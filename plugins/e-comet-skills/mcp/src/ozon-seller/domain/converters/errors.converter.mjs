import { OZON_AUTHORIZATION_ROUTE_CODES, OZON_EXTENSION_OUTDATED_DETAIL_KEYS, OZON_PACKAGE_FAMILIES, } from '../constants/errors.const.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { StorageUnavailableError } from '../../../shared/storage-unavailable.mjs';
import { hasOnlyOwnKeys, isOneOf, isRecord } from '../../../shared/values.mjs';
import { BRIDGE_CODES } from '../../../transport/diagnostics/bridge-codes.mjs';
import { EXTENSION_UPDATE_URL, MAX_SAFE_MESSAGE_LENGTH, OZON_PROMOTION_CAPABILITY, OZON_PROMOTION_MIN_EXTENSION_VERSION, isOzonExecutionInterruptionDetails, } from '../../../transport/extension/wire.mjs';
import { browserJobRejectionDetails, rejectionGuidance } from '../../../transport/failures/rejection.mjs';
import { OZON_EXTENSION_OUTDATED_REASON, OZON_PROMOTION_TERMINAL_CODE_STAGES, artifactFailureDetails, artifactFailureMessage, artifactRejectedDetails, bridgeCodeDetails, descriptorRuleDetails, safeExtensionVersion, } from '../../../transport/failures/vocabulary.mjs';
// The Ozon error mapping (refactor spec §7.5): the closed terminal an Ozon operation ends with, a local failure
// normalized into it, and the refusals of an outdated extension, an unavailable route and a broken signed descriptor.
export const ozonPromotionError = (code, message) => new ToolExecutionError(code, message, OZON_PROMOTION_TERMINAL_CODE_STAGES[code], false);
export const normalizeOzonPromotionError = (error, fallbackCode, fallbackMessage) => {
    // The consumer's own writer can fail before opening a stream. Preserve this local
    // diagnosis without adding storage errors to the extension terminal vocabulary.
    if (error instanceof StorageUnavailableError ||
        (error instanceof ToolExecutionError &&
            OZON_PROMOTION_TERMINAL_CODE_STAGES[error.code] === error.stage &&
            error.retryable === false))
        return error;
    // A rejected local workbook write keeps its closed class and filesystem code, never its text, and names its step.
    const artifact = fallbackCode === 'ARTIFACT_REJECTED' ? artifactFailureDetails(error) : undefined;
    const normalized = ozonPromotionError(fallbackCode, artifactFailureMessage(artifact) ?? fallbackMessage);
    if (artifact)
        normalized.details = artifact;
    return normalized;
};
// Parse boundary: details of any failure, read field by field.
const isOzonExtensionOutdatedDetails = (value) => isRecord(value) &&
    hasOnlyOwnKeys(value, OZON_EXTENSION_OUTDATED_DETAIL_KEYS) &&
    value.reason === OZON_EXTENSION_OUTDATED_REASON &&
    value.requiredCapability === OZON_PROMOTION_CAPABILITY &&
    value.requiredExtensionVersion === OZON_PROMOTION_MIN_EXTENSION_VERSION &&
    value.updateUrl === EXTENSION_UPDATE_URL &&
    (value.installedExtensionVersion === undefined || safeExtensionVersion(value.installedExtensionVersion) !== undefined);
