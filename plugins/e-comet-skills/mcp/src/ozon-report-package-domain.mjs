import { parseOzonPromotionPeriod } from './ozon-promotion-domain.mjs';

export const MAX_OZON_REPORT_PACKAGE_ITEMS = 50;

const exactObject = (value, keys, message) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(message);
    const actual = Object.keys(value);
    if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) throw new TypeError(message);
    return value;
};

export const parseReportPackageItems = (items, { keys, parse, identity, label }) => {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_OZON_REPORT_PACKAGE_ITEMS) {
        throw new TypeError(`${label} must contain 1-${MAX_OZON_REPORT_PACKAGE_ITEMS} items.`);
    }
    const identities = new Set();
    return items.map((item) => {
        const exact = exactObject(item, keys, `${label} item has invalid fields.`);
        const parsed = parse(exact);
        const key = identity(exact);
        if (identities.has(key)) throw new TypeError(`${label} must not contain exact duplicates.`);
        identities.add(key);
        return parsed;
    });
};

export const parsePromotionPeriods = (periods) =>
    parseReportPackageItems(periods, {
        keys: ['dateFrom', 'dateTo'],
        parse: ({ dateFrom, dateTo }) => parseOzonPromotionPeriod(dateFrom, dateTo),
        identity: ({ dateFrom, dateTo }) => `${dateFrom}\0${dateTo}`,
        label: 'Ozon promotion package',
    });
