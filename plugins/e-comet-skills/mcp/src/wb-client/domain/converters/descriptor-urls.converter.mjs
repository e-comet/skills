import { CHECK_SEARCH_DEFAULT_PARAMS } from '../constants/descriptors.const.mjs';
export const buildDescriptorUrl = (endpoint, params, query, page) => {
    const url = new URL(endpoint);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    return url.toString();
};
export const buildCheckDescriptorUrl = (job, query, page, brandId) => {
    const url = new URL(buildDescriptorUrl(job.endpoint, job.params, query, page));
    // FE-1290's signer omitted the normal WB search context. Supply only missing values used by wb_search_by_query.
    for (const [key, value] of Object.entries(CHECK_SEARCH_DEFAULT_PARAMS)) {
        if (!url.searchParams.has(key))
            url.searchParams.set(key, value);
    }
    // Match front's checkAvailabilityForArticle flow: catalog search narrowed by the card-derived brand.
    url.searchParams.set('resultset', 'catalog');
    url.searchParams.set('fbrand', String(brandId));
    return url.toString();
};
// The extension rebuilds the same string and admits it only on exact equality; the contract's wbFiltersByQuery.urlFixtures
// pin the parameter order and encoding (";" is written %3B).
export const buildFiltersDescriptorUrl = (job, query, filterKeys) => {
    const url = new URL(job.endpoint);
    Object.entries(job.params).forEach(([key, value]) => url.searchParams.set(key, value));
    for (const [key, value] of Object.entries(CHECK_SEARCH_DEFAULT_PARAMS)) {
        if (!url.searchParams.has(key))
            url.searchParams.set(key, value);
    }
    url.searchParams.set('query', query);
    url.searchParams.set('resultset', 'filters');
    if (filterKeys)
        url.searchParams.set('filters', filterKeys.join(';'));
    return url.toString();
};
export const fillTemplate = (template, article) => template.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = Object.hasOwn(article, key) ? article[key] : undefined;
    if (value === undefined || value === null || String(value).length === 0)
        throw new Error('Browser job article does not provide a value for the endpoint template');
    return encodeURIComponent(String(value));
});
export const normalizeProductArticles = (articles) => [
    ...new Map(articles.map((article) => [article.nm, article])).values(),
];
