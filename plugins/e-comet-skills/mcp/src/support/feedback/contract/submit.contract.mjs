import { feedbackArtifactIdSchema, feedbackClaim, feedbackErrorObject, feedbackMessage, feedbackSession, feedbackSha256, feedbackWorkflow, grantFeedbackField, hookOnlyFeedbackField, } from './report.mjs';
import { FEEDBACK_MAX_BYTES, FEEDBACK_REPORT_ID_MAX_LENGTH } from '../domain/constants/limits.const.mjs';
import { withOperationDiagnostic } from '../../../transport/mcp/results.mjs';
import { boolean, object, objectUnion } from '../../../transport/mcp/schema.mjs';
const feedbackSubmitSchema = object({
    artifactId: feedbackArtifactIdSchema,
    uploadUrl: grantFeedbackField({ type: 'string', minLength: 1, maxLength: 8192, description: 'Signed HTTPS upload URL.' }),
    requiredHeaders: grantFeedbackField({
        type: 'object',
        properties: {},
        additionalProperties: { type: 'string', maxLength: 8192 },
        description: 'Signed required request headers.',
    }),
    objectKey: grantFeedbackField({ type: 'string', minLength: 1, maxLength: 1024, description: 'Storage object key.' }),
    // Untyped: the hook injects Unix seconds, a Cowork model copies report_issue's ISO time; submit checks either.
    expiresAt: grantFeedbackField({ description: 'Upload grant expiry: Unix seconds, or report_issue expires_at as it came.' }),
    expectedSize: grantFeedbackField({
        type: 'integer',
        minimum: 1,
        maximum: FEEDBACK_MAX_BYTES,
        description: 'Expected archive size in bytes.',
    }),
    expectedSha256: grantFeedbackField({ ...feedbackSha256, description: 'Expected archive SHA-256.' }),
    feedbackClaim: hookOnlyFeedbackField({
        ...feedbackClaim,
        description: 'Local feedback handoff signature injected by the trusted host hook.',
    }),
    feedbackSession: hookOnlyFeedbackField({ ...feedbackSession, description: 'Bound host-session digest for the feedback claim.' }),
}, ['artifactId']);
const feedbackErrorSchema = objectUnion(feedbackErrorObject({
    code: { const: 'FEEDBACK_SUBMISSION_FAILED' },
    message: feedbackMessage,
    stage: { const: 'submit' },
    retryable: { const: false },
}, ['code', 'message', 'stage', 'retryable']), feedbackErrorObject({
    code: { const: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' },
    message: feedbackMessage,
    stage: { const: 'handoff' },
    retryable: { const: false },
}, ['code', 'message', 'stage', 'retryable']), feedbackErrorObject({ code: { const: 'ARTIFACT_UNAVAILABLE' }, message: feedbackMessage, stage: { const: 'artifact' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']), feedbackErrorObject({ code: { const: 'UPLOAD_GRANT_INVALID' }, message: feedbackMessage, stage: { const: 'grant' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']), feedbackErrorObject({ code: { const: 'UPLOAD_DESTINATION_REFUSED' }, message: feedbackMessage, stage: { const: 'grant' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']), feedbackErrorObject({ code: { const: 'UPLOAD_REJECTED' }, message: feedbackMessage, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']), feedbackErrorObject({ code: { const: 'UPLOAD_UNCERTAIN' }, message: feedbackMessage, stage: { const: 'upload' }, retryable: { const: false } }, ['code', 'message', 'stage', 'retryable']));
const feedbackSubmitSuccessSchema = object({
    ok: { const: true },
    status: { const: 'uploaded' },
    artifactId: feedbackArtifactIdSchema,
    transcriptIncluded: boolean,
    reportId: { type: 'string', minLength: 1, maxLength: FEEDBACK_REPORT_ID_MAX_LENGTH },
}, ['ok', 'status', 'artifactId', 'transcriptIncluded', 'reportId']);
const feedbackSubmitFailureSchema = object({
    ok: { const: false },
    status: { type: 'string', enum: ['failed', 'rejected', 'uncertain'] },
    artifactId: feedbackArtifactIdSchema,
    error: feedbackErrorSchema,
}, ['ok', 'status', 'error']);
export const contract = {
    name: 'submit_e_comet_feedback',
    description: 'Upload one prepared e-Comet feedback archive only after remote report_issue returns the trusted upload grant. Before the first feedback tool, call describe_e_comet_tool({name:"submit_e_comet_feedback"}) once and follow the returned complete contract; do not insert it between successful prepare, report_issue, and submit stages. ' +
        'Preserve the explicit report consent and resolved history choice and the order prepare_e_comet_feedback, report_issue, then submit_e_comet_feedback. ' +
        'Model-authored input must omit every hook-only transport, claim, and cloud field and alias; provide only artifactId, except for an mcp__remote-devices__ tool, which also gets the report_issue grant fields the contract names. ' +
        'Never automatically retry an uncertain upload or restart the flow; preserve explicit authorization.',
    inputSchema: feedbackSubmitSchema,
    outputSchema: withOperationDiagnostic(objectUnion(feedbackSubmitSuccessSchema, feedbackSubmitFailureSchema)),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    workflow: feedbackWorkflow,
};
