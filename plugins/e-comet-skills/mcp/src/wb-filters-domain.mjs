import { MAX_FILTER_KEY_LENGTH, MAX_FILTER_KEYS_PER_REQUEST } from './config.mjs';
import { isSuccessfulWbResponse, numberOrUndefined } from './wb-domain.mjs';

// WB search filters (resultset=filters): body {metadata, data: {filters, total}}. Only card characteristics (f<digits>)
// and categories (xsubject) are returned to the agent; the raw responses stay in the result file.

const CHARACTERISTIC_KEY = /^f\d+$/;
// The extension admits the same shape in a full-list request (signed-url-allowance.ts).
const FULL_LIST_KEY = new RegExp(`^ff[0-9a-z]{1,${MAX_FILTER_KEY_LENGTH - 2}}$`);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * genuine: the filters WB showed for the phrase; decoy: a plausible body without metadata.search_result, which WB sends
 * instead of real data under suspicion (observed 2026-10-25); failed: anything else.
 */
export const readFiltersResponse = (response) => {
    const body = response?.data?.body;
    if (!isSuccessfulWbResponse(response) || !isRecord(body) || !isRecord(body.metadata)) return { state: 'failed' };
    if (!Object.hasOwn(body.metadata, 'search_result')) return { state: 'decoy' };
    if (!isRecord(body.data) || !Array.isArray(body.data.filters)) return { state: 'failed' };
    return { state: 'genuine', filters: body.data.filters.filter(isRecord), total: numberOrUndefined(body.data.total) };
};

const filterKind = (key) => (CHARACTERISTIC_KEY.test(key) ? 'characteristic' : key === 'xsubject' ? 'category' : undefined);
const valueNames = (filter) =>
    Array.isArray(filter.items) ? filter.items.flatMap((item) => (typeof item?.name === 'string' && item.name ? [item.name] : [])) : [];

/** The characteristic and category filters of one response, in WB's order. */
export const keptFilters = (filters) =>
    filters.flatMap((filter) => {
        const kind = typeof filter.key === 'string' ? filterKind(filter.key) : undefined;
        if (!kind) return [];
        return [{
            kind,
            name: typeof filter.name === 'string' && filter.name ? filter.name : filter.key,
            key: filter.key,
            isTop: filter.isTop === true,
            fullKey: typeof filter.fullKey === 'string' ? filter.fullKey : undefined,
            values: valueNames(filter),
        }];
    });

/**
 * The distinct fullKey values of the kept filters WB truncated, as one full-list request may name them. The extension refuses
 * a repeated key as an unsigned URL, which would stop the whole job.
 */
export const fullListKeys = (kept) =>
    [...new Set(kept.filter((filter) => filter.isTop && FULL_LIST_KEY.test(filter.fullKey ?? '')).map((filter) => filter.fullKey))]
        .slice(0, MAX_FILTER_KEYS_PER_REQUEST);

/**
 * The kept filters with each truncated list replaced by its full list. `fullFilters` is the full-list response's filters, or
 * undefined when that request was not made or failed; a truncated filter it does not expand keeps its first values and
 * counts in `missing`.
 */
export const completeFilters = (kept, fullFilters) => {
    let missing = 0;
    const filters = kept.map(({ kind, name, key, isTop, values }) => {
        if (!isTop) return { kind, name, key, complete: true, values };
        const full = fullFilters?.find((candidate) => candidate.key === key && candidate.isTop !== true);
        const fullValues = full ? valueNames(full) : [];
        // A full list without names would replace real values with nothing; keep the first values instead.
        if (fullValues.length === 0) {
            missing += 1;
            return { kind, name, key, complete: false, values };
        }
        return { kind, name, key, complete: true, values: fullValues };
    });
    return { filters, missing };
};

/** One entry per filter key across phrases: first-seen order, union of values, complete only if every phrase's list was. */
export const mergeFilters = (phraseFilters) => {
    const merged = new Map();
    for (const filters of phraseFilters) {
        for (const filter of filters) {
            const current = merged.get(filter.key);
            if (!current) {
                merged.set(filter.key, { ...filter, values: [...filter.values], queryCount: 1 });
                continue;
            }
            const known = new Set(current.values);
            current.values.push(...filter.values.filter((value) => !known.has(value) && known.add(value)));
            current.complete = current.complete && filter.complete;
            current.queryCount += 1;
        }
    }
    return [...merged.values()];
};
