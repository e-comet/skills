// The e-Comet extension's own record of its native connection, read from the browser profile on disk when no broker
// answers (spec §1, §7.1): the link that is broken is not needed to read it. Read-only and on the failure path only.
// Only our extension's storage directory is opened, and only its two log keys are decoded; only `native-connection`
// rows with a known action reach the projection, and Chrome's close text is reduced to a closed class here.
import * as fsPromises from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';

import { chosenBrowser } from './bridge-cause.mjs';
import { EXTENSION_ID, probeBrowserExtensionInstall } from './browser-extension-install.mjs';
import { EXTENSION_LOG_LIMITS } from './config.mjs';
import { diagnosticCheck, extensionLogFactsSchema } from './diagnostic-facts.mjs';
import { readLevelDbValues } from './leveldb-read.mjs';
import { validateSchemaValue } from './schema-validation.mjs';

/**
 * @typedef {{ state: 'read' | 'no_log' | 'no_profile' | 'unreadable' | 'format_unknown' | 'truncated',
 *   browser?: string, runningSinceMs?: number, profileOpen?: false, readAtMs?: number, systemCode?: string,
 *   lastTriggerAtMs?: number, lastHandshakeAtMs?: number,
 *   lastClose?: { class: string, atMs: number, handshaken: boolean },
 *   streak?: { open: boolean, startedAtMs: number },
 *   startFailureAtMs: number[], refusedAtMs?: number }} ExtensionLogEvidence
 */

// The actions the extension's native-connection-log.ts writes. A row with any other action is not ours to interpret.
export const NATIVE_LOG_ACTIONS = Object.freeze(['native_trigger', 'native_host_missing', 'native_host_found', 'native_handshake_completed',
    'native_session_ended', 'native_start_failed', 'native_connect_refused']);
// Newer extensions keep the connection rows under their own key, the newest 100, so WB traffic cannot rotate them out of
// the shared log; older ones have only the shared log.
const CONNECTION_KEY = 'ecomet_native_connection_log';
const REQUEST_KEY = 'ecomet_request_logs';
// A row stamped further ahead than this comes from a clock that is not ours to trust, and never counts.
const FUTURE_TOLERANCE_MS = 60_000;

// Chrome's own texts (developer.chrome.com, native messaging, "Debug native messaging"); the first two are also the
// extension's HOST_MISSING_REASON. Matched case-insensitively, never copied. The policy block's text is not on that page;
// it is what Chrome 156 wrote under NativeMessagingBlocklist (stand, 2026-10-27).
/** @type {Array<[RegExp, string]>} */
const CLOSE_TEXTS = [
    [/native messaging host not found/i, 'host_not_found'],
    [/native messaging host is forbidden/i, 'host_forbidden'],
    [/native messaging host was disabled by the system administrator/i, 'host_blocked'],
    [/native host has exited/i, 'host_exited'],
    [/failed to start native messaging host/i, 'start_failed'],
    [/error when communicating with the native messaging host/i, 'communication_error'],
    // The extension's own close reason (local-agent-connection.ts) when a started connector does not answer within 15 s.
    [/^handshake timeout$/i, 'start_failed'],
];
export const classifyNativeClose = (/** @type {unknown} */ text) =>
    (typeof text === 'string' && CLOSE_TEXTS.find(([pattern]) => pattern.test(text))?.[1]) || 'other';

// A host-missing close opens a streak; any sign the browser found the host (a handshake, a found row, a close of
// another kind, which the extension writes after a worker restart without a found row) ends it.
const CLOSE_ACTIONS = new Set(['native_host_missing', 'native_session_ended', 'native_start_failed']);
const STREAK_ENDS = new Set(['native_host_found', 'native_handshake_completed', 'native_session_ended', 'native_start_failed']);

/** @returns {any[]} */
const nativeRows = (/** @type {unknown[]} */ rows, /** @type {number} */ nowMs) => rows
    .filter((/** @type {any} */ row) => row?.requestId === 'native-connection' && NATIVE_LOG_ACTIONS.includes(row.data?.action)
        && Number.isFinite(row.timestamp) && row.timestamp <= nowMs + FUTURE_TOLERANCE_MS)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.timestamp - b.timestamp);

