import { OZON_PROMOTION_MIN_EXTENSION_VERSION } from './extension-vocabulary.mjs';

const authorizationWorkflow =
    'This typed local tool owns the workflow: select it based on user intent, then call the remote e-Comet browser_job exactly once with the matching typed job and immediately invoke this tool. ' +
    'In Claude and Codex, model-authored arguments must omit both triggerUrl and trigger_url so the trusted host hook can inject the transport-only authorization immediately before this local call. ' +
    'Never decode, print, edit, copy, or expose the authorization. Do not infer an authorization failure from client status: attempt the actual remote call and report only the confirmed error in user-friendly language. If a tool is missing from the catalog, repeat the host tool search up to three times; never repeat browser_job or this tool to make an error disappear. ';

const ozonScopeGuard =
    'e-Comet provides exactly two Ozon Seller report families: promotion analytics and general analytics. ' +
    'When the user asks for any other Ozon report or data (returns, finance, products, traffic, campaigns, orders), no e-Comet Ozon tool applies: ' +
    'do not call browser_job, do not substitute the nearest report, and do not run any Ozon tool as a probe; say that only these two families exist and ask what the user wants. ';

const ozonAuthorizationWorkflow =
    ozonScopeGuard +
    'This typed local tool owns the Ozon workflow. First call the remote browser_job({job:{type:"ozon_seller_promotion_report",dateFrom,dateTo}}) exactly once, then immediately invoke this tool with the same dates. ' +
    'The trusted Claude or Codex host hook injects the opaque transport-only triggerUrl; model-authored arguments must omit both triggerUrl and trigger_url. Never decode, print, edit, copy, or expose that authorization. ' +
    'local_bridge_status reports legacy WB browser context and must not be used to gate this Ozon tool; the Ozon capability and typed operation result are authoritative. ' +
    'Its extension version and Ozon capability fields are informational only: use them to explain a failure, never to skip or pre-approve this call. ';

const ozonHandoffGuidance =
    'OZON_AUTHORIZATION_REJECTED with the message "The trusted browser-job hook did not provide Ozon authorization." is the same missing handoff; treat it exactly like BROWSER_JOB_HANDOFF_REQUIRED. ';

const ozonPackageAuthorizationWorkflow = (browserJobType, businessArguments) =>
    ozonScopeGuard +
    `Call the remote browser_job exactly once with job {type:"${browserJobType}",${businessArguments}}, then invoke this local tool exactly once with the identical business array. ` +
    'The trusted Claude or Codex host hook injects the opaque transport-only triggerUrl; model-authored arguments must omit both triggerUrl and trigger_url. Never decode, print, edit, copy, or expose that authorization. ' +
    'Never automatically retry browser_job or the local report call; a fresh authorization requires an explicit user-directed retry. ' +
    'Caller order is execution priority; acceptance does not guarantee that every item will finish. ' +
    'For a user-directed continuation, include only the selected skipped items in a fresh package. Do not silently include completed or failed items. ' +
    'CREATE_OUTCOME_UNKNOWN means creation may already have succeeded: explain that uncertainty and obtain a separate, item-specific retry decision. ' +
    'Neither report family currently provides safe automated reconciliation; ordinary promotion preflight may create another report. ' +
    'Use itemIndex to correlate the ordered results and stopReason to explain skipped work; a null stopReason means nothing was skipped, not that every item succeeded. ' +
    'OZON_EXECUTION_INTERRUPTED identifies an internal phase-delivery failure, not a Seller login or route diagnosis. ' +
    'Use its safe phase/createOutcome evidence: confirmed creation must not be repeated automatically; skipped work has not run. Offer an e-Comet bug report for persistent internal failures. ' +
    'The extension automatically uses the first ready Seller context and pins its company for this package; never ask the user to focus a tab. A fresh authorization uses the then-current context and does not guarantee the previous company. ' +
    'Do not use local_bridge_status to pre-approve or skip the signed operation; the family capability and typed operation result are authoritative. ' +
    ozonHandoffGuidance;

