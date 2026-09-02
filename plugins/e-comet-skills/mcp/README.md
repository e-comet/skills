# e-Comet local MCP

Codex and Claude launch `src/server.mjs` directly over STDIO with the `node` command. The server has no npm runtime
dependencies; all required source modules are included in this directory. Node.js 22+ is required.

`local_bridge_status` distinguishes bridge startup, extension waiting, Wildberries-tab readiness,
update needs, and pairing failures, and returns a recommended next action. It also reports the
connected extension's version and whether that build announces the Ozon promotion capability; both
are informational and never gate a typed tool. Peer-token storage affects pairing only; if a second
agent reports `peer_unavailable`, continue in the agent that owns the bridge. Browser jobs may still
return `LOCAL_STORAGE_FAILED` when result or artifact directories are unwritable; storage
classification, fallback, and retry work is deferred.

The canonical source and tests live under `e-comet-local-mcp/` in the private skills repository. This plugin contains a
release snapshot of its `src/` directory.

The MCP listens only on `127.0.0.1:17361`, and the extension connects automatically while local access is enabled.
There is no pairing flow in the MVP. Full WB responses are stored in the platform-standard user data directory; MCP
tool results contain only compact summaries and local paths.
The extension WebSocket accepts only the official e-Comet Chrome Web Store origin by default.

Each result file is UTF-8 NDJSON with one fetched unit per line:

- product card: `{ jobId, nmId, key, url, response }`;
- search: `{ jobId, queryIndex, query, page, url, response }`;
- check-by-query card: `{ jobId, kind: "card", product_id, url, response }`;
- check-by-query search: `{ jobId, kind: "search", query, page, url, response }`;
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
- `wb_check_by_query` — checks whether one article appears in search for up to 100 phrases, without reporting a position;
- `wb_recommendations_by_product` — discovers and executes signed recommendation-shelf requests;
- `wb_seller_reviews` — exports original WB seller-review XLSX reports through the authenticated seller portal;
- `prepare_e_comet_feedback` — prepares one local e-Comet issue-report archive after explicit user consent;
- `submit_e_comet_feedback` — uploads one prepared feedback archive with a trusted one-use grant;
- `ozon_seller_promotion_report` — exports one Ozon Seller promotion analytics XLSX report for one inclusive period;
- `local_bridge_status` — reports whether the extension is connected, and why the bridge cannot reach a primary
  peer when it cannot;
- `wb_product_images` — public WB image-CDN lookup; this tool does not require the extension.

The agent discovers the matching typed local tool first. Its description then requires sending only the small task
descriptor to remote `browser_job` before invoking the selected local tool.
Claude and Codex/ChatGPT Desktop use the plugin's trusted `PostToolUse` and `PreToolUse` hooks to stage and inject the
exact opaque JWT in a one-use claim bound to the desktop session and exact local tool. The model-authored local call
omits both trigger-field spellings, and the hook injects the transport-only field. This is an integrity guarantee, not
a secrecy guarantee: the remote tool result may still be visible to the model, but the model does not author or
reproduce the transport field. Hosts that do not run or cannot verify the trusted hooks fail closed. The extension
verifies the RS256 signature, expiry, account UUID, job type, and exact signed scope. It rejects
browser operations without matching authorization. Marketplace response bodies remain on the user's computer and do
not pass through e-Comet backend services.

`wb_seller_reviews` accepts the signed mixed export descriptor, expands an omitted `isAnswered` into separate answered and
unanswered physical reports, and preserves successful work when another export fails. It returns compact status metadata plus
one private local `resource_link` for each successful XLSX workbook. Workbook bytes and base64 never enter tool content or model
context; opening or summarizing a workbook is a separate explicit action. Artifacts are retained locally for 24 hours. Each
workbook is limited to 100 MiB and each job to 500 MiB; the shared artifact store is limited to 512 MiB and 1000 files, with
oldest completed artifacts evicted first.

`ozon_seller_promotion_report` needs an extension build that announces the Ozon promotion capability. An older
build cannot run the report at all, so the tool answers with an explicit outdated-extension diagnosis naming the
installed version, the minimum supported one, and the update page, instead of asking for the report route to be
opened. The same code without that diagnosis says only that no ready Ozon route was reachable, which usually
means the exact promotion page is not open.

Multiple Codex tasks can use the fixed bridge port at the same time in MVP mode. The first MCP process owns the
extension WebSocket; later bundled MCP processes connect to it over the loopback-only `/mcp-peer` channel and proxy
their bounded WB fetches through that primary process. If the primary task closes, a remaining process retries the port
and takes ownership.

Processes also exchange a control-protocol version, bridge generation, build version, and instance ID. A newer
generation waits for active WB requests to finish, receives an explicit takeover grant, claims the same port, and becomes
the primary. The old primary and all other conversations reconnect as peers, while the extension reconnects
automatically. Releases must increment `BRIDGE_GENERATION` whenever the active primary needs replacement.
