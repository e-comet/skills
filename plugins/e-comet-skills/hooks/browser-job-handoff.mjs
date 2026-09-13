import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { feedbackDiagnostics } from '../mcp/src/feedback-diagnostics.mjs';
import { sweepExpired } from '../mcp/src/file-retention.mjs';
import { retryTransientFileOperation } from './transient-file-operation.mjs';

const MAX_HOOK_EVENT_BYTES = 1024 * 1024;
const MAX_SESSION_ID_BYTES = 512;
const MAX_TRIGGER_URL_BYTES = 131072;
const HANDOFF_TTL_MS = 90_000;
const CLOCK_SKEW_MS = 5_000;
const STORE_DIRECTORY = 'browser-job-handoff-v1';
const CLAIM_MARKER_SUFFIX = '.claimed';
const REMOTE_BROWSER_JOB_TOOL = /^mcp__.+__browser_job$/;
const LOCAL_BROWSER_TOOL =
    /^mcp__(?:(?:remote-devices__)?plugin_e-comet-skills_)?e[-_]comet[-_]local__(?:wb_product_card|wb_search_by_query|wb_check_by_query|wb_recommendations_by_product|wb_seller_reviews|ozon_seller_promotion_report|ozon_seller_promotion_reports|ozon_seller_analytics_report)$/;
const LOCAL_TOOL_BY_BROWSER_JOB_TYPE = Object.freeze({
    product_card: 'wb_product_card',
    search_by_query: 'wb_search_by_query',
    check_by_query: 'wb_check_by_query',
    recommendations_by_product: 'wb_recommendations_by_product',
    seller_reviews: 'wb_seller_reviews',
    ozon_seller_promotion_report: 'ozon_seller_promotion_report',
    ozon_seller_promotion_reports: 'ozon_seller_promotion_reports',
    ozon_seller_analytics_report: 'ozon_seller_analytics_report',
});
const SIGNED_LOCAL_TOOLS = new Set(Object.values(LOCAL_TOOL_BY_BROWSER_JOB_TYPE));
const SESSION_HASH_SOURCE = '[a-f0-9]{64}';
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SIGNED_TOOLS_SOURCE = [...SIGNED_LOCAL_TOOLS].join('|');
// Everything this hook may ever create in its root directory: one pending authorization, the marker that
// consumes it exactly once, and the temporary name an authorization is published from. Housekeeping
// recognizes nothing else, so a foreign file in the same directory is never touched — including every
// leftover of the previous build (`<hash>.json`, `.claim-*`, `.stage-*`, `.collision-*`, `<hash>.lock`),
// which is neither read nor removed.
const OWN_STATE_FILE = new RegExp(
    `^${SESSION_HASH_SOURCE}-(?:${SIGNED_TOOLS_SOURCE})-${UUID_SOURCE}\\.json(?:\\.claimed|\\.tmp-${UUID_SOURCE})?$`
);

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

const entryFilePattern = (sessionId, targetTool) =>
    new RegExp(`^${hashSessionId(sessionId)}-${targetTool}-${UUID_SOURCE}\\.json$`);

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

const ensurePrivateStoreDirectory = async (dataDirectory) => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await chmod(dataDirectory, 0o700);
    }
};

// Age is the whole housekeeping rule. The window is the authorization lifetime plus the clock skew a
// staging process may have against a claiming one, so a file this hook still considers claimable is
// never removed. A removal that cannot happen now is retried by the next ordinary run: the shared
// sweep never rejects and prints at most one STORAGE_CLEANUP_PENDING line to stderr on failure.
const sweepStore = (dataDirectory, fileNowMs) =>
    sweepExpired({
        directory: dataDirectory,
        ownName: (name) => OWN_STATE_FILE.test(name),
        retentionMs: HANDOFF_TTL_MS + CLOCK_SKEW_MS,
        now: fileNowMs,
    });

