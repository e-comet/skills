import { UUID_V4 } from '../../../shared/values.mjs';
import { FEEDBACK_MESSAGE_MAX_LENGTH } from '../domain/constants/limits.const.mjs';
import { FEEDBACK_DIAGNOSTIC_ERROR_TYPES, FEEDBACK_DIAGNOSTIC_MODULES, FEEDBACK_DIAGNOSTIC_OPERATIONS, FEEDBACK_DIAGNOSTIC_REASONS, FEEDBACK_DIAGNOSTIC_SYSTEM_CODES, } from '../../../transport/failures/evidence.mjs';
import { object } from '../../../transport/mcp/schema.mjs';
// What both feedback tools' contracts share: the complete workflow contract, the archive and grant fields, the
// closed diagnostics of a failure and the published report id.
export const feedbackArtifactIdSchema = { type: 'string', pattern: `^${UUID_V4}$` };
export const feedbackSha256 = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const feedbackClaim = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
export const feedbackSession = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const hookOnlyFeedbackField = (description) => ({
    ...description,
    description: `${description.description} Injected by the trusted Claude or Codex host hook immediately before this local tool call; ` +
        'model-authored arguments must omit it and every snake_case alias.',
});
// The upload grant: in Cowork no hook can change the device call, so the model copies it from report_issue there.
export const grantFeedbackField = (description) => ({
    ...description,
    description: `${description.description} Injected by the trusted Claude Code or Codex host hook immediately before this local tool call, and ` +
        'model-authored arguments omit it, except for an mcp__remote-devices__ tool, which copies it from report_issue and the prepared result.',
});
export const feedbackMessage = { type: 'string', minLength: 1, maxLength: FEEDBACK_MESSAGE_MAX_LENGTH };
export const feedbackDiagnosticsSchema = object({
    operation: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_OPERATIONS },
    errorType: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_ERROR_TYPES },
    systemCode: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_SYSTEM_CODES },
    reason: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_REASONS },
    httpStatus: { type: 'integer', minimum: 100, maximum: 599 },
    source: object({
        module: { type: 'string', enum: FEEDBACK_DIAGNOSTIC_MODULES },
        line: { type: 'integer', minimum: 1, maximum: 9999999 },
        column: { type: 'integer', minimum: 1, maximum: 9999999 },
    }, ['module', 'line', 'column']),
}, ['operation']);
export const feedbackErrorObject = (properties, required) => object({ ...properties, details: feedbackDiagnosticsSchema }, required);
// Accepted residual "Opting out of history still sends the connection rows": docs/architecture/residuals/feedback.md.
export const feedbackToolContract = String.raw `# Send feedback to e-Comet

Use the remote \`report_issue\` tool together with the local \`prepare_e_comet_feedback\` and \`submit_e_comet_feedback\` tools. This is an externally mutating workflow: preserve the user's consent and resolved history choice through every recovery step.

Before preparation, ensure remote e-Comet \`report_issue\` is available in the current session. If it is deferred, perform one targeted tool search for \`report_issue\`; do not treat the two local tools as a complete sending capability. If it is unavailable, stop before preparation and explain that sending requires the remote e-Comet connector. Check connector status through the host when possible; ask the user to connect or sign in only when it is observed disconnected. Tool absence alone does not prove disconnection. Preserve the issue and chosen history option.

## Resolve the report and history choice

Require enough existing facts to identify what went wrong and explicit user agreement to report it. Ask only for what is missing. If the issue is absent or too vague to identify, ask one short plain-language question about what happened.

Preserve any explicit history include or exclude instruction and do not ask again about that choice. If the issue is identifiable but report consent is missing and no explicit history preference is known, ask naturally in one prompt whether to send the report and whether the user wants the default bounded current-session history excluded. With an explicit history preference, ask only for missing report consent.

Before preparation, even when report consent already exists, if no explicit history preference is known and the history interaction has not occurred, explain the default and ask whether the user wants the bounded current-session history excluded, then wait and call no feedback tools. Warn at most once that this history is attached by default, includes more than the visible chat and also the e-Comet extension's log, and may contain system context, tool calls and results, code, paths, and sensitive data; say that the user may explicitly opt out. Do not repeat the warning when clarifying consent.

Do not describe report contents, diagnostics, environment metadata, version, platform, architecture, size, or file formats. Do not present a formal bullet list, checklist, or three-option menu unless requested. Cancellation is accepted but need not be offered as a menu option.

After explicit report consent and the history disclosure and question, clear ordinary continuation defaults to \`includeTranscript:true\`. Use \`includeTranscript:false\` only when the user explicitly opts out. Silence is not consent and calls no feedback tools. If report consent or the history preference is ambiguous, ask one short clarification, do not repeat the warning, and call no feedback tools until resolved. For example, “Yes, send it; maybe leave the history out” leaves the history preference unresolved; default inclusion must not override it. The history interaction is complete only after an explicit include or exclude choice, or clear continuation after the disclosure and question with no unresolved preference.

If the user declines or cancels, do not call \`prepare_e_comet_feedback\`, \`report_issue\`, or \`submit_e_comet_feedback\`. When the issue and explicit report consent are known, the history interaction is complete, and \`report_issue\` is available, the first subsequent action must be \`prepare_e_comet_feedback\`; emit no acknowledgement, restatement, recap, diagnostic call, or other prose before it.

In Claude with \`mcp__remote-devices__...\` local tool names (Cowork), the host gives plugins no session history and no hook can change these calls. There, skip the history disclosure and question, say once that the report goes without the chat history, and prepare with \`includeTranscript:false\`. After \`report_issue\`, call \`submit_e_comet_feedback\` with \`artifactId\` and these fields copied unchanged: \`uploadUrl\` from \`upload_url\`, \`requiredHeaders\` from \`required_headers\`, \`objectKey\` from \`object_key\`, \`expiresAt\` from \`expires_at\`, \`expectedSize\` from \`prepared.sizeBytes\`, and \`expectedSha256\` from \`prepared.sha256\`.

## Author and send

Build \`summary\` and \`details\` only from evidence already in the conversation and observed e-Comet results. When known, cover the affected operation or tool, observed result, expected result, reproduction context, and recovery attempted; preserve the exact safe error code and message. Exclude credentials, personal or commercial data, source code, file paths, and unrelated user content, even from tool results. Generalize relevant context to the minimum needed. Omit unknown facts and never invent a cause. Ask one question only when there is no minimally identifiable issue; do not ask merely to fill optional fields. When a diagnosis ran, put the e_comet_diagnose results that decided the cause (its code and owner, the checks that failed and those that passed) into \`details\`, and each guided step the user performed with the user's answer.

Add an \`Available remote e-Comet tools\` subsection to \`details\` before the chain starts. List deduplicated full names from the agent-visible remote inventory, separate from tools called in the session, and label the source \`agent-visible inventory\`. Mark completeness \`reported complete\` only when the host exposes its full catalog, including deferred tools; otherwise use \`partial\`. Enumerate metadata only: never call a business or authorization tool to discover names. If no inventory is available, write \`Inventory unavailable\` and continue. Never fabricate a name, availability, or completeness.

Use exactly one kind: \`bug\`, \`wrong_data\`, \`missing_capability\`, or \`unclear_contract\`, and pass it unchanged to \`report_issue\`. Never author hook-only fields or aliases, including \`transcriptPath\`, \`transcript_path\`, \`feedbackClaim\`, \`feedback_claim\`, \`feedbackSession\`, or \`feedback_session\`.

The required order is \`prepare_e_comet_feedback\`, remote \`report_issue\`, then \`submit_e_comet_feedback\`. After preparation, immediately call \`report_issue\` exactly once with \`{kind: prepared.kind, size_bytes: prepared.sizeBytes}\`, then immediately call \`submit_e_comet_feedback\` with \`{artifactId: prepared.artifactId}\` only, or in Cowork with the copied grant fields above. In Codex, run all three calls sequentially and await each result; direct MCP and \`functions.exec\` are both allowed, but dependent stages must not run in parallel. Do not insert prose, \`local_bridge_status\`, repeated discovery, a resource read, or diagnostics between successful stages. A \`report.md\` link is temporary and must not be reread in this flow.

Feedback is independent of bridge role, extension readiness, \`browser_job\`, and marketplace tabs.

## Authorization and recovery

Call \`report_issue\` at most once per prepared artifact. Call it again only when a submit result or hook denial explicitly states that authorization expired or a fresh one is required: \`FEEDBACK_GRANT_REFRESH_REQUIRED\`, or a message naming \`report_issue\` as the next step. Retry the same artifact only when the current hook result explicitly confirms no upload request started, authorization was kept, and another submit is the next step. In Cowork, a submit result \`FEEDBACK_HOOK_HANDOFF_UNAVAILABLE\` means the grant fields were not passed and nothing was sent: submit the same \`artifactId\` once more with them copied from the same \`report_issue\` result. There, \`UPLOAD_GRANT_INVALID\` with stage \`grant\` means a copied field was missing or malformed, or the grant expired, and nothing was sent: copy the fields once more from the same \`report_issue\` result and submit once; if it repeats, stop and tell the user the report was not sent, without calling \`report_issue\` again. \`UPLOAD_DESTINATION_REFUSED\` means the grant does not lead to e-Comet storage and nothing was sent; it is terminal: report the safe error and stop without retrying submit or obtaining another authorization. Never automatically retry a rejected, uncertain, or terminally refused upload.

The service allows five authorizations per hour. On a \`report_issue\` rate-limit error, the prepared report stays valid for 24 hours: say «Лимит отправки отчётов исчерпан, попробуйте позже.», do not prepare or send it again, and do not retry \`report_issue\` automatically.

\`FEEDBACK_GRANT_MISSING\` is a denial by a running hook, not evidence that hooks are disabled or untrusted, and this submit was blocked before upload. If no earlier upload was attempted, say «Отчёт не отправлен: не получено разрешение на загрузку.» If \`report_issue\` was skipped, no earlier upload is uncertain, and consent remains valid, obtain its grant once and continue with the same prepared artifact and history choice; do not repeat consent or recreate the archive. If \`report_issue\` already ran, inspect its result and handoff evidence; missing grant state alone does not authorize repeating it.

\`FEEDBACK_TRANSCRIPT_UNAVAILABLE\` on preparation means this host gives plugins no session history: nothing was prepared or sent. Ask the user once whether to prepare the report without history; never retry with history.

Explain failures only from the fixed safe message and supplied closed \`error.details.operation\`, \`reason\`, \`systemCode\`, and \`httpStatus\`. An optional source module and line are public-code investigation context, not a user path or proven cause. Unknown internal errors remain unknown. A trusted-hook denial does not authorize changing consent, history choice, or hook trust.
After preparation failure, explain the observed error, what it does not establish, and one action from \`recommendedAction\`. \`CHECK_FEEDBACK_HOOKS\` means inspect available host/plugin configuration and evidence; suggest enabling or trusting a hook only when that missing prerequisite is observed. \`RESTART_FEEDBACK_FLOW\` means explain only the supplied handoff evidence and ask the user to start a fresh flow; it does not itself prove invalidity or expiry. \`RETRY_WITH_VALID_REPORT\` corrects only identified invalid fields and preserves history choice. \`RETRY_FEEDBACK_ONCE\` offers one retry, never a loop. \`CHECK_LOCAL_STORAGE\` asks the user to check local storage access without exposing paths. \`FEEDBACK_HOOK_HANDOFF_UNAVAILABLE\` does not establish its cause; in Claude Code, \`/hooks\` inspects configured hooks, while in Cowork it means preparation asked for history, which that host cannot give: tell the user and prepare once more with \`includeTranscript:false\`.

For any uncertain upload, preparation metadata such as expiry does not prove recoverable bytes. Never promise an archive, save, report, receipt, or status lookup; never resend that artifact or prepare a new report as a workaround. If submit returns \`UPLOAD_UNCERTAIN\` or \`FEEDBACK_SUBMISSION_FAILED\`, say «Не удалось подтвердить отправку. Отчёт мог быть получен, поэтому я не буду отправлять его повторно автоматически.» and ask what the user wants to do.

After \`status:"uploaded"\`, answer in Russian: «Отчёт отправлен в e-Comet.», when useful specify «…с историей текущей сессии.» or «…без истории текущей сессии.» according to \`transcriptIncluded\`, then «При обращении в поддержку используйте идентификатор обращения:» and the exact \`reportId\` value on the next line, copied verbatim. Only a \`status:"uploaded"\` result has an identifier. Do not mention transcript truncation or add implementation details or caveats.
`.replaceAll(String.raw `\``, '\x60');
export const feedbackWorkflow = {
    appliesTo: ['prepare_e_comet_feedback', 'report_issue', 'submit_e_comet_feedback'],
    text: feedbackToolContract,
};
