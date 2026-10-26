import { isCanonicalTimestamp } from './diagnostic-facts.mjs';
import { tools } from './tool-catalog.mjs';

// One linear pass over an untrusted transcript name: `_` belongs to the class, so `__`-joined host
// prefixes still match without an alternation whose overlapping paths backtrack exponentially. Real
// names are short identifiers — the longest observed are Cowork's URL-slug MCP names such as
// `mcp__https_mcp_e-comet_io_mcp__report_issue` (43) — so this cap keeps threefold headroom while
// stopping one absurd transcript value from spending the report's share of the archive budget.
const TOOL_NAME_MAX_LENGTH = 256;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const FEEDBACK_TOOL_SUFFIXES = new Set([
    'prepare_e_comet_feedback',
    'report_issue',
    'submit_e_comet_feedback',
]);
// A result is read only for its closed outcome fields, never copied: `ok`, `status`, and a `code`,
// `stage` and `cause` either at the top level of a failure envelope or nested under `error`, all in these
// identifier grammars; any other value stays out, and prose is never parsed. The grammars describe our own
// envelopes, so only our own tools are read for them. Another server's result can still say the call
// failed through `ok` and the host's own flag, but a value this server never defined is not ours to put
// in a support archive.
const OUTCOME_LOWER = /^[a-z][a-z_]{1,31}$/;
// The native cause classes include `http_4xx` and `http_5xx`, so the cause grammar admits digits.
const OUTCOME_CAUSE = /^[a-z][a-z0-9_]{1,31}$/;
const OUTCOME_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const OUTCOME_KEYS = new Set(['ok', 'status', 'code', 'stage', 'cause', 'isError']);
// Bounded parse of one result text: a marketplace result can be large, and one absurd tool output must
// not stall the single-threaded server while it looks for five small fields. Beyond this, only the
// host's own error flag is kept.
const OUTCOME_TEXT_MAX_LENGTH = 1_048_576;
// Shared with the DeepSeek renderer: compact JSON follows this exact trailing delimiter.
export const STRUCTURED_MCP_EVIDENCE_MARKER = '\nStructured MCP evidence: ';
// functions.exec wraps the tool's own output behind a timing header; the tool output follows this marker.
const EXEC_OUTPUT_MARKER = /\r?\nOutput:\r?\n/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Hosts prefix an MCP tool with a server name the device does not choose, so the suffix is the only
// stable part. The catalog is the one list of what this server publishes; a name added there is read
// for its closed fields without touching this module. These names are distinctive enough to match by
// suffix; what that still costs — a foreign tool deliberately borrowing one of them — is recorded as an
// accepted residual in docs/local-agent-architecture.md#accepted-residuals.
const E_COMET_TOOL_NAMES = new Set(tools.map((tool) => tool.name));

// The remote e-Comet MCP publishes these, and its failures matter most: `browser_job` authorizes every
// signed live call and runs immediately before it, so a rejection there is the only line support gets.
// A host names that server by its connector id, so these are matched by the whole name rather than by
// the suffix: `info`, `query_metrics` and `campaign_settings` are names another server may legitimately
// publish, and a suffix match would hand it the channel the catalog restriction closes. Matching the
// whole name is what lets every one of them be read without that risk. `report_issue` never reaches
// here, being excluded as a feedback tool. The update hook and the `hooks.json` matcher carry the same set. A method
// the server publishes before our next release is missing from all three until then: accepted residual, see
// docs/local-agent-architecture.md#accepted-residuals.
export const REMOTE_E_COMET_TOOL_NAMES = Object.freeze([
    'browser_job', 'campaign_clusters_settings', 'campaign_settings', 'campaign_target_products_settings',
    'describe_metrics', 'info', 'list_entities', 'org_balance', 'query_forecast', 'query_metrics',
    'query_phrase_frequency', 'search_phrases', 'subscription', 'subscription_balance_history',
    'find_account', 'product_settings', 'stock_rebalancer_settings', 'stock_rebalancer_status',
    'update_campaign_settings', 'update_campaign_clusters_settings', 'update_campaign_target_products_settings',
    'update_product_settings', 'update_stock_rebalancer_settings',
    'campaign_comments', 'product_comments', 'update_campaign_comments', 'update_product_comments',
]);
const REMOTE_TOOL_NAME = new RegExp(`^mcp__(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|e-comet)__(?:${REMOTE_E_COMET_TOOL_NAMES.join('|')})$`);

