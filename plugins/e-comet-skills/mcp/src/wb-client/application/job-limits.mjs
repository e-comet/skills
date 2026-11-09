import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { validTimeout } from '../../shared/timeouts.mjs';
import { fieldOf, isBoundedText, isPositiveSafeInteger, isRecord, isUnknownArray } from '../../shared/values.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH, MAX_BROWSER_JOB_URL_LENGTH } from '../../transport/mcp/limits.mjs';
import { MAX_FILTER_QUERIES, MAX_CHECK_PAGES_PER_QUERY, MAX_CHECK_QUERIES, MAX_CHECK_SEARCH_REQUESTS, MAX_PRODUCT_CARD_PRODUCTS, MAX_PRODUCT_CARD_REQUEST_UNITS, MAX_RECOMMENDATION_PAGES_PER_PRODUCT, MAX_RECOMMENDATION_REQUEST_UNITS, MAX_SEARCH_PAGES_PER_QUERY, MAX_SEARCH_REQUEST_UNITS, } from '../domain/constants/limits.const.mjs';
import { buildCheckDescriptorUrl, buildDescriptorUrl, buildFiltersDescriptorUrl, fillTemplate, normalizeProductArticles, } from '../domain/converters/descriptor-urls.converter.mjs';
import { isAllowedWbUrl } from '../domain/policies/wb-url.policy.mjs';
// Parse boundary: a signed descriptor as the extension attested it; the checks below read it field by field.
const validJobTimeout = (timeout) => timeout === undefined || validTimeout(timeout);
// Each broken limit names its closed rule (DESCRIPTOR_RULES in transport/failures); the message stays in the log only.
const brokenRule = (rule, message) => Object.assign(new Error(message), { rule });
const invalidDescriptor = (cause) => {
    const error = new ToolExecutionError('BROWSER_JOB_DESCRIPTOR_INVALID', 
    // The same job is signed the same way, so another authorization fails the same way.
    'The signed browser job descriptor is invalid; this is an e-Comet defect. Offer to report it; do not request another authorization for the same job.', 'authorization', false, { cause: cause instanceof Error ? cause : new Error(String(cause)) });
    const rule = fieldOf(cause, 'rule');
    if (typeof rule === 'string')
        error.details = { rule };
    return error;
};
const boundedText = (value) => isBoundedText(value, MAX_BROWSER_JOB_TEXT_LENGTH);
const queryText = (value) => boundedText(value) && value.trim().length > 0;
const pageCount = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1;
const validEndpoint = (value) => {
    if (typeof value !== 'string' || value.length > MAX_BROWSER_JOB_URL_LENGTH)
        return false;
    return isAllowedWbUrl(value);
};
const validParams = (value) => isRecord(value) &&
    value.query === undefined &&
    value.page === undefined &&
    Object.entries(value).every(([key, item]) => boundedText(key) && boundedText(item));
const validProductArticle = (article) => isRecord(article) &&
    isPositiveSafeInteger(article.nm) &&
    Object.values(article).every((value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)));
const validEndpointTemplate = (endpoint) => isRecord(endpoint) &&
    boundedText(endpoint.key) &&
    typeof endpoint.url === 'string' &&
    endpoint.url.length >= 1 &&
    endpoint.url.length <= MAX_BROWSER_JOB_URL_LENGTH;
const validSearchScope = (item) => {
    if (!isUnknownArray(item) || item.length !== 2)
        return false;
    const [query, pages] = item;
    return queryText(query) && pageCount(pages);
};
const validRecommendationArticle = (item) => isUnknownArray(item) &&
    (item.length === 1 || item.length === 2) &&
    isPositiveSafeInteger(item[0]) &&
    (item.length === 1 || pageCount(item[1]));
const validUniqueQueries = (queries, maxQueries) => isUnknownArray(queries) &&
    queries.length >= 1 &&
    queries.length <= maxQueries &&
    queries.every(queryText) &&
    new Set(queries).size === queries.length;
