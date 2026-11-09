import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { isNonNegativeSafeInteger, isOneOf, isRecord } from '../../shared/values.mjs';
import { BRIDGE_CODES } from '../diagnostics/bridge-codes.mjs';
import { SELLER_FAILURE_CLASSES, SELLER_FAILURE_REASONS, WBAAS_RECOVERY_OUTCOMES, WB_FETCH_TIMEOUT_PHASES, } from '../extension/wire.mjs';
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
    if (typeof value.httpStatus === 'number' &&
        Number.isSafeInteger(value.httpStatus) &&
        value.httpStatus >= 100 &&
        value.httpStatus <= 599)
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
