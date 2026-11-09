import { feedbackHandoffFlows } from './feedback-handoff.composition.mjs';
import { extractFeedbackToolCalls } from './tool-names.composition.mjs';
import { createFeedbackFlows } from '../support/feedback/application/flows.mjs';
import { feedbackSubmissionFailure } from '../support/feedback/domain/converters/errors.converter.mjs';
import { prepareThroughRoute, submitThroughRoute, verifyHookFields } from '../support/feedback/in/mcp/routes.mjs';
import { createFeedbackZip, feedbackZipFramingBytes } from '../support/feedback/out/artifacts/archive.mjs';
import { feedbackArtifactStorageUnavailable, loadVerifiedFeedbackArtifact, registerFeedbackArtifact, retireFeedbackArtifact, } from '../support/feedback/out/artifacts/store.mjs';
import { readTrustedFeedbackTranscript } from '../support/feedback/out/transcript/file.mjs';
import { putFeedbackArchive } from '../support/feedback/out/upload/http.mjs';
import { safeFeedbackProperty } from '../transport/failures/evidence.mjs';
// The feedback use cases bound to the adapters production uses. A caller's own dependency replaces one of them, as a
// test does; an omitted one falls back to the adapter.
const PREPARE_ADAPTERS = {
    registerArtifact: registerFeedbackArtifact,
    readTranscript: readTrustedFeedbackTranscript,
    createZip: createFeedbackZip,
    extractToolCalls: extractFeedbackToolCalls,
    archiveFramingBytes: feedbackZipFramingBytes,
    storageUnavailable: feedbackArtifactStorageUnavailable,
};
const SUBMIT_ADAPTERS = {
    loadArtifact: loadVerifiedFeedbackArtifact,
    retireArtifact: retireFeedbackArtifact,
    upload: putFeedbackArchive,
};
/** Every feedback use case behind the in-port, the handoff steps over the plugin data `env` names. */
export const feedbackFlows = ({ env }) => createFeedbackFlows({
    prepareAdapters: PREPARE_ADAPTERS,
    submitAdapters: SUBMIT_ADAPTERS,
    handoff: feedbackHandoffFlows({ env }),
});
// The MCP tools' preparation and submission as one call each, with today's result: the prepared report, or the error
// thrown; the submission's result. Tests and the oracle call these with their own dependencies, a signature check
// among them.
const flows = feedbackFlows({ env: process.env });
// Parse boundary: the caller's input and its own dependencies, as the tool hands them.
export const prepareECometFeedback = async (input, dependencies) => {
    const { verifySignature, clientName, ...context } = dependencies;
    const outcome = await prepareThroughRoute(flows, input, { clientName, ...context }, verifySignature === undefined ? verifyHookFields : verifySignature);
    if (outcome.kind !== 'prepared')
        throw outcome.error;
    return outcome.prepared;
};
// Parse boundary: the caller's input and its own dependencies, as the tool hands them.
export const submitECometFeedback = async (input = {}, dependencies = {}) => {
    const { verifySignature, ...rest } = dependencies;
    try {
        return (await submitThroughRoute(flows, input, rest, verifySignature === undefined ? verifyHookFields : verifySignature)).result;
    }
    catch (error) {
        return feedbackSubmissionFailure(error, safeFeedbackProperty(input, 'artifactId'));
    }
};
