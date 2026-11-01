# `local_bridge_status` technical reference

`local_bridge_status` is a passive snapshot. It does not connect to a broker, repair the browser-host registration, wait, probe storage, open a browser tab, obtain authorization, or make a marketplace request. `ok=true` means only that the status response was produced.

e_comet_diagnose with runtime scope, safe-probes mode, and the extension-snapshot probe uses the negotiated diagnostic_snapshot_v1 route. Its facts contain protocol version, observation time, extension version, capabilities, activation state, storage-read state, and the WB, WB Seller, and Ozon port-registration states. Activation is present, absent, or unknown; storage is passed, failed, or unknown; each port is true, false, or unknown. A port value proves registration rather than operational readiness. The probe performs one activation-storage read and observes the extension's in-memory port registry. It does not open, reload, ping, switch, dispatch, cancel, authorize, or call a marketplace. An older extension reports unsupported.

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
| `device_clock_ahead`, `device_clock_behind` (with integer `skewMinutes`) | user | This computer's clock differs from e-Comet's by more than a minute; the message names the skew. The user syncs the system clock, then one fresh authorization on the user's decision. |
| `storage_unavailable` | user, then e-Comet | The browser could not read or write the extension storage. The user restarts the browser, then one fresh authorization; if it repeats, offer a report. |
| `unknown` | — | Report. |

`errorDetails.code:"WB_NOT_AUTHENTICATED"` on a buyer product unit (`products[].units[].errorDetails`)
is produced by the extension page script when the Wildberries page carries no session token for a request that
requires one. It is the only code that supports a "not signed in to wildberries.ru" conclusion; the action is to
sign in in the browser and profile that made the request. A timeout, `WB_FETCH_FAILED` or an expired session token
does not produce this code.

## Missing authorization handoff

A signed local tool answers `code:"BROWSER_JOB_HANDOFF_REQUIRED"` (`stage:"handoff"`, `retryable:false`) when it was called without `triggerUrl` (the message names Codex hooks awaiting approval as the usual Codex cause), or with one that is not a browser job (the message then says the trigger URL is not usable, or too large); the Ozon tools answer `OZON_AUTHORIZATION_REJECTED` with the message "The trusted browser-job hook did not provide Ozon authorization." for the same condition. Outside Cowork, model-authored arguments must omit `triggerUrl`, so this means the host `PreToolUse` hook did not run or did not rewrite the input: the plugin hooks are not trusted, are disabled, changed after a plugin update, or the host does not run plugin hooks in this task. It is not a marketplace, extension or e-Comet account failure, and `browser_job` was already called once. Do not call `browser_job` or the local tool again until the hook condition is resolved: each repeat spends one signed authorization and fails the same way. On an observed Codex host, run installation `hook_permissions` (`safe_probes`) and follow its `disabled`, `review_required` and `not_checked` guidance below; the user action is to enable and trust all e-Comet hooks at once in Settings → Plugins → Personal → e-Comet MCP Tools → Hooks, since Codex asks again after every plugin update. On Claude Code, `/hooks` lists the configured hooks. On Cowork, where the local tools are named `mcp__remote-devices__...`, the host refuses a device call whose arguments a hook changed, so the model passes `triggerUrl` itself there and this code means the call lacked it: pass `trigger_url` from the same `browser_job` result, unchanged, as `triggerUrl` and call the local tool once more, without a new `browser_job`. The receipt is `outcome:"failed"`, `retryDisposition:"unknown"`. A hook that refuses the call itself answers with a `HANDOFF_*` denial instead; see Hook denials below.

## Seller cabinet codes

