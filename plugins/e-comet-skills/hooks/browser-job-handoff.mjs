import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_HOOK_EVENT_BYTES = 1024 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const MAX_TRIGGER_URL_BYTES = 131072;
const MAX_PENDING_ENTRIES = 128;
const HANDOFF_TTL_MS = 90_000;
const CLOCK_SKEW_MS = 5_000;
const STORE_DIRECTORY = 'browser-job-handoff-v1';
const PENDING_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const CLAIM_FILE_PREFIX = '.claim-';
const LOCK_CANDIDATE_PATTERN = /^\.claim-lock-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGE_FILE_PREFIX = '.stage-';
const COLLISION_FILE_PREFIX = '.collision-';
const LOCK_FILE_SUFFIX = '.lock';
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_RETRY_LIMIT = 200;
const LOCK_RELEASE_RETRY_LIMIT = 20;
const TRANSIENT_WINDOWS_LOCK_ERRORS = new Set(['EPERM', 'EBUSY']);
const REMOTE_BROWSER_JOB_TOOL = /^mcp__.+__browser_job$/;
const LOCAL_BROWSER_TOOL =
    /^mcp__(?:(?:remote-devices__)?plugin_e-comet-skills_)?e[-_]comet[-_]local__(?:wb_product_card|wb_search_by_query|wb_check_by_query|wb_recommendations_by_product|wb_seller_reviews|ozon_seller_promotion_report)$/;
const LOCAL_TOOL_BY_BROWSER_JOB_TYPE = Object.freeze({
    product_card: 'wb_product_card',
    search_by_query: 'wb_search_by_query',
    check_by_query: 'wb_check_by_query',
    recommendations_by_product: 'wb_recommendations_by_product',
    seller_reviews: 'wb_seller_reviews',
    ozon_seller_promotion_report: 'ozon_seller_promotion_report',
});
const SIGNED_LOCAL_TOOLS = new Set(Object.values(LOCAL_TOOL_BY_BROWSER_JOB_TYPE));

class HandoffError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'HandoffError';
        this.code = code;
    }
}

const byteLength = (value) => Buffer.byteLength(value, 'utf8');

const validateSessionId = (sessionId) => {
    if (
        typeof sessionId !== 'string' ||
        byteLength(sessionId) < 1 ||
        byteLength(sessionId) > MAX_SESSION_ID_BYTES
    ) {
        throw new HandoffError('HANDOFF_INVALID_SESSION', 'The desktop session identifier is invalid.');
    }
    return sessionId;
};

const validateTriggerUrl = (triggerUrl) => {
    if (
        typeof triggerUrl !== 'string' ||
        byteLength(triggerUrl) < 1 ||
        byteLength(triggerUrl) > MAX_TRIGGER_URL_BYTES
    ) {
        throw new HandoffError('HANDOFF_INVALID_TOKEN', 'The browser authorization result is invalid.');
    }
    return triggerUrl;
};

const validateTargetTool = (targetTool) => {
    if (typeof targetTool !== 'string' || !SIGNED_LOCAL_TOOLS.has(targetTool)) {
        throw new HandoffError('HANDOFF_INVALID_TOOL', 'The browser authorization target is invalid.');
    }
    return targetTool;
};

const hashSessionId = (sessionId) => createHash('sha256').update(validateSessionId(sessionId), 'utf8').digest('hex');

const resolveStoreDirectory = (env) => {
    const pluginData = env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA;
    if (typeof pluginData !== 'string' || !pluginData.trim()) {
        throw new HandoffError(
            'HANDOFF_DATA_DIR_UNAVAILABLE',
            'The desktop client did not provide writable plugin storage.'
        );
    }
    return join(resolve(pluginData), STORE_DIRECTORY);
};