const toolSuffix = (name) => name.split('__').at(-1);

const isFeedbackTool = (name) => FEEDBACK_TOOL_SUFFIXES.has(toolSuffix(name));

const isECometTool = (name) => typeof name === 'string'
    && (E_COMET_TOOL_NAMES.has(toolSuffix(name)) || REMOTE_TOOL_NAME.test(name)
        // The extractor still excludes feedback calls. The native bridge also uses
        // this closed projection to keep a failed authorization's transport private.
        || name === 'mcp__e-comet__report_issue');

export const isFeedbackToolName = (value) =>
    typeof value === 'string' && value.length <= TOOL_NAME_MAX_LENGTH && TOOL_NAME.test(value);

export const isFeedbackCallTimestamp = (value) => isCanonicalTimestamp(value);

/** The exact closed outcome shape the extractor produces; the renderer re-checks it at its boundary. */
export const isFeedbackToolOutcome = (value) => {
    if (!isObject(value)) return false;
    const keys = Object.keys(value);
    if (keys.length === 0 || keys.some((key) => !OUTCOME_KEYS.has(key))) return false;
    return (value.ok === undefined || typeof value.ok === 'boolean')
        && (value.status === undefined || (typeof value.status === 'string' && OUTCOME_LOWER.test(value.status)))
        && (value.code === undefined || (typeof value.code === 'string' && OUTCOME_CODE.test(value.code)))
        && (value.stage === undefined || (typeof value.stage === 'string' && OUTCOME_LOWER.test(value.stage)))
        && (value.cause === undefined || (typeof value.cause === 'string' && OUTCOME_CAUSE.test(value.cause)))
        && (value.isError === undefined || value.isError === true);
};

const acceptedToolName = (value) => isFeedbackToolName(value) && !isFeedbackTool(value);

const callRecord = (name, timestamp) => ({ name, ...(isFeedbackCallTimestamp(timestamp) ? { at: timestamp } : {}) });

// Every text a result carries, in order: a plain string, or the text blocks of a content array.
const resultTexts = (content) => {
    if (typeof content === 'string') return [content];
    if (!Array.isArray(content)) return [];
    return content.filter((item) => isObject(item) && typeof item.text === 'string').map((item) => item.text);
};

const parseObject = (text) => {
    if (typeof text !== 'string' || text.length > OUTCOME_TEXT_MAX_LENGTH) return undefined;
    const trimmed = text.trimStart();
    const marker = trimmed.startsWith('{') ? undefined : EXEC_OUTPUT_MARKER.exec(trimmed);
    const body = marker ? trimmed.slice(marker.index + marker[0].length).trimStart() : trimmed;
    if (!body.startsWith('{')) return undefined;
    try {
        const value = JSON.parse(body);
        return isObject(value) ? value : undefined;
    } catch {
        return undefined;
    }
};

// A host may record the whole CallToolResult envelope as the result; its own text blocks carry the tool's
// JSON, and its isError flag is the host's, not the tool's.
const unwrapEnvelope = (value) => {
    if (!Array.isArray(value.content)) return { value, isError: false };
    for (const text of resultTexts(value.content)) {
        const inner = parseObject(text);
        if (inner) return { value: inner, isError: value.isError === true };
    }
    return { value, isError: value.isError === true };
};

