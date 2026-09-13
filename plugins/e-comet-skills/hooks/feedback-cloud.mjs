import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MAX_MCP_MESSAGE_BYTES, FEEDBACK_CLOUD_MAX_BYTES } from '../mcp/src/config.mjs';
import { prepareECometFeedback } from '../mcp/src/feedback-tools.mjs';
import { registerFeedbackArtifact, loadVerifiedFeedbackArtifact, retireFeedbackArtifact } from '../mcp/src/feedback-artifact-store.mjs';
import { feedbackPreparationFailure } from '../mcp/src/feedback-errors.mjs';
import { feedbackDiagnostics } from '../mcp/src/feedback-diagnostics.mjs';
import { FEEDBACK_HOST_ADAPTER_VERSION, FEEDBACK_CLOUD_TRANSPORT_VERSION, feedbackHostResultUnavailable, isValidFeedbackHostAdapterInput, isValidFeedbackCloudSubmitInput } from '../mcp/src/feedback-host-adapter.mjs';
import { FEEDBACK_MESSAGE_MAX_LENGTH, toolInputSchemas, toolOutputSchemas, validateSchemaValue } from '../mcp/src/tool-schemas.mjs';
import { claimUploadGrant, discardUploadGrant, stagePreparedArtifact, prepareInputWithTrustedTranscript, fitPrepareWireInput,
    cloudPostToolOutput as postOutput, FEEDBACK_ENVELOPE_RESERVE_BYTES } from './feedback-handoff.mjs';
import { CloudFeedbackStore, cloudPaths, canRetryUploadOutcome, TERMINAL_DEVICE_REFUSALS } from './feedback-cloud-state.mjs';

