import {
    DEFAULT_RETURNED_PRODUCTS,
    MAX_BROWSER_JOB_TOKEN_BYTES,
    MAX_BROWSER_JOB_TEXT_LENGTH,
    MAX_BROWSER_JOB_URL_LENGTH,
    MAX_PRODUCT_CARD_PRODUCTS,
    MAX_PRODUCT_CARD_REQUEST_UNITS,
    MAX_RECOMMENDATION_PAGES_PER_PRODUCT,
    MAX_RECOMMENDATION_REQUEST_UNITS,
    MAX_RETURNED_PRODUCTS,
    MAX_SEARCH_PAGES_PER_QUERY,
    MAX_SEARCH_REQUEST_UNITS,
    PRODUCT_CARD_CONCURRENCY,
    RECOMMENDATION_CONCURRENCY,
    REQUEST_TIMEOUT_MS,
    SEARCH_CONCURRENCY,
} from './config.mjs';
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
