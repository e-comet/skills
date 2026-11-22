import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { isHttpStatus, isNonNegativeSafeInteger, isOneOf, isRecord } from '../../shared/values.mjs';
import { BRIDGE_CODES } from '../diagnostics/bridge-codes.mjs';
import { COMPARISON_STREAM_DEADLINE, SELLER_FAILURE_CLASSES, SELLER_FAILURE_REASONS, WBAAS_RECOVERY_OUTCOMES, WB_FETCH_TIMEOUT_PHASES, } from '../extension/wire.mjs';
// Closed rule names of a signed descriptor that broke a local limit (each context's validateAuthorizedJobLimits).
export const DESCRIPTOR_RULES = [
    'descriptor',
    'job_type',
    'timeout',
    'type',
    'endpoint',
    'params',
    'queries',
    'pages',
    'requests',
    'assembled_url',
    'product',
    'card_url',
    'filters',
    'articles',
    'endpoints',
    'unique_products',
    'seller_exports',
    'ozon_descriptor',
    'ozon_items',
    'ozon_canonical',
];
export const ARTIFACT_FAILURE_CLASSES = ['disk', 'limit', 'integrity', 'format'];
// Filesystem errors a local write reports, each with its step in LOCAL_STORAGE_MESSAGES. Only free space is the
// seller's own step: e-Comet picks the output folder unless the user set a custom one.
const CUSTOM_FOLDER_STEP = 'If the user set a custom e-Comet output folder, ask them to check access to it; otherwise offer to report it.';
export const LOCAL_STORAGE_MESSAGES = {
    EBUSY: 'Local output storage is busy. Let any other pending work finish, then retry; report a persistent failure to e-Comet.',
    EEXIST: `A local output path conflicts with an existing entry. ${CUSTOM_FOLDER_STEP}`,
    EACCES: `The agent process cannot access local output storage. ${CUSTOM_FOLDER_STEP}`,
    EPERM: `The operating system denied access to local output storage. ${CUSTOM_FOLDER_STEP}`,
    ENOSPC: 'Local output storage has no free space. Free space before requesting the report again.',
    EDQUOT: 'The local output storage quota is exhausted. Restore available quota before requesting the report again.',
    EROFS: `Local output storage is read-only. ${CUSTOM_FOLDER_STEP}`,
    ENOTDIR: `A local output path contains an entry that is not a directory. ${CUSTOM_FOLDER_STEP}`,
};
// Every closed value a local failure may carry in `details` (spec 7.2, 7.4). The output schemas take these lists.
export const FAILURE_DETAIL_VALUES = {
    reason: ['expired', 'route_changed', 'released', ...Object.values(SELLER_FAILURE_REASONS).flat()],
    phase: WB_FETCH_TIMEOUT_PHASES,
    class: [...SELLER_FAILURE_CLASSES, ...ARTIFACT_FAILURE_CLASSES],
    recovery: WBAAS_RECOVERY_OUTCOMES,
    systemCode: Object.keys(LOCAL_STORAGE_MESSAGES),
    rule: DESCRIPTOR_RULES,
};
// Keeps only the closed failure details this process recognizes; anything else is dropped.
// Parse boundary: `value` is untrusted and narrowed key by key here.
export const closedFailureDetails = (value) => {
    if (!isRecord(value))
        return undefined;
    const details = {};
    for (const [key, values] of Object.entries(FAILURE_DETAIL_VALUES))
        if (values.includes(value[key]))
            details[key] = value[key];
    if (typeof value.wbRefused === 'boolean' && details.class !== undefined)
        details.wbRefused = value.wbRefused;
    if (isHttpStatus(value.httpStatus))
        details.httpStatus = value.httpStatus;
    if (isNonNegativeSafeInteger(value.completed) && isNonNegativeSafeInteger(value.pending))
        Object.assign(details, { completed: value.completed, pending: value.pending });
    return Object.keys(details).length ? details : undefined;
};
export const failureDetails = (error) => (error instanceof ToolExecutionError ? closedFailureDetails(error.details) : undefined);
// The bridge cause an Ozon authorization failure carries when no broker answered. Only this process builds it, and only a
// closed cause code passes.
export const bridgeCodeDetails = (error) => {
    const bridgeCode = error instanceof ToolExecutionError && error.code === 'OZON_AUTHORIZATION_REJECTED' ? error.details?.bridgeCode : undefined;
    return isOneOf(BRIDGE_CODES, bridgeCode) ? { bridgeCode } : undefined;
};
// Причина отказа для сборки расширения, не объявившей возможность Ozon. Терминальный код при этом
// остаётся OZON_ROUTE_NOT_READY: набор кодов зафиксирован в contracts/local-agent-contract.json,
// который обязан побайтно совпадать с копией в репозитории расширения, поэтому отдельный код связал
// бы этот фикс с релизом расширения. Отличие от настоящего «страница отчёта не открыта» несёт
// именно этот reason вместе с текстом сообщения.
export const OZON_EXTENSION_OUTDATED_REASON = 'extension_outdated';
// Версия расширения приходит из hello_ack через брокер, то есть
// из-за границы процесса. В текст и в details она попадает только в консервативном виде: произвольная
// строка вывела бы сообщение за MAX_SAFE_MESSAGE_LENGTH, и весь терминальный ответ выродился бы в
// нераспознанную ошибку вместо диагноза.
const SAFE_EXTENSION_VERSION = /^[\w.+-]{1,32}$/;
export const safeExtensionVersion = (value) => typeof value === 'string' && SAFE_EXTENSION_VERSION.test(value) ? value : undefined;
export const OZON_PROMOTION_TERMINAL_CODE_STAGES = {
    OZON_AUTHORIZATION_REJECTED: 'authorization',
    OZON_ADMISSION_CAPACITY_EXHAUSTED: 'extension',
    OZON_ROUTE_NOT_READY: 'route',
    OZON_CONTEXT_CHANGED: 'context',
    PREFLIGHT_FAILED: 'preflight',
    REPORT_AMBIGUOUS: 'preflight',
    CREATE_REJECTED: 'create',
    CREATE_SERVICE_UNAVAILABLE: 'create',
    CREATE_OUTCOME_UNKNOWN: 'create',
    CREATE_REPORT_AMBIGUOUS: 'create',
    CREATE_NOT_OBSERVABLE: 'create',
    POLL_FAILED: 'poll',
    POLL_EXHAUSTED: 'poll',
    REPORT_TERMINAL_FAILURE: 'poll',
    DOWNLOAD_REJECTED: 'download',
    REUSED_REPORT_FORMAT_UNVERIFIED: 'download',
    OZON_RATE_LIMITED: 'rate_limit',
    ARTIFACT_REJECTED: 'artifact',
    OZON_EXECUTION_INTERRUPTED: 'execution',
    OPERATION_CANCELLED: 'cancelled',
    OPERATION_DEADLINE_EXCEEDED: 'deadline',
};
// The closed class of a local workbook write that failed: a filesystem code, or the class the writer named.
export const artifactFailureDetails = (error) => {
    if (!(error instanceof Error))
        return undefined;
    const code = 'code' in error ? error.code : undefined;
    const artifactClass = 'artifactClass' in error ? error.artifactClass : undefined;
    if (typeof code === 'string' && Object.hasOwn(LOCAL_STORAGE_MESSAGES, code))
        return { class: 'disk', systemCode: code };
    return typeof artifactClass === 'string' && ARTIFACT_FAILURE_CLASSES.includes(artifactClass)
        ? { class: artifactClass }
        : undefined;
};
// The next step and its owner for a rejected local workbook write, by its closed class.
const storageMessages = LOCAL_STORAGE_MESSAGES;
export const artifactFailureMessage = (details) => details?.class === 'disk'
    ? typeof details.systemCode === 'string'
        ? storageMessages[details.systemCode]
        : undefined
    : details?.class === 'limit'
        ? "This job's workbooks exceed the per-job storage limit; split it into smaller jobs."
        : ARTIFACT_FAILURE_CLASSES.includes(details?.class)
            ? 'The workbook stream did not pass the local integrity checks; this is an e-Comet defect. Offer to report it.'
            : undefined;
