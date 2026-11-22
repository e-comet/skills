import { missingHandoff } from '../../../handoff/call-result.mjs';
import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { deliverReportResult } from '../../../mcp-protocol/results/links.mjs';
import { resourceLinkResult, textResult, toolFailure } from '../../../mcp-protocol/results/serialize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { fieldOf, isOneOf, isRecord } from '../../../shared/values.mjs';
import { COMPARISON_STAGES } from '../../../transport/extension/wire.mjs';
import { browserJobRejectionDetails } from '../../../transport/failures/rejection.mjs';
import { failureDetails } from '../../../transport/failures/vocabulary.mjs';
import { validateCardComparisonGrant } from '../../application/card-comparison-job-limits.mjs';
import { exportCardComparison } from '../../application/export-card-comparison.mjs';
import { contract } from '../../contract/card-comparison.contract.mjs';
import { unconfirmedSellerRelease, withSellerJobLease } from './signed-seller-job.mjs';
const comparisonReleaseFailure = (authorized, cause) => authorized
    ? toolFailure(new ToolExecutionError('SELLER_AUTHORIZATION_RELEASE_FAILED', 'The extension could not confirm safe restoration of the seller company. Check which company is active in the Wildberries seller cabinet.', 'extension', false, { cause }))
    : unconfirmedSellerRelease('the browser-job authorization', cause);
export const projectCardComparisonReceipt = (result, defaults) => {
    const value = fieldOf(result, 'structuredContent');
    if (!isRecord(value) || !isOneOf(COMPARISON_STAGES, defaults.stage) || (value.ok !== false && fieldOf(result, 'isError') !== true))
        return defaults;
    const hasWorkbook = isRecord(value.artifact);
    const unknownWrite = value.createOutcome === 'unknown' || value.orderOutcome === 'unknown';
    const outcome = hasWorkbook || value.fileStatus === 'SUCCESS'
        ? 'partial'
        : unknownWrite
            ? 'uncertain'
            : value.status === 'partial'
                ? 'partial'
                : 'failed';
    const independentFailure = fieldOf(value.releaseError, 'code') ?? (fieldOf(value.fileDelivery, 'status') === 'failed' ? 'REPORT_DELIVERY_FAILED' : undefined);
    return {
        ...defaults,
        outcome,
        retryDisposition: 'forbidden',
        ...(defaults.code === undefined && independentFailure ? { code: independentFailure } : {}),
    };
};
export const createCardComparisonTool = ({ answer, authorization, sellerOperations, requireArtifactTarget, createArchiveWriter, withDownloadedUpdate, reportOutputDirectory, shutdownSignal, }) => ({
    needsBridge: true,
    // Parse boundary: the call's arguments, checked against the comparison contract.
    run: async (id, args = {}) => {
        const validation = validateArguments(contract.inputSchema, args);
        if (!validation.ok) {
            const error = new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage(contract.name, validation), 'arguments');
            return answer(id, textResult(toolFailure(error), true));
        }
        const triggerUrl = fieldOf(args, 'triggerUrl');
        if (typeof triggerUrl !== 'string' || !triggerUrl)
            return answer(id, textResult(toolFailure(missingHandoff()), true));
        const { result, failure, releaseError } = await withSellerJobLease(authorization, triggerUrl, 'seller_card_comparison', validateCardComparisonGrant, (job, expiresAt, lease) => {
            requireArtifactTarget();
            return exportCardComparison({
                job,
                expiresAt,
                requestOperation: (operation, handlers, timeout) => sellerOperations.runComparison(operation, handlers, timeout, lease),
                createArchiveWriter,
                signal: shutdownSignal,
            });
        }, comparisonReleaseFailure);
        if (result) {
            const delivered = releaseError ? { ...result, ok: false, releaseError } : result;
            const artifacts = 'artifact' in result && result.artifact ? [result.artifact] : [];
            const linked = resourceLinkResult(delivered, 'Wildberries seller card comparison.', artifacts, !delivered.ok);
            return answer(id, await deliverReportResult(linked, artifacts, reportOutputDirectory));
        }
        const error = await withDownloadedUpdate(failure);
        const details = browserJobRejectionDetails(error) ?? failureDetails(error);
        return answer(id, textResult({ ...toolFailure(error), ...(details ? { details } : {}), ...(releaseError ? { releaseError } : {}) }, true));
    },
});
