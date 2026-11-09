import { isNonNegativeSafeInteger, isRecord as isObject } from '../../../../shared/values.mjs';
import { STRUCTURED_MCP_EVIDENCE_MARKER } from '../../contract/tool-calls.mjs';
import { acceptedToolName, callRecord, OUTCOME_TEXT_MAX_LENGTH, toolOutcomeProjector, } from '../../domain/converters/tool-outcome.converter.mjs';
/** The transcript reader over the tool names the root passes (the tool-names port). */
export const createToolCallExtractor = (toolNames) => {
    const projectFeedbackToolOutcome = toolOutcomeProjector(toolNames);
    const claudeToolCalls = (record, pending) => {
        if (record.type !== 'assistant' || !isObject(record.message) || !Array.isArray(record.message.content))
            return [];
        const calls = [];
        for (const content of record.message.content) {
            if (!isObject(content) || content.type !== 'tool_use' || !acceptedToolName(content.name))
                continue;
            const call = callRecord(content.name, record.timestamp);
            if (typeof content.id === 'string')
                pending.set(content.id, call);
            calls.push(call);
        }
        return calls;
    };
    const claudeToolResults = (record, pending) => {
        if (record.type !== 'user' || !isObject(record.message) || !Array.isArray(record.message.content))
            return;
        for (const content of record.message.content) {
            if (!isObject(content) || content.type !== 'tool_result' || typeof content.tool_use_id !== 'string')
                continue;
            const call = pending.get(content.tool_use_id);
            if (!call)
                continue;
            pending.delete(content.tool_use_id);
            const outcome = projectFeedbackToolOutcome(content.content, content.is_error === true, call.name);
            if (outcome)
                call.outcome = outcome;
        }
    };
    // Codex rollouts record every call and its output as response_item records correlated by call_id; the
    // app-server event stream's item.completed notifications never reach the rollout file.
    const codexToolCall = (record, pending) => {
        if (record.type !== 'response_item' || !isObject(record.payload))
            return undefined;
        const item = record.payload;
        if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || !acceptedToolName(item.name))
            return undefined;
        const call = callRecord(item.name, record.timestamp);
        if (typeof item.call_id === 'string')
            pending.set(item.call_id, call);
        return call;
    };
    const codexToolResult = (record, pending) => {
        if (record.type !== 'response_item' || !isObject(record.payload))
            return;
        const { payload } = record;
        if ((payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') || typeof payload.call_id !== 'string')
            return;
        const call = pending.get(payload.call_id);
        if (!call)
            return;
        pending.delete(payload.call_id);
        const outcome = projectFeedbackToolOutcome(payload.output, false, call.name);
        if (outcome)
            call.outcome = outcome;
    };
    // Native DSH session v4 logs use numeric milliseconds and exact top-level events. Do not
    // walk message payloads or parse authored arguments: only names and correlated outcomes leave here.
    // Prepared-receipt recovery keeps its own session/argument rules and its own call/result matching: see the accepted
    // residual "Separate native preparation-recovery and diagnostic pairing" in docs/architecture/residuals/feedback.md.
    const deepseekToolEvent = (record, pending) => {
        if (!isObject(record.data))
            return undefined;
        const data = record.data;
        const direct = record.type === 'tool/call';
        const nested = record.type === 'tool/ptc-dispatch-start';
        if (direct || nested) {
            if (!acceptedToolName(data.name))
                return undefined;
            const timestamp = isNonNegativeSafeInteger(record.time) && record.time <= 253402300799999 ? new Date(record.time).toISOString() : undefined;
            const call = callRecord(data.name, timestamp);
            const id = direct ? data.callId : data.subCallId;
            if (typeof id === 'string')
                pending.set(`deepseek:${direct ? 'direct' : 'ptc'}:${id}`, call);
            return call;
        }
        const message = record.type === 'tool/result' && isObject(data.message) ? data.message : undefined;
        const outcome = record.type === 'tool/ptc-dispatch' ? data : message;
        if (!outcome)
            return undefined;
        const id = message ? message.toolCallId : data.subCallId;
        if (typeof id !== 'string')
            return undefined;
        const key = `deepseek:${message ? 'direct' : 'ptc'}:${id}`;
        const call = pending.get(key);
        if (!call || (!message && data.name !== call.name))
            return undefined;
        pending.delete(key);
        // DSH ToolRuntime prefixes thrown MCP failures with exactly "Error: ".
        // Prefer our trailing compact evidence over the rendered summary/resource links.
        // Bound the entire block before scanning, and never search prose for JSON fields.
        const content = outcome.isError === true && Array.isArray(outcome.content)
            ? outcome.content.map((block) => {
                if (!isObject(block) ||
                    block.type !== 'text' ||
                    typeof block.text !== 'string' ||
                    block.text.length > OUTCOME_TEXT_MAX_LENGTH ||
                    !block.text.startsWith('Error: '))
                    return block;
                const marker = block.text.lastIndexOf(STRUCTURED_MCP_EVIDENCE_MARKER);
                const text = marker < 0 ? block.text.slice(7) : block.text.slice(marker + STRUCTURED_MCP_EVIDENCE_MARKER.length);
                // Starting at the object prevents the generic exec-output wrapper parser
                // from admitting prose before a malformed or forged evidence suffix.
                return { ...block, text: text.startsWith('{') ? text : '' };
            })
            : outcome.content;
        const projected = projectFeedbackToolOutcome(content, outcome.isError === true, call.name);
        if (projected)
            call.outcome = projected;
        return undefined;
    };
    /**
     * Extract tool calls in native Claude, Codex and DeepSeek JSONL records: the safe direct name, the
     * record timestamp when the host wrote one, and the closed outcome of the correlated result.
     * Payloads are never searched recursively because transcript content is untrusted diagnostic input.
     */
    return (jsonlBytes) => {
        if (!Buffer.isBuffer(jsonlBytes))
            return [];
        const calls = [];
        const pending = new Map();
        for (const line of jsonlBytes.toString('utf8').split('\n')) {
            let record;
            try {
                record = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!isObject(record))
                continue;
            calls.push(...claudeToolCalls(record, pending));
            claudeToolResults(record, pending);
            const codexCall = codexToolCall(record, pending);
            if (codexCall !== undefined)
                calls.push(codexCall);
            codexToolResult(record, pending);
            const deepseekCall = deepseekToolEvent(record, pending);
            if (deepseekCall)
                calls.push(deepseekCall);
        }
        return calls;
    };
};
