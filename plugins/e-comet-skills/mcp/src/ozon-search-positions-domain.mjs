import { MAX_OZON_REPORT_PACKAGE_ITEMS } from './ozon-report-package-domain.mjs';

// Queries are package items, so the shared package cap (50) bounds them as well.
export const MAX_OZON_SEARCH_POSITIONS_SKUS = 10;
export const MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH = 128;
export const OZON_SEARCH_POSITIONS_DEFAULT_REGION = 'Москва';
export const OZON_SEARCH_POSITIONS_PLATFORMS = Object.freeze(['ozon', 'select']);
const REQUEST_KEYS = ['queries', 'skus', 'region', 'platform'];

const trimmedText = (value, label) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < 1 || text.length > MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH) {
        throw new TypeError(`${label} must be 1-${MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH} characters after trimming.`);
    }
    return text;
};

const sameValues = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

export const isSearchPositionsSkuList = (skus) =>
    Array.isArray(skus) &&
    skus.length >= 1 &&
    skus.length <= MAX_OZON_SEARCH_POSITIONS_SKUS &&
    skus.every((sku) => Number.isSafeInteger(sku) && sku > 0) &&
    new Set(skus).size === skus.length;

// Model-authored local arguments omit region and platform; the signer materializes the same defaults.
export const canonicalSearchPositionsRequest = (request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.keys(request).every((key) => REQUEST_KEYS.includes(key))) {
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
    if (!OZON_SEARCH_POSITIONS_PLATFORMS.includes(platform)) throw new TypeError('Ozon search platform must be ozon or select.');
    return { queries: canonicalQueries, skus: [...skus], region: trimmedText(region, 'Ozon search region'), platform };
};

// Order is part of the request: queries are executed in order and cells follow the SKU order.
export const sameSearchPositionsRequest = (left, right) =>
    sameValues(left.queries, right.queries) &&
    sameValues(left.skus, right.skus) &&
    left.region === right.region &&
    left.platform === right.platform;
