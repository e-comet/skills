---
name: e-comet-doctor
description: Use when e-Comet installation, local MCP startup, browser extension routing, storage, report creation, upload, or host hook behavior fails or remains uncertain, and when the user says e-Comet tools are missing, not answering, asking to sign in, or "worked before".
---

# e-Comet doctor

Base every conclusion on an observed typed result. Absence of a local tool can be a valid remote-only installation and does not prove a broken full installation.

## Triage before any conclusion

Both hosts load tools on demand. Search the host tool catalog for `e-comet` with a large result limit, or search by
exact tool name. A fresh task's start list proves nothing. A truncated search result does not prove absence; use the
host's supported bounded search again or search for the exact capability before calling it unavailable.

| Observed after search | Meaning | Next step |
| --- | --- | --- |
| No e-Comet tools | Installation or enablement is uncertain; in Cowork the remote connector may also be disconnected | Cowork: call host `ListConnectors` filtered for e-Comet. If `ListConnectors` shows the connector connected, verify in Customize → Plugins → Yours that e-Comet MCP Tools is installed and enabled, answer any local MCP permission prompt with Continue, and start a new task. Codex: use the [README fallback](https://github.com/e-comet/skills#troubleshooting) to check marketplace, plugin installation and enablement, then start a new task. No local probe is available. |
| Local tools present, remote tools absent | Remote authorization, chat enablement, or connection is uncertain | Codex: call installation `e_comet_diagnose` with `safe_probes` and `codex_mcp_auth`. Cowork: call `ListConnectors`. Apply the connector rules below. |
| Both present | Tools are visible in this task | Continue with the numbered steps below. |

The extension connects through the local MCP. When the local MCP is absent, first resolve that host route; extension
checks cannot explain the missing local tools.

## Typed-result cases

The host-neutral cases (`BRIDGE_*` causes, extension not installed, disabled or not activated, account mismatch,
`WB_NOT_AUTHENTICATED`, `SELLER_LOGIN_REQUIRED`, `BROWSER_JOB_HANDOFF_REQUIRED`, `OZON_ROUTE_NOT_READY`), the
extension rules, the answer order, plain examples and common mistakes are in
[TROUBLESHOOTING.md](../../mcp/TROUBLESHOOTING.md): read it before concluding, and give its action when a row
matches. The rows below add the actions only this host has. A user prerequisite is not a bug report; `retryDisposition`
governs repeats.

## Host cases

| Observed | Meaning | User action |
| --- | --- | --- |
| `BROWSER_JOB_HANDOFF_REQUIRED`, or Ozon `OZON_AUTHORIZATION_REJECTED` with "The trusted browser-job hook did not provide Ozon authorization." | The host hook did not provide the authorization: plugin hooks not trusted, disabled, changed after an update, or not run by the host in this task | Never repeat `browser_job` automatically. Codex: run installation `hook_permissions`; on `disabled` or `review_required` send the user to Settings → Plugins → Personal → e-Comet MCP Tools → Hooks to enable or trust the e-Comet handlers; on `ready` or `not_checked` say the cause is not established and offer a retry on the user's decision or a report. Cowork: when the local tools are named `mcp__remote-devices__...` and no shell command has run in the conversation, run one no-op shell command (`true`), then one fresh `browser_job` and the local tool; otherwise verify the plugin in Customize → Plugins → Yours. «Плагин не смог передать разрешение браузеру. Проверю настройки хуков e-Comet в Codex и скажу, что сделать.» Then, for a disabled or review-required handler: «Откройте Settings → Plugins → Personal → e-Comet MCP Tools → Hooks и подтвердите хуки e-Comet, потом повторим.» |
| Remote tools absent after search; Codex `codex_mcp_auth` `not_logged_in`, or Cowork `installState` other than `connected` | Codex configuration shows sign-in not completed; Cowork reports the connector not connected; firm wording only after a host authorization error | Codex: Settings → Plugins → e-Comet MCP Tools → server E-comet → Connect. «По настройкам Codex вход в e-Comet не выполнен: откройте настройки плагина и нажмите Connect у сервера E-comet.» Cowork: plugin card → Connectors → Connect. «Коннектор e-Comet не подключён: нажмите Connect в карточке плагина.» |
| Cowork `installState:"connected"`, `enabledInChat:false` | Connector connected but disabled for this chat | Ask the user to enable e-Comet for this chat; the exact control is an unverified UI detail, describe the action and name no control. «Коннектор e-Comet подключён, но выключен для этого чата: включите его в этом чате.» |
| Only remote tools after search | Basic installation, or a full one whose local MCP did not start | Ask which installation was intended (README: Базовая / Полная); for a full one use the README fallback. |

## Remote connector rules

Give the connector action in the first answer where its evidence appears. A firm authorization conclusion requires
a remote call's host authorization error or a
host system notice naming authorization. Say e-Comet is not authorized and ask the user to connect the remote
connector; until then analytics, live data and reports are unavailable. Cowork `ListConnectors.installState` other
than `connected` supports the distinct conclusion that its connector is not connected, with the Connect action.
Codex `facts.status:"not_logged_in"` supports the qualified wording "According to the
Codex configuration, e-Comet sign-in was not completed" with the same action. `credentials_present` proves only
stored credentials: call `info` if available, and let its host authorization error outrank the snapshot. `missing`,
`ambiguous`, `unknown_status`, and `not_checked` support no authorization claim. Without stronger
evidence, say only that remote tools are not visible and check whether the connector is connected and authorized.

In Cowork `installState:"connected"` with `enabledInChat:false` means connected but disabled for this chat. Ask the
user to enable it for this chat, not to sign in; the per-chat control has no verified label, so describe the action
and name no control. Cowork's Connect action is on the plugin card under Connectors (or
the Connect button on the connectors card). Codex in ChatGPT Desktop: Settings → Plugins → e-Comet MCP Tools →
server E-comet → Connect. Do not give a CLI command as the user's Desktop action. Before concluding that the
remote server is down or answering about a particular organization, call `info` when available: inspect subscription
tier and expiry, and that organization's `read` flag. An expired subscription or absent readable organization is a
specific observation, not a server-down diagnosis. A stored-credentials snapshot or a host `connected` status
before a real call does not establish that the call will succeed.

