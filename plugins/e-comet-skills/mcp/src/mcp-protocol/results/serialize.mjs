import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { StorageUnavailableError } from '../../shared/storage-unavailable.mjs';
export const textResult = (value, isError = false) => ({
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError,
});
export const resourceLinkResult = (value, summary, artifacts, isError = false) => ({
    content: [
        { type: 'text', text: summary },
        ...artifacts.map((artifact) => ({
            type: 'resource_link',
            uri: artifact.uri,
            name: artifact.name,
            mimeType: artifact.mimeType,
            size: artifact.size,
        })),
    ],
    structuredContent: value,
    isError,
});
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
    const fallbackMessage = typeof fallback.message === 'string' ? fallback.message : 'The local e-Comet operation failed unexpectedly.';
    return {
        ok: false,
        code: fallback.code || 'UNEXPECTED_LOCAL_ERROR',
        message: fallbackMessage,
        stage: fallback.stage || 'local',
        retryable: fallback.retryable === true,
    };
};