const resultPathGuidance =
    'resultPath is only a fallback for the current call when the compact result is insufficient; it is not a cache and must not be reused for another request. ' +
    'Use it only when present. If storageWarnings accompany an absent path, preserve the inline data and explain the storage failure; never invent a file path.';

const reportDeliveryGuidance =
    'When the host provides a project output directory, the tool automatically creates verified report copies in its e-comet-reports folder. fileDelivery describes copying separately from report generation; use its stage, reason and systemCode to diagnose a failure. Never ask to mount internal Cowork plugin/session storage. ' +
    'Use the exact returned resource_link.uri or artifact.path: name is a display name and may differ from the stored filename. ' +
    'If opening fails, check that exact file with the host file capability that can access the MCP host filesystem. An empty filename search, an unavailable resource listing, or an Excel opening error does not prove deletion or retention cleanup. ' +
    'When the file exists, recover delivery through the host file capability using the same workbook; if a copy is needed, preserve the original and verify the copy against the returned size and SHA-256. ' +
    'Do not recreate a completed report because opening or reading its downloaded workbook failed. If the exact file cannot be checked from this host, report that verification gap without claiming the file is missing. ';

const localBridgeFailureGuidance =
    'LOCAL_BRIDGE_* failures describe observed local pairing or listener problems, not marketplace login failures. Use the returned cause and local_bridge_status; do not prescribe opening a WB tab or obtaining repeated authorizations for a local permissions/bind failure. ' +
    'For LOCAL_STORAGE_FAILED, use details.systemCode and the message when supplied to distinguish access, space/quota and path conflicts; do not infer the cause from the generic code alone. ';

const rejectionAndHandoffGuidance =
    'BROWSER_JOB_HANDOFF_REQUIRED (stage handoff) means this tool ran without hook-injected authorization: the host hook did not run or did not rewrite the input, because the plugin hooks are not trusted, are disabled, changed after a plugin update, or the host does not run plugin hooks in this task. It is not a marketplace, extension or account failure. Do not call browser_job or this tool again until that is resolved; each repeat spends one signed authorization. On Codex run e_comet_diagnose with installation scope, safe_probes and the hook_permissions probe and follow its result: on disabled or review_required the user enables or trusts the e-Comet handlers in Settings → Plugins → Personal → e-Comet MCP Tools → Hooks, on ready or not_checked the cause is not established; on Claude Code /hooks lists the configured hooks; on Cowork verify that the plugin is installed and enabled and start a new task. retryable:true never authorizes an automatic repeat. ' +
    'A whole-call BROWSER_JOB_REJECTED or BROWSER_JOB_ACCOUNT_MISMATCH (for Ozon tools, OZON_AUTHORIZATION_REJECTED with the same details) carries details.browserJobRejection.reason: ecomet_not_authenticated means the extension is not activated, and the user activates it with the API key from the e-Comet account (https://app.e-comet.io/account) in the browser where it is connected; subject_mismatch (code BROWSER_JOB_ACCOUNT_MISMATCH) means the extension is activated with a different e-Comet account than the connector, and the user uses the same account on both; expired or token_reuse need one fresh browser_job on the user\'s decision; every other reason is an e-Comet defect to report, not a user change. See the packaged mcp/DIAGNOSTICS.md section "Missing authorization handoff". ';

const buyerOutcomeGuidance =
    'When stopReason is "rate_limited", Wildberries returned HTTP 429: no new work was scheduled after that observation, while already in-flight requests may finish. ' +
    'Report the retained results and skipped work; never automatically repeat the job. skipped:true identifies work that was not dispatched, not proof that a product is missing. ' +
    'Use item errorDetails.code/stage/retryable when present to explain the observed failure; the legacy error text is supplementary. Do not infer missing login, extension failure or a root cause from a timeout alone. ' +
    'errorDetails.code WB_NOT_AUTHENTICATED means the page had no Wildberries session: the user must sign in to wildberries.ru in the browser and profile that made the request, where the connected extension runs; a browser found by the extension_install probe is only a hint. It is the only code that supports a "not signed in" conclusion; a timeout or WB_FETCH_FAILED does not. Then obtain a new authorization and retry only on the user\'s decision. ';