Only when remote tools fail with an observed network error while local tools work, suggest checking the host's
network permission as a candidate: `Allow network egress` in Cowork, `Allow network access` in Codex. Neither
permission is a diagnosed cause from tool absence alone.

For feedback sending or feedback-specific recovery, call `describe_e_comet_tool({name:"prepare_e_comet_feedback"})` once and follow the returned contract before feedback preparation.

1. For a host launch or bootstrap failure, use the independent [public fallback](https://github.com/e-comet/skills#troubleshooting). If Node can run the packaged file, collect exactly one `node mcp/src/doctor.mjs --json` result. Doctor covers only that Node execution plane.
2. For current local runtime facts, the agent calls `local_bridge_status`. `ok:true` means the response was produced, not that the product is healthy.
3. The agent calls `e_comet_diagnose` with the narrowest scope for installation evidence, runtime extension context, or an exact operation receipt. Installation probes are `storage_write`, `extension_install`, and, only for an observed Codex host, `hook_permissions` and `codex_mcp_auth`; under any other client those two answer `unsupported`. The runtime probe is `extension_snapshot`. All require `safe_probes`. Repeating a passive read does not guarantee a more specific cause.
4. Read [DIAGNOSTICS.md](../../mcp/DIAGNOSTICS.md) for exact field and enum meanings and [TROUBLESHOOTING.md](../../mcp/TROUBLESHOOTING.md) for the typed-result cases. After the host is observed, read only [Codex](references/codex.md) or [Claude](references/claude.md).

`BROWSER_JOB_HANDOFF_REQUIRED`, or the Ozon message about the hook not providing authorization, is the symptom that the hooks did not provide the authorization: on an observed Codex host run `hook_permissions` before anything else, never repeat `browser_job`, and read the DIAGNOSTICS.md section Missing authorization handoff. A successful Codex `hook_permissions` result is a configuration snapshot for the checked installation context, not proof that a hook ran in this task. `ready` means all expected native handlers are enabled and trusted. `disabled` means at least one trusted handler is off. `review_required` means at least one handler is new or changed and awaits review. Name the affected safe handler roles. A `not_checked` result with `facts.context:"configuration_probe"` means the bounded inspector failed before a hook inventory was available; use its closed `failure.reason` and `failure.phase` as probe evidence, and do not describe hooks as missing, disabled, or untrusted. For observed ChatGPT Desktop with Codex, direct the user to Settings → Plugins → Personal → e-Comet MCP Tools → Hooks only when a snapshot observed a disabled or review-required handler: enable a disabled handler, or review a new or changed handler and trust it: these are the e-Comet plugin's own handlers, and Codex asks to trust them again after the plugin is installed or updated (the README step is Trust all). For observed Codex CLI, use `/hooks` for the corresponding observed action with the same explanation. Do not expose paths, commands, hashes, or raw inspector errors. Do not use a local Codex snapshot to explain Claude Code or Cowork. Missing native hook context is unavailable evidence; missing Cowork cloud context is not device evidence.
