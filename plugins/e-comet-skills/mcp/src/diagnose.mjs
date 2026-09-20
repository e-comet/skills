import fs from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticCheck, isCanonicalTimestamp } from './diagnostic-facts.mjs';
import { collectDoctorReport } from './doctor.mjs';
import { collectCodexHookPermissions } from './codex-hook-permissions.mjs';
import { collectCodexMcpAuth } from './codex-mcp-auth.mjs';
import { probeBrowserExtensionInstall } from './browser-extension-install.mjs';

const systemCause = (error) => ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? 'permission_denied' : 'io_error';

// Наблюдаемое состояние маршрута, а не догадка о сборке: «расширение не подключено» (спрашивать
// некого), «возможность не объявлена» (подключённая сборка или первичный процесс её не несут) и
// «ответ не той формы» — разные наблюдения. Всё, что осталось неопознанным, остаётся unknown.
const EXTENSION_SNAPSHOT_FAILURES = Object.freeze({
    EXTENSION_DISCONNECTED: { state: 'not_checked', source: 'device_process', cause: 'unavailable' },
    UNSUPPORTED_CAPABILITY: { state: 'unsupported', source: 'extension', cause: 'unsupported' },
    EXTENSION_DIAGNOSTIC_INVALID: { state: 'failed', source: 'extension', cause: 'corrupt' },
    // The device stopped waiting. Whether the extension would have answered is unknown, so this is an
    // observation about our deadline, never a fault attributed to the extension.
    EXTENSION_DIAGNOSTIC_TIMEOUT: { state: 'unknown', source: 'device_process', cause: 'unavailable' },
});
// A typed refusal the table does not name is still the extension's answer; a rejection without a code,
// such as a bridge shutdown while the request was pending, is not extension evidence at all.
export const extensionSnapshotFailure = (code) => EXTENSION_SNAPSHOT_FAILURES[code]
    ?? (typeof code === 'string' ? { state: 'failed', source: 'extension', cause: 'unknown' } : { state: 'unknown', source: 'device_process', cause: 'unknown' });
const step = (operation, state, systemCode, reason) => ({ operation, state, ...(systemCode ? { systemCode } : {}), ...(reason ? { reason } : {}) });

/**
 * One capability-negotiated, read-only extension snapshot as a closed check. Shared by the runtime
 * diagnosis probe and by feedback preparation, which passes its own shorter deadline.
 * @param {{ requestExtensionDiagnosticSnapshot?: (timeoutMs?: number) => Promise<unknown>, observedAt: string, timeoutMs?: number }} input
 */
export const collectExtensionSnapshotCheck = async ({ requestExtensionDiagnosticSnapshot, observedAt, timeoutMs = undefined }) => {
    try {
        const facts = /** @type {any} */ (await requestExtensionDiagnosticSnapshot?.(timeoutMs));
        // The check is dated by the extension's own observation time when it is canonical; the wire
        // admits any short string there, and a non-canonical one must not undate the whole check.
        return facts
            ? diagnosticCheck({ check: 'extension_snapshot', state: 'passed', observedAt: isCanonicalTimestamp(facts.observedAt) ? facts.observedAt : observedAt,
                source: 'extension', executionPlane: 'device', facts })
            : diagnosticCheck({ check: 'extension_snapshot', state: 'unsupported', observedAt, source: 'capability_negotiation', executionPlane: 'device', cause: 'unsupported' });
    } catch (error) {
        return diagnosticCheck({ check: 'extension_snapshot', ...extensionSnapshotFailure(error?.code), observedAt, executionPlane: 'device' });
    }
};