const project = (/** @type {any[]} */ rows) => {
    /** @type {Omit<ExtensionLogEvidence, 'state'>} */
    const evidence = { startFailureAtMs: [] };
    /** @type {{ open: boolean, startedAtMs: number } | undefined} */
    let streak;
    for (const { timestamp: at, data } of rows) {
        const { action } = data;
        if (action === 'native_trigger') evidence.lastTriggerAtMs = at;
        if (action === 'native_handshake_completed') evidence.lastHandshakeAtMs = at;
        if (action === 'native_connect_refused') evidence.refusedAtMs = at;
        if (action === 'native_start_failed') evidence.startFailureAtMs.push(at);
        // The extension writes these fields and actions; no contract pins them. Accepted residual "The extension's
        // connection log is guarded only by the cross-repository test": docs/local-agent-architecture.md#accepted-residuals.
        if (CLOSE_ACTIONS.has(action)) {
            const handshaken = action === 'native_session_ended' || (action === 'native_start_failed' && data.handshaken === true);
            evidence.lastClose = { class: classifyNativeClose(data.reason), atMs: at, handshaken };
        }
        if (action === 'native_host_missing' && !streak?.open) streak = { open: true, startedAtMs: at };
        else if (streak?.open && STREAK_ENDS.has(action)) streak = { open: false, startedAtMs: streak.startedAtMs };
    }
    return streak ? { ...evidence, streak } : evidence;
};

/** @returns {{ state: ExtensionLogEvidence['state'], rows?: unknown[], systemCode?: string }} */
const decode = (/** @type {import('./leveldb-read.mjs').LevelDbReadResult} */ result) => {
    if (result.state === 'absent' || result.state === 'deleted') return { state: 'no_log' };
    if (result.state !== 'found') return { state: result.state, ...(result.systemCode ? { systemCode: result.systemCode } : {}) };
    try {
        const rows = JSON.parse(/** @type {Buffer} */ (result.value).toString('utf8'));
        return Array.isArray(rows) ? { state: 'read', rows } : { state: 'format_unknown' };
    } catch {
        return { state: 'format_unknown' };
    }
};

// One pass over the database files finds both keys, within one byte total and the caller's deadline. The projection
// decodes the connection key and, only when it is absent, the shared log; the report file (`withRows`) takes the whole
// shared log plus the connection rows it no longer holds (rotated out, so older: they go first).
const readProfile = async (/** @type {string} */ dir, /** @type {{ fileSystem: any, deadline: number, clock: () => number, withRows: boolean }} */ options) => {
    const { fileSystem, deadline, clock, withRows } = options;
    const values = await readLevelDbValues({ dir, keys: [CONNECTION_KEY, REQUEST_KEY], fileSystem, deadline, clock });
    const connection = decode(values[CONNECTION_KEY]);
    if (connection.rows && !withRows) return { state: /** @type {const} */ ('read'), native: connection.rows };
    const history = decode(values[REQUEST_KEY]);
    if (!connection.rows && !history.rows) return connection.state === 'no_log' ? history : connection;
    const shared = history.rows ?? [];
    const kept = new Set(shared.map((row) => JSON.stringify(row)));
    return { state: /** @type {const} */ ('read'), native: connection.rows ?? shared,
        rows: [...(connection.rows ?? []).filter((row) => !kept.has(JSON.stringify(row))), ...shared] };
};

/** @typedef {{ browser: string, path: string, state: string, lastUsedAtMs?: number, lastFocused?: boolean, open?: boolean }} ProfilePath */
// Profiles used the same day tie on whole days, and the files of an unfocused profile can be the newer (stand, Chrome
// 156), so the profile focused last goes first, then one with an open window, then the newest files; unknown use last.
const usedBefore = (/** @type {ProfilePath} */ a, /** @type {ProfilePath} */ b) => Number(b.lastFocused === true) - Number(a.lastFocused === true)
    || Number(b.open === true) - Number(a.open === true) || (b.lastUsedAtMs ?? 0) - (a.lastUsedAtMs ?? 0);

