import {
    CHECK_QUERY_CONCURRENCY,
    DEFAULT_RETURNED_PRODUCTS,
    MAX_CONSECUTIVE_SELLER_EXPORT_FAILURES,
    MAX_CONSECUTIVE_SELLER_POLL_FAILURES,
    MIN_SELLER_OPERATION_AGENT_INTERVAL_MS,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    MAX_BROWSER_JOB_TEXT_LENGTH,
    MAX_BROWSER_JOB_URL_LENGTH,
    MAX_CHECK_PAGES_PER_QUERY,
    MAX_CHECK_QUERIES,
    MAX_CHECK_SEARCH_REQUESTS,
    MAX_PRODUCT_CARD_PRODUCTS,
    MAX_PRODUCT_CARD_REQUEST_UNITS,
    MAX_RECOMMENDATION_PAGES_PER_PRODUCT,
    MAX_RECOMMENDATION_REQUEST_UNITS,
    MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS,
    MAX_SELLER_REVIEW_EXPORTS,
    MAX_SELLER_REVIEW_PHYSICAL_REPORTS,
    MAX_SELLER_REVIEW_POLLS_PER_REPORT,
    SELLER_DOWNLOAD_TIMEOUT_MS,
    SELLER_JOB_MAX_DURATION_MS,
    MAX_RETURNED_PRODUCTS,
    MAX_SEARCH_PAGES_PER_QUERY,
    MAX_SEARCH_REQUEST_UNITS,
    PRODUCT_CARD_CONCURRENCY,
    RECOMMENDATION_CONCURRENCY,
    REQUEST_TIMEOUT_MS,
    SEARCH_CONCURRENCY,
} from './config.mjs';
import { SELLER_OPERATION_STAGES } from './extension-vocabulary.mjs';
import { parseOzonPromotionPeriod } from './ozon-promotion-domain.mjs';
import { ToolExecutionError } from './tool-errors.mjs';
import {
    isSuccessfulWbResponse,
    isAllowedWbUrl,
    normalizeStatus,
    numberOrUndefined,
    projectPageProducts,
    recommendationTotalPages,
    responseProducts,
    runWithConcurrency,
    summarizeProduct,
    validTimeout,
} from './wb-domain.mjs';

const CHECK_SEARCH_DEFAULT_PARAMS = Object.freeze({
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
});

const validJobTimeout = (job) => job.timeout === undefined || validTimeout(job.timeout);
const invalidDescriptor = (cause) =>
    new ToolExecutionError(
        'BROWSER_JOB_DESCRIPTOR_INVALID',
        'The signed browser job descriptor is invalid.',
        'authorization',
        false,
        { cause: cause instanceof Error ? cause : new Error(String(cause)) }
    );
const boundedText = (value) =>
    typeof value === 'string' && value.length >= 1 && value.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
const validEndpoint = (value) => {
    if (typeof value !== 'string' || value.length > MAX_BROWSER_JOB_URL_LENGTH) return false;
    return isAllowedWbUrl(value);
};
const validParams = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.query === undefined &&
    value.page === undefined &&
    Object.entries(value).every(([key, item]) => boundedText(key) && boundedText(item));
const validProductArticle = (article) =>
    article !== null &&
    typeof article === 'object' &&
    !Array.isArray(article) &&
    Number.isSafeInteger(article.nm) &&
    article.nm > 0 &&
    Object.values(article).every((value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)));

const cardUrlMatchesArticle = (cardUrl, article) => {
    try {
        return Number(new URL(cardUrl).searchParams.get('nm')) === article;
    } catch {
        return false;
    }
};
const validIsoDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const validSellerOrg = (org) => {
    if (org === undefined) return true;
    if (!org || typeof org !== 'object' || Array.isArray(org)) return false;
    const keys = Object.keys(org);
    return keys.length === 1 && (keys[0] === 'id' || keys[0] === 'name') && boundedText(org[keys[0]]);
};
const validSellerRatings = (ratings) =>
    ratings === undefined ||
    (Array.isArray(ratings) &&
        ratings.length >= 1 &&
        ratings.length <= 5 &&
        ratings.every((rating) => Number.isSafeInteger(rating) && rating >= 1 && rating <= 5) &&
        new Set(ratings).size === ratings.length);
const sellerExportIdentity = (sellerExport) =>
    JSON.stringify({
        product_id: sellerExport.product_id ?? null,
        dateFrom: sellerExport.dateFrom ?? null,
        dateTo: sellerExport.dateTo ?? null,
        isAnswered: sellerExport.isAnswered ?? null,
        ratings: sellerExport.ratings === undefined ? null : [...sellerExport.ratings].sort((left, right) => left - right),
        content: sellerExport.content ?? null,
    });
// Пробрасываем и отказ авторизации, и потерю транспорта: мёртвый мост — не провал
// отдельной единицы, остальные упадут так же. Раньше при числе единиц не больше
// параллелизма задание резолвилось как обычный «провал» без признака retryable, и
// агент не понимал, что достаточно повторить.
const ABORTING_STAGES = new Set(['authorization', 'extension']);
const rethrowAuthorizationError = (error) => {
    if (error instanceof ToolExecutionError && ABORTING_STAGES.has(error.stage)) {
        throw error;
    }
};

