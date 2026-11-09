import { isRecord as record } from '../../../shared/values.mjs';
import { extensionSnapshotFailure, isCodexClientName } from '../../contract/evidence.mjs';
import { FEEDBACK_EVIDENCE_TIMEOUT_MS } from '../domain/constants/limits.const.mjs';
import { feedbackExtensionLog, INSTALLATION_SLOTS } from '../domain/policies/evidence.policy.mjs';
import { diagnosticCheck } from '../../../transport/diagnostics/vocabulary.mjs';
// The same host gate as scoped diagnosis: the Codex inspector runs only for a Codex client.
// Parse boundary: the bridge status, read field by field.
const isCodexClient = (status) => {
    const diagnostics = record(status) ? status.diagnostics : undefined;
    const client = record(diagnostics) ? diagnostics.client : undefined;
    const facts = record(client) ? client.facts : undefined;
    return isCodexClientName(record(facts) ? facts.name : undefined);
};
// Every probe is read-only and best effort. A thrown probe contributes nothing; a probe that observes a
// failure contributes that closed observation. A hang is abandoned at the deadline, because settle cannot
// cancel a stalled read of a network profile or a cold inspector and a report must never be lost to the
// evidence gathered for it; where the device can speak for the abandonment it says so through onTimeout.
const settle = (task, timeoutMs, onTimeout = () => undefined) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    Promise.resolve()
        .then(task)
        .then((value) => {
        clearTimeout(timer);
        resolve(value);
    }, () => {
        clearTimeout(timer);
        resolve(undefined);
    });
});
/**
 * The device evidence a feedback report carries: the passive bridge status plus, collected in parallel
 * and each bounded by the same deadline, one read-only extension snapshot, the packaged installation
 * facts, where the extension is installed, on a Codex client the hook trust state, and without a connected
 * extension its own connection log. Every addition is a closed diagnostic check that the feedback
 * projection selects field by field.
 *
 * `adapters` are the collectors the composition root binds: the doctor, the profile probe, the Codex hook inspector, the
 * extension's log with its check, and the diagnosis's snapshot check.
 */
export const collectDeviceEvidence = async (dependencies, adapters) => {
    const { getBridgeStatus, requestExtensionDiagnosticSnapshot, collectInstallation = adapters.collectInstallation, probeExtensionInstall = adapters.probeExtensionInstall, collectHookPermissions = adapters.collectHookPermissions, 
    // The log reader finds its profiles through the same probe, so an injected probe keeps it off this machine too. The
    // dispatcher passes its own reader, which reads the browser the runtime names.
    collectExtensionLog = (options) => adapters.readExtensionLog({ ...options, probeExtensionInstall }), now = Date.now, timeoutMs = FEEDBACK_EVIDENCE_TIMEOUT_MS, } = dependencies;
    // A status failure is the caller's closed bridge_status_collection observation; it is not swallowed here.
    // Parse boundary: the bridge status, read field by field.
    const status = await getBridgeStatus();
    const extensionConnected = record(status) && status.extensionConnected === true;
    const observedAt = new Date(now()).toISOString();
    const snapshotFailure = (code) => diagnosticCheck({ check: 'extension_snapshot', ...extensionSnapshotFailure(code), observedAt, executionPlane: 'device' });
    // Without a connected route nothing can be asked; the observation is a missing connection, never a
    // missing capability, and it costs no wait.
    const snapshot = extensionConnected
        ? settle(() => adapters.collectExtensionSnapshotCheck({ requestExtensionDiagnosticSnapshot, observedAt, timeoutMs }), timeoutMs, () => snapshotFailure('EXTENSION_DIAGNOSTIC_TIMEOUT'))
        : Promise.resolve(snapshotFailure('EXTENSION_DISCONNECTED'));
    // Parse boundary: what each collector answered, narrowed below.
    const [extensionSnapshot, installation, extensionInstall, hookPermissions, extensionLog] = await Promise.all([
        snapshot,
        settle(() => collectInstallation({ observedAt }), timeoutMs),
        settle(() => probeExtensionInstall({ now }), timeoutMs),
        // The inspector carries its own timeout, but it shares this deadline and the outer timer is armed
        // first, so its typed observation can never win. Our own abandonment is a device observation:
        // dropping the slot instead would read as a host that was never a Codex client at all.
        isCodexClient(status)
            ? settle(() => collectHookPermissions({ now, timeoutMs }), timeoutMs, () => diagnosticCheck({
                check: 'hook_permissions',
                state: 'unknown',
                observedAt,
                source: 'device_process',
                executionPlane: 'device',
                cause: 'unavailable',
            }))
            : undefined,
        // A connected extension answers for itself through the snapshot; without one, its log on disk is what remains.
        extensionConnected ? undefined : settle(() => collectExtensionLog({ now }), timeoutMs),
    ]);
    const diagnostics = { ...(record(status) && record(status.diagnostics) ? status.diagnostics : {}) };
    if (record(extensionSnapshot))
        diagnostics.extensionSnapshot = extensionSnapshot;
    const installationChecks = record(installation) && Array.isArray(installation.checks) ? installation.checks : [];
    for (const check of installationChecks) {
        const slot = record(check) && typeof check.check === 'string'
            ? INSTALLATION_SLOTS[check.check]
            : undefined;
        if (slot)
            diagnostics[slot] = check;
    }
    if (record(extensionInstall))
        diagnostics.extensionInstall = extensionInstall;
    if (record(hookPermissions))
        diagnostics.hookPermissions = hookPermissions;
    if (record(extensionLog))
        diagnostics.extensionLog = adapters.extensionLogCheck(extensionLog, { observedAt, nowMs: Date.parse(observedAt) });
    return { ...(record(status) ? status : {}), diagnostics };
};
/**
 * The log rows, read within the evidence deadline. A reader that is missing, throws or hangs gives none: the report is
 * never lost to the evidence gathered for it. Accepted residual "A failed extension-log read looks like an empty log":
 * docs/architecture/residuals/feedback.md.
 */
const readFeedbackExtensionLogRows = ({ readExtensionLogRows, timeoutMs = FEEDBACK_EVIDENCE_TIMEOUT_MS, }) => readExtensionLogRows ? settle(async () => (await readExtensionLogRows())?.rows, timeoutMs) : Promise.resolve(undefined);
/**
 * Reads the log rows within the evidence deadline and builds the archive file from them.
 */
export const collectFeedbackExtensionLog = async ({ readExtensionLogRows, timeoutMs, ...options }) => feedbackExtensionLog(await readFeedbackExtensionLogRows({ readExtensionLogRows, timeoutMs }), options);
