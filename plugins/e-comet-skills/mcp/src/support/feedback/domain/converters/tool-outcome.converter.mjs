import { isCanonicalTimestamp, isRecord as isObject } from '../../../../shared/values.mjs';
import { closedOutcomeFields, int32, OUTCOME_GRAMMARS } from '../../../../transport/mcp/results.mjs';
// One linear pass over an untrusted transcript name: `_` belongs to the class, so `__`-joined host
// prefixes still match without an alternation whose overlapping paths backtrack exponentially. Real
// names are short identifiers — the longest observed are Cowork's URL-slug MCP names such as
// `mcp__https_mcp_e-comet_io_mcp__report_issue` (43) — so this cap keeps threefold headroom while
// stopping one absurd transcript value from spending the report's share of the archive budget.
const TOOL_NAME_MAX_LENGTH = 256;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const OUTCOME_KEYS = new Set(['ok', 'isError', 'marketplaceErrorCode', ...Object.keys(OUTCOME_GRAMMARS)]);
export const isFeedbackToolName = (value) => typeof value === 'string' && value.length <= TOOL_NAME_MAX_LENGTH && TOOL_NAME.test(value);
export const isFeedbackCallTimestamp = (value) => isCanonicalTimestamp(value);
/** The exact closed outcome shape the extractor produces; the renderer re-checks it at its boundary. */
// Parse boundary: an outcome from the transcript or the report input, checked here.
export const isFeedbackToolOutcome = (value) => {
    if (!isObject(value))
        return false;
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.some((key) => !OUTCOME_KEYS.has(key)))
        return false;
    return ((value.ok === undefined || typeof value.ok === 'boolean') &&
        Object.entries(OUTCOME_GRAMMARS).every(([key, grammar]) => value[key] === undefined || (typeof value[key] === 'string' && grammar.test(value[key]))) &&
        (value.marketplaceErrorCode === undefined || int32(value.marketplaceErrorCode) !== undefined) &&
        (value.isError === undefined || value.isError === true));
};
const FEEDBACK_TOOL_SUFFIXES = new Set(['prepare_e_comet_feedback', 'report_issue', 'submit_e_comet_feedback']);
// Bounded parse of one result text: a marketplace result can be large, and one absurd tool output must
// not stall the single-threaded server while it looks for five small fields. Beyond this, only the
// host's own error flag is kept.
export const OUTCOME_TEXT_MAX_LENGTH = 1_048_576;
// functions.exec wraps the tool's own output behind a timing header; the tool output follows this marker.
const EXEC_OUTPUT_MARKER = /\r?\nOutput:\r?\n/;
const toolSuffix = (name) => name.split('__').at(-1) ?? '';
const isFeedbackTool = (name) => FEEDBACK_TOOL_SUFFIXES.has(toolSuffix(name));
export const acceptedToolName = (value) => isFeedbackToolName(value) && !isFeedbackTool(value);
export const callRecord = (name, timestamp) => ({
    name,
    ...(isFeedbackCallTimestamp(timestamp) ? { at: timestamp } : {}),
});
// Every text a result carries, in order: a plain string, or the text blocks of a content array.
const resultTexts = (content) => {
    if (typeof content === 'string')
        return [content];
    if (!Array.isArray(content))
        return [];
    return content.flatMap((item) => (isObject(item) && typeof item.text === 'string' ? [item.text] : []));
};
// Parse boundary: one result text, whose object the projection reads field by field.
const parseObject = (text) => {
    if (typeof text !== 'string' || text.length > OUTCOME_TEXT_MAX_LENGTH)
        return undefined;
    const trimmed = text.trimStart();
    const marker = trimmed.startsWith('{') ? undefined : EXEC_OUTPUT_MARKER.exec(trimmed);
    const body = marker ? trimmed.slice(marker.index + marker[0].length).trimStart() : trimmed;
    if (!body.startsWith('{'))
        return undefined;
    try {
        const value = JSON.parse(body);
        return isObject(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
};
// A host may record the whole CallToolResult envelope as the result; its own text blocks carry the tool's
// JSON, and its isError flag is the host's, not the tool's.
const unwrapEnvelope = (value) => {
    if (!Array.isArray(value.content))
        return { value, isError: false };
    for (const text of resultTexts(value.content)) {
        const inner = parseObject(text);
        if (inner)
            return { value: inner, isError: value.isError === true };
    }
    return { value, isError: value.isError === true };
};
/**
 * Projects one tool result onto its closed outcome fields, for the local and remote e-Comet tool names given. The first text that parses as a JSON
 * object supplies them; free text, foreign shapes and out-of-grammar values contribute nothing.
 * The fields other than `ok` are read only when the call names an e-Comet tool, local or remote; any
 * other tool contributes `ok` and the host's error flag, which cannot carry a value we did not define.
 */
export const toolOutcomeProjector = ({ local, remote }) => {
    const REMOTE_TOOL_NAME = new RegExp(`^mcp__(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|e-comet|plugin_e-comet-skills_e-comet|(?:claude_ai_)?https_mcp_e-comet_io_mcp)__(?:${remote.join('|')})$`);
    const isECometTool = (name) => typeof name === 'string' &&
        (local.has(toolSuffix(name)) ||
            REMOTE_TOOL_NAME.test(name) ||
            // The extractor still excludes feedback calls. The native bridge also uses
            // this closed projection to keep a failed authorization's transport private.
            name === 'mcp__e-comet__report_issue');
    return (content, isError = false, toolName = undefined) => {
        const ours = isECometTool(toolName);
        const outcome = {};
        for (const text of resultTexts(content)) {
            const parsed = parseObject(text);
            if (!parsed)
                continue;
            const { value, isError: envelopeError } = unwrapEnvelope(parsed);
            if (typeof value.ok === 'boolean')
                outcome.ok = value.ok;
            if (ours)
                Object.assign(outcome, closedOutcomeFields(value));
            if (envelopeError)
                outcome.isError = true;
            break;
        }
        if (isError === true)
            outcome.isError = true;
        return Object.keys(outcome).length ? outcome : undefined;
    };
};
