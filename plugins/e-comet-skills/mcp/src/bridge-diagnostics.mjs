const iso = (value) => {
    if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return undefined;
    try {
        return new Date(value).toISOString();
    } catch {
        return undefined;
    }
};

// Порог конкуренции за сокет. Два экземпляра расширения перехватывают его примерно раз в
// секунду, поэтому реальная конкуренция проходит порог мгновенно, а одиночный повторный
// connect (перезапуск service worker'а, чей прежний сокет ещё не отреагировал) — нет.
export const EXTENSION_CONTENTION_MIN_TAKEOVERS = 3;

export const deriveBridgeDiagnostics = (raw) => {
    const routeAvailable = raw.bridgeRole === 'primary' || raw.bridgeRole === 'secondary';
    const noRoute = !routeAvailable;
    const rejection = raw.peerRejection?.code;
    let state;
    // This snapshot has no task intent; recovery belongs to the selected typed operation.
    if (raw.listenerState === 'pending' && noRoute) state = 'initializing';
    else if (noRoute && (raw.listenerState === 'failed' || rejection === 'listen_failed')) state = 'listen_failed';
    else if (noRoute && ['token_permission_denied', 'token_unavailable'].includes(rejection)) state = 'peer_unavailable';
    else if (noRoute && ['protocol_mismatch', 'authentication_failed', 'handshake_required'].includes(rejection)) state = 'peer_reconnecting';
    else if (noRoute && (rejection === 'connection_failed' || raw.listenerState === 'address_in_use')) state = 'peer_reconnecting';
    else if (raw.bridgeTransitioning) state = 'waiting_for_extension';
    else if (raw.extensionConnected && !raw.browserJobSupported) state = 'extension_update_required';
    // Выше обеих следующих веток намеренно. Перехват сокета сбрасывает `browserContext` в
    // `unknown`, поэтому без этой проверки конкуренция диагностируется как «неизвестный
    // контекст» или «нет вкладки ВБ», и пользователю советуют открыть вкладку, которая
    // у него уже открыта. Именно этот совет увёл предыдущее обращение в переустановки.
    else if (raw.extensionConnected && (raw.extensionTakeovers?.count ?? 0) >= EXTENSION_CONTENTION_MIN_TAKEOVERS)
        state = 'extension_contended';
    else if (raw.extensionConnected && raw.browserContext?.state !== 'known') {
        const legacyPeer = raw.bridgeRole === 'secondary' && raw.peer?.browserContextPropagationSupported !== true;
        state = legacyPeer ? 'peer_context_unknown' : 'extension_context_unknown';
    } else if (raw.extensionConnected && !raw.browserContext.wbTabConnected && !raw.browserContext.sellerTabConnected) state = 'extension_connected_no_wb_tab';
    else if (raw.extensionConnected) state = 'ready';
    else state = 'waiting_for_extension';

    const lastConnectedAt = iso(raw.extensionLastConnectedAtMs);
    const lastDisconnectedAt = iso(raw.extensionLastDisconnectedAtMs);
    return {
        state,
        extension: {
            state: raw.extensionConnected ? 'connected' : raw.extensionLastConnectedAtMs ? 'disconnected' : 'never_connected',
            route: raw.extensionConnected ? (raw.bridgeRole === 'secondary' ? 'peer' : 'direct') : 'none',
            ...(lastConnectedAt === undefined ? {} : { lastConnectedAt }),
            ...(lastDisconnectedAt === undefined ? {} : { lastDisconnectedAt }),
            ...(raw.extensionVersion ? { version: raw.extensionVersion } : {}),
            // Справочное поле: типизированный инструмент Ozon по-прежнему решает сам, а отсутствие
            // поля означает «наблюдать было не по чему», а не «не поддерживается».
            ...(typeof raw.ozonSellerPromotionReportSupported === 'boolean'
                ? { ozonSellerPromotionReportSupported: raw.ozonSellerPromotionReportSupported }
                : {}),
            ...(typeof raw.ozonSellerPromotionReportsSupported === 'boolean'
                ? { ozonSellerPromotionReportsSupported: raw.ozonSellerPromotionReportsSupported } : {}),
            ...(typeof raw.ozonSellerAnalyticsReportSupported === 'boolean'
                ? { ozonSellerAnalyticsReportSupported: raw.ozonSellerAnalyticsReportSupported } : {}),
        },
        ...(raw.peer ? { peer: raw.peer } : {}),
        browserContext: raw.browserContext ?? { state: 'unknown' },
    };
};
