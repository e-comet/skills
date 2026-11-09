import { isCredentialName, redactFeedbackText } from '../converters/report.converter.mjs';
// Installation checks worth carrying in a report, keyed by the doctor's check name. The doctor's own
// runtime and storage checks duplicate what the status already holds and are left out.
export const INSTALLATION_SLOTS = {
    package_layout: 'packageLayout',
    package_metadata: 'packageMetadata',
    codex_manifest: 'codexManifest',
    mcp_configuration: 'mcpConfiguration',
    entrypoint: 'entrypoint',
};
const CONNECTION_ROWS = 'native-connection';
// One row as the archive stores it: every string passes the report redaction on its own, and a value of any type under
// a credential name (an array of cookies, an object) is replaced whole. Per leaf, because the authorization and cookie
// rules run to the end of a line and would cut every following field of a one-line JSON row.
const redactLeaves = (value, key = '') => {
    if (isCredentialName(key) && value !== null && value !== undefined)
        return '[REDACTED]';
    if (typeof value === 'string')
        return redactFeedbackText(value);
    // Items of an array keep the name they sit under.
    if (Array.isArray(value))
        return value.map((item) => redactLeaves(item, key));
    if (value !== null && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactLeaves(item, name)]));
    return value;
};
const archivedRow = (row) => JSON.stringify(redactLeaves(row));
/**
 * The archive's extension-log.json: the whole log when the history is included, only the connection rows when it is
 * not, cut to `maxBytes`. It keeps the newest rows in the order the extension stored them. Undefined when no row is left.
 */
export const feedbackExtensionLog = (rows, { includeTranscript, maxBytes }) => {
    const candidates = (Array.isArray(rows) ? rows : [])
        .filter((row) => includeTranscript || row?.requestId === CONNECTION_ROWS)
        .map((row, index) => ({ index, text: archivedRow(row) }));
    const kept = [];
    let size = 2;
    for (const item of [...candidates].reverse()) {
        size += Buffer.byteLength(item.text, 'utf8') + (kept.length ? 1 : 0);
        if (size > maxBytes)
            break;
        kept.push(item);
    }
    if (kept.length === 0)
        return undefined;
    kept.reverse();
    return { text: `[${kept.map(({ text }) => text).join(',')}]`, rows: kept.length, trimmed: kept.length < candidates.length };
};
