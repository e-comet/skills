# Browser Job Shared Contract

Use this shared contract for e-Comet skills that fetch Wildberries data through the user's browser with the
`browser_job` MCP tool.

## Runtime Requirements

- **MCP server `e-comet`**: installed with the plugin. On first use, authenticate with the email-code flow.
- **e-Comet browser extension**: installed and authenticated with an extension key.
- **Wildberries login**: the user is logged in on wildberries.ru in the same browser. Jobs without WB login fail with
  `wb_not_authenticated`.
- **The user's own Chrome, connected via the e-Comet extension** — pick this in your browser tool (in Codex: "Chrome
  via extension"), NOT the in-app/built-in browser. The in-app browser may have full CDP but has no user profile and no
  e-Comet extension, so there is no RPC/mailbox and nothing works. Only the user's Chrome carries the extension; CDP
  alone does not mean the extension is reachable.
- **A wildberries.ru tab**: open any wildberries.ru tab, for example `https://www.wildberries.ru/`, and talk to the
  extension there through one of the two transports below.

The e-Comet server signs jobs but does not fetch WB data and does not see WB responses. The extension runs the WB
requests in the user's browser; the agent submits the job and reads results through an RPC on the wildberries.ru tab.

Rules for the agent:

- **Do the whole flow yourself, in the user's Chrome (via the extension).** Open the wildberries.ru tab, `submit`,
  poll, and read results yourself. NEVER hand the user the `trigger_url`, ask them to open a link, or offload the
  fetch. Do NOT use the agent's in-app/isolated browser — even one with full CDP has no e-Comet extension, so there is
  no RPC/mailbox and the job returns nothing.
- **Do not invent setup/auth errors.** Real errors come ONLY from `submit` (reject) or `progress().setupError`. Never
  tell the user "e-Comet is not authenticated" (or similar) without actually seeing such an error — submit the job and
  read the status first; if there is an error, its `message` is already user-ready.
- **Let the extension do the work through this API.** Do NOT scrape the WB page DOM, parse raw WB JSON by hand, or
  recompute prices/stocks/positions yourself — `summary` returns ready-to-present data.

## Transports

Same API in both transports (`submit` / `progress` / `list` / `read` / `readAll` / `summary`). There is a **required
order — do NOT skip to the fallback:**

1. **Try postMessage-RPC FIRST — always.** Run `agent_submit.js` (or a `capabilities` probe) in the current
   wildberries.ru tab via your JS-execution tool (Codex `javascript_tool`, CDP `Runtime.evaluate`, etc.).
2. Got a result back → postMessage-RPC works. Use it for the whole job and cache it (below).
3. **Only** if step 1 actually fails — the snippet cannot execute (no JS eval available) or no `ecomet-agent-rpc-result`
   arrives within the timeout — switch to the **DOM mailbox** (`#ecomet-agent-bridge`).

The DOM mailbox is a **fallback, not a default**. Do NOT pick it just because the `#ecomet-agent-bridge` element is
present or "obviously available" — that does NOT prove postMessage is unavailable. **Never fall back without an actual
postMessage error or timeout.** A transient error right after navigation (CDP `Raw CDP is unavailable while Browser Use
is resolving a paused document response`, or `window.addEventListener is not a function`) is NOT such a failure — the
tab is still loading. Wait for readiness (step 2 above) and **retry postMessage** on the same or a fresh idle tab;
switch to the DOM mailbox only after postMessage fails on a READY tab. Skipping the probe is a mistake: postMessage-RPC
is faster and returns many units per call; the DOM mailbox is slower and one response at a time. State which transport
you used and why ("postMessage worked" / "postMessage timed out → DOM").

Why this order: postMessage-RPC needs the agent to run JS on the page — CDP, on by default in Claude, and in Codex only
if the user enabled "Full CDP access" (which you cannot read or toggle, so you MUST actually try it rather than assume).
The DOM mailbox needs no CDP. Cache the working transport across sessions (`ECOMET_AGENT_TRANSPORT=postmessage|dom`, or
your agent's persistent memory); re-probe and overwrite if it starts failing.

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
2. Open or reuse a wildberries.ru tab in the user's Chrome with the e-Comet extension. **Wait for the page to be ready
   before any RPC/evaluate** — after navigating, wait for `domcontentloaded` (or until `document.readyState` is
   `interactive`/`complete`). Do NOT run `goto()` and the RPC snippet back-to-back: on a tab still resolving its
   document response, CDP `Runtime.evaluate` fails with `Raw CDP is unavailable while Browser Use is resolving a paused
   document response` and `evaluate` sees a stub window (`window.addEventListener is not a function`).
3. `submit` the exact `trigger_url` (snippet `agent_submit.js` or mailbox command). Success returns
   `{ jobIds: [...] }`. An error is a setup error — show its text to the user as-is. If the transport is unavailable,
   navigate to `trigger_url` in the same tab as a fallback. You already have the parent `jobId` from
   `browser_job.job_ids` — if `submit` seems to fail on a transport hiccup (not a setup error), the job may already be
   accepted: check `progress`/`list` on that `jobId` before re-submitting. Do NOT create a new `browser_job` to recover
   from a transport error (that wastes time and produces a wrong jobId).
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