// The closed class (and filesystem code) of a local workbook write this process rejected.
export const artifactRejectedDetails = (error) => {
    const details = error instanceof ToolExecutionError && error.code === 'ARTIFACT_REJECTED' ? error.details : undefined;
    const artifactClass = details?.class, systemCode = details?.systemCode;
    return isOneOf(ARTIFACT_FAILURE_CLASSES, artifactClass)
        ? { class: artifactClass, ...(isOneOf(FAILURE_DETAIL_VALUES.systemCode, systemCode) ? { systemCode } : {}) }
        : undefined;
};
export const descriptorRuleDetails = (error) => {
    const rule = error instanceof ToolExecutionError && error.code === 'OZON_AUTHORIZATION_REJECTED' ? error.details?.rule : undefined;
    return isOneOf(DESCRIPTOR_RULES, rule) ? { rule } : undefined;
};
// The agent's step for a WB fetch failure the extension classified by its phase or reason, or none.
const AUTHORIZE_REMAINING = 'then request a new browser job for the exports that did not complete.';
const SELLER_SIGN_IN_STEP = `Ask the user to reload the seller portal tab and sign in if it asks, ${AUTHORIZE_REMAINING} ` +
    'If the same reason repeats, this is an e-Comet defect: offer to report it.';
const FETCH_GUIDANCE = {
    'WB_FETCH_TIMEOUT:no_tab': 'Wildberries did not answer in time: no Wildberries tab was open, so the extension had to open one. ' +
        'Ask the user to keep www.wildberries.ru open in that browser, then retry.',
    'WB_FETCH_TIMEOUT:tab_loading': 'Wildberries did not answer in time: the Wildberries tab was still loading or not answering. ' +
        'Ask the user to wait until the Wildberries page has loaded, then retry.',
    'WB_FETCH_TIMEOUT:reload_backoff': 'Wildberries did not answer in time: a reloaded Wildberries tab did not become ready, and the extension is waiting before the next reload. ' +
        'Ask the user to open the Wildberries tab and check that the page loads, then retry.',
    'WB_FETCH_TIMEOUT:reload_failed': 'Wildberries did not answer in time: reloading or opening a Wildberries tab failed. ' +
        'Ask the user to open www.wildberries.ru in that browser and check that it loads, then retry.',
    'WB_FETCH_TIMEOUT:not_sent': 'Wildberries did not answer in time: the request waited behind other Wildberries requests and was not sent. ' +
        'Retry with fewer queries or pages.',
    'WB_FETCH_TIMEOUT:sent_no_answer': 'Wildberries received the request but did not answer in time. ' + 'Retry later; if it repeats, offer to report it.',
    'SELLER_STATE_UNAVAILABLE:probe_cooling_down': 'Restoring the previous seller company failed; the extension allows the next attempt in a few seconds. ' +
        `No new seller operation was dispatched. Wait a few seconds, ${AUTHORIZE_REMAINING}`,
    'SELLER_STATE_UNAVAILABLE:restore_unresolved': 'The previous seller company has not been restored. No new seller operation was dispatched. ' +
        `Ask the user to open the Wildberries seller portal and check which company is selected, ${AUTHORIZE_REMAINING}`,
    // A full extension storage quota survives the restart.
    'SELLER_STATE_UNAVAILABLE:storage_failed': 'The extension could not read or write its seller restoration state. No new seller operation was dispatched. ' +
        `Ask the user to restart the browser, ${AUTHORIZE_REMAINING} If it repeats, offer to report it.`,
    'ENTITY_SELECTION_REQUIRED:comparison_orphan': 'The previous comparison tab is unavailable. In one ready Wildberries Seller tab, ask the seller to select a different company manually and leave it selected. ' +
        'Ask whether they want to continue before requesting a fresh grant for the requested reviews.',
    // The extension reads the tokens from the page's storage, whose keys Wildberries has renamed before (2026-09-17): a
    // reason that survives a reload and a sign-in is ours. Accepted residual "A reasonless SELLER_AUTH_UNAVAILABLE gets no
    // step": docs/architecture/residuals/wildberries.md.
    'SELLER_AUTH_UNAVAILABLE:access_token_missing': `The Wildberries seller portal tab has no readable access token. ${SELLER_SIGN_IN_STEP}`,
    'SELLER_AUTH_UNAVAILABLE:seller_token_missing': `The Wildberries seller portal tab has no readable seller token. ${SELLER_SIGN_IN_STEP}`,
    'SELLER_AUTH_UNAVAILABLE:both_missing': `The Wildberries seller portal tab has no readable sign-in data. ${SELLER_SIGN_IN_STEP}`,
    // The limit is the extension's own, so signing in again cannot shrink Wildberries' token.
    'SELLER_AUTH_UNAVAILABLE:header_too_long': 'The Wildberries seller portal sign-in data is larger than the extension accepts; this is an e-Comet defect. ' +
        'Offer to report it; do not repeat the export automatically.',
    'SELLER_AUTH_UNAVAILABLE:reader_failed': 'The extension could not read the Wildberries seller portal sign-in data; this is an e-Comet defect. ' +
        'Offer to report it; do not repeat the export automatically.',
};
export const fetchFailureGuidance = (code, details) => FETCH_GUIDANCE[`${code}:${details?.phase ?? details?.reason}`];
// Fixed messages for the comparison-only reasons and existing seller relay codes. Avoid forwarding page prose,
// which may contain private data or package advice that cannot apply to one indivisible comparison.
export const COMPARISON_FAILURE_MESSAGES = {
    access_denied: 'Wildberries denied comparison or Excel access for the selected seller company.',
    access_unknown: 'The extension could not establish the seller company’s access to comparison and Excel.',
    period_out_of_range: 'The requested dates are outside the Wildberries comparison window for the seller browser’s local day.',
    period_unavailable: 'This Wildberries company offers the today, week, month and quarter buttons. Choose one of those periods or its exact dates.',
    cards_unavailable: 'Wildberries reported that one or more cards in the requested set are unavailable.',
    new_comparison_required: 'The selected cards have no usable saved comparison for this request.',
    history_charge_required: 'Wildberries reported that the saved comparison is no longer free to reopen. Reopening it would use the selected company’s comparison quota.',
    comparison_limit: 'Wildberries reported that this seller company cannot create another comparison.',
    export_limit: 'Wildberries reported that the seller company cannot order another Excel file.',
    rate_limited: 'Wildberries rate limited this request (HTTP 429). The comparison job stopped.',
    wb_refused: 'Wildberries refused this comparison operation.',
    outcome_unknown: 'The result of the request sent to Wildberries could not be established.',
    report_failed: 'Wildberries marked this Excel file as failed.',
    response_invalid: 'The seller comparison response did not match the signed operation or the expected response format. Offer to report it to e-Comet.',
    download_refused: 'The Excel file could not be downloaded from Wildberries.',
};
const sellerTabRecoveryStep = 'Open seller.wildberries.ru in the connected browser profile, or refresh the Wildberries Seller tab if it is already open. ' +
    'Wait for the cabinet and company menu to load.';
