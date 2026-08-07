# e-Comet local MCP

Codex and Claude launch `src/server.mjs` directly over STDIO with the `node` command. The server has no npm runtime
dependencies; all required source modules are included in this directory. Node.js 22+ is required.

The canonical source and tests live under `e-comet-local-mcp/` in the private skills repository. This plugin contains a
release snapshot of its `src/` directory.

The MCP listens only on `127.0.0.1:17361`, and the extension connects automatically while local access is enabled.
There is no pairing flow in the MVP. Full WB responses are stored in the platform-standard user data directory; MCP
tool results contain only compact summaries and local paths.
The extension WebSocket accepts only the official e-Comet Chrome Web Store origin by default.

Each result file is UTF-8 NDJSON with one fetched unit per line:

- product card: `{ jobId, nmId, key, url, response }`;
- search: `{ jobId, queryIndex, query, page, url, response }`;
- recommendations: `{ jobId, nmId, page, url, response }`.

The original WB payload is at `response.data.body`. Product-card responses may additionally contain
`response.warehouseNames`, a best-effort map of warehouse ID to the locally known display name.

Full responses use the platform-standard user data directory: `%LOCALAPPDATA%\e-comet\local-agent` on Windows,
`~/Library/Application Support/e-comet/local-agent` on macOS, and
`${XDG_DATA_HOME:-~/.local/share}/e-comet/local-agent` on Linux. `ECOMET_LOCAL_AGENT_RESULT_DIR` overrides this path.
POSIX result directories are created or repaired to mode `0700` and result files to `0600`. On Windows, privacy relies
on ACL inheritance from the current user's local application-data directory rather than POSIX mode bits.

Local tools:

- `wb_product_card` — discovers and executes signed live product-card requests;
- `wb_search_by_query` — discovers and executes signed live WB search requests;
- `wb_recommendations_by_product` — discovers and executes signed recommendation-shelf requests;
- `local_bridge_status` — reports whether the extension is connected;
- `wb_product_images` — public WB image-CDN lookup; this tool does not require the extension.

The agent discovers the matching typed local tool first. Its description then requires sending only the small task
descriptor to remote `browser_job` before invoking the selected local tool.
Claude uses the plugin's `PostToolUse` and `PreToolUse` hooks to hand off the exact opaque JWT. Codex/ChatGPT Desktop
executes both MCP calls inside one `exec` and passes the value only through a local JavaScript variable. The model does
not reproduce the token as text. The extension verifies the RS256 signature, expiry, account UUID, job type, and exact
derived WB URLs. It rejects direct `wb_fetch` calls without that authorization. WB response bodies remain on the user's
computer and do not pass through e-Comet backend services.

Multiple Codex tasks can use the fixed bridge port at the same time in MVP mode. The first MCP process owns the
extension WebSocket; later bundled MCP processes connect to it over the loopback-only `/mcp-peer` channel and proxy
their bounded WB fetches through that primary process. If the primary task closes, a remaining process retries the port
and takes ownership.

Processes also exchange a control-protocol version, bridge generation, build version, and instance ID. A newer
generation waits for active WB requests to finish, receives an explicit takeover grant, claims the same port, and becomes
the primary. The old primary and all other conversations reconnect as peers, while the extension reconnects
automatically. Releases must increment `BRIDGE_GENERATION` whenever the active primary needs replacement.
