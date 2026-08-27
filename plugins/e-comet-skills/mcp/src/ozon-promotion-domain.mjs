const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_OZON_PROMOTION_INCLUSIVE_DAYS = 89;

const parseCanonicalDate = (value) => {
    if (typeof value !== 'string' || !CANONICAL_DATE.test(value)) return NaN;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
};

export const parseOzonPromotionPeriod = (dateFrom, dateTo) => {
    const fromMs = parseCanonicalDate(dateFrom);
    const toMs = parseCanonicalDate(dateTo);
    const inclusiveDays = (toMs - fromMs) / UTC_DAY_MS + 1;
    if (
        !Number.isFinite(fromMs) ||
        !Number.isFinite(toMs) ||
        toMs < fromMs ||
        !Number.isSafeInteger(inclusiveDays) ||
        inclusiveDays > MAX_OZON_PROMOTION_INCLUSIVE_DAYS
    ) {
        throw new TypeError(`Ozon promotion period must contain at most ${MAX_OZON_PROMOTION_INCLUSIVE_DAYS} inclusive days in canonical YYYY-MM-DD form.`);
    }
    return { dateFrom, dateTo, inclusiveDays };
};

export const assertOzonPromotionPeriodEqual = (expected, actual) => {
    const expectedPeriod = parseOzonPromotionPeriod(expected?.dateFrom, expected?.dateTo);
    const actualPeriod = parseOzonPromotionPeriod(actual?.dateFrom, actual?.dateTo);
    if (expectedPeriod.dateFrom !== actualPeriod.dateFrom || expectedPeriod.dateTo !== actualPeriod.dateTo) {
        throw new TypeError('Authorized Ozon promotion period does not match the requested canonical period.');
    }
    return expectedPeriod;
};

export const ozonPromotionArtifactName = (dateFrom, dateTo) => {
    const period = parseOzonPromotionPeriod(dateFrom, dateTo);
    return `ozon-seller-promotion-${period.dateFrom}-${period.dateTo}.xlsx`;
};
