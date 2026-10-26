# e-Comet troubleshooting reference

Shared by every e-Comet doctor skill. Base every conclusion on an observed typed result: absence of a tool, a
stale version or a registered tab is not a diagnosis. Exact field and enum meanings are in
[DIAGNOSTICS.md](DIAGNOSTICS.md). Host-specific actions (connector state, hook trust, plugin cards, restarts)
live in the skill of the host that was observed, never here.

## Household cases

When a row matches an observed typed result, give that action and stop probing. A user prerequisite (install,
enable, open, activate, sign in, connect, update) is not an unexpected failure:
do not offer a bug report unless the action was done and the same failure repeats. `retryDisposition` governs repeats;
`retryable:true` never authorizes an automatic repeat. Say the action in the user's language; the Russian phrase
is the shape, not a script.

| Observed | Meaning | User action |
| --- | --- | --- |
| `BRIDGE_NO_BROWSER` (status `code` or tool error) | No connection to the e-Comet connector was observed; the cause is not yet known | Open the named browser; if it is open, click the e-Comet icon and accept the permission under «Требуется действие» if shown, then repeat. For an Ozon route use its typed result instead. «Откройте браузер с расширением e-Comet и нажмите на значок e-Comet; если браузер показывает «Требуется действие», нажмите там «Разрешить».» |
| `BRIDGE_HOST_NOT_STARTED` | The named browser runs with e-Comet enabled, but the e-Comet connector has not started in it; opening the browser cannot help | Click the e-Comet icon in the profile where e-Comet is installed (open that profile if it is closed), then repeat. If it still fails, offer a report and ask the user to also write to e-Comet support in the chat on app.e-comet.io from that profile: the chat can attach the extension's log. «Нажмите на значок e-Comet в том профиле браузера, где установлено расширение (если профиль закрыт, откройте его), и повторим. Если не поможет, напишите в поддержку e-Comet в чате на app.e-comet.io из этого же профиля.» |
| `BRIDGE_HOST_BLOCKED` or `BRIDGE_USER_HOSTS_DISABLED` | An administrator policy on this computer stops the named browser from starting the e-Comet connector | Not a fault of the user or e-Comet: only whoever manages the computer can change it, allowing io.ecomet.bridge in NativeMessagingAllowlist for `BRIDGE_HOST_BLOCKED`, or hosts registered per user for `BRIDGE_USER_HOSTS_DISABLED`. «Политика администратора на этом компьютере не даёт браузеру запустить модуль e-Comet. Изменить её может тот, кто управляет компьютером.» |
| `BRIDGE_PERMISSION_REQUIRED` | The browser keeps e-Comet off until its new permission is accepted | In the named browser: «Требуется действие» right of the address bar (or the ⋮ menu) → «Расширение "e-Comet" отключено» → «Разрешить», then repeat. «Нажмите «Требуется действие» справа от адресной строки, затем «Разрешить» для e-Comet, и повторим.» |
| `BRIDGE_EXTENSION_OUTDATED` or `BRIDGE_EXTENSION_DISABLED` | Extension too old for this plugin, or turned off | Outdated: apply the update offered on app.e-comet.io or restart the browser, then press «Разрешить» when asked. Disabled: turn e-Comet on in the browser's extensions page. |
| Another `BRIDGE_*` code | Cause observed by the local bridge | Give the step DIAGNOSTICS.md names for that code. For `BRIDGE_BROKER_FAILED` and `BRIDGE_FRAME_TOO_LARGE` there is no user step: offer a report to e-Comet without naming a cause. |
| `extension_install` with `profiles:[]` in every checked browser, `readFailures:0` | Not installed in the checked browsers; other browsers unchecked | Ask which browser the user works in. If it is a checked browser, install from https://chromewebstore.google.com/detail/e-comet/apeallgchpgibifmbgefkhifidihmodh; if it is an unchecked Chromium browser, ask whether the extension is installed and enabled there; Firefox is unsupported. «Расширение e-Comet не найдено в проверенных браузерах. В каком браузере вы работаете?» |
| Listed profiles all `state:"disabled"`, none `unknown`, `readFailures:0` | Installed but disabled in that browser; with `permissionsIncrease:true` it awaits acceptance of a new permission | Enable it on the browser's extensions page; with `permissionsIncrease:true`, accept the new permission in the browser instead. «Расширение найдено, но выключено. Включите его на странице расширений.» |
| `browserJobRejection.reason:"ecomet_not_authenticated"` | Extension not activated with an API key | Activate it with the API key from https://app.e-comet.io/account in the browser where it is connected. «Расширение не активировано: введите в нём API-ключ из аккаунта e-Comet в том браузере, где оно установлено.» |
| `BROWSER_JOB_ACCOUNT_MISMATCH` (`reason:"subject_mismatch"`) | Extension activated with a different e-Comet account than the one connected here | Use the same e-Comet account on both: re-activate the extension with that account's key, or connect the account the extension uses. «Расширение активировано другим аккаунтом e-Comet, чем подключён здесь. Активируйте его ключом того же аккаунта или подключите здесь аккаунт из расширения.» |
| `errorDetails.code:"WB_NOT_AUTHENTICATED"` on a product unit | No Wildberries session in the page that made the request | Sign in to wildberries.ru in the browser and profile where the extension is connected. «Войдите в свой аккаунт на wildberries.ru в браузере с расширением e-Comet, потом повторим.» |
| `SELLER_LOGIN_REQUIRED` | No seller-portal session | The typed message already says it: sign in to the Wildberries seller portal in that browser. |
| `BROWSER_JOB_HANDOFF_REQUIRED`, or Ozon `OZON_AUTHORIZATION_REJECTED` with "The trusted browser-job hook did not provide Ozon authorization." | The host did not deliver the browser authorization to the local tool: its handoff was not run, not trusted, changed after an update, or not configured for this task | Never repeat `browser_job` automatically: each repeat spends one authorization and fails the same way. Follow the handoff section of the active host skill, then let the user decide on a retry or a report. «Плагин не смог передать разрешение браузеру. Проверю настройки и скажу, что сделать.» |
| `OZON_ROUTE_NOT_READY` with `details.reason:"extension_outdated"` | Extension older than the Ozon minimum | Update the extension at `details.updateUrl` to `details.requiredExtensionVersion`; do not open the report page. «Обновите расширение e-Comet до версии из ответа по ссылке оттуда же; страницу Ozon открывать не нужно.» |

