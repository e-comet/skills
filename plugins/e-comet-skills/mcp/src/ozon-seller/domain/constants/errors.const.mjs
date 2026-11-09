import { OZON_ANALYTICS_CAPABILITY, OZON_PROMOTION_PACKAGE_CAPABILITY, OZON_SEARCH_POSITIONS_CAPABILITY, } from '../../../transport/extension/wire.mjs';
// The fields an outdated-extension refusal may carry; a value naming any other field is not ours.
export const OZON_EXTENSION_OUTDATED_DETAIL_KEYS = [
    'reason',
    'requiredCapability',
    'requiredExtensionVersion',
    'updateUrl',
    'installedExtensionVersion',
];
// The authorization failures that mean the Ozon route did not answer.
export const OZON_AUTHORIZATION_ROUTE_CODES = new Set([
    'EXTENSION_DISCONNECTED',
    'BROWSER_JOB_AUTHORIZATION_TIMEOUT',
    'EXTENSION_UPDATE_REQUIRED',
]);
export const OZON_LEASE_DEFECT = 'This is an e-Comet defect: offer to report it; do not request another authorization.';
// Package capability floor, also enforced by scripts/extension_gate.py for publication.
// The released singular @1 tool intentionally retains its independent 1.5.6 floor.
const OZON_PACKAGE_MIN_EXTENSION_VERSION = '1.5.7';
export const OZON_PACKAGE_FAMILIES = {
    promotion: {
        name: 'Ozon promotion report package',
        minVersion: OZON_PACKAGE_MIN_EXTENSION_VERSION,
        supportField: 'ozonSellerPromotionReportsSupported',
        capability: OZON_PROMOTION_PACKAGE_CAPABILITY,
        code: 'OZON_ROUTE_NOT_READY',
        stage: 'route',
    },
    analytics: {
        name: 'Ozon analytics report package',
        minVersion: OZON_PACKAGE_MIN_EXTENSION_VERSION,
        supportField: 'ozonSellerAnalyticsReportSupported',
        capability: OZON_ANALYTICS_CAPABILITY,
        code: 'OZON_ANALYTICS_CAPABILITY_UNAVAILABLE',
        stage: 'context',
    },
    // The first extension release announcing this capability is not served yet: its version is set here at release.
    positions: {
        name: 'Ozon search positions operation',
        minVersion: '1.5.13',
        supportField: 'ozonSearchPositionsSupported',
        capability: OZON_SEARCH_POSITIONS_CAPABILITY,
        code: 'OZON_SEARCH_POSITIONS_CAPABILITY_UNAVAILABLE',
        stage: 'context',
    },
};