// Parse boundary: a failure this process built or the extension sent, read field by field.
export const safeOzonPromotionToolError = (value) => {
    const { code, stage, retryable, message, details } = isRecord(value) ? value : {};
    const expectedStage = typeof code === 'string' ? OZON_PROMOTION_TERMINAL_CODE_STAGES[code] : undefined;
    if (typeof code !== 'string' ||
        expectedStage === undefined ||
        stage !== expectedStage ||
        retryable !== false ||
        typeof message !== 'string' ||
        message.length === 0 ||
        message.length > MAX_SAFE_MESSAGE_LENGTH ||
        (code === 'OZON_EXECUTION_INTERRUPTED' && details !== undefined && !isOzonExecutionInterruptionDetails(code, details))) {
        throw new TypeError('Invalid Ozon promotion terminal error.');
    }
    const safe = new ToolExecutionError(code, message, expectedStage, false);
    // details переносятся только у ошибки, созданной этим процессом. Отказ расширения и отказ пира
    // приходят как разобранный из JSON обычный объект и instanceof пройти не могут, поэтому чужая
    // сторона сокета не в состоянии дописать собственный текст в контекст модели через это поле.
    if (value instanceof ToolExecutionError && isOzonExtensionOutdatedDetails(value.details))
        safe.details = value.details;
    if (value instanceof ToolExecutionError && value.code === 'OZON_AUTHORIZATION_REJECTED' && value.details?.browserJobRejection) {
        safe.details = value.details;
    }
    if (descriptorRuleDetails(value))
        safe.details = descriptorRuleDetails(value);
    if (value instanceof ToolExecutionError && artifactRejectedDetails(value))
        safe.details = artifactRejectedDetails(value);
    if (bridgeCodeDetails(value))
        safe.details = bridgeCodeDetails(value);
    if (isRecord(details) && isOzonExecutionInterruptionDetails(code, details)) {
        safe.details = { phase: details.phase, createOutcome: details.createOutcome };
    }
    return safe;
};
// A signed Ozon descriptor that breaks a local rule is e-Comet's defect, not a request that differs from the signature.
export const ozonDescriptorRejected = (error) => {
    if (!(error instanceof ToolExecutionError) || error.code !== 'BROWSER_JOB_DESCRIPTOR_INVALID')
        return undefined;
    const rule = error.details?.rule;
    const rejected = new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', `The signed Ozon job breaks the local descriptor rule ${rule ?? 'descriptor'}; this is an e-Comet defect. ` +
        'Offer to report it; do not request another authorization for the same job.', 'authorization', false, { cause: error });
    if (rule)
        rejected.details = { rule };
    return rejected;
};
// Расширение объявляет возможности в hello_ack. Сборка, которая не объявила Ozon, не умеет исполнять
// операцию вообще: подписанное задание она отвергает как неизвестный тип ещё на авторизации, поэтому
// совет «откройте страницу отчёта» для неё заведомо бесполезен.
export const ozonExtensionOutdatedError = (installedExtensionVersion) => {
    const installed = safeExtensionVersion(installedExtensionVersion);
    const error = new ToolExecutionError('OZON_ROUTE_NOT_READY', `The connected e-Comet extension${installed === undefined ? '' : ` ${installed}`} does not announce ` +
        `${OZON_PROMOTION_CAPABILITY} and cannot run the Ozon Seller promotion report. Update the e-Comet extension to ` +
        `${OZON_PROMOTION_MIN_EXTENSION_VERSION} or newer at ${EXTENSION_UPDATE_URL} and retry. ` +
        'Opening the Ozon promotion page does not help until the extension is updated.', 'route', false);
    error.details = {
        reason: OZON_EXTENSION_OUTDATED_REASON,
        requiredCapability: OZON_PROMOTION_CAPABILITY,
        requiredExtensionVersion: OZON_PROMOTION_MIN_EXTENSION_VERSION,
        updateUrl: EXTENSION_UPDATE_URL,
        ...(installed === undefined ? {} : { installedExtensionVersion: installed }),
    };
    return error;
};
export const ozonRouteUnavailableError = (reason = 'unavailable') => new ToolExecutionError('OZON_ROUTE_NOT_READY', reason === 'disconnected'
    ? // A page no longer starts the browser connection, so refreshing one cannot restore it.
        'The browser connection closed before the Ozon report authorization completed; no report operation was dispatched by this call. ' +
            "Check local_bridge_status for the cause, then request a new report authorization on the user's decision."
    : (reason === 'timeout'
        ? 'The Ozon report authorization response timed out; this does not establish why the route was unavailable. '
        : 'The Ozon extension route is unavailable; its cause is not established. ') +
        `Ensure e-Comet extension ${OZON_PROMOTION_MIN_EXTENSION_VERSION} or newer is enabled in the same browser profile, refresh any authenticated Ozon Seller page under https://seller.ozon.ru/app, then request a new report authorization and retry.`, 'route', false);