const PREFIX = 'mcp__remote-devices__plugin_e-comet-skills_e-comet-local__';
// claimUploadGrant returns exactly these six transport fields; artifactId stays the authored one.
const TRANSPORT_KEYS = ['uploadUrl', 'requiredHeaders', 'objectKey', 'expiresAt', 'expectedSize', 'expectedSha256'];
// An upload that ended releases the authorization it used; nothing else may reuse one.
const TERMINAL_UPLOAD_STATUSES = ['uploaded', 'rejected', 'uncertain'];
// report.md framing, metadata.json and the ZIP directory share the cloud archive with the fitted
// report, and a consented history tail takes what is left. The report is bounded by the archive the
// device has to carry, not only by the host wire: an oversized report is shortened, never refused.
const CLOUD_ARCHIVE_RESERVE_BYTES = 8192;
const CLOUD_PREPARE_LIMIT_BYTES = FEEDBACK_CLOUD_MAX_BYTES - CLOUD_ARCHIVE_RESERVE_BYTES;
// These fixed-width sizing placeholders never leave this process. The store
// generates the actual random marker after the report has been fitted.
const CLOUD_WIRE_FIELDS = { feedbackAdapter: {
    version: FEEDBACK_HOST_ADAPTER_VERSION, operationId: '0'.repeat(36), nonce: '0'.repeat(43),
} };
const invalid = () => Object.assign(new Error('The trusted cloud feedback operation could not be verified.'), { feedbackReason: 'invalid_state' });
const parseHostJson = value => {
    try { return JSON.parse(value); }
    catch (error) { throw Object.assign(invalid(), { cause: error }); }
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);
// JSON object member order is transport formatting, not part of the trusted value.
const equal = isDeepStrictEqual;
const blocksUpload = outcome => outcome && !canRetryUploadOutcome(outcome.result);
// The submit PreToolUse of this route reads the staged grant without consuming it, so a refusal that
// sent nothing leaves the session authorized: the same prepared artifact is simply submitted again.
// The service issues only a few authorizations per hour, and one more report_issue is the step only
// when the hook itself reports the grant expired or missing.
const GRANT_KEPT_STEP = 'Nothing was sent. The authorization is kept for this artifact: submit the same artifactId again, preserving the existing history choice, and request no new authorization.';
// A device plugin older than cloud device upload rejects the injected transport in its own input
// validation and answers with an unattributed grant refusal. Its catalog holds the version-skew
// guidance, but that never reaches this session, so the supported action is authored here. A missing
// artifactId infers that skew: accepted residual, see
// docs/local-agent-architecture.md#accepted-residuals.
// Neither terminal refusal can succeed under the same grant, so neither keeps one.
const OUTDATED_DEVICE_MESSAGE = 'The e-Comet plugin on this device is older than this cloud session and refused the prepared archive. Ask the user to update the e-Comet plugin on the device, and do not request another grant before that update. After updating the plugin on the device, submit the same artifactId again; a new authorization is needed only if this one has expired, and this hook says so when it has.';
const deviceRefusal = (response, artifactId) => {
    if (response.error?.code !== 'UPLOAD_GRANT_INVALID') return response.artifactId === undefined ? { ...response, artifactId } : response;
    if (response.artifactId === undefined) {
        return { ok: false, status: 'failed', artifactId, error: { code: 'UPLOAD_GRANT_INVALID',
            message: OUTDATED_DEVICE_MESSAGE, stage: 'grant', retryable: false, details: feedbackDiagnostics(undefined, 'input_validation') } };
    }
    // A current device that names the artifact refused a grant this session cannot reissue by itself — an
    // expired one after a slow bridge, say. Keep its own wording and add the step it cannot know about,
    // dropping that wording only if the device's message leaves no room for it.
    const appended = `${response.error.message} ${GRANT_KEPT_STEP}`;
    return { ...response, error: { ...response.error,
        message: appended.length <= FEEDBACK_MESSAGE_MAX_LENGTH ? appended : GRANT_KEPT_STEP } };
};
const hook = value => ({ exitCode: 0, stdout: json({ hookSpecificOutput: value }), stderr: '' });
const prepareRefusalOutput = eventName => {
    const result = feedbackPreparationFailure({ code: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' });
    result.error.message = 'The device did not complete the cloud preparation handoff. This call prepared no report; do not call report_issue. Check the device tool error and the e-Comet plugin versions in this cloud session and on the device. If they differ, update the older installation and start a new cloud task before preparing again with the same consent and history choice. A version mismatch is not established by this refusal alone.';
    // Failure has no structured tool response to replace. Its opaque error is not parsed or echoed;
    // only prepare is safe to explain here, because archive creation runs after the device handshake.
    return eventName === 'PostToolUseFailure'
        ? hook({ hookEventName: eventName, additionalContext: json(result) }) : postOutput(result);
};
const recoveryOutput = result => hook({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    'This repeat call was blocked. The saved host outcome below is read-only recovery; no new upload was started. Do not request another grant or send this artifact again. ' + json(result) });
const notStartedOutput = result => hook({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
    'This call did not start upload. ' + json(result) });
// A refusal after the claim is not just a failure to report: the session holds a prepared artifact and
// a grant this call did not spend. Each branch names the one step that restores the flow, because
// nothing left in the session says which it is.
const keptGrantMessage = cause => `${cause} Nothing was sent and this call did not start upload. The authorization is untouched and still staged for this artifact: submit the same artifactId again, preserving the existing history choice, and request no new authorization.`;
const UNDELIVERED_KEPT_MESSAGE = keptGrantMessage('The prepared archive never reached the device.');
const ARCHIVE_KEPT_MESSAGE = `${keptGrantMessage('The prepared feedback archive could not be read.')} If it still cannot be read, prepare the report again.`;
const safeFailure = (error, artifactId, status = 'uncertain', code = 'FEEDBACK_SUBMISSION_FAILED', authored = undefined) => ({
    ok: false, status, ...(artifactId ? { artifactId } : {}), error: { code,
        message: authored ?? (code === 'FEEDBACK_GRANT_MISSING'
            ? 'No upload grant is staged for this artifact. This call did not start upload. If report_issue has not been called for the prepared artifact, call it once with the prepared kind and size_bytes. If it already returned, inspect that result and handoff evidence before repeating it.'
            : code === 'FEEDBACK_GRANT_REFRESH_REQUIRED'
                ? 'The upload grant cannot cover the required start window. This call did not start upload. Call report_issue again for the same prepared artifact, preserving the existing history choice.'
                : status === 'not_started'
                    ? error?.code === 'FEEDBACK_ARTIFACT_MISMATCH'
                        ? 'The staged grant belongs to a different prepared artifact. This call did not start upload. Inspect the latest prepared result and authorization before continuing.'
                        : 'This call did not start upload. Inspect the handoff diagnostics and existing authorization before continuing.'
                    : 'The trusted cloud feedback operation could not complete. Inspect the saved same-artifact outcome before any further action.'),
        stage: status === 'not_started' ? 'handoff' : 'submit',
        retryable: false, details: feedbackDiagnostics(error, 'handoff_submit') },
});
const trustedField = (event, snake, camel, max = 512) => {
    const value = event[snake] ?? event[camel];
    if (event[snake] !== undefined && event[camel] !== undefined && !equal(event[snake], event[camel])) throw invalid();
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max) throw invalid();
    return value;
};
const hostValue = (event, snake, camel) => {
    if (event[snake] !== undefined && event[camel] !== undefined && !equal(event[snake], event[camel])) throw invalid();
    return event[snake] ?? event[camel];
};
const authoredInput = (target, value) => {
    const keys = target === 'prepare_e_comet_feedback' ? ['kind', 'summary', 'details', 'includeTranscript'] : ['artifactId'];
    if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || !validateSchemaValue(value, toolInputSchemas[target]))
        throw Object.assign(new Error('The feedback arguments are invalid.'), { feedbackReason: 'invalid_input' });
    const input = Object.fromEntries(keys.map(key => [key, value[key]]));
    return input;
};

