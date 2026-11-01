import { BRIDGE_CODES } from './bridge-codes.mjs';
import {
    EXTENSION_UPDATE_URL,
    OZON_PROMOTION_CAPABILITY,
    OZON_PROMOTION_MIN_EXTENSION_VERSION,
    SELLER_FAILURE_CLASSES,
    SELLER_FAILURE_REASONS,
    WBAAS_RECOVERY_OUTCOMES,
    WB_FETCH_TIMEOUT_PHASES,
    isOzonExecutionInterruptionDetails,
} from './extension-vocabulary.mjs';
import { StorageUnavailableError } from './storage-layout.mjs';

const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;
const SAFE_STAGES = new Set(['arguments', 'handoff', 'extension', 'authorization', 'execution', 'storage', 'images', 'seller', 'local']);
const BROWSER_JOB_REJECTION_CODES = new Set(['BROWSER_JOB_REJECTED', 'BROWSER_JOB_ACCOUNT_MISMATCH']);
export const BROWSER_JOB_REJECTION_REASONS = new Set(['public_key_not_configured', 'user_not_available', 'invalid_format', 'invalid_algorithm', 'invalid_signature', 'issuer_mismatch', 'audience_mismatch', 'subject_mismatch', 'expired', 'invalid_job', 'token_reuse', 'ecomet_not_authenticated', 'activation_storage_unavailable', 'device_clock_ahead', 'device_clock_behind', 'storage_unavailable', 'unknown']);
export const BROWSER_JOB_INVALID_JOB_DIAGNOSTICS = new Set(['job_type', 'jobs_count', 'descriptor_type', 'descriptor_shape', 'date_from', 'date_to_or_range', 'claims_iat_or_jti']);
export const DEVICE_CLOCK_REASONS = Object.freeze(['device_clock_ahead', 'device_clock_behind']);
const exactKeys = (value, allowed, required) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));

export const parseBrowserJobRejection = (code, value) => {
    if (!BROWSER_JOB_REJECTION_CODES.has(code) || !exactKeys(value, ['schemaVersion', 'reason', 'diagnostic', 'skewMinutes'], ['schemaVersion', 'reason']) ||
        value.schemaVersion !== 1 || !BROWSER_JOB_REJECTION_REASONS.has(value.reason)) return undefined;
    if (value.diagnostic !== undefined && (value.reason !== 'invalid_job' || !BROWSER_JOB_INVALID_JOB_DIAGNOSTICS.has(value.diagnostic))) return undefined;
    if (value.skewMinutes !== undefined && (!DEVICE_CLOCK_REASONS.includes(value.reason) || !Number.isSafeInteger(value.skewMinutes) ||
        value.skewMinutes < 0 || value.skewMinutes > 1_000_000)) return undefined;
    return Object.freeze({ schemaVersion: 1, reason: value.reason, ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
        ...(value.skewMinutes === undefined ? {} : { skewMinutes: value.skewMinutes }) });
};

// The agent's next step and its owner for a refusal reason the extension names (spec 7.2). A reason without a row
// keeps the extension's own message.
const AUTHORIZE_AGAIN = 'then request a new browser job.';
const AUTHORIZE_REMAINING = 'then request a new browser job for the exports that did not complete.';
const SELLER_SIGN_IN_STEP = `Ask the user to reload the seller portal tab and sign in if it asks, ${AUTHORIZE_REMAINING} ` +
    'If the same reason repeats, this is an e-Comet defect: offer to report it.';
export const rejectionGuidance = (rejection) => {
    const skew = rejection?.skewMinutes === undefined ? '' : ` by about ${rejection.skewMinutes} minutes`;
    if (rejection?.reason === 'device_clock_ahead') return `This computer's clock runs ahead${skew}, so the extension saw the browser job as expired. ` +
        `Ask the user to sync the system clock, ${AUTHORIZE_AGAIN}`;
    if (rejection?.reason === 'device_clock_behind') return `This computer's clock runs behind${skew}, so the browser job looked issued in the future. ` +
        `Ask the user to sync the system clock, ${AUTHORIZE_AGAIN}`;
    if (rejection?.reason === 'storage_unavailable') return 'The browser could not read or write the extension storage. ' +
        `Ask the user to restart the browser, ${AUTHORIZE_AGAIN} If it repeats, offer to report it.`;
    return undefined;
};