const productCardContract =
            'Get live Wildberries product-card data by article ID. Use for Russian requests about остаток, остатки, сток, наличие, склады, размеры, цена, карточка товара, описание, характеристики, or склейка. ' +
            authorizationWorkflow + localBridgeFailureGuidance + buyerOutcomeGuidance + rejectionAndHandoffGuidance +
            'Authorize with job {type:"product_card",product_ids:[integer,...]}; use 1-1000 positive product IDs. Read products[]. For price use priceRub.product; priceRub.basic is the crossed-out/basic price. ' +
            'For stock use quantity.total, quantity.byWarehouse, and quantity.bySize. Warehouse names are already in warehouse; if absent, display wh <id>. Use colors for merged articles, options for characteristics, and description for description. ' +
            'Translate raw field names for the user and render booleans as yes/no. A product-level ok:false is a failed WB request, not proof that the product does not exist. Report partial item errors. ' +
            'product.complete:false means at least one requested part failed; product.ok and succeeded can still indicate useful detail data. Do not claim the complete card or description was obtained. ' +
            'Values are a current WB-session snapshot. ' +
            resultPathGuidance;

const searchContract =
            'Get live Wildberries search results, top products, and positions for one or more phrases. Use for Russian requests about поиск, поисковая выдача, позиция товара, место по запросу, or топ товаров. ' +
            authorizationWorkflow + localBridgeFailureGuidance + buyerOutcomeGuidance + rejectionAndHandoffGuidance +
            'Authorize with job {type:"search_by_query",queries:[{query:string,pages:integer},...]}; use at most 50 pages for each query and 1000 pages total. Start with 1 page for a top list or 2-3 pages when depth is unspecified. ' +
            'For a targeted rank check, put phrases in remote job.queries and target article IDs in local productNmIds. For a top N list, use productLimitPerQuery:N. ' +
            'Read queries[].pages[].products. Use globalPosition only when globalPositionsComplete is true; position is page-local. promoted is always boolean: promoted:true means реклама (paid placement), promoted:false means органика. ' +
            'One product occupies exactly one position per phrase in a snapshot: WB does not also list it organically when it is already rendered as реклама. ' +
            'If a product appears as promoted:true, its organic position for that phrase is not observed at all in this snapshot — not "not found", but fundamentally not visible. ' +
            'Do not infer presence or absence of organic ranking from promoted:true, and never claim the product is "absent from organics" / «нет в органике». ' +
            'Correct wording: "position N, рекламная; organic position for this phrase cannot be determined from this snapshot". ' +
            'To observe the organic position, take a snapshot when реклама for that phrase is not running. ' +
            'If a target is absent, claim only that it was not found within the requested pages/positions, never that it is absent from all WB search results or from organics. Group multiple phrases separately and disclose failed pages. ' +
            'Results are a current WB-session snapshot. ' +
            resultPathGuidance;

const checkContract =
            'Check whether one Wildberries article appears in search results for 1-100 phrases. Use for Russian requests about проверка артикула в выдаче, находится ли артикул по фразе, индексируется ли товар, or по каким запросам виден товар. ' +
            authorizationWorkflow + localBridgeFailureGuidance + buyerOutcomeGuidance + rejectionAndHandoffGuidance +
            'Authorize with job {type:"check_by_query",product_id:integer,queries:[string,...]}; send one positive product ID and 1-100 unique non-empty phrases. Page depth is fixed by the service; do not supply it. ' +
            'Read queries[] separately. For found:true, report only that the product was found for the phrase. For found:false, report only that the product was not found for the phrase. ' +
            'Do not mention pagesChecked, completionReason, page limits, or brand-filtered depth unless the user explicitly asks for diagnostics. Never present pagesChecked as a page, position, rank, or search depth in ordinary unfiltered search. ' +
            'request_failed and card_failed mean the check was incomplete; report that the check was incomplete rather than reporting the product as not found. ' +
            'Do not claim that the product is absent from all Wildberries search results. Results are a current WB-session snapshot. ' +
            resultPathGuidance;

