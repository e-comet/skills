import { isCanonicalTimestamp, isRecord } from '../../../shared/values.mjs';
import { extensionSnapshotFailure, isCodexClientName } from '../../contract/evidence.mjs';
import { diagnosticCheck } from '../../../transport/diagnostics/vocabulary.mjs';
/**
 * One capability-negotiated, read-only extension snapshot as a closed check. Shared by the runtime
 * diagnosis probe and by feedback preparation, which passes its own shorter deadline.
 */
export const collectExtensionSnapshotCheck = async ({ requestExtensionDiagnosticSnapshot, observedAt, timeoutMs = undefined, }) => {
    try {
        // Parse boundary: the extension's snapshot facts, validated on the wire as an object.
        const facts = await requestExtensionDiagnosticSnapshot?.(timeoutMs);
        // The check is dated by the extension's own observation time when it is canonical; the wire
        // admits any short string there, and a non-canonical one must not undate the whole check.
        const factsObservedAt = isRecord(facts) ? facts.observedAt : undefined;
        return isRecord(facts)
            ? diagnosticCheck({
                check: 'extension_snapshot',
                state: 'passed',
                observedAt: typeof factsObservedAt === 'string' && isCanonicalTimestamp(factsObservedAt) ? factsObservedAt : observedAt,
                source: 'extension',
                executionPlane: 'device',
                facts,
            })
            : diagnosticCheck({
                check: 'extension_snapshot',
                state: 'unsupported',
                observedAt,
                source: 'capability_negotiation',
                executionPlane: 'device',
                cause: 'unsupported',
            });
    }
    catch (error) {
        return diagnosticCheck({
            check: 'extension_snapshot',
            ...extensionSnapshotFailure(isRecord(error) ? error.code : undefined),
            observedAt,
            executionPlane: 'device',
        });
    }
};
// A scope or probe whose collaborator nobody wired throws, as calling the missing function did.
const wired = (collaborator, name) => {
    if (collaborator === undefined)
        throw new TypeError(`${name} is not a function`);
    return collaborator;
};
export const collectDiagnosis = async ({ scope, mode, operationHandle, operationDiagnostics, getBridgeStatus, requestExtensionDiagnosticSnapshot, clientName, storageLayout = {}, probes = [], now = Date.now, collectInstallation, collectHookPermissions, collectMcpAuth, probeExtensionInstall, readExtensionLog, probeStorage, } = {}) => {
    const observedAt = new Date(now()).toISOString();
    let checks = [];
    let operation;
    if (scope === 'installation')
        checks = [...(await wired(collectInstallation, 'collectInstallation')({ observedAt })).checks];
    else if (scope === 'runtime') {
        try {
            checks = Object.values(getBridgeStatus?.()?.diagnostics ?? {});
        }
        catch {
            checks = [
                diagnosticCheck({
                    check: 'runtime_snapshot',
                    state: 'failed',
                    observedAt,
                    source: 'local_bridge_status',
                    executionPlane: 'device',
                    cause: 'unknown',
                }),
            ];
        }
    }
    else if (scope === 'last_operation') {
        operation = operationDiagnostics?.read(operationHandle) ?? undefined;
        checks = [
            diagnosticCheck({
                check: 'operation_receipt',
                state: operation ? 'passed' : 'unknown',
                observedAt,
                source: 'process_memory',
                executionPlane: 'device',
            }),
        ];
    }
    if (mode === 'safe_probes') {
        if (scope === 'installation' && probes.includes('storage_write'))
            for (const [name, target] of Object.entries(storageLayout))
                checks.push(await wired(probeStorage, 'probeStorage')(name, target, { observedAt }));
        // Not a probe this host offers: the answer is the closed unsupported check, never another host's configuration.
        const codexOnly = (check, collect) => isCodexClientName(clientName)
            ? wired(collect, 'collect')({ now })
            : diagnosticCheck({
                check,
                state: 'unsupported',
                observedAt,
                source: 'device_process',
                executionPlane: 'device',
                cause: 'unsupported',
            });
        if (scope === 'installation' && probes.includes('hook_permissions'))
            checks.push(await codexOnly('hook_permissions', collectHookPermissions));
        if (scope === 'installation' && probes.includes('codex_mcp_auth'))
            checks.push(await codexOnly('codex_mcp_auth', collectMcpAuth));
        if (scope === 'installation' && probes.includes('extension_install'))
            checks.push(await wired(probeExtensionInstall, 'probeExtensionInstall')({ now }));
        if (scope === 'runtime' && probes.includes('extension_snapshot')) {
            checks.push(await collectExtensionSnapshotCheck({ requestExtensionDiagnosticSnapshot, observedAt }));
        }
        // The offline counterpart of the snapshot: what the browser told the extension, read from the profile on disk.
        // A fresh read replaces the one the last failing tool call left in status, there too, so the cause in `code` is
        // judged again from it; a reader that throws is unreadable.
        if (scope === 'runtime' && probes.includes('extension_log')) {
            const logCheck = await wired(readExtensionLog, 'readExtensionLog')({ now, observedAt });
            checks = [...checks.filter(({ check }) => check !== 'extension_log'), logCheck];
        }
    }
    if (scope === 'runtime')
        checks.push(diagnosticCheck({
            check: 'host_hook_context',
            state: 'not_checked',
            observedAt,
            source: 'device_process',
            executionPlane: 'device',
            cause: 'unavailable',
        }));
    return { schemaVersion: 1, scope, mode, checks, ...(operation ? { operation } : {}) };
};
