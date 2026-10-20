import { localMessage, MESSAGE_TYPES } from './extension-vocabulary.mjs';
import { ozonExtensionOutdatedError, ToolExecutionError } from './tool-errors.mjs';
import { sendWs, WS_OPEN } from './websocket.mjs';
import { markOzonPackageNotStarted } from './ozon-report-package-result.mjs';

export const createDiagnosticSnapshotRoute = ({ connections, sendExtension = sendWs }) => ({ requestId }) => {
    if (connections.extensionReady) {
        if (!connections.extensionDiagnosticSnapshotReady) throw new ToolExecutionError('UNSUPPORTED_CAPABILITY', 'The connected extension does not support diagnostic snapshots.', 'extension', false);
        sendExtension(connections.extensionSocket, localMessage(requestId, MESSAGE_TYPES.diagnosticSnapshot, { protocolVersion: 1 }));
        return;
    }
    if (connections.peerReady && connections.peerExtensionDiagnosticSnapshotReady &&
        connections.authenticatedPrimaryMetadata?.diagnosticForwardingSupported === true && connections.peerSocket?.readyState === WS_OPEN) {
        connections.peerSocket.send(JSON.stringify({ type: 'peer_diagnostic_snapshot', requestId, protocolVersion: 1 }));
        return;
    }
    // «Спросить некого» и «спрашивать нечем» — разные наблюдения. Пока подключённого расширения нет
    // ни здесь, ни у первичного процесса, отказ по возможности приписал бы пользователю устаревшую
    // сборку, хотя наблюдается только отсутствие подключения — самый частый бытовой случай.
    if (!(connections.peerReady && connections.peerExtensionReady === true && connections.peerSocket?.readyState === WS_OPEN)) {
        throw new ToolExecutionError('EXTENSION_DISCONNECTED', 'No connected e-Comet extension is reachable for a diagnostic snapshot.', 'extension', false);
    }
    throw new ToolExecutionError('UNSUPPORTED_CAPABILITY', 'Extension diagnostic snapshots are unavailable on this route.', 'extension', false);
};

/**
 * @param {{
 *   connections: {
 *     extensionOzonPromotionReady: boolean,
 *     extensionOzonPromotionPackageReady?: boolean,
 *     extensionOzonAnalyticsReady?: boolean,
 *     extensionOzonSearchPositionsReady?: boolean,
 *     extensionSocket?: unknown,
 *     peerExtensionOzonPromotionReady?: boolean,
 *     peerExtensionOzonPromotionPackageReady?: boolean,
 *     peerExtensionOzonAnalyticsReady?: boolean,
 *     peerExtensionOzonSearchPositionsReady?: boolean,
 *     peerSocket?: {readyState: number, send(message: string): void} | null,
 *     effectiveExtensionVersion?: string,
 *     effectiveOzonPromotionReady?: boolean,
 *     effectiveOzonPromotionSupportKnown?: boolean,
 *     effectiveOzonPromotionPackageReady?: boolean,
 *     effectiveOzonPromotionPackageSupportKnown?: boolean,
 *     effectiveOzonAnalyticsReady?: boolean,
 *     effectiveOzonAnalyticsSupportKnown?: boolean,
 *     effectiveOzonSearchPositionsSupportKnown?: boolean,
 *   },
 *   sendExtension?: (socket: unknown, message: object) => void,
 * }} options
 */
export const createOzonPromotionRoute = ({ connections, sendExtension = sendWs }) => {
    if (!connections) throw new TypeError('Ozon promotion routing requires connection state.');
    return ({ requestId, authorizationId, authorizationScopeId, dateFrom, dateTo, deadlineAt, timeout, family, items }) => {
        const route =
            family === 'promotion'
                ? {
                      directReady: connections.extensionOzonPromotionPackageReady,
                      peerReady: connections.peerExtensionOzonPromotionPackageReady,
                      supportKnown: connections.effectiveOzonPromotionPackageSupportKnown,
                      operationType: MESSAGE_TYPES.ozonPromotionPackageOperation,
                      peerOperationType: 'peer_ozon_promotion_reports_operation',
                      businessPayload: { periods: items },
                      name: 'promotion report packages',
                  }
                : family === 'analytics'
                  ? {
                        directReady: connections.extensionOzonAnalyticsReady,
                        peerReady: connections.peerExtensionOzonAnalyticsReady,
                        supportKnown: connections.effectiveOzonAnalyticsSupportKnown,
                        operationType: MESSAGE_TYPES.ozonAnalyticsOperation,
                        peerOperationType: 'peer_ozon_analytics_report_operation',
                        businessPayload: { reports: items },
                        name: 'analytics report packages',
                    }
                  : family === 'positions'
                    ? {
                          directReady: connections.extensionOzonSearchPositionsReady,
                          peerReady: connections.peerExtensionOzonSearchPositionsReady,
                          supportKnown: connections.effectiveOzonSearchPositionsSupportKnown,
                          operationType: MESSAGE_TYPES.ozonSearchPositionsOperation,
                          peerOperationType: 'peer_ozon_search_positions_operation',
                          businessPayload: { queries: items },
                          name: 'search positions',
                      }
                    : undefined;
        if (route) {
            if (route.directReady) {
                sendExtension(
                    connections.extensionSocket,
                    localMessage(requestId, route.operationType, { authorizationId, ...route.businessPayload, deadlineAt })
                );
                return;
            }
            if (route.peerReady && connections.peerSocket?.readyState === WS_OPEN) {
                connections.peerSocket.send(
                    JSON.stringify({
                        type: route.peerOperationType,
                        requestId,
                        authorizationScopeId,
                        authorizationId,
                        package: { family, items, deadlineAt },
                        timeout,
                    })
                );
                return;
            }
            if (route.supportKnown) {
                throw markOzonPackageNotStarted(new ToolExecutionError(
                    'OZON_ROUTE_NOT_READY',
                    `The connected extension cannot run Ozon ${route.name}.`,
                    'route',
                    false
                ));
            }
            throw markOzonPackageNotStarted(new ToolExecutionError(
                'OZON_ROUTE_NOT_READY',
                `The Ozon Seller ${route.name} route is not available.`,
                'route',
                false
            ));
        }
        if (connections.extensionOzonPromotionReady) {
            sendExtension(
                connections.extensionSocket,
                localMessage(requestId, MESSAGE_TYPES.ozonPromotionOperation, {
                    authorizationId,
                    dateFrom,
                    dateTo,
                    deadlineAt,
                })
            );
            return;
        }
        if (connections.peerExtensionOzonPromotionReady && connections.peerSocket?.readyState === WS_OPEN) {
            connections.peerSocket.send(
                JSON.stringify({
                    type: 'peer_ozon_promotion_operation',
                    requestId,
                    authorizationScopeId,
                    authorizationId,
                    operation: { dateFrom, dateTo, deadlineAt },
                    timeout,
                })
            );
            return;
        }
        // Ответ про возможность известен (а значит расширение подключено) и возможность не объявлена —
        // дело в версии расширения, а не в закрытой странице отчёта. Во всех остальных случаях
        // (расширения нет, пир о возможности не сообщал, маршрут отвалился на полпути) остаётся
        // прежний общий отказ: приписывать пользователю устаревшее расширение по незнанию нельзя.
        if (connections.effectiveOzonPromotionSupportKnown === true && connections.effectiveOzonPromotionReady !== true) {
            throw ozonExtensionOutdatedError(connections.effectiveExtensionVersion);
        }
        throw new ToolExecutionError(
            'OZON_ROUTE_NOT_READY',
            'The Ozon Seller promotion operation route is not available.',
            'route',
            false
        );
    };
};