// Closed rule names of a signed descriptor that broke a local limit (browser-job.mjs validateAuthorizedJobLimits).
export const DESCRIPTOR_RULES = Object.freeze(['descriptor', 'job_type', 'timeout', 'type', 'endpoint', 'params', 'queries', 'pages',
    'requests', 'assembled_url', 'product', 'card_url', 'articles', 'endpoints', 'unique_products', 'seller_exports',
    'ozon_descriptor', 'ozon_items', 'ozon_canonical']);
export const ARTIFACT_FAILURE_CLASSES = Object.freeze(['disk', 'limit', 'integrity', 'format']);
// Filesystem errors a local write reports, each with its step in LOCAL_STORAGE_MESSAGES. Only free space is the
// seller's own step: e-Comet picks the output folder unless the user set a custom one.
const CUSTOM_FOLDER_STEP = 'If the user set a custom e-Comet output folder, ask them to check access to it; otherwise offer to report it.';
export const LOCAL_STORAGE_MESSAGES = Object.freeze({
    EBUSY: 'Local output storage is busy. Let any other pending work finish, then retry; report a persistent failure to e-Comet.',
    EEXIST: `A local output path conflicts with an existing entry. ${CUSTOM_FOLDER_STEP}`,
    EACCES: `The agent process cannot access local output storage. ${CUSTOM_FOLDER_STEP}`,
    EPERM: `The operating system denied access to local output storage. ${CUSTOM_FOLDER_STEP}`,
    ENOSPC: 'Local output storage has no free space. Free space before requesting the report again.',
    EDQUOT: 'The local output storage quota is exhausted. Restore available quota before requesting the report again.',
    EROFS: `Local output storage is read-only. ${CUSTOM_FOLDER_STEP}`,
    ENOTDIR: `A local output path contains an entry that is not a directory. ${CUSTOM_FOLDER_STEP}`,
});
// Every closed value a local failure may carry in `details` (spec 7.2, 7.4). The output schemas take these lists.
export const FAILURE_DETAIL_VALUES = Object.freeze({
    reason: Object.freeze(['expired', 'route_changed', 'released', ...Object.values(SELLER_FAILURE_REASONS).flat()]),
    phase: WB_FETCH_TIMEOUT_PHASES,
    class: Object.freeze([...SELLER_FAILURE_CLASSES, ...ARTIFACT_FAILURE_CLASSES]),
    recovery: WBAAS_RECOVERY_OUTCOMES,
    systemCode: Object.freeze(Object.keys(LOCAL_STORAGE_MESSAGES)),
    rule: DESCRIPTOR_RULES,
});
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
// Keeps only the closed failure details this process recognizes; anything else is dropped.
export const closedFailureDetails = (value) => {
    if (!value || typeof value !== 'object') return undefined;
    const details = {};
    for (const [key, values] of Object.entries(FAILURE_DETAIL_VALUES)) if (values.includes(value[key])) details[key] = value[key];
    if (typeof value.wbRefused === 'boolean' && details.class !== undefined) details.wbRefused = value.wbRefused;
    if (Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) details.httpStatus = value.httpStatus;
    if (isCount(value.completed) && isCount(value.pending)) Object.assign(details, { completed: value.completed, pending: value.pending });
    return Object.keys(details).length ? Object.freeze(details) : undefined;
};
export const failureDetails = (error) => error instanceof ToolExecutionError ? closedFailureDetails(error.details) : undefined;

