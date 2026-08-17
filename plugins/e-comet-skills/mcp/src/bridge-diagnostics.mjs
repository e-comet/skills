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

export const deriveBridgeDiagnostics = (raw, nowMs) => {
    const routeAvailable = raw.bridgeRole === 'primary' || raw.bridgeRole === 'secondary';
    const noRoute = !routeAvailable;
    const rejection = raw.peerRejection?.code;
    let state;
    let recommendedAction;
    if (raw.listenerState === 'pending' && noRoute) [state, recommendedAction] = ['initializing', 'WAIT_FOR_EXTENSION'];
    else if (noRoute && (raw.listenerState === 'failed' || rejection === 'listen_failed')) [state, recommendedAction] = ['listen_failed', 'RESTART_DESKTOP_HOSTS'];
    else if (noRoute && rejection === 'token_permission_denied') [state, recommendedAction] = ['peer_unavailable', 'FIX_PEER_TOKEN_PERMISSIONS'];
    else if (noRoute && rejection === 'token_unavailable') [state, recommendedAction] = ['peer_unavailable', 'USE_PRIMARY_AGENT'];
    else if (noRoute && ['protocol_mismatch', 'authentication_failed', 'handshake_required'].includes(rejection)) [state, recommendedAction] = ['peer_reconnecting', 'RESTART_DESKTOP_HOSTS'];
    else if (noRoute && (rejection === 'connection_failed' || raw.listenerState === 'address_in_use')) [state, recommendedAction] = ['peer_reconnecting', 'WAIT_FOR_EXTENSION'];
    else if (raw.bridgeTransitioning) [state, recommendedAction] = ['waiting_for_extension', 'WAIT_FOR_EXTENSION'];
    else if (raw.extensionConnected && !raw.browserJobSupported) [state, recommendedAction] = ['extension_update_required', 'UPDATE_EXTENSION'];
    // Выше обеих следующих веток намеренно. Перехват сокета сбрасывает `browserContext` в
    // `unknown`, поэтому без этой проверки конкуренция диагностируется как «неизвестный
    // контекст» или «нет вкладки ВБ», и пользователю советуют открыть вкладку, которая
    // у него уже открыта. Именно этот совет увёл предыдущее обращение в переустановки.
    else if (raw.extensionConnected && (raw.extensionTakeovers?.count ?? 0) >= EXTENSION_CONTENTION_MIN_TAKEOVERS)
        [state, recommendedAction] = ['extension_contended', 'CLOSE_DUPLICATE_EXTENSIONS'];
    else if (raw.extensionConnected && raw.browserContext?.state !== 'known') {
        const legacyPeer = raw.bridgeRole === 'secondary' && raw.peer?.browserContextPropagationSupported !== true;
        [state, recommendedAction] = legacyPeer ? ['peer_context_unknown', 'RESTART_DESKTOP_HOSTS'] : ['extension_context_unknown', 'UPDATE_EXTENSION'];
    } else if (raw.extensionConnected && !raw.browserContext.wbTabConnected && !raw.browserContext.sellerTabConnected) [state, recommendedAction] = ['extension_connected_no_wb_tab', 'OPEN_AUTHENTICATED_WB'];
    else if (raw.extensionConnected) [state, recommendedAction] = ['ready', 'NONE'];
    else if (raw.extensionLastDisconnectedAtMs && nowMs - raw.extensionLastDisconnectedAtMs <= 5000) [state, recommendedAction] = ['waiting_for_extension', 'WAIT_FOR_EXTENSION'];
    else [state, recommendedAction] = ['waiting_for_extension', 'OPEN_OR_REFRESH_WB'];

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
        },
        ...(raw.peer ? { peer: raw.peer } : {}),
        browserContext: raw.browserContext ?? { state: 'unknown' },
        recommendedAction,
    };
};