`wb_seller_reviews` exports run inside the signed-in Wildberries seller cabinet tab (seller.wildberries.ru) in the
browser where the extension is connected. `SELLER_LOGIN_REQUIRED` (`stage:"execution"`, `retryable:false`) means the
extension found no signed-in cabinet tab: the user opens the cabinet there and signs in; the package aborts, and one
fresh `browser_job` follows on the user's decision. `SELLER_AUTH_UNAVAILABLE` with the same stage means a cabinet tab was
selected but the extension could not read the page's own request credentials within its bounded wait; the
`reason` in the error's details says which. For a missing token (`access_token_missing`, `seller_token_missing`, `both_missing`)
the user reloads the seller portal tab and signs in if it asks, then one fresh `browser_job` for the remaining exports
on the user's decision. If the same reason comes back, it is an e-Comet defect to report (the extension reads the
tokens from the page's storage, whose keys Wildberries has renamed before): repeating again spends authorizations
without changing the outcome. `header_too_long` (the sign-in data exceeds the extension's own limit) and
`reader_failed` are e-Comet defects to report at once.

## Existing status contract

| Field | Producer and exact meaning | Inference boundary / next discriminating check |
| --- | --- | --- |
| `ok` | MCP dispatcher; response construction succeeded | It is not product health. Inspect the typed checks and the selected operation. |
| `extensionConnected`, `browserJobSupported` | Whether this process holds an extension session through a broker, and whether that extension announced signed browser jobs | They do not prove login, hook execution, or a particular operation. Call the selected typed tool. |
| `state` | Ordered compatibility summary: `initializing` (the first broker connect attempt is in flight), `waiting_for_extension`, `extension_connected_no_wb_tab`, `extension_context_unknown`, `ready`, or `extension_update_required` | It is neither a complete fault list nor permission to run/retry a business operation. |
| `bridgeVersion`, `extensionProtocolVersion`, `instanceId` | Local build metadata and the identifier of this process | These fields do not prove that a route works. |
| `extension.state`, `extension.route`, `extension.version`, `extension.lastConnectedAt`, `extension.lastDisconnectedAt` | Derived effective extension observation; states are `never_connected`, `connected`, `disconnected`; route is `direct` while this process holds a broker session, otherwise `none` | Retained version/time after disconnect is valid. A version is not an integrity or end-to-end check. |
| `extension.ozonSellerPromotionReportSupported`, `extension.ozonSellerPromotionReportsSupported`, `extension.ozonSellerAnalyticsReportSupported`, `extension.ozonSearchPositionsSupported`, `ozonSellerPromotionReportSupported`, `ozonSellerPromotionReportsSupported`, `ozonSellerAnalyticsReportSupported`, `ozonSearchPositionsSupported` | Capability reported by a connected extension; the top-level fields are legacy copies | Absence means unobserved, not `false`; the typed Ozon tool remains authoritative. |
| `extensionLastConnectedAtMs`, `extensionLastDisconnectedAtMs`, `extensionVersion` | Compatibility copies of effective extension observations | Copies are not independent evidence. |
| `browserContext.state`, `browserContext.wbTabConnected`, `browserContext.sellerTabConnected`, `browserContext.changedAt` | Extension-reported registered WB and WB Seller ports; state is `known` or `unknown` | Registered ports are not authenticated sessions. `changedAt` is not a freshness check and says nothing about Ozon. |
| `storage.results`, `storage.marketplaceArtifacts`, `storage.feedbackArtifacts` | Resolved configuration. Each target has `state`: `ready` with `backend` `plugin_data`, `application_data`, or `override`, or `unavailable` with `reason` from the closed configuration vocabulary | `ready` does not prove a write. Status performs no write probe. Reasons are `plugin_data_missing`, `plugin_data_invalid`, `plugin_data_conflict`, `application_data_invalid`, `override_invalid`. |

## Cause code and broker fields

`code` is the field to read first. It is one closed value that the bridge sets from what it observed; the fields below
are the evidence behind it and none of them is a recovery instruction. The bridge reaches the extension only through
the broker that the browser starts; status reports what this process last observed and never connects, repairs or
waits to produce it.

| Field | Producer and exact meaning | Inference boundary / next discriminating check |
| --- | --- | --- |
| `code` | Cause classification set by the bridge. `connected`: an extension route is observed. `connecting`: the bridge is still starting, or a tool call is waiting up to 30 s for a broker about to appear. The other values are the causes from the table below; `BRIDGE_NO_BROWSER` is the one used when nothing more specific was observed. A route lost mid-job is the failing tool call's EXTENSION_DISCONNECTED, never a status code: status then names the cause found since. | It classifies the bridge, not a marketplace, a login or a particular operation. A value that is not listed is kept as data and given no invented meaning. |
| `registration.state`, `registration.version`, `registration.runtime`, `registration.manifestWrittenAt`, `registration.error`, `registration.error.name`, `registration.error.code` | The last browser-host registration check made by this process; `registration` is null until one ran. State is `registered` (something was written), `current` (already up to date), `disabled` (this run registers nothing), `failed` (a step failed) or `denied` (macOS refused a browser folder). Any other refused browser folder makes it `failed` only when no folder holds the manifest; otherwise it stays `registered` or `current` with the refusal in `registration.error`. Runtime is `path_node` (Node found on PATH) or `host_executable` (the host application's own executable), null when none was resolved. `registration.manifestWrittenAt` is the ISO time of the newest host manifest, null when unknown. `registration.verifiedSinceAt` is the ISO time since which what the browser reads (the manifest, the launcher and, on Windows, the registry key) has stayed unchanged: rewriting identical content keeps it, and a key that a repair found missing or different starts it again; null when unknown. `registration.runtimeRecheck` is `not_run` (no repair, or the launcher was just written), `passed` (a repair started the launcher's runtime with -v and it answered as Node 22 or newer), `repaired` (it was missing or answered an older version, and the launcher now names another runtime), `failed` (it was missing or older and no other runtime was found; the launcher is left as it is) or `inconclusive` (the answer proved nothing: a start this process may not make, such as another host's packaged executable, a timeout, an exit or no version; the launcher is left as it is). `registration.error` names the failed step and its system code, null without a failure. | Registration says where the browser would start the broker from, not that a browser did. The error carries a step name and a code, never a message or a path. |
| `userLevelHosts` | One item per browser: the browser; `allowed`, whether its NativeMessagingUserLevelHosts policy allows hosts registered per user (true, false, or null when no policy is set); and `hostBlocked`, whether its NativeMessagingBlocklist and NativeMessagingAllowlist policies block the e-Comet host io.ecomet.bridge (true when the block list holds `*` or the host and the allow list does not name it, false when the lists do not block it, null when no block list is set). Only mandatory policies count, as in the browser; recommended ones are ignored. Empty when no policy was read. Read at start, on a tool call that finds no broker and in a diagnosis, not in the background, so between them it can be out of date. | A false `allowed` or a true `hostBlocked` is a policy somebody set, not a fault of the installation. |
| `extensionInstall` | The facts the extension_install probe returns, in the shape documented for e_comet_diagnose; null until a probe ran. | Profile metadata only. It never proves that the extension is connected. |
| `brokers` | Live broker entries, newest first. Each item has the process id, the browser the extension reported, the extension and broker versions, the ISO start time, and whether this process is connected to it. Empty when none runs. | An entry never carries the nonce or the endpoint. A listed broker does not prove that a job will succeed. |
| `lastFailureRecord`, `lastFailureRecord.name`, `lastFailureRecord.code`, `lastFailureRecord.at` | The newest broker failure record that is newer than every live entry, the newest manifest write and this process's last good session; older records are ignored and deleted. Null when there is none. | A record names an error and its code, never a message or a path. It counts toward a cause while the probe shows an install enabled on a native-capable extension build, or when it is newer than the registration's last change. |
| `policyReadFailed` | The browsers whose native messaging policy read observed nothing: a timeout, or a reader that did not start. Their `userLevelHosts` values are null because nothing was seen, not because no policy is set. Empty when every read worked; the bug report's bridge block carries the same list when it is not empty. | An unread policy is a possible cause, not a proven one: a browser whose policy was read and admits the host is chosen first. |
| `owner` | Who can act on the cause in `code`, by the assignment in the table below: `user`, `administrator` (whoever manages the computer), `e_comet`, or `unknown`. Absent while `connected` or `connecting`. | The failing tool call carries the owner in its message wording only. `unknown` is a start failure no fact narrowed: follow the guided steps, then report. |
| `comspec` | `valid`, `invalid` or `unknown`: whether the Windows ComSpec environment variable names an existing cmd.exe, which the browser needs to start the connector. Read in-process by the last tool call that found no broker or runtime `extension_log` probe; present only on Windows while the code is `BRIDGE_HOST_START_FAILED`. `unknown` means this process has no ComSpec: it sees its host's environment, not the browser's, and a host may leave the variable out. | `invalid` makes the owner `administrator`. `valid` rules this one cause out and nothing more; `unknown` rules nothing in or out. |
| `clientProtocolVersion`, `brokerProtocolVersion`, `brokerVersion` | The client protocol version this plugin speaks, the one the connected broker reported, and that broker's plugin version. The last two are null without a broker session. | Different versions are a fact to report, not a reason to retry. |
| `transportEvents` | The last 32 transport events this process saw, oldest first, each with `at` (when it was first seen), `kind` and `code`. Kinds: late_answer (an answer arrived for a request that had already settled, usually after its timeout; the code is the answer's own typed code or what kind of answer it was), connect_failed (a broker entry exists but the connect failed; the code is the system code or the closed outcome), session_end (the session ended; the code is the broker's reason, the broken stream's code, or closed), registration_step_failed (the failed step and its system code joined, such as ManifestWrite_EPERM) and failure_record_seen (a broker failure record, named the same way, seen before a later start deletes it). A repeat of the newest event is not listed again. The bug report carries the same list within its own 4 KiB. | Codes are short identifiers, never a request id, a path or a message. An event is a fact about the transport; it names no cause by itself. |

| Cause | Observed condition | Owner and supported next step |
| --- | --- | --- |
| `BRIDGE_NO_BROWSER` | No live broker entry and none of the more specific causes below was observed, including no install observed or an unreadable profile. | User: open the browser that has the e-Comet extension (the named browser when the probe saw one; install it from the Chrome Web Store if it is missing), click the e-Comet icon, accept the permission the browser asks for, then repeat the request; if it still fails, apply the extension update or restart the browser, then report it. |
| `BRIDGE_HOST_NOT_STARTED` | No live broker entry, and the browser that would be chosen has the extension enabled on a native-capable build, a policy that admits the host, and a process singleton showing it running for at least 30 s: its extension had the time to start the connector and did not. The extension's own log, when it could be read, names none of the log causes below (`BRIDGE_HOST_NOT_FOUND`, `BRIDGE_HOST_FORBIDDEN`, `BRIDGE_HOST_START_FAILED`, `BRIDGE_BROKER_NOT_VISIBLE`, or a policy block as `BRIDGE_HOST_BLOCKED`), or the browser lists the profile it was read from as closed. When that browser's policy could not be read (`policyReadFailed`), the message adds that an administrator policy on this computer may block the connector. | User: click the e-Comet icon in the profile where e-Comet is installed (open that profile if it is closed), then repeat the request; if it still fails, report it and also write to e-Comet support in the chat on app.e-comet.io from that profile, which can attach the extension's log. |
| `BRIDGE_HOST_NOT_FOUND` | For the browser that would be chosen, the extension's own log (the extension log check) shows the browser answering "not found" for the connector in this run of the browser, with no connection since, while the registration had stayed unchanged for at least 20 s when the log was read, longer than the extension's 15 s search interval. A registration this call has just restored is decided by a later read of the log, never by status on its own clock. | e-Comet: the browser does not see the connector's registration, and repeating does not help. Report it. |
| `BRIDGE_HOST_FORBIDDEN` | The extension's log for that browser shows a "forbidden" answer since the registration last changed and no connection since, or a run of "forbidden" answers still open in this run of the browser while the registration had stayed unchanged for at least 20 s when the log was read (the extension writes only a run's first answer, so a later registration change does not end it), or the extension refused to open the connector because its own ID is not the one it was built for, with no connection since. | e-Comet: this copy of the extension is not from the Chrome Web Store, or an e-Comet defect. Report it. |
| `BRIDGE_HOST_START_FAILED` | The extension's log for that browser shows the connector started after the registration last changed and after the browser started, and ending before it answered (the browser's "exited", "failed to start" or "communication" answer, or the extension's own handshake timeout), with no connection since, while no broker entry and no failure record exist: something stopped it before e-Comet's code ran. On Windows, a ComSpec environment variable that does not name an existing cmd.exe narrows it, and the message then names that variable. | Unknown: ask which security program is installed and to check its quarantine or blocked list for e-Comet, then click the e-Comet icon in that browser and repeat (after failed starts the extension waits for an icon click or a browser start); if that does not help, follow the doctor's guided steps and report. With ComSpec: whoever manages the computer restores it, then the user restarts the browser and the agent app and repeats; not a fault of e-Comet or the user. |
| `BRIDGE_BROKER_NOT_VISIBLE` | The extension's log for that browser shows the connector answered in this run of the browser and nothing closed it since, but this process finds no broker entry or none it can connect to: the profile with e-Comet may have been closed (that writes no row), or the connector runs under another user account or app. | User: click the e-Comet icon in the profile where e-Comet is installed (open that profile if it is closed), then repeat the request; if it still fails, the connector may run under another user account or app: report it. |
| `BRIDGE_PERMISSION_REQUIRED` | The browser keeps the native-capable extension disabled until the user accepts its new permission. | User: accept the permission in the named browser, then repeat the request. |
| `BRIDGE_EXTENSION_OUTDATED` | No enabled install runs a native-capable extension build. | User: apply the extension update offered on app.e-comet.io or restart the browser, accept the new permission, repeat; report if the version stays old. |
| `BRIDGE_EXTENSION_DISABLED` | At least one install was observed and every observed install is disabled for a reason other than the permission. | User: turn e-Comet on in the extensions page of the browser. |
| `BRIDGE_USER_HOSTS_DISABLED` | The NativeMessagingUserLevelHosts policy is false for every browser that would otherwise be chosen, and none of them blocks the host. | Whoever manages the computer: allow hosts registered per user; after that the user restarts the browser and repeats the request. |
| `BRIDGE_HOST_BLOCKED` | No browser that would otherwise be chosen admits the host, and in at least one of them NativeMessagingBlocklist holds `*` or io.ecomet.bridge while NativeMessagingAllowlist does not name it. The browser then refuses to start the connector ("Access to the native messaging host was disabled by the system administrator."); that close in the extension's log, current in this run of the browser, gives the same code when the registry read saw no such policy (a cloud-managed browser). | Whoever manages the computer: allow io.ecomet.bridge in NativeMessagingAllowlist; after that the user restarts the browser and repeats the request. Not a fault of e-Comet or the user. |
| `BRIDGE_BROKER_UNRESPONSIVE` | A live broker entry exists, and its endpoint did not accept within 2 s, failed with an error that does not prove the entry stale, or accepted and then closed or sent no hello reply within 5 s. | e-Comet: the first step is asking the user to restart the browser and repeat the request; if it repeats, report it. |
| `BRIDGE_BROKER_FAILED` | The registration is `failed`, or a broker failure record is newer than every live entry, the newest manifest write and this process's last good session, and either an install is enabled on a native-capable extension build or the record is newer than the registration's last change (`registration.verifiedSinceAt`): that registration's broker ran and failed. | e-Comet: report it without naming a cause: the message names the failed step and its system code, as in "failed at RegistryWrite, code WMI_CREATE_5", from the registration error or the failure record (UNKNOWN when there was none). Neither alone names the owner: a broker failure record keeps the system code, such as ENOSPC or EPERM, when the computer refused a startup step. |
| `BRIDGE_FRAME_TOO_LARGE` | The broker refused a message for the extension, or the client refused an oversize one before writing; the tool error's message names the refusal code in parentheses (FRAME_TOO_LARGE, FRAME_MALFORMED, AUTHORIZATION_NOT_OWNED, ID_TOO_LONG, SESSION_CONTROL_FORBIDDEN). | e-Comet: our defect; report it. |
| `BRIDGE_MACOS_FOLDER_ACCESS` | macOS denied the manifest write into a browser folder. | User: in System Settings under Privacy and Security, Files and Folders, allow the browser for the application that runs the agent, then repeat. |
| `BRIDGE_UNAVAILABLE_IN_WSL` | The MCP process runs inside WSL. | User: run the agent on Windows; in Codex Desktop turn off running the agent in WSL. |
| `BRIDGE_UNSUPPORTED_PLATFORM` | The MCP process runs on an operating system that registration does not cover: neither Windows, macOS nor Linux. | User: use the agent on Windows, macOS or Linux. |

## Typed passive diagnostics

Every check has `check`, `state`, `observedAt`, `source`, and `executionPlane`. States are `passed`, `failed`, `unknown`, `not_checked`, and `unsupported`. Optional union arms are `facts`, `cause`, `evidenceRefs`, and `nextCheck`; absent data stays absent.

| Field | Exact meaning and producer | Boundary / next check |
| --- | --- | --- |
| `diagnostics.snapshot` | MCP status observation time | It dates this response, not every nested source observation. |
| `diagnostics.runtime.facts.nodeVersion`, `diagnostics.runtime.facts.platform`, `diagnostics.runtime.facts.arch`, `diagnostics.runtime.facts.bridgeVersion`, `diagnostics.runtime.facts.mcpProtocolVersion`, `diagnostics.runtime.facts.osRelease` | Current Node process and negotiated MCP metadata; the OS release is the kernel release os.release() reports, kept only in a bounded version grammar | It does not identify a hook process or host UI. |
| `diagnostics.client.facts.name`, `diagnostics.client.facts.version`, `diagnostics.client.facts.provenance`, `diagnostics.client.facts.hostRuntimeVersion`, `diagnostics.client.facts.hostLastFailure`, `diagnostics.client.facts.hostRestarts` | Bounded strings retained from MCP initialize; provenance is `client_reported`. The host runtime version is present only under the native DeepSeek adapter: the DeepSeek Harness runtime version it resolved its declared peers against, passed through the local module's environment; never the Desktop product version. The same adapter passes, after it started the module again, the closed class of the last failure (`spawn_failed`, `timeout`, `exited`, `protocol` or `unknown`) and how many times it started it again | It is not a trusted host-session identity or proof of hook support. Malformed/oversized input is omitted. A restart count says the module stopped before, not why this call failed. |
| `diagnostics.routeFreshness.facts.lastObservedAt` | Time of the last frame the extension sent over a session; frames the broker writes itself are not counted | Without a frame since this process started the check is `unknown` with next check `observe_extension_heartbeat`; `browserContext.changedAt` is never substituted. A recent frame does not prove the next request will be answered. |
| `diagnostics.storage.facts.scope`, `diagnostics.storage.facts.targets` | Sanitized copy of resolved targets; scope is `configuration` | It does not establish writability. A future explicit storage I/O fact is the discriminating check. |
| `diagnostics.extensionLog`, `diagnostics.extensionLog.facts.reader`, `diagnostics.extensionLog.facts.browser`, `diagnostics.extensionLog.facts.lastTriggerAgoS`, `diagnostics.extensionLog.facts.lastHandshakeAgoS`, `diagnostics.extensionLog.facts.lastClose.class`, `diagnostics.extensionLog.facts.lastClose.agoS`, `diagnostics.extensionLog.facts.lastClose.handshaken`, `diagnostics.extensionLog.facts.missingStreak.open`, `diagnostics.extensionLog.facts.missingStreak.startedAgoS`, `diagnostics.extensionLog.facts.startFailures`, `diagnostics.extensionLog.facts.refused` | The `extension_log` check the last tool call that found no broker, or the last runtime `extension_log` probe made while no extension was connected, read from the browser profile on disk, described with its probe below: reader `read`, `no_log`, `no_profile`, `unreadable`, `format_unknown` or `truncated`; browser `chrome`, `edge`, `brave`, `yandex` or `opera`; close class `host_not_found`, `host_forbidden`, `host_blocked`, `host_exited`, `start_failed`, `communication_error` or `other`; refused `extension_id_mismatch`. Ages are whole seconds before this status observation. Present only after such a read, and dropped once a broker connects. | Status never reads the disk for it. The cause in `code` weighs the read it keeps as of when it was read, so after the user's step run the runtime `extension_log` probe, which re-judges `code` while no extension is connected, or repeat the request that failed; the facts tell what the browser last answered and when. |

Unknown future fields and enum values must be preserved as data by consumers but must not receive an invented interpretation. Raw paths, secrets, environment values, browser payloads, and error messages are outside this contract.

## Independent bootstrap doctor

`node mcp/src/doctor.mjs --json` runs outside the MCP lifecycle and returns
`{"schemaVersion":1,"checks":DiagnosticCheck[],"limitations":DoctorLimitations}`. Collection exit status is 0 even
when individual checks fail; status 1 means the doctor could not form valid output. It reads metadata and resolves
configuration but performs no write, broker connection, registration, retention, extension, authorization, or business operation.

Doctor checks use the shared check fields and state/cause vocabularies above. `runtime` describes the executing Node
process. `storage` reports the same configuration-only target facts described above. `package_layout.facts.layout` is
`canonical_source` or `installed_plugin`; it describes where the running file resides and is not proof of host
installation. `package_metadata.facts.name` and `.version` validate the canonical npm package. Installed layout instead
uses `codex_manifest.facts.name` and `.version`, plus `mcp_configuration.facts.transport`, `.command`, `.cwd`, and `.entrypoint`.
`entrypoint` checks only that the referenced server file exists and never imports it. Metadata and entrypoint failures use
the closed causes `missing`, `corrupt`, or `io_error`. Versions must use the bounded Node/npm release-version grammar;
malformed values make their metadata check corrupt and are never copied to output. The packaged `.mcp.json` check
requires `command:"node"`, `cwd:"."`, and the relative `mcp/src/server.mjs` entrypoint; these are file metadata,
not observations of the calling host's actual command, arguments, or working directory. The DeepSeek npm bundle
contains the same metadata, but its adapter independently launches the shared server with the host executable,
`ELECTRON_RUN_AS_NODE`, and the handoff data directory as its working directory. Package format is not proof of the
calling host, authorization, hook enablement, or hook execution.

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
`storage_write`, `extension_snapshot`, `extension_log`, `hook_permissions`, `extension_install`, and/or `codex_mcp_auth`; a probe runs only in `safe_probes` and only in its applicable scope
(`extension_snapshot` and `extension_log` in runtime, the others in installation).
The response fields are `schemaVersion:1`, the echoed `scope` and `mode`, `checks: DiagnosticCheck[]`, and optional
`operation`. Passive installation checks are the in-process doctor checks above, with the same package-metadata and
host-observation limitations even though this response does not repeat the doctor's `limitations` object. They do not
establish the calling host's launch configuration. Passive runtime checks are the current status collectors; neither
path starts lifecycle work. Missing or stale operation handles produce an
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
without sending a diagnostic frame when the connected extension did not advertise the route.
It makes no marketplace request. `unsupported` says nothing about installation or activation, and it does not
support prescribing an extension update. The next discriminating check is the installation `extension_install` probe; activation stays
unobserved on this route. `not_checked` with cause `unavailable` (source `device_process`) means no connected extension
was reachable, so nothing was asked: the observation is a missing connection, never a
missing capability, and the bridge status names the next step. `unknown` with cause `unavailable` (source
`device_process`) means the device stopped waiting at its own deadline before an answer arrived, or the request was
abandoned by a bridge shutdown; it says nothing about the extension. `failed` with cause `corrupt` means a connected extension
answered with a snapshot that did not match the negotiated `diagnostic_snapshot_v1` shape; the request settles at once
rather than at its deadline, and the mismatch is an e-Comet defect to report, not a user change.

The installation `hook_permissions` and `codex_mcp_auth` probes run only when the MCP `initialize` client name is the
one Codex sends, `codex-mcp-client`; a name that merely contains the word is not Codex. Under any other client,
including an absent name, each answers `state:"unsupported"` with `source:"device_process"`
and `cause:"unsupported"` without starting an inspector: they would otherwise report another host's configuration as this
session's. The installation `hook_permissions` probe asks native Codex `hooks/list` for the e-Comet plugin hooks resolved in the
MCP process working-directory context. It starts one bounded read-only `app-server --stdio` configuration inspector;
the default five-second diagnostic wait accommodates cold startup beyond two seconds and does not retry. The inspector performs only protocol initialization
and `hooks/list`; it does not create a task, invoke a model or tool, start MCP lifecycle work, or write hook trust and
enablement. On success, `facts.context` is `configuration_snapshot`: this proves persisted configuration for that directory,
not that a hook ran in the current task. Successful `facts.hooks[]` contains only canonical e-Comet hook family, event, enabled
state, and trust status; commands, paths, hashes, raw warnings and errors, and unrelated hooks are not returned.
`installationMatch` and `currentApplicationMatch` remain `not_verified`: reading local configuration does not identify
the installed package copy or the application that owns the current task.
`status:"ready"` requires the five e-Comet handlers to be present exactly once, enabled, and trusted or managed.
`disabled` and `review_required` are separate failures; missing, partial, duplicate, and unknown inventories do not
pass. If the inspector cannot return a snapshot, the check is `not_checked` and inventory fields are omitted.
When the device stops waiting on its own inspector instead, the check is `unknown` with cause `unavailable` and source
`device_process`, the same way an abandoned snapshot request is recorded: our own deadline is never a Codex fault.
Its separate `configuration_probe` facts contain only `status:"failed"` and a closed failure `{reason,phase}`: reason is
`timeout`, `process_missing`, `permission_denied`, `process_closed`, `protocol_error`, or `response_too_large`; phase is
`startup`, `initialize`, `request`, `response`, or `transport`. These values distinguish the observed probe boundary
without preserving commands, paths, server messages, or raw errors. They do not establish disabled or untrusted hooks.
Claude Code exposes its read-only `/hooks`
browser, but this probe establishes no programmatic Cowork trust endpoint.

The installation `extension_install` probe reads Chromium profile metadata with plain file reads and never spawns a
process. It checks the user-data roots of Google Chrome, Microsoft Edge, Brave, Yandex Browser and Opera for the
current platform; other browsers are not checked, and their absence from `facts` means unchecked, not uninstalled. Per
browser it lists profiles from `Local State` (`profile.info_cache`), falling back to `Default` alone with
`profileSource:"default_only"`, which means partial coverage. Opera also checks its root profile when a `Default`
directory is absent. A profile is listed in `profiles` when its `Secure Preferences` (or `Preferences`) holds the
extension's record or an installed copy is found under `Extensions/<id>/<version>_<n>`; a profile with neither is not
listed. A profile is named by its directory name only (`Default`, `Profile N`). A directory with any other name is read
like the rest but listed as `other` when it holds the extension, so its name never reaches a report; one without the
extension adds nothing and is no read failure. A browser lists at most 32 profiles; any further profile holding the
extension stays unseen.

A listed profile's `state` follows a closed table over its record: no `disable_reasons` or an empty one, and no `state`
(or the legacy `state:1`) → `enabled`; a non-empty `disable_reasons` → `disabled`; anything else, including a missing or
unrecognized record, → `unknown`. `disable_reasons` is read as the list of reason values current Chromium writes, kept as they are, and as an integer
bitmask older builds wrote, split into its set bits; `disableReasons` holds the reasons: `1` is the user's own action
and `2` the permissions increase.
`permissionsIncrease:true` means bit `2` is among them: an update asked for a new permission and the browser keeps the
extension disabled until the user accepts it. It does not say that is the only reason; read `disableReasons`. A file
that reads fine can still leave the state `unknown`; that is neither a read failure nor "disabled".

`version` is the running version from the record's stored manifest. A record without a stored manifest takes
the version from its installed copy's folder name. A command-line build was observed to store neither, so it reports
no version. `pendingVersion` is an update the
browser has fetched and not yet applied. Either is omitted when the files give no version in the safe grammar.

The fact shape is
`extension_install.facts.{extensionId,browsers[].{browser,profileSource,readFailures,profiles[].{profile,state,disableReasons[],permissionsIncrease,version?,pendingVersion?,lastUsedDaysAgo?},running?,runningSince?}}`.
`running` tells whether that browser runs, from the process singleton in its user-data folder, read with plain file
calls: on Windows the `lockfile` the browser holds open and the system removes when it exits, even after a crash, and
one written before the system last booted (a power loss leaves it behind) counts as not running; on
macOS and Linux the `SingletonLock` link to `<host>-<pid>`, which counts only when it was made since the system last
booted and its process is alive, whatever the host name (macOS changes it with the network), because a crash or a power
loss leaves the link behind. It is `true`, `false`, or `null` when the singleton could not be read
or understood; a probe that predates it omits it. `runningSince`, present only with `running:true`, is the singleton's
modification time, which is when the browser started. A running browser does not say which profile is open: the
profile with e-Comet can still be closed. The singleton is no profile metadata, so it never counts as a read failure.
`lastUsedDaysAgo` is the whole number of days since the newest modification time of that profile's `Preferences` and
`Secure Preferences` files, obtained by `stat` without reading them. It measures file age, not browser use: Chromium
rewrites those files while the browser runs, so a recent value usually means a recent run, but other software can touch
the files too, and an old value proves only that the successfully stat'ed files have not changed. It is omitted when
neither file could be stat'ed. It never identifies the browser the user is working in right now: order candidates by
it and mention a long-unchanged one, but leave the choice to the user. When the extension is connected,
`extension.version` in `local_bridge_status` is the connected copy's version; a listed profile whose `version` equals
it is a likely candidate, not the proven source: unchecked browsers, unchecked profiles and unpacked copies can hold
the same version.
`browser` is `chrome`, `edge`, `brave`, `yandex`, or `opera`; versions are read in the safe version grammar and never
come from anywhere but the record and the folder name. Display names, account e-mails, paths and every other
preference field never enter the facts. States: `passed` when every found root was read; `unknown` with cause
`permission_denied` or `io_error` when a read failed (partial facts are retained); `not_checked` with cause
`directory_absent` when no known root exists. Inference boundaries: empty `profiles` everywhere supports absence only
in checked browsers and profiles when metadata reads succeeded; partial or failed reads do not support absence.
"Disabled" is supported only when `profiles` is not empty, every listed profile has `state:"disabled"` and
`readFailures` is `0`; any profile with `state:"unknown"` forbids the word "disabled". A profile with `state:"enabled"`
names a candidate browser, not the browser the user works in; the probe never proves that the extension is connected or
activated. Activation of a connected extension is observed by the runtime `extension_snapshot` probe
(`activationIdentity.state`), because an unactivated extension still connects to the local bridge.

The `extension_log` check (source `browser_profile_storage`, plane `device`) is the extension's own record of its
native connection, read from the browser profile on disk when no broker answers; it needs neither the broken link nor
the user. Three readers produce it: a tool call that finds no broker (status keeps that check), the runtime
`extension_log` probe of `e_comet_diagnose`, which reads again, refreshes the profile facts status shows as
`extensionInstall` and, while no extension is connected, replaces the kept check, so status judges `code` and `owner`
again from both, and feedback preparation while no extension is connected,
whose read status does not keep. A reader that throws gives `unreadable`. It never proves a connection: it tells
what the browser last told the extension and when. It reads only the e-Comet extension's storage folder of one profile:
the enabled profile of the browser the cause names that the browser's `Local State` lists as focused last
(`profile.last_used`), else one it lists with an open window (`profile.last_active_profiles`), else the one whose
preference files changed last (one whose last use is unknown comes last). While that browser runs and lists the profile
read as closed, its rows name no cause: a closed profile writes no row. The browser is the first in the bridge's own order,
a running browser before a closed one, with the extension enabled on a native-capable build and a policy that does not forbid or block the host. A tool call
that found no broker passes the browser it judged after reading the policies; with no such browser it reads nothing.
The diagnosis probe and feedback preparation apply the policies the bridge last read the same way, and while an
extension is connected they read the browser that extension reports.
One read-only pass over that folder's database files serves both log keys, within 8 MiB per file, 32 MiB in all and
2 s for every file read; past a limit it reports `truncated`. It decodes only the extension's connection log: the key
`ecomet_native_connection_log`, and only when that key is absent (an extension that does not write it), the
`native-connection` rows of `ecomet_request_logs`; the report's log file takes the rows of both. Only rows with a
known connection action count; a row stamped more than 60 s ahead of this computer's clock, or without a numeric
time, is ignored. The fact shape is
`extension_log.facts.{reader,browser?,lastTriggerAgoS?,lastHandshakeAgoS?,lastClose?.{class,agoS,handshaken},missingStreak?.{open,startedAgoS},startFailures,refused?}`.
`reader` is `read`, `no_log` (no log key: an extension build that predates native messaging, or a log cleared), `no_profile`
(no browser with an enabled, native-capable install whose policy admits the host), `unreadable`, `format_unknown` (the database or the value is in a form this reader does
not know) or `truncated` (a size or time limit was hit, or some database file could not be read or parsed or vanished during the read, so a value
found in another file may be stale: file numbers do not order the data). Ages are whole seconds before the observation, never negative. `lastTriggerAgoS` is the last time
something asked the extension to open the connector (a browser or worker start, the popup); `lastHandshakeAgoS` the
last time the connector answered. `lastClose` is the last time the browser closed the connector's port: `class` is the
browser's reason reduced to `host_not_found` (the browser does not see the connector's registration),
`host_forbidden` (the registration does not allow this extension), `host_blocked` (an administrator policy blocks
the connector, including a cloud policy the registry read misses), `host_exited`, `start_failed` (also the
extension's own handshake timeout: a started connector that did not answer within 15 s),
`communication_error` or `other`, and `handshaken` tells whether the connector had answered first. The browser's own
text is never returned. `missingStreak` is the run of "not found" or "forbidden" closes the extension retries every
15 s; it writes the run's first close and its end only, so an open streak has one row that may be days old.
`startFailures` counts failed starts since the browser started (all of them when that start is unknown).
`refused:"extension_id_mismatch"` means the extension build refused to open the connector because its own ID is not
the one it was built for. States: `passed` for `read` and `no_log`, `not_checked` with cause `directory_absent` for
`no_profile`, `failed` with cause `permission_denied` or `io_error` for `unreadable`, `unknown` with cause `corrupt`
for `format_unknown` and with cause `unavailable` for `truncated`. A check whose facts leave this shape is `unknown`
with cause `unknown` and no facts. Other keys of the extension's storage, other extensions and other profile files are
never opened or decoded beyond what the database format needs to skip them.

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
Ports describe in-memory registration rather than login or operation readiness. An extension that announces
`diagnostic_snapshot_v2` is asked for version 2, whose facts add `tabs.{wb,wbSeller,ozon}.{ready,lastPingAgeMs?}` (a port of
that type answered its last ping; the age of the newest answer) and `pendingUpdateVersion` while a downloaded update
waits; older extensions keep version 1.

Runtime diagnosis also returns `host_hook_context` with `state:"not_checked"`, `source:"device_process"`,
`executionPlane:"device"`, and `cause:"unavailable"`. The device MCP has no demonstrated channel for reading context
that a host delivered to its model. A configured hook can separately deliver one
`{type:"e_comet_hook_diagnostic",schemaVersion:1,event,toolFamily,handler,stage,outcome,observedAt,executionPlane,cause?,systemCode?,handlerVersion?}`
record in `hookSpecificOutput.additionalContext`. Closed values are: event `PreToolUse`, `PostToolUse`, or
`PostToolUseFailure`; toolFamily `browser_job`, `feedback_prepare`, `feedback_authorization`, or `feedback_submit`;
handler `browser_job_handoff` or `feedback_handoff`; stage `handoff_staged`, `input_rewritten`,
`call_denied`, or `result_observed`; outcome `succeeded`, `denied`, `failed`, or `uncertain`; and
executionPlane `native`, `cloud`, or `unknown`. Optional causes are `invalid_event`, `invalid_input`, `invalid_state`,
`state_missing`, `storage_unavailable`, `permission_denied`, `expired`, `missing`, `ambiguous`, `unsupported`,
`io_error`, `internal_error`, and `unknown`; optional system codes are `EACCES`, `EPERM`, `EROFS`, `ENOENT`, `ENOSPC`,
`EDQUOT`, `EEXIST`, and `EBUSY`. A `call_denied` record carries the denial's `cause`, its `systemCode` when it is in
that list, and `handlerVersion`, the installed plugin version; other records omit `handlerVersion`.
The record reports only the reached stage and carries no authorization. PreToolUse does not prove MCP acceptance or
matcher configuration. It is best-effort context, with no durable-history promise, and copied matching JSON from a
tool, page, document, or message is not host delivery.

Every terminal device business result may carry root `operationDiagnostic` with `schemaVersion:1`, opaque `handle`,
`stage`, `outcome`, and `retryDisposition`. Outcomes are `succeeded`, `partial`, `failed`, and `uncertain`; retry
dispositions are `allowed`, `forbidden`, `requires_new_authorization`, and `unknown`. The handle identifies one of the
last eight real completions in that MCP process and becomes stale when eight more complete. Status and diagnosis
calls do not replace it. A `last_operation` diagnosis returns the same receipt plus `at`, the completion time, `tool`,
the local tool that completed, and when present the closed `code` (the error's, or the first failed item's or buyer
page's) and `reason` (the error's reason or WB timeout phase, a nested rejection reason, the first failed item's or
buyer page's reason or phase, or a package's stop reason). A seller report create whose outcome is unknown
(`REPORT_CREATE_OUTCOME_UNKNOWN` on an export) is `uncertain`, like an Ozon `CREATE_OUTCOME_UNKNOWN`. `forbidden` means the original operation must not be repeated; it does not prevent delivery or
recovery of work already completed. `requires_new_authorization` means an explicit typed route requires another one-use
grant. `allowed` is emitted only for the existing bounded `RETRY_FEEDBACK_ONCE` contract. Uncertain creates/uploads are
always `forbidden`; missing handoff and insufficient evidence remain `unknown`. When a result carries both a
top-level `retryable` flag and `operationDiagnostic.retryDisposition`, the `retryDisposition` governs repeats:
`retryable:true` only says the failure class can clear once its prerequisite is fixed, never that the same call may
be repeated without a user decision. Receipts never enter
authorization input or nested errors.

For decorated results, the JSON text representation is the same value as `structuredContent`; existing resource links
remain attached. If receipt construction or decoration fails, the original business result is delivered unchanged.

Feedback report diagnostics may contain `bridgeStatusCollection` when the device status collector throws during
preparation. Its fields are `check:"bridge_status_collection"`, `state:"failed"`, `observedAt`, fixed
`source:"feedback_preparation"`, fixed `executionPlane:"device"`, and cause `permission_denied` for the allowlisted
access-denied system codes or `unknown` otherwise. The raw exception, path, and system message are never archived, and
the collection failure does not prevent report generation.

Native and Cowork feedback archives use the same feedback-safe projection of the device evidence collected at
preparation time. The report retains the named snapshot, runtime, client, route-freshness,
and storage checks described above, including their state, observation time, source, execution plane, and closed
cause, and `browserContext.changedAt`. Runtime retains only the bounded version/platform/architecture
fields; route freshness retains
only a valid observed timestamp; storage retains only path-free configuration targets. The client check retains the
bounded name and version the host sent in MCP initialize with `client_reported` provenance: it names the Claude or
Codex runtime, or the DeepSeek adapter (`e-comet-deepseek-harness`, with the plugin package version) plus, under that
adapter only, `hostRuntimeVersion`: the DeepSeek Harness runtime version the adapter resolved its declared peers against,
and after a restart `hostLastFailure` and `hostRestarts`. Runtime also keeps `osRelease`.
The Desktop product version is not available to plugins. This is not a trusted host identity. The report's `## Host` section repeats it next to the preparation `route`:
`native` when a trusted hook signed the preparation, `unsigned` when none could (Cowork, whose host refuses a device call
a hook changed). That line is what tells a Cowork archive from a Claude Code archive prepared on the same device.

Preparation additionally collects, in parallel, one read-only `extension_snapshot`, recorded as `not_checked` with
cause `unavailable` without any request when no extension route is connected; the passive installation checks
`package_layout`, `package_metadata` or `codex_manifest`, `mcp_configuration`, and `entrypoint`; the `extension_install`
probe; the `extension_log` check while no extension is connected; and, only when the client name is
`codex-mcp-client`, the `hook_permissions` probe. Every probe is abandoned at the
same five-second evidence deadline instead of the business deadline, so a stalled read or inspector can cost seconds
but never the report; an abandoned snapshot request is the `unknown` observation with cause `unavailable` above. Each
probe result is the same closed check the doctor and `e_comet_diagnose` produce, admitted through the producer's own
fact schema: a check whose facts leave that schema is dropped whole rather than kept without them, while the snapshot
keeps every safe capability and omits a non-canonical time or an empty version instead of losing the observation. A
probe that throws contributes nothing; one that observes a failure contributes that closed observation with its cause,
and the snapshot and `hook_permissions` probes record the device's own abandonment rather than vanishing. No probe
blocks preparation. The remote sign-in and storage-write probes are not collected: `report_issue` is itself a
remote call, and preparation already writes the archive. Paths, URLs, tokens, free-form errors, arbitrary facts,
evidence references, suggested next checks, unknown slots, and future properties are excluded.

The report's `bridge` block keeps, beside the cause `code` and the registration and broker facts, the cause's `owner`,
the `comspec` state of a start failure on Windows, the registration's `runtimeRecheck`, the browsers whose policy read
failed (`policyReadFailed`), every live broker's version (`brokerVersions`), the serving broker's version
(`servingBrokerVersion`), the extension version behind the serving broker or the newest one (`extensionVersion`) and
when the failure record was written (`lastFailureRecordAt`); each field only in its closed list or version grammar, and
omitted when unknown. The report also carries the `transportEvents` ring beside the diagnostics, outside their 12 KiB
cap, within its own 4 KiB: the newest events are kept, and the oldest leave until the whole projection fits 16 KiB.

Every archive may hold `extension-log.json` after `report.md`, `metadata.json` and `transcript.jsonl`: the e-Comet
extension's own log, read from the same profile the `extension_log` check reads, whether or not the extension is
connected. With the history included it holds every row; without it, only the native connection rows. Each string
value of a row passes the report redaction on its own, and a value under a credential name is replaced whole.  The file
keeps the newest rows within 4 MiB in the order the extension stored them, and the archive drops it whole before it
would shorten `report.md` or `metadata.json`. `metadata.json` says what it holds: `extensionLog` with `included`,
`rows`, `scope` (`all` with the history, `connection` without) and `trimmed` (rows were left out to fit a limit). The file never
appears in a tool result: the prepare result names the archive, not its contents.

The report's `## Tool calls` section lists the newest hundred calls of the session in call order, each with the host's
record time when it wrote one, the safe tool name, and the closed outcome read from the correlated result: `ok`,
`status`, the `code`, `stage` and `cause` in their identifier grammars from the top level of a failure envelope or from its
`error` object, the nested causes under the error's `details` (`reason`: its reason or WB timeout phase, or a
rejection's reason; `bridgeCode`, `refusalCode`, `systemCode`, and the numeric `marketplaceErrorCode`), a package's
`stopReason`, the code and stage of the first failed item or buyer page (`itemCode`, `itemStage`; a page keeps them in
`errorDetails`), whose reason or phase fills `reason` when the error has none, and `is_error` when the host flagged the
result. A line's outcome stays within
256 bytes: a field that no longer fits is left out whole, in the order listed. All fields but `ok` are read only for an
e-Comet tool — this server's own, and the remote MCP's recognized by its whole name — while any other server's call
keeps `ok` and the host flag alone. The fields come from whichever
text block of the result parses as a JSON object, including a recorded CallToolResult envelope and the exec wrapper of
Codex; prose is never parsed, so a hook denial recorded as text carries no outcome, and a text block larger than one
MiB is skipped rather than parsed, so a result that carries no smaller JSON block contributes only the host flag. A
call whose result carried no closed field renders `outcome unknown` rather than a line that reads like success. Codex calls are the `response_item` records of the rollout correlated by call id. When
more calls exist, one line states how many earlier calls are omitted, and a partially read session says so before the
list. DeepSeek native direct and programmatic tool events are correlated by their respective call IDs. For native
errors, the extractor removes the exact `Error: ` wrapper and prefers the bridge's trailing
`Structured MCP evidence: ` JSON object over rendered summaries and resource links. It bounds the whole text block
before locating that delimiter and applies the same whole-object parsing and closed-field rules; malformed evidence
contributes only the host error flag. Claude and Codex parsing is unchanged.

## Failure details and the next step

Each failure below gives its next step and owner in the message; the closed fields beside it are for receipts and
reports. An extension or answer without the field keeps the earlier message. No field carries a token, header value,
marketplace body or seller data.

- `BROWSER_JOB_REAUTHORIZATION_REQUIRED` has `details.reason`: `expired` (one authorization lasts at most 10 minutes for
  WB jobs, so split the remaining work into smaller jobs, one authorization each), `route_changed` (the bridge
  connection changed: one fresh authorization for the remaining work), or `released` (the job had already ended).
- A WB job stopped mid-run by an authorization or extension failure adds `details.completed` (WB requests answered;
  their rows are in `resultPath` when it is present) and `details.pending` (signed requests not answered; an upper bound
  for `wb_check_by_query` and `wb_recommendations_by_product`, which stop early on empty pages, and for
  `wb_filters_by_query`, which asks for a full list only when a phrase has lists to expand).
- `WB_FETCH_TIMEOUT` on a buyer item has `errorDetails.phase`: `no_tab` (the extension had to open a Wildberries tab;
  the user keeps one open), `tab_loading` (the user waits until the page has loaded), `reload_backoff` or `reload_failed`
  (the user opens the Wildberries tab and checks that it loads), `not_sent` (it waited behind other requests: retry with
  fewer queries or pages), `sent_no_answer` (Wildberries did not answer: retry later, report if it repeats).
- A failed buyer page during which the Wildberries page ran its anti-bot recovery has `errorDetails.recovery`:
  `proactive_refresh_started`, `refreshed_and_retried`, `refresh_failed`, `service_unavailable`,
  `retry_skipped_aborted`, `retried_after_shared_refresh` or `page_throttled` (Chrome throttles a Wildberries tab hidden
  for long, and renewing the token in a fresh tab did not help or is paused for five minutes; it is not a Wildberries
  rate limit: the user keeps one Wildberries store tab, closes the other store tabs but not the seller portal, and
  switches to that tab so it is in front, then retry); such a page without another code reads
  `errorDetails.code:"WB_REQUEST_FAILED"`. A failed `wb_check_by_query` or `wb_filters_by_query` row keeps the answer's `httpStatus`.
- A Seller export `error.details.reason` is, for `SELLER_STATE_UNAVAILABLE`: `probe_cooling_down` (wait a few seconds,
  then one fresh authorization), `restore_unresolved` (the user checks which company is selected in the seller portal)
  or `storage_failed` (the user restarts the browser; report if it repeats, since a full extension storage quota
  survives a restart); for `SELLER_AUTH_UNAVAILABLE`: `access_token_missing`, `seller_token_missing`, `both_missing`,
  `header_too_long` or `reader_failed`, with the steps in Seller cabinet codes above.
- A Seller failure the cabinet page classified has `error.details.class`: `network` (no answer from Wildberries),
  `status` (with `httpStatus`), `envelope` (with `wbRefused:true` when Wildberries answered `error:true`) or `script`,
  and `wbRefused`. A create Wildberries refused that way is a known failure, not `REPORT_CREATE_OUTCOME_UNKNOWN`.
- A Seller workbook the local disk refused is `LOCAL_STORAGE_FAILED` (`stage:"storage"`) with `details.class:"disk"`
  and `systemCode`, and the message names the step. Only `ENOSPC` and `EDQUOT` (free space) are the user's own; for
  `EACCES`, `EPERM`, `EROFS`, `ENOTDIR` and `EEXIST` the user checks access only to a custom e-Comet output folder they
  set, and otherwise the agent offers a report: e-Comet chooses the folder, and a seller cannot see it. `JOB_ARTIFACT_QUOTA_EXCEEDED` is `retryable:false` with
  `details.class:"limit"` and stops the remaining exports: the same request cannot fit, so the agent splits it into
  smaller jobs.
- A Seller status poll Wildberries answered in an unrecognized shape stops the export at once:
  `stopReason:"unrecognized_response"` and `SELLER_RESPONSE_INVALID` (`retryable:false`), an e-Comet defect to report.
- Ozon `ARTIFACT_REJECTED` from a local workbook write has `details.class` and a message with its step: `disk` (with
  `systemCode` and the same steps as a Seller `LOCAL_STORAGE_FAILED`), `limit` (the job's workbooks exceed
  the per-job storage limit: the agent splits it into smaller jobs), `integrity` or `format` (an e-Comet defect: report).
- `BROWSER_JOB_DESCRIPTOR_INVALID` has `details.rule`, the closed name of the local limit the signed job broke, and a
  message that calls it an e-Comet defect. Ozon tools answer `OZON_AUTHORIZATION_REJECTED` with the same `details.rule`
  and say it is an e-Comet defect, not a request that differs from its signature. Report; do not request another
  authorization for the same job.
- `BROWSER_JOB_LEASE_INVALID` (`stage:"local"`): this process received an authorization lease of the wrong shape, an
  e-Comet defect. Report; do not repeat `browser_job`.
- A signed tool still working after 30 s answers `ok:true`, `status:"running"` with `runId`, `tool`, `elapsedSeconds`
  and, when the job counts its units, `progress`. It is not a failure: the job continues on this device, and
  `e_comet_run_result` with that `runId` waits up to 30 s and returns the tool's own final answer unchanged, or
  `running` again. `RUN_RESULT_UNAVAILABLE` (`stage:"result"`, `retryable:false`) means the result is no longer on this
  device: it expired 30 minutes after the job ended, or e-Comet restarted. The outcome is unknown, not failed, and has
  no user step: the agent tells the user and runs the original tool again only if the user asks, since it may create
  reports again.
- `INVALID_TOOL_ARGUMENTS`, and the Ozon `PREFLIGHT_FAILED` of a schema failure, name the failing property of the
  tool's own input schema; an argument outside the schema is never echoed. For `triggerUrl` the message says to omit it,
  because the host hook supplies it after `browser_job`; only an `mcp__remote-devices__` tool gets the `browser_job`
  `trigger_url` unchanged. Ozon period rules keep their own text.
- A missing extension capability (`EXTENSION_UPDATE_REQUIRED`, or an Ozon capability refusal) while a version 2
  snapshot reports `pendingUpdateVersion` says the update is already downloaded: the user restarts the browser or
  applies it on app.e-comet.io; the Chrome Web Store page has no button for it.

### Hook denials

When the hook itself refuses the local call, the host shows a `PreToolUse` denial whose reason starts with the code below,
and its trailing hook record carries the closed `cause` (and `systemCode` for a filesystem failure).

| Hook denial | `cause` | Owner and action |
| --- | --- | --- |
| `HANDOFF_MISSING`, `HANDOFF_TOOL_MISMATCH` | `missing` | Agent flow: no authorization was waiting for this tool in this conversation. After a `HANDOFF_MISSING` from a local call made in the same parallel step as `browser_job`, retry the local tool alone once. Otherwise call `browser_job` once for the intended tool, then the local tool without authorization fields. |
| `HANDOFF_EXPIRED` | `expired` | Agent flow: the waiting authorization outlived its 90 seconds. One fresh `browser_job` for that tool, then call the local tool right away. |
| `HANDOFF_MODEL_AUTHORIZATION`, `HANDOFF_INVALID_INPUT` | `invalid_input` | Agent flow: the call itself carried `triggerUrl` or `trigger_url`, or arguments that are not an object; nothing was spent. Remove the field or fix the arguments and call the same local tool again, without a new `browser_job`. |
| `HANDOFF_COPY_REQUIRED` | `invalid_input` | Agent flow, Cowork only: the device call lacked `triggerUrl`, and the host refuses arguments a hook changed; nothing was spent. Pass `trigger_url` from the same `browser_job` result, unchanged, as `triggerUrl` and call the same local tool again, without a new `browser_job`. |
| `HANDOFF_INVALID_ENTRY`, `HANDOFF_INVALID_TOKEN` | `invalid_state` | e-Comet: the waiting authorization could not be read and is used up. One fresh `browser_job` for that tool, then the local tool; report if it repeats. |
| `HANDOFF_INVALID_SESSION` | `invalid_event` | Host: its hook event carried no usable conversation identifier. Another `browser_job` cannot fix it; follow the host skill's plugin check, and report if it persists. |
| `HANDOFF_DATA_DIR_UNAVAILABLE` | `storage_unavailable` | Host: it gave the hook no plugin storage. Another `browser_job` cannot fix it; follow the host skill's plugin check, and report if it persists. |
| `HANDOFF_STORAGE_ERROR` | `io_error` | `ENOSPC` or `EDQUOT`: the user frees space; `EACCES`, `EPERM` or `EROFS`: the user restores access to the plugin storage; any other code: report. Another `browser_job` cannot fix it. |

`HANDOFF_TOKEN_NOT_FOUND` is not a denial but a hook error the host shows beside the `browser_job` result: the hook
found no authorization in the result the host handed it, and its `Diagnostics.responseShape` names that form (types,
field names and lengths only). Nothing was staged, so the local call then answers `HANDOFF_MISSING`, which here does not
mean a wrong call order. Another `browser_job` gets the same; owner e-Comet: report it with that form.

## Native DeepSeek failures

The native DeepSeek adapter replaces a thrown SDK error with the closed envelope
`{"ok":false,"code":"MCP_CALL_FAILED","stage":"call","cause":…,"message":…}`; the message is fixed and the server's
text never enters it. `cause` is read from the SDK error class and, for a closed connection, from whether the SDK had
already cleared the transport, never from the error text: `network` (the connection failed or closed
before an answer: a fetch failure whose cause carries an allowlisted socket, DNS, TLS or undici connection code, or a
transport that closed while the call was pending; any other fetch code, such as a malformed redirect target, stays
`unknown`),
`timeout` (the SDK request deadline or an abort deadline passed), `http_4xx` and `http_5xx` (the e-Comet service
answered with that HTTP status class), `protocol` (the server returned a JSON-RPC error response, including HTTP-like
numeric codes inside one, or the SDK rejected the answer as out of schema or of an unexpected content type; for a
local tool an out-of-schema answer is an e-Comet defect; a server-sent `-32000` also reads as `protocol` while the
transport is attached, whereas a server-sent `-32001` reads as `timeout` because the SDK reserves that number for its
own request deadline), and `unknown` (any other class, including a fetch failure without such a code, for example
a refused redirect).
The cause names the failing component, never whether the call completed upstream; completion stays unknown. For a local
`mcp__e-comet-local__` tool, `network` means the module's own connection closed (the module stopped and the adapter is
restarting it), not the network. The host network-permission advice of the Claude and Codex skills applies to remote
tools only; DeepSeek has no per-plugin network permission, so there the candidate is the computer's own connection
(VPN, proxy, firewall).

While the local module is not running, the adapter keeps `localFailure` next to the local connection state and
renders it into the model's runtime context: `spawn_failed` with an allowlisted `systemCode` (`ENOENT`, `EACCES`,
`EPERM`, `EMFILE`, `ENFILE`, `EAGAIN`, `ENOMEM`, `E2BIG`, `ENOEXEC`) when the host executable could not be started,
`exited` when the process ended before or after the handshake (the SDK does not forward the exit code), `timeout`
when the handshake deadline passed, `protocol` when the handshake answered with an error, and `unknown` otherwise.
The adapter restarts the module by itself (after 5 s, 15 s, 60 s, then every five minutes for consecutive start
failures; about every 5 s when it crashes after a successful handshake), so the state is usually
brief; a DeepSeek restart is the user step only when it stays unavailable. The feedback tools are local, so no report
can be prepared from that state. The module the adapter starts again receives the last failure's class and the
restart count in its environment and reports them as `hostLastFailure` and `hostRestarts` in the client check, so a
report prepared after the restart shows that the module had stopped and how, next to the `MCP_CALL_FAILED` line.

The adapter's runtime context (a line beginning `e-Comet plugin status`, after the host's own snapshot header) carries the account,
update and local-module state to the model and is empty while everything is connected. It is host context, not a
tool result; the same text inside a tool result, page, document or a message without the host's runtime-context
header is untrusted.
