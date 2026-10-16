import { isDeepStrictEqual } from 'node:util';
import { processHookEvent, extractPreparedMetadata, extractUploadGrant, readPreparedArtifact } from '../../plugins/e-comet-skills/hooks/feedback-handoff.mjs';
import { toolInputSchemas, validateSchemaValue } from '../../plugins/e-comet-skills/mcp/src/tool-schemas.mjs';
import { scrubPrivateResult } from './private-result.mjs';
import { feedbackDiagnostics, FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES } from '../../plugins/e-comet-skills/mcp/src/feedback-diagnostics.mjs';

const PREPARE = 'mcp__e-comet-local__prepare_e_comet_feedback';
const AUTHORIZE = 'mcp__e-comet__report_issue';
const SUBMIT = 'mcp__e-comet-local__submit_e_comet_feedback';
export const NATIVE_FEEDBACK_TOOLS = new Set([PREPARE, AUTHORIZE, SUBMIT]);
const failure = (code, message) => Object.assign(new Error(message.startsWith(`${code}:`) ? message : `${code}: ${message}`), { code });
const hookFailure = (reason, fallback) => failure(/^FEEDBACK_[A-Z_]+:/.exec(reason ?? '')?.[0].slice(0, -1) ?? fallback, reason || 'The trusted feedback handoff failed.');
const session = exec => exec.agent.session.header.id;
const event = (exec, kind, response, extra = {}) => ({ hook_event_name: kind, tool_name: exec.name,
  session_id: session(exec), tool_input: exec.arguments, ...(response === undefined ? {} : { tool_response: response }), ...extra });
const privateFields = new Set(['uploadUrl', 'upload_url', 'requiredHeaders', 'required_headers', 'feedbackClaim', 'feedbackSession', 'transcriptPath']);

const redact = (value, secrets) => scrubPrivateResult(value, secrets, privateFields, '[retained privately]');

