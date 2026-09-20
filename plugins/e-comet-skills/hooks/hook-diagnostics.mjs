const EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const TOOL_FAMILIES = new Set(['browser_job', 'feedback_prepare', 'feedback_authorization', 'feedback_submit']);
const HANDLERS = new Set(['browser_job_handoff', 'feedback_handoff', 'feedback_cloud']);
const STAGES = new Set(['handoff_staged', 'input_rewritten', 'call_denied', 'result_observed', 'result_replaced']);
const OUTCOMES = new Set(['succeeded', 'denied', 'failed', 'uncertain']);
const EXECUTION_PLANES = new Set(['native', 'cloud', 'unknown']);
const CAUSES = new Set(['invalid_event', 'invalid_input', 'invalid_state', 'state_missing', 'storage_unavailable',
    'permission_denied', 'expired', 'missing', 'ambiguous', 'unsupported', 'io_error', 'internal_error', 'unknown']);
const SYSTEM_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOSPC', 'EDQUOT', 'EEXIST', 'EBUSY']);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

const requiredEnum = (value, allowed) => {
    if (typeof value !== 'string' || !allowed.has(value)) throw new TypeError('Unsupported hook diagnostic value.');
    return value;
};

const projectEvidence = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid hook diagnostic evidence.');
    const observedAt = value.observedAt;
    if (typeof observedAt !== 'string' || observedAt.length > 32 || new Date(observedAt).toISOString() !== observedAt)
        throw new TypeError('Invalid hook diagnostic timestamp.');
    const projected = {
        type: 'e_comet_hook_diagnostic', schemaVersion: 1,
        event: requiredEnum(value.event, EVENTS), toolFamily: requiredEnum(value.toolFamily, TOOL_FAMILIES),
        handler: requiredEnum(value.handler, HANDLERS), stage: requiredEnum(value.stage, STAGES),
        outcome: requiredEnum(value.outcome, OUTCOMES), observedAt,
        executionPlane: requiredEnum(value.executionPlane, EXECUTION_PLANES),
    };
    if (value.cause !== undefined) projected.cause = requiredEnum(value.cause, CAUSES);
    if (value.systemCode !== undefined) projected.systemCode = requiredEnum(value.systemCode, SYSTEM_CODES);
    if (value.handlerVersion !== undefined) {
        if (typeof value.handlerVersion !== 'string' || !VERSION.test(value.handlerVersion) || value.handlerVersion.length > 64)
            throw new TypeError('Invalid hook handler version.');
        projected.handlerVersion = value.handlerVersion;
    }
    return projected;
};

// This is presentation-only evidence. It neither stores a receipt nor changes the
// authoritative decision, rewrite, replacement, exit status, or stderr channel.
export const withHookDiagnostic = (authoritativeResult, evidence) => {
    try {
        if (!authoritativeResult || authoritativeResult.exitCode !== 0 || authoritativeResult.stderr !== '') return authoritativeResult;
        if (typeof evidence === 'function') evidence = evidence();
        const diagnostic = JSON.stringify(projectEvidence(evidence));
        let output;
        if (authoritativeResult.stdout === '') output = { hookSpecificOutput: { hookEventName: evidence.event } };
        else {
            output = JSON.parse(authoritativeResult.stdout);
            if (!output || typeof output !== 'object' || Array.isArray(output)
                || !output.hookSpecificOutput || typeof output.hookSpecificOutput !== 'object'
                || Array.isArray(output.hookSpecificOutput)) return authoritativeResult;
            output = { ...output, hookSpecificOutput: { ...output.hookSpecificOutput } };
        }
        const prior = output.hookSpecificOutput.additionalContext;
        if (prior !== undefined && typeof prior !== 'string') return authoritativeResult;
        output.hookSpecificOutput.additionalContext = prior === undefined ? diagnostic : `${prior}\n${diagnostic}`;
        return { ...authoritativeResult, stdout: JSON.stringify(output) };
    } catch {
        return authoritativeResult;
    }
};
