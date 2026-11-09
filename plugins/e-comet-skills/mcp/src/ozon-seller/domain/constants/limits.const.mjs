export const MAX_OZON_REPORT_PACKAGE_ITEMS = 50;
export const OZON_PACKAGE_STOP_REASONS = [
    'authorization_unavailable',
    'capability_unavailable',
    'seller_context_unavailable',
    'capacity_unavailable',
    'deadline_exceeded',
    'rate_limited',
    'cancelled',
    'artifact_unavailable',
    'systemic_failure_breaker',
    'execution_interrupted',
];
// Positions add their two preflight stops; kept here, beside the shared list, so the schema needs no job module.
export const OZON_SEARCH_POSITIONS_STOP_REASONS = [...OZON_PACKAGE_STOP_REASONS, 'region_unavailable', 'sku_limit_exceeded'];
// Queries are package items, so the shared package cap (50) bounds them as well.
export const MAX_OZON_SEARCH_POSITIONS_SKUS = 10;
export const MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH = 128;
export const OZON_SEARCH_POSITIONS_DEFAULT_REGION = 'Москва';
export const OZON_SEARCH_POSITIONS_PLATFORMS = ['ozon', 'select'];
// One Ozon operation's lifecycle: a promotion report, and one item of a package, finishes within it.
export const OZON_PROMOTION_OPERATION_MAX_MS = 8 * 60 * 1000;
