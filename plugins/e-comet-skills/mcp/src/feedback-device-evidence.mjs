import { FEEDBACK_EVIDENCE_TIMEOUT_MS } from './config.mjs';
import { diagnosticCheck } from './diagnostic-facts.mjs';
import { collectExtensionSnapshotCheck, extensionSnapshotFailure, isCodexClientName } from './diagnose.mjs';
import { collectDoctorReport } from './doctor.mjs';
import { probeBrowserExtensionInstall } from './browser-extension-install.mjs';
import { collectCodexHookPermissions } from './codex-hook-permissions.mjs';
import { collectExtensionLog as readExtensionLogEvidence, extensionLogCheck } from './extension-log.mjs';
import { isCredentialName, redactFeedbackText } from './feedback-report.mjs';

// Installation checks worth carrying in a report, keyed by the doctor's check name. The doctor's own
// runtime and storage checks duplicate what the status already holds and are left out.
const INSTALLATION_SLOTS = Object.freeze({
    package_layout: 'packageLayout',
    package_metadata: 'packageMetadata',
    codex_manifest: 'codexManifest',
    mcp_configuration: 'mcpConfiguration',
    entrypoint: 'entrypoint',
});

const record = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// The same host gate as scoped diagnosis: the Codex inspector runs only for a Codex client.
const isCodexClient = (/** @type {any} */ status) => isCodexClientName(status?.diagnostics?.client?.facts?.name);
// Every probe is read-only and best effort. A thrown probe contributes nothing; a probe that observes a
// failure contributes that closed observation. A hang is abandoned at the deadline, because settle cannot
// cancel a stalled read of a network profile or a cold inspector and a report must never be lost to the
// evidence gathered for it; where the device can speak for the abandonment it says so through onTimeout.
const settle = (/** @type {() => Promise<unknown>} */ task, /** @type {number} */ timeoutMs, /** @type {() => unknown} */ onTimeout = () => undefined) =>
    new Promise((resolve) => {
        const timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
        Promise.resolve().then(task).then(
            (value) => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(undefined); },
        );
    });

/**
 * The device evidence a feedback report carries: the passive bridge status plus, collected in parallel
 * and each bounded by the same deadline, one read-only extension snapshot, the packaged installation
 * facts, where the extension is installed, on a Codex client the hook trust state, and without a connected
 * extension its own connection log. Every addition is a closed diagnostic check that the feedback
 * projection selects field by field.
 *
 * @param {{ getBridgeStatus: () => unknown, requestExtensionDiagnosticSnapshot?: (timeoutMs?: number) => Promise<unknown>, collectInstallation?: (input: { observedAt: string }) => Promise<unknown>, probeExtensionInstall?: (input: any) => Promise<unknown>, collectHookPermissions?: (input: { now: () => number, timeoutMs: number }) => Promise<unknown>, collectExtensionLog?: (input: { now: () => number }) => Promise<unknown>, now?: () => number, timeoutMs?: number }} dependencies
 */
export const collectFeedbackDeviceEvidence = async ({
    getBridgeStatus,
    requestExtensionDiagnosticSnapshot,
    collectInstallation = collectDoctorReport,
    probeExtensionInstall = probeBrowserExtensionInstall,
    collectHookPermissions = collectCodexHookPermissions,
    // The log reader finds its profiles through the same probe, so an injected probe keeps it off this machine too. The
    // dispatcher passes its own reader, which reads the browser the runtime names.
    collectExtensionLog = (/** @type {any} */ options) => readExtensionLogEvidence({ ...options, probeExtensionInstall }),
    now = Date.now,
    timeoutMs = FEEDBACK_EVIDENCE_TIMEOUT_MS,
}) => {
    // A status failure is the caller's closed bridge_status_collection observation; it is not swallowed here.
    const status = /** @type {any} */ (await getBridgeStatus());
    const observedAt = new Date(now()).toISOString();
    const snapshotFailure = (/** @type {string | undefined} */ code) =>
        diagnosticCheck({ check: 'extension_snapshot', ...extensionSnapshotFailure(code), observedAt, executionPlane: 'device' });
    // Without a connected route nothing can be asked; the observation is a missing connection, never a
    // missing capability, and it costs no wait.
    const snapshot = status?.extensionConnected === true
        ? settle(() => collectExtensionSnapshotCheck({ requestExtensionDiagnosticSnapshot, observedAt, timeoutMs }), timeoutMs, () => snapshotFailure('EXTENSION_DIAGNOSTIC_TIMEOUT'))
        : Promise.resolve(snapshotFailure('EXTENSION_DISCONNECTED'));
    const [extensionSnapshot, installation, extensionInstall, hookPermissions, extensionLog] = /** @type {any[]} */ (await Promise.all([
        snapshot,
        settle(() => collectInstallation({ observedAt }), timeoutMs),
        settle(() => probeExtensionInstall({ now }), timeoutMs),
        // The inspector carries its own timeout, but it shares this deadline and the outer timer is armed
        // first, so its typed observation can never win. Our own abandonment is a device observation:
        // dropping the slot instead would read as a host that was never a Codex client at all.
        isCodexClient(status)
            ? settle(() => collectHookPermissions({ now, timeoutMs }), timeoutMs,
                () => diagnosticCheck({ check: 'hook_permissions', state: 'unknown', observedAt, source: 'device_process', executionPlane: 'device', cause: 'unavailable' }))
            : undefined,
        // A connected extension answers for itself through the snapshot; without one, its log on disk is what remains.
        status?.extensionConnected === true ? undefined : settle(() => collectExtensionLog({ now }), timeoutMs),
    ]));
    const diagnostics = { ...(record(status?.diagnostics) ? status.diagnostics : {}) };
    if (record(extensionSnapshot)) diagnostics.extensionSnapshot = extensionSnapshot;
    for (const check of Array.isArray(installation?.checks) ? installation.checks : []) {
        const slot = record(check) ? INSTALLATION_SLOTS[check.check] : undefined;
        if (slot) diagnostics[slot] = check;
    }
    if (record(extensionInstall)) diagnostics.extensionInstall = extensionInstall;
    if (record(hookPermissions)) diagnostics.hookPermissions = hookPermissions;
    if (record(extensionLog)) diagnostics.extensionLog = extensionLogCheck(extensionLog, { observedAt, nowMs: Date.parse(observedAt) });
    return { ...(record(status) ? status : {}), diagnostics };
};