export const validateAuthorizedJobLimits = (authorization) => {
    try {
        const job = authorization?.job;
        if (!job || typeof job !== 'object' || Array.isArray(job) || !boundedText(job.jobId))
            throw new Error('Browser job descriptor is invalid');
        if (!validJobTimeout(job)) throw new Error('Browser job timeout is invalid');

        if (authorization.jobType === 'search_by_query') {
            const queries = job.queries;
            if (job.type !== 'wb-search-by-query') throw new Error('Invalid search descriptor type');
            if (!validEndpoint(job.endpoint)) throw new Error('Invalid browser job endpoint');
            if (!validParams(job.params)) throw new Error('Invalid browser job params');
            if (
                !Array.isArray(queries) ||
                queries.length < 1 ||
                !queries.every(
                    (item) =>
                        Array.isArray(item) &&
                        item.length === 2 &&
                        boundedText(item[0]) &&
                        item[0].trim().length > 0 &&
                        Number.isInteger(item[1]) &&
                        item[1] >= 1
                )
            )
                throw new Error('Invalid browser job queries');
            if (queries.some(([, pages]) => pages > MAX_SEARCH_PAGES_PER_QUERY))
                throw new Error(`Browser search job requires at most ${MAX_SEARCH_PAGES_PER_QUERY} pages per query`);
            if (queries.reduce((total, [, pages]) => total + pages, 0) > MAX_SEARCH_REQUEST_UNITS)
                throw new Error(`Browser search job requires at most ${MAX_SEARCH_REQUEST_UNITS} total pages`);
            if (!descriptorPagesAllowed(job.endpoint, job.params, queries))
                throw new Error('Invalid browser job assembled endpoint URL');
            return;
        }

        if (authorization.jobType === 'check_by_query') {
            const queries = job.queries;
            if (job.type !== 'wb-check-by-query') throw new Error('Invalid check-by-query descriptor type');
            if (!Number.isSafeInteger(job.article) || job.article <= 0)
                throw new Error('Invalid check-by-query product');
            if (!validEndpoint(job.cardUrl) || !cardUrlMatchesArticle(job.cardUrl, job.article))
                throw new Error('Invalid check-by-query card URL');
            if (!validEndpoint(job.endpoint)) throw new Error('Invalid browser job endpoint');
            if (!validParams(job.params) || job.params.fbrand !== undefined || job.params.resultset !== undefined)
                throw new Error('Invalid browser job params');
            if (
                !Array.isArray(queries) ||
                queries.length < 1 ||
                queries.length > MAX_CHECK_QUERIES ||
                !queries.every((query) => boundedText(query) && query.trim().length > 0) ||
                new Set(queries).size !== queries.length
            )
                throw new Error(`Browser check-by-query job requires 1-${MAX_CHECK_QUERIES} unique queries`);
            if (job.maxPages !== MAX_CHECK_PAGES_PER_QUERY)
                throw new Error(`Browser check-by-query job requires exactly ${MAX_CHECK_PAGES_PER_QUERY} pages per query`);
            if (queries.length * job.maxPages > MAX_CHECK_SEARCH_REQUESTS)
                throw new Error(`Browser check-by-query job requires at most ${MAX_CHECK_SEARCH_REQUESTS} search requests`);
            if (!descriptorCheckPagesAllowed(job, queries))
                throw new Error('Invalid browser job assembled endpoint URL');
            return;
        }

        if (authorization.jobType === 'product_card') {
            const articles = job.articles;
            const endpoints = job.endpoints;
            if (job.type !== 'wb-product-card') throw new Error('Invalid product-card descriptor type');
            if (!Array.isArray(articles) || articles.length < 1 || !articles.every(validProductArticle))
                throw new Error('Invalid browser job articles');
            if (articles.length > MAX_PRODUCT_CARD_PRODUCTS)
                throw new Error(`Browser product-card job requires at most ${MAX_PRODUCT_CARD_PRODUCTS} products`);
            if (
                !Array.isArray(endpoints) ||
                endpoints.length < 1 ||
                !endpoints.every(
                    (endpoint) =>
                        boundedText(endpoint?.key) &&
                        typeof endpoint?.url === 'string' &&
                        endpoint.url.length >= 1 &&
                        endpoint.url.length <= MAX_BROWSER_JOB_URL_LENGTH
                )
            )
                throw new Error('Invalid browser job endpoints');
            if (articles.length * endpoints.length > MAX_PRODUCT_CARD_REQUEST_UNITS)
                throw new Error(`Browser product-card job requires at most ${MAX_PRODUCT_CARD_REQUEST_UNITS} requests`);
            if (!articles.every((article) => endpoints.every((endpoint) => isAllowedWbUrl(fillTemplate(endpoint.url, article)))))
                throw new Error('Invalid browser job expanded endpoint URL');
            return;
        }

        if (authorization.jobType === 'recommendations_by_product') {
            const articles = job.articles;
            if (job.type !== 'wb-recommendations-by-product') throw new Error('Invalid recommendations descriptor type');
            if (!validEndpoint(job.endpoint)) throw new Error('Invalid browser job endpoint');
            if (!validParams(job.params)) throw new Error('Invalid browser job params');
            if (
                !Array.isArray(articles) ||
                articles.length < 1 ||
                !articles.every(
                    (item) =>
                        Array.isArray(item) &&
                        (item.length === 1 || item.length === 2) &&
                        Number.isSafeInteger(item[0]) &&
                        item[0] > 0 &&
                        (item.length === 1 || (Number.isInteger(item[1]) && item[1] >= 1))
                )
            )
                throw new Error('Invalid browser job recommendation articles');
            if (new Set(articles.map(([nm]) => nm)).size !== articles.length)
                throw new Error('Browser recommendations job requires unique products');
            if (articles.some((item) => item[1] !== undefined && item[1] > MAX_RECOMMENDATION_PAGES_PER_PRODUCT))
                throw new Error(`Browser recommendations job requires at most ${MAX_RECOMMENDATION_PAGES_PER_PRODUCT} pages per product`);
            if (
                articles.reduce((total, item) => total + (item[1] ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT), 0) >
                MAX_RECOMMENDATION_REQUEST_UNITS
            )
                throw new Error(`Browser recommendations job requires at most ${MAX_RECOMMENDATION_REQUEST_UNITS} total pages`);
            if (
                !descriptorPagesAllowed(
                    job.endpoint,
                    job.params,
                    articles.map(([nm, pages]) => [String(nm), pages ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT])
                )
            )
                throw new Error('Invalid browser job assembled endpoint URL');
            return;
        }

        if (authorization.jobType === 'seller_reviews') {
            const exports = job.exports;
            const validSellerReviews =
                job.type === 'wb-seller-reviews' &&
                validSellerOrg(job.org) &&
                Array.isArray(exports) &&
                exports.length >= 1 &&
                exports.length <= MAX_SELLER_REVIEW_EXPORTS &&
                exports.every(
                    (item) =>
                        item &&
                        typeof item === 'object' &&
                        !Array.isArray(item) &&
                        Object.keys(item).every((key) =>
                            ['product_id', 'dateFrom', 'dateTo', 'isAnswered', 'ratings', 'content'].includes(key)
                        ) &&
                        (item.product_id === undefined || (Number.isSafeInteger(item.product_id) && item.product_id > 0)) &&
                        (item.isAnswered === undefined || typeof item.isAnswered === 'boolean') &&
                        validSellerRatings(item.ratings) &&
                        (item.content === undefined || item.content === 'media') &&
                        ((item.dateFrom === undefined && item.dateTo === undefined) ||
                            (validIsoDate(item.dateFrom) && validIsoDate(item.dateTo) && item.dateFrom <= item.dateTo))
                ) &&
                new Set(exports.map(sellerExportIdentity)).size === exports.length &&
                exports.reduce((total, item) => total + (item.isAnswered === undefined ? 2 : 1), 0) <=
                    MAX_SELLER_REVIEW_PHYSICAL_REPORTS;
            if (!validSellerReviews) {
                throw new Error(
                    `Browser seller-review job requires at most ${MAX_SELLER_REVIEW_EXPORTS} exports and ${MAX_SELLER_REVIEW_PHYSICAL_REPORTS} physical reports`
                );
            }
            return;
        }

        if (authorization.jobType === 'ozon_seller_promotion_report') {
            const keys = Object.keys(job);
            if (
                keys.length !== 4 ||
                !keys.every((key) => ['jobId', 'type', 'dateFrom', 'dateTo'].includes(key)) ||
                job.type !== 'ozon-seller-promotion-report'
            ) {
                throw new Error('Invalid Ozon promotion descriptor');
            }
            parseOzonPromotionPeriod(job.dateFrom, job.dateTo);
            return;
        }

        throw new Error(`Unsupported browser_job type: ${authorization.jobType}`);
    } catch (error) {
        if (error instanceof ToolExecutionError) throw error;
        throw invalidDescriptor(error);
    }
};

