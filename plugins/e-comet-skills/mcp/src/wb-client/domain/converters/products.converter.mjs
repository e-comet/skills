import { fieldOf, isPositiveSafeInteger, isUnknownArray } from '../../../shared/values.mjs';
import { wbData } from '../policies/response.policy.mjs';
// Parse boundary: WB answers and their products are read field by field.
export const responseProducts = (response) => {
    const products = fieldOf(wbData(response, 'body'), 'products');
    return isUnknownArray(products) ? products : [];
};
export const numberOrUndefined = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
export const textOrUndefined = (value) => (typeof value === 'string' ? value : undefined);
const positiveSafeIntegerOrUndefined = (value) => (isPositiveSafeInteger(value) ? value : undefined);
const toRub = (value) => {
    const amount = numberOrUndefined(value);
    return amount === undefined ? undefined : Math.round(amount) / 100;
};
const listOrEmpty = (value) => (isUnknownArray(value) ? value : []);
// The price of the first size that has one, else the product's own.
const productPrice = (product, sizes) => fieldOf(sizes.find((size) => fieldOf(size, 'price')), 'price') || fieldOf(product, 'price');
const summarizeListingProduct = (product, position, globalPosition) => {
    const nmId = positiveSafeIntegerOrUndefined(fieldOf(product, 'id'));
    if (nmId === undefined)
        return undefined;
    const price = productPrice(product, listOrEmpty(fieldOf(product, 'sizes')));
    const row = {
        nmId,
        name: textOrUndefined(fieldOf(product, 'name')),
        brand: textOrUndefined(fieldOf(product, 'brand')),
        supplierId: numberOrUndefined(fieldOf(product, 'supplierId')),
        priceRub: price ? { basic: toRub(fieldOf(price, 'basic')), product: toRub(fieldOf(price, 'product')) } : undefined,
        rating: numberOrUndefined(fieldOf(product, 'reviewRating')),
        feedbacks: numberOrUndefined(fieldOf(product, 'feedbacks')),
        pics: numberOrUndefined(fieldOf(product, 'pics')),
        promoted: isPromotedViewFlags(fieldOf(product, 'viewFlags')),
        position,
    };
    if (globalPosition !== undefined && Number.isSafeInteger(globalPosition) && globalPosition > 0) {
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
        .map((product, index) => summarizeListingProduct(product, index + 1, includeGlobalPosition ? globalOffset + index + 1 : undefined))
        .filter((row) => Boolean(row));
    const selected = (filter ? rows.filter((row) => filter.has(row.nmId)) : rows).slice(0, remainingLimit);
    return selected;
};
export const summarizeProduct = (nmId, response) => {
    const product = responseProducts(response)[0];
    if (!product || typeof product !== 'object') {
        return {
            nmId,
            ok: false,
            status: wbData(response, 'status'),
            error: fieldOf(response, 'error') || 'WB response did not contain a product',
        };
    }
    const sizes = listOrEmpty(fieldOf(product, 'sizes'));
    const warehouseNames = fieldOf(response, 'warehouseNames');
    const byWarehouseMap = new Map();
    const bySize = [];
    let quantityTotal = 0;
    for (const size of sizes) {
        const stocks = listOrEmpty(fieldOf(size, 'stocks'));
        const warehouses = new Set();
        let sizeQuantity = 0;
        for (const stock of stocks) {
            const wh = numberOrUndefined(fieldOf(stock, 'wh'));
            if (wh === undefined)
                continue;
            const qty = numberOrUndefined(fieldOf(stock, 'qty')) || 0;
            quantityTotal += qty;
            sizeQuantity += qty;
            warehouses.add(wh);
            const current = byWarehouseMap.get(wh) || { wh, qty: 0, rows: 0 };
            const warehouseName = textOrUndefined(fieldOf(warehouseNames, String(wh)))?.trim() ?? '';
            if (warehouseName && !current.warehouse) {
                current.warehouse = warehouseName;
            }
            current.qty += qty;
            current.rows += 1;
            byWarehouseMap.set(wh, current);
        }
        bySize.push({
            size: textOrUndefined(fieldOf(size, 'origName')) ?? textOrUndefined(fieldOf(size, 'name')) ?? '',
            qty: sizeQuantity,
            warehouses: warehouses.size,
        });
    }
    const price = productPrice(product, sizes);
    return {
        nmId: positiveSafeIntegerOrUndefined(fieldOf(product, 'id')) ?? nmId,
        ok: true,
        name: textOrUndefined(fieldOf(product, 'name')),
        brand: textOrUndefined(fieldOf(product, 'brand')),
        supplier: textOrUndefined(fieldOf(product, 'supplier')),
        supplierId: numberOrUndefined(fieldOf(product, 'supplierId')),
        rating: numberOrUndefined(fieldOf(product, 'reviewRating')),
        feedbacks: numberOrUndefined(fieldOf(product, 'feedbacks')),
        pics: numberOrUndefined(fieldOf(product, 'pics')),
        priceRub: {
            basic: toRub(fieldOf(price, 'basic')),
            product: toRub(fieldOf(price, 'product')),
            logistics: toRub(fieldOf(price, 'logistics')),
            return: toRub(fieldOf(price, 'return')),
            cashback: toRub(fieldOf(price, 'cashback')),
        },
        quantity: {
            total: quantityTotal,
            byWarehouse: [...byWarehouseMap.values()],
            bySize,
        },
        status: wbData(response, 'status'),
    };
};
