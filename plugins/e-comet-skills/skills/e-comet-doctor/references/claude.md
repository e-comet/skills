# Claude host actions

Use these actions only after the corresponding Claude surface is observed.

- Claude Code CLI: inspect the exact candidate with `claude plugin validate ... --json` and `claude --plugin-dir ... plugin list --json`. After hook or MCP configuration changes, use `/reload-plugins` or restart. For an observed hook failure, a bounded isolated `--debug-file` can distinguish hook events.
- Claude Desktop Code: verify install and enablement in that Code surface, restart the app after an update, and open a fresh task. CLI identity or loader success does not prove Desktop behavior.
- Cowork local: verify the plugin is installed and enabled in Customize → Plugins → Yours (card e-Comet MCP Tools) and that device policy permits local MCP only when absence is observed; a visible permission request needs the user's answer (Continue); it is not an installation failure. After that check, start a new task. A `BROWSER_JOB_HANDOFF_REQUIRED` result here has no hook-trust control to change: the same plugin check and a new task are the only supported actions.
- Cowork cloud: local MCP runs on the bound device, not in the cloud sandbox. Check account plugin sync separately from device availability. Cloud hook context and device MCP facts are separate evidence planes.

Current official documentation verifies Cowork → Customize → Plugins for installation and Claude Code's commands above. Exact update-card labels remain a UI acceptance gap. If the exact installed build has not been exercised on the observed Claude surface, state that verification gap. Accepted local observations establish split cloud/device execution and hook dispatch for earlier builds only.

The `hook_permissions` safe probe reads local Codex configuration. Do not use its result as Claude Code or Cowork hook evidence; use the host-specific checks above.

- Tool discovery: `ToolSearch` exists in Cowork and the Code tab. A fresh Cowork task's start list may hold no e-Comet tools; search with a large limit or by exact name before reporting absence.
- Connector state: Cowork `ListConnectors` (`list_connectors` in the Code tab) reports `installState`, `connected`, and `enabledInChat` for the remote connector. The plugin's local server does not appear there. In the Code tab a session's `connected` status before a call proves little; `needs_auth` can appear only after the first failed call. A host authorization error on the call is stronger evidence. Connected connector tokens normally refresh automatically. The per-chat enable control for `enabledInChat:false` has no verified label; describe the action without naming a control.

Official sources, verified 2026-09-13: [Claude hooks](https://code.claude.com/docs/en/hooks), [plugin loading and CLI inspection](https://code.claude.com/docs/en/plugins-reference), [Cowork plugin installation](https://support.claude.com/en/articles/13837440-use-plugins-in-claude), and [Cowork local/cloud architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview).
