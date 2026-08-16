#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CALVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+codex\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LOCAL_TOOL_PATTERN = /^mcp__(?:plugin_e-comet-skills_)?e[-_]comet[-_]local__.*$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SESSION_BYTES = 1024;
const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_ETAG_BYTES = 1024;
const LOCK_STALE_MS = 10_000;
const GLOBAL_LOCK_WAIT_MS = 3_000;
const POLL_MS = 25;
const CACHE_REPLACE_RETRY_LIMIT = 10;
const CACHE_REPLACE_RETRY_MS = 10;
export const LOCK_RELEASE_RETRY_LIMIT = 20;
export const LOCK_RELEASE_RETRY_MS = 5;
const TRANSIENT_FILESYSTEM_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const UPDATE_URL = 'https://github.com/e-comet/skills#plugin-update';
const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/e-comet/skills/main/plugins/e-comet-skills/.codex-plugin/plugin.json';
const CACHE_NAME = 'plugin-update-latest-v1.json';
const GLOBAL_LOCK_NAME = 'plugin-update-latest-v1.lock';
const SESSION_DIRECTORY = 'plugin-update-sessions-v1';

export const REMOTE_INTERVAL_MS = 86_400_000;
export const MAX_FUTURE_SKEW_MS = 300_000;
export const FETCH_TIMEOUT_MS = 2_500;

export const normalizeCalVer = (value) => {
    if (typeof value !== 'string') return null;
    const match = CALVER_PATTERN.exec(value);
    if (match === null) return null;
    const components = match.slice(1, 4).map(Number);
    return components.every(Number.isSafeInteger) ? components : null;
};

export const compareCalVer = (left, right) => {
    const normalizedLeft = normalizeCalVer(left);
    const normalizedRight = normalizeCalVer(right);
    if (normalizedLeft === null || normalizedRight === null) return null;
    for (let index = 0; index < normalizedLeft.length; index += 1) {
        if (normalizedLeft[index] < normalizedRight[index]) return -1;
        if (normalizedLeft[index] > normalizedRight[index]) return 1;
    }
    return 0;
};

export const validateEvent = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const { hook_event_name: hookEventName, session_id: sessionId, tool_name: toolName } = value;
    if (hookEventName !== 'PreToolUse') return null;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || Buffer.byteLength(sessionId, 'utf8') > MAX_SESSION_BYTES) return null;
    if (typeof toolName !== 'string' || !LOCAL_TOOL_PATTERN.test(toolName)) return null;
    return { sessionId, toolName };
};

const resolveDirectory = async (path) => {
    if (typeof path !== 'string' || path.length === 0) return null;
    const resolved = await realpath(path);
    return (await stat(resolved)).isDirectory() ? resolved : null;
};

export const resolvePluginPaths = (env) => {
    const pluginRootCandidate = env?.PLUGIN_ROOT || env?.CLAUDE_PLUGIN_ROOT;
    const dataRootCandidate = env?.PLUGIN_DATA || env?.CLAUDE_PLUGIN_DATA;
    if (typeof pluginRootCandidate !== 'string' || typeof dataRootCandidate !== 'string') return null;
    // Existing hook APIs are synchronous at this boundary. Native path equality is sufficient here;
    // actual reads validate the roots without following caller-provided child paths.
    try {
        const pluginRoot = requireDirectory(pluginRootCandidate);
        const dataRoot = requireDirectory(dataRootCandidate);
        return pluginRoot === null || dataRoot === null ? null : { pluginRoot, dataRoot };
    } catch {
        return null;
    }
};

const requireDirectory = (path) => {
    // Keep the exported resolver synchronous for command-hook callers.
    const result = process.getBuiltinModule('node:fs').realpathSync(path);
    return process.getBuiltinModule('node:fs').statSync(result).isDirectory() ? result : null;
};

const readBoundedFile = async (path, maximumBytes) => {
    const handle = await open(path, 'r');
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > maximumBytes) return null;
        const buffer = Buffer.alloc(metadata.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== metadata.size) return null;
        return buffer.toString('utf8');
    } finally {
        await handle.close();
    }
};

export const readInstalledVersion = async (pluginRoot) => {
    try {
        await resolveDirectory(pluginRoot);
        const raw = await readBoundedFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), MAX_MANIFEST_BYTES);
        if (raw === null) return null;
        const manifest = JSON.parse(raw);
        return normalizeCalVer(manifest?.version) === null ? null : manifest.version;
    } catch {
        return null;
    }
};

