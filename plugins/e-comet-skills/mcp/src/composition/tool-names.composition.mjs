import { TOOL_CONTRACTS } from '../catalog.mjs';
import { REMOTE_E_COMET_TOOL_NAMES } from '../support/feedback/contract/tool-calls.mjs';
import { toolOutcomeProjector } from '../support/feedback/domain/converters/tool-outcome.converter.mjs';
import { createToolCallExtractor } from '../support/feedback/out/transcript/tool-calls.mjs';
// The tool-names port: the catalog is the one list of the local tools this server publishes, so a tool added there is read
// for its closed outcome fields without touching the feedback code; the remote names are the feedback contract's.
const TOOL_NAMES = { local: new Set(TOOL_CONTRACTS.map((tool) => tool.name)), remote: REMOTE_E_COMET_TOOL_NAMES };
export const extractFeedbackToolCalls = createToolCallExtractor(TOOL_NAMES);
export const projectFeedbackToolOutcome = toolOutcomeProjector(TOOL_NAMES);
