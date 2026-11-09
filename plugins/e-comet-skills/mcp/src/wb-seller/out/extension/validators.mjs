import { hasOnlyOwnKeys, isNonNegativeSafeInteger, isRecord } from '../../../shared/values.mjs';
import { ARTIFACT_MAX_FILE_BYTES } from '../../../storage/limits.mjs';
import { isSellerOperationStage, SELLER_OPERATION_STAGES } from '../../../transport/extension/wire.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../../transport/mcp/limits.mjs';
// The Seller frames the extension may send and the operations this process may request: today's wire validators.
const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_BASE64_STREAM_CHUNK_LENGTH = 4 * Math.ceil(MAX_STREAM_CHUNK_BYTES / 3);
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const isValidBase64Chunk = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_STREAM_CHUNK_LENGTH || !BASE64_PATTERN.test(value)) {
        return false;
    }
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value && decoded.byteLength <= MAX_STREAM_CHUNK_BYTES;
};
// Parse boundary: an operation or frame payload of any shape, narrowed field by field.
export const isValidSellerOperation = (value) => {
    if (!isRecord(value) || !hasOnlyOwnKeys(value, ['exportIndex', 'isAnswered', 'stage', 'reportId']))
        return false;
    if (!isNonNegativeSafeInteger(value.exportIndex) || typeof value.isAnswered !== 'boolean' || !isSellerOperationStage(value.stage)) {
        return false;
    }
    return value.stage === SELLER_OPERATION_STAGES.create
        ? value.reportId === undefined
        : typeof value.reportId === 'string' && value.reportId.length > 0 && value.reportId.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
};
export const isValidSellerStreamStart = (value) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['mimeType', 'declaredSize']) &&
    value.mimeType === XLSX_MIME_TYPE &&
    (value.declaredSize === undefined || (isNonNegativeSafeInteger(value.declaredSize) && value.declaredSize <= ARTIFACT_MAX_FILE_BYTES));
export const isValidSellerStreamChunk = (value) => isRecord(value) && hasOnlyOwnKeys(value, ['index', 'data']) && isNonNegativeSafeInteger(value.index) && isValidBase64Chunk(value.data);
export const isValidSellerStreamEnd = (value) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['size', 'sha256']) &&
    isNonNegativeSafeInteger(value.size) &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256);
