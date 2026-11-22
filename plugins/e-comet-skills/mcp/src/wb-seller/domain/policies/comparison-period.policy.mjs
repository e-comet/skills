import { MAX_COMPARISON_PERIOD_DAYS, MILLISECONDS_PER_DAY, } from '../../../transport/extension/wire.mjs';
const BUTTON_DAYS = { today: 1, week: 7, month: 30, quarter: MAX_COMPARISON_PERIOD_DAYS };
const shiftDate = (date, days) => new Date(Date.parse(date) + days * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
const presetDates = (period, dateTo) => ({
    dateFrom: shiftDate(dateTo, 1 - BUTTON_DAYS[period]),
    dateTo,
});
export const comparisonPeriodWindow = (localToday) => presetDates('quarter', localToday);
export const sameComparisonDates = (left, right) => left.dateFrom === right.dateFrom && left.dateTo === right.dateTo;
const calendarMonthStart = (localToday) => {
    // The browser already supplied the seller's local day. Reproduce WB's setMonth overflow on that calendar.
    const date = new Date(localToday + 'T00:00:00.000Z');
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.toISOString().slice(0, 10);
};
export const resolveComparisonPeriod = (period, { localToday, mode }) => {
    if (typeof period !== 'string') {
        const window = comparisonPeriodWindow(localToday);
        if (period.dateFrom < window.dateFrom || period.dateTo > window.dateTo)
            return { reason: 'period_out_of_range' };
        if (mode === 'calendar' ||
            (period.dateTo === localToday && Object.values(BUTTON_DAYS).some((days) => period.dateFrom === shiftDate(localToday, 1 - days)))) {
            return { dates: period };
        }
        return { reason: mode === 'buttons' ? 'period_unavailable' : 'access_unknown' };
    }
    const dates = presetDates(period, localToday);
    if (period !== 'month' || mode === 'buttons')
        return { dates };
    const calendarStart = calendarMonthStart(localToday);
    if (mode === 'calendar')
        return { dates: { dateFrom: calendarStart, dateTo: localToday } };
    return dates.dateFrom === calendarStart ? { dates } : { reason: 'access_unknown' };
};
