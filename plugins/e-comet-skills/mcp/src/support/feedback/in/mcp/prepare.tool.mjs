import { validateArguments } from '../../../../mcp-protocol/registry/validate.mjs';
import { resourceLinkResult, textResult } from '../../../../mcp-protocol/results/serialize.mjs';
import { isRecord } from '../../../../shared/values.mjs';
import { contract } from '../../contract/prepare.contract.mjs';
import { FeedbackPreparationError, feedbackPreparationFailure } from '../../domain/converters/errors.converter.mjs';
import { withFeedbackOperation } from '../../../../transport/failures/evidence.mjs';
const failureResult = (error) => {
    const failure = feedbackPreparationFailure(error);
    console.error('[McpDispatcher] Feedback preparation failed:', JSON.stringify(failure.error));
    return textResult(failure, true);
};
// prepare_e_comet_feedback: `prepare` answers the preparation's outcome for the call's arguments.
export const createPrepareTool = ({ answer, prepare, }) => ({
    needsBridge: false,
    // Parse boundary: the call's arguments, checked against the contract first.
    run: async (id, args = {}) => {
        // The contract admits only an object.
        if (!validateArguments(contract.inputSchema, args).ok || !isRecord(args)) {
            answer(id, failureResult(new FeedbackPreparationError('FEEDBACK_INPUT_INVALID')));
            return;
        }
        let operation = 'prepare';
        try {
            const outcome = await prepare(args);
            if (outcome.kind !== 'prepared')
                throw outcome.error;
            const { prepared } = outcome;
            operation = 'prepare_result';
            const reportResource = prepared?.reportResource;
            if (!reportResource || reportResource.name !== 'report.md')
                throw new Error('missing report resource');
            // The report link carries no size; resource_link leaves the field out.
            answer(id, resourceLinkResult(prepared, JSON.stringify(prepared), [reportResource]));
        }
        catch (error) {
            answer(id, failureResult(operation === 'prepare_result' ? withFeedbackOperation(error, operation) : error));
        }
    },
});