export const extractBrowserJobToken = (value) => {
    if (typeof value !== 'string') {
        throw new Error('triggerUrl must be a browser_job trigger URL or JWT string');
    }
    const input = value.trim();
    if (!input) {
        throw new Error('triggerUrl must be a browser_job trigger URL or JWT string');
    }
    if (Buffer.byteLength(input, 'utf8') > MAX_BROWSER_JOB_TOKEN_BYTES) throw new Error('triggerUrl is too large');
    if (!input.includes('__agent_job')) {
        if (input.split('.').length !== 3) throw new Error('Invalid browser_job JWT');
        return input;
    }
    const hashIndex = input.indexOf('#');
    const hash = hashIndex >= 0 ? input.slice(hashIndex + 1) : input.replace(/^#/, '');
    const token = new URLSearchParams(hash).get('__agent_job');
    if (!token || token.split('.').length !== 3) {
        throw new Error('Invalid browser_job trigger URL');
    }
    return token;
};

const buildDescriptorUrl = (endpoint, params, query, page) => {
    const url = new URL(endpoint);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set('query', query);
    url.searchParams.set('page', String(page));
    return url.toString();
};

const descriptorPagesAllowed = (endpoint, params, scopes) =>
    scopes.every(([query, pages]) => {
        for (let page = 1; page <= pages; page += 1) {
            if (!isAllowedWbUrl(buildDescriptorUrl(endpoint, params, query, page))) return false;
        }
        return true;
    });

const buildCheckDescriptorUrl = (job, query, page, brandId) => {
    const url = new URL(buildDescriptorUrl(job.endpoint, job.params, query, page));
    // FE-1290's signer omitted the normal WB search context. Supply only missing values used by wb_search_by_query.
    for (const [key, value] of Object.entries(CHECK_SEARCH_DEFAULT_PARAMS)) {
        if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    // Match front's checkAvailabilityForArticle flow: catalog search narrowed by the card-derived brand.
    url.searchParams.set('resultset', 'catalog');
    url.searchParams.set('fbrand', String(brandId));
    return url.toString();
};

const descriptorCheckPagesAllowed = (job, queries) =>
    queries.every((query) => {
        for (let page = 1; page <= job.maxPages; page += 1) {
            // The extension derives fbrand from WB card data, so reserve URL space for every valid brand identity.
            if (!isAllowedWbUrl(buildCheckDescriptorUrl(job, query, page, Number.MAX_SAFE_INTEGER))) return false;
        }
        return true;
    });

const fillTemplate = (template, article) =>
    template.replace(/\{(\w+)\}/g, (_match, key) => {
        const value = Object.prototype.hasOwnProperty.call(article, key) ? article[key] : undefined;
        if (value === undefined || value === null || String(value).length === 0)
            throw new Error('Browser job article does not provide a value for the endpoint template');
        return encodeURIComponent(String(value));
    });

const normalizeProductArticles = (articles) => [...new Map(articles.map((article) => [article.nm, article])).values()];

const compactCardBody = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
    return {
        imtId: numberOrUndefined(body.imt_id),
        nmId: numberOrUndefined(body.nm_id),
        vendorCode: typeof body.vendor_code === 'string' ? body.vendor_code : undefined,
        description: typeof body.description === 'string' ? body.description : undefined,
        subjectId: numberOrUndefined(body.subj_id) ?? numberOrUndefined(body.subject_id),
        subject: typeof body.subj_name === 'string' ? body.subj_name : typeof body.subject_name === 'string' ? body.subject_name : undefined,
        rootSubject:
            typeof body.subj_root_name === 'string'
                ? body.subj_root_name
                : typeof body.root_subject_name === 'string'
                  ? body.root_subject_name
                  : undefined,
        options: Array.isArray(body.options) ? body.options : undefined,
        colors: Array.isArray(body.colors) ? body.colors.filter((value) => Number.isSafeInteger(value) && value > 0) : undefined,
    };
};

const executeSearchJob = async ({ authorizationId, job, requestWbFetch, writer, projection }) => {
    const units = job.queries.flatMap(([query, pages], queryIndex) =>
        Array.from({ length: pages }, (_, index) => ({
            queryIndex,
            query,
            page: index + 1,
            url: buildDescriptorUrl(job.endpoint, job.params, query, index + 1),
        }))
    );
    const fetched = await runWithConcurrency(units, SEARCH_CONCURRENCY, async (unit) => {
        try {
            const response = await requestWbFetch(unit.url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, response });
            return {
                ...unit,
                response,
                ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
            };
        } catch (error) {
            rethrowAuthorizationError(error);
            await writer.append({
                jobId: job.jobId,
                ...unit,
                error: error.message,
            });
            return { ...unit, ok: false, error: error.message };
        }
    });

    const queries = job.queries.map(([query, pagesRequested], queryIndex) => {
        let globalOffset = 0;
        let returnedProducts = 0;
        let globalPositionsReliable = true;
        const pages = fetched
            .filter((unit) => unit.queryIndex === queryIndex)
            .sort((left, right) => left.page - right.page)
            .map((unit) => {
                const products = responseProducts(unit.response);
                const productLimit = projection.productNmIds ? MAX_RETURNED_PRODUCTS : projection.productLimitPerScope;
                const remaining = Math.max(0, productLimit - returnedProducts);
                const pageGlobalPositionsReliable = globalPositionsReliable && unit.ok;
                const selected = unit.ok
                    ? projectPageProducts(
                          products,
                          globalOffset,
                          projection.productNmIds,
                          remaining,
                          pageGlobalPositionsReliable
                      )
                    : [];
                returnedProducts += selected.length;
                const page = {
                    page: unit.page,
                    ok: unit.ok,
                    httpStatus: unit.response?.data?.status,
                    total: products.length,
                    overallTotal: numberOrUndefined(unit.response?.data?.body?.total),
                    globalPositionsReliable: pageGlobalPositionsReliable,
                    products: selected,
                };
                if (!unit.ok) {
                    page.error = unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB search request failed';
                }
                if (!unit.ok) globalPositionsReliable = false;
                globalOffset += products.length;
                return page;
            });
        return {
            query,
            pagesRequested,
            pagesSucceeded: pages.filter((page) => page.ok).length,
            productsSeen: pages.reduce((total, page) => total + page.total, 0),
            productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
            globalPositionsComplete: pages.every((page) => page.globalPositionsReliable),
            pages,
        };
    });
    const succeeded = fetched.filter((unit) => unit.ok).length;
    return {
        ok: succeeded > 0,
        status: normalizeStatus(succeeded, fetched.length),
        pagesRequested: fetched.length,
        pagesSucceeded: succeeded,
        pagesFailed: fetched.length - succeeded,
        productFilterApplied: Boolean(projection.productNmIds),
        productLimitPerQuery: projection.productNmIds ? undefined : projection.productLimitPerScope,
        queries,
    };
};

