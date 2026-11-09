import { randomUUID } from 'node:crypto';
import { probeBrowserExtensionInstall } from '../bridge/profile/extension-install.mjs';
import { collectExtensionLog as collectExtensionLogFromDisk, readExtensionLogRows as readExtensionLogRowsFromDisk, } from '../bridge/profile/extension-log.mjs';
import { collectFeedbackDeviceEvidence } from './device-evidence.composition.mjs';
import { feedbackFlows } from './feedback.composition.mjs';
import { collectDoctorReport } from '../doctor.mjs';
import { isOneOf, isRecord } from '../shared/values.mjs';
import { resolveStorageLayout } from '../storage/files/layout.mjs';
import { createDiagnoseTool } from '../support/diagnostics/in/mcp/diagnose.tool.mjs';
import { createStatusTool } from '../support/diagnostics/in/mcp/status.tool.mjs';
import { createExtensionLogReader } from '../support/diagnostics/out/bridge/facts.mjs';
import { collectCodexHookPermissions } from '../support/diagnostics/out/codex/hook-permissions.mjs';
import { collectCodexMcpAuth } from '../support/diagnostics/out/codex/mcp-auth.mjs';
import { createStorageProbe } from '../support/diagnostics/out/fs-probe/storage.mjs';
import { submitOutcome } from '../support/feedback/application/submit.mjs';
import { createPrepareTool } from '../support/feedback/in/mcp/prepare.tool.mjs';
import { prepareThroughRoute, submitThroughRoute } from '../support/feedback/in/mcp/routes.mjs';
import { createSubmitTool } from '../support/feedback/in/mcp/submit.tool.mjs';
import { DIAGNOSTIC_STATES } from '../transport/diagnostics/vocabulary.mjs';
// A check this process built with diagnosticCheck, coming back through a seam that does not type it.
const isDiagnosticCheck = (value) => isRecord(value) &&
    typeof value.check === 'string' &&
    isOneOf(DIAGNOSTIC_STATES, value.state) &&
    (value.observedAt === undefined || typeof value.observedAt === 'string') &&
    typeof value.source === 'string' &&
    typeof value.executionPlane === 'string' &&
    (value.facts === undefined || (typeof value.facts === 'object' && value.facts !== null)) &&
    (value.cause === undefined || typeof value.cause === 'string') &&
    (value.nextCheck === undefined || typeof value.nextCheck === 'string') &&
    (value.evidenceRefs === undefined || (Array.isArray(value.evidenceRefs) && value.evidenceRefs.every((ref) => typeof ref === 'string')));
/**
 * The support tools' handlers the MCP root registers: `registry` is the dispatcher's (answer with its receipt, the
 * current status, the session's client, the receipts), `options` the root's collaborators. Every probe is injectable,
 * so tests never read this machine's packages, profiles or Codex configuration; `prepareFeedback` and `submitFeedback`
 * replace a whole use case in tests.
 */
export const supportTools = (registry, { requestExtensionDiagnosticSnapshot = undefined, 
// Refreshes policy and, when selected, returns that pass's profile probe for the same diagnosis.
refreshBridgeFacts = async (_options) => undefined, now = Date.now, randomUUID: createUuid = randomUUID, storageLayout = resolveStorageLayout(), 
// The plugin release the root read from the manifest: the bug report carries it.
version, collectInstallation = undefined, probeExtensionInstall = undefined, collectHookPermissions = undefined, collectExtensionLog = undefined, readExtensionLogRows = undefined, extensionLogTarget = () => ({}), 
// A runtime diagnosis's fresh read of the extension's log, which status then judges instead of the one it kept.
replaceExtensionLog = (_evidence) => undefined, prepareFeedback = undefined, submitFeedback = undefined, flows = feedbackFlows({ env: process.env }), }) => {
    // The extension's own log is found through the same profile probe, so an injected probe keeps it off this machine. It
    // is the log of the browser the runtime names: the connected extension's own, else the chooser's pick under the policies.
    const logReaderOptions = () => ({ now, ...(probeExtensionInstall ? { probeExtensionInstall } : {}), ...extensionLogTarget() });
    const collectLog = collectExtensionLog ?? (() => collectExtensionLogFromDisk(logReaderOptions()));
    const readLogRows = readExtensionLogRows ?? (() => readExtensionLogRowsFromDisk(logReaderOptions()));
    // Feedback preparation carries the passive status plus bounded read-only evidence.
    const collectDeviceEvidence = () => collectFeedbackDeviceEvidence({
        getBridgeStatus: registry.bridgeStatus,
        requestExtensionDiagnosticSnapshot,
        now,
        collectExtensionLog: collectLog,
        ...(collectInstallation ? { collectInstallation } : {}),
        ...(probeExtensionInstall ? { probeExtensionInstall } : {}),
        ...(collectHookPermissions ? { collectHookPermissions } : {}),
    });
    const prepare = prepareFeedback
        ? async (args, context) => ({ kind: 'prepared', prepared: await prepareFeedback(args, context) })
        : (args, context) => prepareThroughRoute(flows, args, context);
    const submit = submitFeedback
        ? async (args) => submitOutcome(await submitFeedback(args))
        : (args) => submitThroughRoute(flows, args, {});
    return [
        ['local_bridge_status', createStatusTool({ answer: registry.answer('local_bridge_status'), bridgeStatus: registry.bridgeStatus })],
        [
            'e_comet_diagnose',
            createDiagnoseTool({
                answer: registry.answer('e_comet_diagnose'),
                refreshBridgeFacts,
                diagnosis: (extensionInstall) => ({
                    operationDiagnostics: registry.operationDiagnostics,
                    getBridgeStatus: registry.bridgeStatus,
                    ...(requestExtensionDiagnosticSnapshot ? { requestExtensionDiagnosticSnapshot } : {}),
                    storageLayout,
                    now,
                    clientName: registry.clientName(),
                    collectInstallation: collectInstallation ?? collectDoctorReport,
                    collectHookPermissions: collectHookPermissions ?? collectCodexHookPermissions,
                    collectMcpAuth: collectCodexMcpAuth,
                    // The refreshed profile probe is a check the bridge built.
                    probeExtensionInstall: isDiagnosticCheck(extensionInstall)
                        ? async () => extensionInstall
                        : (probeExtensionInstall ?? probeBrowserExtensionInstall),
                    readExtensionLog: createExtensionLogReader(collectLog, replaceExtensionLog),
                    probeStorage: createStorageProbe({ randomUUID: createUuid }),
                }),
            }),
        ],
        [
            'prepare_e_comet_feedback',
            createPrepareTool({
                answer: registry.answer('prepare_e_comet_feedback'),
                prepare: (args) => prepare(args, {
                    getBridgeStatus: collectDeviceEvidence,
                    readExtensionLogRows: readLogRows,
                    clientName: registry.clientName(),
                    version,
                }),
            }),
        ],
        ['submit_e_comet_feedback', createSubmitTool({ answer: registry.answer('submit_e_comet_feedback'), submit })],
    ];
};
