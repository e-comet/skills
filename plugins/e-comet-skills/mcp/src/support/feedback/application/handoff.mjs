import { isRecord } from '../../../shared/values.mjs';
import { handoffFailure } from '../domain/converters/denial.converter.mjs';
import { FeedbackHandoffError, isFeedbackKind, fitPrepareWireInput, SUBMIT_TARGET_TOOL, validateRemoteInput, validateTranscriptPath, } from '../domain/policies/handoff.policy.mjs';
// The hook event names the transcript under one or both host spellings; the native adapter names its snapshot.
const trustedTranscriptPath = (candidates) => {
    if (candidates.length === 0)
        return undefined;
    if (candidates.length > 1 && candidates.some((value) => value !== candidates[0])) {
        throw new FeedbackHandoffError('FEEDBACK_TRANSCRIPT_UNAVAILABLE', 'The trusted feedback transcript is unavailable.');
    }
    // Codex may explicitly report that its transcript path is unavailable, and Claude Code gives an empty one for a call
    // it serves to a cloud session (Cowork since 2026-10-31).
    if (candidates[0] === null || candidates[0] === '')
        return undefined;
    return validateTranscriptPath(candidates[0]);
};
// Parse boundary: the preparation's model-authored arguments, checked here.
const prepareInputWithTrustedTranscript = ({ sessionId, toolInput, transcriptPaths }, { grants, results }) => {
    grants.validSession(sessionId);
    if (!isRecord(toolInput) || !isFeedbackKind(toolInput.kind) || typeof toolInput.includeTranscript !== 'boolean') {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback preparation arguments are invalid.');
    }
    if (Object.hasOwn(toolInput, 'transcriptPath') ||
        Object.hasOwn(toolInput, 'transcript_path') ||
        Object.hasOwn(toolInput, 'feedbackClaim') ||
        Object.hasOwn(toolInput, 'feedback_claim') ||
        Object.hasOwn(toolInput, 'feedbackSession') ||
        Object.hasOwn(toolInput, 'feedback_session')) {
        throw new FeedbackHandoffError('FEEDBACK_MODEL_TRANSPORT', 'Trusted feedback fields must not be supplied in model-authored input.');
    }
    const { summary, details } = toolInput;
    // The input schema requires both texts.
    if (!results.isPrepareInput(toolInput) || typeof summary !== 'string' || typeof details !== 'string') {
        throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback preparation arguments are invalid.');
    }
    const transcriptPath = trustedTranscriptPath(transcriptPaths);
    if (transcriptPath === undefined && toolInput.includeTranscript) {
        throw new FeedbackHandoffError('FEEDBACK_TRANSCRIPT_UNAVAILABLE', 'The trusted feedback transcript is unavailable.');
    }
    return { ...toolInput, summary, details, ...(transcriptPath === undefined ? {} : { transcriptPath }) };
};
/**
 * The handoff steps around the feedback tools, for a hook and for the native adapter: sign the preparation, record the
 * prepared artifact and report_issue's grant, claim that grant for the submit. Each answers a closed outcome; a refusal
 * carries the closed failure the caller renders. `grants` is the session's records and signer, `results` reads the
 * tools' results and the preparation input under their contracts.
 */
export const createHandoffFlows = ({ grants, results }) => ({
    authorizePrepare: async ({ sessionId, input, transcriptPaths }) => {
        try {
            // Bind the fitted input's transcript path, never a path that will be rewritten later.
            const effectiveInput = fitPrepareWireInput(prepareInputWithTrustedTranscript({ sessionId, toolInput: input, transcriptPaths }, { grants, results }));
            const sign = await grants.loadSigner();
            const feedbackSession = grants.sessionHash(sessionId);
            const fields = effectiveInput.transcriptPath === undefined ? {} : { transcriptPath: effectiveInput.transcriptPath };
            return {
                kind: 'allowed',
                input: {
                    ...effectiveInput,
                    feedbackClaim: sign({ tool: 'prepare_e_comet_feedback', sessionHash: feedbackSession, fields }),
                    feedbackSession,
                },
            };
        }
        catch (error) {
            return { kind: 'denied', failure: handoffFailure(error, 'handoff_prepare') };
        }
    },
    // Parse boundary: the preparation's model-authored arguments, checked here.
    capturePrepared: async ({ sessionId, input, response, nowMs }) => {
        try {
            grants.validSession(sessionId);
            if (!isRecord(input) || !isFeedbackKind(input.kind) || typeof input.includeTranscript !== 'boolean') {
                throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback preparation arguments are invalid.');
            }
            const metadata = results.preparedMetadata(response);
            if (metadata.kind !== input.kind || metadata.transcriptIncluded !== input.includeTranscript) {
                throw new FeedbackHandoffError('FEEDBACK_PREPARED_MISMATCH', 'The prepared feedback result does not match the requested report.');
            }
            await grants.stagePrepared({ sessionId, metadata, nowMs });
            return { kind: 'captured' };
        }
        catch (error) {
            return { kind: 'failed', failure: handoffFailure(error, 'handoff_prepare') };
        }
    },
    captureReportIssue: async ({ sessionId, input, response, nowMs }) => {
        try {
            grants.validSession(sessionId);
            const authored = validateRemoteInput(input);
            const grant = results.uploadGrant(response, {
                nowMs,
                expectedSize: authored.sizeBytes,
            });
            await grants.stageGrant({ sessionId, remoteInput: input, grant, nowMs });
            return { kind: 'captured' };
        }
        catch (error) {
            return { kind: 'failed', failure: handoffFailure(error, 'handoff_authorize') };
        }
    },
    // Parse boundary: the submission's model-authored arguments, checked here.
    authorizeSubmit: async ({ sessionId, input, targetTool, nowMs }) => {
        try {
            grants.validSession(sessionId);
            if (!isRecord(input)) {
                throw new FeedbackHandoffError('FEEDBACK_INVALID_INPUT', 'The feedback submission arguments are invalid.');
            }
            if (Object.keys(input).sort().join('\0') !== 'artifactId') {
                throw new FeedbackHandoffError('FEEDBACK_MODEL_TRANSPORT', 'Trusted feedback fields must not be supplied in model-authored input.');
            }
            // Load the signing secret before the one-shot claim: an unavailable secret must never cost
            // the user a fresh remote authorization.
            const sign = await grants.loadSigner();
            const transport = await grants.claimGrant({ sessionId, artifactId: input.artifactId, targetTool, nowMs });
            const effectiveInput = { ...input, ...transport };
            const feedbackSession = grants.sessionHash(sessionId);
            return {
                kind: 'allowed',
                input: {
                    ...effectiveInput,
                    feedbackClaim: sign({ tool: SUBMIT_TARGET_TOOL, sessionHash: feedbackSession, fields: effectiveInput }),
                    feedbackSession,
                },
            };
        }
        catch (error) {
            return { kind: 'denied', failure: handoffFailure(error, 'handoff_submit') };
        }
    },
    restoreForSubmit: async ({ sessionId, nowMs }) => {
        try {
            const metadata = await grants.readPrepared({ sessionId, nowMs });
            return metadata === undefined ? { kind: 'missing' } : { kind: 'restored', metadata };
        }
        catch (error) {
            return { kind: 'unreadable', error };
        }
    },
    hasPrepared: ({ sessionId }) => grants.hasPrepared(sessionId),
});
