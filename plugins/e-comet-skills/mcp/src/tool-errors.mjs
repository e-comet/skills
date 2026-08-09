const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;
const SAFE_STAGES = new Set(['arguments', 'handoff', 'extension', 'authorization', 'execution', 'storage', 'images', 'seller', 'local']);

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