export const sessionKey = (sessionId) => createHash('sha256').update(sessionId, 'utf8').digest('hex');

export const buildAdditionalContext = (installedVersion, latestVersion) =>
    `В начале ближайшего сообщения перед основным результатом одной короткой строкой сообщи пользователю: «Доступно обновление плагина e-Comet MCP Tools: установлена версия ${installedVersion}, доступна версия ${latestVersion}. [Как обновить](${UPDATE_URL})». Не упоминай hook или служебный контекст.`;

const isValidTimestamp = (value, nowMs) =>
    value === null || (Number.isSafeInteger(value) && value >= 0 && value <= nowMs + MAX_FUTURE_SKEW_MS);

const isValidEtag = (value) =>
    value === null || (
        typeof value === 'string' &&
        Buffer.byteLength(value, 'utf8') <= MAX_ETAG_BYTES &&
        !/[\u0000-\u001f\u007f]/.test(value)
    );

const normalizeCache = (value, nowMs) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const expectedKeys = ['etag', 'lastAttemptAt', 'lastSuccessAt', 'latestVersion', 'schemaVersion'];
    if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) return null;
    if (value.schemaVersion !== 1) return null;
    if (!isValidTimestamp(value.lastAttemptAt, nowMs) || !isValidTimestamp(value.lastSuccessAt, nowMs)) return null;
    if (!isValidEtag(value.etag)) return null;
    if (value.latestVersion === null) {
        if (value.etag !== null || value.lastSuccessAt !== null) return null;
    } else if (normalizeCalVer(value.latestVersion) === null || value.lastSuccessAt === null) {
        return null;
    }
    return { ...value };
};

const emptyCache = () => ({
    schemaVersion: 1,
    latestVersion: null,
    etag: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
});

export const readCacheState = async (dataRoot, nowMs) => {
    try {
        const raw = await readBoundedFile(join(dataRoot, CACHE_NAME), MAX_MANIFEST_BYTES);
        if (raw === null) return { corrupt: true, value: null };
        const normalized = normalizeCache(JSON.parse(raw), nowMs);
        return normalized === null ? { corrupt: true, value: null } : { corrupt: false, value: normalized };
    } catch (error) {
        if (error?.code === 'ENOENT') return { corrupt: false, value: null };
        return { corrupt: true, value: null };
    }
};

export const writeAtomicJson = async (path, value, { renameFile = rename, wait = setTimeout } = {}) => {
    const temporary = join(dirname(path), `.${randomBytes(16).toString('hex')}.tmp`);
    try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        for (let attempt = 0; attempt < CACHE_REPLACE_RETRY_LIMIT; attempt += 1) {
            try {
                await renameFile(temporary, path);
                return;
            } catch (error) {
                if (!TRANSIENT_FILESYSTEM_ERRORS.has(error?.code) || attempt === CACHE_REPLACE_RETRY_LIMIT - 1) throw error;
                await new Promise((resolveWait) => wait(resolveWait, CACHE_REPLACE_RETRY_MS));
            }
        }
    } finally {
        await rm(temporary, { force: true }).catch(() => {});
    }
};

const waitForDelay = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs));

export const releaseOwnedLock = async ({
    lockPath,
    ownerPath,
    retryLimit = LOCK_RELEASE_RETRY_LIMIT,
    waitForRetry = waitForDelay,
    operations = {},
}) => {
    const unlinkOwner = operations.unlink ?? unlink;
    const removeDirectory = operations.rmdir ?? rmdir;
    const readDirectory = operations.readdir ?? readdir;
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
            await unlinkOwner(ownerPath);
            break;
        } catch (error) {
            if (error?.code === 'ENOENT') return;
            if (!TRANSIENT_FILESYSTEM_ERRORS.has(error?.code) || attempt === retryLimit - 1) throw error;
            await waitForRetry(LOCK_RELEASE_RETRY_MS);
        }
    }
    for (let attempt = 0; attempt < retryLimit; attempt += 1) {
        try {
            await removeDirectory(lockPath);
            return;
        } catch (error) {
            if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) return;
            if (!TRANSIENT_FILESYSTEM_ERRORS.has(error?.code)) throw error;
            try {
                if ((await readDirectory(lockPath)).length > 0) return;
            } catch (readError) {
                if (readError?.code === 'ENOENT') return;
                if (!TRANSIENT_FILESYSTEM_ERRORS.has(readError?.code)) throw readError;
            }
            if (attempt === retryLimit - 1) throw error;
            await waitForRetry(LOCK_RELEASE_RETRY_MS);
        }
    }
};