const recommendationsContract =
            'Get live Wildberries recommendation shelves for source article IDs and check whether specific products occur in them. Use for Russian requests about рекомендации, похожие товары, рекомендательная полка, соседние товары, or whether a product встречается в рекомендациях. ' +
            authorizationWorkflow + localBridgeFailureGuidance + buyerOutcomeGuidance + rejectionAndHandoffGuidance +
            'Authorize with job {type:"recommendations_by_product",products:[{product_id:integer,pages?:integer},...]}; use unique source product IDs, at most 50 pages for each product, and 1000 pages total; an omitted pages value counts as 50 toward the total. ' +
            'For первые N recommendations, explicitly request pages: 1 and pass local productLimitPerSource: N. Omit pages only when the user explicitly needs the whole discovered shelf within local limits. ' +
            'For a membership check, put исходные товары in remote job.products and целевые товары in local productNmIds. Read articles[].pages[].products and group results by sourceNmId. ' +
            'Use globalPosition only when globalPositionsComplete is true. If a target is absent, claim only that it was not found in the successfully requested part of that source shelf. ' +
            'Disclose status partial/failed, failed pages, complete:false, and truncatedByLocalLimit:true. Recommendations are a current WB-session snapshot. ' +
            resultPathGuidance;

const sellerReviewsContract =
            'Original WB seller-review XLSX. ' +
            'Call remote browser_job once: job {type:"seller_reviews",exports:[{product_id?:int,dateFrom?,dateTo?,isAnswered?:bool,ratings?:[1|2|3|4|5,...],content?},...],org?}, then immediately this tool. ' +
            'Trusted Claude/Codex hooks inject authorization: omit triggerUrl/trigger_url; never decode, print, edit, copy or expose it. ' +
            'Never infer authorization failure from status. ' +
            rejectionAndHandoffGuidance +
            'Repeat host tool search up to 3x for a missing tool; never repeat browser_job or this tool; explain confirmed errors. ' +
            'One array includes all filters. ' +
            'Omit product_id/ratings/content for all products/ratings/content; content:"media" means photo/video. ' +
            'Omitted dates mean all time; otherwise both inclusive YYYY-MM-DD dates. ' +
            'Omitted isAnswered produces separate answered and unanswered workbooks. ' +
            'Omit org for active seller company; another requires explicit user choice and one signed {id} or exact {name}. ' +
            'For legacy-restoration ENTITY_SELECTION_REQUIRED, ask company, then reauthorize explicitly; never guess. ' +
            'SELLER_LOGIN_REQUIRED means no signed-in seller cabinet tab: the user opens seller.wildberries.ru in the browser where the extension is connected and signs in; then one fresh browser_job on the user\'s decision. ' +
            'SELLER_AUTH_UNAVAILABLE with browserContext.sellerTabConnected:true means the extension could not read the cabinet\'s own request credentials: an e-Comet defect to report, not a user change; never repeat. ' +
            'Max 50 exports/100 reports, 100 MiB/XLSX, 500 MiB/job. ' +
            'Artifacts retained for 24 hours, never evicted by another export. ' +
            'Return all resource links; summarize complete/failed/skipped. ' +
            'Empty workbook cannot establish ownership. ' +
            'Never auto-retry rate limits/uncertain creates. ' +
            'Project output gets verified e-comet-reports copies; fileDelivery.stage/reason/systemCode diagnose delivery. ' +
            'Never mount Cowork internal storage. ' +
            'Use exact resource_link.uri/artifact.path, not name. ' +
            'Opening/search/listing failure cannot prove deletion: check exact file via host filesystem capability; if uncheckable, report verification gap. ' +
            'Recover same workbook; preserve original, verify copies by size/SHA-256; never regenerate for delivery failure. ' +
            'LOCAL_BRIDGE_*: pairing/listener, not login; no WB-tab/repeated-auth fix. ' +
            'LOCAL_STORAGE_FAILED: use details.systemCode/message, never guess. ' +
            'ARTIFACT_TOO_LARGE: no redownload; offer user-selected narrower export, retain workbooks. ' +
            'Metadata/private links only; bytes never enter tool result or model context, no base64. ' +
            'Read/summarize only if separately asked.';

