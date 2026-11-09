import { randomUUID } from 'node:crypto';
import { mcpError, mcpResult } from '../framing.mjs';
import { describeToolContract } from '../generic-tools.mjs';
import { createRouter } from './router.mjs';
import { answerRunResult, callWithHandoff, createRunRegistry, RUN_RESULT_RETENTION_MS, RUN_WAIT_MS, } from './runs.mjs';
import { invalidArgumentsMessage, validateArguments } from './validate.mjs';
import { createOperationDiagnostics, withReceipt } from '../results/receipts.mjs';
import { textResult, toolFailure } from '../results/serialize.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { isRecord } from '../../shared/values.mjs';
import { PENDING_UPDATE_VERSION_PATTERN } from '../../transport/extension/wire.mjs';
import { OZON_EXTENSION_OUTDATED_REASON } from '../../transport/failures/vocabulary.mjs';
// A capability the connected extension lacks while a downloaded update waits: the store cannot help, a restart can.
// Accepted residual "The downloaded-update step does not compare versions": docs/architecture/residuals/signed-flow.md.
const withPendingUpdate = (error, pendingUpdateVersion) => {
    const end = error.message.indexOf('. ');
    error.message =
        `${end < 0 ? error.message : error.message.slice(0, end + 1)} The extension update ${pendingUpdateVersion} is already ` +
            'downloaded: ask the user to restart the browser, or apply the update on app.e-comet.io, then request a new browser job and retry.';
    return error;
};
// A failing call waits at most this long for the snapshot that may name a downloaded update.
const PENDING_UPDATE_SNAPSHOT_TIMEOUT_MS = 3000;
export const createMcpMessageHandler = ({ 
// The catalog the root publishes: every tool's contract, in tools/list order, and the server instructions.
contracts, instructions, getBridgeStatus, 
// Called once the initialize result is sent: the bridge starts looking for a broker only after the handshake.
onInitialized = () => undefined, 
// Non-blocking: starts a broker connect attempt unless one is in flight. Applied once at the tools/call dispatch
// point to every tool declaring `needsBridge`, so a call that returns early still starts it.
kick = () => undefined, requestExtensionDiagnosticSnapshot = undefined, 
// Whether the connected extension announced diagnostic_snapshot_v2.
diagnosticSnapshotV2Ready = () => false, sendError = mcpError, sendResult: sendMcpResult = mcpResult, runWaitMs = RUN_WAIT_MS, runRetentionMs = RUN_RESULT_RETENTION_MS, now = Date.now, randomUUID: createUuid = randomUUID, 
// The plugin release the root read from the manifest: serverInfo carries it.
version = undefined, 
// The handlers the root registers besides the generic tools: `registerTools(registry)` answers
// [name, handler] pairs, with `registry` the dispatcher's answer (with its receipt), status, client, receipts and the
// downloaded-update reading of a failure.
registerTools = (_registry) => [], }) => {
    const validateToolArguments = (name, args) => validateArguments(contracts.find((contract) => contract.name === name)?.inputSchema, args);
    const currentBridgeStatus = () => getBridgeStatus({
        clientInfo: router.session.clientInfo,
        protocolVersion: router.session.protocolVersion,
        clientObservedAt: router.session.observedAt,
    });
    const operationDiagnostics = createOperationDiagnostics({ now, randomUUID: createUuid });
    // A capability the extension lacks while its update is downloaded: the version 2 snapshot names that update. A caller
    // that attests a missing capability itself (an Ozon package tool) says so in `attested`.
    const withDownloadedUpdate = async (error, attested = false) => {
        const missingCapability = error instanceof ToolExecutionError &&
            (error.code === 'EXTENSION_UPDATE_REQUIRED' || attested || error.details?.reason === OZON_EXTENSION_OUTDATED_REASON);
        // Only a version 2 snapshot can name the update; an older extension is not asked.
        if (!missingCapability || !diagnosticSnapshotV2Ready() || requestExtensionDiagnosticSnapshot === undefined)
            return error;
        try {
            const snapshot = await requestExtensionDiagnosticSnapshot(PENDING_UPDATE_SNAPSHOT_TIMEOUT_MS);
            const version = isRecord(snapshot) ? snapshot.pendingUpdateVersion : undefined;
            return typeof version === 'string' && PENDING_UPDATE_VERSION_PATTERN.test(version) ? withPendingUpdate(error, version) : error;
        }
        catch {
            return error;
        }
    };
    const runs = createRunRegistry({ now, randomUUID: createUuid, waitMs: runWaitMs, retentionMs: runRetentionMs });
    // A bridge tool's handler answers to its run key; every other answer goes out as before.
    const sendResult = (id, result) => runs.settle(id, result) || sendMcpResult(id, result);
    const sendOperationResult = async (id, toolName, result) => sendResult(id, withReceipt(operationDiagnostics, toolName, result));
    // `needsBridge` declares which operational tools depend on the bridge, so the wake-up is applied once at
    // the dispatch point below instead of being remembered inside each handler. A tool added without the flag
    // never nudges; a tool added with it cannot forget to. `local_bridge_status` is deliberately false because
    // its read-only contract forbids a diagnostic call from starting a connect attempt.
    const registry = {
        answer: (toolName) => (id, result) => sendOperationResult(id, toolName, result),
        bridgeStatus: currentBridgeStatus,
        clientName: () => router.session.clientInfo?.name,
        operationDiagnostics,
        withDownloadedUpdate,
    };
    const toolHandlers = new Map([
        ...registerTools(registry),
        [
            'describe_e_comet_tool',
            // Parse boundary: the arguments, checked against the contract first.
            {
                needsBridge: false,
                run: async (id, args) => {
                    const validation = validateToolArguments('describe_e_comet_tool', args);
                    if (!validation.ok) {
                        sendOperationResult(id, 'describe_e_comet_tool', textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage('describe_e_comet_tool', validation), 'arguments', false)), true));
                        return;
                    }
                    sendOperationResult(id, 'describe_e_comet_tool', textResult(describeToolContract(contracts, isRecord(args) ? args.name : undefined)));
                },
            },
        ],
        [
            'e_comet_run_result',
            // Not a bridge tool, so it answers to the request id.
            { needsBridge: false, run: (id, args) => answerRunResult(runs, sendMcpResult, id, args) },
        ],
    ]);
    const router = createRouter({
        contracts,
        instructions,
        serverInfo: { name: 'e-comet-local-bridge', version },
        now,
        send: sendResult,
        sendError,
        onInitialized,
        call: async (name, args, { id }) => {
            // The router calls only a listed tool, and every listed tool has its handler.
            const tool = toolHandlers.get(name);
            if (!tool)
                throw new TypeError(`No handler for the listed tool ${name}.`);
            if (!tool.needsBridge) {
                await tool.run(id, args);
                return;
            }
            // Before the handler runs, so the first call starts a connect attempt rather than waiting for the next
            // re-list — including the signed-call forms that return early, before they ever reach ensureBroker.
            kick();
            await callWithHandoff(runs, sendMcpResult, id, name, (key) => tool.run(key, args));
        },
    });
    return router.route;
};
