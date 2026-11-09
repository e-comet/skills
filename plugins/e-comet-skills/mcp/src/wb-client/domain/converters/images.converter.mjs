import { IMAGE_BASKET_BOUNDS } from '../constants/limits.const.mjs';
export const basketNumberForVol = (vol) => {
    const index = IMAGE_BASKET_BOUNDS.findIndex((upperBound) => vol <= upperBound);
    return index < 0 ? null : index + 1;
};
// `testOrigin` replaces the WB basket host in tests only; the root passes it.
export const imageBaseUrl = (nmId, basket, testOrigin = undefined) => {
    const origin = testOrigin || `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru`;
    return `${origin}/vol${Math.floor(nmId / 100000)}/part${Math.floor(nmId / 1000)}/${nmId}/images`;
};
