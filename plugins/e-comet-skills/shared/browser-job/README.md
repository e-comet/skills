# Browser Job Shared Contract

Use this shared contract for e-Comet skills that fetch Wildberries data through the user's browser with the
`browser_job` MCP tool.

## Runtime Requirements

- **MCP server `e-comet`**: installed with the plugin. On first use, authenticate with the email-code flow.
- **e-Comet browser extension**: installed and authenticated with an extension key.
- **Wildberries login**: the user is logged in on wildberries.ru in the same browser. Jobs without WB login fail with
  `wb_not_authenticated`.
- **User Chrome with the extension**: use the browser exposed by `agent.browsers.get("extension")`, not the agent's
  built-in browser.
- **A wildberries.ru tab**: open any wildberries.ru tab, for example `https://www.wildberries.ru/`, and talk to the
  extension there through one of the two transports below.

The e-Comet server signs jobs but does not fetch WB data and does not see WB responses. The extension runs the WB
requests in the user's browser; the agent submits the job and reads results through an RPC on the wildberries.ru tab.

Let the extension do all the work through this API. Do NOT scrape the WB page DOM, parse raw WB JSON by hand, or
recompute prices/stocks/positions yourself — `summary` returns ready-to-present data.

## Transports

The API is identical in both transports (`submit` / `progress` / `list` / `read` / `readAll` / `summary`); pick by
what your runtime can do:

| Agent runtime | Transport |
| --- | --- |
| Claude (and any agent whose `evaluate` runs real JS via CDP) | **postMessage-RPC** — run the snippets from `scripts/` |
| Codex default (no "Full CDP access") | **DOM mailbox** — drive the `#ecomet-agent-bridge` element |
| Codex with "Full CDP access" enabled | postMessage-RPC (faster) |

Probe once, then cache your working transport across sessions (`ECOMET_AGENT_TRANSPORT=postmessage|dom` in your
environment, or your agent's persistent memory/config). If a cached transport starts failing (extension updated,
CDP access toggled), re-probe and overwrite the cache.

### postMessage-RPC (snippets)

Resolve snippet paths relative to the calling skill directory:

- `../../shared/browser-job/scripts/agent_submit.js`
- `../../shared/browser-job/scripts/agent_poll.js`
- `../../shared/browser-job/scripts/agent_summary.js`
- `../../shared/browser-job/scripts/agent_read.js`

Use these snippets as opaque templates. Replace only their placeholder tokens:

- `__TRIGGER_URL__`: exact `trigger_url` string from `browser_job`; do not reformat or wrap it.
- `__JOB_ID__`: parent job id from `browser_job.job_ids` or from the submit result.
- `__UNIT_IDS__`: `null` for `readAll`, or an array of unit ids for targeted reads.

### DOM mailbox (no JS execution needed)

The extension keeps a hidden mailbox element on every wildberries.ru page:

```html
<div id="ecomet-agent-bridge" data-ecomet-agent="1" data-version="1" data-ready="true">
  <textarea data-role="request"></textarea>              <!-- JSON command goes here -->
  <button data-action="run-command">run</button>          <!-- click to execute -->
  <div data-role="response-meta" data-command-id="" data-status="" data-json=""></div>
  <textarea data-role="response-body"></textarea>          <!-- response body -->
</div>
```

1. Fill `textarea[data-role="request"]` with a JSON command `{ "id": "<unique>", "method": "...", "params": { ... } }`.
   Methods/params match the snippets: `submit` takes `{ "token": "<trigger_url>" }`, `progress`/`list` take
   `{ "parentJobId": "<jobId>" }` (optional), `read` takes `{ "jobId": "<unitId>" }`, `readAll`/`summary` take
   `{ "parentJobId": "<jobId>" }`.
2. Click `button[data-action="run-command"]`.
3. Poll the `div[data-role="response-meta"]` attributes: the response is ready when `data-command-id` equals your id
   and `data-status` is not `pending`. `data-json` holds light meta `{ id, ok, method, bytes?, error? }`.
4. Read the full body from `textarea[data-role="response-body"]` (target it directly; on `ok: false` the body is
   empty and the reason is in `data-json.error`).

One response lives in the mailbox at a time — read the body before sending the next command. For large jobs prefer
`read` per unit over one giant `readAll` body.

## Workflow

1. Call `browser_job` with the skill-specific payload.
2. Open or reuse a wildberries.ru tab in the user's Chrome with the e-Comet extension.
3. `submit` the exact `trigger_url` (snippet `agent_submit.js` or mailbox command). Success returns
   `{ jobIds: [...] }`. An error is a setup error — show its text to the user as-is. If the transport is unavailable,
   navigate to `trigger_url` in the same tab as a fallback.
4. Poll `progress` (snippet `agent_poll.js`) every 2-3 seconds until `progress.status === "done"`. Large jobs run in
   throttled waves and can take tens of minutes; read completed units as they appear. If `setupError` appears, stop
   and show `setupError.message` as-is.
5. Read the result with `summary` (snippet `agent_summary.js`) — a ready-to-present compact object per product or per
   search page, no manual JSON parsing. Fall back to raw bodies (`agent_read.js`: `readAll` for small jobs, concrete
   unit ids in chunks of 1-2 for large ones) only when a field is missing from the summary.
6. Answer from the summary fields without extra recomputation.

**One job = one snapshot, readable many times.** Results are retained up to ~1 day (older completed ones can be
evicted earlier). To fetch additional fields from data you already captured, reuse the same `parentJobId`
(`summary`, then `read`/`readAll`) — do NOT start a new `browser_job` for that. Start a new `browser_job` only for
the current state of fast-moving data (price/stock/positions), for new articles/queries, or after retention expired.

## Common Errors

Setup errors can arrive from `submit` or `progress().setupError`; show the user the message as-is.

| `code` | User action |
| --- | --- |
| `extension_not_authenticated` | Open the e-Comet extension popup and enter the extension key |
| `wb_not_authenticated` | Log in to wildberries.ru and repeat the request |
| `extension_misconfigured` | Update or reinstall the extension |
| `token_rejected` | Request a new `browser_job` and retry |

Unit-level errors (`status: "error"`, `error` field) include `Agent job timed out`, `Fetch URL host is not allowed`,
and `Extension connection not ready` / `closed`. A snippet response
`{ error: "e-Comet extension did not respond" }` means the extension did not answer on the current tab; verify that the
tab is wildberries.ru and the extension is enabled, or switch to the DOM mailbox transport.
