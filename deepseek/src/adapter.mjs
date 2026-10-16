import { isDeepStrictEqual } from 'node:util';
import { processHookEvent, extractTriggerUrl, MAX_SESSION_ID_BYTES, HANDOFF_TTL_MS, isEntryFresh, LOCAL_TOOL_BY_BROWSER_JOB_TYPE as TARGETS } from '../../plugins/e-comet-skills/hooks/browser-job-handoff.mjs';
import { createFeedbackHandoff, NATIVE_FEEDBACK_TOOLS } from './feedback.mjs';
import { scrubPrivateResult } from './private-result.mjs';

const REMOTE = 'mcp__e-comet__browser_job';
const LOCAL_PREFIX = 'mcp__e-comet-local__';
const SIGNED = new Set(Object.values(TARGETS).map(name => LOCAL_PREFIX + name));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The native host persists Error text, not arbitrary Error.code properties.
// Use the existing closed JSON outcome format so feedback retains the handoff cause.
export const failure = (code, message, stage = 'handoff') => Object.assign(new Error(JSON.stringify({ ok: false, code, stage, message })), { code });
const sessionId = exec => {
  const id = exec.agent?.session?.header?.id;
  if (typeof id !== 'string' || !id || Buffer.byteLength(id) > MAX_SESSION_ID_BYTES) throw failure('HANDOFF_INVALID_SESSION', 'The native agent has no valid session identity.');
  return id;
};
const key = (session, target) => JSON.stringify([session, target]);
const handoffCode = message => /^(HANDOFF_[A-Z_]+):/.exec(message ?? '')?.[1];

const privateFields = new Set(['trigger_url', 'triggerUrl']);
// Sanitize the canonical value as well as text projections: run_code receives value.
const sanitize = (value, token) => scrubPrivateResult(value, [token], privateFields, '[authorization retained privately]');

