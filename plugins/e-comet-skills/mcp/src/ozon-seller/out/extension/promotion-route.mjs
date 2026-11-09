import { ozonExtensionOutdatedError } from '../../domain/converters/errors.converter.mjs';
import { markOzonPackageNotStarted } from '../../domain/converters/package-result.converter.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { localMessage, MESSAGE_TYPES } from '../../../transport/extension/wire.mjs';
/** The Ozon route: an operation goes to the extension only when it announced that operation's capability. */
export const createOzonPromotionRoute = ({ connections, sendExtension, }) => {
    return ({ requestId, authorizationId, dateFrom, dateTo, deadlineAt, family, items }) => {
        const route = family === 'promotion'
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
                throw markOzonPackageNotStarted(new ToolExecutionError('OZON_ROUTE_NOT_READY', `The connected extension cannot run Ozon ${route.name}.`, 'route', false));
            }
            throw markOzonPackageNotStarted(new ToolExecutionError('OZON_ROUTE_NOT_READY', `The Ozon Seller ${route.name} route is not available.`, 'route', false));
        }
        if (connections.extensionOzonPromotionReady) {
            sendExtension(localMessage(requestId, MESSAGE_TYPES.ozonPromotionOperation, { authorizationId, dateFrom, dateTo, deadlineAt }));
            return;
        }
        // Подключённое расширение возможность не объявило — дело в версии расширения, а не в закрытой
        // странице отчёта. Без подключения остаётся прежний общий отказ: приписывать пользователю
        // устаревшее расширение по незнанию нельзя.
        if (connections.extensionReady)
            throw ozonExtensionOutdatedError(connections.extensionVersion);
        throw new ToolExecutionError('OZON_ROUTE_NOT_READY', 'The Ozon Seller promotion operation route is not available.', 'route', false);
    };
};