const FETCH_GUIDANCE = Object.freeze({
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
    'WB_FETCH_TIMEOUT:sent_no_answer': 'Wildberries received the request but did not answer in time. ' +
        'Retry later; if it repeats, offer to report it.',
    'SELLER_STATE_UNAVAILABLE:probe_cooling_down': 'Restoring the previous seller company failed; the extension allows the next attempt in a few seconds. ' +
        `No new seller operation was dispatched. Wait a few seconds, ${AUTHORIZE_REMAINING}`,
    'SELLER_STATE_UNAVAILABLE:restore_unresolved': 'The previous seller company has not been restored. No new seller operation was dispatched. ' +
        `Ask the user to open the Wildberries seller portal and check which company is selected, ${AUTHORIZE_REMAINING}`,
    // A full extension storage quota survives the restart.
    'SELLER_STATE_UNAVAILABLE:storage_failed': 'The extension could not read or write its seller restoration state. No new seller operation was dispatched. ' +
        `Ask the user to restart the browser, ${AUTHORIZE_REMAINING} If it repeats, offer to report it.`,
    // The extension reads the tokens from the page's storage, whose keys Wildberries has renamed before (2026-09-17): a
    // reason that survives a reload and a sign-in is ours. Accepted residual "A reasonless SELLER_AUTH_UNAVAILABLE gets no
    // step": docs/local-agent-architecture.md#accepted-residuals.
    'SELLER_AUTH_UNAVAILABLE:access_token_missing': `The Wildberries seller portal tab has no readable access token. ${SELLER_SIGN_IN_STEP}`,
    'SELLER_AUTH_UNAVAILABLE:seller_token_missing': `The Wildberries seller portal tab has no readable seller token. ${SELLER_SIGN_IN_STEP}`,
    'SELLER_AUTH_UNAVAILABLE:both_missing': `The Wildberries seller portal tab has no readable sign-in data. ${SELLER_SIGN_IN_STEP}`,
    // The limit is the extension's own, so signing in again cannot shrink Wildberries' token.
    'SELLER_AUTH_UNAVAILABLE:header_too_long': 'The Wildberries seller portal sign-in data is larger than the extension accepts; this is an e-Comet defect. ' +
        'Offer to report it; do not repeat the export automatically.',
    'SELLER_AUTH_UNAVAILABLE:reader_failed': 'The extension could not read the Wildberries seller portal sign-in data; this is an e-Comet defect. ' +
        'Offer to report it; do not repeat the export automatically.',
});
export const fetchFailureGuidance = (code, details) => FETCH_GUIDANCE[`${code}:${details?.phase ?? details?.reason}`];

// A capability the connected extension lacks while a downloaded update waits: the store cannot help, a restart can.
// Accepted residual "The downloaded-update step does not compare versions": docs/local-agent-architecture.md#accepted-residuals.
export const withPendingUpdate = (error, pendingUpdateVersion) => {
    const end = error.message.indexOf('. ');
    error.message = `${end < 0 ? error.message : error.message.slice(0, end + 1)} The extension update ${pendingUpdateVersion} is already ` +
        'downloaded: ask the user to restart the browser, or apply the update on app.e-comet.io, then request a new browser job and retry.';
    return error;
};

export const browserJobRejectionDetails = (error) => error instanceof ToolExecutionError && error.details?.browserJobRejection
    ? { browserJobRejection: error.details.browserJobRejection } : undefined;

// The bridge cause an Ozon authorization failure carries when no broker answered. Only this process builds it, and only a
// closed cause code passes.
export const bridgeCodeDetails = (error) => error instanceof ToolExecutionError && error.code === 'OZON_AUTHORIZATION_REJECTED'
    && BRIDGE_CODES.includes(error.details?.bridgeCode) ? { bridgeCode: error.details.bridgeCode } : undefined;

// Причина отказа для сборки расширения, не объявившей возможность Ozon. Терминальный код при этом
// остаётся OZON_ROUTE_NOT_READY: набор кодов зафиксирован в contracts/local-agent-contract.json,
// который обязан побайтно совпадать с копией в репозитории расширения, поэтому отдельный код связал
// бы этот фикс с релизом расширения. Отличие от настоящего «страница отчёта не открыта» несёт
// именно этот reason вместе с текстом сообщения.
export const OZON_EXTENSION_OUTDATED_REASON = 'extension_outdated';
const OZON_EXTENSION_OUTDATED_DETAIL_KEYS = Object.freeze([
    'reason',
    'requiredCapability',
    'requiredExtensionVersion',
    'updateUrl',
    'installedExtensionVersion',
]);

// Версия расширения приходит из hello_ack через брокер, то есть
// из-за границы процесса. В текст и в details она попадает только в консервативном виде: произвольная
// строка вывела бы сообщение за MAX_SAFE_MESSAGE_LENGTH, и весь терминальный ответ выродился бы в
// нераспознанную ошибку вместо диагноза.
const SAFE_EXTENSION_VERSION = /^[\w.+-]{1,32}$/;
export const safeExtensionVersion = (value) => (typeof value === 'string' && SAFE_EXTENSION_VERSION.test(value) ? value : undefined);

const isOzonExtensionOutdatedDetails = (value) =>
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).every((key) => OZON_EXTENSION_OUTDATED_DETAIL_KEYS.includes(key)) &&
    value.reason === OZON_EXTENSION_OUTDATED_REASON &&
    value.requiredCapability === OZON_PROMOTION_CAPABILITY &&
    value.requiredExtensionVersion === OZON_PROMOTION_MIN_EXTENSION_VERSION &&
    value.updateUrl === EXTENSION_UPDATE_URL &&
    (value.installedExtensionVersion === undefined || safeExtensionVersion(value.installedExtensionVersion) !== undefined);