const promotionContract =
            'Download the Ozon Seller promotion analytics report for one requested period as one XLSX workbook. ' +
            ozonAuthorizationWorkflow +
            reportDeliveryGuidance +
            rejectionAndHandoffGuidance +
            ozonHandoffGuidance +
            'Use canonical inclusive dateFrom/dateTo dates with at most 89 inclusive days. One call produces one period and one workbook. ' +
            'Neighboring analytics are unavailable in this first tool: it does not provide product, traffic, finance, campaign, or other Ozon reports. ' +
            'The operation may create a saved report in Ozon, but it does not change products, campaigns, budgets, or seller settings. ' +
            'CREATE_OUTCOME_UNKNOWN means the report may already exist: explain the uncertainty and obtain a separate user decision before another create attempt; never automatically retry it. ' +
            'For legacy singular compatibility, ARTIFACT_REJECTED may describe an internal acknowledgement failure in its message; the code alone is not proof of a disk problem. Preserve any stated confirmed create outcome and do not repeat it automatically. ' +
            'An OZON_ROUTE_NOT_READY failure carrying error.details.reason "extension_outdated" means the installed e-Comet extension is too old for this report: tell the user to update the extension to the version in error.details and retry, ' +
            `and do not tell them to open the report page. This operation requires extension ${OZON_PROMOTION_MIN_EXTENSION_VERSION} or newer and any authenticated Ozon Seller page under https://seller.ozon.ru/app, not an exact promotion-overview route and never a Wildberries tab. ` +
            'The same code without those details means no ready Ozon route was reachable; it does not establish a cause. A timeout is not proof of disconnection. If status reports extensionConnected:false, explain that there is no effective extension route, without claiming attachment to an old primary. ' +
            'For an unready route, ask the user to check the extension in the same browser profile and refresh any authenticated Ozon /app page, then obtain a new authorization before retrying. Never reuse the consumed one-use authorization, automatically loop, or use WB-tab recovery for Ozon. ' +
            'Returns compact metadata and exactly one private resource_link. The resource_link contains a local file URI; workbook bytes, base64, company context, report identifiers, and request details are not included in model content.';

const promotionPackageContract =
            'Download an ordered package of up to 50 Ozon Seller promotion analytics XLSX workbooks. ' +
            ozonPackageAuthorizationWorkflow('ozon_seller_promotion_reports', 'periods:[{dateFrom,dateTo},...]') +
            reportDeliveryGuidance +
            rejectionAndHandoffGuidance +
            'Each period independently uses canonical inclusive dates and may contain at most 89 inclusive days. Periods may overlap and need not be chronological; exact duplicates are rejected and there is no aggregate-day cap. ' +
            'One browser authorization and one local call cover the whole ordered package. Completed workbooks remain available when later items fail; return every completed resource_link and report every failed and skipped item from the ordered result. ' +
            'The operation may create saved reports in Ozon, but it does not change products, campaigns, budgets, or seller settings. ' +
            'Returns compact metadata and one private resource_link per completed workbook. The resource_link contains a local file URI; workbook bytes, base64, company context, report identifiers, and request details are not included in model content.';

