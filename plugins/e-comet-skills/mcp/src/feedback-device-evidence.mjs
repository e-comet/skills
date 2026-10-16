import { FEEDBACK_EVIDENCE_TIMEOUT_MS } from './config.mjs';
import { diagnosticCheck } from './diagnostic-facts.mjs';
import { collectExtensionSnapshotCheck, extensionSnapshotFailure } from './diagnose.mjs';
import { collectDoctorReport } from './doctor.mjs';
import { probeBrowserExtensionInstall } from './browser-extension-install.mjs';
import { collectCodexHookPermissions } from './codex-hook-permissions.mjs';

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
// The Codex configuration inspector describes Codex hook trust; under any other client it would report
// another host's state as this session's. The client name from MCP initialize is the only host signal
// the device holds.
const isCodexClient = (/** @type {any} */ status) => {
    const facts = status?.diagnostics?.client?.facts;
    return record(facts) && typeof facts.name === 'string' && /codex/i.test(facts.name);
};
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
 * facts, where the extension is installed, and on a Codex client the hook trust state. Every addition
 * is a closed diagnostic check that the feedback projection selects field by field.
 *
 * @param {{ getBridgeStatus: () => unknown, requestExtensionDiagnosticSnapshot?: (timeoutMs?: number) => Promise<unknown>, collectInstallation?: (input: { observedAt: string }) => Promise<unknown>, probeExtensionInstall?: (input: { now: () => number }) => Promise<unknown>, collectHookPermissions?: (input: { now: () => number, timeoutMs: number }) => Promise<unknown>, now?: () => number, timeoutMs?: number }} dependencies
 */
export const collectFeedbackDeviceEvidence = async ({
    getBridgeStatus,
    requestExtensionDiagnosticSnapshot,
    collectInstallation = collectDoctorReport,
    probeExtensionInstall = probeBrowserExtensionInstall,
    collectHookPermissions = collectCodexHookPermissions,
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
    const [extensionSnapshot, installation, extensionInstall, hookPermissions] = /** @type {any[]} */ (await Promise.all([
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
    ]));
    const diagnostics = { ...(record(status?.diagnostics) ? status.diagnostics : {}) };
    if (record(extensionSnapshot)) diagnostics.extensionSnapshot = extensionSnapshot;
    for (const check of Array.isArray(installation?.checks) ? installation.checks : []) {
        const slot = record(check) ? INSTALLATION_SLOTS[check.check] : undefined;
        if (slot) diagnostics[slot] = check;
    }
    if (record(extensionInstall)) diagnostics.extensionInstall = extensionInstall;
    if (record(hookPermissions)) diagnostics.hookPermissions = hookPermissions;
    return { ...(record(status) ? status : {}), diagnostics };
};
