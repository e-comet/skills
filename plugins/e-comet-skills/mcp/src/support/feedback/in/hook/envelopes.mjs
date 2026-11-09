import { readHookEvent } from '../../../../handoff/hook-io.mjs';
import { denialReason } from '../../domain/converters/denial.converter.mjs';
import { FeedbackHandoffError } from '../../domain/policies/handoff.policy.mjs';
import { MAX_MCP_MESSAGE_BYTES } from '../../../../transport/mcp/limits.mjs';
// PostToolUse can carry one maximum-size MCP request and response. Reserve another 256 KiB for the
// host's session/tool metadata and platform paths while keeping malformed stdin decisively bounded.
const MAX_HOOK_EVENT_BYTES = 2 * MAX_MCP_MESSAGE_BYTES + 256 * 1024;
/** One hook event from the host's stdin, bounded. */
export const readFeedbackHookEvent = (stream) => readHookEvent(stream, {
    maxBytes: MAX_HOOK_EVENT_BYTES,
    tooLarge: () => new FeedbackHandoffError('FEEDBACK_EVENT_TOO_LARGE', 'The desktop hook event is too large.'),
    invalid: () => new FeedbackHandoffError('FEEDBACK_INVALID_EVENT', 'The desktop hook event is invalid.'),
});
/** The PreToolUse answer that denies a call, with the failure's code, evidence and recovery as its reason. */
export const deniedPreToolUseOutput = (failure) => JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denialReason(failure),
    },
});