// Only a package tool can attest a missing capability from bridge status.
// Remote error fields and message text cannot select the public stop reason.
const ozonPackageCapabilityErrors = new WeakSet();
// Parse boundary: the bridge status, read field by field.
export const ozonPackageCapabilityFailure = (family, status) => {
    const { name, minVersion, supportField, capability, code, stage } = OZON_PACKAGE_FAMILIES[family];
    if (!isRecord(status) || status.extensionConnected !== true || status[supportField] !== false)
        return undefined;
    const error = new ToolExecutionError(code, `The connected extension does not announce ${capability} and cannot run this ${name}. ` +
        `Update the e-Comet extension${minVersion ? ` to ${minVersion} or newer` : ''} at ${EXTENSION_UPDATE_URL}, then request a new authorization and retry.`, stage, false);
    ozonPackageCapabilityErrors.add(error);
    return error;
};
// Whether a failure is the missing capability a package tool attested.
export const isOzonPackageCapabilityFailure = (error) => typeof error === 'object' && error !== null && ozonPackageCapabilityErrors.has(error);
// Parse boundary: the bridge status, read field by field.
export const classifyOzonAuthorizationFailure = (error, status, packageFamily) => {
    // A trigger URL that is not a browser job is the same failed handoff as a missing one.
    if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_HANDOFF_REQUIRED') {
        return new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The trusted browser-job hook did not provide Ozon authorization.', 'authorization', false, { cause: error });
    }
    // No broker answered, or the broker refused the authorization frame: nothing reached Ozon. The contract pins only
    // the authorization stage, so the cause and its step ride in details.bridgeCode and the message.
    if (error instanceof ToolExecutionError && isOneOf(BRIDGE_CODES, error.code)) {
        const rejected = new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', error.message, 'authorization', false, { cause: error });
        rejected.details = { bridgeCode: error.code };
        return rejected;
    }
    const familySpec = packageFamily === undefined ? undefined : OZON_PACKAGE_FAMILIES[packageFamily];
    if (packageFamily !== undefined) {
        const capabilityFailure = ozonPackageCapabilityFailure(packageFamily, status);
        if (capabilityFailure)
            return capabilityFailure;
    }
    if (packageFamily === undefined &&
        error instanceof ToolExecutionError &&
        OZON_AUTHORIZATION_ROUTE_CODES.has(error.code) &&
        isRecord(status) &&
        status.extensionConnected === true &&
        status.ozonSellerPromotionReportSupported === false) {
        return ozonExtensionOutdatedError(status.extensionVersion);
    }
    if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT') {
        // No Seller probe has occurred. A missing authorization response cannot
        // establish a tab/company prerequisite or authorize repeating a create.
        return new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The Ozon report authorization response timed out. The cause is not established; no report operation was dispatched by this call. ' +
            'Inspect local_bridge_status and include this authorization failure in a bug report if it persists.', 'authorization', false, { cause: error });
    }
    if (error instanceof ToolExecutionError && OZON_AUTHORIZATION_ROUTE_CODES.has(error.code)) {
        // The browser connection closed under the authorization; a page cannot reopen it, status names the cause.
        if (error.code === 'EXTENSION_DISCONNECTED')
            return ozonRouteUnavailableError('disconnected');
        if (familySpec !== undefined) {
            return new ToolExecutionError('OZON_ROUTE_NOT_READY', 'The Ozon report authorization route did not complete; its cause is not established. ' +
                `Ensure e-Comet extension ${familySpec.minVersion ? `${familySpec.minVersion} or newer ` : ''}is enabled in the same browser profile, refresh an authenticated Ozon Seller page, then request a new authorization and retry.`, 'route', false);
        }
        if (isRecord(status) && status.extensionConnected === true && status.ozonSellerPromotionReportSupported === false) {
            return ozonExtensionOutdatedError(status.extensionVersion);
        }
        return ozonRouteUnavailableError(error.code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT' ? 'timeout' : 'unavailable');
    }
    let message = familySpec === undefined
        ? 'The Ozon promotion report authorization was rejected.'
        : `The ${familySpec.name} authorization was rejected.`;
    if (error instanceof ToolExecutionError &&
        error.code === 'BROWSER_JOB_REJECTED' &&
        error.message === 'Extension is not authenticated with e-Comet') {
        message =
            'The e-Comet extension is not signed in. Open the e-Comet extension and sign in to the same e-Comet account used for this request.';
    }
    else if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_ACCOUNT_MISMATCH') {
        message =
            'The e-Comet extension is signed in to a different e-Comet account. Open the e-Comet extension and sign in to the same e-Comet account used for this request.';
    }
    const rejection = browserJobRejectionDetails(error);
    const classified = new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', rejectionGuidance(rejection?.browserJobRejection) ?? message, 'authorization', false, { cause: error });
    if (rejection)
        classified.details = rejection;
    return classified;
};
