import { validateArguments } from '../../../../mcp-protocol/registry/validate.mjs';
import { textResult } from '../../../../mcp-protocol/results/serialize.mjs';
import { validateSchemaValue } from '../../../../shared/schema-validate.mjs';
import { isRecord } from '../../../../shared/values.mjs';
import { feedbackArtifactIdSchema, feedbackDiagnosticsSchema } from '../../contract/report.mjs';
import { contract } from '../../contract/submit.contract.mjs';
import { feedbackSubmissionFailure } from '../../domain/converters/errors.converter.mjs';
import { feedbackDiagnostics, safeFeedbackProperty } from '../../../../transport/failures/evidence.mjs';
// submit_e_comet_feedback: `submit` answers the submission's outcome for the call's arguments.
export const createSubmitTool = ({ answer, submit, }) => ({
    needsBridge: false,
    // Parse boundary: the call's arguments, checked against the contract first.
    run: async (id, args = {}) => {
        // The contract admits only an object.
        if (!validateArguments(contract.inputSchema, args).ok || !isRecord(args)) {
            // The authored artifactId is carried through when it is usable, so a caller can attribute the refusal.
            answer(id, textResult({
                ok: false,
                status: 'failed',
                ...(isRecord(args) && validateSchemaValue(args.artifactId, feedbackArtifactIdSchema)
                    ? { artifactId: args.artifactId }
                    : {}),
                error: {
                    code: 'UPLOAD_GRANT_INVALID',
                    message: 'The feedback upload grant is invalid or has expired.',
                    stage: 'grant',
                    retryable: false,
                    details: feedbackDiagnostics(undefined, 'input_validation'),
                },
            }, true));
            return;
        }
        try {
            const { result: submitted } = await submit(args);
            if (!submitted.ok) {
                const details = safeFeedbackProperty(safeFeedbackProperty(submitted, 'error'), 'details');
                if (validateSchemaValue(details, feedbackDiagnosticsSchema))
                    console.error('[McpDispatcher] Feedback submission failed:', JSON.stringify(details));
            }
            answer(id, textResult(submitted, !submitted.ok));
        }
        catch (error) {
            const failure = feedbackSubmissionFailure(error, args.artifactId);
            console.error('[McpDispatcher] Feedback submission failed:', JSON.stringify(failure.error));
            answer(id, textResult(failure, true));
        }
    },
});