// One profile: the enabled profile of the browser the cause names that was used last. A caller that knows the browser
// (the cause it judged, the connected extension's own) passes it; otherwise the chooser picks from this probe and the
// policies the caller passes. All of its file reads share EXTENSION_LOG_LIMITS.timeoutMs.
const readSelected = async (/** @type {any} */ { now = Date.now, platform = process.platform, env = process.env, home = homedir(), fileSystem = fsPromises,
    probeExtensionInstall = probeBrowserExtensionInstall, browser = undefined, policy = null, clock = () => performance.now(), withRows = false } = {}) => {
    /** @type {ProfilePath[]} */
    const profilePaths = [];
    const probe = await probeExtensionInstall({ now, platform, env, home, fileSystem, profilePaths });
    const name = browser ?? chosenBrowser({ probe, policy });
    const profile = profilePaths.filter((item) => item.browser === name && item.state === 'enabled').sort(usedBefore)[0];
    if (!profile) return { evidence: /** @type {ExtensionLogEvidence} */ ({ state: 'no_profile', startFailureAtMs: [] }), rows: [] };

    const join = platform === 'win32' ? win32.join : posix.join;
    const read = await readProfile(join(profile.path, 'Local Extension Settings', EXTENSION_ID),
        { fileSystem, deadline: clock() + EXTENSION_LOG_LIMITS.timeoutMs, clock, withRows });
    const install = probe?.facts?.browsers?.find((/** @type {any} */ item) => item.browser === profile.browser);
    const runningSinceMs = install?.running === true ? Date.parse(install.runningSince) : NaN;
    const readAtMs = now();
    /** @type {ExtensionLogEvidence} */
    const evidence = {
        state: /** @type {ExtensionLogEvidence['state']} */ (read.state),
        browser: profile.browser,
        ...(Number.isFinite(runningSinceMs) ? { runningSinceMs } : {}),
        // Internal only: the rules ignore the rows of a profile the browser lists as closed; the facts never carry it.
        ...(profile.open === false ? { profileOpen: /** @type {const} */ (false) } : {}),
        // Internal only, too: status judges a read it keeps at this time, not at its own clock.
        readAtMs,
        ...('systemCode' in read && read.systemCode ? { systemCode: read.systemCode } : {}),
        ...project('native' in read ? nativeRows(read.native, readAtMs) : []),
    };
    return { evidence, rows: 'rows' in read && read.rows ? read.rows : [] };
};

/** @returns {Promise<ExtensionLogEvidence>} */
export const collectExtensionLog = async (/** @type {any} */ options = {}) => (await readSelected(options)).evidence;

/**
 * The selected profile's log rows as the extension stored them, unfiltered, from both keys, for the report file only:
 * never a tool result or model context.
 * @returns {Promise<{ state: ExtensionLogEvidence['state'], rows: unknown[] }>}
 */
export const readExtensionLogRows = async (/** @type {any} */ options = {}) => {
    const { evidence, rows } = await readSelected({ ...options, withRows: true });
    return { state: evidence.state, rows };
};

const CHECK_STATES = {
    read: { state: 'passed' },
    no_log: { state: 'passed' },
    no_profile: { state: 'not_checked', cause: 'directory_absent' },
    format_unknown: { state: 'unknown', cause: 'corrupt' },
    truncated: { state: 'unknown', cause: 'unavailable' },
};

/**
 * The closed `extension_log` check: whole-second ages instead of times, and start failures since the browser started
 * (all of them when its start is unknown).
 * @param {ExtensionLogEvidence} evidence
 * @param {{ observedAt: string, nowMs: number }} options
 */
export const extensionLogCheck = (evidence, { observedAt, nowMs }) => {
    const base = { check: 'extension_log', observedAt, source: 'browser_profile_storage', executionPlane: 'device' };
    const ago = (/** @type {number} */ at) => Math.max(0, Math.floor((nowMs - at) / 1000));
    const since = evidence.runningSinceMs;
    const facts = {
        reader: evidence.state,
        ...(evidence.browser === undefined ? {} : { browser: evidence.browser }),
        ...(evidence.lastTriggerAtMs === undefined ? {} : { lastTriggerAgoS: ago(evidence.lastTriggerAtMs) }),
        ...(evidence.lastHandshakeAtMs === undefined ? {} : { lastHandshakeAgoS: ago(evidence.lastHandshakeAtMs) }),
        ...(evidence.lastClose ? { lastClose: { class: evidence.lastClose.class, agoS: ago(evidence.lastClose.atMs), handshaken: evidence.lastClose.handshaken } } : {}),
        ...(evidence.streak ? { missingStreak: { open: evidence.streak.open, startedAgoS: ago(evidence.streak.startedAtMs) } } : {}),
        startFailures: evidence.startFailureAtMs.filter((at) => since === undefined || at > since).length,
        ...(evidence.refusedAtMs === undefined ? {} : { refused: 'extension_id_mismatch' }),
    };
    if (!validateSchemaValue(facts, extensionLogFactsSchema)) return diagnosticCheck({ ...base, state: 'unknown', cause: 'unknown' });
    const outcome = evidence.state === 'unreadable'
        ? { state: 'failed', cause: ['EACCES', 'EPERM'].includes(/** @type {string} */ (evidence.systemCode)) ? 'permission_denied' : 'io_error' }
        : CHECK_STATES[evidence.state];
    return diagnosticCheck({ ...base, ...outcome, facts });
};
