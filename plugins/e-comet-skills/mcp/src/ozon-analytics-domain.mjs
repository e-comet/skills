import { parseReportPackageItems } from './ozon-report-package-domain.mjs';

const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_OZON_ANALYTICS_INCLUSIVE_DAYS = 731;

const parseCanonicalDate = (value) => {
    if (typeof value !== 'string' || !CANONICAL_DATE.test(value)) return NaN;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : NaN;
};

const moscowDateAt = (issuedAtSeconds) => {
    if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds < 0) return undefined;
    const instant = new Date(issuedAtSeconds * 1000);
    if (!Number.isFinite(instant.getTime())) return undefined;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    return Number.isFinite(parseCanonicalDate(date)) ? date : undefined;
};

export const parseAnalyticsDateRange = (dateFrom, dateTo) => {
    const fromMs = parseCanonicalDate(dateFrom);
    const toMs = parseCanonicalDate(dateTo);
    const inclusiveDays = (toMs - fromMs) / UTC_DAY_MS + 1;
    if (
        !Number.isFinite(fromMs) ||
        !Number.isFinite(toMs) ||
        toMs < fromMs ||
        !Number.isSafeInteger(inclusiveDays) ||
        inclusiveDays > MAX_OZON_ANALYTICS_INCLUSIVE_DAYS
    ) throw new TypeError('Ozon analytics dates must be canonical, ordered, and at most 731 inclusive days.');
    return { dateFrom, dateTo, fromMs, toMs, inclusiveDays };
};

export const parseOzonAnalyticsPeriod = (dateFrom, dateTo, issuedAtSeconds) => {
    const { fromMs, toMs, inclusiveDays } = parseAnalyticsDateRange(dateFrom, dateTo);
    const issuedOnMoscow = moscowDateAt(issuedAtSeconds);
    const issuedMs = parseCanonicalDate(issuedOnMoscow);
    const earliestMs = issuedMs - (MAX_OZON_ANALYTICS_INCLUSIVE_DAYS - 1) * UTC_DAY_MS;
    if (
        !Number.isFinite(issuedMs) ||
        fromMs < earliestMs ||
        toMs > issuedMs
    ) {
        throw new TypeError('Ozon analytics period must be canonical, ordered, at most 731 inclusive days, and inside the signed Moscow issuance window.');
    }
    return { dateFrom, dateTo, inclusiveDays, issuedOnMoscow };
};

export const parseOzonAnalyticsBreakdown = (value) => {
    if (value !== 'period' && value !== 'daily') throw new TypeError('Ozon analytics breakdown must be period or daily.');
    return value;
};

export const parseAnalyticsReports = (reports, issuedAtSeconds) =>
    parseReportPackageItems(reports, {
        keys: ['dateFrom', 'dateTo', 'breakdown'],
        parse: ({ dateFrom, dateTo, breakdown }) => ({
            ...parseOzonAnalyticsPeriod(dateFrom, dateTo, issuedAtSeconds),
            breakdown: parseOzonAnalyticsBreakdown(breakdown),
        }),
        identity: ({ dateFrom, dateTo, breakdown }) => `${dateFrom}\0${dateTo}\0${breakdown}`,
        label: 'Ozon analytics reports',
    });

export const assertOzonAnalyticsRequestEqual = (expected, actual, issuedAtSeconds) => {
    const [expectedReport] = parseAnalyticsReports([expected], issuedAtSeconds);
    const [actualReport] = parseAnalyticsReports([actual], issuedAtSeconds);
    if (
        expectedReport.dateFrom !== actualReport.dateFrom ||
        expectedReport.dateTo !== actualReport.dateTo ||
        expectedReport.breakdown !== actualReport.breakdown
    ) {
        throw new TypeError('Authorized Ozon analytics request does not match the requested dates and breakdown.');
    }
    return expectedReport;
};

export const ozonAnalyticsArtifactName = (dateFrom, dateTo, breakdown, issuedAtSeconds) => {
    const period = parseOzonAnalyticsPeriod(dateFrom, dateTo, issuedAtSeconds);
    const parsedBreakdown = parseOzonAnalyticsBreakdown(breakdown);
    return `ozon-seller-analytics-${parsedBreakdown}-${period.dateFrom}-${period.dateTo}.xlsx`;
};