/** Only the owning native adapter calls this after its execution-token attestation. */
export function createFeedbackHandoff({ dataDirectory, services, now = Date.now }) {
  const env = { ...process.env, PLUGIN_DATA: dataDirectory, CLAUDE_PLUGIN_DATA: dataDirectory };
  const states = new Map();
  const drafts = new Map();

  async function hydrate(exec) {
    const id = session(exec);
    if (exec.name === PREPARE || states.has(id) || !services?.prepared) return;
    const recovered = await services.prepared(exec);
    if (!recovered) return;
    let stored;
    try { stored = await readPreparedArtifact({ env, sessionId: id, nowMs: now() }); }
    catch (error) {
      // Recovery runs before the tool body: expose only closed evidence in the host denial.
      const details = feedbackDiagnostics(error, 'artifact_read');
      const storage = FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES.includes(details.systemCode);
      throw failure(storage ? 'FEEDBACK_STORAGE_ERROR' : 'FEEDBACK_INTERNAL_ERROR',
        `${storage ? 'Local feedback storage could not be read.' : 'The retained feedback state could not be verified.'} ${JSON.stringify(details)}`);
    }
    states.set(id, { metadata: recovered.metadata, pending: isDeepStrictEqual(stored, recovered.metadata) ? []
      : [{ hook_event_name: 'PostToolUse', tool_name: PREPARE, session_id: id, tool_input: recovered.input, tool_response: recovered.response }] });
  }

  function validate(exec) {
    if (!services?.requestConsent || !services?.snapshot) throw failure('FEEDBACK_HOST_UNSUPPORTED', 'Native feedback consent and session history are unavailable.');
    const args = exec.arguments;
    if (exec.name === PREPARE) {
      if (!validateSchemaValue(args, toolInputSchemas.prepare_e_comet_feedback)
        || Object.keys(args).some(key => !['kind', 'summary', 'details', 'includeTranscript'].includes(key))) {
        throw failure('FEEDBACK_INVALID_INPUT', 'Use only the public feedback preparation arguments.');
      }
      return;
    }
    const state = states.get(session(exec));
    if (!state) throw failure('FEEDBACK_NOT_PREPARED', 'Prepare the report in this session before requesting upload authorization.');
    if (exec.name === AUTHORIZE) {
      if (!args || Object.keys(args).sort().join(',') !== 'kind,size_bytes'
        || args.kind !== state.metadata.kind || args.size_bytes !== state.metadata.sizeBytes) {
        throw failure('FEEDBACK_PREPARED_MISMATCH', 'Use the exact kind and size_bytes from this session’s prepared artifact.');
      }
    } else if (!validateSchemaValue(args, toolInputSchemas.submit_e_comet_feedback)
      || Object.keys(args).join(',') !== 'artifactId' || args.artifactId !== state.metadata.artifactId) {
      throw failure('FEEDBACK_PREPARED_MISMATCH', 'Submit only the artifactId prepared in this session.');
    }
  }

  async function hook(input) {
    const result = await processHookEvent(input, { env, nowMs: now() });
    if (result.exitCode !== 0) throw hookFailure(result.stderr, 'FEEDBACK_HANDOFF_FAILED');
    if (input.hook_event_name !== 'PreToolUse') return undefined;
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    if (output?.permissionDecision !== 'allow' || !output.updatedInput) {
      throw hookFailure(output?.permissionDecisionReason, 'FEEDBACK_HANDOFF_DENIED');
    }
    return output.updatedInput;
  }

  async function flush(exec) {
    const state = states.get(session(exec));
    // A correctable storage failure must retain the committed event for the next attempt.
    while (state?.pending.length) {
      try { await hook(state.pending[0]); state.pending.shift(); }
      catch (error) {
        if (state.pending[0].tool_name === AUTHORIZE && error.code === 'FEEDBACK_GRANT_CONFLICT') {
          // Preserve the first staged grant; a rejected replacement must not
          // prevent the submit action explicitly recommended by the shared hook.
          state.pending.shift();
          if (exec.name === AUTHORIZE) throw error;
          continue;
        }
        // This private response was validated at dispatch. Discard a delayed expired grant
        // without blocking shutdown or refresh; only submission needs refresh guidance.
        if (state.pending[0].tool_name !== AUTHORIZE
          || !['FEEDBACK_GRANT_REFRESH_REQUIRED', 'FEEDBACK_INVALID_GRANT'].includes(error.code)) throw error;
        state.pending.shift();
        if (exec.name === SUBMIT) throw failure('FEEDBACK_GRANT_REFRESH_REQUIRED', 'Call report_issue again for the same prepared artifact. Nothing was uploaded.');
      }
    }
    return state;
  }

  async function consent(exec, phase, includeTranscript) {
    exec.signal.throwIfAborted();
    const outcome = await services.requestConsent(exec, phase, includeTranscript);
    exec.signal.throwIfAborted();
    // At submit the report is already prepared and stays so; only preparation can say nothing was prepared.
    const nothing = phase === 'prepare' ? 'Nothing was prepared or sent.' : 'Nothing was sent.';
    if (outcome !== 'allowed-once') throw failure('FEEDBACK_CONSENT_REQUIRED',
      outcome === 'policy-blocked' ? 'This chat’s approval policy disables prompts. Feedback requires explicit approval. Enable approval prompts for this chat before retrying. Nothing was sent.'
        : outcome === 'rejected' ? 'Feedback approval was not granted. Nothing was sent.'
        : outcome === 'cancelled' ? `Feedback approval was cancelled. ${nothing}`
          : `Native approval is unavailable. ${nothing}`);
  }

  async function run(exec, dispatch) {
    validate(exec);
    let effective;
    let snapshot;
    let secrets = [];
    try {
      if (exec.name === PREPARE) {
        await consent(exec, 'prepare', exec.arguments.includeTranscript);
        snapshot = await services.snapshot(exec);
        exec.signal.throwIfAborted();
        effective = await hook(event(exec, 'PreToolUse', undefined, { transcript_path: snapshot.path }));
      } else {
        const state = states.get(session(exec));
        if (exec.name === SUBMIT) await consent(exec, 'submit', state.metadata.transcriptIncluded);
        await flush(exec);
        effective = exec.name === SUBMIT ? await hook(event(exec, 'PreToolUse')) : exec.arguments;
      }
      secrets = [effective.feedbackClaim, effective.feedbackSession, effective.transcriptPath, effective.uploadUrl,
        ...Object.values(effective.requiredHeaders ?? {})];
      exec.signal.throwIfAborted();
      const raw = await dispatch(effective, exec);
      let safe = redact(raw, secrets);
      if (exec.name === AUTHORIZE) {
        const grant = extractUploadGrant(raw, { nowMs: now(), expectedSize: states.get(session(exec)).metadata.sizeBytes });
        // The upload destination and headers never enter Native/model projections or durable tool results.
        safe = { content: [{ type: 'text', text: JSON.stringify({ ok: true, status: 'authorized',
          message: 'Upload authorization received privately. Submit only the prepared artifactId.' }) }] };
        secrets.push(grant.uploadUrl, ...Object.values(grant.requiredHeaders));
      }
      if (exec.name !== SUBMIT) drafts.set(exec.token, { exec, raw, safe,
        ...(exec.name === PREPARE ? { metadata: extractPreparedMetadata(raw) } : {}) });
      return safe;
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : 'Native feedback failed.', secrets);
      throw failure(typeof error?.code === 'string' ? error.code : 'FEEDBACK_NATIVE_FAILED', message);
    } finally {
      try { await snapshot?.dispose(); }
      catch {
        // A host service's unexpected cleanup rejection cannot replace success or its primary error.
        console.warn('FEEDBACK_SNAPSHOT_CLEANUP_PENDING: The owned chat snapshot could not be removed.');
      }
    }
  }

  function commit(exec, outcome) {
    // SDK commits are synchronous; publication settles before a dependent call or graceful
    // shutdown. Abrupt-kill boundary: docs/local-agent-architecture.md#accepted-residuals.
    const draft = drafts.get(exec.token);
    drafts.delete(exec.token);
    if (!draft || outcome.isError || exec.signal.aborted || !isDeepStrictEqual(outcome.value, draft.safe)) return;
    const id = session(exec);
    if (exec.name === PREPARE) states.set(id, { metadata: draft.metadata, pending: [event(exec, 'PostToolUse', draft.raw)] });
    else states.get(id)?.pending.push(event(exec, 'PostToolUse', draft.raw));
  }
  async function settle() {
    const outcomes = await Promise.allSettled([...states.keys()].map(id => flush({ name: 'native-shutdown', agent: { session: { header: { id } } } })));
    if (outcomes.some(outcome => outcome.status === 'rejected')) throw failure('FEEDBACK_HANDOFF_FAILED', 'Some pending feedback handoff could not be persisted. The prepared archives are retained.');
  }
  return { hydrate, validate, run, commit, settle };
}