// Verified host representations only, with one bounded serialized layer. Never
// recurse through arbitrary response properties or accept a tool_output alias.
// The device submit result is a reported failure as often as a success, so that
// caller allows an error envelope and validates the carried result itself.
export const normalizeCloudResponse = (response, { allowError = false } = {}) => {
    if (Buffer.byteLength(json(response) ?? '') > MAX_MCP_MESSAGE_BYTES) throw invalid();
    if (typeof response === 'string') response = parseHostJson(response);
    const candidates = [];
    let content;
    if (Array.isArray(response)) content = response;
    else if (record(response)) {
        if (response.isError !== undefined && response.isError !== false && !allowError) throw invalid();
        if (response.status === 'host_result_unavailable' || (allowError && typeof response.status === 'string')) candidates.push(response);
        else {
            for (const key of ['structuredContent', 'structured_content']) if (Object.hasOwn(response, key)) candidates.push(response[key]);
            if (response.content !== undefined && !Array.isArray(response.content)) throw invalid();
            content = response.content;
        }
    } else throw invalid();
    for (const item of content ?? []) {
        if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') throw invalid();
        candidates.push(parseHostJson(item.text));
    }
    if (!candidates.length || candidates.some(item => !equal(item, candidates[0]))) throw invalid();
    return candidates[0];
};

