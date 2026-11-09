// Наблюдаемое состояние маршрута, а не догадка о сборке: «расширение не подключено» (спрашивать
// некого), «возможность не объявлена» (подключённая сборка её не несёт) и
// «ответ не той формы» — разные наблюдения. Всё, что осталось неопознанным, остаётся unknown.
const EXTENSION_SNAPSHOT_FAILURES = {
    EXTENSION_DISCONNECTED: { state: 'not_checked', source: 'device_process', cause: 'unavailable' },
    UNSUPPORTED_CAPABILITY: { state: 'unsupported', source: 'extension', cause: 'unsupported' },
    EXTENSION_DIAGNOSTIC_INVALID: { state: 'failed', source: 'extension', cause: 'corrupt' },
    // The device stopped waiting. Whether the extension would have answered is unknown, so this is an
    // observation about our deadline, never a fault attributed to the extension.
    EXTENSION_DIAGNOSTIC_TIMEOUT: { state: 'unknown', source: 'device_process', cause: 'unavailable' },
};
// A typed refusal the table does not name is still the extension's answer; a rejection without a code,
// such as a bridge shutdown while the request was pending, is not extension evidence at all.
export const extensionSnapshotFailure = (code) => EXTENSION_SNAPSHOT_FAILURES[String(code)] ??
    (typeof code === 'string'
        ? { state: 'failed', source: 'extension', cause: 'unknown' }
        : { state: 'unknown', source: 'device_process', cause: 'unknown' });
// The Codex configuration inspectors describe Codex hook trust and sign-in state; under any other client
// they would report a foreign host's state as this session's. The client name from MCP initialize is
// the only host signal the device holds: only the identity Codex sends (openai/codex,
// codex-rs/codex-mcp/src/rmcp_client.rs) is Codex, never an absent name or one that merely contains the word.
const CODEX_CLIENT_NAMES = new Set(['codex-mcp-client']);
export const isCodexClientName = (name) => CODEX_CLIENT_NAMES.has(name);