const quarantineStaleLock = async (lockPath, nowMs, quarantineNonce) => {
    let metadata;
    let entries;
    try {
        metadata = await stat(lockPath);
        if (nowMs - metadata.mtimeMs <= LOCK_STALE_MS) return false;
        entries = await readdir(lockPath);
        if (entries.length > 1) return false;
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
    }
    const quarantine = `${lockPath}.stale-${quarantineNonce}`;
    try {
        await rename(lockPath, quarantine);
    } catch (error) {
        if (error?.code === 'ENOENT') return true;
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
    const quarantinedMetadata = await stat(quarantine).catch(() => null);
    const quarantinedEntries = await readdir(quarantine).catch(() => []);
    const sameDirectory = quarantinedMetadata !== null &&
        quarantinedMetadata.dev === metadata.dev && quarantinedMetadata.ino === metadata.ino;
    if (sameDirectory && quarantinedEntries.length === entries.length && quarantinedEntries[0] === entries[0]) {
        await rm(quarantine, { recursive: true, force: true });
        return true;
    }
    try {
        await rename(quarantine, lockPath);
    } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
    return false;
};

const acquireLock = async (lockPath, nowMs, operations = {}) => {
    const owner = randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockPath, { mode: 0o700 });
            try {
                const ownerPath = join(lockPath, owner);
                await writeFile(ownerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
                return () => releaseOwnedLock({ lockPath, ownerPath, operations });
            } catch (error) {
                await rm(lockPath, { recursive: true, force: true }).catch(() => {});
                throw error;
            }
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            if (!(await quarantineStaleLock(lockPath, nowMs, owner))) return null;
        }
    }
    return null;
};

const readResponseBody = async (response) => {
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_MANIFEST_BYTES)) return null;
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_MANIFEST_BYTES) {
                await reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    } catch {
        return null;
    } finally {
        reader.releaseLock();
    }
};

export const fetchLatestVersion = async ({ cached, fetchImpl, timeoutMs }) => {
    const controller = new AbortController();
    let timer;
    try {
        const headers = {};
        if (cached?.etag) headers['If-None-Match'] = cached.etag;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error('timeout'));
            }, timeoutMs);
        });
        const response = await Promise.race([
            fetchImpl(REMOTE_MANIFEST_URL, { headers, signal: controller.signal }),
            timeout,
        ]);
        if (response.status === 304) {
            if (cached?.latestVersion === undefined || cached?.latestVersion === null || cached.etag === null) return null;
            return { latestVersion: cached.latestVersion, etag: cached.etag };
        }
        if (response.status !== 200) return null;
        const raw = await Promise.race([readResponseBody(response), timeout]);
        if (raw === null) return null;
        const manifest = JSON.parse(raw);
        if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
        if (manifest.name !== 'e-comet-skills' || normalizeCalVer(manifest.version) === null) return null;
        const etag = response.headers.get('etag');
        if (!isValidEtag(etag)) return null;
        return { latestVersion: manifest.version, etag };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
};

