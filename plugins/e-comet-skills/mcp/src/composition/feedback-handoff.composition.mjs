import { validateSchemaValue } from '../shared/schema-validate.mjs';
import { createHandoffFlows } from '../support/feedback/application/handoff.mjs';
import { contract as prepareContract } from '../support/feedback/contract/prepare.contract.mjs';
import { extractPreparedMetadata, extractUploadGrant } from '../support/feedback/contract/results.mjs';
import { createFileFeedbackGrants } from '../support/feedback/out/grants/handoff.mjs';
// The feedback handoff steps over the file records of the plugin data `env` names: the native hooks and the DeepSeek
// adapter drive the same steps. Kept apart from the MCP use cases so a hook process loads only what it runs.
const RESULTS = {
    preparedMetadata: extractPreparedMetadata,
    uploadGrant: extractUploadGrant,
    isPrepareInput: (input) => validateSchemaValue(input, prepareContract.inputSchema),
};
export const feedbackHandoffFlows = ({ env }) => createHandoffFlows({ grants: createFileFeedbackGrants({ env }), results: RESULTS });
