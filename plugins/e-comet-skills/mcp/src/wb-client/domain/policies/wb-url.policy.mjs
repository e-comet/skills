import { MAX_BROWSER_JOB_URL_LENGTH } from '../../../transport/mcp/limits.mjs';
const ALLOWED_WB_HOSTS = new Set(['wildberries.ru', 'www.wildberries.ru']);
const ALLOWED_WB_PATH = /^\/__internal\/(card|search|recom|recommendations)\//;
const WB_CARD_HOST = /^basket-\d+\.wbbasket\.ru$/;
const WB_CARD_PATH = /^\/vol(?<vol>\d+)\/part(?<part>\d+)\/(?<nm>\d+)\/info\/[a-z]{2}\/card\.json$/;
const isAllowedWbCardUrl = (url) => {
    if (!WB_CARD_HOST.test(url.hostname) || url.search || url.hash)
        return false;
    const match = WB_CARD_PATH.exec(url.pathname);
    if (!match?.groups)
        return false;
    const nm = Number(match.groups.nm);
    return (Number.isSafeInteger(nm) &&
        nm > 0 &&
        Number(match.groups.vol) === Math.floor(nm / 100000) &&
        Number(match.groups.part) === Math.floor(nm / 1000));
};
export const isAllowedWbUrl = (value) => {
    try {
        // Длина проверяется на собранном URL: ограничения на отдельные строки
        // дескриптора не связывают их количество.
        if (typeof value !== 'string' || value.length > MAX_BROWSER_JOB_URL_LENGTH)
            return false;
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
            return false;
        if (url.pathname.includes('%'))
            return false;
        return (ALLOWED_WB_HOSTS.has(hostname) && ALLOWED_WB_PATH.test(url.pathname)) || isAllowedWbCardUrl(url);
    }
    catch {
        return false;
    }
};
