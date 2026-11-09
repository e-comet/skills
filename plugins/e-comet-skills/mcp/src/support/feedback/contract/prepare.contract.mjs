import { feedbackArtifactIdSchema, feedbackClaim, feedbackErrorObject, feedbackMessage, feedbackSession, feedbackSha256, feedbackWorkflow, hookOnlyFeedbackField, } from './report.mjs';
import { FEEDBACK_KINDS } from '../domain/constants/limits.const.mjs';
import { withOperationDiagnostic } from '../../../transport/mcp/results.mjs';
import { boolean, object, objectUnion, positiveInteger } from '../../../transport/mcp/schema.mjs';
// Preserve authored report text: the STDIO message limit and trusted prepare hook enforce
// MAX_MCP_MESSAGE_BYTES before rendering. The archive budget also includes the transcript;
// it is not a replacement per-field allowance for model-authored summary/details.
const feedbackPrepareSchema = object({
    kind: { type: 'string', enum: FEEDBACK_KINDS },
    summary: { type: 'string', minLength: 1 },
    details: { type: 'string', minLength: 1 },
    includeTranscript: boolean,
    transcriptPath: hookOnlyFeedbackField({
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        description: 'Trusted local transcript path.',
    }),
    feedbackClaim: hookOnlyFeedbackField({
        ...feedbackClaim,
        description: 'Local feedback handoff signature injected by the trusted host hook.',
    }),
    feedbackSession: hookOnlyFeedbackField({ ...feedbackSession, description: 'Bound host-session digest for the feedback claim.' }),
}, ['kind', 'summary', 'details', 'includeTranscript']);
const feedbackPreparationErrorSchema = objectUnion(feedbackErrorObject({
    code: { const: 'FEEDBACK_INPUT_INVALID' },
    message: feedbackMessage,
    stage: { const: 'prepare' },
    retryable: { const: false },
    recommendedAction: { const: 'RETRY_WITH_VALID_REPORT' },
}, ['code', 'message', 'stage', 'retryable', 'recommendedAction']), feedbackErrorObject({
    code: { const: 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE' },
    message: feedbackMessage,
    stage: { const: 'handoff' },
    retryable: { const: false },
    recommendedAction: { const: 'CHECK_FEEDBACK_HOOKS' },
}, ['code', 'message', 'stage', 'retryable', 'recommendedAction']), feedbackErrorObject({
    code: { const: 'FEEDBACK_CLAIM_INVALID' },
    message: feedbackMessage,
    stage: { const: 'handoff' },
    retryable: { const: false },
    recommendedAction: { const: 'RESTART_FEEDBACK_FLOW' },
}, ['code', 'message', 'stage', 'retryable', 'recommendedAction']), feedbackErrorObject({
    code: { const: 'TRANSCRIPT_UNAVAILABLE' },
    message: feedbackMessage,
    stage: { const: 'transcript' },
    retryable: { const: true },
    recommendedAction: { const: 'RETRY_FEEDBACK_ONCE' },
}, ['code', 'message', 'stage', 'retryable', 'recommendedAction']), feedbackErrorObject({
    code: { const: 'FEEDBACK_ARCHIVE_FAILED' },
    message: feedbackMessage,
    stage: { const: 'archive' },
    retryable: { const: true },
    recommendedAction: { const: 'RETRY_FEEDBACK_ONCE' },
}, ['code', 'message', 'stage', 'retryable', 'recommendedAction']), feedbackErrorObject({
    code: { const: 'FEEDBACK_STORAGE_UNAVAILABLE' },
    message: feedbackMessage,
    stage: { const: 'storage' },
    retryable: { const: true },
    recommendedAction: { const: 'CHECK_LOCAL_STORAGE' },
}, ['code', 'message', 'stage', 'retryable', 'recommendedAction']), feedbackErrorObject({
    code: { const: 'FEEDBACK_PREPARATION_FAILED' },
    message: feedbackMessage,
    stage: { const: 'prepare' },
    retryable: { const: true },
    recommendedAction: { const: 'RETRY_FEEDBACK_ONCE' },
}, ['code', 'message', 'stage', 'retryable', 'recommendedAction']));
const feedbackPrepareSuccessSchema = object({
    ok: { const: true },
    status: { const: 'prepared' },
    artifactId: feedbackArtifactIdSchema,
    kind: { type: 'string', enum: FEEDBACK_KINDS },
    sizeBytes: positiveInteger,
    sha256: feedbackSha256,
    transcriptIncluded: boolean,
    summary: { type: 'string', minLength: 1, maxLength: 512 },
}, ['ok', 'status', 'artifactId', 'kind', 'sizeBytes', 'sha256', 'transcriptIncluded', 'summary']);
const feedbackPrepareFailureSchema = object({ ok: { const: false }, status: { const: 'failed' }, error: feedbackPreparationErrorSchema }, [
    'ok',
    'status',
    'error',
]);
export const contract = {
    name: 'prepare_e_comet_feedback',
    description: 'Prepare one local e-Comet feedback archive after the user explicitly agrees to report an e-Comet problem. Before this call, call describe_e_comet_tool({name:"prepare_e_comet_feedback"}) once and follow the returned complete contract. ' +
        'Preserve the explicit report consent and resolved history choice. Use the three-stage order prepare_e_comet_feedback, report_issue, then submit_e_comet_feedback without inserting prose or discovery between successful stages. ' +
        'Model-authored input must omit every hook-only field and alias; provide only kind, summary, details, and the resolved includeTranscript choice. ' +
        'Never automatically retry an uncertain upload.',
    inputSchema: feedbackPrepareSchema,
    outputSchema: withOperationDiagnostic(objectUnion(feedbackPrepareSuccessSchema, feedbackPrepareFailureSchema)),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    workflow: feedbackWorkflow,
};
