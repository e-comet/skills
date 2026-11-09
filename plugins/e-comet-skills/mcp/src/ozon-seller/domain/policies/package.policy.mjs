import { MAX_OZON_REPORT_PACKAGE_ITEMS } from '../constants/limits.const.mjs';
import { parseOzonPromotionPeriod } from './promotion.policy.mjs';
import { hasExactOwnKeys, isRecord } from '../../../shared/values.mjs';
// Parse boundary: an item as the caller or the signed job gave it.
const exactObject = (value, keys, message) => {
    if (!isRecord(value) || !hasExactOwnKeys(value, keys))
        throw new TypeError(message);
    return value;
};
// Parse boundary: the items as the caller or the signed job gave them.
export const parseReportPackageItems = (items, { keys, parse, identity, label, }) => {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_OZON_REPORT_PACKAGE_ITEMS) {
        throw new TypeError(`${label} must contain 1-${MAX_OZON_REPORT_PACKAGE_ITEMS} items.`);
    }
    const identities = new Set();
    return items.map((item) => {
        const exact = exactObject(item, keys, `${label} item has invalid fields.`);
        const parsed = parse(exact);
        const key = identity(exact);
        if (identities.has(key))
            throw new TypeError(`${label} must not contain exact duplicates.`);
        identities.add(key);
        return parsed;
    });
};
// Parse boundary: the periods as the caller or the signed job gave them.
export const parsePromotionPeriods = (periods) => parseReportPackageItems(periods, {
    keys: ['dateFrom', 'dateTo'],
    parse: ({ dateFrom, dateTo }) => parseOzonPromotionPeriod(dateFrom, dateTo),
    identity: ({ dateFrom, dateTo }) => `${dateFrom}\0${dateTo}`,
    label: 'Ozon promotion package',
});
