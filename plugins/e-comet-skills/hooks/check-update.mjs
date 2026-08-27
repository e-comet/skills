#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CALVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+codex\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ECOMET_TOOL_PATTERN = /^mcp__(?:(?:(?:remote-devices__)?plugin_e-comet-skills_)?e[-_]comet(?:[-_]local)?__.+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__(?:info|describe_metrics|list_entities|query_metrics|query_forecast|browser_job))$/;
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
export const CHANGELOG_URL = 'https://github.com/e-comet/skills/blob/main/CHANGELOG.md';
// Claude Code caps hook output at 10,000 characters; Codex caps a model-visible hook message at
// roughly 2,500 tokens, which for Cyrillic is pessimistically ~3,750 characters. This budget sits
// under the tighter ceiling with margin and still holds far more than the changelog written to date.
export const CHANGELOG_CONTEXT_BUDGET = 3000;
const MAX_CHANGELOG_BYTES = 64 * 1024;
const MAX_RELEASES = 200;
const MAX_ADDED_ENTRIES = 20;
const MAX_ADDED_ENTRY_BYTES = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/e-comet/skills/main/plugins/e-comet-skills/.codex-plugin/plugin.json';
const CACHE_NAME = 'plugin-update-latest-v1.json';
const GLOBAL_LOCK_NAME = 'plugin-update-latest-v1.lock';
const SESSION_DIRECTORY = 'plugin-update-sessions-v1';
const CHANGELOG_STATE_NAME = 'changelog-state-v1.json';
const CHANGELOG_LOCK_NAME = 'changelog-state-v1.lock';

export const REMOTE_INTERVAL_MS = 86_400_000;
export const MAX_FUTURE_SKEW_MS = 300_000;
export const FETCH_TIMEOUT_MS = 2_500;
export const MAX_CALVER_BYTES = 256;

export const normalizeCalVer = (value) => {
    if (typeof value !== 'string') return null;
    if (Buffer.byteLength(value, 'utf8') > MAX_CALVER_BYTES) return null;
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

const normalizeAdded = (value) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ADDED_ENTRIES) return null;
    for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim().length === 0) return null;
        if (Buffer.byteLength(entry, 'utf8') > MAX_ADDED_ENTRY_BYTES) return null;
        if (CONTROL_CHARACTERS.test(entry)) return null;
    }
    return [...value];
};

export const normalizeChangelogFeed = (value, installedVersion) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join('\0') !== ['releases', 'schemaVersion', 'version'].join('\0')) return null;
    if (value.schemaVersion !== 1) return null;
    if (normalizeCalVer(value.version) === null || normalizeCalVer(installedVersion) === null) return null;
    // The top-level version identifies the exact build whose local changelog this is. Numeric CalVer
    // comparison deliberately ignores +codex metadata for release ranges, but build identity must not.
    if (value.version !== installedVersion) return null;
    if (!Array.isArray(value.releases) || value.releases.length > MAX_RELEASES) return null;
    const releases = [];
    let previous = null;
    for (const release of value.releases) {
        if (release === null || typeof release !== 'object' || Array.isArray(release)) return null;
        if (Object.keys(release).sort().join('\0') !== ['added', 'version'].join('\0')) return null;
        if (normalizeCalVer(release.version) === null) return null;
        if (compareCalVer(release.version, value.version) === 1) return null;
        // Strictly descending: selection walks this list newest first and stops when the budget is hit.
        if (previous !== null && compareCalVer(previous, release.version) !== 1) return null;
        const added = normalizeAdded(release.added);
        if (added === null) return null;
        releases.push({ version: release.version, added });
        previous = release.version;
    }
    return { version: value.version, releases };
};

export const normalizeHandledState = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join('\0') !== ['lastHandledVersion', 'schemaVersion'].join('\0')) return null;
    if (value.schemaVersion !== 1) return null;
    return normalizeCalVer(value.lastHandledVersion) === null ? null : value.lastHandledVersion;
};

export const selectChangelogEntries = ({ feed, handledVersion, installedVersion, budget = CHANGELOG_CONTEXT_BUDGET }) => {
    const inRange = feed.releases.filter(
        (release) =>
            compareCalVer(release.version, handledVersion) === 1 && compareCalVer(release.version, installedVersion) !== 1,
    );
    if (inRange.length === 0) return null;
    const totalEntries = inRange.reduce((sum, release) => sum + release.added.length, 0);
    let added = [];
    let taken = 0;
    let prefix = [];
    for (let index = 0; index < inRange.length; index += 1) {
        // Whole releases only: a user never sees half of a version.
        prefix = [...prefix, ...inRange[index].added];
        const rendered = buildChangelogContext(
            installedVersion,
            prefix,
            totalEntries - prefix.length,
            inRange.length - (index + 1),
        );
        // The omission sentence shrinks and eventually disappears, so later cumulative prefixes can
        // fit even when an earlier rendering did not. Retain the deepest whole-release prefix that fits.
        if (rendered.length <= budget) {
            added = prefix;
            taken = index + 1;
        }
    }
    return { added, omittedEntries: totalEntries - added.length, omittedReleases: inRange.length - taken };
};

