import { feedbackDiagnostics, safeFeedbackProperty } from './feedback-diagnostics.mjs';
export { feedbackDiagnostics } from './feedback-diagnostics.mjs';

const PREPARATION_ERRORS = Object.freeze({
    FEEDBACK_INPUT_INVALID: Object.freeze({ message: 'The feedback report input is invalid.', stage: 'prepare', retryable: false, recommendedAction: 'RETRY_WITH_VALID_REPORT' }),
    FEEDBACK_HOOK_HANDOFF_UNAVAILABLE: Object.freeze({ message: 'The trusted e-Comet hook handoff is unavailable.', stage: 'handoff', retryable: false, recommendedAction: 'CHECK_FEEDBACK_HOOKS' }),
    FEEDBACK_CLAIM_INVALID: Object.freeze({ message: 'The trusted feedback handoff claim could not be verified.', stage: 'handoff', retryable: false, recommendedAction: 'RESTART_FEEDBACK_FLOW' }),
    TRANSCRIPT_UNAVAILABLE: Object.freeze({ message: 'The requested feedback transcript is unavailable.', stage: 'transcript', retryable: true, recommendedAction: 'RETRY_FEEDBACK_ONCE' }),
    FEEDBACK_ARCHIVE_FAILED: Object.freeze({ message: 'The feedback archive could not be created.', stage: 'archive', retryable: true, recommendedAction: 'RETRY_FEEDBACK_ONCE' }),
    FEEDBACK_STORAGE_UNAVAILABLE: Object.freeze({ message: 'The feedback archive could not be stored locally.', stage: 'storage', retryable: true, recommendedAction: 'CHECK_LOCAL_STORAGE' }),
    FEEDBACK_PREPARATION_FAILED: Object.freeze({ message: 'The feedback archive could not be prepared.', stage: 'prepare', retryable: true, recommendedAction: 'RETRY_FEEDBACK_ONCE' }),
});

const hasPreparationError = (code) => typeof code === 'string' && Object.hasOwn(PREPARATION_ERRORS, code);

export class FeedbackPreparationError extends Error {
    constructor(code, cause) {
        const definition = hasPreparationError(code) ? PREPARATION_ERRORS[code] : PREPARATION_ERRORS.FEEDBACK_PREPARATION_FAILED;
        super(definition.message, cause === undefined ? undefined : { cause });
        this.name = 'FeedbackPreparationError';
        this.code = hasPreparationError(code) ? code : 'FEEDBACK_PREPARATION_FAILED';
    }
}

export const feedbackPreparationFailure = (error) => {
    const candidate = safeFeedbackProperty(error, 'code');
    const code = hasPreparationError(candidate)
        ? candidate
        : 'FEEDBACK_PREPARATION_FAILED';
    const definition = PREPARATION_ERRORS[code];
    return {
        ok: false,
        status: 'failed',
        error: { code, ...definition, details: feedbackDiagnostics(error, ({ FEEDBACK_INPUT_INVALID: 'input_validation', FEEDBACK_CLAIM_INVALID: 'claim_verification', FEEDBACK_HOOK_HANDOFF_UNAVAILABLE: 'handoff_prepare', TRANSCRIPT_UNAVAILABLE: 'transcript_read', FEEDBACK_ARCHIVE_FAILED: 'archive_create', FEEDBACK_STORAGE_UNAVAILABLE: 'artifact_store' })[code] ?? 'prepare') },
    };
};

export const feedbackSubmissionFailure = (error, artifactId) => ({
    ok: false,
    status: 'uncertain',
    ...(typeof artifactId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(artifactId) ? { artifactId } : {}),
    // WHY: an unexpected escape does not establish whether delivery began or finished; automatic retry risks duplication.
    error: { code: 'FEEDBACK_SUBMISSION_FAILED', message: 'The feedback submission outcome could not be established.', stage: 'submit', retryable: false, details: feedbackDiagnostics(error, 'submit') },
});