const COMPARISON_RELAY_MESSAGES = {
    BROWSER_JOB_EXPIRED: 'Authorization expired before the comparison job finished.',
    BROWSER_JOB_REQUIRED: 'The comparison authorization ended before the job finished.',
    BROWSER_JOB_NOT_AUTHORIZED: 'The extension did not accept this comparison authorization.',
    DUPLICATE_REQUEST_ID: 'This request is already in progress in the extension.',
    TOO_MANY_PENDING_REQUESTS: 'The extension has too many pending requests.',
    SESSION_CLOSED: 'The extension session closed during the comparison job.',
    WB_FETCH_TIMEOUT: 'The seller cabinet did not answer this operation in time.',
    SELLER_OPERATION_TIMEOUT: 'The seller operation deadline expired before dispatch.',
    SELLER_OPERATION_NOT_AUTHORIZED: 'The extension refused this operation under the signed comparison scope.',
    SELLER_OPERATION_FAILED: 'The admitted seller operation failed inside the extension.',
    SELLER_OPERATION_RATE_LIMITED: 'The extension refused the operation because it arrived too soon after another seller operation.',
    SELLER_PORT_UNAVAILABLE: 'No usable Wildberries Seller tab was available for this operation. ' + sellerTabRecoveryStep,
    SELLER_LOGIN_REQUIRED: 'Open the Wildberries seller cabinet in the connected browser and sign in.',
    SELLER_AUTH_UNAVAILABLE: 'The selected seller tab could not supply its authenticated cabinet session.',
    SELLER_CABINET_UNAUTHORIZED: 'Wildberries did not accept the seller cabinet session.',
    SELLER_CABINET_RATE_LIMITED: COMPARISON_FAILURE_MESSAGES.rate_limited,
    SELLER_CONTEXT_CHANGED: 'The selected seller cabinet changed or its tab became unavailable during this operation. ' +
        'If the tab was closed, reopen seller.wildberries.ru in the connected browser profile. ' +
        'Check the active company in Wildberries Seller and confirm which cabinet you want to use.',
    SELLER_STATE_UNAVAILABLE: 'The extension could not verify the Seller restoration state.',
    SELLER_RESPONSE_INVALID: COMPARISON_FAILURE_MESSAGES.response_invalid,
    ENTITY_CATALOG_UNAVAILABLE: 'The extension could not read a current list of seller companies. ' + sellerTabRecoveryStep,
    ENTITY_SELECTION_REQUIRED: 'Choose the seller company explicitly by its canonical ID before authorizing an export. ' +
        'If the ID is unknown, use wb_seller_list_orgs and ask the seller to choose from the returned catalog.',
    ENTITY_NOT_AVAILABLE: 'The signed seller company is unavailable in the current Wildberries seller session.',
};
export const isComparisonRelayFailureCode = (code) => typeof code === 'string' && Object.hasOwn(COMPARISON_RELAY_MESSAGES, code);
export const comparisonRelayFailureDetails = (code, reason) => {
    const reasons = SELLER_FAILURE_REASONS;
    if (isOneOf(reasons[code] ?? [], reason))
        return { reason };
};
const COMPARISON_RESTORE_MESSAGES = {
    storage_failed: 'The extension could not read or save the local Seller restoration state. Restart the browser. If it repeats, offer to report it to e-Comet.',
    probe_cooling_down: 'Wait a few seconds before the extension can check restoration of the previous seller company again.',
    restore_unresolved: 'The extension could not confirm restoration of the previous seller company. Check which company is active in the Wildberries Seller portal.',
};
export const comparisonRelayFailureMessage = (code, reason) => {
    if (code === 'SELLER_STATE_UNAVAILABLE' && isOneOf(SELLER_FAILURE_REASONS.SELLER_STATE_UNAVAILABLE, reason)) {
        return COMPARISON_RESTORE_MESSAGES[reason];
    }
    if (code === COMPARISON_STREAM_DEADLINE.code && reason === COMPARISON_STREAM_DEADLINE.reason) {
        return 'The comparison workbook stream exceeded its local delivery deadline.';
    }
    if (code === 'ENTITY_SELECTION_REQUIRED' && reason === 'multiple_seller_documents') {
        return ('More than one Wildberries Seller page connection is eligible. ' +
            'Leave one Wildberries Seller tab in the connected profile and wait until it loads.');
    }
    if (code === 'ENTITY_SELECTION_REQUIRED' && reason === 'comparison_orphan') {
        return ('The previous comparison tab is unavailable. Leave one ready Wildberries Seller tab in the connected profile. ' +
            'Ask the seller to choose a company and authorize a new comparison with explicit org, or have them manually select a different company in the cabinet.');
    }
    return isComparisonRelayFailureCode(code) ? COMPARISON_RELAY_MESSAGES[code] : undefined;
};
const SELLER_CATALOG_FAILURE_MESSAGES = {
    BROWSER_JOB_EXPIRED: 'The authorization expired before the seller company catalog could be read.',
    BROWSER_JOB_NOT_AUTHORIZED: 'The extension did not accept this seller catalog authorization.',
    BROWSER_JOB_REQUIRED: 'The seller catalog authorization ended before the read finished.',
    BROWSER_JOB_REAUTHORIZATION_REQUIRED: 'The seller catalog authorization ended before the read finished.',
    EXTENSION_DISCONNECTED: 'The browser connection closed before the seller company catalog was read.',
    SELLER_OPERATION_NOT_AUTHORIZED: 'The extension refused the operation under the signed seller catalog scope.',
    SELLER_CABINET_UNAUTHORIZED: 'Wildberries did not accept the Seller session. Open the cabinet in the connected browser and check sign-in.',
};
export const sellerCatalogFailureMessage = (code, reason) => {
    if (reason === 'rate_limited')
        return 'Wildberries rate limited the catalog request (HTTP 429). The read stopped.';
    if (reason === 'response_invalid')
        return 'The Wildberries Seller catalog response did not match the expected format. Offer to report it to e-Comet.';
    return (SELLER_CATALOG_FAILURE_MESSAGES[code] ??
        comparisonRelayFailureMessage(code, reason) ??
        'The seller company catalog could not be read.');
};
