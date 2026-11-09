import { prepareOutcome } from './prepare.mjs';
import { submitFeedback, submitOutcome } from './submit.mjs';
/**
 * Every feedback use case behind the in-port: the MCP preparation and submission over their adapters, and the handoff
 * steps the hooks and the native adapter drive.
 */
export const createFeedbackFlows = ({ prepareAdapters, submitAdapters, handoff, }) => ({
    ...handoff,
    prepare: (input, route, context) => prepareOutcome(input, context, prepareAdapters, route),
    submit: async (input, signed, dependencies = {}) => submitOutcome(await submitFeedback(input, dependencies, submitAdapters, signed)),
});
