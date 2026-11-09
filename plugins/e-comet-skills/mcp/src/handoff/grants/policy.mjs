import { HandoffError } from '../hook-io.mjs';
// The one-use grant parameters of each flow (spec §7.3). The MCP side of feedback only refuses a submitted grant with
// no time left (feedback-tools, support context); the update check holds no grant.
export const GRANT_POLICIES = {
    // Many grants per session, one per browser_job; a grant lives 90 s from staging; a consumption marker is never
    // reclaimed on age: it goes with its grant.
    BROWSER_JOB: { lifetimeMs: 90_000, clockSkewMs: 5_000, staleMarkerMs: undefined },
    // One grant per session. WHY: the grant must survive ordinary Post->Pre scheduling (5 s) and the start of the PUT
    // (30 s); its expiry is not coupled to the uploader's longer wall deadline for completing an already-started
    // request. A claim marker older than any hook run is reclaimed after 60 s.
    FEEDBACK: { minStageRemainingMs: 35_000, minClaimRemainingMs: 30_000, staleMarkerMs: 60_000 },
};
const { lifetimeMs: HANDOFF_TTL_MS, clockSkewMs: CLOCK_SKEW_MS } = GRANT_POLICIES.BROWSER_JOB;
// The local tool each signed browser_job type authorizes; the browser-job flow moves as it is (spec §7.2).
export const LOCAL_TOOL_BY_BROWSER_JOB_TYPE = {
    product_card: 'wb_product_card',
    search_by_query: 'wb_search_by_query',
    check_by_query: 'wb_check_by_query',
    filters_by_query: 'wb_filters_by_query',
    recommendations_by_product: 'wb_recommendations_by_product',
    seller_reviews: 'wb_seller_reviews',
    ozon_seller_promotion_report: 'ozon_seller_promotion_report',
    ozon_seller_promotion_reports: 'ozon_seller_promotion_reports',
    ozon_seller_analytics_report: 'ozon_seller_analytics_report',
    ozon_search_positions: 'ozon_search_positions',
};
export const SIGNED_LOCAL_TOOLS = new Set(Object.values(LOCAL_TOOL_BY_BROWSER_JOB_TYPE));
export const validateTargetTool = (targetTool) => {
    if (typeof targetTool !== 'string' || !SIGNED_LOCAL_TOOLS.has(targetTool)) {
        throw new HandoffError('HANDOFF_INVALID_TOOL', 'The browser authorization target is invalid.');
    }
    return targetTool;
};
export const isEntryFresh = (entry, nowMs) => entry.createdAtMs <= nowMs + CLOCK_SKEW_MS && nowMs - entry.createdAtMs <= HANDOFF_TTL_MS;
