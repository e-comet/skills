#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './entry-point.mjs';
import { processHookEvent } from '../hooks/browser-job-handoff.mjs';
import { attachStdioTransport } from '../mcp/src/stdio-transport.mjs';
import { SIGNED_CONTRACT_TOOL_NAMES } from '../mcp/src/tool-contracts.mjs';
import { resolveQwenRuntimeEnv } from './runtime-env.mjs';
import { prepareQwenFeedbackCall } from './feedback-handoff.mjs';

const signedTools = new Set(SIGNED_CONTRACT_TOOL_NAMES);
const feedbackTools = new Set(['prepare_e_comet_feedback', 'submit_e_comet_feedback']);
for (const name of feedbackTools) signedTools.add(name);
const isSignedCall = message => message?.method === 'tools/call' && signedTools.has(message.params?.name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const refusal = (id, text) => ({ response: { jsonrpc: '2.0', id,
    result: { isError: true, content: [{ type: 'text', text }] } } });

export const prepareBrowserCall = async (message, options = {}) => {
    if (!isSignedCall(message)) return { message };
    const feedback = feedbackTools.has(message.params.name);
    if (message.jsonrpc !== '2.0' || !validId(message.id)) {
        return { response: rpcError(null, -32600, `${feedback ? 'Feedback' : 'Signed browser'} tools require a JSON-RPC request ID.`) };
    }
    // Only Qwen's transport-owned root metadata is trusted. The arguments object is
    // model-authored. Hook prompt_id and MCP promptId differ in Qwen 0.25.0.
    const context = message.params._meta?.['qwen-code/invocation'];
    if (!object(context) || context.version !== 1 || typeof context.sessionId !== 'string'
        || !context.sessionId.trim() || Buffer.byteLength(context.sessionId, 'utf8') > 512) {
        return refusal(message.id, feedback
            ? 'FEEDBACK_QWEN_CONTEXT_REQUIRED: Qwen did not provide valid native session metadata. Check the Qwen plugin integration before preparing or authorizing feedback.'
            : 'HANDOFF_QWEN_CONTEXT_REQUIRED: Qwen did not provide valid native session metadata. Check the Qwen plugin integration; another browser_job cannot repair missing host context.');
    }
    const handler = feedback ? prepareQwenFeedbackCall : processHookEvent;
    const result = await handler({
        hook_event_name: 'PreToolUse', session_id: context.sessionId,
        tool_name: `mcp__e-comet-local__${message.params.name}`,
        tool_input: message.params.arguments === undefined ? {} : message.params.arguments,
    }, { ...options, env: resolveQwenRuntimeEnv(options.env) });
    const decision = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : undefined;
    if (result.exitCode !== 0 || decision?.permissionDecision !== 'allow' || !object(decision.updatedInput)) {
        return refusal(message.id, decision?.permissionDecisionReason
            ?? (feedback ? 'FEEDBACK_QWEN_INTEGRATION_ERROR: The local feedback handoff failed. Check the Qwen plugin integration before authorizing feedback.'
                : 'HANDOFF_QWEN_INTEGRATION_ERROR: The local authorization handoff failed. Check the Qwen plugin integration before requesting another browser_job.'));
    }
    return { message: { ...message, params: { ...message.params, arguments: decision.updatedInput } } };
};

export const runProxy = ({
    childCommand = process.execPath,
    childArgs = [fileURLToPath(new URL('../mcp/src/server.mjs', import.meta.url))],
    env = process.env, input = process.stdin, output = process.stdout, error = process.stderr,
} = {}) => new Promise(resolveExit => {
    env = resolveQwenRuntimeEnv(env);
    const child = spawn(childCommand, childArgs, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // These entries exist only while filesystem claims are in flight. A cancelled
    // claim may be consumed, but it must never be restored or dispatched later.
    const preparing = new Map();
    let inputEnded = false;
    let closed = false;
    let failed = false;
    const send = message => { if (!closed) output.write(`${JSON.stringify(message)}\n`); };
    const fail = () => {
        if (closed || failed) return;
        failed = true;
        error.write('QWEN_PROXY_TRANSPORT_ERROR: The local MCP transport closed unexpectedly.\n');
        for (const pending of preparing.values()) pending.cancelled = true;
        child.kill();
    };
    const endInput = () => {
        if (inputEnded && preparing.size === 0 && !child.stdin.destroyed) child.stdin.end();
    };
    const forward = message => {
        if (!closed && !failed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const detachInput = attachStdioTransport({ input,
        sendError: (id, code, message) => send(rpcError(id, code, message)),
        onClose: () => { inputEnded = true; endInput(); },
        handleMessage: async message => {
            if (closed || failed) return;
            if (message?.method === 'notifications/cancelled') {
                const pending = preparing.get(message.params?.requestId);
                if (pending) { pending.cancelled = true; return; }
            }
            if (!isSignedCall(message)) { forward(message); return; }
            if (preparing.has(message.id)) {
                send(rpcError(message.id, -32600, 'A request with this ID is already awaiting authorization.'));
                return;
            }
            const pending = { cancelled: false };
            preparing.set(message.id, pending);
            try {
                const result = await prepareBrowserCall(message, { env });
                if (!pending.cancelled && !closed && !failed) {
                    if (result.response) send(result.response);
                    else forward(result.message);
                }
            } finally {
                preparing.delete(message.id);
                endInput();
            }
        },
    });
    // Parse complete bounded frames so a local refusal cannot be inserted in the
    // middle of a child stdout chunk. Preserve every JSON-RPC envelope and field.
    const detachOutput = attachStdioTransport({ input: child.stdout,
        handleMessage: send, sendError: fail,
    });
    child.stderr.pipe(error, { end: false });
    child.on('error', fail);
    child.stdin.on('error', fail);
    input.on('error', fail);
    output.on('error', fail);
    const stop = () => child.kill();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('close', (code) => {
        closed = true;
        for (const pending of preparing.values()) pending.cancelled = true;
        detachInput(); detachOutput();
        input.pause();
        input.off('error', fail); output.off('error', fail);
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        resolveExit(failed ? 1 : code ?? 1);
    });
});

if (isMainModule(import.meta.url)) {
    process.exitCode = await runProxy();
}
