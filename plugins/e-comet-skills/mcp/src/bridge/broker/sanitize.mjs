// The sanitizing of an error the extension sends (refactor spec §7.5): a code of the safe shape, a bounded message, a
// known stage and a closed browser-job rejection; anything else falls back to the browser-job authorization failure.
import { SAFE_STAGES, ToolExecutionError } from '../../shared/coded-error.mjs';
import { isRecord } from '../../shared/values.mjs';
import { MAX_SAFE_MESSAGE_LENGTH } from '../../transport/extension/wire.mjs';
import { parseBrowserJobRejection, rejectionGuidance } from '../../transport/failures/rejection.mjs';
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
// Parse boundary: `value` is an error object the extension sent, read field by field.
export const safeExternalToolError = (value, fallbackMessage = 'Browser job authorization failed.') => {
    const fields = isRecord(value) ? value : {};
    const code = typeof fields.code === 'string' && SAFE_CODE.test(fields.code) ? fields.code : 'BROWSER_JOB_AUTHORIZATION_FAILED';
    const rejection = parseBrowserJobRejection(code, fields.browserJobRejection);
    const message = rejectionGuidance(rejection) ??
        (typeof fields.message === 'string' && fields.message.length > 0 && fields.message.length <= MAX_SAFE_MESSAGE_LENGTH
            ? fields.message
            : fallbackMessage);
    const stage = typeof fields.stage === 'string' && SAFE_STAGES.has(fields.stage) ? fields.stage : 'authorization';
    const error = new ToolExecutionError(code, message, stage, fields.retryable === true);
    if (rejection)
        error.details = { browserJobRejection: rejection };
    return error;
};
