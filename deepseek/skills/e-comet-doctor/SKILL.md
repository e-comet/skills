---
name: e-comet-doctor
description: Diagnose missing e-Comet tools, account connection, browser extension readiness, and signed Wildberries or Ozon calls in DeepSeek Harness.
---

# e-Comet in DeepSeek Harness

Use observed tool results to distinguish account login, extension prerequisites, host compatibility and unknown failures. A successfully imported plugin does not prove either MCP is connected.

1. Look for the `mcp__e-comet__` and `mcp__e-comet-local__` tools. Missing tools alone do not prove the account is signed out. First inspect Plugins → e-Comet Skills (package dsh-e-comet-skills), or ask the user for its status. During an update, wait; if the footer asks to restart DeepSeek, restart without repeating login; if recovery failed, follow its support instruction. A checking or reconnecting card needs no action. Recommend «Связать с аккаунтом e-Comet» only when the card offers that button. The login page opens in the browser by itself; «Открыть страницу входа ещё раз» is only for a tab that did not open or was closed. Account login happens in the browser; do not ask for API keys or bearer tokens in chat, terminal commands, or a restart after ordinary login. Verify a successful account connection with a remote `info` call when available.
2. When signed in and not paused for an update, the card's «Живые данные WB и отчёты Ozon» row reflects bridge observations; it is not a diagnosis. When available, call `local_bridge_status` for current bridge facts. A secondary bridge with `address_in_use` can be healthy. For an unconnected extension, use `e_comet_diagnose` when available with installation scope, `safe_probes`, and `extension_install`. If those tools are absent, follow the card status in step 1. Do not run Codex-only probes in DeepSeek.
3. If a checked browser profile has e-Comet installed but disabled, tell the user to enable that copy. For a WB flow, open wildberries.ru in the browser with the enabled extension. Browser metadata does not prove which browser the user is using. An Ozon flow follows its own typed route result.
4. Before a browser operation, call `describe_e_comet_tool` for the exact local tool and follow its contract. The native adapter owns authorization. Never supply `triggerUrl`, `trigger_url`, signatures or host-adapter fields in model input, and never copy an authorization between tools or sessions.
5. Missing, expired or rejected authorization is not permission to automatically repeat `browser_job`. Preserve completed work; an uncertain report creation or upload must not be retried to hide an error.
6. Follow the shared feedback contract for an identifiable problem and the user's history choice. The native host asks separately to prepare and to send the report; decline or cancellation must stop before the corresponding action. History comes only from the current native session. Never author transcript paths, upload destinations, headers or handoff claims, never copy another chat's history, and never retry an uncertain upload to hide its outcome. If native approval or history is unavailable, state the observed limitation; do not use Codex/Cowork instructions or bypass the native host.

The public upstream tool contracts define marketplace parameters and recovery rules. This skill changes host diagnostics, not those contracts.
