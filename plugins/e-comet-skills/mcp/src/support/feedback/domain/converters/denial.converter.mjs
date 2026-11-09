import { isOneOf } from '../../../../shared/values.mjs';
import { ownedHandoffError as ownedErrors } from '../policies/handoff.policy.mjs';
import { FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES, feedbackDiagnostics, safeFeedbackProperty, } from '../../../../transport/failures/evidence.mjs';
// The reason a denied call carries: the closed code, message and evidence, then the recovery for that code.
export const denialReason = (error) => {
    const recovery = error.code === 'FEEDBACK_GRANT_REFRESH_REQUIRED'
        ? 'Call report_issue again for the same prepared artifact.'
        : error.code === 'FEEDBACK_ARTIFACT_MISMATCH'
            ? 'Nothing was sent and the existing authorization is kept. Use the artifactId from the prepared result associated with the existing authorization, preserving its consent and history choice. If that association is unclear, inspect the preparation and authorization results first; do not request another authorization or recreate the report to bypass the mismatch.'
            : error.code === 'FEEDBACK_GRANT_MISSING'
                ? 'This submit call was blocked before upload; the hook ran. No upload was attempted by this call. This does not establish the outcome of an earlier submit. Do not retry automatically with unchanged state. Check the observed call sequence: if report_issue has not been called for this prepared artifact and no earlier upload has an uncertain outcome, find remote e-Comet report_issue and call it once with the prepared kind and size_bytes, then submit the same artifactId, preserving the existing consent and history choice. If report_issue is unavailable, stop and report that the remote authorization tool is unavailable; check the remote e-Comet connector status and ask to connect only when it is observed disconnected. If report_issue was already called, inspect its result and handoff evidence instead of repeating it or guessing a cause.'
                : 'Do not retry automatically. Ask the user before starting a new feedback flow.';
    return `${error.code}: ${error.message} ${JSON.stringify(error.details)} ` + recovery;
};
// The closed cause each denial code reports in its hook diagnostic record.
export const FEEDBACK_DENIAL_CAUSES = {
    ...Object.fromEntries(['FEEDBACK_INVALID_INPUT', 'FEEDBACK_MODEL_TRANSPORT'].map((code) => [code, 'invalid_input'])),
    ...Object.fromEntries(['FEEDBACK_INVALID_EVENT', 'FEEDBACK_INVALID_SESSION', 'FEEDBACK_EVENT_TOO_LARGE'].map((code) => [code, 'invalid_event'])),
    ...Object.fromEntries([
        'FEEDBACK_INVALID_STATE',
        'FEEDBACK_INVALID_GRANT',
        'FEEDBACK_INVALID_PREPARED',
        'FEEDBACK_CLAIM_INVALID',
        'FEEDBACK_ARTIFACT_MISMATCH',
        'FEEDBACK_PREPARED_MISMATCH',
        'FEEDBACK_TOOL_MISMATCH',
        'FEEDBACK_GRANT_CONFLICT',
    ].map((code) => [code, 'invalid_state'])),
    ...Object.fromEntries(['FEEDBACK_GRANT_MISSING', 'FEEDBACK_PREPARED_MISSING'].map((code) => [code, 'missing'])),
    ...Object.fromEntries(['FEEDBACK_AMBIGUOUS_GRANT', 'FEEDBACK_AMBIGUOUS_PREPARED'].map((code) => [code, 'ambiguous'])),
    FEEDBACK_GRANT_REFRESH_REQUIRED: 'expired',
    FEEDBACK_DATA_DIR_UNAVAILABLE: 'storage_unavailable',
    FEEDBACK_STORAGE_ERROR: 'io_error',
    FEEDBACK_TRANSCRIPT_UNAVAILABLE: 'unsupported',
    FEEDBACK_INTERNAL_ERROR: 'internal_error',
};
export const handoffFailure = (error, operation) => {
    const details = feedbackDiagnostics(error, operation);
    const owned = ownedErrors(error);
    if (owned)
        return { ...owned, details };
    const filesystemBlocked = isOneOf(FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES, details.systemCode);
    if (filesystemBlocked)
        return { code: 'FEEDBACK_STORAGE_ERROR', message: 'A local feedback filesystem operation could not complete.', details };
    if (safeFeedbackProperty(error, 'code') === 'FEEDBACK_CLAIM_INVALID') {
        return { code: 'FEEDBACK_CLAIM_INVALID', message: 'The trusted feedback handoff claim could not be verified.', details };
    }
    return {
        code: 'FEEDBACK_INTERNAL_ERROR',
        message: 'The local feedback handoff failed internally.',
        details: { ...details, reason: 'internal_error' },
    };
};
// What a failed capture reports: the closed code, message and evidence.
export const failureText = (failure) => `${failure.code}: ${failure.message} ${JSON.stringify(failure.details)}`;