export const processCloudFeedbackEvent = async (event, options = {}) => {
    const now = options.cloud?.now ?? Date.now;
    const binding = { sessionId: trustedField(event, 'session_id', 'sessionId'),
        toolName: trustedField(event, 'tool_name', 'toolName'), callId: trustedField(event, 'tool_use_id', 'toolUseId') };
    const eventName = trustedField(event, 'hook_event_name', 'hookEventName');
    const target = binding.toolName.slice(PREFIX.length);
    if (!binding.toolName.startsWith(PREFIX) || !['prepare_e_comet_feedback', 'submit_e_comet_feedback'].includes(target)) throw invalid();
    const paths = cloudPaths(options.env ?? process.env);
    // Explicit artifactDirectory prevents canonical legacy/native-root fallback.
    const artifactOptions = { artifactDirectory: paths.artifacts, now };
    const retireArtifact = options.cloud?.retireArtifact ?? (value => retireFeedbackArtifact(value, artifactOptions));
    const store = new CloudFeedbackStore(paths, { now, ...options.cloud?.state });
    const input = hostValue(event, 'tool_input', 'toolInput');
    if (eventName === 'PreToolUse') {
        const authored = authoredInput(target, input);
        if (target === 'submit_e_comet_feedback') {
            const loadArtifact = transport => (options.cloud?.loadArtifact ?? (request => loadVerifiedFeedbackArtifact(request, artifactOptions)))(
                { artifactId: authored.artifactId, expectedSize: transport.expectedSize, expectedSha256: transport.expectedSha256 });
            const injectedInput = (transport, marker, artifact) => ({ ...authored,
                ...Object.fromEntries(TRANSPORT_KEYS.map(key => [key, transport[key]])),
                feedbackCloud: { version: FEEDBACK_CLOUD_TRANSPORT_VERSION, operationId: marker.operationId, nonce: marker.nonce,
                    transcriptIncluded: artifact.transcriptIncluded, archiveBase64: artifact.bytes.toString('base64') } });
            // Lookup comes before staging, claim/grant access, or any upload. It
            // works after archive, grant and completed operation cleanup.
            const outcome = await store.readArtifactOutcome(binding.sessionId, authored.artifactId);
            // A host that repeats PreToolUse for one tool_use_id is repeating this call, not starting a
            // second one: the started attempt is this call's own and no device answer exists yet.
            // Re-emit the identical staged input instead of denying the call or claiming another attempt.
            if (outcome?.status === 'started' && outcome.callId === binding.callId) {
                const pending = await store.readOperation(binding).catch(() => undefined);
                const staged = pending?.state === 'pending' && store.inputMatches(pending, authored) ? pending.input.transport : undefined;
                const artifact = staged && await loadArtifact(staged).catch(() => undefined);
                if (artifact) return hook({ hookEventName: 'PreToolUse', updatedInput: injectedInput(staged, pending.marker, artifact) });
            }
            if (blocksUpload(outcome)) {
                if (outcome.result.status === 'uploaded') await retireArtifact({ artifactId: authored.artifactId }).catch(() => undefined);
                return recoveryOutput(outcome.result);
            }
            // The sandbox egress proxy blocks storage, so the device performs the PUT: this process
            // claims the grant and delivers the verified archive inside the submit input it rewrites.
            let transport;
            try {
                // The exclusive attempt file below is this route's one-shot election, so the claim reads
                // the grant without consuming it: every refusal from here on sent nothing and keeps it.
                transport = await claimUploadGrant({ dataDirectory: paths.handoff, sessionId: binding.sessionId,
                    artifactId: authored.artifactId, targetTool: target, nowMs: now(), consume: false });
            } catch (error) {
                const code = ['FEEDBACK_GRANT_MISSING', 'FEEDBACK_GRANT_REFRESH_REQUIRED'].includes(error?.code) ? error.code : 'FEEDBACK_SUBMISSION_FAILED';
                return notStartedOutput(safeFailure(error, authored.artifactId, 'not_started', code));
            }
            const notStarted = (error, message) =>
                notStartedOutput(safeFailure(error, authored.artifactId, 'not_started', 'FEEDBACK_SUBMISSION_FAILED', message));
            let artifact;
            try {
                artifact = await loadArtifact(transport);
            } catch (error) {
                return notStarted(error, ARCHIVE_KEPT_MESSAGE);
            }
            let marker;
            try {
                marker = await store.stage(binding, { authored, transport: Object.fromEntries(TRANSPORT_KEYS.map(key => [key, transport[key]])) }, authored);
            } catch (error) {
                return notStarted(error, UNDELIVERED_KEPT_MESSAGE);
            }
            const updatedInput = injectedInput(transport, marker, artifact);
            if (Buffer.byteLength(json(updatedInput)) > MAX_MCP_MESSAGE_BYTES - FEEDBACK_ENVELOPE_RESERVE_BYTES || !isValidFeedbackCloudSubmitInput(updatedInput)) {
                return notStarted(undefined, UNDELIVERED_KEPT_MESSAGE);
            }
            // The intent is recorded before the input leaves this process: a lost device result is uncertain, never absent.
            try {
                await store.beginUploadAttempt(binding.sessionId, { artifactId: authored.artifactId, sizeBytes: transport.expectedSize,
                    sha256: transport.expectedSha256, transcriptIncluded: artifact.transcriptIncluded, callId: binding.callId });
            } catch (error) {
                // Nothing was injected, so this call sent nothing. Only another attempt recorded for the same
                // artifact — a concurrent submit — can still mean a request exists.
                const concurrent = await store.readArtifactOutcome(binding.sessionId, authored.artifactId).catch(() => undefined);
                if (blocksUpload(concurrent)) return recoveryOutput(concurrent.result);
                return notStarted(error, UNDELIVERED_KEPT_MESSAGE);
            }
            return hook({ hookEventName: 'PreToolUse', updatedInput });
        }
        const effective = fitPrepareWireInput(prepareInputWithTrustedTranscript({ ...event, tool_input: authored, toolInput: authored }),
            CLOUD_WIRE_FIELDS, { limitBytes: CLOUD_PREPARE_LIMIT_BYTES, measureRendered: true });
        const { transcriptPath, ...fitted } = effective;
        const marker = await store.stage(binding, { authored: fitted, ...(transcriptPath ? { transcriptPath } : {}) }, authored);
        return hook({ hookEventName: 'PreToolUse', updatedInput: { ...fitted, feedbackAdapter: marker } });
    }
    if (eventName !== 'PostToolUse' && !(eventName === 'PostToolUseFailure' && target === 'prepare_e_comet_feedback')) throw invalid();
    const op = await store.readOperation(binding);
    const marker = op.marker;
    const postInput = record(input) ? { ...input } : undefined;
    let normalized;
    let response;
    if (target === 'submit_e_comet_feedback') {
        if (!postInput) throw invalid();
        // Like prepare, accept either the rewritten input or the authored one a host may report instead.
        if (Object.hasOwn(postInput, 'feedbackCloud')) {
            if (!isValidFeedbackCloudSubmitInput(postInput)) throw invalid();
            const { feedbackCloud } = postInput;
            if (feedbackCloud.operationId !== marker.operationId || feedbackCloud.nonce !== marker.nonce) throw invalid();
            normalized = authoredInput(target, { artifactId: postInput.artifactId });
        } else normalized = authoredInput(target, postInput);
        if (!store.inputMatches(op, normalized)) throw invalid();
        response = normalizeCloudResponse(hostValue(event, 'tool_response', 'toolResponse'), { allowError: true });
        // A device refusal before any request may omit the artifactId; nothing else may.
        if (!validateSchemaValue(response, toolOutputSchemas.submit_e_comet_feedback)
            || response.status === 'host_result_unavailable' || response.status === 'not_started'
            || (response.artifactId === undefined ? response.status !== 'failed' : response.artifactId !== normalized.artifactId)) throw invalid();
    } else {
        if (postInput && Object.hasOwn(postInput, 'feedbackAdapter')) {
            if (!isValidFeedbackHostAdapterInput(target, postInput) || !equal(postInput.feedbackAdapter, marker)) throw invalid();
            delete postInput.feedbackAdapter;
        }
        normalized = authoredInput(target, postInput);
        if (!store.inputMatches(op, normalized)) throw invalid();
        if (eventName === 'PostToolUseFailure') return prepareRefusalOutput(eventName);
        response = normalizeCloudResponse(hostValue(event, 'tool_response', 'toolResponse'), { allowError: true });
        if (response.status === 'failed' && validateSchemaValue(response, toolOutputSchemas.prepare_e_comet_feedback)) return prepareRefusalOutput(eventName);
        if (!equal(response, feedbackHostResultUnavailable(target, marker))) throw invalid();
    }
    const claim = await store.claimOperation(binding);
    if (claim.result) return postOutput(claim.result);
    if (!claim.owned) return postOutput(target === 'prepare_e_comet_feedback'
        ? feedbackPreparationFailure(invalid()) : safeFailure(undefined, normalized.artifactId));
    let result;
    // The cloud hook prepares inside this process, so it is itself the trusted party: it never reads
    // the shared hook secret and issues no signature to verify against itself.
    const trusted = { verifySignature: () => true, now };
    const feedbackSession = createHash('sha256').update(binding.sessionId, 'utf8').digest('hex');
    try {
        if (target === 'prepare_e_comet_feedback') {
            const effective = { ...op.input.authored, ...(op.input.transcriptPath ? { transcriptPath: op.input.transcriptPath } : {}) };
            result = await prepareECometFeedback({ ...effective, feedbackSession }, {
                ...trusted, maxBytes: FEEDBACK_CLOUD_MAX_BYTES,
                getBridgeStatus: () => ({ nativeBridgeDiagnostics: 'unavailable_in_cloud_hook' }),
                registerArtifact: value => registerFeedbackArtifact(value, artifactOptions),
                ...(options.cloud?.readTranscript ? { readTranscript: options.cloud.readTranscript } : {}),
            });
            const { artifactId, kind, sizeBytes, sha256, transcriptIncluded } = result;
            await stagePreparedArtifact({ dataDirectory: paths.handoff, sessionId: binding.sessionId,
                metadata: { artifactId, kind, sizeBytes, sha256, transcriptIncluded }, nowMs: now() });
        } else {
            // The device performed (or refused) the PUT; this process only records what it reported.
            const recorded = await store.readArtifactOutcome(binding.sessionId, normalized.artifactId);
            if (recorded && blocksUpload(recorded) && recorded.terminal) result = recorded.result;
            else {
                const attempt = await store.attemptHandle(binding.sessionId, normalized.artifactId);
                if (!attempt || attempt.intent.callId !== binding.callId) throw invalid();
                if (response.status === 'failed') {
                    // Preserve the device's authoritative no-send receipt before ancillary cleanup.
                    // A retryable refusal keeps the untouched grant; terminal refusals block a repeat
                    // even if grant cleanup fails.
                    result = deviceRefusal(response, normalized.artifactId);
                    await store.recordUploadOutcome(attempt, result);
                    if (TERMINAL_DEVICE_REFUSALS.includes(response.error?.code)) {
                        await discardUploadGrant({ dataDirectory: paths.handoff, sessionId: binding.sessionId }).catch(() => undefined);
                    }
                } else {
                    await store.recordUploadOutcome(attempt, response);
                    if (response.status === 'uploaded') await retireArtifact({ artifactId: normalized.artifactId }).catch(() => undefined);
                    result = response;
                }
            }
        }
    } catch (error) {
        if (target === 'prepare_e_comet_feedback' && result?.status === 'prepared') {
            // Initial staging never exposed this archive to the model. Retire it
            // through canonical cleanup instead of leaving unreachable quota use.
            await retireArtifact({ artifactId: result.artifactId }).catch(() => undefined);
        }
        // If the authoritative attempt receipt cannot be published, future calls still cannot prove
        // no-send: accepted residual, see docs/local-agent-architecture.md#accepted-residuals.
        result = target === 'prepare_e_comet_feedback' ? feedbackPreparationFailure(error) : safeFailure(error, normalized.artifactId, 'uncertain');
        if (target === 'submit_e_comet_feedback') {
            try {
                const recorded = await store.readArtifactOutcome(binding.sessionId, normalized.artifactId);
                if (recorded) result = recorded.result;
            } catch { /* The saved outcome stays authoritative for later recovery. */ }
        }
    }
    // An upload that ended — accepted, refused by storage, or of unknown outcome — spends the
    // authorization it used: nothing may send this artifact again under it.
    if (target === 'submit_e_comet_feedback' && TERMINAL_UPLOAD_STATUSES.includes(result.status)) {
        await discardUploadGrant({ dataDirectory: paths.handoff, sessionId: binding.sessionId }).catch(() => undefined);
    }
    try { await store.finishOperation(binding, result); }
    catch {
        // Preparation publication and submit outcome selection have already completed. This operation
        // receipt is ancillary: its failure cannot change the selected outcome or erase device evidence.
        // The earlier path already retains uncertainty when the authoritative attempt write fails.
    }
    return postOutput(result);
};
