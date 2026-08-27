const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;
const SAFE_STAGES = new Set(['arguments', 'handoff', 'extension', 'authorization', 'execution', 'storage', 'images', 'seller', 'local']);

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
    return new ToolExecutionError(value.code, value.message, expectedStage, false);
};

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
