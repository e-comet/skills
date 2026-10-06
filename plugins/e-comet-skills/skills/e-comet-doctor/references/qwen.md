# Qwen Code host actions

Use this route only after Qwen Code is observed. Keep CLI, Desktop and other Qwen surfaces separate: an installed
package or successful Node diagnostic does not prove that this session ran its hooks or authorized the remote server.

- Inspect the actual Qwen Plugins/Extensions and MCP server states available in the current surface. In the CLI,
  `qwen extensions list` identifies installed extensions; it does not establish a live server connection. The native
  package is `e-comet-skills` (e-Comet) and configures remote `e-comet` and local `e-comet-local` servers.
- If tools are absent, first inspect those observed installation, enablement and connection states. Missing tools
  alone do not establish a need to sign in, restart or reinstall. When the local server did not start, collect one
  `node mcp/src/doctor.mjs --json` result from the installed package if Node can run it. This covers only that Node
  execution plane; use its bounded facts and [diagnostic meanings](../../../mcp/DIAGNOSTICS.md).
- When local tools work, call `local_bridge_status`, then `e_comet_diagnose` with the narrowest applicable scope.
  Use `safe_probes` for `storage_write`, `extension_install` or runtime `extension_snapshot` when the observed case
  calls for them. Do not request `codex_mcp_auth` or `hook_permissions`: they inspect Codex, not Qwen.
- Missing remote tools support only uncertainty. Use the actual Qwen MCP state and an available `info` call to
  distinguish visibility, connection and authorization. Ask the user to authorize e-Comet only after an observed
  host authorization error or notice; describe the action in the current Qwen surface without inventing a button.
- For `BROWSER_JOB_HANDOFF_REQUIRED`, `HANDOFF_QWEN_CONTEXT_REQUIRED`, a Qwen feedback-context refusal, or Ozon's
  trusted-hook authorization refusal, do not repeat `browser_job` automatically. Check whether the installed native
  package, local proxy and the host's recorded hook failure match this session. No Qwen hook-trust GUI control is
  established here; do not give Codex's Hooks settings or Cowork's controls as Qwen instructions. If the cause is
  still unknown, say so and preserve the error evidence. A repeat is the user's decision and must also satisfy the
  operation's `retryDisposition`; an uncertain create or upload must never be repeated.

Apply the shared skill's browser-extension and typed marketplace-error rules when those results are observed.
Before feedback preparation, call `describe_e_comet_tool({name:"prepare_e_comet_feedback"})` and follow its contract.
Native Qwen context attests the session's transcript path, not human consent or an individual tool call. Never put
authorization or transcript-path fields into model-authored tool input.