export const decideChangelogNotice = ({ installedVersion, handledVersion, selection }) => {
    if (handledVersion === null) return { emit: false, store: installedVersion };
    const order = compareCalVer(handledVersion, installedVersion);
    if (order === null) return { emit: false, store: installedVersion };
    // A stored version at or above the installed one is never lowered: a rollback would otherwise
    // re-announce the version the user has already seen every time the plugin moves forward again.
    if (order >= 0) return { emit: false, store: null };
    return { emit: selection !== null, store: installedVersion };
};

// The hosts render the notice as Markdown, so the block is dictated verbatim rather than described:
// a heading line, a bulleted list and a trailing rule that separates the notice from the answer the
// user actually asked for. Describing it left the model free to flatten everything into paragraphs.
const ONE_SHOT_FINAL_INSTRUCTION =
    'Эта одноразовая инструкция относится только к ближайшему итоговому ответу текущего хода. Не выводи уведомление в размышлениях, commentary или промежуточных сообщениях. Покажи уведомление ровно один раз в самом начале ближайшего итогового ответа, даже если в текущем ходе было несколько вызовов инструментов. После отправки этого итогового ответа считай инструкцию исполненной и не повторяй уведомление в последующих ответах.';
const CHANGELOG_INSTRUCTION =
    `${ONE_SHOT_FINAL_INSTRUCTION} Выведи блок ниже дословно вместе со строкой «---», затем дай основной результат. Не упоминай hook или служебный контекст.`;

const buildChangelogBlock = (version, body) =>
    `${CHANGELOG_INSTRUCTION}

**Установлено обновление плагина e-Comet MCP Tools версии ${version}**

${body}

[Все изменения](${CHANGELOG_URL})

---`;

export const buildChangelogContext = (version, added, omittedEntries, omittedReleases) => {
    const tail = omittedEntries > 0
        ? `

За рамками списка: изменений — ${omittedEntries}; предыдущих версий — ${omittedReleases}.`
        : '';
    return buildChangelogBlock(version, `Добавлено:
${added.map((entry) => `- ${entry}`).join('\n')}${tail}`);
};

export const buildChangelogDigestContext = (version) =>
    buildChangelogBlock(version, 'Накопившихся изменений слишком много для короткого перечисления.');

export const validateEvent = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const { hook_event_name: hookEventName, session_id: sessionId, tool_name: toolName } = value;
    if (hookEventName !== 'PreToolUse') return null;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || Buffer.byteLength(sessionId, 'utf8') > MAX_SESSION_BYTES) return null;
    if (typeof toolName !== 'string' || !ECOMET_TOOL_PATTERN.test(toolName)) return null;
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
    const result = realpathSync(path);
    return statSync(result).isDirectory() ? result : null;
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

export const readHandledState = async (stateDir, readStateFile = readBoundedFile) => {
    try {
        const raw = await readStateFile(join(stateDir, CHANGELOG_STATE_NAME), MAX_MANIFEST_BYTES);
        if (raw === null) return { status: 'invalid' };
        let value;
        try {
            value = JSON.parse(raw);
        } catch {
            return { status: 'invalid' };
        }
        const version = normalizeHandledState(value);
        return version === null ? { status: 'invalid' } : { status: 'valid', version };
    } catch (error) {
        return { status: error?.code === 'ENOENT' ? 'missing' : 'error' };
    }
};

export const readChangelogFeed = async (pluginRoot, installedVersion) => {
    try {
        const raw = await readBoundedFile(join(pluginRoot, 'changelog.json'), MAX_CHANGELOG_BYTES);
        return raw === null ? null : normalizeChangelogFeed(JSON.parse(raw), installedVersion);
    } catch {
        return null;
    }
};

const selectFor = async (pluginRoot, handledVersion, installedVersion, readFeed) => {
    const feed = await readFeed(pluginRoot, installedVersion);
    return feed === null ? null : selectChangelogEntries({ feed, handledVersion, installedVersion });
};

