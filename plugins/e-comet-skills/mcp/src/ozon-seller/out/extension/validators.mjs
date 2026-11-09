import { MAX_ID_LENGTH } from '../../../bridge/broker/messages.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from '../../domain/constants/limits.const.mjs';
import { safeOzonPromotionToolError } from '../../domain/converters/errors.converter.mjs';
import { parseOzonPromotionPeriod } from '../../domain/policies/promotion.policy.mjs';
import { isSearchPositionsSkuList, isValidOzonSearchPositionsDetails } from '../../domain/policies/search-positions.policy.mjs';
import { hasOnlyOwnKeys, isBoundedText, isNonNegativeSafeInteger, isOneOf, isPositiveSafeInteger, isRecord } from '../../../shared/values.mjs';
import { ARTIFACT_MAX_FILE_BYTES } from '../../../storage/limits.mjs';
import { MESSAGE_TYPES, OZON_ANALYTICS_SERVER_MESSAGE_TYPES, OZON_ANALYTICS_TERMINAL_CODE_STAGES, isOzonAnalyticsTerminalDetails, isOzonExecutionInterruptionDetails, OZON_PROMOTION_SERVER_MESSAGE_TYPES, OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES, } from '../../../transport/extension/wire.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../../transport/mcp/limits.mjs';
// The Ozon frame validators (refactor spec §7.4): the operation this process sends, and every frame the extension
// answers with, by type, before the frame reaches its request.
const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_BASE64_STREAM_CHUNK_LENGTH = 4 * Math.ceil(MAX_STREAM_CHUNK_BYTES / 3);
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;
const isValidBase64Chunk = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_STREAM_CHUNK_LENGTH || !BASE64_PATTERN.test(value)) {
        return false;
    }
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value && decoded.byteLength <= MAX_STREAM_CHUNK_BYTES;
};
// Parse boundary: every check below reads a frame the extension wrote, field by field.
export const isValidOzonReportPhase = (value) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['family', 'frameId', 'itemIndex', 'phase']) &&
    isOneOf(['promotion', 'analytics'], value.family) &&
    isBoundedText(value.frameId, 128) &&
    isNonNegativeSafeInteger(value.itemIndex) &&
    value.itemIndex < MAX_OZON_REPORT_PACKAGE_ITEMS &&
    isOneOf(['pre_create', 'create_dispatched', 'create_settled', 'polling', 'downloading', 'streaming'], value.phase);
export const isValidOzonPromotionOperation = (value) => {
    if (!isRecord(value) || !hasOnlyOwnKeys(value, ['dateFrom', 'dateTo', 'deadlineAt']) || !isPositiveSafeInteger(value.deadlineAt)) {
        return false;
    }
    try {
        parseOzonPromotionPeriod(value.dateFrom, value.dateTo);
        return true;
    }
    catch {
        return false;
    }
};
const isValidOzonStreamStart = (value, indexed = false) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['frameId', 'itemIndex', 'name', 'mimeType', 'declaredSize']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedText(value.frameId, MAX_ID_LENGTH) &&
    isBoundedText(value.name, MAX_BROWSER_JOB_TEXT_LENGTH) &&
    value.mimeType === XLSX_MIME_TYPE &&
    (value.declaredSize === undefined || (isNonNegativeSafeInteger(value.declaredSize) && value.declaredSize <= ARTIFACT_MAX_FILE_BYTES));
const isValidOzonStreamChunk = (value, indexed = false) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['frameId', 'itemIndex', 'index', 'data']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedText(value.frameId, MAX_ID_LENGTH) &&
    isNonNegativeSafeInteger(value.index) &&
    isValidBase64Chunk(value.data);
const isValidOzonStreamEnd = (value, indexed = false) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['frameId', 'itemIndex', 'size', 'sha256']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedText(value.frameId, MAX_ID_LENGTH) &&
    isNonNegativeSafeInteger(value.size) &&
    value.size <= ARTIFACT_MAX_FILE_BYTES &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256);
const isValidOzonResult = (value, allowSkipped = false) => {
    // Promotion may carry date context; analytics below deliberately requires its own exact error keys.
    if (!isRecord(value) || !hasOnlyOwnKeys(value, ['ok', 'status', 'error']))
        return false;
    if (value.ok === true)
        return Object.keys(value).length === 1;
    const skipped = allowSkipped && value.status === 'skipped' && Object.keys(value).length === 3;
    if (value.ok !== false || (!skipped && Object.keys(value).length !== 2) || !isRecord(value.error))
        return false;
    const error = value.error;
    if (!hasOnlyOwnKeys(error, ['code', 'stage', 'retryable', 'message', 'dateFrom', 'dateTo', 'details']) ||
        (Object.hasOwn(error, 'details') && (!allowSkipped || !isOzonExecutionInterruptionDetails(error.code, error.details))) ||
        typeof error.message !== 'string' ||
        error.message.length === 0 ||
        error.message.length > MAX_SAFE_MESSAGE_LENGTH) {
        return false;
    }
    try {
        safeOzonPromotionToolError(error);
        if ((error.dateFrom === undefined) !== (error.dateTo === undefined))
            return false;
        if (error.dateFrom !== undefined)
            parseOzonPromotionPeriod(error.dateFrom, error.dateTo);
        return true;
    }
    catch {
        return false;
    }
};
const isValidIndexedOzonResult = (value, family) => {
    if (!isRecord(value) || !isNonNegativeSafeInteger(value.itemIndex))
        return false;
    const { itemIndex: _itemIndex, ...result } = value;
    if (family === 'promotion')
        return isValidOzonResult(result, true);
    if (!isRecord(result) || !hasOnlyOwnKeys(result, ['ok', 'status', 'error']))
        return false;
    if (result.ok === true)
        return Object.keys(result).length === 1;
    const skipped = result.status === 'skipped' && Object.keys(result).length === 3;
    if (result.ok !== false || (!skipped && Object.keys(result).length !== 2) || !isRecord(result.error))
        return false;
    const error = result.error;
    return (hasOnlyOwnKeys(error, ['code', 'stage', 'retryable', 'message', 'details']) &&
        (!Object.hasOwn(error, 'details') ||
            (!skipped && isOzonAnalyticsTerminalDetails(error.code, error.details)) ||
            isOzonExecutionInterruptionDetails(error.code, error.details)) &&
        typeof error.code === 'string' &&
        OZON_ANALYTICS_TERMINAL_CODE_STAGES[error.code] === error.stage &&
        error.retryable === false &&
        typeof error.message === 'string' &&
        error.message.length > 0 &&
        error.message.length <= MAX_SAFE_MESSAGE_LENGTH);
};
const MAX_OZON_SEARCH_POSITIONS_LABEL_LENGTH = 32;
const isValidOzonSearchPositionsCell = (cell) => isRecord(cell) &&
    Object.keys(cell).length === 2 &&
    isPositiveSafeInteger(cell.sku) &&
    (isPositiveSafeInteger(cell.position) ||
        cell.found === false ||
        cell.returned === false ||
        isBoundedText(cell.label, MAX_OZON_SEARCH_POSITIONS_LABEL_LENGTH));
