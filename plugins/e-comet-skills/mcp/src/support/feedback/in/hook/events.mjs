import { denialEvidence, withHookDiagnostic } from '../../../../handoff/diagnostics.mjs';
import { eventNameOf, preToolUseOutput, toolInputOf, toolNameOf, toolResponseOf } from '../../../../handoff/hook-io.mjs';
import { isOneOf, isRecord } from '../../../../shared/values.mjs';
import { failureText, FEEDBACK_DENIAL_CAUSES } from '../../domain/converters/denial.converter.mjs';
import { FeedbackHandoffError } from '../../domain/policies/handoff.policy.mjs';
import { deniedPreToolUseOutput } from './envelopes.mjs';
const COWORK_UUID_NAMESPACE = '2da262fd-fd1f-4636-90cb-75b02fd1f1f1';
const LOCAL_FEEDBACK_TOOL = /^mcp__(?:(?:remote-devices__)?plugin_e-comet-skills_)?e[-_]comet[-_]local__(?:prepare_e_comet_feedback|submit_e_comet_feedback)$/;
const REMOTE_REPORT_ISSUE_TOOL = new RegExp(`^mcp__(?:e[-_]comet|e_comet_stage|(?:claude_ai_)?https_mcp_(?:stage_int_)?e[-_]comet_io_mcp|plugin_e-comet-skills_e-comet|remote-devices__plugin_e-comet-skills_e-comet|${COWORK_UUID_NAMESPACE})__report_issue$`);
// A hook in Claude's cloud sandbox (Cowork) cannot change the device calls, so the model copies the upload grant there
// and nothing is staged, unless a hook prepared the report in this session (a cloud session running the local tools).
const cloudSandbox = (env) => env?.CLAUDE_CODE_REMOTE === 'true';
const sessionIdOf = (event) => event.session_id ?? event.sessionId;
// A result the host marks as failed.
const failedResult = (event) => {
    const response = toolResponseOf(event);
    return isRecord(response) && response.isError === true;
};
// The hookSpecificOutput of an answer this module wrote; a stdout that is not JSON throws.
const hookSpecificOutputOf = (stdout) => {
    const parsed = JSON.parse(stdout);
    const output = isRecord(parsed) ? parsed.hookSpecificOutput : undefined;
    return isRecord(output) ? output : undefined;
};
const routeHookEvent = async (event, { flows, env: optionEnv, nowMs: optionNow }, observed) => {
    if (!isRecord(event)) {
        const error = new FeedbackHandoffError('FEEDBACK_INVALID_EVENT', 'The desktop hook event is invalid.');
        return { exitCode: 2, stdout: '', stderr: `${error.code}: ${error.message}` };
    }
    const eventName = eventNameOf(event);
    const toolName = toolNameOf(event);
    const nowOf = () => (optionNow === undefined ? Date.now() : optionNow);
    if (eventName === 'PostToolUse' && typeof toolName === 'string' && REMOTE_REPORT_ISSUE_TOOL.test(toolName)) {
        // A failed authorization already carries the only fact that matters here, and the service
        // issues very few of them per hour: replacing an exhausted-limit error with a handoff outcome
        // would hide why the report cannot be sent. Nothing is staged for a result that granted nothing.
        if (failedResult(event)) {
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (cloudSandbox(optionEnv ?? process.env) && !(await flows.hasPrepared({ sessionId: sessionIdOf(event) }))) {
            observed.skipped = true;
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        const outcome = await flows.captureReportIssue({
            sessionId: sessionIdOf(event),
            input: toolInputOf(event),
            response: toolResponseOf(event),
            nowMs: nowOf(),
        });
        return outcome.kind === 'captured'
            ? { exitCode: 0, stdout: '', stderr: '' }
            : { exitCode: 2, stdout: '', stderr: failureText(outcome.failure) };
    }
    if (eventName === 'PostToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__prepare_e_comet_feedback')) {
        // A failed tool already supplies its diagnostic. Blocking PostToolUse would replace it.
        if (failedResult(event)) {
            return { exitCode: 0, stdout: '', stderr: '' };
        }
        const outcome = await flows.capturePrepared({
            sessionId: sessionIdOf(event),
            input: toolInputOf(event),
            response: toolResponseOf(event),
            nowMs: nowOf(),
        });
        return outcome.kind === 'captured'
            ? { exitCode: 0, stdout: '', stderr: '' }
            : { exitCode: 2, stdout: '', stderr: failureText(outcome.failure) };
    }
    if (eventName === 'PreToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__prepare_e_comet_feedback')) {
        const outcome = await flows.authorizePrepare({
            sessionId: sessionIdOf(event),
            input: toolInputOf(event),
            transcriptPaths: [event.transcript_path, event.transcriptPath].filter((value) => value !== undefined),
            nowMs: nowOf(),
        });
        if (outcome.kind === 'allowed')
            return { exitCode: 0, stdout: preToolUseOutput(outcome.input), stderr: '' };
        observed.denial = outcome.failure;
        return { exitCode: 0, stdout: deniedPreToolUseOutput(outcome.failure), stderr: '' };
    }
    if (eventName === 'PreToolUse' &&
        typeof toolName === 'string' &&
        LOCAL_FEEDBACK_TOOL.test(toolName) &&
        toolName.endsWith('__submit_e_comet_feedback')) {
        const outcome = await flows.authorizeSubmit({
            sessionId: sessionIdOf(event),
            input: toolInputOf(event),
            targetTool: toolName.slice(toolName.lastIndexOf('__') + 2),
            nowMs: nowOf(),
        });
        if (outcome.kind === 'allowed')
            return { exitCode: 0, stdout: preToolUseOutput(outcome.input), stderr: '' };
        observed.denial = outcome.failure;
        return { exitCode: 0, stdout: deniedPreToolUseOutput(outcome.failure), stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
};
const feedbackDiagnosticOutcome = (result) => {
    try {
        if (hookSpecificOutputOf(result.stdout)?.permissionDecision === 'deny')
            return 'denied';
    }
    catch {
        /* Empty successful native Post output is expected. */
    }
    return 'succeeded';
};
/**
 * One host hook event of the feedback chain, answered as the host reads it: the prepare and submit calls rewritten or
 * denied, the prepared result and report_issue's grant recorded, each with its hook diagnostic. `env` and `nowMs` are
 * the caller's, unset meaning the process's own.
 */
export const handleFeedbackHookEvent = async (event, { flows, env, nowMs, handlerVersion, }) => {
    const observed = {};
    const result = await routeHookEvent(event, { flows, env, nowMs }, observed);
    if (!isRecord(event))
        return result;
    const eventName = eventNameOf(event);
    const toolName = toolNameOf(event);
    // RegExp.test reads a name that is not a string as its text, as it always did.
    const toolText = String(toolName);
    const target = typeof toolName === 'string' ? toolName.slice(toolName.lastIndexOf('__') + 2) : '';
    const family = target === 'prepare_e_comet_feedback'
        ? 'feedback_prepare'
        : target === 'submit_e_comet_feedback'
            ? 'feedback_submit'
            : REMOTE_REPORT_ISSUE_TOOL.test(toolText)
                ? 'feedback_authorization'
                : undefined;
    const routedLocal = LOCAL_FEEDBACK_TOOL.test(toolText);
    const routedRemote = eventName === 'PostToolUse' && REMOTE_REPORT_ISSUE_TOOL.test(toolText);
    if (!family ||
        result.exitCode !== 0 ||
        (!routedRemote && !routedLocal) ||
        observed.skipped ||
        !isOneOf(['PreToolUse', 'PostToolUse'], eventName))
        return result;
    if (eventName === 'PostToolUse' && family === 'feedback_prepare' && failedResult(event))
        return result;
    if (eventName === 'PostToolUse' && family === 'feedback_authorization' && failedResult(event))
        return result;
    let decision;
    if (result.stdout) {
        try {
            decision = hookSpecificOutputOf(result.stdout)?.permissionDecision;
        }
        catch {
            return result;
        }
    }
    if (eventName === 'PreToolUse' && decision !== 'deny') {
        try {
            if (hookSpecificOutputOf(result.stdout)?.updatedInput === undefined)
                return result;
        }
        catch {
            return result;
        }
    }
    return withHookDiagnostic(result, () => ({
        event: eventName,
        toolFamily: family,
        handler: 'feedback_handoff',
        stage: eventName === 'PreToolUse'
            ? decision === 'deny'
                ? 'call_denied'
                : 'input_rewritten'
            : family === 'feedback_authorization'
                ? 'handoff_staged'
                : 'result_observed',
        outcome: feedbackDiagnosticOutcome(result),
        observedAt: new Date(nowMs ?? Date.now()).toISOString(),
        executionPlane: 'native',
        ...(decision === 'deny' && observed.denial
            ? denialEvidence(FEEDBACK_DENIAL_CAUSES[observed.denial.code] ?? observed.denial.details?.reason, observed.denial.details?.systemCode, handlerVersion)
            : {}),
    }));
};