const cardUrlMatchesArticle = (cardUrl, article) => {
    try {
        return Number(new URL(cardUrl).searchParams.get('nm')) === article;
    }
    catch {
        return false;
    }
};
// The limits of a signed buyer or filters descriptor, answered as the checked grant; any other job type is not this context's.
// Parse boundary: the grant as the extension sent it.
export const validateAuthorizedJobLimits = (authorization) => {
    try {
        const job = fieldOf(authorization, 'job');
        const jobId = fieldOf(job, 'jobId');
        if (!isRecord(job) || !boundedText(jobId))
            throw brokenRule('descriptor', 'Browser job descriptor is invalid');
        const timeout = job.timeout;
        if (!validJobTimeout(timeout))
            throw brokenRule('timeout', 'Browser job timeout is invalid');
        const jobType = fieldOf(authorization, 'jobType');
        if (jobType === 'search_by_query') {
            const { queries, endpoint, params } = job;
            if (job.type !== 'wb-search-by-query')
                throw brokenRule('type', 'Invalid search descriptor type');
            if (!validEndpoint(endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(params))
                throw brokenRule('params', 'Invalid browser job params');
            if (!isUnknownArray(queries) || queries.length < 1 || !queries.every(validSearchScope))
                throw brokenRule('queries', 'Invalid browser job queries');
            if (queries.some(([, pages]) => pages > MAX_SEARCH_PAGES_PER_QUERY))
                throw brokenRule('pages', `Browser search job requires at most ${MAX_SEARCH_PAGES_PER_QUERY} pages per query`);
            if (queries.reduce((total, [, pages]) => total + pages, 0) > MAX_SEARCH_REQUEST_UNITS)
                throw brokenRule('requests', `Browser search job requires at most ${MAX_SEARCH_REQUEST_UNITS} total pages`);
            if (!descriptorPagesAllowed(endpoint, params, queries))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
            return { jobType, job: { jobId, timeout, endpoint, params, queries } };
        }
        if (jobType === 'check_by_query') {
            const { queries, article, cardUrl, endpoint, params, maxPages } = job;
            if (job.type !== 'wb-check-by-query')
                throw brokenRule('type', 'Invalid check-by-query descriptor type');
            if (!isPositiveSafeInteger(article))
                throw brokenRule('product', 'Invalid check-by-query product');
            if (!validEndpoint(cardUrl) || !cardUrlMatchesArticle(cardUrl, article))
                throw brokenRule('card_url', 'Invalid check-by-query card URL');
            if (!validEndpoint(endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(params) || params.fbrand !== undefined || params.resultset !== undefined)
                throw brokenRule('params', 'Invalid browser job params');
            if (!validUniqueQueries(queries, MAX_CHECK_QUERIES))
                throw brokenRule('queries', `Browser check-by-query job requires 1-${MAX_CHECK_QUERIES} unique queries`);
            if (maxPages !== MAX_CHECK_PAGES_PER_QUERY)
                throw brokenRule('pages', `Browser check-by-query job requires exactly ${MAX_CHECK_PAGES_PER_QUERY} pages per query`);
            if (queries.length * maxPages > MAX_CHECK_SEARCH_REQUESTS)
                throw brokenRule('requests', `Browser check-by-query job requires at most ${MAX_CHECK_SEARCH_REQUESTS} search requests`);
            const checkJob = { jobId, timeout, article, cardUrl, endpoint, params, queries, maxPages };
            if (!descriptorCheckPagesAllowed(checkJob, queries))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
            return { jobType, job: checkJob };
        }
        if (jobType === 'filters_by_query') {
            const { queries, endpoint, params } = job;
            if (job.type !== 'wb-filters-by-query')
                throw brokenRule('type', 'Invalid filters-by-query descriptor type');
            if (!validEndpoint(endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(params) || params.resultset !== undefined || params.filters !== undefined)
                throw brokenRule('params', 'Invalid browser job params');
            if (!validUniqueQueries(queries, MAX_FILTER_QUERIES))
                throw brokenRule('queries', `Browser filters-by-query job requires 1-${MAX_FILTER_QUERIES} unique queries`);
            if (!queries.every((query) => isAllowedWbUrl(buildFiltersDescriptorUrl({ endpoint, params }, query))))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
            return { jobType, job: { jobId, timeout, endpoint, params, queries } };
        }
        if (jobType === 'product_card') {
            const { articles, endpoints } = job;
            if (job.type !== 'wb-product-card')
                throw brokenRule('type', 'Invalid product-card descriptor type');
            if (!isUnknownArray(articles) || articles.length < 1 || !articles.every(validProductArticle))
                throw brokenRule('articles', 'Invalid browser job articles');
            if (articles.length > MAX_PRODUCT_CARD_PRODUCTS)
                throw brokenRule('requests', `Browser product-card job requires at most ${MAX_PRODUCT_CARD_PRODUCTS} products`);
            if (!isUnknownArray(endpoints) || endpoints.length < 1 || !endpoints.every(validEndpointTemplate))
                throw brokenRule('endpoints', 'Invalid browser job endpoints');
            if (articles.length * endpoints.length > MAX_PRODUCT_CARD_REQUEST_UNITS)
                throw brokenRule('requests', `Browser product-card job requires at most ${MAX_PRODUCT_CARD_REQUEST_UNITS} requests`);
            if (!articles.every((article) => endpoints.every((endpoint) => isAllowedWbUrl(fillTemplate(endpoint.url, article)))))
                throw brokenRule('assembled_url', 'Invalid browser job expanded endpoint URL');
            return { jobType, job: { jobId, timeout, articles, endpoints } };
        }
        if (jobType === 'recommendations_by_product') {
            const { articles, endpoint, params } = job;
            if (job.type !== 'wb-recommendations-by-product')
                throw brokenRule('type', 'Invalid recommendations descriptor type');
            if (!validEndpoint(endpoint))
                throw brokenRule('endpoint', 'Invalid browser job endpoint');
            if (!validParams(params))
                throw brokenRule('params', 'Invalid browser job params');
            if (!isUnknownArray(articles) || articles.length < 1 || !articles.every(validRecommendationArticle))
                throw brokenRule('articles', 'Invalid browser job recommendation articles');
            if (new Set(articles.map(([nm]) => nm)).size !== articles.length)
                throw brokenRule('unique_products', 'Browser recommendations job requires unique products');
            if (articles.some((item) => item[1] !== undefined && item[1] > MAX_RECOMMENDATION_PAGES_PER_PRODUCT))
                throw brokenRule('pages', `Browser recommendations job requires at most ${MAX_RECOMMENDATION_PAGES_PER_PRODUCT} pages per product`);
            if (articles.reduce((total, item) => total + (item[1] ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT), 0) >
                MAX_RECOMMENDATION_REQUEST_UNITS)
                throw brokenRule('requests', `Browser recommendations job requires at most ${MAX_RECOMMENDATION_REQUEST_UNITS} total pages`);
            if (!descriptorPagesAllowed(endpoint, params, articles.map(([nm, pages]) => [String(nm), pages ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT])))
                throw brokenRule('assembled_url', 'Invalid browser job assembled endpoint URL');
            return { jobType, job: { jobId, timeout, endpoint, params, articles } };
        }
        throw brokenRule('job_type', `Unsupported browser_job type: ${jobType}`);
    }
    catch (error) {
        if (error instanceof ToolExecutionError)
            throw error;
        throw invalidDescriptor(error);
    }
};
const descriptorPagesAllowed = (endpoint, params, scopes) => scopes.every(([query, pages]) => {
    for (let page = 1; page <= pages; page += 1) {
        if (!isAllowedWbUrl(buildDescriptorUrl(endpoint, params, query, page)))
            return false;
    }
    return true;
});
const descriptorCheckPagesAllowed = (job, queries) => queries.every((query) => {
    for (let page = 1; page <= job.maxPages; page += 1) {
        // The extension derives fbrand from WB card data, so reserve URL space for every valid brand identity.
        if (!isAllowedWbUrl(buildCheckDescriptorUrl(job, query, page, Number.MAX_SAFE_INTEGER)))
            return false;
    }
    return true;
});
// The job stopped mid-run: say how many WB requests were answered (their rows are in the result file) and, when the
// signed budget is known, how many were not. Each job gets its own copy; one cause can end several jobs at once.
export const stoppedWbJobError = (error, grant, answered) => {
    const stopped = new ToolExecutionError(error.code, error.message, error.stage, error.retryable, { cause: error });
    const budget = signedRequests(grant);
    stopped.details = {
        ...error.details,
        completed: answered,
        ...(budget === undefined ? {} : { pending: Math.max(0, budget - answered) }),
    };
    return stopped;
};
// The signed request budget, undefined for a job type not listed here; check_by_query and recommendations may stop
// early, and filters_by_query asks for a full list only when a phrase has lists to expand, so for them it is an upper bound.
const signedRequests = (grant) => {
    switch (grant.jobType) {
        case 'search_by_query':
            return grant.job.queries.reduce((total, [, pages]) => total + pages, 0);
        case 'check_by_query':
            return 1 + grant.job.queries.length * grant.job.maxPages;
        case 'filters_by_query':
            return grant.job.queries.length * 2;
        case 'product_card':
            return normalizeProductArticles(grant.job.articles).length * grant.job.endpoints.length;
        case 'recommendations_by_product':
            return grant.job.articles.reduce((total, [, pages]) => total + (pages ?? MAX_RECOMMENDATION_PAGES_PER_PRODUCT), 0);
        default:
            return undefined;
    }
};