const pendingPathForSession = (storeDirectory, sessionId) => join(storeDirectory, `${hashSessionId(sessionId)}.json`);
const lockPathForSession = (storeDirectory, sessionId) => join(storeDirectory, `${hashSessionId(sessionId)}${LOCK_FILE_SUFFIX}`);
const stageFilePrefixForSession = (sessionId) => `${STAGE_FILE_PREFIX}${hashSessionId(sessionId)}-`;
const collisionPathForSession = (storeDirectory, sessionId) =>
    join(storeDirectory, `${COLLISION_FILE_PREFIX}${hashSessionId(sessionId)}`);

const parseStoredEntry = (text, { requireTarget = false } = {}) => {
    let entry;
    try {
        entry = JSON.parse(text);
    } catch {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    if (
        !entry ||
        entry.version !== 1 ||
        typeof entry.createdAtMs !== 'number' ||
        !Number.isSafeInteger(entry.createdAtMs)
    ) {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    validateTriggerUrl(entry.triggerUrl);
    if (entry.targetTool !== undefined && !SIGNED_LOCAL_TOOLS.has(entry.targetTool)) {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    if (requireTarget && entry.targetTool === undefined) {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    return entry;
};

const isEntryFresh = (entry, nowMs) =>
    entry.createdAtMs <= nowMs + CLOCK_SKEW_MS && nowMs - entry.createdAtMs <= HANDOFF_TTL_MS;

export const removeFile = async (
    path,
    { retryLimit = LOCK_RELEASE_RETRY_LIMIT, waitForRetry = wait, operations = {} } = {}
) => {
    const unlinkFile = operations.unlink ?? unlink;
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
            await unlinkFile(path);
            return;
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            if (!TRANSIENT_WINDOWS_LOCK_ERRORS.has(error?.code) || attempt === retryLimit - 1) throw error;
            await waitForRetry(LOCK_RETRY_DELAY_MS);
        }
    }
};

const ensurePrivateStoreDirectory = async (dataDirectory) => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await chmod(dataDirectory, 0o700);
    }
};

const wait = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs));

export const releaseOwnedSessionLock = async ({
    lockPath,
    ownerPath,
    retryLimit = LOCK_RELEASE_RETRY_LIMIT,
    waitForRetry = wait,
    operations = {},
}) => {
    const unlinkOwner = operations.unlink ?? unlink;
    const removeLockDirectory = operations.rmdir ?? rmdir;
    const readLockDirectory = operations.readdir ?? readdir;
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
            await unlinkOwner(ownerPath);
            break;
        } catch (error) {
            if (error?.code === 'ENOENT') break;
            if (!TRANSIENT_WINDOWS_LOCK_ERRORS.has(error?.code) || attempt === retryLimit - 1) throw error;
            await waitForRetry(LOCK_RETRY_DELAY_MS);
        }
    }
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
            await removeLockDirectory(lockPath);
            return;
        } catch (error) {
            if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) return;
            if (!TRANSIENT_WINDOWS_LOCK_ERRORS.has(error?.code)) throw error;
            try {
                if ((await readLockDirectory(lockPath)).length > 0) return;
            } catch (readError) {
                if (readError?.code === 'ENOENT') return;
                if (!TRANSIENT_WINDOWS_LOCK_ERRORS.has(readError?.code)) throw readError;
            }
            if (attempt === retryLimit - 1) throw error;
            await waitForRetry(LOCK_RETRY_DELAY_MS);
        }
    }
};

