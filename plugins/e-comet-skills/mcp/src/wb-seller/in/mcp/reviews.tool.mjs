import { missingHandoff } from '../../../handoff/call-result.mjs';
import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { deliverReportResult } from '../../../mcp-protocol/results/links.mjs';
import { resourceLinkResult, textResult, toolFailure } from '../../../mcp-protocol/results/serialize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { REQUEST_TIMEOUT_MS } from '../../../shared/timeouts.mjs';
import { fieldOf } from '../../../shared/values.mjs';
import { browserJobRejectionDetails } from '../../../transport/failures/rejection.mjs';
import { failureDetails } from '../../../transport/failures/vocabulary.mjs';
import { executeSellerReviewsJob } from '../../application/export-reviews.mjs';
import { contract } from '../../contract/reviews.contract.mjs';
// The authorization lease is built by this process; a wrong shape is an e-Comet defect, not the seller's.
const leaseInvalid = () => new ToolExecutionError('BROWSER_JOB_LEASE_INVALID', 'The local MCP received an invalid browser job authorization lease; this is an e-Comet defect. Offer to report it; do not repeat browser_job.', 'local', false);
// The one closed `details` a Seller tool failure carries.
const errorDetails = (error) => {
    const details = browserJobRejectionDetails(error) ?? failureDetails(error);
    return details ? { details } : {};
};
/**
 * wb_seller_reviews: authorize the trigger URL once the artifact root is usable, refuse a foreign job type before any
 * workbook exists, export every signed report through the seller operations bound to the lease, and answer the
 * workbooks as resource links; the lease's release restores the seller's organization, and its failure keeps the report.
 */
export const createReviewsTool = ({ answer, authorization, sellerOperations, artifacts, withDownloadedUpdate, reportOutputDirectory, }) => ({
    needsBridge: true,
    // Parse boundary: the call's arguments, checked against the contract first.
    run: async (id, args = {}) => {
        const toolName = 'wb_seller_reviews';
        const validation = validateArguments(contract.inputSchema, args);
        if (!validation.ok) {
            answer(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage(toolName, validation), 'arguments', false)), true));
            return;
        }
        const triggerUrl = fieldOf(args, 'triggerUrl');
        if (typeof triggerUrl !== 'string' || !triggerUrl) {
            answer(id, textResult(toolFailure(missingHandoff()), true));
            return;
        }
        let authorizationLease;
        let terminalResult;
        let sellerResult;
        let sellerArtifacts = [];
        // One byte counter per call: every writer of this export shares it (spec §4.2).
        const jobBudget = { bytes: 0 };
        try {
            artifacts.requireTarget();
            authorizationLease = await authorization.authorize(triggerUrl);
            const grant = authorizationLease?.authorization;
            const grantJobType = fieldOf(grant, 'jobType');
            if (!grant ||
                typeof fieldOf(grant, 'authorizationId') !== 'string' ||
                grantJobType !== 'seller_reviews' ||
                !fieldOf(grant, 'job') ||
                !authorizationLease) {
                if (grantJobType && grantJobType !== 'seller_reviews') {
                    throw new ToolExecutionError('BROWSER_JOB_TYPE_MISMATCH', `Signed ${grantJobType} job cannot be executed as ${toolName}.`, 'authorization', false);
                }
                throw leaseInvalid();
            }
            const lease = authorizationLease;
            sellerResult = await executeSellerReviewsJob({
                authorization: grant,
                // A create and a poll carry no timeout of their own: they get the request default, as the lease's own operation gave them.
                requestSellerOperation: (operation, handlers, timeout = REQUEST_TIMEOUT_MS) => sellerOperations.run(operation, handlers, timeout, lease),
                createArtifactWriter: artifacts.create,
                jobBudget,
            });
            sellerArtifacts = sellerResult.exports.flatMap((item) => item.status === 'complete' && 'artifact' in item ? [item.artifact] : []);
            const summary = `Seller review export ${sellerResult.status}: ${sellerArtifacts.length} of ${sellerResult.exports.length} XLSX artifact(s) available.`;
            terminalResult = resourceLinkResult(sellerResult, summary, sellerArtifacts, !sellerResult.ok);
        }
        catch (caught) {
            const error = await withDownloadedUpdate(caught);
            terminalResult = textResult({
                ...toolFailure(error, {
                    code: 'SELLER_REVIEWS_EXPORT_FAILED',
                    message: 'The authorized seller review export could not be completed.',
                    stage: 'execution',
                    retryable: false,
                }),
                ...errorDetails(error),
            }, true);
        }
        try {
            await authorizationLease?.release?.();
        }
        catch (error) {
            const failure = toolFailure(new ToolExecutionError('SELLER_AUTHORIZATION_RELEASE_FAILED', 'The seller organization could not be restored safely after the export.', 'extension', false, { cause: error }));
            // A restore failure must not erase the per-export report: the workbooks exist and only the
            // export list says which filters each one covers. Carry the failure alongside that report.
            if (sellerResult) {
                terminalResult = resourceLinkResult({ ...sellerResult, ok: false, releaseError: failure }, `Seller review export ${sellerResult.status}: ${sellerArtifacts.length} of ${sellerResult.exports.length} XLSX artifact(s) available, but seller cabinet restoration failed.`, sellerArtifacts, true);
            }
            else {
                terminalResult = textResult(failure, true);
            }
        }
        answer(id, await deliverReportResult(terminalResult, sellerArtifacts, reportOutputDirectory));
    },
});
