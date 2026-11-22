import { completeContractGuidance, coworkCopyStep, rejectionAndHandoffGuidance, sellerCabinetRecoveryGuidance, } from '../../transport/mcp/prose.mjs';
import { failureDetailsSchema, toolErrorSchema, triggerUrlProperty, withOperationDiagnostic, withRunningAnswer, } from '../../transport/mcp/results.mjs';
import { array, object, objectUnion, string } from '../../transport/mcp/schema.mjs';
export const SELLER_LIST_ORGS_FAILURE_REASONS = ['rate_limited', 'response_invalid'];
const results = {
    stage: { const: 'list_orgs' },
    organizations: array(object({ id: string, name: string }, ['id']), { minItems: 1, maxItems: 1000 }),
};
const complete = object({ ...results, ok: { const: true }, status: { const: 'complete' } });
const partial = object({ ...results, ok: { const: false }, status: { const: 'partial' }, releaseError: toolErrorSchema });
const failed = object({
    ...toolErrorSchema.properties,
    status: { const: 'failed' },
    stage: { const: 'list_orgs' },
    reason: { type: 'string', enum: [...SELLER_LIST_ORGS_FAILURE_REASONS] },
    details: failureDetailsSchema,
    releaseError: toolErrorSchema,
}, ['ok', 'status', 'stage', 'code', 'message', 'retryable']);
const preparationFailure = { ...toolErrorSchema, properties: { ...toolErrorSchema.properties, releaseError: toolErrorSchema } };
export const contract = {
    name: 'wb_seller_list_orgs',
    description: 'List available WB Seller companies and canonical IDs for reviews and comparisons. ' +
        'Unless its full contract is in this task, call describe_e_comet_tool({name:"wb_seller_list_orgs"}) and await it before browser_job. ' +
        'Then call browser_job once with job {type:"seller_list_orgs"} and, after it returns, this local tool exactly once. ' +
        'Omit triggerUrl and trigger_url. Native handoff injects it. ' +
        'Only mcp__remote-devices__: trigger_url unchanged as triggerUrl. Keep secret. ' +
        completeContractGuidance,
    inputSchema: object({ triggerUrl: triggerUrlProperty }),
    outputSchema: withRunningAnswer(withOperationDiagnostic(objectUnion(complete, partial, failed, preparationFailure))),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    workflow: {
        appliesTo: ['browser_job', 'wb_seller_list_orgs'],
        text: 'Read the current Wildberries Seller session’s company catalog. Call remote browser_job once with exactly job {type:"seller_list_orgs"}, then call wb_seller_list_orgs in a later step. ' +
            'Omit triggerUrl and trigger_url. Native Codex and Claude Code hooks and the DeepSeek adapter inject authorization. ' +
            coworkCopyStep +
            'Keep authorization secret. Show names where available and their canonical IDs. Use a seller’s explicit choice of ID in a separately signed reviews or comparison job. ' +
            'If releaseError accompanies organizations, show the companies and report that release of the read-only grant was unconfirmed. ' +
            sellerCabinetRecoveryGuidance +
            'For ENTITY_SELECTION_REQUIRED with details.reason="multiple_seller_documents", ask the seller to leave one Wildberries Seller tab in the connected profile and wait until it loads. ' +
            'For EXTENSION_UPDATE_REQUIRED, relay the connected extension update step. For other failed reads follow the returned message. ' +
            'For a missing tool, repeat host tool search up to three times. ' +
            'A running result refers to the original read. Obtain its terminal result with e_comet_run_result using runId. ' +
            'Never automatically repeat browser_job or the local call. ' +
            rejectionAndHandoffGuidance +
            'RUN_RESULT_UNAVAILABLE means the outcome is unknown: request the catalog again only if the user asks.',
    },
};
