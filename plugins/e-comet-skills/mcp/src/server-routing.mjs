import { localMessage, MESSAGE_TYPES } from './extension-vocabulary.mjs';
import { ozonExtensionOutdatedError, ToolExecutionError } from './tool-errors.mjs';
import { sendWs, WS_OPEN } from './websocket.mjs';
import { markOzonPackageNotStarted } from './ozon-report-package-result.mjs';

/**
 * @param {{
 *   connections: {
 *     extensionOzonPromotionReady: boolean,
 *     extensionOzonPromotionPackageReady?: boolean,
 *     extensionOzonAnalyticsReady?: boolean,
 *     extensionSocket?: unknown,
 *     peerExtensionOzonPromotionReady?: boolean,
 *     peerExtensionOzonPromotionPackageReady?: boolean,
 *     peerExtensionOzonAnalyticsReady?: boolean,
 *     peerSocket?: {readyState: number, send(message: string): void} | null,
 *     effectiveExtensionVersion?: string,
 *     effectiveOzonPromotionReady?: boolean,
 *     effectiveOzonPromotionSupportKnown?: boolean,
 *     effectiveOzonPromotionPackageReady?: boolean,
 *     effectiveOzonPromotionPackageSupportKnown?: boolean,
 *     effectiveOzonAnalyticsReady?: boolean,
 *     effectiveOzonAnalyticsSupportKnown?: boolean,
 *   },
 *   sendExtension?: (socket: unknown, message: object) => void,
 * }} options
 */
export const createOzonPromotionRoute = ({ connections, sendExtension = sendWs }) => {
    if (!connections) throw new TypeError('Ozon promotion routing requires connection state.');
    return ({ requestId, authorizationId, authorizationScopeId, dateFrom, dateTo, deadlineAt, timeout, family, items }) => {
        if (family === 'promotion' || family === 'analytics') {
            const directReady =
                family === 'promotion' ? connections.extensionOzonPromotionPackageReady : connections.extensionOzonAnalyticsReady;
            const peerReady =
                family === 'promotion'
                    ? connections.peerExtensionOzonPromotionPackageReady
                    : connections.peerExtensionOzonAnalyticsReady;
            const operationType =
                family === 'promotion' ? MESSAGE_TYPES.ozonPromotionPackageOperation : MESSAGE_TYPES.ozonAnalyticsOperation;
            const businessPayload = family === 'promotion' ? { periods: items } : { reports: items };
            if (directReady) {
                sendExtension(
                    connections.extensionSocket,
                    localMessage(requestId, operationType, { authorizationId, ...businessPayload, deadlineAt })
                );
                return;
            }
            if (peerReady && connections.peerSocket?.readyState === WS_OPEN) {
                connections.peerSocket.send(
                    JSON.stringify({
                        type:
                            family === 'promotion'
                                ? 'peer_ozon_promotion_reports_operation'
                                : 'peer_ozon_analytics_report_operation',
                        requestId,
                        authorizationScopeId,
                        authorizationId,
                        package: { family, items, deadlineAt },
                        timeout,
                    })
                );
                return;
            }
            const supportKnown =
                family === 'promotion'
                    ? connections.effectiveOzonPromotionPackageSupportKnown
                    : connections.effectiveOzonAnalyticsSupportKnown;
            if (supportKnown) {
                throw markOzonPackageNotStarted(new ToolExecutionError(
                    'OZON_ROUTE_NOT_READY',
                    `The connected extension cannot run Ozon ${family} report packages.`,
                    'route',
                    false
                ));
            }
            throw markOzonPackageNotStarted(new ToolExecutionError(
                'OZON_ROUTE_NOT_READY',
                `The Ozon Seller ${family} report package route is not available.`,
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