const probeStorageTarget = async (name, target, { observedAt, randomUUID, fileSystem }) => {
    const base = { check: 'storage_write', observedAt, source: 'safe_probe', executionPlane: 'device' };
    if (target?.state !== 'ready') return diagnosticCheck({ ...base, state: 'not_checked', cause: 'unknown', facts: { target: name, steps: [] } });
    try {
        if (!(await fileSystem.stat(target.path)).isDirectory()) return diagnosticCheck({ ...base, state: 'not_checked', cause: 'directory_absent', facts: { target: name, steps: [] } });
    } catch (error) {
        if (error?.code === 'ENOENT') return diagnosticCheck({ ...base, state: 'not_checked', cause: 'directory_absent', facts: { target: name, steps: [] } });
        return diagnosticCheck({ ...base, state: 'failed', cause: systemCause(error), facts: { target: name, steps: [] } });
    }
    const path = join(target.path, `.e-comet-diagnostic-${randomUUID()}.tmp`);
    const payload = Buffer.from('e-comet-safe-probe\n');
    const steps = [];
    let handle;
    let failure;
    let acquired = false;
    let identity;
    try {
        try {
            handle = await fileSystem.open(path, 'wx');
            acquired = true;
            steps.push(step('create', 'passed'));
            try { identity = await handle.stat(); }
            catch (error) { steps.push(step('identify', 'failed', error?.code)); failure = error; }
        }
        catch (error) { steps.push(step('create', 'failed', error?.code)); failure = error; }
        if (identity) {
            try { await handle.writeFile(payload); steps.push(step('write', 'passed')); }
            catch (error) { steps.push(step('write', 'failed', error?.code)); failure = error; }
        }
        if (identity && !failure) {
            try { const read = await fileSystem.readFile(path); if (!read.equals(payload)) throw Object.assign(new Error('mismatch'), { code: 'EIO' }); steps.push(step('read', 'passed')); }
            catch (error) { steps.push(step('read', 'failed', error?.code)); failure = error; }
        }
    } finally {
        if (acquired) {
            let sameFile = false;
            if (identity) {
                try { const current = await fileSystem.stat(path); sameFile = current.dev === identity.dev && current.ino === identity.ino; }
                catch (error) { steps.push(step('remove', 'failed', error?.code)); failure ??= error; }
            }
            try { await handle.close(); }
            catch (error) { steps.push(step('close', 'failed', error?.code)); failure ??= error; }
            if (!identity) {
                // Accepted residual: the tiny probe file may remain because no existing store sweep owns its grammar.
                // See docs/local-agent-architecture.md#accepted-residuals.
                steps.push(step('remove', 'not_checked', undefined, 'identity_unavailable'));
            } else if (!sameFile && !steps.some(({ operation }) => operation === 'remove')) {
                const error = Object.assign(new Error('probe file identity changed'), { code: 'IDENTITY_CHANGED' });
                steps.push(step('remove', 'failed', error.code)); failure ??= error;
            } else if (sameFile) {
                try { await fileSystem.unlink(path); steps.push(step('remove', 'passed')); }
                catch (error) { steps.push(step('remove', 'failed', error?.code)); failure ??= error; }
            }
        }
    }
    return diagnosticCheck({ ...base, state: failure ? 'failed' : 'passed', ...(failure ? { cause: systemCause(failure) } : {}), facts: { target: name, steps } });
};

export const collectDiagnosis = async (/** @type {any} */ { scope, mode, operationHandle, operationDiagnostics, getBridgeStatus,
    requestExtensionDiagnosticSnapshot,
    storageLayout = {}, probes = [], now = Date.now, randomUUID = () => globalThis.crypto.randomUUID(), collectInstallation = collectDoctorReport,
    collectHookPermissions = collectCodexHookPermissions,
    collectMcpAuth = collectCodexMcpAuth,
    probeExtensionInstall = probeBrowserExtensionInstall,
    fileSystem = fs } = {}) => {
    const observedAt = new Date(now()).toISOString();
    let checks = [];
    let operation;
    if (scope === 'installation') checks = [...(await collectInstallation({ observedAt })).checks];
    else if (scope === 'runtime') {
        try { checks = Object.values(getBridgeStatus?.()?.diagnostics ?? {}); }
        catch { checks = [diagnosticCheck({ check: 'runtime_snapshot', state: 'failed', observedAt, source: 'local_bridge_status', executionPlane: 'device', cause: 'unknown' })]; }
    } else if (scope === 'last_operation') {
        operation = operationDiagnostics?.read(operationHandle) ?? undefined;
        checks = [diagnosticCheck({ check: 'operation_receipt', state: operation ? 'passed' : 'unknown', observedAt, source: 'process_memory', executionPlane: 'device' })];
    }
    if (mode === 'safe_probes') {
        if (scope === 'installation' && probes.includes('storage_write')) for (const [name, target] of Object.entries(storageLayout)) checks.push(await probeStorageTarget(name, target, { observedAt, randomUUID, fileSystem }));
        if (scope === 'installation' && probes.includes('hook_permissions')) checks.push(await collectHookPermissions({ now }));
        if (scope === 'installation' && probes.includes('codex_mcp_auth')) checks.push(await collectMcpAuth({ now }));
        if (scope === 'installation' && probes.includes('extension_install')) checks.push(await probeExtensionInstall({ now }));
        if (scope === 'runtime' && probes.includes('extension_snapshot')) {
            checks.push(await collectExtensionSnapshotCheck({ requestExtensionDiagnosticSnapshot, observedAt }));
        }
    }
    if (scope === 'runtime') checks.push(diagnosticCheck({ check: 'host_hook_context', state: 'not_checked', observedAt,
        source: 'device_process', executionPlane: 'device', cause: 'unavailable' }));
    return { schemaVersion: 1, scope, mode, checks, ...(operation ? { operation } : {}) };
};
