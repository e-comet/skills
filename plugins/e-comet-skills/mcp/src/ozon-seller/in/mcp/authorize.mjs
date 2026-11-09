import { OZON_LEASE_DEFECT, OZON_PACKAGE_FAMILIES } from '../../domain/constants/errors.const.mjs';
import { classifyOzonAuthorizationFailure, ozonExtensionOutdatedError, ozonPackageCapabilityFailure, } from '../../domain/converters/errors.converter.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { isRecord } from '../../../shared/values.mjs';
// Scope revocation occurs before the release route's acknowledgement can suspend, so callers can safely
// deliver a terminal result without letting an extension round trip delay it.
export const releaseAuthorizationInBackground = (lease, context) => {
    if (!lease)
        return;
    // Parse boundary: whatever the release threw or rejected with.
    const reportFailure = (releaseError) => {
        let message;
        try {
            message = isRecord(releaseError) && typeof releaseError.message === 'string' ? releaseError.message : String(releaseError);
        }
        catch {
            message = 'unknown release failure';
        }
        console.error(`[McpDispatcher] Failed to release browser-job authorization ${context}:`, message);
    };
    try {
        Promise.resolve(lease.release()).catch(reportFailure);
    }
    catch (releaseError) {
        reportFailure(releaseError);
    }
};
/**
 * What the Ozon tools share before their job: the bridge status as it is now, the promotion report's outdated-extension
 * refusal, and a package's authorization with its capability refusals around the broker wait.
 */
// Parse boundary: the bridge status, read field by field.
export const createAuthorize = ({ authorization, getBridgeStatus }) => {
    // Диагноз строится только по статусу, который явно сообщил про возможность. Статус без этого
    // поля (нет расширения, старый соседний процесс, тестовая заглушка) оставляет прежнее поведение.
    const currentOzonStatus = () => {
        try {
            return getBridgeStatus();
        }
        catch {
            return undefined;
        }
    };
    const ozonExtensionOutdated = (status) => {
        if (!isRecord(status) || status.extensionConnected !== true || status.ozonSellerPromotionReportSupported !== false)
            return undefined;
        return ozonExtensionOutdatedError(status.extensionVersion);
    };
    // Every Ozon package family refuses an unannounced capability before and after readiness, so an older
    // extension never spends the one-use signed authorization; the caller's own preflight runs in between.
    const authorizeOzonPackage = async (family, triggerUrl, beforeWait = () => undefined) => {
        if (typeof triggerUrl !== 'string' || !triggerUrl) {
            throw new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The trusted browser-job hook did not provide Ozon authorization.', 'authorization', false);
        }
        const unavailableBeforeWait = ozonPackageCapabilityFailure(family, currentOzonStatus());
        beforeWait();
        if (unavailableBeforeWait)
            throw unavailableBeforeWait;
        const unavailable = await authorization.connect();
        if (unavailable)
            throw classifyOzonAuthorizationFailure(unavailable, currentOzonStatus(), family);
        const unavailableAfterWait = ozonPackageCapabilityFailure(family, currentOzonStatus());
        if (unavailableAfterWait)
            throw unavailableAfterWait;
        let lease;
        try {
            lease = await authorization.authorize(triggerUrl);
        }
        catch (error) {
            throw classifyOzonAuthorizationFailure(error, currentOzonStatus(), family);
        }
        // A lease bound to no scope cannot run the operation: that is our defect.
        if (!lease || typeof lease.scopeId !== 'string') {
            releaseAuthorizationInBackground(lease, `after an invalid ${OZON_PACKAGE_FAMILIES[family].name} authorization`);
            throw new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', `The extension returned an invalid ${OZON_PACKAGE_FAMILIES[family].name} authorization. ${OZON_LEASE_DEFECT}`, 'authorization', false);
        }
        return lease;
    };
    return { currentOzonStatus, ozonExtensionOutdated, authorizeOzonPackage };
};
