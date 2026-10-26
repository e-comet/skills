import { localMessage, MESSAGE_TYPES } from './extension-vocabulary.mjs';
import { ozonExtensionOutdatedError, ToolExecutionError } from './tool-errors.mjs';
import { markOzonPackageNotStarted } from './ozon-report-package-result.mjs';

// `sendExtension(message)` sends to the current session and throws a typed failure when there is none.
export const createDiagnosticSnapshotRoute = ({ connections, sendExtension }) => ({ requestId }) => {
    // «Спросить некого» и «спрашивать нечем» — разные наблюдения. Без подключённого расширения отказ по
    // возможности приписал бы пользователю устаревшую сборку, хотя наблюдается только отсутствие подключения.
    if (!connections.extensionReady) {
        throw new ToolExecutionError('EXTENSION_DISCONNECTED', 'No connected e-Comet extension is reachable for a diagnostic snapshot.', 'extension', false);
    }
    if (!connections.extensionDiagnosticSnapshotReady) throw new ToolExecutionError('UNSUPPORTED_CAPABILITY', 'The connected extension does not support diagnostic snapshots.', 'extension', false);
    sendExtension(localMessage(requestId, MESSAGE_TYPES.diagnosticSnapshot, { protocolVersion: 1 }));
};

/**
 * @param {{
 *   connections: {
 *     extensionReady: boolean,
 *     extensionOzonPromotionReady: boolean,
 *     extensionOzonPromotionPackageReady?: boolean,
 *     extensionOzonAnalyticsReady?: boolean,
 *     extensionOzonSearchPositionsReady?: boolean,
 *     extensionVersion?: string,
 *   },
 *   sendExtension: (message: object) => void,
 * }} options
 */
export const createOzonPromotionRoute = ({ connections, sendExtension }) => {
    if (!connections) throw new TypeError('Ozon promotion routing requires connection state.');
    return ({ requestId, authorizationId, dateFrom, dateTo, deadlineAt, family, items }) => {
        const route =
            family === 'promotion'
                ? {
                      ready: connections.extensionOzonPromotionPackageReady,
                      operationType: MESSAGE_TYPES.ozonPromotionPackageOperation,
                      businessPayload: { periods: items },
                      name: 'promotion report packages',
                  }
                : family === 'analytics'
                  ? {
                        ready: connections.extensionOzonAnalyticsReady,
                        operationType: MESSAGE_TYPES.ozonAnalyticsOperation,
                        businessPayload: { reports: items },
                        name: 'analytics report packages',
                    }
                  : family === 'positions'
                    ? {
                          ready: connections.extensionOzonSearchPositionsReady,
                          operationType: MESSAGE_TYPES.ozonSearchPositionsOperation,
                          businessPayload: { queries: items },
                          name: 'search positions',
                      }
                    : undefined;
        if (route) {
            if (route.ready) {
                sendExtension(localMessage(requestId, route.operationType, { authorizationId, ...route.businessPayload, deadlineAt }));
                return;
            }
            // A connected extension answered the capability question; without one nothing is known about it.
            if (connections.extensionReady) {
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
            sendExtension(localMessage(requestId, MESSAGE_TYPES.ozonPromotionOperation, { authorizationId, dateFrom, dateTo, deadlineAt }));
            return;
        }
        // Подключённое расширение возможность не объявило — дело в версии расширения, а не в закрытой
        // странице отчёта. Без подключения остаётся прежний общий отказ: приписывать пользователю
        // устаревшее расширение по незнанию нельзя.
        if (connections.extensionReady) throw ozonExtensionOutdatedError(connections.extensionVersion);
        throw new ToolExecutionError(
            'OZON_ROUTE_NOT_READY',
            'The Ozon Seller promotion operation route is not available.',
            'route',
            false
        );
    };
};