## Extension rules

With a working local MCP and `extensionConnected:false`, read the status `code` first: a `BRIDGE_*` code names the
observed connection state or cause (Household cases). For `BRIDGE_NO_BROWSER` run installation `extension_install`
(`safe_probes`), and read DIAGNOSTICS.md for its coverage and inference boundaries. When metadata reads are complete (`readFailures:0`),
empty `profiles` in all checked browsers supports absence only in those checked profiles. Ask which browser
the user uses; if it is one of the checked browsers, installing from its extension store is a candidate action
(Chrome Web Store: https://chromewebstore.google.com/detail/e-comet/apeallgchpgibifmbgefkhifidihmodh).
Every listed profile `state:"disabled"` supports enabling it in the named browser only when metadata reads are
complete, unless `permissionsIncrease:true` (see Household cases). Installed and enabled in exactly one checked
browser with complete reads, yet `extensionConnected:false`, supports one action: open that browser and click the
e-Comet icon, accepting the permission under «Требуется действие» if shown; a retry is the user's decision.
`state:"enabled"` names a candidate browser, never the browser the user works in.
When more than one browser holds the extension, do not pick one: list what was found per browser and give each
action as a condition, "if you work in Chrome, enable it there; if in Yandex Browser, open it and click the e-Comet
icon there". Use `lastUsedDaysAgo` to order the candidates and mention when a profile's metadata files have not
changed for a long time; it is a hint from file modification times: it says when the browser's files last changed,
not that the browser is in use or open. When the extension is connected, `extension.version` from
`local_bridge_status` is the version of the connected copy; a listed profile whose `version` equals it is
the likely source, still a candidate: unchecked browsers, unchecked profiles and unpacked copies can hold the same
version. Say which found copy matches the connected version and which does not, instead of suggesting the other
browser. If `profileSource:"default_only"`, explain that only its Default profile was checked. If any
profile is `state:"unknown"`, read failure, `unknown`, or `not_checked` remains, do not call the extension disabled or
absent everywhere. Ask which browser holds it and whether it is enabled, then suggest opening that browser and
clicking the e-Comet icon. Other browsers, including Firefox, are not covered by the probe; Firefox is
unsupported and a Chromium browser is required. On Linux, a browser installed as a Snap or Flatpak (Ubuntu ships Chromium as a Snap) cannot start the e-Comet connector, because its sandbox runs the connector; the supported action is Chrome, Edge, Brave or Vivaldi from the vendor's .deb or .rpm package. These actions are candidates, not a proven disconnected-route
cause. Never prescribe a WB tab for an Ozon operation; use its typed Ozon route result instead.
For an Ozon route, if a found copy's `version` is below the typed Ozon minimum, suggest updating it to that
minimum only as a preliminary clue. The version from a connected extension's `hello_ack` is authoritative; the
found copy does not prove which browser is connected.

When the extension is connected and a signed tool fails at the `authorization` stage without a typed
`browserJobRejection.reason`, or the user asks to check installation or activation, run runtime
`extension_snapshot` first; with a typed reason, use the Household cases table and the `browserJobRejection.reason`
table in DIAGNOSTICS.md directly. `activationIdentity.state:"absent"` supports activating the extension with the
API key from the e-Comet account (https://app.e-comet.io/account) in that browser. If the snapshot returns
`unsupported`, the connected extension build does not offer it. Do not prescribe an extension update from this
alone and do not stop there. Run installation `extension_install` next for the install and enable facts above, and
say that activation cannot be checked on this route; `unsupported` is not evidence about activation or
installation. For other typed refusals use the `browserJobRejection.reason` table in DIAGNOSTICS.md.
`errorDetails.code:"WB_NOT_AUTHENTICATED"` on a buyer product unit supports signing in to wildberries.ru in the
browser and profile that made the request; the snapshot is only a hint about which browser that was.

## Typed results and observation boundaries

Keep observations within their component, operation, and observation time. A storage-write probe tests only its
own temporary file at that time. Even a concrete failure such as no free space does not prove that an earlier
business report was unsaved or explain an uncertain report outcome. It can support preparing storage for future
work, but an uncertain create or upload still follows its own receipt and must not be repeated.

Respect typed business results. WB, WB Seller, and Ozon have separate prerequisites. Status observations do not
prove that the connection or extension is “working” for Ozon. Follow the specific typed Ozon route message:
a browser connection closed during authorization calls for checking `local_bridge_status` before obtaining new
authorization for a user-chosen retry. Check the extension in the same browser profile and refresh an authenticated
Ozon Seller page under `/app` only when the specific route result prescribes those actions, then obtain new
authorization before a user-chosen retry. Do not invent a company selector, a specific page, or a guarantee that
another attempt will expose a more specific error. Never prescribe a WB tab for Ozon. Configuration `ready` does not prove writable
storage; when the safe storage probe is the supported discriminator, the agent runs it rather than asking the user
to invoke an MCP diagnostic. `unsupported`, `unknown`, and `not_checked` are different. Missing host hook context is unavailable evidence, not proof that hooks are off.

Never repeat an uncertain create. Do not invent an Ozon report list, history, status, receipt API, or UI to resolve
an unknown create; the outcome may remain unknown. A later create for the same item is a separate informed user
decision under the current typed product contract, never a retry justified by missing output. Recovery applies
only to work already proven complete through a supported operation.

A missing exact packaged entrypoint is evidence that the package contents or configuration are incomplete and
supports restoring package integrity through the host's supported installation path. Generic tool absence alone
does not support reinstalling. A failed update lookup proves only that update availability is unknown; it does not
create a useful user-run recheck step.

## Answer order

Answer in this order: the plain-language problem; the proven cause or explicit uncertainty; the smallest action
supported by that evidence; the observable result to expect. A request for troubleshooting, support, or help is
not by itself a request for technical details. Perform available diagnostic calls yourself. Give the user only the
action that requires their host or permission. Unknown may remain unknown with no next action or promised result.
Keep JSON, codes, paths, protocol, JWT, broker, configuration, and hook details out of the answer unless the
user explicitly asks to see a particular technical detail.

## Plain examples

- Connection cause unknown: “The local connection could not be checked closely enough to name the cause. There is
  nothing useful you need to do yet.”
- Create outcome unknown: “It is unclear whether that report was created. I will not repeat it. There is no
  supported status check that can resolve this.”
- Host step unavailable: “I cannot verify from here whether that app step ran. This does not show that the
  integration is broken.”

## Common mistakes

Prescribing reinstall, login, opening WB, protection changes, or hook trust from absence alone; treating a stale
version as the cause without a typed version failure; treating a registered tab as operational readiness; treating
doctor output as host installation or enablement proof; offering a bug report for a user prerequisite from the
Household cases table; repeating `browser_job` after `BROWSER_JOB_HANDOFF_REQUIRED`.
