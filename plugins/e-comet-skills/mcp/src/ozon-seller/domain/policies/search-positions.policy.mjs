import { MAX_OZON_REPORT_PACKAGE_ITEMS, MAX_OZON_SEARCH_POSITIONS_SKUS, MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH, OZON_SEARCH_POSITIONS_DEFAULT_REGION, OZON_SEARCH_POSITIONS_PLATFORMS, } from '../constants/limits.const.mjs';
import { hasOnlyOwnKeys, isBoundedText, isOneOf, isPositiveSafeInteger, isRecord } from '../../../shared/values.mjs';
const REQUEST_KEYS = ['queries', 'skus', 'region', 'platform'];
const MAX_OZON_REGION_CANDIDATES = 5;
const trimmedText = (value, label) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < 1 || text.length > MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH) {
        throw new TypeError(`${label} must be 1-${MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH} characters after trimming.`);
    }
    return text;
};
const sameValues = (left, right) => Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
export const isSearchPositionsSkuList = (skus) => Array.isArray(skus) &&
    skus.length >= 1 &&
    skus.length <= MAX_OZON_SEARCH_POSITIONS_SKUS &&
    skus.every((sku) => Number.isSafeInteger(sku) && sku > 0) &&
    new Set(skus).size === skus.length;
// Model-authored local arguments omit region and platform; the signer materializes the same defaults.
// Parse boundary: the request as the caller or the signed job gave it.
export const canonicalSearchPositionsRequest = (request) => {
    if (!isRecord(request) || !hasOnlyOwnKeys(request, REQUEST_KEYS)) {
        throw new TypeError('Ozon search positions request has invalid fields.');
    }
    const { queries, skus, region = OZON_SEARCH_POSITIONS_DEFAULT_REGION, platform = 'ozon' } = request;
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_OZON_REPORT_PACKAGE_ITEMS) {
        throw new TypeError(`Ozon search positions queries must contain 1-${MAX_OZON_REPORT_PACKAGE_ITEMS} items.`);
    }
    const canonicalQueries = queries.map((query) => trimmedText(query, 'Ozon search query'));
    if (new Set(canonicalQueries).size !== canonicalQueries.length) {
        throw new TypeError('Ozon search queries must be unique after trimming.');
    }
    if (!isSearchPositionsSkuList(skus)) {
        throw new TypeError(`Ozon search positions SKUs must be 1-${MAX_OZON_SEARCH_POSITIONS_SKUS} unique positive integers.`);
    }
    if (!isOneOf(OZON_SEARCH_POSITIONS_PLATFORMS, platform))
        throw new TypeError('Ozon search platform must be ozon or select.');
    return { queries: canonicalQueries, skus: [...skus], region: trimmedText(region, 'Ozon search region'), platform };
};
// Order is part of the request: queries are executed in order and cells follow the SKU order.
// Parse boundary: `right` may be the signed job, read field by field.
export const sameSearchPositionsRequest = (left, right) => isRecord(right) &&
    sameValues(left.queries, right.queries) &&
    sameValues(left.skus, right.skus) &&
    left.region === right.region &&
    left.platform === right.platform;
// Only a failed item that actually ran may explain its preflight stop; a skipped item carries no details.
// Parse boundary: details as the extension sent them.
export const isValidOzonSearchPositionsDetails = (code, details) => isRecord(details) &&
    Object.keys(details).length === 1 &&
    ((code === 'OZON_REGION_UNAVAILABLE' &&
        Array.isArray(details.candidates) &&
        details.candidates.length >= 1 &&
        details.candidates.length <= MAX_OZON_REGION_CANDIDATES &&
        details.candidates.every((candidate) => isBoundedText(candidate, MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH))) ||
        (code === 'OZON_SKU_LIMIT_EXCEEDED' && isPositiveSafeInteger(details.limit)));