const closedField = (candidate, grammar) => (typeof candidate === 'string' && grammar.test(candidate) ? candidate : undefined);

/**
 * Projects one tool result onto its closed outcome fields. The first text that parses as a JSON
 * object supplies them; free text, foreign shapes and out-of-grammar values contribute nothing.
 * `status`, `code`, `stage` and `cause` are read only when the call names an e-Comet tool, local or remote; any
 * other tool contributes `ok` and the host's error flag, which cannot carry a value we did not define.
 */
export const projectFeedbackToolOutcome = (content, isError = false, toolName = undefined) => {
    const ours = isECometTool(toolName);
    const outcome = {};
    for (const text of resultTexts(content)) {
        const parsed = parseObject(text);
        if (!parsed) continue;
        const { value, isError: envelopeError } = unwrapEnvelope(parsed);
        if (typeof value.ok === 'boolean') outcome.ok = value.ok;
        if (ours) {
            const status = closedField(value.status, OUTCOME_LOWER);
            if (status) outcome.status = status;
            const error = isObject(value.error) ? value.error : undefined;
            const code = closedField(value.code, OUTCOME_CODE) ?? closedField(error?.code, OUTCOME_CODE);
            if (code) outcome.code = code;
            const stage = closedField(value.stage, OUTCOME_LOWER) ?? closedField(error?.stage, OUTCOME_LOWER);
            if (stage) outcome.stage = stage;
            // The native DeepSeek adapter classifies a failed call (network, timeout, http_4xx, http_5xx, protocol, unknown).
            const cause = closedField(value.cause, OUTCOME_CAUSE) ?? closedField(error?.cause, OUTCOME_CAUSE);
            if (cause) outcome.cause = cause;
        }
        if (envelopeError) outcome.isError = true;
        break;
    }
    if (isError === true) outcome.isError = true;
    return Object.keys(outcome).length ? outcome : undefined;
};

const claudeToolCalls = (record, pending) => {
    if (record.type !== 'assistant' || !isObject(record.message) || !Array.isArray(record.message.content)) return [];
    const calls = [];
    for (const content of record.message.content) {
        if (!isObject(content) || content.type !== 'tool_use' || !acceptedToolName(content.name)) continue;
        const call = callRecord(content.name, record.timestamp);
        if (typeof content.id === 'string') pending.set(content.id, call);
        calls.push(call);
    }
    return calls;
};

const claudeToolResults = (record, pending) => {
    if (record.type !== 'user' || !isObject(record.message) || !Array.isArray(record.message.content)) return;
    for (const content of record.message.content) {
        if (!isObject(content) || content.type !== 'tool_result' || typeof content.tool_use_id !== 'string') continue;
        const call = pending.get(content.tool_use_id);
        if (!call) continue;
        pending.delete(content.tool_use_id);
        const outcome = projectFeedbackToolOutcome(content.content, content.is_error === true, call.name);
        if (outcome) call.outcome = outcome;
    }
};

// Codex rollouts record every call and its output as response_item records correlated by call_id; the
// app-server event stream's item.completed notifications never reach the rollout file.
const codexToolCall = (record, pending) => {
    if (record.type !== 'response_item' || !isObject(record.payload)) return undefined;
    const item = record.payload;
    if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || !acceptedToolName(item.name)) return undefined;
    const call = callRecord(item.name, record.timestamp);
    if (typeof item.call_id === 'string') pending.set(item.call_id, call);
    return call;
};