/** Owns exact native invocations. Secrets never enter arguments logged by ToolRuntime. */
export function createAdapter({ dataDirectory, now = Date.now, feedbackServices, updates } = {}) {
  if (typeof dataDirectory !== 'string' || !dataDirectory) throw new TypeError('A dedicated dataDirectory is required.');
  const env = { ...process.env, PLUGIN_DATA: dataDirectory, CLAUDE_PLUGIN_DATA: dataDirectory };
  const permitted = new Map();
  const drafts = new Map();
  const grants = new Map();
  const feedback = createFeedbackHandoff({ dataDirectory, services: feedbackServices, now });
  const relevant = name => name === REMOTE || SIGNED.has(name) || NATIVE_FEEDBACK_TOOLS.has(name);

  function validate(exec) {
    sessionId(exec);
    if (NATIVE_FEEDBACK_TOOLS.has(exec.name)) feedback.validate(exec);
    if (SIGNED.has(exec.name)) {
      if (!record(exec.arguments)) throw failure('HANDOFF_INVALID_INPUT', 'Local tool arguments must be an object.');
      if (Object.hasOwn(exec.arguments, 'triggerUrl') || Object.hasOwn(exec.arguments, 'trigger_url')) throw failure('HANDOFF_MODEL_AUTHORIZATION', 'Remove model-authored authorization fields; the native adapter injects them privately.');
    }
  }

  async function preExecute(exec, next) {
    if (!relevant(exec.name)) return next();
    try { sessionId(exec); if (NATIVE_FEEDBACK_TOOLS.has(exec.name)) await feedback.hydrate(exec); validate(exec); } catch (error) { return { kind: 'deny', reason: error.message }; }
    const decision = await next();
    // ToolRuntime resolves native ask approvals after this waterfall. Its execution
    // gate dispatches only approved asks; retain the exact token without changing policy.
    if (['allow', 'ask'].includes(decision.kind) && !exec.signal.aborted) permitted.set(exec.token, { session: sessionId(exec), name: exec.name, executing: false });
    return decision;
  }

  async function executeAuthorized(exec, next) {
    if (!relevant(exec.name)) return next();
    const permit = permitted.get(exec.token);
    if (!permit || permit.name !== exec.name || permit.session !== sessionId(exec)) throw failure('HANDOFF_UNATTESTED', 'The native pre-execution lifecycle is missing.');
    if (exec.signal.aborted) throw failure('HANDOFF_CANCELLED', 'The native call was cancelled before dispatch.');
    permit.executing = true;
    try { return await next(); } finally { permit.executing = false; }
  }

  function execute(exec, next) {
    const owned = exec.name.startsWith('mcp__e-comet__') || exec.name.startsWith(LOCAL_PREFIX);
    return updates && owned ? updates.runTool(() => executeAuthorized(exec, next)) : executeAuthorized(exec, next);
  }

  function attest(exec) {
    validate(exec);
    const permit = permitted.get(exec.token);
    if (!permit?.executing || permit.name !== exec.name || permit.session !== sessionId(exec)) throw failure('HANDOFF_UNATTESTED', 'The native execution lifecycle is missing.');
    if (exec.signal.aborted) throw failure('HANDOFF_CANCELLED', 'The native call was cancelled before dispatch.');
  }

  async function authorizeLocal(exec) {
    const grantKey = key(sessionId(exec), exec.name);
    const pending = grants.get(grantKey) ?? [];
    grants.delete(grantKey); // A competing local body cannot claim these grants.
    if (!pending.length) throw failure('HANDOFF_MISSING', 'Call browser_job once for this session and matching local tool.');
    const nowMs = now();
    const fresh = pending.filter(grant => isEntryFresh({ createdAtMs: grant.createdAt }, nowMs));
    if (!fresh.length) throw failure('HANDOFF_EXPIRED', 'Call browser_job once for a fresh matching authorization.');
    // tools/result is synchronous and cannot await disk writes. Deferred publication
    // processes only committed native Post evidence here, before the local body.
    for (const grant of fresh) {
      if (grant.staged) continue;
      const stage = await processHookEvent(grant.event, { env, nowMs: grant.createdAt });
      if (stage.exitCode !== 0) {
        // This in-process hook already projects closed storage diagnostics; do not replace its cause.
        const code = handoffCode(stage.stderr);
        throw failure(code ?? 'HANDOFF_STAGE_FAILED',
          (code ? stage.stderr : 'The public authorization hook could not stage the committed result.')
          + ' Resolve the handoff failure before requesting fresh browser authorization.');
      }
    }
    const outcome = await processHookEvent({ hook_event_name: 'PreToolUse', tool_name: exec.name, session_id: sessionId(exec), tool_input: exec.arguments }, { env, nowMs: now() });
    let output;
    try { output = JSON.parse(outcome.stdout).hookSpecificOutput; } catch { throw failure('HANDOFF_HOOK_FAILED', 'The public authorization hook returned no valid decision.'); }
    if (output.permissionDecision !== 'allow' || !record(output.updatedInput)) {
      const code = handoffCode(output.permissionDecisionReason);
      if (code === 'HANDOFF_STORAGE_ERROR' && fresh.length === 1) {
        // Retry only the existing publication: restaging could replay a consumed
        // grant. The shared claim marker remains authoritative after partial failure.
        grants.set(grantKey, [...(grants.get(grantKey) ?? []), { ...fresh[0], staged: true }]);
      }
      throw failure(code ?? 'HANDOFF_DENIED', output.permissionDecisionReason ?? 'The public authorization hook denied dispatch.');
    }
    return output.updatedInput;
  }

  function wrapToolDefinition(definition) {
    if (!relevant(definition.name)) return definition;
    const wrapped = { ...definition, async execute(args, exec) {
      attest(exec);
      if (NATIVE_FEEDBACK_TOOLS.has(exec.name)) return feedback.run(exec, definition.execute.bind(definition));
      if (SIGNED.has(exec.name)) {
        const effective = await authorizeLocal(exec);
        if (exec.signal.aborted) throw failure('HANDOFF_CANCELLED', 'The native call was cancelled before local dispatch.');
        try { return sanitize(await definition.execute(effective, exec), effective.triggerUrl); }
        catch (error) {
          const message = error instanceof Error ? error.message : 'The local MCP call failed.';
          throw new Error(sanitize(message, effective.triggerUrl));
        }
      }
      const raw = await definition.execute(args, exec);
      if (exec.name !== REMOTE) return raw;
      let token;
      try { token = extractTriggerUrl(raw); } catch { throw failure('HANDOFF_INVALID_TOKEN', 'The remote browser authorization is ambiguous or invalid.'); }
      if (!token) throw failure('HANDOFF_TOKEN_NOT_FOUND', 'The remote browser authorization contained no usable token.');
      const target = Object.hasOwn(TARGETS, args?.job?.type) ? TARGETS[args.job.type] : undefined;
      if (!target) throw failure('HANDOFF_INVALID_TOOL', 'The remote job type has no supported local tool.');
      const safe = sanitize(raw, token);
      drafts.set(exec.token, { session: sessionId(exec), target: LOCAL_PREFIX + target, safe, createdAt: now(),
        event: { hook_event_name: 'PostToolUse', tool_name: REMOTE, session_id: sessionId(exec), tool_input: args, tool_response: raw } });
      return safe;
    } };
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
    if (!draft || outcome.isError || exec.signal.aborted || draft.session !== sessionId(exec) || !isDeepStrictEqual(outcome.value, draft.safe)) return;
    const grantKey = key(draft.session, draft.target);
    const pending = (grants.get(grantKey) ?? []).filter(grant => now() - grant.createdAt <= HANDOFF_TTL_MS);
    pending.push(draft);
    grants.set(grantKey, pending);
  }

  return { wrapToolDefinition, preExecute, execute, result, settle: feedback.settle };
}

export function installAdapter(ctx, adapter) {
  // Wrap policies that may short-circuit with ask/deny instead of invoking next.
  ctx.on('tools/pre-execute', adapter.preExecute, { prepend: true });
  ctx.on('tools/execute', adapter.execute);
  ctx.on('tools/result', adapter.result);
}