export const OZON_PROMOTION_TERMINAL_CODE_STAGES = Object.freeze({
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
});

export class ToolExecutionError extends Error {
    // Структурированное дополнение к message, которое строит только этот процесс.
    details = undefined;

    constructor(code, message, stage, retryable = false, options = {}) {
        super(message, options);
        this.name = 'ToolExecutionError';
        this.code = code;
        this.stage = stage;
        this.retryable = retryable;
    }
}

export const safeExternalToolError = (value, fallbackMessage = 'Browser job authorization failed.') => {
    const code = typeof value?.code === 'string' && SAFE_CODE.test(value.code) ? value.code : 'BROWSER_JOB_AUTHORIZATION_FAILED';
    const rejection = parseBrowserJobRejection(code, value?.browserJobRejection);
    const message = rejectionGuidance(rejection) ??
        (typeof value?.message === 'string' && value.message.length > 0 && value.message.length <= MAX_SAFE_MESSAGE_LENGTH
            ? value.message
            : fallbackMessage);
    const stage = SAFE_STAGES.has(value?.stage) ? value.stage : 'authorization';
    const error = new ToolExecutionError(code, message, stage, value?.retryable === true);
    if (rejection) error.details = Object.freeze({ browserJobRejection: rejection });
    return error;
};

export const safeOzonPromotionToolError = (value) => {
    const expectedStage = OZON_PROMOTION_TERMINAL_CODE_STAGES[value?.code];
    if (
        expectedStage === undefined ||
        value?.stage !== expectedStage ||
        value?.retryable !== false ||
        typeof value?.message !== 'string' ||
        value.message.length === 0 ||
        value.message.length > MAX_SAFE_MESSAGE_LENGTH
        || (value?.code === 'OZON_EXECUTION_INTERRUPTED' && value.details !== undefined &&
            !isOzonExecutionInterruptionDetails(value.code, value.details))
    ) {
        throw new TypeError('Invalid Ozon promotion terminal error.');
    }
    const safe = new ToolExecutionError(value.code, value.message, expectedStage, false);
    // details переносятся только у ошибки, созданной этим процессом. Отказ расширения и отказ пира
    // приходят как разобранный из JSON обычный объект и instanceof пройти не могут, поэтому чужая
    // сторона сокета не в состоянии дописать собственный текст в контекст модели через это поле.
    if (value instanceof ToolExecutionError && isOzonExtensionOutdatedDetails(value.details)) safe.details = value.details;
    if (value instanceof ToolExecutionError && value.code === 'OZON_AUTHORIZATION_REJECTED' && value.details?.browserJobRejection) {
        safe.details = value.details;
    }
    if (descriptorRuleDetails(value)) safe.details = descriptorRuleDetails(value);
    if (value instanceof ToolExecutionError && artifactRejectedDetails(value)) safe.details = artifactRejectedDetails(value);
    if (bridgeCodeDetails(value)) safe.details = bridgeCodeDetails(value);
    if (isOzonExecutionInterruptionDetails(value.code, value.details)) {
        safe.details = { phase: value.details.phase, createOutcome: value.details.createOutcome };
    }
    return safe;
};

// The closed class (and filesystem code) of a local workbook write this process rejected.
export const artifactRejectedDetails = (error) => error instanceof ToolExecutionError && error.code === 'ARTIFACT_REJECTED' &&
    ARTIFACT_FAILURE_CLASSES.includes(error.details?.class)
    ? { class: error.details.class, ...(FAILURE_DETAIL_VALUES.systemCode.includes(error.details.systemCode) ? { systemCode: error.details.systemCode } : {}) }
    : undefined;

export const descriptorRuleDetails = (error) => error instanceof ToolExecutionError && error.code === 'OZON_AUTHORIZATION_REJECTED' &&
    DESCRIPTOR_RULES.includes(error.details?.rule) ? { rule: error.details.rule } : undefined;

// The next step and its owner for a rejected local workbook write, by its closed class.
export const artifactFailureMessage = (details) =>
    details?.class === 'disk' ? LOCAL_STORAGE_MESSAGES[details.systemCode]
        : details?.class === 'limit' ? "This job's workbooks exceed the per-job storage limit; split it into smaller jobs."
            : ARTIFACT_FAILURE_CLASSES.includes(details?.class)
                ? 'The workbook stream did not pass the local integrity checks; this is an e-Comet defect. Offer to report it.'
                : undefined;