const CONNECTION_ROWS = 'native-connection';
// One row as the archive stores it: every string passes the report redaction on its own, and a value of any type under
// a credential name (an array of cookies, an object) is replaced whole. Per leaf, because the authorization and cookie
// rules run to the end of a line and would cut every following field of a one-line JSON row.
/** @returns {unknown} */
const redactLeaves = (/** @type {unknown} */ value, key = '') => {
    if (isCredentialName(key) && value !== null && value !== undefined) return '[REDACTED]';
    if (typeof value === 'string') return redactFeedbackText(value);
    // Items of an array keep the name they sit under.
    if (Array.isArray(value)) return value.map((item) => redactLeaves(item, key));
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactLeaves(item, name)]));
    return value;
};
const archivedRow = (/** @type {unknown} */ row) => JSON.stringify(redactLeaves(row));

/**
 * The archive's extension-log.json: the whole log when the history is included, only the connection rows when it is
 * not, cut to `maxBytes`. It keeps the newest rows in the order the extension stored them. Undefined when no row is left.
 * @param {unknown} rows @param {{ includeTranscript: boolean, maxBytes: number }} options
 * @returns {{ text: string, rows: number, trimmed: boolean } | undefined}
 */
const feedbackExtensionLog = (rows, { includeTranscript, maxBytes }) => {
    const candidates = (Array.isArray(rows) ? rows : []).filter((row) => includeTranscript || row?.requestId === CONNECTION_ROWS)
        .map((row, index) => ({ index, text: archivedRow(row) }));
    const kept = [];
    let size = 2;
    for (const item of [...candidates].reverse()) {
        size += Buffer.byteLength(item.text, 'utf8') + (kept.length ? 1 : 0);
        if (size > maxBytes) break;
        kept.push(item);
    }
    if (kept.length === 0) return undefined;
    kept.reverse();
    return { text: `[${kept.map(({ text }) => text).join(',')}]`, rows: kept.length, trimmed: kept.length < candidates.length };
};

/**
 * The log rows, read within the evidence deadline. A reader that is missing, throws or hangs gives none: the report is
 * never lost to the evidence gathered for it. Accepted residual "A failed extension-log read looks like an empty log":
 * docs/local-agent-architecture.md#accepted-residuals.
 * @param {{ readExtensionLogRows?: () => Promise<{ rows?: unknown }>, timeoutMs?: number }} options
 * @returns {Promise<unknown>}
 */
const readFeedbackExtensionLogRows = ({ readExtensionLogRows, timeoutMs = FEEDBACK_EVIDENCE_TIMEOUT_MS }) =>
    readExtensionLogRows ? settle(async () => (await readExtensionLogRows())?.rows, timeoutMs) : Promise.resolve(undefined);

/**
 * Reads the log rows within the evidence deadline and builds the archive file from them.
 * @param {{ readExtensionLogRows?: () => Promise<{ rows?: unknown }>, includeTranscript: boolean, maxBytes: number, timeoutMs?: number }} options
 */
export const collectFeedbackExtensionLog = async ({ readExtensionLogRows, timeoutMs, ...options }) =>
    feedbackExtensionLog(await readFeedbackExtensionLogRows({ readExtensionLogRows, timeoutMs }), options);