const executeCheckByQueryJob = async ({ authorizationId, job, requestWbFetch, writer }) => {
    // product_id is the public tool terminology; article is retained only in the signed wire descriptor.
    const productId = job.article;
    let cardResponse;
    try {
        cardResponse = await requestWbFetch(job.cardUrl, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
        await writer.append({ jobId: job.jobId, kind: 'card', product_id: productId, url: job.cardUrl, response: cardResponse });
    } catch (error) {
        rethrowAuthorizationError(error);
        await writer.append({ jobId: job.jobId, kind: 'card', product_id: productId, url: job.cardUrl, error: error.message });
        return {
            ok: false,
            status: 'failed',
            complete: false,
            product_id: productId,
            requestsMade: 1,
            queries: job.queries.map((query) => ({
                query,
                found: false,
                pagesChecked: 0,
                completionReason: 'card_failed',
                error: error.message,
            })),
        };
    }

    const cardProducts = responseProducts(cardResponse);
    const cardProduct = cardProducts.find((product) => numberOrUndefined(product?.id) === productId);
    const brandId = numberOrUndefined(cardProduct?.brandId);
    if (!isSuccessfulWbResponse(cardResponse) || !Number.isSafeInteger(brandId) || brandId <= 0) {
        const error = !isSuccessfulWbResponse(cardResponse)
            ? cardResponse?.error || cardResponse?.data?.statusText || 'WB product-card request failed'
            : 'WB product card did not contain a valid brand';
        return {
            ok: false,
            status: 'failed',
            complete: false,
            product_id: productId,
            product: {
                nmId: numberOrUndefined(cardProduct?.id) ?? productId,
                name: typeof cardProduct?.name === 'string' ? cardProduct.name : undefined,
                brand: typeof cardProduct?.brand === 'string' ? cardProduct.brand : undefined,
            },
            requestsMade: 1,
            queries: job.queries.map((query) => ({
                query,
                found: false,
                pagesChecked: 0,
                completionReason: 'card_failed',
                error,
            })),
        };
    }

    let searchRequestsMade = 0;
    const queries = await runWithConcurrency(job.queries, CHECK_QUERY_CONCURRENCY, async (query) => {
        let previousFingerprint;
        for (let page = 1; page <= job.maxPages; page += 1) {
            const url = buildCheckDescriptorUrl(job, query, page, brandId);
            let response;
            try {
                searchRequestsMade += 1;
                response = await requestWbFetch(url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
                await writer.append({ jobId: job.jobId, kind: 'search', query, page, url, response });
            } catch (error) {
                rethrowAuthorizationError(error);
                await writer.append({ jobId: job.jobId, kind: 'search', query, page, url, error: error.message });
                return {
                    query,
                    found: false,
                    pagesChecked: page - 1,
                    completionReason: 'request_failed',
                    error: error.message,
                };
            }
            const body = response?.data?.body;
            const hasProductArray = Array.isArray(body?.products);
            // WB's current valid no-results response is metadata-only and omits products entirely.
            const isMetadataOnlyNoResult =
                isSuccessfulWbResponse(response) &&
                body !== null &&
                typeof body === 'object' &&
                typeof body.name === 'string' &&
                typeof body.query === 'string' &&
                body.shardKey === 'merger' &&
                body.search_result !== null &&
                typeof body.search_result === 'object' &&
                !Object.hasOwn(body, 'products');
            const products = hasProductArray ? responseProducts(response) : [];
            if (!isSuccessfulWbResponse(response) || (!hasProductArray && !isMetadataOnlyNoResult)) {
                return {
                    query,
                    found: false,
                    pagesChecked: page - 1,
                    completionReason: 'request_failed',
                    error: response?.error || response?.data?.statusText || 'WB search request failed',
                };
            }

            const position = products.findIndex((product) => numberOrUndefined(product?.id) === productId);
            if (position >= 0) {
                return {
                    query,
                    found: true,
                    pagesChecked: page,
                    completionReason: 'found',
                };
            }
            if (products.length === 0) {
                return { query, found: false, pagesChecked: page, completionReason: 'empty_page' };
            }
            const fingerprint = JSON.stringify(products.map((product) => numberOrUndefined(product?.id) ?? null));
            if (fingerprint === previousFingerprint) {
                return { query, found: false, pagesChecked: page, completionReason: 'repeated_page' };
            }
            previousFingerprint = fingerprint;
        }
        return {
            query,
            found: false,
            pagesChecked: job.maxPages,
            completionReason: 'page_limit',
        };
    });

    const successfulQueries = queries.filter((query) => query.completionReason !== 'request_failed').length;
    return {
        ok: successfulQueries > 0,
        status: normalizeStatus(successfulQueries, queries.length),
        complete: successfulQueries === queries.length,
        product_id: productId,
        product: {
            nmId: numberOrUndefined(cardProduct?.id) ?? productId,
            name: typeof cardProduct?.name === 'string' ? cardProduct.name : undefined,
            brand: typeof cardProduct?.brand === 'string' ? cardProduct.brand : undefined,
        },
        requestsMade: 1 + searchRequestsMade,
        queries,
    };
};

const executeProductCardJob = async ({ authorizationId, job, requestWbFetch, writer }) => {
    const articles = normalizeProductArticles(job.articles);
    const units = articles.flatMap((article) =>
        job.endpoints.map((endpoint) => ({
            nmId: article.nm,
            key: endpoint.key,
            url: fillTemplate(endpoint.url, article),
        }))
    );
    const fetched = await runWithConcurrency(units, PRODUCT_CARD_CONCURRENCY, async (unit) => {
        try {
            const response = await requestWbFetch(unit.url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, response });
            return { ...unit, response, ok: isSuccessfulWbResponse(response) };
        } catch (error) {
            rethrowAuthorizationError(error);
            await writer.append({
                jobId: job.jobId,
                ...unit,
                error: error.message,
            });
            return { ...unit, ok: false, error: error.message };
        }
    });

    const products = articles.map((article) => {
        const articleUnits = fetched.filter((unit) => unit.nmId === article.nm);
        const detailUnit =
            articleUnits.find((unit) => unit.key === 'detail') || articleUnits.find((unit) => responseProducts(unit.response).length);
        const cardUnit = articleUnits.find((unit) => unit.key === 'card');
        const detail = detailUnit ? summarizeProduct(article.nm, detailUnit.response) : { nmId: article.nm, ok: false };
        const content = compactCardBody(cardUnit?.response?.data?.body);
        return {
            ...detail,
            ...content,
            nmId: article.nm,
            content,
            units: articleUnits.map((unit) => ({
                key: unit.key,
                ok: unit.ok,
                httpStatus: unit.response?.data?.status,
                error: unit.error || unit.response?.error || unit.response?.data?.statusText,
            })),
        };
    });
    const succeeded = products.filter((product) => product.ok).length;
    return {
        ok: succeeded > 0,
        status: normalizeStatus(succeeded, products.length),
        total: products.length,
        succeeded,
        failed: products.length - succeeded,
        products,
    };
};

const normalizeRecommendationArticles = (articles) => articles.map(([nmId, pages]) => ({ nmId, pages }));

const executeRecommendationsJob = async ({ authorizationId, job, requestWbFetch, writer, projection }) => {
    const articles = normalizeRecommendationArticles(job.articles);
    const fetchPage = async (unit) => {
        const url = buildDescriptorUrl(job.endpoint, job.params, String(unit.nmId), unit.page);
        try {
            const response = await requestWbFetch(url, job.timeout ?? REQUEST_TIMEOUT_MS, authorizationId);
            await writer.append({ jobId: job.jobId, ...unit, url, response });
            return {
                ...unit,
                url,
                response,
                ok: isSuccessfulWbResponse(response) && Array.isArray(response?.data?.body?.products),
            };
        } catch (error) {
            rethrowAuthorizationError(error);
            await writer.append({
                jobId: job.jobId,
                ...unit,
                url,
                error: error.message,
            });
            return { ...unit, url, ok: false, error: error.message };
        }
    };

    const firstPages = await runWithConcurrency(
        articles.map((article) => ({ ...article, page: 1 })),
        RECOMMENDATION_CONCURRENCY,
        fetchPage
    );
    const remainingUnits = [];
    const autoDepthCapped = new Set();
    for (const firstPage of firstPages) {
        const discoveredPages = recommendationTotalPages(numberOrUndefined(firstPage.response?.data?.body?.total));
        const article = articles.find((item) => item.nmId === firstPage.nmId);
        if (article.pages === undefined && discoveredPages !== null && discoveredPages > MAX_RECOMMENDATION_PAGES_PER_PRODUCT) {
            autoDepthCapped.add(article.nmId);
        }
        const requestedPages =
            article.pages === undefined
                ? Math.min(discoveredPages || 1, MAX_RECOMMENDATION_PAGES_PER_PRODUCT)
                : Math.min(article.pages, discoveredPages || article.pages);
        const additionalPages = Math.max(0, requestedPages - 1);
        for (let page = 2; page <= additionalPages + 1; page += 1) {
            remainingUnits.push({ ...article, page });
        }
    }
    const remainingPages = await runWithConcurrency(remainingUnits, RECOMMENDATION_CONCURRENCY, fetchPage);
    const fetched = [...firstPages, ...remainingPages];

    const summaries = articles.map((article) => {
        let globalOffset = 0;
        let returnedProducts = 0;
        let globalPositionsReliable = true;
        const articleUnits = fetched.filter((unit) => unit.nmId === article.nmId).sort((left, right) => left.page - right.page);
        const overallTotal = numberOrUndefined(articleUnits[0]?.response?.data?.body?.total);
        const discoveredPages = recommendationTotalPages(overallTotal);
        const pages = articleUnits.map((unit) => {
            const products = responseProducts(unit.response);
            const productLimit = projection.productNmIds ? MAX_RETURNED_PRODUCTS : projection.productLimitPerScope;
            const remaining = Math.max(0, productLimit - returnedProducts);
            const pageGlobalPositionsReliable = globalPositionsReliable && unit.ok;
            const selected = unit.ok
                ? projectPageProducts(
                      products,
                      globalOffset,
                      projection.productNmIds,
                      remaining,
                      pageGlobalPositionsReliable
                  )
                : [];
            returnedProducts += selected.length;
            const page = {
                page: unit.page,
                ok: unit.ok,
                httpStatus: unit.response?.data?.status,
                total: products.length,
                globalPositionsReliable: pageGlobalPositionsReliable,
                products: selected,
            };
            if (!unit.ok) {
                page.error = unit.error || unit.response?.error || unit.response?.data?.statusText || 'WB recommendation request failed';
            }
            if (!unit.ok) globalPositionsReliable = false;
            globalOffset += products.length;
            return page;
        });
        return {
            sourceNmId: article.nmId,
            pagesRequested: pages.length,
            pagesSucceeded: pages.filter((page) => page.ok).length,
            overallTotal,
            totalPages: discoveredPages,
            productsSeen: pages.reduce((total, page) => total + page.total, 0),
            productsReturned: pages.reduce((total, page) => total + page.products.length, 0),
            truncatedByLocalLimit: autoDepthCapped.has(article.nmId),
            globalPositionsComplete: pages.every((page) => page.globalPositionsReliable),
            pages,
        };
    });
    const succeeded = fetched.filter((unit) => unit.ok).length;
    const truncatedByLocalLimit = autoDepthCapped.size > 0;
    return {
        ok: succeeded > 0,
        status: truncatedByLocalLimit && succeeded === fetched.length ? 'partial' : normalizeStatus(succeeded, fetched.length),
        complete: !truncatedByLocalLimit && succeeded === fetched.length,
        truncatedByLocalLimit,
        pagesRequested: fetched.length,
        pagesSucceeded: succeeded,
        pagesFailed: fetched.length - succeeded,
        productFilterApplied: Boolean(projection.productNmIds),
        productLimitPerSource: projection.productNmIds ? undefined : projection.productLimitPerScope,
        articles: summaries,
    };
};

const SELLER_XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SELLER_ABORT_CODES = new Set([
    'SELLER_LOGIN_REQUIRED',
    'SELLER_AUTH_UNAVAILABLE',
    'SELLER_STATE_UNAVAILABLE',
    // Raised before the create request ever reaches the page, so every remaining export would fail the
    // same way: abort the package instead of re-driving cabinet activation once per export.
    'SELLER_PORT_UNAVAILABLE',
    'ENTITY_CATALOG_UNAVAILABLE',
    'ENTITY_SELECTION_REQUIRED',
    'ENTITY_NOT_AVAILABLE',
    'BROWSER_JOB_REAUTHORIZATION_REQUIRED',
    'JOB_ARTIFACT_QUOTA_EXCEEDED',
    'ARTIFACT_FILE_QUOTA_EXCEEDED',
    'ARTIFACT_TOTAL_QUOTA_EXCEEDED',
    // The cabinet itself refused us. Every remaining export would be refused the same way under the
    // same seller token, so the package stops instead of proving it once per export. Deliberately not
    // routed through AUTHORIZATION_FETCH_ERROR_CODES: stage `authorization` would abort too, but it
    // also puts the code on the re-authorization path, and re-signing the browser job token cannot
    // revive a dead cabinet session.
    'SELLER_CABINET_UNAUTHORIZED',
    'SELLER_CABINET_RATE_LIMITED',
    // The extension admission floor. A correct agent pacing above it never trips it, so a trip means
    // this job is sending faster than the trust boundary allows and retrying would only hit the same
    // rejection.
    'SELLER_OPERATION_RATE_LIMITED',
]);

const normalizeSellerExports = (exports) =>
    exports.flatMap((sellerExport) => {
        const base = {
            ...(sellerExport.product_id === undefined ? {} : { product_id: sellerExport.product_id }),
            ...(sellerExport.dateFrom === undefined ? {} : { dateFrom: sellerExport.dateFrom }),
            ...(sellerExport.dateTo === undefined ? {} : { dateTo: sellerExport.dateTo }),
            ...(sellerExport.ratings === undefined
                ? {}
                : { ratings: [...sellerExport.ratings].sort((left, right) => left - right) }),
            ...(sellerExport.content === undefined ? {} : { content: sellerExport.content }),
        };
        if (sellerExport.isAnswered === undefined) {
            return [
                { ...base, isAnswered: false, section: 'unanswered' },
                { ...base, isAnswered: true, section: 'answered' },
            ];
        }
        return [
            {
                ...base,
                isAnswered: sellerExport.isAnswered,
                section: sellerExport.isAnswered ? 'answered' : 'unanswered',
            },
        ];
    });

// Every field `sellerExportIdentity` treats as distinguishing has to reach the name too, or two exports
// that differ only by rating or media filter arrive at the agent as identically named resource links.
const sellerArtifactName = (sellerExport) => {
    const period = sellerExport.dateFrom ? `${sellerExport.dateFrom}_${sellerExport.dateTo}` : 'all-time';
    const ratings = sellerExport.ratings === undefined ? 'any-rating' : `stars${[...sellerExport.ratings].join('')}`;
    const content = sellerExport.content === undefined ? 'any-content' : sellerExport.content;
    return `wb-reviews-${sellerExport.product_id ?? 'all-products'}-${sellerExport.section}-${period}-${ratings}-${content}.xlsx`;
};

const sellerError = (error, fallbackCode, fallbackMessage, stage = 'execution', retryable = false) => {
    if (error instanceof ToolExecutionError) {
        return { code: error.code, message: error.message, stage: error.stage, retryable: error.retryable };
    }
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code : fallbackCode;
    return { code, message: fallbackMessage, stage: error?.stage || stage, retryable: error?.retryable === true || retryable };
};

// A per-operation timeout is retryable by construction: the poll and download loops already own their
// own retry budgets, so it must not be swallowed by the stage-based package abort below. WB_FETCH_TIMEOUT
// belongs here for the same reason and is in fact the common one: the extension's own request timer fires
// before the agent's, which carries a grace margin, so a slow cabinet reaches us under that code rather
// than as SELLER_OPERATION_TIMEOUT. It arrives with retryable false, so nothing else marks it survivable.
const SELLER_RETRY_ONLY_CODES = new Set(['SELLER_OPERATION_TIMEOUT', 'WB_FETCH_TIMEOUT']);

const abortsSellerPackage = (error) =>
    SELLER_RETRY_ONLY_CODES.has(error?.code)
        ? false
        : error instanceof ToolExecutionError
          ? error.stage === 'authorization' || error.stage === 'extension' || SELLER_ABORT_CODES.has(error.code)
          : error?.stage === 'authorization' || error?.stage === 'extension' || SELLER_ABORT_CODES.has(error?.code);

const reportIdFromCreate = (response) => response?.data?.reportId ?? response?.reportId;
const reportStatusFromPoll = (response, reportId) => {
    if (response?.data?.reportId === reportId && typeof response.data.status === 'string') return response.data.status;
    if (response?.reportId === reportId && typeof response.status === 'string') return response.status;
    const reports = response?.data?.reportsInfo ?? response?.reportsInfo;
    return Array.isArray(reports) ? reports.find((report) => report?.reportId === reportId)?.status : undefined;
};
const delay = (milliseconds) => (milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve());

/**
 * Executes a signed seller-review report workflow. The extension has already validated
 * the descriptor; this executor only expands its immutable scope into physical reports.
 */
export const executeSellerReviewsJob = async ({
    authorization,
    requestSellerOperation,
    createArtifactWriter,
    artifactJobId = undefined,
    releaseArtifactJob = undefined,
    // Keep the same cadence as the current WB feedbacks-front report polling saga.
    pollIntervalMs = 3000,
    minSellerOperationIntervalMs = MIN_SELLER_OPERATION_AGENT_INTERVAL_MS,
    maxPollsPerReport = MAX_SELLER_REVIEW_POLLS_PER_REPORT,
    maxConsecutivePollFailures = MAX_CONSECUTIVE_SELLER_POLL_FAILURES,
    maxConsecutiveExportFailures = MAX_CONSECUTIVE_SELLER_EXPORT_FAILURES,
    maxDownloadAttempts = MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS,
    downloadTimeoutMs = SELLER_DOWNLOAD_TIMEOUT_MS,
    maxJobDurationMs = SELLER_JOB_MAX_DURATION_MS,
    now = Date.now,
    delay: delayFn = delay,
}) => {
    // Stop starting new work before the job can be cancelled out from under itself. Without this the
    // scope expiry timer cancels whatever is in flight with BROWSER_JOB_REAUTHORIZATION_REQUIRED, which
    // reads as an authorization failure rather than as a job that ran out of budget. The signed token is
    // the real ceiling — nothing rejects a short-lived one — so a five-minute token deadlines the job in
    // five minutes, not in `maxJobDurationMs`. The reserve has to cover every download attempt the loop
    // below is allowed to make, not just the first, or the retry is what crosses the expiry.
    const downloadReserveMs = downloadTimeoutMs * Math.max(1, maxDownloadAttempts);
    const authorizationExpiresAtMs =
        typeof authorization?.expiresAt === 'number' && Number.isFinite(authorization.expiresAt)
            ? authorization.expiresAt * 1000 - downloadReserveMs
            : Infinity;
    const jobDeadline = Math.min(now() + maxJobDurationMs, authorizationExpiresAtMs);
    const deadlineExceeded = () => now() >= jobDeadline;
    const deadlineFailure = (result) => ({
        ...result,
        status: 'failed',
        error: {
            code: 'SELLER_JOB_DEADLINE_EXCEEDED',
            message: 'The seller export ran out of authorized time before this report could start.',
            stage: 'execution',
            retryable: true,
        },
    });
    const jobId = authorization?.job?.jobId;
    const artifactExecutionId = artifactJobId ?? jobId;
    let lastSellerOperationSentAt;
    // The poll cadence only ever covered poll-to-poll. Create-to-first-poll, poll-to-download and
    // export-to-export had no pacing at all, which is what let a package burst at the cabinet.
    const pacedRequestSellerOperation = async (...args) => {
        if (lastSellerOperationSentAt !== undefined) {
            // Date.now is not monotonic: an NTP correction or a VM resume can step it backwards, and an
            // unclamped remainder would then sleep past the signed token instead of pacing by it.
            const elapsedMs = Math.max(0, now() - lastSellerOperationSentAt);
            const waitMs = minSellerOperationIntervalMs - elapsedMs;
            if (waitMs > 0) await delayFn(waitMs);
        }
        lastSellerOperationSentAt = now();
        return requestSellerOperation(...args);
    };
    let primaryError;
    try {
        validateAuthorizedJobLimits(authorization);
        if (authorization.jobType !== 'seller_reviews') throw new Error('Seller review executor requires a seller_reviews authorization');
        if (typeof requestSellerOperation !== 'function' || typeof createArtifactWriter !== 'function') {
            throw new Error('Seller review execution dependencies are unavailable');
        }
        const physicalExports = normalizeSellerExports(authorization.job.exports);
        const exports = [];
        let packageAborted = false;
        let consecutiveExportFailures = 0;
        // Every export result goes through here so the package can notice that it is failing the same
        // way over and over: a create that keeps failing costs one request per export, and without a
        // counter the run proves that once for every remaining export.
        const recordExport = (entry, { systemic = true } = {}) => {
            exports.push(entry);
            if (entry.status === 'complete') {
                consecutiveExportFailures = 0;
                return;
            }
            if (entry.status !== 'failed' || !systemic) return;
            consecutiveExportFailures += 1;
            if (consecutiveExportFailures >= maxConsecutiveExportFailures) packageAborted = true;
        };
        for (let exportIndex = 0; exportIndex < physicalExports.length; exportIndex += 1) {
            const sellerExport = physicalExports[exportIndex];
            const result = {
                ...(sellerExport.product_id === undefined ? {} : { product_id: sellerExport.product_id }),
                isAnswered: sellerExport.isAnswered,
                ...(sellerExport.dateFrom === undefined ? {} : { dateFrom: sellerExport.dateFrom }),
                ...(sellerExport.dateTo === undefined ? {} : { dateTo: sellerExport.dateTo }),
                ...(sellerExport.ratings === undefined ? {} : { ratings: [...sellerExport.ratings] }),
                ...(sellerExport.content === undefined ? {} : { content: sellerExport.content }),
            };
            if (!packageAborted && deadlineExceeded()) {
                packageAborted = true;
                recordExport(deadlineFailure(result));
                continue;
            }
            if (packageAborted) {
                recordExport({ ...result, status: 'skipped' });
                continue;
            }

            let reportId;
            try {
                const createResponse = await pacedRequestSellerOperation({
                    exportIndex,
                    isAnswered: sellerExport.isAnswered,
                    stage: SELLER_OPERATION_STAGES.create,
                });
                reportId = reportIdFromCreate(createResponse);
                if (typeof reportId !== 'string' || reportId.length === 0) {
                    throw new ToolExecutionError(
                        'REPORT_CREATE_OUTCOME_UNKNOWN',
                        'Wildberries did not confirm creation of the review report.',
                        'execution',
                        false
                    );
                }
            } catch (error) {
                const normalized = sellerError(
                    error,
                    'REPORT_FAILED',
                    'Wildberries could not create the review report.'
                );
                recordExport({ ...result, status: 'failed', error: normalized });
                packageAborted = packageAborted || abortsSellerPackage(error);
                continue;
            }

            let reportReady = false;
            let pollFailure;
            let pollBreakerTripped = false;
            // Only a status Wildberries actually returned is its verdict. Deciding that from the error
            // code instead would have caught the create stage's REPORT_FAILED fallback, which means the
            // opposite there — that the failure could not be classified at all.
            let reportVerdict = false;
            let consecutivePollFailures = 0;
            for (let poll = 0; poll < maxPollsPerReport; poll += 1) {
                try {
                    const pollResponse = await pacedRequestSellerOperation({
                        exportIndex,
                        isAnswered: sellerExport.isAnswered,
                        stage: SELLER_OPERATION_STAGES.poll,
                        reportId,
                    });
                    // Reset on the response itself, not on a usable status: the request succeeded, so
                    // whatever the line below makes of it is a fresh failure rather than a repeat.
                    consecutivePollFailures = 0;
                    const status = reportStatusFromPoll(pollResponse, reportId);
                    if (status === 'complete') {
                        reportReady = true;
                        break;
                    }
                    if (status === 'stopped' || status === 'error') {
                        reportVerdict = true;
                        pollFailure = new ToolExecutionError(
                            status === 'stopped' ? 'REPORT_STOPPED' : 'REPORT_FAILED',
                            status === 'stopped' ? 'Wildberries stopped the review report.' : 'Wildberries failed the review report.',
                            'execution',
                            false
                        );
                        break;
                    }
                } catch (error) {
                    if (abortsSellerPackage(error)) {
                        pollFailure = error;
                        packageAborted = true;
                        break;
                    }
                    pollFailure = error;
                    consecutivePollFailures += 1;
                    // Repeated failures are not "not ready yet": a successful poll returning inProgress
                    // resets the counter, so reaching the threshold means the endpoint is answering
                    // badly and the rest of the budget would be spent for nothing. Only a retryable
                    // cause leaves the remaining exports alive.
                    if (consecutivePollFailures >= maxConsecutivePollFailures) {
                        pollBreakerTripped = true;
                        // Slowness is not refusal. A cabinet that keeps timing out may still finish the
                        // next report, so the export gives up while the package goes on; only a failure
                        // that says the cabinet will answer the same way for everyone stops the run.
                        if (error?.retryable !== true && !SELLER_RETRY_ONLY_CODES.has(error?.code)) {
                            packageAborted = true;
                        }
                        break;
                    }
                }
                if (poll + 1 >= maxPollsPerReport) break;
                // Give up polling in time to still download whatever is already complete rather than
                // letting the scope expiry cancel the operation mid-poll.
                if (now() + pollIntervalMs >= jobDeadline) break;
                await delayFn(pollIntervalMs);
            }
            if (!reportReady) {
                // A tripped breaker carries the real cause: reporting it as a timeout would tell the
                // agent to wait longer for a report that was never being refused for time reasons. An
                // opaque failure has no cause to carry, so it must at least not claim to be a
                // retryable timeout while the package it just stopped stays stopped.
                const error = pollBreakerTripped
                    ? pollFailure instanceof ToolExecutionError
                        ? pollFailure
                        : new ToolExecutionError(
                              'REPORT_POLL_FAILED',
                              'Wildberries stopped answering polls for this review report.',
                              'execution',
                              false
                          )
                    : pollFailure instanceof ToolExecutionError && abortsSellerPackage(pollFailure)
                      ? pollFailure
                      : pollFailure instanceof ToolExecutionError && ['REPORT_STOPPED', 'REPORT_FAILED'].includes(pollFailure.code)
                        ? pollFailure
                        : new ToolExecutionError('REPORT_TIMEOUT', 'Wildberries did not complete the review report in time.', 'execution', true);
                recordExport(
                    { ...result, status: 'failed', error: sellerError(error, 'REPORT_TIMEOUT', 'Wildberries did not complete the review report in time.') },
                    { systemic: !reportVerdict }
                );
                continue;
            }

            // Polling can burn the whole budget on its own, so the report being ready is not proof there
            // is still time to fetch it. Crossing here would surface as an authorization failure.
            if (deadlineExceeded()) {
                packageAborted = true;
                recordExport(deadlineFailure(result));
                continue;
            }

            let artifact;
            let downloadError;
            for (let attempt = 0; attempt < maxDownloadAttempts; attempt += 1) {
                // The reserve covers every attempt, but a first attempt that ran long can still eat it.
                if (attempt > 0 && deadlineExceeded()) break;
                /** @type {{ appendChunk: (index: number, data: string) => Promise<void>, complete: (completion: { size: number, sha256: string }) => Promise<unknown>, abort: () => Promise<void> } | undefined} */
                let writer;
                try {
                    await pacedRequestSellerOperation(
                        { exportIndex, isAnswered: sellerExport.isAnswered, stage: SELLER_OPERATION_STAGES.download, reportId },
                        {
                            onStart: async () => {
                                if (writer) throw new Error('Seller artifact stream started more than once');
                                writer = await createArtifactWriter({
                                    jobId: artifactExecutionId,
                                    fileName: sellerArtifactName(sellerExport),
                                    mimeType: SELLER_XLSX_MIME_TYPE,
                                });
                            },
                            onChunk: async (index, data) => {
                                if (!writer) throw new Error('Seller artifact stream chunk arrived before start');
                                await writer.appendChunk(index, data);
                            },
                            onEnd: async ({ size, sha256 }) => {
                                if (!writer) throw new Error('Seller artifact stream ended before start');
                                artifact = await writer.complete({ size, sha256 });
                            },
                        },
                        downloadTimeoutMs
                    );
                    if (!artifact) throw new Error('Seller artifact stream completed without publishing an artifact');
                    break;
                } catch (error) {
                    downloadError = error;
                    if (writer) {
                        try {
                            await writer.abort();
                        } catch (cleanupError) {
                            downloadError = new ToolExecutionError(
                                'ARTIFACT_CLEANUP_FAILED',
                                'The partial review workbook could not be removed safely.',
                                'storage',
                                false,
                                { cause: new AggregateError([error, cleanupError], 'Download and artifact cleanup both failed') }
                            );
                            packageAborted = true;
                            break;
                        }
                    }
                    if (artifact) break;
                    if (abortsSellerPackage(error)) {
                        packageAborted = true;
                        break;
                    }
                }
            }
            if (artifact) {
                recordExport({ ...result, status: 'complete', artifact });
            } else {
                recordExport({
                    ...result,
                    status: 'failed',
                    error: sellerError(downloadError, 'ARTIFACT_STORAGE_FAILED', 'The review workbook could not be stored locally.', 'storage', true),
                });
            }
        }

        const succeeded = exports.filter((item) => item.status === 'complete').length;
        return {
            ok: succeeded > 0,
            status: succeeded === exports.length ? 'complete' : succeeded > 0 ? 'partial' : 'failed',
            jobType: 'seller_reviews',
            jobId,
            ...(authorization.job.org ? { org: authorization.job.org } : {}),
            exports,
        };
    } catch (error) {
        primaryError = error;
        throw error;
    } finally {
        // Direct executor callers may still own cleanup. The MCP dispatcher omits this callback because it must
        // retain pins through authorization restoration and terminal response emission.
        if (typeof releaseArtifactJob === 'function' && typeof artifactExecutionId === 'string' && artifactExecutionId.length > 0) {
            try {
                await releaseArtifactJob(artifactExecutionId);
            } catch (releaseError) {
                if (!primaryError) throw releaseError;
            }
        }
    }
};

export const executeAuthorizedBrowserJob = async ({
    authorization,
    requestWbFetch,
    writer,
    productLimitPerScope = DEFAULT_RETURNED_PRODUCTS,
    productNmIds,
}) => {
    validateAuthorizedJobLimits(authorization);
    const projection = { productLimitPerScope, productNmIds };
    let result;
    if (authorization.jobType === 'search_by_query') {
        result = await executeSearchJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
            projection,
        });
    } else if (authorization.jobType === 'check_by_query') {
        result = await executeCheckByQueryJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
        });
    } else if (authorization.jobType === 'product_card') {
        result = await executeProductCardJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
        });
    } else if (authorization.jobType === 'recommendations_by_product') {
        result = await executeRecommendationsJob({
            authorizationId: authorization.authorizationId,
            job: authorization.job,
            requestWbFetch,
            writer,
            projection,
        });
    } else {
        throw new Error(`Unsupported browser_job type: ${authorization.jobType}`);
    }
    return {
        ...result,
        jobType: authorization.jobType,
        jobId: authorization.job.jobId,
        expiresAt: authorization.expiresAt,
    };
};
