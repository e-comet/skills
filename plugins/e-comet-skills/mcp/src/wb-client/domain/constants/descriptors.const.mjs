// The signed job types of the buyer and filters tools: the WB fetch serves only these, and the Ozon descriptor check sends
// them to this context's check.
export const BUYER_JOB_TYPES = new Set([
    'search_by_query',
    'check_by_query',
    'filters_by_query',
    'product_card',
    'recommendations_by_product',
]);
// The normal WB search context the signer may omit; the check and filters URLs supply each missing value.
export const CHECK_SEARCH_DEFAULT_PARAMS = {
    curr: 'rub',
    dest: '-446115',
    hide_dtype: '15',
    hide_vflags: '4294967296',
    inheritFilters: 'false',
    lang: 'ru',
    locale: 'ru',
    sort: 'popular',
    spp: '30',
    suppressSpellcheck: 'false',
    uclusters: '0',
};