// A signed Ozon descriptor that breaks a local rule is e-Comet's defect, not a request that differs from the signature.
export const ozonDescriptorRejected = (error) => {
    if (!(error instanceof ToolExecutionError) || error.code !== 'BROWSER_JOB_DESCRIPTOR_INVALID') return undefined;
    const rule = error.details?.rule;
    const rejected = new ToolExecutionError('OZON_AUTHORIZATION_REJECTED',
        `The signed Ozon job breaks the local descriptor rule ${rule ?? 'descriptor'}; this is an e-Comet defect. ` +
            'Offer to report it; do not request another authorization for the same job.', 'authorization', false, { cause: error });
    if (rule) rejected.details = Object.freeze({ rule });
    return rejected;
};

// Расширение объявляет возможности в hello_ack. Сборка, которая не объявила Ozon, не умеет исполнять
// операцию вообще: подписанное задание она отвергает как неизвестный тип ещё на авторизации, поэтому
// совет «откройте страницу отчёта» для неё заведомо бесполезен.
export const ozonExtensionOutdatedError = (installedExtensionVersion) => {
    const installed = safeExtensionVersion(installedExtensionVersion);
    const error = new ToolExecutionError(
        'OZON_ROUTE_NOT_READY',
        `The connected e-Comet extension${installed === undefined ? '' : ` ${installed}`} does not announce ` +
            `${OZON_PROMOTION_CAPABILITY} and cannot run the Ozon Seller promotion report. Update the e-Comet extension to ` +
            `${OZON_PROMOTION_MIN_EXTENSION_VERSION} or newer at ${EXTENSION_UPDATE_URL} and retry. ` +
            'Opening the Ozon promotion page does not help until the extension is updated.',
        'route',
        false
    );
    error.details = Object.freeze({
        reason: OZON_EXTENSION_OUTDATED_REASON,
        requiredCapability: OZON_PROMOTION_CAPABILITY,
        requiredExtensionVersion: OZON_PROMOTION_MIN_EXTENSION_VERSION,
        updateUrl: EXTENSION_UPDATE_URL,
        ...(installed === undefined ? {} : { installedExtensionVersion: installed }),
    });
    return error;
};

export const ozonRouteUnavailableError = (reason = 'unavailable') =>
    new ToolExecutionError(
        'OZON_ROUTE_NOT_READY',
        reason === 'disconnected'
            // A page no longer starts the browser connection, so refreshing one cannot restore it.
            ? 'The browser connection closed before the Ozon report authorization completed; no report operation was dispatched by this call. ' +
                "Check local_bridge_status for the cause, then request a new report authorization on the user's decision."
            : (reason === 'timeout'
                ? 'The Ozon report authorization response timed out; this does not establish why the route was unavailable. '
                : 'The Ozon extension route is unavailable; its cause is not established. ') +
                `Ensure e-Comet extension ${OZON_PROMOTION_MIN_EXTENSION_VERSION} or newer is enabled in the same browser profile, refresh any authenticated Ozon Seller page under https://seller.ozon.ru/app, then request a new report authorization and retry.`,
        'route',
        false
    );

// Форма ответа фиксирована: ровно ok/code/message/stage/retryable. Диагноз устаревшего расширения
// добавляет к терминальному ответу сам обработчик инструмента, а не этот сериализатор.
export const toolFailure = (error, fallback = {}) => {
    if (error instanceof ToolExecutionError || error instanceof StorageUnavailableError) {
        return {
            ok: false,
            code: error.code,
            message: error.message,
            stage: error.stage,
            retryable: error.retryable,
        };
    }
    // Классификация по подстроке в тексте ошибки удалена: строки менялись, регулярки
    // тихо переставали матчиться (например, `Extension WebSocket is not connected`
    // не подходил под /extension is not connected/). Источники теперь бросают
    // ToolExecutionError с кодом, а сюда попадает только действительно неожиданное.
    const fallbackMessage =
        typeof fallback.message === 'string' ? fallback.message : 'The local e-Comet operation failed unexpectedly.';
    return {
        ok: false,
        code: fallback.code || 'UNEXPECTED_LOCAL_ERROR',
        message: fallbackMessage,
        stage: fallback.stage || 'local',
        retryable: fallback.retryable === true,
    };
};
