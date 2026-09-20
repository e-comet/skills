# `local_bridge_status` technical reference

`local_bridge_status` is a passive snapshot. It does not start a listener, create or repair pairing data, schedule a reconnect, probe storage, open a browser tab, obtain authorization, or make a marketplace request. `ok=true` means only that the status response was produced.

e_comet_diagnose with runtime scope, safe-probes mode, and the extension-snapshot probe uses the negotiated diagnostic_snapshot_v1 route. Its facts contain protocol version, observation time, extension version, capabilities, activation state, storage-read state, and the WB, WB Seller, and Ozon port-registration states. Activation is present, absent, or unknown; storage is passed, failed, or unknown; each port is true, false, or unknown. A port value proves registration rather than operational readiness. The probe performs one activation-storage read and observes the extension's in-memory port registry. It does not open, reload, ping, switch, dispatch, cancel, authorize, or call a marketplace. An older extension or primary reports unsupported.

Negotiated browser-job refusals may include a versioned, closed browser-job rejection record in public error details. The optional diagnostic is present only for the invalid-job reason. This record never contains tokens, claims, user identifiers, paths, or arbitrary error text. Its absence preserves the legacy refusal and does not imply an unknown reason.

| `reason` in `browserJobRejection` | Owner | Supported action |
| --- | --- | --- |
| `ecomet_not_authenticated` | user | Activate the extension with the API key from the e-Comet account (https://app.e-comet.io/account) in the browser where it is connected. Ozon tools already translate this into "the e-Comet extension is not signed in"; WB tools deliver the raw extension message plus this typed reason. |
| `subject_mismatch` (delivered with code `BROWSER_JOB_ACCOUNT_MISMATCH`) | user | The extension is activated with a different e-Comet account than the one that authorized the job through the remote connector. Activate the extension with the API key of the same e-Comet account as the connector (https://app.e-comet.io/account), or connect the remote connector with the account the extension uses; then one fresh authorization on the user's decision. Ozon tools already translate this into "signed in to a different e-Comet account"; WB tools deliver the raw extension message plus this typed reason. |
| `activation_storage_unavailable` | browser or our defect | No user action; offer a report. |
| `expired`, `token_reuse` | authorization flow | Obtain a new one-use authorization; never reuse the old one. |
| `invalid_job` (optional `diagnostic`) | our defect (agent input or contract) | Report; when present, `diagnostic` names the offending field. |
| `public_key_not_configured`, `invalid_signature`, `issuer_mismatch`, `audience_mismatch`, `invalid_format`, `invalid_algorithm` | our infrastructure | Report; do not ask the user to change anything. |
| `user_not_available` | e-Comet session inside the extension | Check activation with the API key; report if it repeats. |
| `unknown` | — | Report. |

`errorDetails.code:"WB_NOT_AUTHENTICATED"` on a buyer product unit (`products[].units[].errorDetails`)
is produced by the extension page script when the Wildberries page carries no session token for a request that
requires one. It is the only code that supports a "not signed in to wildberries.ru" conclusion; the action is to
sign in in the browser and profile that made the request. A timeout, `WB_FETCH_FAILED` or an expired session token
does not produce this code.

## Missing authorization handoff

A signed local tool answers `code:"BROWSER_JOB_HANDOFF_REQUIRED"` (`stage:"handoff"`, `retryable:true`) when it was called without `triggerUrl`; the Ozon tools answer `OZON_AUTHORIZATION_REJECTED` with the message "The trusted browser-job hook did not provide Ozon authorization." for the same condition. Model-authored arguments must omit `triggerUrl`, so this means the host `PreToolUse` hook did not run or did not rewrite the input: the plugin hooks are not trusted, are disabled, changed after a plugin update, or the host does not run plugin hooks in this task. It is not a marketplace, extension or e-Comet account failure, and `browser_job` was already called once. Do not call `browser_job` or the local tool again until the hook condition is resolved: each repeat spends one signed authorization and fails the same way. On an observed Codex host, run installation `hook_permissions` (`safe_probes`) and follow its `disabled`, `review_required` and `not_checked` guidance below; the user action is Settings → Plugins → Personal → e-Comet MCP Tools → Hooks. On Claude Code, `/hooks` lists the configured hooks. On Cowork there is no hook-trust control: verify that the plugin is installed and enabled in Customize → Plugins → Yours and start a new task. The receipt is `outcome:"failed"`, `retryDisposition:"unknown"`.

## Seller cabinet codes

`wb_seller_reviews` exports run inside the signed-in Wildberries seller cabinet tab (seller.wildberries.ru) in the
browser where the extension is connected. `SELLER_LOGIN_REQUIRED` (`stage:"execution"`, `retryable:false`) means the
extension found no signed-in cabinet tab: the user opens the cabinet there and signs in; the package aborts, and one
fresh `browser_job` follows on the user's decision. `SELLER_AUTH_UNAVAILABLE` with the same stage means a cabinet tab was
selected but the extension could not read the page's own request credentials within its bounded wait. With
`browserContext.sellerTabConnected:true` that is an e-Comet defect to report, never a user action; repeating spends
authorizations without changing the outcome.

## Existing status contract

| Field | Producer and exact meaning | Inference boundary / next discriminating check |
| --- | --- | --- |
| `ok` | MCP dispatcher; response construction succeeded | It is not product health. Inspect the typed checks and the selected operation. |
| `extensionConnected`, `browserJobSupported` | Effective direct or authenticated-peer route state | They do not prove login, hook execution, or a particular operation. Call the selected typed tool. |
| `bridgeRole`, `bridgeTransitioning`, `listenerState` | Bridge runtime; role is `primary`, `secondary`, or `disconnected`; listener event is `pending`, `listening`, `address_in_use`, or `failed` | `secondary` with `address_in_use` is normal. `listenerState` is a last event, not current port ownership. |
| `state` | Ordered compatibility summary: `initializing`, `listen_failed`, `waiting_for_extension`, `extension_connected_no_wb_tab`, `extension_contended`, `extension_context_unknown`, `peer_context_unknown`, `ready`, `extension_update_required`, `peer_reconnecting`, or `peer_unavailable` | It is neither a complete fault list nor permission to run/retry a business operation. |
| `bridgeVersion`, `bridgeGeneration`, `controlProtocolVersion`, `extensionProtocolVersion`, `instanceId`, `websocket` | Local build/control metadata and configured loopback endpoint | These fields do not prove which build owns the port or that a route works. |
| `extension.state`, `extension.route`, `extension.version`, `extension.lastConnectedAt`, `extension.lastDisconnectedAt` | Derived effective extension observation; states are `never_connected`, `connected`, `disconnected`; routes are `direct`, `peer`, `none` | Retained version/time after disconnect is valid. A version is not an integrity or end-to-end check. |
| `extension.ozonSellerPromotionReportSupported`, `extension.ozonSellerPromotionReportsSupported`, `extension.ozonSellerAnalyticsReportSupported`, `ozonSellerPromotionReportSupported`, `ozonSellerPromotionReportsSupported`, `ozonSellerAnalyticsReportSupported` | Capability reported by a connected extension; the latter three are legacy top-level copies | Absence means unobserved, not `false`; the typed Ozon tool remains authoritative. |
| `extensionLastConnectedAtMs`, `extensionLastDisconnectedAtMs`, `extensionVersion` | Compatibility copies of effective extension observations | Copies are not independent evidence. |
| `extensionTakeovers.count`, `extensionTakeovers.lastAtMs`, `extensionTakeovers.saturated` | Recent takeover-window count, retained last timestamp, and lower-bound marker | `lastAtMs` may lie outside the count window. It does not identify a browser profile. |
| `peer.bridgeVersion`, `peer.browserContextPropagationSupported`, `peer.diagnosticForwardingSupported` | Metadata from an authenticated primary. The diagnostic-forwarding field is true when that primary advertised diagnostic_snapshot_forwarding_v1; false includes a compatible legacy or other primary that did not advertise it. | A missing peer is normal for a primary. The diagnostic-forwarding field alone says nothing about extension diagnostic-snapshot capability and does not prove that a snapshot request will succeed. |
| `peerRejection.code`, `peerRejection.since`, `peerRejection.retryAt` | Current continuous rejection streak and retry schedule | Codes are `authentication_failed`, `protocol_mismatch`, `handshake_required`, `connection_failed`, `listen_failed`, `token_permission_denied`, `token_unavailable`. The token code is not an e-Comet login error and combines multiple pairing causes. |
| `browserContext.state`, `browserContext.wbTabConnected`, `browserContext.sellerTabConnected`, `browserContext.changedAt` | Extension-reported registered WB and WB Seller ports; state is `known` or `unknown` | Registered ports are not authenticated sessions. `changedAt` is not a freshness check and says nothing about Ozon. |
| `storage.results`, `storage.marketplaceArtifacts`, `storage.feedbackArtifacts` | Resolved configuration. Each target has `state`: `ready` with `backend` `plugin_data`, `application_data`, or `override`, or `unavailable` with `reason` from the closed configuration vocabulary | `ready` does not prove a write. Status performs no write probe. Reasons are `plugin_data_missing`, `plugin_data_invalid`, `plugin_data_conflict`, `application_data_invalid`, `override_invalid`. |

## Typed passive diagnostics

Every check has `check`, `state`, `observedAt`, `source`, and `executionPlane`. States are `passed`, `failed`, `unknown`, `not_checked`, and `unsupported`. Optional union arms are `facts`, `cause`, `evidenceRefs`, and `nextCheck`; absent data stays absent.

| Field | Exact meaning and producer | Boundary / next check |
| --- | --- | --- |
| `diagnostics.snapshot` | MCP status observation time | It dates this response, not every nested source observation. |
| `diagnostics.runtime.facts.nodeVersion`, `diagnostics.runtime.facts.platform`, `diagnostics.runtime.facts.arch`, `diagnostics.runtime.facts.bridgeVersion`, `diagnostics.runtime.facts.mcpProtocolVersion` | Current Node process and negotiated MCP metadata | It does not identify a hook process or host UI. |
| `diagnostics.client.facts.name`, `diagnostics.client.facts.version`, `diagnostics.client.facts.provenance` | Bounded strings retained from MCP initialize; provenance is `client_reported` | It is not a trusted host-session identity or proof of hook support. Malformed/oversized input is omitted. |
| `diagnostics.listener.facts.operation`, `diagnostics.listener.facts.listenerState`, `diagnostics.listener.facts.systemCode` | Existing bind observation; operation is `bind_listener`. An observed code is allowlisted as `EACCES`, `EPERM`, `EADDRINUSE`, `EADDRNOTAVAIL`, `EAFNOSUPPORT`, or `EINVAL` | Causes are `address_in_use`, `listen_failed`, or `unknown`. A healthy secondary makes `address_in_use` passed. A system code does not identify the OS policy that produced it. |
| `diagnostics.pairingSource.cause` | Latest source-owned safe classification. `permission_denied` means the token source returned an access-denied system result. On non-Windows systems, `insecure_permissions` can mean unsafe mode or ownership, an unexpected directory or file type, a symlink, or replacement of the checked directory during the read. | Causes are `permission_denied`, `insecure_permissions`, `missing`, `corrupt`, `unsupported`, or `io_error`. These classifications do not identify the operating-system policy, affected object, or safe repair. Do not infer a grant/restriction action or a successful repair from them. No path, token, owner, environment value, or raw exception is exposed. |
| `diagnostics.routeFreshness.facts.lastObservedAt` | Time of an actually observed route response, when a producer supplies it | No current producer supplies a freshness time, so the check is `unknown` with next check `observe_extension_heartbeat`; `browserContext.changedAt` is never substituted. |
| `diagnostics.storage.facts.scope`, `diagnostics.storage.facts.targets` | Sanitized copy of resolved targets; scope is `configuration` | It does not establish writability. A future explicit storage I/O fact is the discriminating check. |

Unknown future fields and enum values must be preserved as data by consumers but must not receive an invented interpretation. Raw paths, secrets, environment values, browser payloads, and error messages are outside this contract.

## Independent bootstrap doctor

`node mcp/src/doctor.mjs --json` runs outside the MCP lifecycle and returns
`{"schemaVersion":1,"checks":DiagnosticCheck[],"limitations":DoctorLimitations}`. Collection exit status is 0 even
when individual checks fail; status 1 means the doctor could not form valid output. It reads metadata and resolves
configuration but performs no write, listener, pairing, retention, extension, authorization, or business operation.

Doctor checks use the shared check fields and state/cause vocabularies above. `runtime` describes the executing Node
process. `storage` reports the same configuration-only target facts described above. `package_layout.facts.layout` is
`canonical_source` or `installed_plugin`; it describes where the running file resides and is not proof of host
installation. `package_metadata.facts.name` and `.version` validate the canonical npm package. Installed layout instead
uses `codex_manifest.facts.name` and `.version`, plus `mcp_configuration.facts.transport`, `.command`, `.cwd`, and `.entrypoint`.
`entrypoint` checks only that the referenced server file exists and never imports it. Metadata and entrypoint failures use
the closed causes `missing`, `corrupt`, or `io_error`. Versions must use the bounded Node/npm release-version grammar;
malformed values make their metadata check corrupt and are never copied to output. The installed command is valid only
with the packaged `cwd:"."` and relative `mcp/src/server.mjs` entrypoint.

The doctor fact shapes are exact: `package_layout.facts.layout` is derived from the running doctor's location;
`package_metadata.facts.name` and `.version` come from canonical npm metadata; `codex_manifest.facts.name` and
`.version` come from the installed Codex manifest; and `mcp_configuration.facts.transport`, `.command`, `.cwd`, and
`.entrypoint` come from installed `.mcp.json`. The `entrypoint`, `operation_receipt`, `runtime_snapshot`, and
`host_hook_context` checks have no `facts`; state, cause, source, and execution plane carry their observation. Missing
facts are not lost positive evidence.

`limitations.hostInstallation`, `.hostEnablement`, `.hookTrust`, and `.otherExecutionPlanes` are always `not_checked`:
a read-only device command cannot establish those facts. A separately observed host launch error belongs to the invoking
agent's host context and is not accepted through ordinary process environment or echoed by the doctor.

## Scoped diagnosis and operation receipts

`e_comet_diagnose` accepts `scope` (`installation`, `runtime`, or `last_operation`) and `mode` (`passive` or
`safe_probes`). `operationHandle` is required only for `last_operation`. `probes` is an allowlisted array containing
`storage_write`, `extension_snapshot`, `hook_permissions`, `extension_install`, and/or `codex_mcp_auth`; a probe runs only in `safe_probes` and only in its applicable scope.
The response fields are `schemaVersion:1`, the echoed `scope` and `mode`, `checks: DiagnosticCheck[]`, and optional
`operation`. Passive installation checks are the in-process doctor checks above. Passive runtime checks are the current
status collectors; neither path starts lifecycle work. Missing or stale operation handles produce an
`operation_receipt` check in state `unknown` and never substitute the latest operation.

The installation `storage_write` probe operates separately on each configured target. Its `facts.target` names the
logical configured target, never its path. `facts.steps[]` may record `operation` values `create`, `identify`, `write`,
`read`, `close`, and `remove`, in reached order. Every step has `state` (`passed`, `failed`, or `not_checked`) and may
have a filesystem `systemCode` when Node supplies one. The probe also generates `EIO` when read-back bytes differ and
`IDENTITY_CHANGED` when the created path no longer identifies the same file. `systemCode` is omitted when no code is
available. A step may instead have `reason:"identity_unavailable"`; `reason` is omitted otherwise. It opens only an unpredictable probe file with exclusive creation and removes that
exact file in `finally`. A missing target directory yields `not_checked` with cause `directory_absent`; this observation
does not claim why the directory is absent or whether the normal writer can create its directory. A failed removal is
retained as a failed `remove` step. Removal is attempted only after successful exclusive creation and only while the
path still identifies the created file; a collision or replacement is preserved. A failed close is retained as a
`close` step without hiding the separate removal outcome. If identity observation fails after exclusive creation,
`identify` is failed, the acquired handle is still closed, and `remove` is `not_checked` with reason
`identity_unavailable`; the unverified path is preserved. Existing result, workbook, and feedback retention passes do
not own the diagnostic filename grammar, so they do not promise to remove that rare tiny residual file. The runtime
`extension_snapshot` probe requests one capability-negotiated, read-only extension snapshot. It returns `unsupported`
without sending a diagnostic frame when the connected extension or authenticated primary did not advertise the route.
It makes no marketplace request. `unsupported` says nothing about installation or activation, and it does not
identify which side lacks the route, the extension build or the primary process; it does not support prescribing an
extension update. The next discriminating check is the installation `extension_install` probe; activation stays
unobserved on this route. `not_checked` with cause `unavailable` (source `device_process`) means no connected extension
was reachable, directly or through the primary, so nothing was asked: the observation is a missing connection, never a
missing capability, and the bridge status names the next step. `unknown` with cause `unavailable` (source
`device_process`) means the device stopped waiting at its own deadline before an answer arrived, or the request was
abandoned by a bridge shutdown; it says nothing about the extension. `failed` with cause `corrupt` means a connected extension
answered with a snapshot that did not match the negotiated `diagnostic_snapshot_v1` shape; the request settles at once
rather than at its deadline, and the mismatch is an e-Comet defect to report, not a user change.

The installation `hook_permissions` probe asks native Codex `hooks/list` for the e-Comet plugin hooks resolved in the
MCP process working-directory context. It starts one bounded read-only `app-server --stdio` configuration inspector;
the default five-second diagnostic wait accommodates cold startup beyond two seconds and does not retry. The inspector performs only protocol initialization
and `hooks/list`; it does not create a task, invoke a model or tool, start MCP lifecycle work, or write hook trust and
enablement. On success, `facts.context` is `configuration_snapshot`: this proves persisted configuration for that directory,
not that a hook ran in the current task. Successful `facts.hooks[]` contains only canonical e-Comet hook family, event, enabled
state, and trust status; commands, paths, hashes, raw warnings and errors, and unrelated hooks are not returned.
`installationMatch` and `currentApplicationMatch` remain `not_verified`: reading local configuration does not identify
the installed package copy or the application that owns the current task.
`status:"ready"` requires the seven Codex-supported e-Comet handlers to be present exactly once, enabled, and trusted
or managed. `disabled` and `review_required` are separate failures; missing, partial, duplicate, and unknown inventories
do not pass. Codex currently omits the packaged `PostToolUseFailure` handler because this native host version does not
support that event. If the inspector cannot return a snapshot, the check is `not_checked` and inventory fields are omitted.
When the device stops waiting on its own inspector instead, the check is `unknown` with cause `unavailable` and source
`device_process`, the same way an abandoned snapshot request is recorded: our own deadline is never a Codex fault.
Its separate `configuration_probe` facts contain only `status:"failed"` and a closed failure `{reason,phase}`: reason is
`timeout`, `process_missing`, `permission_denied`, `process_closed`, `protocol_error`, or `response_too_large`; phase is
`startup`, `initialize`, `request`, `response`, or `transport`. These values distinguish the observed probe boundary
without preserving commands, paths, server messages, or raw errors. They do not establish disabled or untrusted hooks.
Claude Code exposes its read-only `/hooks`
browser, but this probe establishes no programmatic Cowork trust endpoint.

The installation `extension_install` probe reads Chromium profile metadata with plain file reads and never spawns a
process. It checks the user-data roots of Google Chrome, Microsoft Edge, Yandex Browser and Opera for the current
platform; other browsers are not checked, and their absence from `facts` means unchecked, not uninstalled. Per
browser it lists profiles from `Local State` (`profile.info_cache`), falling back to `Default` alone with
`profileSource:"default_only"`, which means partial coverage. Opera also checks its root profile when a `Default`
directory is absent. A profile counts as installed when a matching extension manifest is found under
`Extensions/<id>/<version>/manifest.json`. Its state follows a closed table read from `Secure Preferences`
(or `Preferences`): `disable_reasons` empty → enabled; `disable_reasons` a non-empty integer list → disabled; the
legacy `state:1` without `disable_reasons` → enabled; anything else, including a missing record, → unknown. A file
that reads fine can still leave the state unknown; that is neither a read failure nor "disabled".

The fact shape is
`extension_install.facts.{extensionId,browsers[].{browser,profileSource,profilesChecked,installedProfiles,enabledProfiles,unknownProfiles,readFailures,versions[],lastUsedDaysAgo?}}`.
`lastUsedDaysAgo` is the whole number of days since the newest modification time of the browser's `Local State` and
the checked profiles' preference files, obtained by `stat` without reading them. It measures file age, not browser
use: Chromium rewrites those files while the browser runs, so a recent value usually means a recent run, but other
software can touch the files too, and an old value proves only that the successfully stat'ed checked files have not
changed. It is omitted when none of those files could be stat'ed. It never identifies the browser the user is working
in right now: order candidates by
it and mention a long-unchanged browser, but leave the choice to the user. When the extension is connected,
`extension.version` in `local_bridge_status` is the connected copy's version; a checked browser whose `versions[]`
contains it is a likely candidate, not the proven source: unchecked browsers, unchecked profiles and unpacked copies
can hold the same version.
`browser` is `chrome`, `edge`, `yandex`, or `opera`; `versions` holds distinct versions read from manifests in the
safe version grammar, never directory names. Profile names, paths, account e-mails and every other preference field
never enter the facts. States: `passed` when every found root was read; `unknown` with cause `permission_denied` or
`io_error` when a read failed (partial facts are retained); `not_checked` with cause `directory_absent` when no known
root exists. Inference boundaries: `installedProfiles:0` everywhere supports absence only in checked browsers and
profiles when metadata reads succeeded; partial or failed reads do not support absence. "Disabled" is supported only
when `installedProfiles>0`, `enabledProfiles:0` and `unknownProfiles:0` with complete metadata reads; any
`unknownProfiles>0` forbids the word "disabled". `enabledProfiles>0` names a candidate browser, not the browser the
user works in; the probe never proves that the extension is connected or activated. Activation of a connected
extension is observed by the runtime `extension_snapshot` probe (`activationIdentity.state`), because an unactivated
extension still connects to the local bridge.

The installation `codex_mcp_auth` probe makes one bounded native `codex mcp list --json` call. It reports a
configuration snapshot, not the current Desktop runtime connection, and selects exact configured names from our
`.mcp.json`: `e-comet` (remote) and `e-comet-local` (local). The CLI provides no plugin identity, so a name match
cannot attest that a server belongs to this installed plugin; `installationMatch` stays `not_verified`. Facts are
`{host:"codex",context:"configuration_snapshot",inspector:"cli_config_reader",status,installationMatch:"not_verified",servers[].{role,authStatus,enabled?}}`.
`authStatus` is `unknown`, `unsupported`, `notLoggedIn`, `bearerToken`, or `oAuth`, normalized from CLI snake-case
words. `enabled` appears only when the CLI supplied a boolean. A disabled remote entry is not treated as active
sign-in evidence. Server names, URLs, credentials, foreign server metadata and tool schemas are never returned.
`status` is `not_logged_in` (configuration reports sign-in incomplete; qualify the statement),
`credentials_present` (stored credentials are unvalidated; a real `info` call or host auth error can clarify),
`unknown_status`, `missing` (no remote name; state `not_checked`, cause `missing`), or `ambiguous` (duplicate target
names; state `unknown`, cause `unknown`). Malformed JSON, nonzero exit, unavailable CLI, timeout or oversized output
yields `not_checked`, cause `unavailable`, without projecting raw output. The command has a 20 s and 2 MiB stdout
bound; its child is killed on timeout or excess output. Firm Connect wording needs a real host authorization error
or notice, not this CLI snapshot. The Codex Desktop action is Settings → Plugins → e-Comet MCP Tools → server E-comet
→ Connect; CLI commands are not user actions. Claude uses its own host connector evidence.

Every storage-write result is evidence only about the probe's own temporary file, configured target, execution plane,
and observation time. A code such as `ENOSPC` proves that the corresponding probe step failed for that reason; it does
not prove that an earlier business artifact was unsaved or caused an earlier operation to be uncertain. Correlate a
business result only with its own operation receipt. Storage remediation may prepare future work, but it never permits
repeating an uncertain create or upload.

The extension fact shape is
`extension_snapshot.facts.{protocolVersion,observedAt,extensionVersion,capabilities[],activationIdentity.state,storageRead.state,ports.wb,ports.wbSeller,ports.ozon}`.
The nested time is the extension observation time. Activation is `present`, `absent`, or `unknown`; storage is
`passed`, `failed`, or `unknown`; every port is `true`, `false`, or `unknown`. Capabilities are extension-reported.
Ports describe in-memory registration rather than login or operation readiness. A peer-forwarded snapshot still
originates at the extension route on the device.

Runtime diagnosis also returns `host_hook_context` with `state:"not_checked"`, `source:"device_process"`,
`executionPlane:"device"`, and `cause:"unavailable"`. The device MCP has no demonstrated channel for reading context
that a host delivered to its model. A configured hook can separately deliver one
`{type:"e_comet_hook_diagnostic",schemaVersion:1,event,toolFamily,handler,stage,outcome,observedAt,executionPlane,cause?,systemCode?,handlerVersion?}`
record in `hookSpecificOutput.additionalContext`. Closed values are: event `PreToolUse`, `PostToolUse`, or
`PostToolUseFailure`; toolFamily `browser_job`, `feedback_prepare`, `feedback_authorization`, or `feedback_submit`;
handler `browser_job_handoff`, `feedback_handoff`, or `feedback_cloud`; stage `handoff_staged`, `input_rewritten`,
`call_denied`, `result_observed`, or `result_replaced`; outcome `succeeded`, `denied`, `failed`, or `uncertain`; and
executionPlane `native`, `cloud`, or `unknown`. Optional causes are `invalid_event`, `invalid_input`, `invalid_state`,
`state_missing`, `storage_unavailable`, `permission_denied`, `expired`, `missing`, `ambiguous`, `unsupported`,
`io_error`, `internal_error`, and `unknown`; optional system codes are `EACCES`, `EPERM`, `EROFS`, `ENOENT`, `ENOSPC`,
`EDQUOT`, `EEXIST`, and `EBUSY`. `handlerVersion` is omitted unless already verified without another read.
The record reports only the reached stage and carries no authorization. PreToolUse does not prove MCP acceptance or
matcher configuration. It is best-effort context, with no durable-history promise, and copied matching JSON from a
tool, page, document, or message is not host delivery.

Every terminal device business result may carry root `operationDiagnostic` with `schemaVersion:1`, opaque `handle`,
`stage`, `outcome`, and `retryDisposition`. Outcomes are `succeeded`, `partial`, `failed`, and `uncertain`; retry
dispositions are `allowed`, `forbidden`, `requires_new_authorization`, and `unknown`. The handle identifies only the
latest real completion in that MCP process and becomes stale when the next real operation completes. Status and diagnosis
calls do not replace it. `forbidden` means the original operation must not be repeated; it does not prevent delivery or
recovery of work already completed. `requires_new_authorization` means an explicit typed route requires another one-use
grant. `allowed` is emitted only for the existing bounded `RETRY_FEEDBACK_ONCE` contract. Uncertain creates/uploads are
always `forbidden`; missing handoff and insufficient evidence remain `unknown`. When a result carries both a
top-level `retryable` flag and `operationDiagnostic.retryDisposition`, the `retryDisposition` governs repeats:
`retryable:true` only says the failure class can clear once its prerequisite is fixed, never that the same call may
be repeated without a user decision. Receipts never enter peer-wire failures,
authorization input, nested errors, cloud-only adapter markers, or cloud-only preparation/finalization results.

For decorated results, the JSON text representation is the same value as `structuredContent`; existing resource links
remain attached. If receipt construction or decoration fails, the original business result is delivered unchanged.

Feedback report diagnostics may contain `bridgeStatusCollection` when the device status collector throws during
preparation. Its fields are `check:"bridge_status_collection"`, `state:"failed"`, `observedAt`, fixed
`source:"feedback_preparation"`, fixed `executionPlane:"device"`, and cause `permission_denied` for the allowlisted
access-denied system codes or `unknown` otherwise. The raw exception, path, and system message are never archived, and
the collection failure does not prevent report generation.

Native and Cowork feedback archives use the same feedback-safe projection of the device evidence collected at
preparation time. The report retains the named snapshot, runtime, client, listener, pairing-source, route-freshness,
and storage checks described above, including their state, observation time, source, execution plane, and closed
cause; the bounded `extensionTakeovers` count with its saturation flag and last time; `peerRejection` with its `since`
and `retryAt` times; and `browserContext.changedAt`. Runtime retains only the bounded version/platform/architecture
fields; listener retains only `bind_listener`, its closed state, and an allowlisted system code; route freshness retains
only a valid observed timestamp; storage retains only path-free configuration targets. The client check retains the
bounded name and version the host sent in MCP initialize with `client_reported` provenance: it names the Claude or
Codex runtime, not a trusted host identity. The report's `## Host` section repeats it next to the preparation `route`,
`native` for the device dispatcher and `cloud` for the Cowork hook, which is what tells a Cowork archive from a Claude
Code archive prepared on the same device.

Preparation additionally collects, in parallel, one read-only `extension_snapshot`, recorded as `not_checked` with
cause `unavailable` without any request when no extension route is connected; the passive installation checks
`package_layout`, `package_metadata` or `codex_manifest`, `mcp_configuration`, and `entrypoint`; the `extension_install`
probe; and, only when the client name identifies Codex, the `hook_permissions` probe. Every probe is abandoned at the
same five-second evidence deadline instead of the business deadline, so a stalled read or inspector can cost seconds
but never the report; an abandoned snapshot request is the `unknown` observation with cause `unavailable` above. Each
probe result is the same closed check the doctor and `e_comet_diagnose` produce, admitted through the producer's own
fact schema: a check whose facts leave that schema is dropped whole rather than kept without them, while the snapshot
keeps every safe capability and omits a non-canonical time or an empty version instead of losing the observation. A
probe that throws contributes nothing; one that observes a failure contributes that closed observation with its cause,
and the snapshot and `hook_permissions` probes record the device's own abandonment rather than vanishing. No probe
blocks preparation. The remote sign-in and storage-write probes are not collected: `report_issue` is itself a
remote call, and preparation already writes the archive. Paths, URLs, tokens, free-form errors, arbitrary facts,
evidence references, suggested next checks, unknown slots, and future properties are excluded. Cowork carries this
projection, bounded at 16 KiB, in the nonce-bound versioned prepare response and validates the complete response
before creating the immutable archive. Mixed adapter versions fail closed and require updating the older plugin half
and starting a fresh cloud task; the upload transport and archive bytes are unchanged.

The report's `## Tool calls` section lists the newest hundred calls of the session in call order, each with the host's
record time when it wrote one, the safe tool name, and the closed outcome read from the correlated result: `ok`,
`status`, the `code` and `stage` in their identifier grammars from the top level of a failure envelope or from its
`error` object, and `is_error` when the host flagged the result. `status`, `code` and `stage` are read only for an
e-Comet tool — this server's own, and the remote MCP's recognized by its whole name — while any other server's call
keeps `ok` and the host flag alone. The fields come from whichever
text block of the result parses as a JSON object, including a recorded CallToolResult envelope and the exec wrapper of
Codex; prose is never parsed, so a hook denial recorded as text carries no outcome, and a text block larger than one
MiB is skipped rather than parsed, so a result that carries no smaller JSON block contributes only the host flag. A
call whose result carried no closed field renders `outcome unknown` rather than a line that reads like success. Codex calls are the `response_item` records of the rollout correlated by call id. When
more calls exist, one line states how many earlier calls are omitted, and a partially read session says so before the
list.
