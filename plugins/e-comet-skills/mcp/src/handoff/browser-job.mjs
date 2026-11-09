import { extractTriggerUrl, responseShape } from './call-result.mjs';
import { denialEvidence, withHookDiagnostic } from './diagnostics.mjs';
import { validateTargetTool, LOCAL_TOOL_BY_BROWSER_JOB_TYPE } from './grants/policy.mjs';
import { HandoffError, preToolUseOutput, readHookEvent } from './hook-io.mjs';
import { isOneOf, isRecord } from '../shared/values.mjs';
import { feedbackDiagnostics } from '../transport/failures/evidence.mjs';
// The browser-job hook flow, moved as it is (spec §7.2): FE-1547 replaces it with a job-number fetch. The root wires the
// grant store: files for the hooks, memory for DeepSeek's tool runtime.
const MAX_HOOK_EVENT_BYTES = 1024 * 1024;
const REMOTE_BROWSER_JOB_TOOL = /^mcp__.+__browser_job$/;
const LOCAL_BROWSER_TOOL = /^mcp__(?:(?:remote-devices__)?plugin_e-comet-skills_)?e[-_]comet[-_]local__(?:wb_product_card|wb_search_by_query|wb_check_by_query|wb_filters_by_query|wb_recommendations_by_product|wb_seller_reviews|ozon_seller_promotion_report|ozon_seller_promotion_reports|ozon_seller_analytics_report|ozon_search_positions)$/;
const handoffRecovery = (code) => {
    // Refusals before claim consumption must not manufacture a second pending authorization.
    if (code === 'HANDOFF_COPY_REQUIRED')
        return 'Pass trigger_url from the same browser_job result, unchanged, as triggerUrl and retry the same local tool once; do not call browser_job again.';
    if (code === 'HANDOFF_MODEL_AUTHORIZATION')
        return 'Remove triggerUrl and trigger_url from the model-authored arguments and retry the same local tool. The hook must inject authorization; do not request a new browser_job for this argument correction.';
    if (code === 'HANDOFF_INVALID_INPUT')
        return 'Correct the local tool arguments and retry the same local tool; do not request another authorization just to repair arguments.';
    if (code === 'HANDOFF_DATA_DIR_UNAVAILABLE')
        return 'The host did not provide plugin storage. Check the installed plugin and host hook integration; requesting another browser_job cannot fix missing host storage.';
    if (code === 'HANDOFF_INVALID_SESSION' || code === 'HANDOFF_INVALID_EVENT' || code === 'HANDOFF_INVALID_TOOL')
        return 'The host hook context is invalid. Check the supported plugin/host integration and report this failure if it persists; do not obtain repeated authorizations.';
    if (['HANDOFF_MISSING', 'HANDOFF_EXPIRED', 'HANDOFF_TOOL_MISMATCH', 'HANDOFF_INVALID_ENTRY', 'HANDOFF_INVALID_TOKEN'].includes(code))
        return 'No usable matching authorization remains. Call browser_job once for the intended local tool, then retry without model-authored authorization fields.';
    return 'The local authorization handoff failed. Check the host integration and local storage access; if it persists, report the failure. Do not request repeated browser_job authorizations without resolving the observed problem.';
};
const handoffStorageRecovery = (details) => {
    if (isOneOf(['ENOSPC', 'EDQUOT'], details?.systemCode))
        return 'Local storage reports exhausted space or quota. Free space or resolve the quota before retrying; another browser_job will not fix this.';
    if (isOneOf(['EACCES', 'EPERM', 'EROFS'], details?.systemCode))
        return 'Local storage reports denied access or a read-only filesystem. Check access to plugin storage before retrying; another browser_job will not fix this.';
    return null;
};
const deniedPreToolUseOutput = (error) => JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${error.code}: e-Comet could not safely hand off the browser authorization. ${error.message} ` +
            (handoffStorageRecovery(error.details) ?? error.recovery ?? handoffRecovery(error.code)) +
            (error.details ? ` Diagnostics: ${JSON.stringify(error.details)}` : ''),
    },
});
// The closed cause each denial code reports in its hook diagnostic record.
const HANDOFF_CAUSES = {
    HANDOFF_MISSING: 'missing',
    HANDOFF_TOOL_MISMATCH: 'missing',
    HANDOFF_EXPIRED: 'expired',
    HANDOFF_DATA_DIR_UNAVAILABLE: 'storage_unavailable',
    HANDOFF_STORAGE_ERROR: 'io_error',
    HANDOFF_INVALID_INPUT: 'invalid_input',
    HANDOFF_MODEL_AUTHORIZATION: 'invalid_input',
    HANDOFF_COPY_REQUIRED: 'invalid_input',
    HANDOFF_INVALID_SESSION: 'invalid_event',
    HANDOFF_INVALID_EVENT: 'invalid_event',
    HANDOFF_INVALID_ENTRY: 'invalid_state',
    HANDOFF_INVALID_TOKEN: 'invalid_state',
    HANDOFF_INVALID_TOOL: 'unsupported',
    HANDOFF_AMBIGUOUS_TOKEN: 'ambiguous',
};
const safeHookError = (error, operation = 'handoff_authorize') => {
    if (error instanceof HandoffError)
        return error;
    const safe = new HandoffError('HANDOFF_STORAGE_ERROR', 'The local browser authorization handoff failed.');
    safe.details = feedbackDiagnostics(error, operation);
    return safe;
};
const browserJobTargetTool = (event) => {
    const toolInput = event.tool_input ?? event.toolInput;
    if (!isRecord(toolInput)) {
        throw new HandoffError('HANDOFF_INVALID_TOOL', 'The browser authorization target is invalid.');
    }
    const job = toolInput.job;
    if (!isRecord(job)) {
        throw new HandoffError('HANDOFF_INVALID_TOOL', 'The browser authorization target is invalid.');
    }
    return validateTargetTool(typeof job.type === 'string' ? LOCAL_TOOL_BY_BROWSER_JOB_TYPE[job.type] : undefined);
};
// The one-use claim of a signed local call: the waiting authorization for this session and tool, added to the call's
// input. A Cowork device call passes untouched (`undefined`). The hook renders a refusal as a denial; DeepSeek's tool
// runtime calls this step directly.
// `toolInput` is the host's or the model's argument object, checked here (parse boundary).
export const claimLocalAuthorization = async ({ store, sessionId, toolName, toolInput, nowMs, }) => {
    if (!isRecord(toolInput)) {
        throw new HandoffError('HANDOFF_INVALID_INPUT', 'The local browser-job arguments are invalid.');
    }
    const targetTool = toolName.slice(toolName.lastIndexOf('__') + 2);
    // WHY: since 2026-10-30 Cowork refuses a device call whose input a cloud hook changed, so there the model
    // copies trigger_url itself and the call passes untouched; the signed token, not its carrier, is the check.
    // Accepted residual "Cowork: the model carries the browser authorization".
    if (toolName.startsWith('mcp__remote-devices__')) {
        if (typeof toolInput.triggerUrl === 'string' && toolInput.triggerUrl)
            return undefined;
        throw new HandoffError('HANDOFF_COPY_REQUIRED', 'This host refuses a local call whose arguments a plugin hook changed, so the hook cannot add the authorization.');
    }
    if (Object.hasOwn(toolInput, 'triggerUrl') || Object.hasOwn(toolInput, 'trigger_url')) {
        throw new HandoffError('HANDOFF_MODEL_AUTHORIZATION', 'The browser authorization must be injected by the trusted host hook.');
    }
    const triggerUrl = await store.open().claim({
        sessionId,
        targetTool,
        nowMs,
    });
    return { ...toolInput, triggerUrl };
};
const processHookEventAuthoritative = async (event, { store, env = process.env, nowMs = Date.now() }, observed = {}) => {
    if (!event || typeof event !== 'object') {
        const error = new HandoffError('HANDOFF_INVALID_EVENT', 'The desktop hook event is invalid.');
        return { exitCode: 2, stdout: '', stderr: `${error.code}: ${error.message}` };
    }
    // An array names no event: nothing to do.
    if (!isRecord(event))
        return { exitCode: 0, stdout: '', stderr: '' };
    const eventName = event.hook_event_name || event.hookEventName;
    const toolName = event.tool_name ?? event.toolName;
    const sessionId = event.session_id ?? event.sessionId;
    if (eventName === 'PostToolUse' && typeof toolName === 'string' && REMOTE_BROWSER_JOB_TOOL.test(toolName)) {
        try {
            const toolResponse = event.tool_response ?? event.toolResponse;
            const triggerUrl = extractTriggerUrl(toolResponse);
            if (triggerUrl === null) {
                const error = new HandoffError('HANDOFF_TOKEN_NOT_FOUND', 'The browser authorization result did not contain a usable token.');
                error.details = { responseShape: responseShape(toolResponse).slice(0, 400) };
                throw error;
            }
            await store.open().stage({
                sessionId,
                triggerUrl,
                targetTool: browserJobTargetTool(event),
                nowMs,
            });
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        catch (error) {
            // In Claude's cloud sandbox a Cowork device call takes trigger_url from the model, so an error staging it here
            // must not stop the flow; a cloud session whose local tools claim it gets HANDOFF_MISSING there instead.
            if (env.CLAUDE_CODE_REMOTE === 'true') {
                observed.unstaged = true;
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            const safeError = safeHookError(error);
            return {
                exitCode: 2,
                stdout: '',
                stderr: `${safeError.code}: ${safeError.message}${safeError.details ? ` Diagnostics: ${JSON.stringify(safeError.details)}` : ''}`,
            };
        }
    }
    if (eventName === 'PreToolUse' && typeof toolName === 'string' && LOCAL_BROWSER_TOOL.test(toolName)) {
        try {
            const updatedInput = await claimLocalAuthorization({
                store,
                sessionId,
                toolName,
                toolInput: event.tool_input ?? event.toolInput,
                nowMs,
            });
            if (updatedInput === undefined)
                return { exitCode: 0, stdout: '', stderr: '' };
            return {
                exitCode: 0,
                stdout: preToolUseOutput(updatedInput),
                stderr: '',
            };
        }
        catch (error) {
            const safeError = safeHookError(error, 'claim_consume');
            observed.denial = safeError;
            return { exitCode: 0, stdout: deniedPreToolUseOutput(safeError), stderr: '' };
        }
    }
    return { exitCode: 0, stdout: '', stderr: '' };
};
export const runBrowserJobHook = async (event, options) => {
    const observed = {};
    const result = await processHookEventAuthoritative(event, options, observed);
    const eventName = isRecord(event) ? (event.hook_event_name ?? event.hookEventName) : undefined;
    const toolName = isRecord(event) ? (event.tool_name ?? event.toolName) : undefined;
    const isPost = eventName === 'PostToolUse' && typeof toolName === 'string' && REMOTE_BROWSER_JOB_TOOL.test(toolName);
    const isPre = eventName === 'PreToolUse' && typeof toolName === 'string' && LOCAL_BROWSER_TOOL.test(toolName);
    // A Cowork call that passes untouched, or a cloud token left unstaged, has nothing to record.
    if ((!isPost && !isPre) || result.exitCode !== 0 || (isPre && result.stdout === '') || observed.unstaged)
        return result;
    let decision;
    if (result.stdout) {
        try {
            const output = JSON.parse(result.stdout);
            decision = isRecord(output) && isRecord(output.hookSpecificOutput) ? output.hookSpecificOutput.permissionDecision : undefined;
        }
        catch {
            return result;
        }
    }
    return withHookDiagnostic(result, () => ({
        event: eventName,
        toolFamily: 'browser_job',
        handler: 'browser_job_handoff',
        stage: isPost ? 'handoff_staged' : decision === 'deny' ? 'call_denied' : 'input_rewritten',
        outcome: decision === 'deny' ? 'denied' : 'succeeded',
        observedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
        executionPlane: typeof toolName === 'string' && toolName.startsWith('mcp__remote-devices__') ? 'cloud' : 'native',
        ...(decision === 'deny' && observed.denial
            ? denialEvidence(HANDOFF_CAUSES[observed.denial.code], observed.denial.details?.systemCode, options.handlerVersion)
            : {}),
    }));
};
export const readBrowserJobEvent = (input) => readHookEvent(input, {
    maxBytes: MAX_HOOK_EVENT_BYTES,
    tooLarge: () => new HandoffError('HANDOFF_EVENT_TOO_LARGE', 'The desktop hook event is too large.'),
    invalid: () => new HandoffError('HANDOFF_INVALID_EVENT', 'The desktop hook event is invalid.'),
});
// The answer to an event that could not be read or handled at all.
export const failedEventResult = (error) => {
    const safeError = safeHookError(error);
    return {
        exitCode: 2,
        stdout: '',
        stderr: `${safeError.code}: ${safeError.message}${safeError.details ? ` Diagnostics: ${JSON.stringify(safeError.details)}` : ''}`,
    };
};
