import { isDeepStrictEqual } from 'node:util';
import { claimLocalAuthorization } from '../../../plugins/e-comet-skills/mcp/src/handoff/browser-job.mjs';
import { extractTriggerUrl } from '../../../plugins/e-comet-skills/mcp/src/handoff/call-result.mjs';
import { scrubPrivateResult } from '../../../plugins/e-comet-skills/mcp/src/handoff/call-result.mjs';
import { createMemoryGrantStore } from '../../../plugins/e-comet-skills/mcp/src/handoff/grants/memory-store.mjs';
import { LOCAL_TOOL_BY_BROWSER_JOB_TYPE as TARGETS } from '../../../plugins/e-comet-skills/mcp/src/handoff/grants/policy.mjs';
import { HandoffError } from '../../../plugins/e-comet-skills/mcp/src/handoff/hook-io.mjs';
import { SESSION_ID_MAX_BYTES } from '../../../plugins/e-comet-skills/mcp/src/handoff/session.mjs';
import { isRecord } from '../../../plugins/e-comet-skills/mcp/src/shared/values.mjs';
const REMOTE = 'mcp__e-comet__browser_job';
const LOCAL_PREFIX = 'mcp__e-comet-local__';
const SIGNED = new Set(Object.values(TARGETS).map((name) => LOCAL_PREFIX + name));
// The native host persists Error text, not arbitrary Error.code properties.
// Use the existing closed JSON outcome format so feedback retains the handoff cause.
export const failure = (code, message, stage = 'handoff', extra = {}) => Object.assign(new Error(JSON.stringify({ ok: false, code, stage, ...extra, message })), { code });
const sessionId = (exec) => {
    const id = exec.agent?.session?.header?.id;
    if (typeof id !== 'string' || !id || Buffer.byteLength(id) > SESSION_ID_MAX_BYTES.BROWSER_JOB)
        throw failure('HANDOFF_INVALID_SESSION', 'The native agent has no valid session identity.');
    return id;
};
const privateFields = new Set(['trigger_url', 'triggerUrl']);
// Sanitize the canonical value as well as text projections: run_code receives value.
const sanitize = (value, token) => scrubPrivateResult(value, [token], privateFields, '[authorization retained privately]');
/** Owns exact native invocations. Secrets never enter arguments logged by ToolRuntime. */
export function createAdapter({ dataDirectory, now = Date.now, feedback }) {
    if (typeof dataDirectory !== 'string' || !dataDirectory)
        throw new TypeError('A dedicated dataDirectory is required.');
    const permitted = new Map();
    const drafts = new Map();
    // Grants never reach the disk: a restarted adapter has none (spec §7.2).
    const grants = createMemoryGrantStore();
    const relevant = (name) => name === REMOTE || SIGNED.has(name) || feedback.tools.has(name);
    function validate(exec) {
        sessionId(exec);
        if (feedback.tools.has(exec.name))
            feedback.validate(exec);
        if (SIGNED.has(exec.name)) {
            if (!isRecord(exec.arguments))
                throw failure('HANDOFF_INVALID_INPUT', 'Local tool arguments must be an object.');
            if (Object.hasOwn(exec.arguments, 'triggerUrl') || Object.hasOwn(exec.arguments, 'trigger_url'))
                throw failure('HANDOFF_MODEL_AUTHORIZATION', 'Remove model-authored authorization fields; the native adapter injects them privately.');
        }
    }
    async function preExecute(exec, next) {
        if (!relevant(exec.name))
            return next();
        try {
            sessionId(exec);
            if (feedback.tools.has(exec.name))
                await feedback.hydrate(exec);
            validate(exec);
        }
        catch (error) {
            return { kind: 'deny', reason: isRecord(error) ? error.message : undefined };
        }
        const decision = await next();
        // ToolRuntime resolves native ask approvals after this waterfall. Its execution
        // gate dispatches only approved asks; retain the exact token without changing policy.
        if (['allow', 'ask'].includes(decision.kind) && !exec.signal.aborted)
            permitted.set(exec.token, { session: sessionId(exec), name: exec.name, executing: false });
        return decision;
    }
    async function execute(exec, next) {
        if (!relevant(exec.name))
            return next();
        const permit = permitted.get(exec.token);
        if (!permit || permit.name !== exec.name || permit.session !== sessionId(exec))
            throw failure('HANDOFF_UNATTESTED', 'The native pre-execution lifecycle is missing.');
        if (exec.signal.aborted)
            throw failure('HANDOFF_CANCELLED', 'The native call was cancelled before dispatch.');
        permit.executing = true;
        try {
            return await next();
        }
        finally {
            permit.executing = false;
        }
    }
    function attest(exec) {
        validate(exec);
        const permit = permitted.get(exec.token);
        if (!permit?.executing || permit.name !== exec.name || permit.session !== sessionId(exec))
            throw failure('HANDOFF_UNATTESTED', 'The native execution lifecycle is missing.');
        if (exec.signal.aborted)
            throw failure('HANDOFF_CANCELLED', 'The native call was cancelled before dispatch.');
    }
    // The browser-job flow's own claim step over the memory store: one use, the hook's lifetime and refusals.
    async function authorizeLocal(exec) {
        try {
            const effective = await claimLocalAuthorization({
                store: grants,
                sessionId: sessionId(exec),
                toolName: exec.name,
                toolInput: exec.arguments,
                nowMs: now(),
            });
            // A DeepSeek tool is never a Cowork device call, so the claim always returns the input with its authorization.
            if (!effective)
                throw new TypeError('The local authorization claim returned no input.');
            return effective;
        }
        catch (error) {
            if (error instanceof HandoffError)
                throw failure(error.code, error.recovery ? `${error.message} ${error.recovery}` : error.message);
            throw error;
        }
    }
    function wrapToolDefinition(definition) {
        if (!relevant(definition.name))
            return definition;
        const wrapped = {
            ...definition,
            async execute(args, exec) {
                attest(exec);
                if (feedback.tools.has(exec.name))
                    return feedback.run(exec, definition.execute.bind(definition));
                if (SIGNED.has(exec.name)) {
                    const effective = await authorizeLocal(exec);
                    if (exec.signal.aborted)
                        throw failure('HANDOFF_CANCELLED', 'The native call was cancelled before local dispatch.');
                    let message;
                    try {
                        return sanitize(await definition.execute(effective, exec), effective.triggerUrl);
                    }
                    catch (error) {
                        message = error instanceof Error ? error.message : 'The local MCP call failed.';
                    }
                    // A string comes back a string. The failure carries no cause: the original holds the unsanitized authorization.
                    throw new Error(String(sanitize(message, effective.triggerUrl)));
                }
                const raw = await definition.execute(args, exec);
                if (exec.name !== REMOTE)
                    return raw;
                let token;
                try {
                    token = extractTriggerUrl(raw);
                }
                catch {
                    throw failure('HANDOFF_INVALID_TOKEN', 'The remote browser authorization is ambiguous or invalid.');
                }
                if (!token)
                    throw failure('HANDOFF_TOKEN_NOT_FOUND', 'The remote browser authorization contained no usable token.');
                const job = isRecord(args) ? args.job : undefined;
                const type = isRecord(job) ? job.type : undefined;
                const target = typeof type === 'string' && Object.hasOwn(TARGETS, type) ? TARGETS[type] : undefined;
                if (!target)
                    throw failure('HANDOFF_INVALID_TOOL', 'The remote job type has no supported local tool.');
                const safe = sanitize(raw, token);
                drafts.set(exec.token, { session: sessionId(exec), target, safe, token, createdAt: now() });
                return safe;
            },
        };
        if (definition.name === REMOTE) {
            // A bridge projector must never restore its cached, unsanitized upstream result.
            delete wrapped.projectContent;
            delete wrapped.finalizeContent;
        }
        return wrapped;
    }
    function result(exec, outcome) {
        feedback.commit(exec, outcome);
        const draft = drafts.get(exec.token);
        drafts.delete(exec.token);
        permitted.delete(exec.token);
        if (!draft ||
            outcome.isError ||
            exec.signal.aborted ||
            draft.session !== sessionId(exec) ||
            !isDeepStrictEqual(outcome.value, draft.safe))
            return;
        grants.stage({ sessionId: draft.session, targetTool: draft.target, triggerUrl: draft.token, nowMs: draft.createdAt });
    }
    return { wrapToolDefinition, preExecute, execute, result, settle: feedback.settle };
}
// The host context's event registration, as this adapter uses it.
export function installAdapter(ctx, adapter) {
    // Wrap policies that may short-circuit with ask/deny instead of invoking next.
    ctx.on('tools/pre-execute', adapter.preExecute, { prepend: true });
    ctx.on('tools/execute', adapter.execute);
    ctx.on('tools/result', adapter.result);
}
