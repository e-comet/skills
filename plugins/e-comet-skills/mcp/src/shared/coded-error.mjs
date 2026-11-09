// The coded error every layer throws: a closed code, a stage and a retry flag (refactor spec §6.3). Bug reports carry
// its class name, so it stays ToolExecutionError.
export const SAFE_STAGES = new Set([
    'arguments',
    'handoff',
    'extension',
    'authorization',
    'execution',
    'storage',
    'images',
    'seller',
    'local',
]);
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
