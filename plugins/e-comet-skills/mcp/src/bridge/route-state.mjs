import { extensionLogCheck } from './profile/extension-log.mjs';
import { diagnosticCheck } from '../transport/diagnostics/vocabulary.mjs';
const iso = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 8.64e15)
        return undefined;
    try {
        return new Date(value).toISOString();
    }
    catch {
        return undefined;
    }
};
// `raw` is the session runtime's status record with the time of this observation.
export const deriveBridgeDiagnostics = (raw) => {
    let state;
    // This snapshot has no task intent; recovery belongs to the selected typed operation.
    if (raw.code === 'connecting' && !raw.extensionConnected)
        state = 'initializing';
    else if (raw.extensionConnected && !raw.browserJobSupported)
        state = 'extension_update_required';
    else if (raw.extensionConnected && raw.browserContext?.state !== 'known')
        state = 'extension_context_unknown';
    else if (raw.extensionConnected && !raw.browserContext?.wbTabConnected && !raw.browserContext?.sellerTabConnected)
        state = 'extension_connected_no_wb_tab';
    else if (raw.extensionConnected)
        state = 'ready';
    else
        state = 'waiting_for_extension';
    const lastConnectedAt = iso(raw.extensionLastConnectedAtMs);
    const lastDisconnectedAt = iso(raw.extensionLastDisconnectedAtMs);
    const observedAt = raw.observedAt ?? new Date().toISOString();
    return {
        state,
        extension: {
            state: raw.extensionConnected ? 'connected' : raw.extensionLastConnectedAtMs ? 'disconnected' : 'never_connected',
            route: raw.extensionConnected ? 'direct' : 'none',
            ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
            ...(lastDisconnectedAt === undefined ? {} : { lastDisconnectedAt }),
            ...(raw.extensionVersion ? { version: raw.extensionVersion } : {}),
            // Справочное поле: типизированный инструмент Ozon по-прежнему решает сам, а отсутствие
            // поля означает «наблюдать было не по чему», а не «не поддерживается».
            ...(typeof raw.ozonSellerPromotionReportSupported === 'boolean'
                ? { ozonSellerPromotionReportSupported: raw.ozonSellerPromotionReportSupported }
                : {}),
            ...(typeof raw.ozonSellerPromotionReportsSupported === 'boolean'
                ? { ozonSellerPromotionReportsSupported: raw.ozonSellerPromotionReportsSupported }
                : {}),
            ...(typeof raw.ozonSellerAnalyticsReportSupported === 'boolean'
                ? { ozonSellerAnalyticsReportSupported: raw.ozonSellerAnalyticsReportSupported }
                : {}),
            ...(typeof raw.ozonSearchPositionsSupported === 'boolean'
                ? { ozonSearchPositionsSupported: raw.ozonSearchPositionsSupported }
                : {}),
        },
        browserContext: raw.browserContext ?? { state: 'unknown' },
        diagnostics: {
            snapshot: diagnosticCheck({
                check: 'snapshot',
                state: 'passed',
                observedAt,
                source: 'local_bridge_status',
                executionPlane: 'device',
            }),
            routeFreshness: diagnosticCheck({
                check: 'route_freshness',
                state: Number.isFinite(raw.routeLastObservedAtMs) ? 'passed' : 'unknown',
                observedAt,
                source: 'extension_heartbeat',
                executionPlane: 'device',
                ...(Number.isFinite(raw.routeLastObservedAtMs)
                    ? { facts: { lastObservedAt: iso(raw.routeLastObservedAtMs) } }
                    : { cause: 'unknown', nextCheck: 'observe_extension_heartbeat' }),
            }),
            // Kept from the last tool call that found no broker; its ages count to this observation.
            ...(raw.extensionLog
                ? { extensionLog: extensionLogCheck(raw.extensionLog, { observedAt, nowMs: Date.parse(observedAt) }) }
                : {}),
        },
    };
};
