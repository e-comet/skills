import {
    EXTENSION_UPDATE_URL,
    OZON_PROMOTION_CAPABILITY,
    OZON_PROMOTION_MIN_EXTENSION_VERSION,
} from './extension-vocabulary.mjs';

const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;
const SAFE_STAGES = new Set(['arguments', 'handoff', 'extension', 'authorization', 'execution', 'storage', 'images', 'seller', 'local']);

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

// Версия расширения приходит из hello_ack, а на вторичном процессе — ещё и из peer_status, то есть
// из-за границы процесса. В текст и в details она попадает только в консервативном виде: произвольная
// строка вывела бы сообщение за MAX_SAFE_MESSAGE_LENGTH, и весь терминальный ответ выродился бы в
// нераспознанную ошибку вместо диагноза.
const SAFE_EXTENSION_VERSION = /^[\w.+-]{1,32}$/;
const safeExtensionVersion = (value) => (typeof value === 'string' && SAFE_EXTENSION_VERSION.test(value) ? value : undefined);

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
    CREATE_OUTCOME_UNKNOWN: 'create',
    CREATE_REPORT_AMBIGUOUS: 'create',
    CREATE_NOT_OBSERVABLE: 'create',
    POLL_FAILED: 'poll',
    POLL_EXHAUSTED: 'poll',
    REPORT_TERMINAL_FAILURE: 'poll',
    DOWNLOAD_REJECTED: 'download',
    REUSED_REPORT_FORMAT_UNVERIFIED: 'download',
    ARTIFACT_REJECTED: 'artifact',
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
    const message =
        typeof value?.message === 'string' && value.message.length > 0 && value.message.length <= MAX_SAFE_MESSAGE_LENGTH
            ? value.message
            : fallbackMessage;
    const stage = SAFE_STAGES.has(value?.stage) ? value.stage : 'authorization';
    return new ToolExecutionError(code, message, stage, value?.retryable === true);
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
    ) {
        throw new TypeError('Invalid Ozon promotion terminal error.');
    }
    const safe = new ToolExecutionError(value.code, value.message, expectedStage, false);
    // details переносятся только у ошибки, созданной этим процессом. Отказ расширения и отказ пира
    // приходят как разобранный из JSON обычный объект и instanceof пройти не могут, поэтому чужая
    // сторона сокета не в состоянии дописать собственный текст в контекст модели через это поле.
    if (value instanceof ToolExecutionError && isOzonExtensionOutdatedDetails(value.details)) safe.details = value.details;
    return safe;
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

// Форма ответа фиксирована и на проводе: peer_ozon_promotion_result принимает у toolError ровно
// ok/code/message/stage/retryable, поэтому лишний ключ отсюда сделал бы кадр невалидным и вторичный
// процесс ждал бы дедлайна вместо отказа. Диагноз устаревшего расширения добавляет к терминальному
// ответу сам обработчик инструмента, а не этот сериализатор.
export const toolFailure = (error, fallback = {}) => {
    if (error instanceof ToolExecutionError) {
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