// `skus` is the signed SKU list: cells are exactly one per SKU in that order. Without it (the wire
// parser, before correlation) the cell SKUs must still form a valid signed list. EMPTY has no cells:
// «no data for this query» must never read as «not found» for every SKU.
// `skus` is undefined on the wire parser, before correlation.
export const isValidOzonSearchPositionsResult = (payload, skus) => {
    if (!isRecord(payload) || !isNonNegativeSafeInteger(payload.itemIndex) || payload.itemIndex >= MAX_OZON_REPORT_PACKAGE_ITEMS) {
        return false;
    }
    if (payload.ok === true) {
        if (!hasOnlyOwnKeys(payload, ['itemIndex', 'ok', 'status', 'checkedAt', 'positions']) ||
            Object.keys(payload).length !== 5 ||
            // The last millisecond of year 9999: toISOString() keeps the four-digit year the output schema requires.
            !isPositiveSafeInteger(payload.checkedAt) ||
            payload.checkedAt > 253402300799999 ||
            !Array.isArray(payload.positions))
            return false;
        const positions = payload.positions;
        if (payload.status === 'empty')
            return positions.length === 0;
        if (payload.status !== 'complete' || !positions.every(isValidOzonSearchPositionsCell))
            return false;
        const cellSkus = positions.map(({ sku }) => sku);
        return skus === undefined
            ? isSearchPositionsSkuList(cellSkus)
            : cellSkus.length === skus.length && cellSkus.every((sku, index) => sku === skus[index]);
    }
    if (payload.ok !== false || !hasOnlyOwnKeys(payload, ['itemIndex', 'ok', 'status', 'error']) || !isRecord(payload.error))
        return false;
    const skipped = payload.status === 'skipped';
    if (!skipped && Object.hasOwn(payload, 'status'))
        return false;
    const { error } = payload;
    return (hasOnlyOwnKeys(error, ['code', 'stage', 'retryable', 'message', 'details']) &&
        typeof error.code === 'string' &&
        Object.hasOwn(OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES, error.code) &&
        OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES[error.code] === error.stage &&
        error.retryable === false &&
        isBoundedText(error.message, MAX_SAFE_MESSAGE_LENGTH) &&
        (!Object.hasOwn(error, 'details') || (!skipped && isValidOzonSearchPositionsDetails(error.code, error.details))));
};
// The Ozon frames beside the extension's own vocabulary: the Ozon operations, their report phases and position results.
export const OZON_OPERATION_TYPES = [
    ...OZON_PROMOTION_SERVER_MESSAGE_TYPES,
    ...OZON_ANALYTICS_SERVER_MESSAGE_TYPES,
    MESSAGE_TYPES.ozonReportPhase,
    MESSAGE_TYPES.ozonSearchPositionsResult,
];
// An Ozon frame's payload is valid for its type; a frame of any other type is not checked here.
export const isValidOzonOperationPayload = (type, payload) => {
    // The message parser admits only object payloads.
    const indexed = isRecord(payload) && Object.hasOwn(payload, 'itemIndex');
    if (type === MESSAGE_TYPES.ozonReportPhase && !isValidOzonReportPhase(payload))
        return false;
    if (type === MESSAGE_TYPES.ozonPromotionStreamStart && !isValidOzonStreamStart(payload, indexed))
        return false;
    if (type === MESSAGE_TYPES.ozonPromotionStreamChunk && !isValidOzonStreamChunk(payload, indexed))
        return false;
    if (type === MESSAGE_TYPES.ozonPromotionStreamEnd && !isValidOzonStreamEnd(payload, indexed))
        return false;
    if (type === MESSAGE_TYPES.ozonPromotionResult &&
        !(indexed ? isValidIndexedOzonResult(payload, 'promotion') : isValidOzonResult(payload)))
        return false;
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamStart && !isValidOzonStreamStart(payload, true))
        return false;
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamChunk && !isValidOzonStreamChunk(payload, true))
        return false;
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamEnd && !isValidOzonStreamEnd(payload, true))
        return false;
    if (type === MESSAGE_TYPES.ozonAnalyticsResult && !isValidIndexedOzonResult(payload, 'analytics'))
        return false;
    if (type === MESSAGE_TYPES.ozonSearchPositionsResult && !isValidOzonSearchPositionsResult(payload))
        return false;
    return true;
};