const analyticsPackageContract =
            'Download an ordered package of up to 50 Ozon Seller general analytics XLSX workbooks. ' +
            ozonPackageAuthorizationWorkflow('ozon_seller_analytics_report', 'reports:[{dateFrom,dateTo,breakdown},...]') +
            reportDeliveryGuidance +
            rejectionAndHandoffGuidance +
            'Each report independently uses canonical inclusive dates, an explicit breakdown:"period" or breakdown:"daily", at most 731 inclusive days, and the signed Moscow issuance window. ' +
            'daily means daily rows inside one XLSX workbook for that report; never create one report per day unless the user explicitly requests separate date items. ' +
            'REPORT_TERMINAL_FAILURE may include details.marketplaceErrorCode: retain this observed numeric code in a consented bug report, but never invent its business meaning or treat it as permission to retry create. ' +
            'Ranges may overlap and need not be chronological; the same range with different breakdowns is valid, exact duplicate descriptors are rejected, and there is no aggregate-day cap. ' +
            'One browser authorization and one local call cover the whole ordered package. Completed workbooks remain available when later items fail; return every completed resource_link and report every failed and skipped item from the ordered result. ' +
            'Check that the connected extension advertises the analytics capability; tool presence alone is not readiness. ' +
            'Promotion analytics remains a separate Ozon workflow. The operation may create saved reports in Ozon, but it does not change products, campaigns, budgets, or seller settings. ' +
            'Returns compact metadata and one private resource_link per completed workbook. The resource_link contains a local file URI; workbook bytes, base64, company context, report identifiers, and request details are not included in model content.';

