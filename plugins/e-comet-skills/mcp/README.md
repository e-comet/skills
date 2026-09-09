# e-Comet local MCP

Codex and Claude launch `src/server.mjs` directly over STDIO with the `node` command. The server has no npm runtime
dependencies; all required source modules are included in this directory. Node.js 22+ is required.

The `secondary` bridge role is a normal proxy role. `peer.bridgeVersion` and `extension.version`
identify different components; version skew alone does not establish a failure cause.
`extensionConnected:false` means there is no effective extension route, not why it is absent.
The released singular Ozon promotion report requires e-Comet extension 1.5.6+ and any authenticated Ozon Seller `/app` page,
not a Wildberries tab or a specific promotion-overview page. Ozon company context comes only from the
`sc_company_id` cookie; the extension does not depend on Vue, Vuex, Axios defaults, or a visible company label.
Feedback is independent of bridge
and extension readiness; its optional history is bounded current-session history supplied by
the trusted host hook. The explicit history choice and protected handoff remain required.

Feedback failures provide only closed diagnostic evidence in `error.details`: the operation, reason,
system code, HTTP status, and optional public module/line context. No raw paths, messages, stacks,
upload secrets, or history are exposed there. A source location helps investigation; it does not prove
the root cause. Explain the supplied safe evidence and next action without guessing missing causes.
`UPLOAD_UNCERTAIN` and `FEEDBACK_SUBMISSION_FAILED` mean delivery cannot be confirmed; ask for user
direction and never automatically repeat submission or restart the flow. On success, say only that
the report was sent to e-Comet. The archive has a 32 MiB aggregate limit; the chosen history option
is never silently changed and truncation markers are not inserted.

`local_bridge_status` distinguishes bridge startup, extension waiting, Wildberries-tab readiness,
update needs, and pairing failures. It reports facts, not a global next action: recovery depends on
the user's task and the selected typed tool's result. It also reports the
connected extension's version and family-specific Ozon capability verdicts; these observations
are informational and never replace the typed tool's own capability gate. Peer-token storage affects pairing only;
`peerRejection.code` identifies the observed pairing failure. Storage-dependent calls return the typed
`LOCAL_STORAGE_UNAVAILABLE` outcome when no valid host plugin-data root or explicit store override exists.
The peer token and normal feedback-claim rendezvous remain in shared profile state, outside host-specific
plugin-data output, so concurrently running supported hosts can coordinate the same local lifecycle.

The canonical source and tests live under `e-comet-local-mcp/` in the private skills repository. This plugin contains a
release snapshot of its `src/` directory.

The MCP listens only on `127.0.0.1:17361`, and the extension connects automatically while local access is enabled.
There is no pairing flow in the MVP. Full WB responses and artifacts are stored below the host plugin-data root; MCP
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

Full responses and artifacts use `PLUGIN_DATA` or `CLAUDE_PLUGIN_DATA` when supplied by the host. If both are absent,
the local MCP uses the per-user e-Comet application-data directory. Both use owned `local-mcp-output-v2` children;
bridge status identifies the selected backend. Invalid declared paths fail explicitly. Absolute `ECOMET_LOCAL_AGENT_RESULT_DIR`, `ECOMET_LOCAL_AGENT_ARTIFACT_DIR`, and
`ECOMET_FEEDBACK_ARTIFACT_DIR` values override only their corresponding store. POSIX directories are created or
repaired to mode `0700` and files to `0600`; Windows relies on ACL inheritance from the selected current-user directory.

Local tools:

- `wb_product_card` — discovers and executes signed live product-card requests;
- `wb_search_by_query` — discovers and executes signed live WB search requests;
- `wb_check_by_query` — checks whether one article appears in search for up to 100 phrases, without reporting a position;
- `wb_recommendations_by_product` — discovers and executes signed recommendation-shelf requests;
- `wb_seller_reviews` — exports original WB seller-review XLSX reports through the authenticated seller portal;
- `prepare_e_comet_feedback` — prepares one local e-Comet issue-report archive after explicit user consent;
- `submit_e_comet_feedback` — uploads one prepared feedback archive with a trusted one-use grant;
- `ozon_seller_promotion_report` — exports one Ozon Seller promotion analytics XLSX report for one inclusive period;
- `ozon_seller_promotion_reports` — exports 1–50 ordered promotion-period XLSX files through one `browser_job`
  authorization and one local call;
- `ozon_seller_analytics_report` — exports 1–50 ordered general-analytics XLSX files through one `browser_job`
  authorization and one local call; the connected extension must advertise the analytics capability;
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

The plural promotion signer accepts exactly `periods:[{dateFrom,dateTo},...]`; the analytics signer accepts exactly
`reports:[{dateFrom,dateTo,breakdown},...]`. Each signs one descriptor containing the complete caller-ordered array.
Promotion and analytics are separate variants and are never mixed. Package streams and ACKs carry an item index under
one shared Ozon report owner and correlation. The create phase is never automatically retried after dispatch ambiguity.
Completed artifacts remain available when later items fail, and a partial response lists every complete, failed, and
skipped item.

`wb_seller_reviews` accepts the signed mixed export descriptor, expands an omitted `isAnswered` into separate answered and
unanswered physical reports, and preserves successful work when another export fails. It returns compact status metadata plus
one private local `resource_link` for each successful XLSX workbook. Workbook bytes and base64 never enter tool content or model
context; opening or summarizing a workbook is a separate explicit action. Artifacts are retained locally for 24 hours. Each
workbook is limited to 100 MiB and each job to 500 MiB; the shared artifact store is limited to 512 MiB and 1000 files, with
oldest completed artifacts evicted first.

Ozon tools likewise return the original XLSX workbooks as private `resource_link` entries rooted in the launching
host's plugin data. The plugin does not add a workbook reader or converter; the originating agent may use its normal
file and spreadsheet capabilities when the user asks to inspect a workbook. Legacy platform-data stores are read,
retired, or cleaned only by bounded maintenance; new payloads never fall back there.

`ozon_seller_promotion_report` needs an extension build that announces the Ozon promotion capability. An older
build cannot run the report at all, so the tool answers with an explicit outdated-extension diagnosis naming the
installed version, the minimum supported one, and the update page, instead of asking for the report route to be
opened. The same code without that diagnosis says only that no ready Ozon route was reachable; it does not
establish why. Extension 1.5.6+ can use any authenticated Ozon Seller `/app` page, not only the promotion page.

Multiple Codex tasks can use the fixed bridge port at the same time in MVP mode. The first MCP process owns the
extension WebSocket; later bundled MCP processes connect to it over the loopback-only `/mcp-peer` channel and proxy
their bounded WB fetches through that primary process. If the primary task closes, a remaining process retries the port
and takes ownership.

Processes also exchange a control-protocol version, bridge generation, build version, and instance ID. A newer
generation waits for active WB requests to finish, receives an explicit takeover grant, claims the same port, and becomes
the primary. The old primary and all other conversations reconnect as peers, while the extension reconnects
automatically. Releases must increment `BRIDGE_GENERATION` whenever the active primary needs replacement.
