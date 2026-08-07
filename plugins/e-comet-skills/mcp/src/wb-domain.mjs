import {
    IMAGE_BASKET_BOUNDS,
    IMAGE_CONCURRENCY,
    MAX_BROWSER_JOB_URL_LENGTH,
    MAX_REQUEST_TIMEOUT_MS,
    MIN_REQUEST_TIMEOUT_MS,
    RECOMMENDATION_PAGE_SIZE,
} from './config.mjs';

const ALLOWED_WB_HOSTS = new Set(['wildberries.ru', 'www.wildberries.ru']);
const ALLOWED_WB_PATH = /^\/__internal\/(card|search|recom|recommendations)\//;
const WB_CARD_HOST = /^basket-\d+\.wbbasket\.ru$/;
const WB_CARD_PATH = /^\/vol(?<vol>\d+)\/part(?<part>\d+)\/(?<nm>\d+)\/info\/[a-z]{2}\/card\.json$/;

const isAllowedWbCardUrl = (url) => {
    if (!WB_CARD_HOST.test(url.hostname) || url.search || url.hash) return false;
    const match = WB_CARD_PATH.exec(url.pathname);
    if (!match?.groups) return false;
    const nm = Number(match.groups.nm);
    return (
        Number.isSafeInteger(nm) &&
        nm > 0 &&
        Number(match.groups.vol) === Math.floor(nm / 100000) &&
        Number(match.groups.part) === Math.floor(nm / 1000)
    );
};

export const isAllowedWbUrl = (value) => {
    try {
        // Длина проверяется на собранном URL: ограничения на отдельные строки
        // дескриптора не связывают их количество.
        if (typeof value !== 'string' || value.length > MAX_BROWSER_JOB_URL_LENGTH) return false;
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
        if (url.pathname.includes('%')) return false;
        return (ALLOWED_WB_HOSTS.has(hostname) && ALLOWED_WB_PATH.test(url.pathname)) || isAllowedWbCardUrl(url);
    } catch {
        return false;
    }
};

export const responseProducts = (response) => (Array.isArray(response?.data?.body?.products) ? response.data.body.products : []);

export const isSuccessfulWbResponse = (response) =>
    !response?.error &&
    response?.data?.ok !== false &&
    typeof response?.data?.status === 'number' &&
    response.data.status >= 200 &&
    response.data.status < 300;

export const numberOrUndefined = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const positiveSafeIntegerOrUndefined = (value) =>
    Number.isSafeInteger(value) && value > 0 ? value : undefined;

const toRub = (value) => (numberOrUndefined(value) === undefined ? undefined : Math.round(value) / 100);

const summarizeListingProduct = (product, position, globalPosition) => {
    const nmId = positiveSafeIntegerOrUndefined(product?.id);
    if (nmId === undefined) return undefined;
    const sizes = Array.isArray(product?.sizes) ? product.sizes : [];
    const price = sizes.find((size) => size?.price)?.price || product?.price;
    const row = {
        nmId,
        name: typeof product?.name === 'string' ? product.name : undefined,
        brand: typeof product?.brand === 'string' ? product.brand : undefined,
        supplierId: numberOrUndefined(product?.supplierId),
        priceRub: price ? { basic: toRub(price.basic), product: toRub(price.product) } : undefined,
        rating: numberOrUndefined(product?.reviewRating),
        feedbacks: numberOrUndefined(product?.feedbacks),
        pics: numberOrUndefined(product?.pics),
        promoted: isPromotedViewFlags(product?.viewFlags),
        position,
    };
    if (Number.isSafeInteger(globalPosition) && globalPosition > 0) {
        row.globalPosition = globalPosition;
    }
    return row;
};

const isPromotedViewFlags = (value) => {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 && (BigInt(value) & 64n) !== 0n;
    }
    return typeof value === 'string' && /^\d{1,20}$/.test(value) && (BigInt(value) & 64n) !== 0n;
};

export const projectPageProducts = (products, globalOffset, productNmIds, remainingLimit, includeGlobalPosition = true) => {
    const filter = productNmIds ? new Set(productNmIds) : null;
    const rows = products
        .map((product, index) =>
            summarizeListingProduct(product, index + 1, includeGlobalPosition ? globalOffset + index + 1 : undefined)
        )
        .filter(Boolean);
    const selected = (filter ? rows.filter((row) => filter.has(row.nmId)) : rows).slice(0, remainingLimit);
    return selected;
};

export const normalizeStatus = (succeeded, total) => (succeeded === total ? 'done' : succeeded === 0 ? 'failed' : 'partial');

export const validTimeout = (timeout) =>
    typeof timeout === 'number' &&
    Number.isFinite(timeout) &&
    timeout >= MIN_REQUEST_TIMEOUT_MS &&
    timeout <= MAX_REQUEST_TIMEOUT_MS;

export const recommendationTotalPages = (total) => {
    if (!Number.isInteger(total) || total < 0) {
        return null;
    }
    return Math.max(1, Math.ceil(total / RECOMMENDATION_PAGE_SIZE));
};

const basketNumberForVol = (vol) => {
    const index = IMAGE_BASKET_BOUNDS.findIndex((upperBound) => vol <= upperBound);
    return index < 0 ? null : index + 1;
};

export const createConcurrencyLimiter = (concurrency, worker) => {
    let active = 0;
    const queued = [];
    const acquire = () => {
        if (active < concurrency) {
            active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => queued.push(resolve));
    };
    const release = () => {
        const next = queued.shift();
        if (next) next();
        else active -= 1;
    };
    return async (...args) => {
        await acquire();
        try {
            return await worker(...args);
        } finally {
            release();
        }
    };
};