const codexToolResult = (record, pending) => {
    if (record.type !== 'response_item' || !isObject(record.payload)) return;
    const { payload } = record;
    if ((payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') || typeof payload.call_id !== 'string') return;
    const call = pending.get(payload.call_id);
    if (!call) return;
    pending.delete(payload.call_id);
    const outcome = projectFeedbackToolOutcome(payload.output, false, call.name);
    if (outcome) call.outcome = outcome;
};

// Native DSH session v4 logs use numeric milliseconds and exact top-level events. Do not
// walk message payloads or parse authored arguments: only names and correlated outcomes leave here.
// Prepared-receipt recovery keeps its own session/argument rules and its own call/result matching: see the accepted
// residual "Separate native preparation-recovery and diagnostic pairing" in docs/local-agent-architecture.md#accepted-residuals.
const deepseekToolEvent = (record, pending) => {
    if (!isObject(record.data)) return undefined;
    const data = record.data;
    const direct = record.type === 'tool/call';
    const nested = record.type === 'tool/ptc-dispatch-start';
    if (direct || nested) {
        if (!acceptedToolName(data.name)) return undefined;
        const timestamp = Number.isSafeInteger(record.time) && record.time >= 0 && record.time <= 253402300799999
            ? new Date(record.time).toISOString() : undefined;
        const call = callRecord(data.name, timestamp);
        const id = direct ? data.callId : data.subCallId;
        if (typeof id === 'string') pending.set(`deepseek:${direct ? 'direct' : 'ptc'}:${id}`, call);
        return call;
    }
    const message = record.type === 'tool/result' && isObject(data.message) ? data.message : undefined;
    const outcome = record.type === 'tool/ptc-dispatch' ? data : message;
    if (!outcome) return undefined;
    const id = message ? message.toolCallId : data.subCallId;
    if (typeof id !== 'string') return undefined;
    const key = `deepseek:${message ? 'direct' : 'ptc'}:${id}`;
    const call = pending.get(key);
    if (!call || (!message && data.name !== call.name)) return undefined;
    pending.delete(key);
    // DSH ToolRuntime prefixes thrown MCP failures with exactly "Error: ".
    // Prefer our trailing compact evidence over the rendered summary/resource links.
    // Bound the entire block before scanning, and never search prose for JSON fields.
    const content = outcome.isError === true && Array.isArray(outcome.content)
        ? outcome.content.map((block) => {
            if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string'
                || block.text.length > OUTCOME_TEXT_MAX_LENGTH || !block.text.startsWith('Error: ')) return block;
            const marker = block.text.lastIndexOf(STRUCTURED_MCP_EVIDENCE_MARKER);
            const text = marker < 0 ? block.text.slice(7)
                : block.text.slice(marker + STRUCTURED_MCP_EVIDENCE_MARKER.length);
            // Starting at the object prevents the generic exec-output wrapper parser
            // from admitting prose before a malformed or forged evidence suffix.
            return { ...block, text: text.startsWith('{') ? text : '' };
        })
        : outcome.content;
    const projected = projectFeedbackToolOutcome(content, outcome.isError === true, call.name);
    if (projected) call.outcome = projected;
    return undefined;
};

/**
 * Extract tool calls in native Claude, Codex and DeepSeek JSONL records: the safe direct name, the
 * record timestamp when the host wrote one, and the closed outcome of the correlated result.
 * Payloads are never searched recursively because transcript content is untrusted diagnostic input.
 *
 * @param {Buffer} jsonlBytes
 * @returns {Array<{ name: string, at?: string, outcome?: { ok?: boolean, status?: string, code?: string, stage?: string, cause?: string, isError?: true } }>}
 */
export const extractFeedbackToolCalls = (jsonlBytes) => {
    if (!Buffer.isBuffer(jsonlBytes)) return [];
    const calls = [];
    const pending = new Map();
    for (const line of jsonlBytes.toString('utf8').split('\n')) {
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isObject(record)) continue;
        calls.push(...claudeToolCalls(record, pending));
        claudeToolResults(record, pending);
        const codexCall = codexToolCall(record, pending);
        if (codexCall !== undefined) calls.push(codexCall);
        codexToolResult(record, pending);
        const deepseekCall = deepseekToolEvent(record, pending);
        if (deepseekCall) calls.push(deepseekCall);
    }
    return calls;
};
