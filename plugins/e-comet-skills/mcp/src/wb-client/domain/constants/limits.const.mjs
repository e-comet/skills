export const MAX_PRODUCT_ARTICLES = 20;
export const MAX_PRODUCT_CARD_PRODUCTS = 1000;
export const MAX_PRODUCT_CARD_REQUEST_UNITS = 2000;
export const PRODUCT_CARD_CONCURRENCY = 4;
export const MAX_SEARCH_PAGES_PER_QUERY = 50;
export const MAX_SEARCH_REQUEST_UNITS = 1000;
export const SEARCH_CONCURRENCY = 4;
export const MAX_CHECK_QUERIES = 100;
export const MAX_CHECK_PAGES_PER_QUERY = 10;
export const MAX_CHECK_SEARCH_REQUESTS = 1000;
// wb_filters_by_query: one filters request and at most one full-list request per phrase. A full-list request names at most
// this many WB fullKey values (`ff` + at most 32 lower-case letters or digits), joined by ";".
export const MAX_FILTER_QUERIES = 50;
export const MAX_FILTER_KEYS_PER_REQUEST = 64;
export const MAX_FILTER_KEY_LENGTH = 34;
export const FILTER_QUERY_CONCURRENCY = 4;
// Keep per-job in-flight work conservative; the extension independently owns
// the service-worker-wide dispatch budget of 30 WB requests per 2.5 seconds.
export const CHECK_QUERY_CONCURRENCY = 4;
export const MAX_RECOMMENDATION_PAGES_PER_PRODUCT = 50;
export const MAX_RECOMMENDATION_REQUEST_UNITS = 1000;
export const RECOMMENDATION_PAGE_SIZE = 100;
export const RECOMMENDATION_CONCURRENCY = 4;
export const MAX_RETURNED_PRODUCTS = 200;
export const DEFAULT_RETURNED_PRODUCTS = 30;
export const MAX_IMAGE_ARTICLES = 20;
export const MAX_IMAGE_PHOTOS = 30;
export const DEFAULT_IMAGE_PHOTOS = 15;
export const MAX_IMAGE_BASKET = 60;
export const IMAGE_CONCURRENCY = 8;
export const IMAGE_BASKET_BOUNDS = [
    143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485, 3701, 3917, 4133,
    4349, 4565, 4877, 5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605, 10373, 11141, 11909, 12677, 13445,
    14213,
];
