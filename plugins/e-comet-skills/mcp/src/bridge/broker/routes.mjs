// The session route of the diagnostic snapshot (refactor spec §6.3): asked of the connected extension only when it
// announced the capability, in the newest version it announced.
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { localMessage, MESSAGE_TYPES } from '../../transport/extension/wire.mjs';
// `sendExtension(message)` sends to the current session and throws a typed failure when there is none.
export const createDiagnosticSnapshotRoute = ({ connections, sendExtension, }) => ({ requestId }) => {
    // «Спросить некого» и «спрашивать нечем» — разные наблюдения. Без подключённого расширения отказ по
    // возможности приписал бы пользователю устаревшую сборку, хотя наблюдается только отсутствие подключения.
    if (!connections.extensionReady) {
        throw new ToolExecutionError('EXTENSION_DISCONNECTED', 'No connected e-Comet extension is reachable for a diagnostic snapshot.', 'extension', false);
    }
    if (!connections.extensionDiagnosticSnapshotReady)
        throw new ToolExecutionError('UNSUPPORTED_CAPABILITY', 'The connected extension does not support diagnostic snapshots.', 'extension', false);
    // An extension without diagnostic_snapshot_v2 refuses version 2, so it is asked for version 1 as before.
    sendExtension(localMessage(requestId, MESSAGE_TYPES.diagnosticSnapshot, {
        protocolVersion: connections.extensionDiagnosticSnapshotV2Ready ? 2 : 1,
    }));
};