export const resolveChangelogNotice = async ({
    acquireStateLock = acquireLock,
    pluginRoot,
    readFeed = readChangelogFeed,
    stateDir,
    lockOperations = {},
    readState = readHandledState,
    writeState = writeAtomicJson,
}) => {
    try {
        if (typeof stateDir !== 'string' || stateDir.length === 0) return null;
        const installedVersion = await readInstalledVersion(pluginRoot);
        if (installedVersion === null) return null;
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        // Unlocked pre-read: the steady state is "already handled", and it must cost two reads and no lock.
        const initialState = await readState(stateDir);
        if (initialState.status === 'error') return null;
        // Covers both already-handled directions, not just equality: after a rollback the older plugin root
        // can only ever decide to do nothing, and must not take the lock to learn that.
        const initialOrder = initialState.status === 'valid' ? compareCalVer(initialState.version, installedVersion) : null;
        if (initialOrder !== null && initialOrder >= 0) return null;

        const release = await acquireStateLock(join(stateDir, CHANGELOG_LOCK_NAME), Date.now(), lockOperations);
        if (release === null) return null;
        try {
            const lockedState = await readState(stateDir);
            if (lockedState.status === 'error') return null;
            const handledVersion = lockedState.status === 'valid' ? lockedState.version : null;
            const selection = compareCalVer(handledVersion, installedVersion) === -1
                ? await selectFor(pluginRoot, handledVersion, installedVersion, readFeed)
                : null;
            const { emit, store } = decideChangelogNotice({ installedVersion, handledVersion, selection });
            if (store !== null) {
                // Persist before emitting: a lost notification is preferred over a repeated one.
                await writeState(join(stateDir, CHANGELOG_STATE_NAME), { schemaVersion: 1, lastHandledVersion: store });
            }
            return emit ? { version: installedVersion, ...selection } : null;
        } finally {
            await release().catch(() => {});
        }
    } catch {
        return null;
    }
};

export const sessionKey = (sessionId) => createHash('sha256').update(sessionId, 'utf8').digest('hex');

export const buildAdditionalContext = (installedVersion, latestVersion) =>
    `${ONE_SHOT_FINAL_INSTRUCTION} Выведи уведомление одной строкой: «Доступно обновление плагина e-Comet MCP Tools: установлена версия ${installedVersion}, доступна версия ${latestVersion}. [Как обновить](${UPDATE_URL})». Затем выведи строку «---» и основной результат. Не упоминай hook или служебный контекст.`;

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

const emit = (additionalContext) =>
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } })}\n`;

export const runHook = async ({ input, env, fetchImpl, nowMs = Date.now() }) => {
    try {
        const event = validateEvent(input);
        const paths = resolvePluginPaths(env);
        if (event === null || paths === null || !Number.isSafeInteger(nowMs)) return '';

        // Path B runs on every matching call: an update can land while a session stays open, and the
        // once-per-version guarantee comes from the stored version rather than the session marker.
        const notice = await resolveChangelogNotice({ pluginRoot: paths.pluginRoot, stateDir: paths.dataRoot });
        if (notice !== null) {
            // Nothing fit the budget: name the version and let the link carry the rest.
            return emit(notice.added.length === 0
                ? buildChangelogDigestContext(notice.version)
                : buildChangelogContext(notice.version, notice.added, notice.omittedEntries, notice.omittedReleases));
        }

        if (typeof fetchImpl !== 'function') return '';
        const update = await checkUpdateForSession({ ...paths, event, fetchImpl, nowMs });
        if (update === null) return '';
        return emit(buildAdditionalContext(update.installedVersion, update.latestVersion));
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
        const output = await runHook({
            input,
            env: process.env,
            fetchImpl: globalThis.fetch,
            nowMs: Date.now(),
        });
        if (output !== '') process.stdout.write(output);
    } catch {
        // Command hooks must always fail open without polluting the agent response or diagnostics.
    }
};

// Node resolves module specifiers through symlinks, so `import.meta.url` is already canonical while
// argv[1] keeps whatever path the host invoked. On macOS the temporary directory alone differs
// (/var vs /private/var), and a symlinked plugin root would otherwise leave the hook silently inert.
const isEntryPoint = (invokedPath) => {
    if (typeof invokedPath !== 'string' || invokedPath.length === 0) return false;
    const modulePath = fileURLToPath(import.meta.url);
    const invoked = resolve(invokedPath);
    if (invoked === modulePath) return true;
    try {
        return realpathSync(invoked) === modulePath;
    } catch {
        return false;
    }
};

if (isEntryPoint(process.argv[1])) await main();