const acquireSessionLock = async (storeDirectory, sessionId, fileNow) => {
    const lockPath = lockPathForSession(storeDirectory, sessionId);
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
        const ownerId = `${process.pid}-${randomUUID()}`;
        const candidatePath = join(storeDirectory, `${CLAIM_FILE_PREFIX}lock-${ownerId}`);
        const candidateOwnerPath = join(candidatePath, ownerId);
        await mkdir(candidatePath, { mode: 0o700 });
        try {
            await writeFile(candidateOwnerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            await rename(candidatePath, lockPath);
            const ownerPath = join(lockPath, ownerId);
            return () => releaseOwnedSessionLock({ lockPath, ownerPath });
        } catch (error) {
            await rm(candidatePath, { recursive: true, force: true });
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
        }

        try {
            const lockStat = await stat(lockPath);
            if (fileNow() - lockStat.mtimeMs > HANDOFF_TTL_MS) {
                const stalePath = join(storeDirectory, `${CLAIM_FILE_PREFIX}stale-lock-${process.pid}-${randomUUID()}`);
                try {
                    const currentLockStat = await stat(lockPath);
                    if (
                        currentLockStat.dev !== lockStat.dev ||
                        currentLockStat.ino !== lockStat.ino ||
                        currentLockStat.mtimeMs !== lockStat.mtimeMs
                    ) {
                        continue;
                    }
                    await rename(lockPath, stalePath);
                    await rm(stalePath, { recursive: true, force: true });
                } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
                continue;
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
        await wait(LOCK_RETRY_DELAY_MS);
    }
    throw new HandoffError('HANDOFF_BUSY', 'Another browser authorization handoff is still in progress.');
};

export const withSessionLock = async (storeDirectory, sessionId, fileNow, operation, acquireLock = acquireSessionLock) => {
    const releaseLock = await acquireLock(storeDirectory, sessionId, fileNow);
    let operationFailed = false;
    try {
        return await operation();
    } catch (error) {
        operationFailed = true;
        throw error;
    } finally {
        try {
            await releaseLock();
        } catch (error) {
            if (!operationFailed) throw error;
        }
    }
};

const hasActiveStage = async (storeDirectory, sessionId) => {
    const stageFilePrefix = stageFilePrefixForSession(sessionId);
    const entries = await readdir(storeDirectory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.startsWith(stageFilePrefix));
};

const readCollision = async (storeDirectory, sessionId) => {
    try {
        const entry = JSON.parse(await readFile(collisionPathForSession(storeDirectory, sessionId), 'utf8'));
        if (
            entry?.version === 1 &&
            typeof entry.generationId === 'string' &&
            entry.generationId &&
            ['open', 'closed'].includes(entry.status)
        ) {
            return entry;
        }
        return { version: 1, generationId: null, status: 'open' };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) return { version: 1, generationId: null, status: 'open' };
        throw error;
    }
};

const hasCollision = async (storeDirectory, sessionId) => (await readCollision(storeDirectory, sessionId)) !== null;

const recordCollision = async (storeDirectory, sessionId) => {
    try {
        await writeFile(
            collisionPathForSession(storeDirectory, sessionId),
            JSON.stringify({ version: 1, generationId: randomUUID(), status: 'open' }),
            {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            }
        );
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
    }
};

const closeCollision = async (storeDirectory, sessionId) => {
    const collision = await readCollision(storeDirectory, sessionId);
    if (!collision) return;
    await writeFile(
        collisionPathForSession(storeDirectory, sessionId),
        JSON.stringify({
            version: 1,
            generationId: collision.generationId || randomUUID(),
            status: 'closed',
        }),
        { encoding: 'utf8', mode: 0o600 }
    );
};

const cleanupStore = async (storeDirectory, nowMs, fileNowMs) => {
    let entries;
    try {
        entries = await readdir(storeDirectory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return 0;
        throw error;
    }

    let pendingCount = 0;
    for (const directoryEntry of entries) {
        if (directoryEntry.isDirectory() && LOCK_CANDIDATE_PATTERN.test(directoryEntry.name)) {
            const candidatePath = join(storeDirectory, directoryEntry.name);
            try {
                const candidateStat = await stat(candidatePath);
                if (fileNowMs - candidateStat.mtimeMs > HANDOFF_TTL_MS) {
                    const currentStat = await stat(candidatePath);
                    if (
                        currentStat.dev === candidateStat.dev &&
                        currentStat.ino === candidateStat.ino &&
                        currentStat.mtimeMs === candidateStat.mtimeMs
                    ) {
                        const stalePath = join(storeDirectory, `.claim-stale-lock-${process.pid}-${randomUUID()}`);
                        await rename(candidatePath, stalePath);
                        await rm(stalePath, { recursive: true, force: true });
                    }
                }
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            continue;
        }
        if (!directoryEntry.isFile()) continue;
        const path = join(storeDirectory, directoryEntry.name);
        if (PENDING_FILE_PATTERN.test(directoryEntry.name)) {
            let remove = false;
            try {
                const entry = parseStoredEntry(await readFile(path, 'utf8'));
                remove = !isEntryFresh(entry, nowMs);
            } catch {
                remove = true;
            }
            if (remove) await removeFile(path);
            else pendingCount += 1;
            continue;
        }
        if (directoryEntry.name.startsWith(CLAIM_FILE_PREFIX)) {
            try {
                const fileStat = await stat(path);
                if (fileNowMs - fileStat.mtimeMs > HANDOFF_TTL_MS) await removeFile(path);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            continue;
        }
        if (directoryEntry.name.startsWith(STAGE_FILE_PREFIX)) {
            try {
                const fileStat = await stat(path);
                if (fileNowMs - fileStat.mtimeMs > HANDOFF_TTL_MS) await removeFile(path);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            continue;
        }
        if (directoryEntry.name.startsWith(COLLISION_FILE_PREFIX)) {
            try {
                const fileStat = await stat(path);
                if (fileNowMs - fileStat.mtimeMs > HANDOFF_TTL_MS) await removeFile(path);
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
    }
    return pendingCount;
};

export const stageTriggerUrl = async ({
    dataDirectory,
    sessionId,
    triggerUrl,
    targetTool,
    nowMs = Date.now(),
    fileNow = Date.now,
}) => {
    validateSessionId(sessionId);
    validateTriggerUrl(triggerUrl);
    validateTargetTool(targetTool);
    await ensurePrivateStoreDirectory(dataDirectory);
    const stagePath = join(dataDirectory, `${stageFilePrefixForSession(sessionId)}${process.pid}-${randomUUID()}`);
    const observedCollision = await readCollision(dataDirectory, sessionId);
    await writeFile(
        stagePath,
        JSON.stringify({
            version: 1,
            collisionGenerationId: observedCollision?.generationId ?? null,
            collisionStatus: observedCollision?.status ?? null,
        }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    try {
        await withSessionLock(dataDirectory, sessionId, fileNow, async () => {
            const pendingCount = await cleanupStore(dataDirectory, nowMs, fileNow());
            if (pendingCount >= MAX_PENDING_ENTRIES) {
                throw new HandoffError('HANDOFF_CAPACITY', 'Too many browser authorizations are waiting locally.');
            }

            const pendingPath = pendingPathForSession(dataDirectory, sessionId);
            const collision = await readCollision(dataDirectory, sessionId);
            if (collision) {
                const stageEntry = JSON.parse(await readFile(stagePath, 'utf8'));
                const startsNewGeneration =
                    collision.status === 'closed' &&
                    collision.generationId !== null &&
                    stageEntry.collisionGenerationId === collision.generationId &&
                    stageEntry.collisionStatus === 'closed';
                if (startsNewGeneration) {
                    await removeFile(collisionPathForSession(dataDirectory, sessionId));
                } else {
                    await removeFile(pendingPath);
                    throw new HandoffError(
                        'HANDOFF_CONFLICT',
                        'Another browser authorization was already waiting in this conversation.'
                    );
                }
            }
            const payload = JSON.stringify({
                version: 1,
                createdAtMs: nowMs,
                triggerUrl,
                targetTool,
            });
            try {
                await writeFile(pendingPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
                await removeFile(pendingPath);
                await recordCollision(dataDirectory, sessionId);
                throw new HandoffError(
                    'HANDOFF_CONFLICT',
                    'Another browser authorization was already waiting in this conversation.'
                );
            }
        });
    } finally {
        await removeFile(stagePath);
        try {
            await withSessionLock(dataDirectory, sessionId, fileNow, async () => {
                await cleanupStore(dataDirectory, nowMs, fileNow());
                if (!(await hasActiveStage(dataDirectory, sessionId))) {
                    await closeCollision(dataDirectory, sessionId);
                }
            });
        } catch {
            // The owned stage is already gone; remaining cleanup is recoverable housekeeping.
        }
    }
};

export const claimTriggerUrl = async ({
    dataDirectory,
    sessionId,
    targetTool,
    nowMs = Date.now(),
    fileNow = Date.now,
}) => {
    validateSessionId(sessionId);
    validateTargetTool(targetTool);
    await ensurePrivateStoreDirectory(dataDirectory);
    return withSessionLock(dataDirectory, sessionId, fileNow, async () => {
        await cleanupStore(dataDirectory, nowMs, fileNow());
        if ((await hasActiveStage(dataDirectory, sessionId)) || (await hasCollision(dataDirectory, sessionId))) {
            throw new HandoffError(
                'HANDOFF_MISSING',
                'No unambiguous browser authorization is waiting for this conversation.'
            );
        }

        const pendingPath = pendingPathForSession(dataDirectory, sessionId);
        const claimPath = join(dataDirectory, `${CLAIM_FILE_PREFIX}${process.pid}-${randomUUID()}`);
        try {
            await rename(pendingPath, claimPath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                throw new HandoffError(
                    'HANDOFF_MISSING',
                    'No browser authorization is waiting for this conversation.'
                );
            }
            throw error;
        }

        try {
            const entry = parseStoredEntry(await readFile(claimPath, 'utf8'), { requireTarget: true });
            if (!isEntryFresh(entry, nowMs)) {
                throw new HandoffError('HANDOFF_EXPIRED', 'The pending browser authorization expired.');
            }
            if (entry.targetTool !== targetTool) {
                throw new HandoffError(
                    'HANDOFF_TOOL_MISMATCH',
                    'The pending browser authorization does not match this local tool.'
                );
            }
            return entry.triggerUrl;
        } finally {
            await removeFile(claimPath);
        }
    });
};

const collectTriggerUrlCandidates = (toolResponse) => {
    if (typeof toolResponse === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(toolResponse);
        } catch {
            return [];
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
        return typeof parsed.trigger_url === 'string' ? [parsed.trigger_url] : [];
    }
    if (!toolResponse || typeof toolResponse !== 'object' || toolResponse.isError === true) return [];
    const candidates = [];
    for (const structured of [toolResponse.structuredContent, toolResponse.structured_content]) {
        if (structured && typeof structured === 'object' && typeof structured.trigger_url === 'string') {
            candidates.push(structured.trigger_url);
        }
    }
    if (Array.isArray(toolResponse.content)) {
        for (const item of toolResponse.content) {
            if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
            let parsed;
            try {
                parsed = JSON.parse(item.text);
            } catch {
                continue;
            }
            if (parsed && typeof parsed === 'object' && typeof parsed.trigger_url === 'string') {
                candidates.push(parsed.trigger_url);
            }
        }
    }
    return candidates;
};

export const extractTriggerUrl = (toolResponse) => {
    const candidates = collectTriggerUrlCandidates(toolResponse);
    if (candidates.length === 0) return null;
    const unique = [...new Set(candidates)];
    if (unique.length !== 1) {
        throw new HandoffError('HANDOFF_AMBIGUOUS_TOKEN', 'The browser authorization result is ambiguous.');
    }
    return validateTriggerUrl(unique[0]);
};

const preToolUseOutput = (updatedInput) =>
    JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput,
        },
    });

const deniedPreToolUseOutput = (error) =>
    JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                `${error.code}: e-Comet could not safely hand off the browser authorization. ` +
                'Call browser_job once, then retry.',
        },
    });

const safeHookError = (error) => {
    if (error instanceof HandoffError) return error;
    return new HandoffError('HANDOFF_STORAGE_ERROR', 'The local browser authorization handoff failed.');
};

const browserJobTargetTool = (event) => {
    const toolInput = event.tool_input ?? event.toolInput;
    if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
        throw new HandoffError('HANDOFF_INVALID_TOOL', 'The browser authorization target is invalid.');
    }
    const job = toolInput.job;
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
        throw new HandoffError('HANDOFF_INVALID_TOOL', 'The browser authorization target is invalid.');
    }
    return validateTargetTool(LOCAL_TOOL_BY_BROWSER_JOB_TYPE[job.type]);
};

export const processHookEvent = async (event, { env = process.env, nowMs = Date.now(), fileNow = Date.now } = {}) => {
    if (!event || typeof event !== 'object') {
        const error = new HandoffError('HANDOFF_INVALID_EVENT', 'The desktop hook event is invalid.');
        return { exitCode: 2, stdout: '', stderr: `${error.code}: ${error.message}` };
    }

    const eventName = event.hook_event_name || event.hookEventName;
    const toolName = event.tool_name ?? event.toolName;
    const sessionId = event.session_id ?? event.sessionId;
    if (eventName === 'PostToolUse' && REMOTE_BROWSER_JOB_TOOL.test(toolName)) {
        try {
            const triggerUrl = extractTriggerUrl(event.tool_response ?? event.toolResponse);
            if (triggerUrl === null) {
                throw new HandoffError(
                    'HANDOFF_TOKEN_NOT_FOUND',
                    'The browser authorization result did not contain a usable token.'
                );
            }
            await stageTriggerUrl({
                dataDirectory: resolveStoreDirectory(env),
                sessionId,
                triggerUrl,
                targetTool: browserJobTargetTool(event),
                nowMs,
                fileNow,
            });
            return { exitCode: 0, stdout: '', stderr: '' };
        } catch (error) {
            const safeError = safeHookError(error);
            return { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}` };
        }
    }

    const isLocalBrowserTool = eventName === 'PreToolUse' && LOCAL_BROWSER_TOOL.test(toolName);
    if (isLocalBrowserTool) {
        try {
            const toolInput = event.tool_input ?? event.toolInput;
            if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
                throw new HandoffError('HANDOFF_INVALID_INPUT', 'The local browser-job arguments are invalid.');
            }
            const targetTool = toolName.slice(toolName.lastIndexOf('__') + 2);
            if (
                Object.prototype.hasOwnProperty.call(toolInput, 'triggerUrl') ||
                Object.prototype.hasOwnProperty.call(toolInput, 'trigger_url')
            ) {
                throw new HandoffError(
                    'HANDOFF_MODEL_AUTHORIZATION',
                    'The browser authorization must be injected by the trusted host hook.'
                );
            }
            const triggerUrl = await claimTriggerUrl({
                dataDirectory: resolveStoreDirectory(env),
                sessionId,
                targetTool,
                nowMs,
                fileNow,
            });
            return {
                exitCode: 0,
                stdout: preToolUseOutput({ ...toolInput, triggerUrl }),
                stderr: '',
            };
        } catch (error) {
            const safeError = safeHookError(error);
            return { exitCode: 0, stdout: deniedPreToolUseOutput(safeError), stderr: '' };
        }
    }

    return { exitCode: 0, stdout: '', stderr: '' };
};

const readStdin = async () => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > MAX_HOOK_EVENT_BYTES) {
            throw new HandoffError('HANDOFF_EVENT_TOO_LARGE', 'The desktop hook event is too large.');
        }
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try {
        return JSON.parse(text);
    } catch {
        throw new HandoffError('HANDOFF_INVALID_EVENT', 'The desktop hook event is invalid.');
    }
};

const main = async () => {
    let result;
    try {
        result = await processHookEvent(await readStdin());
    } catch (error) {
        const safeError = safeHookError(error);
        result = { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}` };
    }
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
