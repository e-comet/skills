import { isRecord } from '../shared/values.mjs';
const safeText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
// Parse boundary: initialize metadata is whatever the client sent.
export const sanitizeClientInfo = (value) => isRecord(value) && safeText(value.name) && safeText(value.version) ? { name: value.name, version: value.version } : null;
