import { UUID_V4 } from '../../../../shared/values.mjs';
import { feedbackDiagnostics, safeFeedbackProperty } from '../../../../transport/failures/evidence.mjs';
const PREPARATION_FAILED = {
    message: 'The feedback archive could not be prepared.',
    stage: 'prepare',
    retryable: true,
    recommendedAction: 'RETRY_FEEDBACK_ONCE',
};
const PREPARATION_ERRORS = {
    FEEDBACK_INPUT_INVALID: {
        message: 'The feedback report input is invalid.',
        stage: 'prepare',
        retryable: false,
        recommendedAction: 'RETRY_WITH_VALID_REPORT',
    },
    FEEDBACK_HOOK_HANDOFF_UNAVAILABLE: {
        message: 'The trusted e-Comet hook handoff is unavailable.',
        stage: 'handoff',
        retryable: false,
        recommendedAction: 'CHECK_FEEDBACK_HOOKS',
    },
    FEEDBACK_CLAIM_INVALID: {
        message: 'The trusted feedback handoff claim could not be verified.',
        stage: 'handoff',
        retryable: false,
        recommendedAction: 'RESTART_FEEDBACK_FLOW',
    },
    TRANSCRIPT_UNAVAILABLE: {
        message: 'The requested feedback transcript is unavailable.',
        stage: 'transcript',
        retryable: true,
        recommendedAction: 'RETRY_FEEDBACK_ONCE',
    },
    FEEDBACK_ARCHIVE_FAILED: {
        message: 'The feedback archive could not be created.',
        stage: 'archive',
        retryable: true,
        recommendedAction: 'RETRY_FEEDBACK_ONCE',
    },
    FEEDBACK_STORAGE_UNAVAILABLE: {
        message: 'The feedback archive could not be stored locally.',
        stage: 'storage',
        retryable: true,
        recommendedAction: 'CHECK_LOCAL_STORAGE',
    },
    FEEDBACK_PREPARATION_FAILED: PREPARATION_FAILED,
};
const hasPreparationError = (code) => typeof code === 'string' && Object.hasOwn(PREPARATION_ERRORS, code);
export class FeedbackPreparationError extends Error {
    constructor(code, cause) {
        const definition = (hasPreparationError(code) ? PREPARATION_ERRORS[code] : undefined) ?? PREPARATION_FAILED;
        super(definition.message, cause === undefined ? undefined : { cause });
        this.name = 'FeedbackPreparationError';
        this.code = hasPreparationError(code) ? code : 'FEEDBACK_PREPARATION_FAILED';
    }
}
export const feedbackPreparationFailure = (error) => {
    const candidate = safeFeedbackProperty(error, 'code');
    const code = hasPreparationError(candidate) ? candidate : 'FEEDBACK_PREPARATION_FAILED';
    const definition = PREPARATION_ERRORS[code] ?? PREPARATION_FAILED;
    return {
        ok: false,
        status: 'failed',
        error: {
            code,
            ...definition,
            details: feedbackDiagnostics(error, {
                FEEDBACK_INPUT_INVALID: 'input_validation',
                FEEDBACK_CLAIM_INVALID: 'claim_verification',
                FEEDBACK_HOOK_HANDOFF_UNAVAILABLE: 'handoff_prepare',
                TRANSCRIPT_UNAVAILABLE: 'transcript_read',
                FEEDBACK_ARCHIVE_FAILED: 'archive_create',
                FEEDBACK_STORAGE_UNAVAILABLE: 'artifact_store',
            }[code] ?? 'prepare'),
        },
    };
};
export const feedbackSubmissionFailure = (error, artifactId) => ({
    ok: false,
    status: 'uncertain',
    ...(typeof artifactId === 'string' && new RegExp(`^${UUID_V4}$`).test(artifactId) ? { artifactId } : {}),
    // WHY: an unexpected escape does not establish whether delivery began or finished; automatic retry risks duplication.
    error: {
        code: 'FEEDBACK_SUBMISSION_FAILED',
        message: 'The feedback submission outcome could not be established.',
        stage: 'submit',
        retryable: false,
        details: feedbackDiagnostics(error, 'submit'),
    },
});
export class FeedbackUploadError extends Error {
    constructor(code, message, cause = undefined) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'FeedbackUploadError';
        this.code = code;
    }
}
