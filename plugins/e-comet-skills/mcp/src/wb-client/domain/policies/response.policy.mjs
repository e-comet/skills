import { fieldOf } from '../../../shared/values.mjs';
import { RECOMMENDATION_PAGE_SIZE } from '../constants/limits.const.mjs';
// Parse boundary: a WB answer as the extension relayed it, `{ error, data: { ok, status, statusText, body } }`, read field by
// field. One field of its `data`.
export const wbData = (response, key) => fieldOf(fieldOf(response, 'data'), key);
export const isSuccessfulWbResponse = (response) => {
    const status = wbData(response, 'status');
    return !fieldOf(response, 'error') && wbData(response, 'ok') !== false && typeof status === 'number' && status >= 200 && status < 300;
};
export const normalizeStatus = (succeeded, total) => succeeded === total ? 'done' : succeeded === 0 ? 'failed' : 'partial';
export const recommendationTotalPages = (total) => {
    if (total === undefined || !Number.isInteger(total) || total < 0) {
        return null;
    }
    return Math.max(1, Math.ceil(total / RECOMMENDATION_PAGE_SIZE));
};