export const imageBaseUrl = (nmId, basket) => {
    const testOrigin = process.env.NODE_ENV === 'test' ? process.env.ECOMET_LOCAL_BRIDGE_TEST_IMAGE_ORIGIN : undefined;
    const origin = testOrigin || `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru`;
    return `${origin}/vol${Math.floor(nmId / 100000)}/part${Math.floor(nmId / 1000)}/${nmId}/images`;
};

const imageRequestSignal = (timeout, shutdownSignal) =>
    shutdownSignal ? AbortSignal.any([AbortSignal.timeout(timeout), shutdownSignal]) : AbortSignal.timeout(timeout);

export const imageExists = async (url, timeout, shutdownSignal) => {
    try {
        const response = await fetch(url, { method: 'HEAD', signal: imageRequestSignal(timeout, shutdownSignal) });
        if (response.ok) return true;
        if (response.status !== 403 && response.status !== 405) return false;
    } catch {
        // Some CDN edges do not support HEAD; retry with a one-byte GET.
    }
    try {
        const response = await fetch(url, {
            headers: { Range: 'bytes=0-0' },
            signal: imageRequestSignal(timeout, shutdownSignal),
        });
        try {
            return response.ok || response.status === 206;
        } finally {
            await response.body?.cancel?.().catch(() => undefined);
        }
    } catch {
        return false;
    }
};

export const discoverImageBasket = async (nmId, maxBasket, size, timeout, probe = imageExists) => {
    const vol = Math.floor(nmId / 100000);
    const predicted = basketNumberForVol(vol);
    const allBaskets = Array.from({ length: maxBasket }, (_, index) => index + 1);
    const firstFutureBasket = IMAGE_BASKET_BOUNDS.length + 1;
    const candidates = predicted
        ? [predicted, ...allBaskets.filter((basket) => basket !== predicted)]
        : firstFutureBasket <= maxBasket
          ? [...allBaskets.filter((basket) => basket >= firstFutureBasket), ...allBaskets.filter((basket) => basket < firstFutureBasket)]
          : allBaskets;
    for (let index = 0; index < candidates.length; index += IMAGE_CONCURRENCY) {
        const batch = candidates.slice(index, index + IMAGE_CONCURRENCY);
        const matches = await Promise.all(
            batch.map(async (basket) => {
                const baseUrl = imageBaseUrl(nmId, basket);
                return (await probe(`${baseUrl}/${size}/1.webp`, timeout)) ? { basket, baseUrl } : null;
            })
        );
        const match = matches.find(Boolean);
        if (match) {
            return match;
        }
    }
    return null;
};

export const summarizeProduct = (nmId, response) => {
    const product = Array.isArray(response?.data?.body?.products) ? response.data.body.products[0] : undefined;
    if (!product || typeof product !== 'object') {
        return {
            nmId,
            ok: false,
            status: response?.data?.status,
            error: response?.error || 'WB response did not contain a product',
        };
    }

    const sizes = Array.isArray(product.sizes) ? product.sizes : [];
    const warehouseNames =
        response?.warehouseNames && typeof response.warehouseNames === 'object' && !Array.isArray(response.warehouseNames)
            ? response.warehouseNames
            : {};
    const byWarehouseMap = new Map();
    const bySize = [];
    let quantityTotal = 0;
    for (const size of sizes) {
        const stocks = Array.isArray(size?.stocks) ? size.stocks : [];
        const warehouses = new Set();
        let sizeQuantity = 0;
        for (const stock of stocks) {
            const wh = numberOrUndefined(stock?.wh);
            if (wh === undefined) continue;
            const qty = numberOrUndefined(stock?.qty) || 0;
            quantityTotal += qty;
            sizeQuantity += qty;
            warehouses.add(wh);
            const current = byWarehouseMap.get(wh) || { wh, qty: 0, rows: 0 };
            const warehouseName = typeof warehouseNames[String(wh)] === 'string' ? warehouseNames[String(wh)].trim() : '';
            if (warehouseName && !current.warehouse) {
                current.warehouse = warehouseName;
            }
            current.qty += qty;
            current.rows += 1;
            byWarehouseMap.set(wh, current);
        }
        bySize.push({
            size: typeof size?.origName === 'string' ? size.origName : typeof size?.name === 'string' ? size.name : '',
            qty: sizeQuantity,
            warehouses: warehouses.size,
        });
    }
    const price = sizes.find((size) => size?.price)?.price || product.price;

    return {
        nmId: positiveSafeIntegerOrUndefined(product.id) ?? nmId,
        ok: true,
        name: typeof product.name === 'string' ? product.name : undefined,
        brand: typeof product.brand === 'string' ? product.brand : undefined,
        supplier: typeof product.supplier === 'string' ? product.supplier : undefined,
        supplierId: numberOrUndefined(product.supplierId),
        rating: numberOrUndefined(product.reviewRating),
        feedbacks: numberOrUndefined(product.feedbacks),
        pics: numberOrUndefined(product.pics),
        priceRub: {
            basic: toRub(price?.basic),
            product: toRub(price?.product),
            logistics: toRub(price?.logistics),
            return: toRub(price?.return),
            cashback: toRub(price?.cashback),
        },
        quantity: {
            total: quantityTotal,
            byWarehouse: [...byWarehouseMap.values()],
            bySize,
        },
        status: response?.data?.status,
    };
};

export const runWithConcurrency = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
};
