import { safeFeedbackProperty } from '../mcp/src/feedback-diagnostics.mjs';

// A short-lived Windows handle can deny removal or an owned temporary file's rename. Retry only
// errors that leave the requested operation undone; unknown failures must reach the caller.
export const retryTransientFileOperation = async (operation) => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= 20 || !['EBUSY', 'EPERM'].includes(safeFeedbackProperty(error, 'code'))) throw error;
            await new Promise(resolveWait => setTimeout(resolveWait, 5));
        }
    }
};
