#!/usr/bin/env node
import { feedbackHandoffFlows } from '../mcp/src/composition/feedback-handoff.composition.mjs';
import { moduleNameOf } from '../mcp/src/composition/module-names.composition.mjs';
import { handlerVersionReader } from '../mcp/src/handoff/diagnostics.mjs';
import { isHookEntry, writeHookResult } from '../mcp/src/handoff/hook-io.mjs';
import { handoffFailure } from '../mcp/src/support/feedback/domain/converters/denial.converter.mjs';
import { readFeedbackHookEvent } from '../mcp/src/support/feedback/in/hook/envelopes.mjs';
import { handleFeedbackHookEvent } from '../mcp/src/support/feedback/in/hook/events.mjs';
import { useModuleNames } from '../mcp/src/transport/failures/evidence.mjs';
useModuleNames(moduleNameOf);
const handlerVersion = handlerVersionReader(new URL('../.codex-plugin/plugin.json', import.meta.url));
// The hook's whole flow over the file records of the host's plugin data.
// Parse boundary: the host's hook event, which the adapter reads field by field.
export const processHookEvent = async (event, options = {}) => handleFeedbackHookEvent(event, {
    flows: feedbackHandoffFlows({ env: options.env === undefined ? process.env : options.env }),
    env: options.env,
    nowMs: options.nowMs,
    handlerVersion,
});
const main = async () => {
    let result;
    try {
        result = await processHookEvent(await readFeedbackHookEvent(process.stdin));
    }
    catch (error) {
        const safeError = handoffFailure(error);
        result = { exitCode: 2, stdout: '', stderr: `${safeError.code}: ${safeError.message}` };
    }
    writeHookResult(result);
};
if (isHookEntry(import.meta.url))
    await main();