export const feedbackToolContract = String.raw`# Send feedback to e-Comet

Use the remote \`report_issue\` tool together with the local \`prepare_e_comet_feedback\` and \`submit_e_comet_feedback\` tools. This is an externally mutating workflow: preserve the user's consent and resolved history choice through every recovery step.

Before preparation, ensure remote e-Comet \`report_issue\` is available in the current session. If it is deferred, perform one targeted tool search for \`report_issue\`; do not treat the two local tools as a complete sending capability. If it is unavailable, stop before preparation and explain that sending requires the remote e-Comet connector. Check connector status through the host when possible; ask the user to connect or sign in only when it is observed disconnected. Tool absence alone does not prove disconnection. Preserve the issue and chosen history option.

## Resolve the report and history choice

Require enough existing facts to identify what went wrong and explicit user agreement to report it. Ask only for what is missing. If the issue is absent or too vague to identify, ask one short plain-language question about what happened.

Preserve any explicit history include or exclude instruction and do not ask again about that choice. If the issue is identifiable but report consent is missing and no explicit history preference is known, ask naturally in one prompt whether to send the report and whether the user wants the default bounded current-session history excluded. With an explicit history preference, ask only for missing report consent.

Before preparation, even when report consent already exists, if no explicit history preference is known and the history interaction has not occurred, explain the default and ask whether the user wants the bounded current-session history excluded, then wait and call no feedback tools. Warn at most once that this history is attached by default, includes more than the visible chat, and may contain system context, tool calls and results, code, paths, and sensitive data; say that the user may explicitly opt out. Do not repeat the warning when clarifying consent.

Do not describe report contents, diagnostics, environment metadata, version, platform, architecture, size, or file formats. Do not present a formal bullet list, checklist, or three-option menu unless requested. Cancellation is accepted but need not be offered as a menu option.

After explicit report consent and the history disclosure and question, clear ordinary continuation defaults to \`includeTranscript:true\`. Use \`includeTranscript:false\` only when the user explicitly opts out. Silence is not consent and calls no feedback tools. If report consent or the history preference is ambiguous, ask one short clarification, do not repeat the warning, and call no feedback tools until resolved. For example, “Yes, send it; maybe leave the history out” leaves the history preference unresolved; default inclusion must not override it. The history interaction is complete only after an explicit include or exclude choice, or clear continuation after the disclosure and question with no unresolved preference.

If the user declines or cancels, do not call \`prepare_e_comet_feedback\`, \`report_issue\`, or \`submit_e_comet_feedback\`. When the issue and explicit report consent are known, the history interaction is complete, and \`report_issue\` is available, the first subsequent action must be \`prepare_e_comet_feedback\`; emit no acknowledgement, restatement, recap, diagnostic call, or other prose before it.

## Author and send

Build \`summary\` and \`details\` only from evidence already in the conversation and observed e-Comet results. When known, cover the affected operation or tool, observed result, expected result, reproduction context, and recovery attempted; preserve the exact safe error code and message. Exclude credentials, personal or commercial data, source code, file paths, and unrelated user content, even from tool results. Generalize relevant context to the minimum needed. Omit unknown facts and never invent a cause. Ask one question only when there is no minimally identifiable issue; do not ask merely to fill optional fields.

Add an \`Available remote e-Comet tools\` subsection to \`details\` before the chain starts. List deduplicated full names from the agent-visible remote inventory, separate from tools called in the session, and label the source \`agent-visible inventory\`. Mark completeness \`reported complete\` only when the host exposes its full catalog, including deferred tools; otherwise use \`partial\`. Enumerate metadata only: never call a business or authorization tool to discover names. If no inventory is available, write \`Inventory unavailable\` and continue. Never fabricate a name, availability, or completeness.

Use exactly one kind: \`bug\`, \`wrong_data\`, \`missing_capability\`, or \`unclear_contract\`, and pass it unchanged to \`report_issue\`. Never author hook-only fields or aliases, including \`transcriptPath\`, \`transcript_path\`, \`feedbackClaim\`, \`feedback_claim\`, \`feedbackSession\`, \`feedback_session\`, \`feedbackAdapter\`, or \`feedback_adapter\`.

The required order is \`prepare_e_comet_feedback\`, remote \`report_issue\`, then \`submit_e_comet_feedback\`. After preparation, immediately call \`report_issue\` exactly once with \`{kind: prepared.kind, size_bytes: prepared.sizeBytes}\`, then immediately call \`submit_e_comet_feedback\` with \`{artifactId: prepared.artifactId}\` only. In Codex, run all three calls sequentially and await each result; direct MCP and \`functions.exec\` are both allowed, but dependent stages must not run in parallel. Do not insert prose, \`local_bridge_status\`, repeated discovery, a resource read, or diagnostics between successful stages. A native \`report.md\` link is temporary and must not be reread in this flow; cloud preparation supplies metadata without that link.

Feedback is independent of bridge role, extension readiness, \`browser_job\`, and marketplace tabs.

## Authorization and recovery

Call \`report_issue\` at most once per prepared artifact. Call it again only when a submit result or hook denial explicitly states that authorization expired or a fresh one is required: \`FEEDBACK_GRANT_REFRESH_REQUIRED\`, or a message naming \`report_issue\` as the next step. Retry the same artifact only when the current hook result explicitly confirms no upload request started, authorization was kept, and another submit is the next step. Never automatically retry a rejected, uncertain, or terminally refused upload.

The service allows five authorizations per hour. On a \`report_issue\` rate-limit error, the prepared report stays valid for 24 hours: say «Лимит отправки отчётов исчерпан, попробуйте позже.», do not prepare or send it again, and do not retry \`report_issue\` automatically.

\`FEEDBACK_GRANT_MISSING\` is a denial by a running hook, not evidence that hooks are disabled or untrusted, and this submit was blocked before upload. If no earlier upload was attempted, say «Отчёт не отправлен: не получено разрешение на загрузку.» If \`report_issue\` was skipped, no earlier upload is uncertain, and consent remains valid, obtain its grant once and continue with the same prepared artifact and history choice; do not repeat consent or recreate the archive. If \`report_issue\` already ran, inspect its result and handoff evidence; missing grant state alone does not authorize repeating it.

Explain failures only from the fixed safe message and supplied closed \`error.details.operation\`, \`reason\`, \`systemCode\`, and \`httpStatus\`. An optional source module and line are public-code investigation context, not a user path or proven cause. Unknown internal errors remain unknown. A trusted-hook denial does not authorize changing consent, history choice, or hook trust. \`status:"not_started"\` confirms that call did not upload; follow its current reason and action without describing it as possibly sent, while preserving any separate earlier uncertainty.

After preparation failure, explain the observed error, what it does not establish, and one action from \`recommendedAction\`. \`CHECK_FEEDBACK_HOOKS\` means inspect available host/plugin configuration and evidence; suggest enabling or trusting a hook only when that missing prerequisite is observed. \`RESTART_FEEDBACK_FLOW\` means explain only the supplied handoff evidence and ask the user to start a fresh flow; it does not itself prove invalidity or expiry. \`RETRY_WITH_VALID_REPORT\` corrects only identified invalid fields and preserves history choice. \`RETRY_FEEDBACK_ONCE\` offers one retry, never a loop. \`CHECK_LOCAL_STORAGE\` asks the user to check local storage access without exposing paths. \`FEEDBACK_HOOK_HANDOFF_UNAVAILABLE\` does not establish its cause; in Claude Code, \`/hooks\` inspects configured hooks, while Cowork has no invented hook-trust switch.

\`UPLOAD_DESTINATION_REFUSED\` and \`FEEDBACK_ARCHIVE_MISMATCH\` are terminal: report the safe error and stop without retrying submit, obtaining another grant, or preparing again. For any uncertain upload, preparation metadata such as expiry does not prove recoverable bytes. Never promise an archive, save, report, receipt, or status lookup; never resend that artifact or prepare a new report as a workaround. If submit returns \`UPLOAD_UNCERTAIN\` or \`FEEDBACK_SUBMISSION_FAILED\` without \`status:"not_started"\`, say «Не удалось подтвердить отправку. Отчёт мог быть получен, поэтому я не буду отправлять его повторно автоматически.» and ask what the user wants to do.

After \`status:"uploaded"\`, answer in Russian: «Отчёт отправлен в e-Comet.», when useful specify «…с историей текущей сессии.» or «…без истории текущей сессии.» according to \`transcriptIncluded\`, then «При обращении в поддержку используйте идентификатор обращения:» and the exact \`reportId\` value on the next line, copied verbatim. Only a \`status:"uploaded"\` result has an identifier. Do not mention transcript truncation or add implementation details or caveats.
`.replaceAll(String.raw`\``, '\x60');

