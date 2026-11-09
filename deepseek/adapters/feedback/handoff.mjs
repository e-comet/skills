import { isDeepStrictEqual } from 'node:util';
import { scrubPrivateResult } from '../../../plugins/e-comet-skills/mcp/src/handoff/call-result.mjs';
import { validateSchemaValue } from '../../../plugins/e-comet-skills/mcp/src/shared/schema-validate.mjs';
import { isOneOf, isRecord } from '../../../plugins/e-comet-skills/mcp/src/shared/values.mjs';
import { contract as prepareContract } from '../../../plugins/e-comet-skills/mcp/src/support/feedback/contract/prepare.contract.mjs';
import { extractPreparedMetadata, extractUploadGrant } from '../../../plugins/e-comet-skills/mcp/src/support/feedback/contract/results.mjs';
import { contract as submitContract } from '../../../plugins/e-comet-skills/mcp/src/support/feedback/contract/submit.contract.mjs';
import { denialReason, failureText } from '../../../plugins/e-comet-skills/mcp/src/support/feedback/domain/converters/denial.converter.mjs';
import { feedbackDiagnostics, FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES } from '../../../plugins/e-comet-skills/mcp/src/transport/failures/evidence.mjs';
const PREPARE = 'mcp__e-comet-local__prepare_e_comet_feedback';
const AUTHORIZE = 'mcp__e-comet__report_issue';
const SUBMIT = 'mcp__e-comet-local__submit_e_comet_feedback';
export const NATIVE_FEEDBACK_TOOLS = new Set([PREPARE, AUTHORIZE, SUBMIT]);
const failure = (code, message) => Object.assign(new Error(message.startsWith(`${code}:`) ? message : `${code}: ${message}`), { code });
const hookFailure = (reason, fallback) => failure(/^FEEDBACK_[A-Z_]+:/.exec(reason ?? '')?.[0].slice(0, -1) ?? fallback, reason || 'The trusted feedback handoff failed.');
const session = (exec) => exec.agent.session.header.id;
const event = (exec, kind, response, extra = {}) => ({
    hook_event_name: kind,
    tool_name: exec.name,
    session_id: session(exec),
    tool_input: exec.arguments,
    ...(response === undefined ? {} : { tool_response: response }),
    ...extra,
});
const privateFields = new Set([
    'uploadUrl',
    'upload_url',
    'requiredHeaders',
    'required_headers',
    'feedbackClaim',
    'feedbackSession',
    'transcriptPath',
]);
const redact = (value, secrets) => scrubPrivateResult(value, secrets, privateFields, '[retained privately]');
/** Only the owning native adapter calls this after its execution-token attestation. */
/** `flows` is the feedback handoff in-port over this adapter's plugin data; the root binds it. */
export function createFeedbackHandoff({ services, flows, now = Date.now, }) {
    // Each session's prepared metadata and the committed events waiting for the next call.
    const states = new Map();
    const drafts = new Map();
    // validate() refused a call without this session's prepared state, and a state is never removed.
    const prepared = (exec) => {
        const state = states.get(session(exec));
        if (!state)
            throw failure('FEEDBACK_NOT_PREPARED', 'Prepare the report in this session before requesting upload authorization.');
        return state;
    };
    async function hydrate(exec) {
        const id = session(exec);
        if (exec.name === PREPARE || states.has(id) || !services?.prepared)
            return;
        const recovered = await services.prepared(exec);
        if (!recovered)
            return;
        let stored;
        try {
            const restored = await flows.restoreForSubmit({ sessionId: id, nowMs: now() });
            if (restored.kind === 'unreadable')
                throw restored.error;
            stored = restored.kind === 'restored' ? restored.metadata : undefined;
        }
        catch (error) {
            // Recovery runs before the tool body: expose only closed evidence in the host denial.
            const details = feedbackDiagnostics(error, 'artifact_read');
            const storage = FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES.includes(details.systemCode);
            throw failure(storage ? 'FEEDBACK_STORAGE_ERROR' : 'FEEDBACK_INTERNAL_ERROR', `${storage ? 'Local feedback storage could not be read.' : 'The retained feedback state could not be verified.'} ${JSON.stringify(details)}`);
        }
        states.set(id, {
            metadata: recovered.metadata,
            pending: isDeepStrictEqual(stored, recovered.metadata)
                ? []
                : [
                    {
                        hook_event_name: 'PostToolUse',
                        tool_name: PREPARE,
                        session_id: id,
                        tool_input: recovered.input,
                        tool_response: recovered.response,
                    },
                ],
        });
    }
    function validate(exec) {
        if (!services?.requestConsent || !services?.snapshot)
            throw failure('FEEDBACK_HOST_UNSUPPORTED', 'Native feedback consent and session history are unavailable.');
        const args = exec.arguments;
        if (exec.name === PREPARE) {
            if (!validateSchemaValue(args, prepareContract.inputSchema) ||
                !isRecord(args) ||
                Object.keys(args).some((key) => !['kind', 'summary', 'details', 'includeTranscript'].includes(key))) {
                throw failure('FEEDBACK_INVALID_INPUT', 'Use only the public feedback preparation arguments.');
            }
            return;
        }
        const state = states.get(session(exec));
        if (!state)
            throw failure('FEEDBACK_NOT_PREPARED', 'Prepare the report in this session before requesting upload authorization.');
        if (exec.name === AUTHORIZE) {
            if (!isRecord(args) ||
                Object.keys(args).sort().join(',') !== 'kind,size_bytes' ||
                args.kind !== state.metadata.kind ||
                args.size_bytes !== state.metadata.sizeBytes) {
                throw failure('FEEDBACK_PREPARED_MISMATCH', 'Use the exact kind and size_bytes from this session’s prepared artifact.');
            }
        }
        else if (!validateSchemaValue(args, submitContract.inputSchema) ||
            !isRecord(args) ||
            Object.keys(args).join(',') !== 'artifactId' ||
            args.artifactId !== state.metadata.artifactId) {
            throw failure('FEEDBACK_PREPARED_MISMATCH', 'Submit only the artifactId prepared in this session.');
        }
    }
    // One recorded step of the handoff: a call's trusted input, or a committed result recorded for the next call.
    async function hook(input) {
        const sessionId = input.session_id;
        const nowMs = now();
        if (input.hook_event_name !== 'PreToolUse') {
            // The hook's cloud-sandbox (Cowork) skip, which this adapter ran through the hook before the in-port.
            if (input.tool_name === AUTHORIZE && process.env.CLAUDE_CODE_REMOTE === 'true' && !(await flows.hasPrepared({ sessionId })))
                return undefined;
            const capture = input.tool_name === AUTHORIZE ? flows.captureReportIssue : flows.capturePrepared;
            const outcome = await capture({ sessionId, input: input.tool_input, response: input.tool_response, nowMs });
            if (outcome.kind !== 'captured')
                throw hookFailure(failureText(outcome.failure), 'FEEDBACK_HANDOFF_FAILED');
            return undefined;
        }
        const outcome = input.tool_name === PREPARE
            ? await flows.authorizePrepare({
                sessionId,
                input: input.tool_input,
                transcriptPaths: input.transcript_path === undefined ? [] : [input.transcript_path],
                nowMs,
            })
            : await flows.authorizeSubmit({ sessionId, input: input.tool_input, targetTool: 'submit_e_comet_feedback', nowMs });
        if (outcome.kind !== 'allowed')
            throw hookFailure(denialReason(outcome.failure), 'FEEDBACK_HANDOFF_DENIED');
        return outcome.input;
    }
    async function flush(exec) {
        const state = states.get(session(exec));
        // A correctable storage failure must retain the committed event for the next attempt.
        while (state?.pending.length) {
            const [next] = state.pending;
            try {
                if (next)
                    await hook(next);
                state.pending.shift();
            }
            catch (error) {
                const code = isRecord(error) ? error.code : undefined;
                if (state.pending[0]?.tool_name === AUTHORIZE && code === 'FEEDBACK_GRANT_CONFLICT') {
                    // Preserve the first staged grant; a rejected replacement must not
                    // prevent the submit action explicitly recommended by the shared hook.
                    state.pending.shift();
                    if (exec.name === AUTHORIZE)
                        throw error;
                    continue;
                }
                // This private response was validated at dispatch. Discard a delayed expired grant
                // without blocking shutdown or refresh; only submission needs refresh guidance.
                if (state.pending[0]?.tool_name !== AUTHORIZE ||
                    !isOneOf(['FEEDBACK_GRANT_REFRESH_REQUIRED', 'FEEDBACK_INVALID_GRANT'], code))
                    throw error;
                state.pending.shift();
                if (exec.name === SUBMIT)
                    throw failure('FEEDBACK_GRANT_REFRESH_REQUIRED', 'Call report_issue again for the same prepared artifact. Nothing was uploaded.');
            }
        }
        return state;
    }
    async function consent(exec, phase, includeTranscript) {
        exec.signal.throwIfAborted();
        // validate() refused a host without consent first.
        if (!services?.requestConsent)
            throw failure('FEEDBACK_HOST_UNSUPPORTED', 'Native feedback consent and session history are unavailable.');
        const outcome = await services.requestConsent(exec, phase, includeTranscript);
        exec.signal.throwIfAborted();
        // At submit the report is already prepared and stays so; only preparation can say nothing was prepared.
        const nothing = phase === 'prepare' ? 'Nothing was prepared or sent.' : 'Nothing was sent.';
        if (outcome !== 'allowed-once')
            throw failure('FEEDBACK_CONSENT_REQUIRED', outcome === 'policy-blocked'
                ? 'This chat’s approval policy disables prompts. Feedback requires explicit approval. Enable approval prompts for this chat before retrying. Nothing was sent.'
                : outcome === 'rejected'
                    ? 'Feedback approval was not granted. Nothing was sent.'
                    : outcome === 'cancelled'
                        ? `Feedback approval was cancelled. ${nothing}`
                        : `Native approval is unavailable. ${nothing}`);
    }
    async function run(exec, dispatch) {
        validate(exec);
        let effective;
        let snapshot;
        let secrets = [];
        try {
            if (exec.name === PREPARE) {
                // validate() accepted only an object of the public preparation arguments.
                await consent(exec, 'prepare', isRecord(exec.arguments) ? exec.arguments.includeTranscript : undefined);
                if (!services?.snapshot)
                    throw failure('FEEDBACK_HOST_UNSUPPORTED', 'Native feedback consent and session history are unavailable.');
                snapshot = await services.snapshot(exec);
                exec.signal.throwIfAborted();
                effective = await hook(event(exec, 'PreToolUse', undefined, { transcript_path: snapshot.path }));
            }
            else {
                if (exec.name === SUBMIT)
                    await consent(exec, 'submit', prepared(exec).metadata.transcriptIncluded);
                await flush(exec);
                effective = exec.name === SUBMIT ? await hook(event(exec, 'PreToolUse')) : exec.arguments;
            }
            // The effective input is the hook's object or the validated arguments.
            const fields = isRecord(effective) ? effective : {};
            const headers = fields.requiredHeaders;
            const headerValues = headers === undefined || headers === null ? [] : Object.values(headers);
            secrets = [fields.feedbackClaim, fields.feedbackSession, fields.transcriptPath, fields.uploadUrl, ...headerValues];
            exec.signal.throwIfAborted();
            const raw = await dispatch(effective, exec);
            let safe = redact(raw, secrets);
            if (exec.name === AUTHORIZE) {
                const grant = extractUploadGrant(raw, { nowMs: now(), expectedSize: prepared(exec).metadata.sizeBytes });
                // The upload destination and headers never enter Native/model projections or durable tool results.
                safe = {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                ok: true,
                                status: 'authorized',
                                message: 'Upload authorization received privately. Submit only the prepared artifactId.',
                            }),
                        },
                    ],
                };
                secrets.push(grant.uploadUrl, ...Object.values(grant.requiredHeaders));
            }
            if (exec.name !== SUBMIT)
                drafts.set(exec.token, { exec, raw, safe, ...(exec.name === PREPARE ? { metadata: extractPreparedMetadata(raw) } : {}) });
            return safe;
        }
        catch (error) {
            // A string comes back a string.
            const message = String(redact(error instanceof Error ? error.message : 'Native feedback failed.', secrets));
            const code = isRecord(error) ? error.code : undefined;
            throw failure(typeof code === 'string' ? code : 'FEEDBACK_NATIVE_FAILED', message);
        }
        finally {
            try {
                await snapshot?.dispose();
            }
            catch {
                // A host service's unexpected cleanup rejection cannot replace success or its primary error.
                console.warn('FEEDBACK_SNAPSHOT_CLEANUP_PENDING: The owned chat snapshot could not be removed.');
            }
        }
    }
    function commit(exec, outcome) {
        // SDK commits are synchronous; publication settles before a dependent call or graceful
        // shutdown. Abrupt-kill boundary: docs/architecture/residuals/feedback.md.
        const draft = drafts.get(exec.token);
        drafts.delete(exec.token);
        if (!draft || outcome.isError || exec.signal.aborted || !isDeepStrictEqual(outcome.value, draft.safe))
            return;
        const id = session(exec);
        // run() recorded the prepared metadata with every preparation draft.
        if (exec.name !== PREPARE)
            states.get(id)?.pending.push(event(exec, 'PostToolUse', draft.raw));
        else if (draft.metadata)
            states.set(id, { metadata: draft.metadata, pending: [event(exec, 'PostToolUse', draft.raw)] });
    }
    async function settle() {
        const outcomes = await Promise.allSettled([...states.keys()].map((id) => flush({ name: 'native-shutdown', agent: { session: { header: { id } } } })));
        if (outcomes.some((outcome) => outcome.status === 'rejected'))
            throw failure('FEEDBACK_HANDOFF_FAILED', 'Some pending feedback handoff could not be persisted. The prepared archives are retained.');
    }
    return { tools: NATIVE_FEEDBACK_TOOLS, hydrate, validate, run, commit, settle };
}