const removeQuietly = async (path) => {
    try {
        await retryTransientFileOperation(() => rm(path, { force: true }));
        return true;
    } catch {
        return false;
    }
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
    await sweepStore(dataDirectory, fileNow());
    const entryPath = join(dataDirectory, `${hashSessionId(sessionId)}-${targetTool}-${randomUUID()}.json`);
    const temporaryPath = `${entryPath}.tmp-${randomUUID()}`;
    const payload = JSON.stringify({ version: 1, createdAtMs: nowMs, triggerUrl, targetTool });
    await writeFile(temporaryPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
        // Publication is a rename of a name only this call owns: a reader never sees a partial file.
        await retryTransientFileOperation(() => rename(temporaryPath, entryPath));
    } catch (error) {
        // The temporary file belongs to this call alone; if it cannot go now, it ages out.
        await removeQuietly(temporaryPath);
        throw error;
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
    const fileNowMs = fileNow();
    await sweepStore(dataDirectory, fileNowMs);
    const entries = await readdir(dataDirectory, { withFileTypes: true });
    const present = new Set(entries.map((entry) => entry.name));
    const pattern = entryFilePattern(sessionId, targetTool);
    const candidates = [];
    for (const entry of entries) {
        const { name } = entry;
        // Only a regular file can be an authorization: a directory or symlink of that name is never
        // read, aged or removed here, so it can neither wedge the store nor smuggle foreign bytes in.
        if (!entry.isFile() || !pattern.test(name) || present.has(`${name}${CLAIM_MARKER_SUFFIX}`)) continue;
        let metadata;
        try {
            metadata = await stat(join(dataDirectory, name));
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        // The file clock decides visibility and tolerates skew; the entry timestamp decides expiry.
        if (fileNowMs - metadata.mtimeMs > HANDOFF_TTL_MS + CLOCK_SKEW_MS) continue;
        candidates.push(name);
    }
    if (candidates.length === 0) {
        throw new HandoffError('HANDOFF_MISSING', 'No browser authorization is waiting for this conversation.');
    }
    if (candidates.length > 1) {
        // Authorizations are sequential, so two waiting ones cannot both be the intended job. Neither is
        // consumed into this call, and both are invalidated: an abandoned earlier authorization must not
        // block the conversation for the rest of its lifetime, and the recovery text below has to be
        // true when it asks for exactly one fresh browser_job.
        for (const name of candidates) {
            const path = join(dataDirectory, name);
            if (await removeQuietly(path)) continue;
            // Retain the ordinary consumption marker while the authorization cannot be deleted.
            // If neither removal nor invalidation works, surface storage failure before advising a refresh.
            try {
                await writeFile(`${path}${CLAIM_MARKER_SUFFIX}`, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
            }
        }
        throw new HandoffError(
            'HANDOFF_MISSING',
            'Several browser authorizations were waiting for this conversation; all of them were invalidated.'
        );
    }

    const entryPath = join(dataDirectory, candidates[0]);
    const markerPath = `${entryPath}${CLAIM_MARKER_SUFFIX}`;
    try {
        // Exclusive creation is the one-use primitive: exactly one caller can ever pass this line for
        // this authorization, on every filesystem the plugin ships on.
        await writeFile(markerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        throw new HandoffError(
            'HANDOFF_MISSING',
            'No unambiguous browser authorization is waiting for this conversation.'
        );
    }

    try {
        let text;
        try {
            text = await readFile(entryPath, 'utf8');
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            throw new HandoffError(
                'HANDOFF_MISSING',
                'No browser authorization is waiting for this conversation.'
            );
        }
        const entry = parseStoredEntry(text, { requireTarget: true });
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
        // The authorization goes first: while it exists, its marker must stay to keep it consumed.
        if (await removeQuietly(entryPath)) await removeQuietly(markerPath);
    }
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

const handoffRecovery = (code) => {
    // Refusals before claim consumption must not manufacture a second pending authorization.
    if (code === 'HANDOFF_MODEL_AUTHORIZATION') return 'Remove triggerUrl and trigger_url from the model-authored arguments and retry the same local tool. The hook must inject authorization; do not request a new browser_job for this argument correction.';
    if (code === 'HANDOFF_INVALID_INPUT') return 'Correct the local tool arguments and retry the same local tool; do not request another authorization just to repair arguments.';
    if (code === 'HANDOFF_DATA_DIR_UNAVAILABLE') return 'The host did not provide plugin storage. Check the installed plugin and host hook integration; requesting another browser_job cannot fix missing host storage.';
    if (code === 'HANDOFF_INVALID_SESSION' || code === 'HANDOFF_INVALID_EVENT' || code === 'HANDOFF_INVALID_TOOL') return 'The host hook context is invalid. Check the supported plugin/host integration and report this failure if it persists; do not obtain repeated authorizations.';
    if (['HANDOFF_MISSING', 'HANDOFF_EXPIRED', 'HANDOFF_TOOL_MISMATCH', 'HANDOFF_INVALID_ENTRY', 'HANDOFF_INVALID_TOKEN'].includes(code)) return 'No usable matching authorization remains. Call browser_job once for the intended local tool, then retry without model-authored authorization fields.';
    return 'The local authorization handoff failed. Check the host integration and local storage access; if it persists, report the failure. Do not request repeated browser_job authorizations without resolving the observed problem.';
};
const handoffStorageRecovery = (details) => {
    if (['ENOSPC', 'EDQUOT'].includes(details?.systemCode)) return 'Local storage reports exhausted space or quota. Free space or resolve the quota before retrying; another browser_job will not fix this.';
    if (['EACCES', 'EPERM', 'EROFS'].includes(details?.systemCode)) return 'Local storage reports denied access or a read-only filesystem. Check access to plugin storage before retrying; another browser_job will not fix this.';
    return null;
};
const deniedPreToolUseOutput = (error) =>
    JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                `${error.code}: e-Comet could not safely hand off the browser authorization. ${error.message} ` +
                (handoffStorageRecovery(error.details) ?? handoffRecovery(error.code)) + (error.details ? ` Diagnostics: ${JSON.stringify(error.details)}` : ''),
        },
    });

const safeHookError = (error, operation = 'handoff_authorize') => {
    if (error instanceof HandoffError) return error;
    const safe = new HandoffError('HANDOFF_STORAGE_ERROR', 'The local browser authorization handoff failed.');
    safe.details = feedbackDiagnostics(error, operation);
    return safe;
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
            return { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}${safeError.details ? ` Diagnostics: ${JSON.stringify(safeError.details)}` : ''}` };
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
            const safeError = safeHookError(error, 'claim_consume');
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
        result = { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}${safeError.details ? ` Diagnostics: ${JSON.stringify(safeError.details)}` : ''}` };
    }
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
};

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