export const FEEDBACK_CONTRACT_SCHEMA_VERSION = 1;

export const FEEDBACK_CONTRACT_TOOL_NAMES = Object.freeze([
    'prepare_e_comet_feedback',
    'submit_e_comet_feedback',
]);

const signedNames = [
    'wb_product_card', 'wb_search_by_query', 'wb_check_by_query',
    'wb_recommendations_by_product', 'wb_seller_reviews',
    'ozon_seller_promotion_report', 'ozon_seller_promotion_reports',
    'ozon_seller_analytics_report',
];

export const SIGNED_CONTRACT_TOOL_NAMES = Object.freeze(signedNames);
export const CONTRACT_TOOL_NAMES = Object.freeze([...FEEDBACK_CONTRACT_TOOL_NAMES, ...SIGNED_CONTRACT_TOOL_NAMES]);

const signedContracts = Object.freeze({
    wb_product_card: productCardContract,
    wb_search_by_query: searchContract,
    wb_check_by_query: checkContract,
    wb_recommendations_by_product: recommendationsContract,
    wb_seller_reviews: sellerReviewsContract,
    ozon_seller_promotion_report: promotionContract,
    ozon_seller_promotion_reports: promotionPackageContract,
    ozon_seller_analytics_report: analyticsPackageContract,
});

const feedbackContractAppliesTo = Object.freeze([
    'prepare_e_comet_feedback',
    'report_issue',
    'submit_e_comet_feedback',
]);

const feedbackResult = (name) => {
    return {
        schemaVersion: FEEDBACK_CONTRACT_SCHEMA_VERSION,
        type: 'e_comet_tool_contract',
        requestedTool: name,
        appliesTo: [...feedbackContractAppliesTo],
        contract: feedbackToolContract,
    };
};

export const describeToolContract = (name) => {
    if (FEEDBACK_CONTRACT_TOOL_NAMES.includes(name)) return feedbackResult(name);
    if (!Object.hasOwn(signedContracts, name)) return null;
    return {
        schemaVersion: FEEDBACK_CONTRACT_SCHEMA_VERSION,
        type: 'e_comet_tool_contract',
        requestedTool: name,
        appliesTo: ['browser_job', name],
        contract: signedContracts[name],
    };
};
