#!/usr/bin/env node

import { processHookEvent } from '../hooks/browser-job-handoff.mjs';
import { isMainModule } from './entry-point.mjs';
import { resolveQwenRuntimeEnv } from './runtime-env.mjs';
import { processQwenFeedbackEvent } from './feedback-handoff.mjs';
import { MAX_MCP_MESSAGE_BYTES } from '../mcp/src/config.mjs';

const isBrowserPost = event => (event?.hook_event_name ?? event?.hookEventName) === 'PostToolUse'
    && /^mcp__.+__browser_job$/.test(event?.tool_name ?? event?.toolName ?? '');
const isFeedbackPost = event => (event?.hook_event_name ?? event?.hookEventName) === 'PostToolUse'
    && /^(?:mcp__e-comet-local__prepare_e_comet_feedback|mcp__e-comet__report_issue)$/.test(event?.tool_name ?? event?.toolName ?? '');

export const normalizeQwenPostEvent = event => {
    if (!isBrowserPost(event) && !isFeedbackPost(event)) return event;
    const response = event.tool_response ?? event.toolResponse;
    if (!response || typeof response !== 'object' || Array.isArray(response)) return event;
    // Qwen marks native tool errors on ToolResult.error; keep them unchanged for
    // the model and let shared feedback staging observe the failed envelope.
    const normalized = isFeedbackPost(event) && response.error ? { ...response, isError: true } : response;
    const parts = typeof response.llmContent === 'string' ? [response.llmContent] : response.llmContent;
    if (!Array.isArray(parts)) return normalized === response ? event : { ...event, tool_response: normalized };
    const content = parts.flatMap(part => {
        const text = typeof part === 'string' ? part : part?.text;
        return typeof text === 'string' ? [{ type: 'text', text }] : [];
    });
    // Retain existing candidates: a conflicting native envelope must remain ambiguous.
    return { ...event, tool_response: { ...normalized,
        content: [...(Array.isArray(response.content) ? response.content : []), ...content] } };
};

export const processQwenPostEvent = async (event, options = {}) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return { exitCode: 2, stdout: '', stderr: 'HANDOFF_INVALID_EVENT: The Qwen hook event is invalid.' };
    }
    return isBrowserPost(event)
        ? processHookEvent(normalizeQwenPostEvent(event), { ...options, env: resolveQwenRuntimeEnv(options.env) })
        : isFeedbackPost(event) ? processQwenFeedbackEvent(normalizeQwenPostEvent(event), { ...options, env: resolveQwenRuntimeEnv(options.env) })
            : { exitCode: 0, stdout: '', stderr: '' };
};

const main = async () => {
    let result;
    try {
        const chunks = [];
        let bytes = 0;
        // Same bound as the shared command hook; reject before accumulating a large event.
        for await (const chunk of process.stdin) {
            bytes += chunk.length;
            if (bytes > 2 * MAX_MCP_MESSAGE_BYTES + 256 * 1024) throw new Error('oversized hook event');
            chunks.push(chunk);
        }
        result = await processQwenPostEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
        result = { exitCode: 2, stdout: '', stderr: 'HANDOFF_INVALID_EVENT: The Qwen hook event is invalid or too large.' };
    }
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
};

if (isMainModule(import.meta.url)) await main();