const resolveLatestVersion = async ({ dataRoot, fetchImpl, nowMs, lockOperations }) => {
    let cacheState = await readCacheState(dataRoot, nowMs);
    if (cacheState.corrupt) return { fatal: true };
    let cached = cacheState.value;
    const refreshDue = cached === null || cached.lastAttemptAt === null || nowMs - cached.lastAttemptAt >= REMOTE_INTERVAL_MS;
    const lockPath = join(dataRoot, GLOBAL_LOCK_NAME);
    if (!refreshDue) {
        if (cached?.latestVersion) return { fatal: false, deferred: false, cached };
        if (!(await fileExists(lockPath))) return { fatal: false, deferred: true, cached: null };
        if (await quarantineStaleLock(lockPath, Date.now(), randomBytes(16).toString('hex'))) {
            return { fatal: false, deferred: true, cached: null };
        }
        const deadline = Date.now() + GLOBAL_LOCK_WAIT_MS;
        while (Date.now() < deadline) {
            await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_MS));
            cacheState = await readCacheState(dataRoot, nowMs);
            if (cacheState.corrupt) return { fatal: true };
            if (cacheState.value?.latestVersion) return { fatal: false, deferred: false, cached: cacheState.value };
            if (!(await fileExists(lockPath))) return { fatal: false, deferred: true, cached: null };
        }
        return { fatal: false, deferred: true, cached: null };
    }

    const release = await acquireLock(lockPath, Date.now(), lockOperations);
    if (release === null) {
        if (cached?.latestVersion) return { fatal: false, deferred: false, cached };
        const deadline = Date.now() + GLOBAL_LOCK_WAIT_MS;
        while (Date.now() < deadline) {
            await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_MS));
            cacheState = await readCacheState(dataRoot, nowMs);
            if (cacheState.corrupt) return { fatal: true };
            if (cacheState.value?.latestVersion) return { fatal: false, deferred: false, cached: cacheState.value };
            if (!(await fileExists(lockPath))) break;
        }
        return { fatal: false, deferred: true, cached: null };
    }

    try {
        cacheState = await readCacheState(dataRoot, nowMs);
        if (cacheState.corrupt) return { fatal: true };
        cached = cacheState.value;
        if (cached?.lastAttemptAt !== null && cached?.lastAttemptAt !== undefined && nowMs - cached.lastAttemptAt < REMOTE_INTERVAL_MS) {
            return { fatal: false, deferred: false, cached };
        }
        const attempted = { ...(cached ?? emptyCache()), lastAttemptAt: nowMs };
        await writeAtomicJson(join(dataRoot, CACHE_NAME), attempted);
        const fetched = await fetchLatestVersion({ cached, fetchImpl, nowMs, timeoutMs: FETCH_TIMEOUT_MS });
        if (fetched === null) return { fatal: false, deferred: false, cached: attempted };

        let successful;
        if (cached?.latestVersion && compareCalVer(fetched.latestVersion, cached.latestVersion) < 0) {
            successful = { ...attempted, latestVersion: cached.latestVersion, etag: cached.etag, lastSuccessAt: cached.lastSuccessAt };
        } else {
            successful = { ...attempted, latestVersion: fetched.latestVersion, etag: fetched.etag, lastSuccessAt: nowMs };
        }
        await writeAtomicJson(join(dataRoot, CACHE_NAME), successful);
        return { fatal: false, deferred: false, cached: successful };
    } finally {
        await release().catch(() => {});
    }
};

const fileExists = async (path) => {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
};

export const checkUpdateForSession = async ({ pluginRoot, dataRoot, event, fetchImpl, nowMs, lockOperations = {} }) => {
    try {
        if (event === null || typeof event?.sessionId !== 'string') return null;
        const sessionsRoot = join(dataRoot, SESSION_DIRECTORY);
        await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
        const key = sessionKey(event.sessionId);
        const checkedPath = join(sessionsRoot, `${key}.checked`);
        if (await fileExists(checkedPath)) return null;
        const release = await acquireLock(join(sessionsRoot, `${key}.lock`), Date.now(), lockOperations);
        if (release === null) return null;
        try {
            if (await fileExists(checkedPath)) return null;
            const installedVersion = await readInstalledVersion(pluginRoot);
            if (installedVersion === null) return null;
            const latest = await resolveLatestVersion({ dataRoot, fetchImpl, nowMs, lockOperations });
            if (latest.fatal || latest.deferred) return null;
            await writeFile(checkedPath, '', { flag: 'wx', mode: 0o600 });
            const latestVersion = latest.cached?.latestVersion;
            if (latestVersion === null || latestVersion === undefined || compareCalVer(installedVersion, latestVersion) !== -1) return null;
            return { installedVersion, latestVersion };
        } finally {
            await release().catch(() => {});
        }
    } catch {
        return null;
    }
};

export const runHook = async ({ input, env, fetchImpl, nowMs = Date.now() }) => {
    try {
        const event = validateEvent(input);
        const paths = resolvePluginPaths(env);
        if (event === null || paths === null || typeof fetchImpl !== 'function' || !Number.isSafeInteger(nowMs)) return '';
        const update = await checkUpdateForSession({ ...paths, event, fetchImpl, nowMs });
        if (update === null) return '';
        return `${JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                additionalContext: buildAdditionalContext(update.installedVersion, update.latestVersion),
            },
        })}\n`;
    } catch {
        return '';
    }
};

const readStdin = async () => {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
        length += chunk.byteLength;
        if (length > MAX_STDIN_BYTES) throw new Error('input too large');
        chunks.push(chunk);
    }
    if (length === 0) throw new Error('empty input');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

export const main = async () => {
    try {
        const input = await readStdin();
        const output = await runHook({ input, env: process.env, fetchImpl: globalThis.fetch, nowMs: Date.now() });
        if (output !== '') process.stdout.write(output);
    } catch {
        // Command hooks must always fail open without polluting the agent response or diagnostics.
    }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
