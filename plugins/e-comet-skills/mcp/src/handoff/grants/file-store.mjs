import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateTriggerUrl } from '../call-result.mjs';
import { GRANT_POLICIES, SIGNED_LOCAL_TOOLS, isEntryFresh, validateTargetTool, } from './policy.mjs';
import { HandoffError } from '../hook-io.mjs';
import { hashSessionId as sessionHash, isValidSessionId, SESSION_ID_MAX_BYTES } from '../session.mjs';
import { isRecord } from '../../shared/values.mjs';
import { resolvePluginDataRoot } from '../../storage/files/layout.mjs';
import { sweepExpired } from '../../storage/files/retention.mjs';
import { RETRY_POLICIES, retryTransientFileOperation } from '../../storage/files/transient-retry.mjs';
import { safeFeedbackProperty } from '../../transport/failures/evidence.mjs';
const { lifetimeMs: HANDOFF_TTL_MS, clockSkewMs: CLOCK_SKEW_MS } = GRANT_POLICIES.BROWSER_JOB;
const STORE_DIRECTORY = 'browser-job-handoff-v1';
const CLAIM_MARKER_SUFFIX = '.claimed';
const SESSION_HASH_SOURCE = '[a-f0-9]{64}';
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SIGNED_TOOLS_SOURCE = [...SIGNED_LOCAL_TOOLS].join('|');
// Everything this hook may ever create in its root directory: one pending authorization, the marker that
// consumes it exactly once, and the temporary name an authorization is published from. Housekeeping
// recognizes nothing else, so a foreign file in the same directory is never touched — including every
// leftover of the previous build (`<hash>.json`, `.claim-*`, `.stage-*`, `.collision-*`, `<hash>.lock`),
// which is neither read nor removed.
const OWN_STATE_FILE = new RegExp(`^${SESSION_HASH_SOURCE}-(?:${SIGNED_TOOLS_SOURCE})-${UUID_SOURCE}\\.json(?:\\.claimed|\\.tmp-${UUID_SOURCE})?$`);
const validateSessionId = (sessionId) => {
    if (!isValidSessionId(sessionId, SESSION_ID_MAX_BYTES.BROWSER_JOB)) {
        throw new HandoffError('HANDOFF_INVALID_SESSION', 'The desktop session identifier is invalid.');
    }
    return sessionId;
};
const hashSessionId = (sessionId) => sessionHash(validateSessionId(sessionId));
export const resolveStoreDirectory = (env) => {
    const pluginData = resolvePluginDataRoot(env, 'browser-job');
    if (pluginData.state !== 'ready') {
        throw new HandoffError('HANDOFF_DATA_DIR_UNAVAILABLE', 'The desktop client did not provide writable plugin storage.');
    }
    return join(pluginData.path, STORE_DIRECTORY);
};
const entryFilePattern = (sessionId, targetTool) => new RegExp(`^${hashSessionId(sessionId)}-${targetTool}-${UUID_SOURCE}\\.json$`);
// Parse boundary: a stored file is checked field by field before it is trusted.
const parseStoredEntry = (text, { requireTarget = false } = {}) => {
    let entry;
    try {
        entry = JSON.parse(text);
    }
    catch {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    if (!isRecord(entry) || entry.version !== 1 || typeof entry.createdAtMs !== 'number' || !Number.isSafeInteger(entry.createdAtMs)) {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    const triggerUrl = validateTriggerUrl(entry.triggerUrl);
    const targetTool = entry.targetTool;
    if (targetTool !== undefined && (typeof targetTool !== 'string' || !SIGNED_LOCAL_TOOLS.has(targetTool))) {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    if (requireTarget && targetTool === undefined) {
        throw new HandoffError('HANDOFF_INVALID_ENTRY', 'The pending browser authorization is invalid.');
    }
    return { version: 1, createdAtMs: entry.createdAtMs, triggerUrl, ...(targetTool === undefined ? {} : { targetTool }) };
};
export const ensurePrivateStoreDirectory = async (dataDirectory) => {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await chmod(dataDirectory, 0o700);
    }
};
// The one-use election: exclusive creation of the marker, which exactly one caller passes on every filesystem the
// plugin ships on. Under a policy with `staleMarkerMs` (feedback), a marker left by a hook killed mid-claim would deny
// every later claim of the session, so one older than any possible run is removed with `remove` and the election
// retried once. Age is the file's own clock, like every other sweep. Two claimers that both observe one stale marker
// can each remove what the other just created and both hold the election; for feedback the outcome is one repeated PUT
// of the same archive to the same object key, which storage answers with 412. See the accepted residuals in
// docs/architecture/residuals/feedback.md.
export const createClaimMarker = async (markerPath, { staleMarkerMs, remove }) => {
    const create = () => writeFile(markerPath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (staleMarkerMs === undefined)
        return create();
    try {
        await create();
        return;
    }
    catch (error) {
        if (safeFeedbackProperty(error, 'code') !== 'EEXIST')
            throw error;
    }
    const metadata = await stat(markerPath).catch(() => undefined);
    if (metadata !== undefined && Date.now() - metadata.mtimeMs > staleMarkerMs) {
        await remove(markerPath).catch(() => undefined);
    }
    await create();
};
// Age is the whole housekeeping rule. The window is the authorization lifetime plus the clock skew a
// staging process may have against a claiming one, so a file this hook still considers claimable is
// never removed. A removal that cannot happen now is retried by the next ordinary run: the shared
// sweep never rejects and prints at most one STORAGE_CLEANUP_PENDING line to stderr on failure.
const sweepStore = (dataDirectory, fileNowMs) => sweepExpired({
    directory: dataDirectory,
    ownName: (name) => OWN_STATE_FILE.test(name),
    retentionMs: HANDOFF_TTL_MS + CLOCK_SKEW_MS,
    now: fileNowMs,
});
const removeQuietly = async (path) => {
    try {
        await retryTransientFileOperation(() => rm(path, { force: true }), RETRY_POLICIES.BROWSER_JOB);
        return true;
    }
    catch {
        return false;
    }
};
export const stageTriggerUrl = async ({ dataDirectory, sessionId, triggerUrl, targetTool, nowMs = Date.now(), fileNow = Date.now, }) => {
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
        await retryTransientFileOperation(() => rename(temporaryPath, entryPath), RETRY_POLICIES.BROWSER_JOB);
    }
    catch (error) {
        // The temporary file belongs to this call alone; if it cannot go now, it ages out.
        await removeQuietly(temporaryPath);
        throw error;
    }
};
export const claimTriggerUrl = async ({ dataDirectory, sessionId, targetTool, nowMs = Date.now(), fileNow = Date.now, }) => {
    const session = validateSessionId(sessionId);
    const tool = validateTargetTool(targetTool);
    await ensurePrivateStoreDirectory(dataDirectory);
    const fileNowMs = fileNow();
    await sweepStore(dataDirectory, fileNowMs);
    const entries = await readdir(dataDirectory, { withFileTypes: true });
    const present = new Set(entries.map((entry) => entry.name));
    const pattern = entryFilePattern(session, tool);
    const candidates = [];
    for (const entry of entries) {
        const { name } = entry;
        // Only a regular file can be an authorization: a directory or symlink of that name is never
        // read, aged or removed here, so it can neither wedge the store nor smuggle foreign bytes in.
        if (!entry.isFile() || !pattern.test(name) || present.has(`${name}${CLAIM_MARKER_SUFFIX}`))
            continue;
        let metadata;
        try {
            metadata = await stat(join(dataDirectory, name));
        }
        catch (error) {
            if (safeFeedbackProperty(error, 'code') === 'ENOENT')
                continue;
            throw error;
        }
        // The file clock decides visibility and tolerates skew; the entry timestamp decides expiry.
        if (fileNowMs - metadata.mtimeMs > HANDOFF_TTL_MS + CLOCK_SKEW_MS)
            continue;
        candidates.push(name);
    }
    const [candidate] = candidates;
    if (candidate === undefined) {
        // browser_job stages its authorization only after it returns, so a local call issued beside it finds none yet.
        throw new HandoffError('HANDOFF_MISSING', 'No browser authorization is waiting for this conversation.', 'If browser_job ran in the same parallel step as this call, retry this local tool alone once, without a new browser_job; otherwise call browser_job once for the intended local tool, then retry without model-authored authorization fields.');
    }
    if (candidates.length > 1) {
        // Authorizations are sequential, so two waiting ones cannot both be the intended job. Neither is
        // consumed into this call, and both are invalidated: an abandoned earlier authorization must not
        // block the conversation for the rest of its lifetime, and the recovery text below has to be
        // true when it asks for exactly one fresh browser_job.
        for (const name of candidates) {
            const path = join(dataDirectory, name);
            if (await removeQuietly(path))
                continue;
            // Retain the ordinary consumption marker while the authorization cannot be deleted.
            // If neither removal nor invalidation works, surface storage failure before advising a refresh.
            try {
                await writeFile(`${path}${CLAIM_MARKER_SUFFIX}`, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            }
            catch (error) {
                if (safeFeedbackProperty(error, 'code') !== 'EEXIST')
                    throw error;
            }
        }
        throw new HandoffError('HANDOFF_MISSING', 'Several browser authorizations were waiting for this conversation; all of them were invalidated.');
    }
    const entryPath = join(dataDirectory, candidate);
    const markerPath = `${entryPath}${CLAIM_MARKER_SUFFIX}`;
    try {
        // Exclusive creation is the one-use primitive: exactly one caller can ever pass this line for
        // this authorization, on every filesystem the plugin ships on.
        await createClaimMarker(markerPath, { staleMarkerMs: GRANT_POLICIES.BROWSER_JOB.staleMarkerMs, remove: removeQuietly });
    }
    catch (error) {
        if (safeFeedbackProperty(error, 'code') !== 'EEXIST')
            throw error;
        throw new HandoffError('HANDOFF_MISSING', 'No unambiguous browser authorization is waiting for this conversation.');
    }
    try {
        let text;
        try {
            text = await readFile(entryPath, 'utf8');
        }
        catch (error) {
            if (safeFeedbackProperty(error, 'code') !== 'ENOENT')
                throw error;
            throw new HandoffError('HANDOFF_MISSING', 'No browser authorization is waiting for this conversation.');
        }
        const entry = parseStoredEntry(text, { requireTarget: true });
        if (!isEntryFresh(entry, nowMs)) {
            throw new HandoffError('HANDOFF_EXPIRED', 'The pending browser authorization expired.');
        }
        if (entry.targetTool !== targetTool) {
            throw new HandoffError('HANDOFF_TOOL_MISMATCH', 'The pending browser authorization does not match this local tool.');
        }
        return entry.triggerUrl;
    }
    finally {
        // The authorization goes first: while it exists, its marker must stay to keep it consumed.
        if (await removeQuietly(entryPath))
            await removeQuietly(markerPath);
    }
};
// The browser-job grants in the host's plugin data. `open()` resolves the store directory for one event, so missing
// plugin storage is refused where the flow first touches the store.
export const createFileGrantStore = ({ env, fileNow = Date.now, }) => ({
    open: () => {
        const dataDirectory = resolveStoreDirectory(env);
        return {
            stage: (grant) => stageTriggerUrl({ dataDirectory, ...grant, fileNow }),
            claim: (request) => claimTriggerUrl({ dataDirectory, ...request, fileNow }),
        };
    },
});
