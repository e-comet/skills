import { bridgeCauseError } from './bridge-cause.mjs';
import { ARTIFACT_MAX_FILE_BYTES, MAX_BROWSER_JOB_TEXT_LENGTH } from './config.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from './ozon-report-package-domain.mjs';
import {
    AUTHORIZATION_FETCH_ERROR_CODES,
    DIAGNOSTIC_SNAPSHOT_CAPABILITY,
    EXTENSION_TO_CLIENT_MESSAGE_TYPES,
    isSellerOperationStage,
    localMessage,
    MESSAGE_TYPES,
    OZON_ANALYTICS_CAPABILITY,
    OZON_ANALYTICS_SERVER_MESSAGE_TYPES,
    OZON_ANALYTICS_TERMINAL_CODE_STAGES,
    isOzonAnalyticsTerminalDetails,
    isOzonExecutionInterruptionDetails,
    OZON_PROMOTION_CAPABILITY,
    OZON_PROMOTION_PACKAGE_CAPABILITY,
    OZON_PROMOTION_SERVER_MESSAGE_TYPES,
    OZON_SEARCH_POSITIONS_CAPABILITY,
    OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES,
    RETRYABLE_FETCH_ERROR_CODES,
    SELLER_FAILURE_CLASSES,
    SELLER_FAILURE_REASONS,
    SELLER_OPERATION_STAGES,
    UNCLASSIFIED_FETCH_ERROR_CODE,
    WB_FETCH_TIMEOUT_PHASES,
    wbaasRecoveryOutcome,
    DIAGNOSTIC_SNAPSHOT_V2_CAPABILITY,
    PENDING_UPDATE_VERSION_PATTERN,
} from './extension-vocabulary.mjs';
import { parseOzonPromotionPeriod } from './ozon-promotion-domain.mjs';
import { isSearchPositionsSkuList, MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH } from './ozon-search-positions-domain.mjs';
import { ToolExecutionError, fetchFailureGuidance, parseBrowserJobRejection, safeExternalToolError, safeOzonPromotionToolError } from './tool-errors.mjs';

const MAX_ID_LENGTH = 128;
const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_BASE64_STREAM_CHUNK_LENGTH = 4 * Math.ceil(MAX_STREAM_CHUNK_BYTES / 3);
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isTabReadiness = (value) => isRecord(value) && hasOnlyKeys(value, ['ready', 'lastPingAgeMs']) && typeof value.ready === 'boolean' &&
    (value.lastPingAgeMs === undefined || isNonNegativeSafeInteger(value.lastPingAgeMs));
// Version 2 is version 1 plus tab readiness and a downloaded update, served only behind diagnostic_snapshot_v2.
export const isDiagnosticSnapshot = (payload) => {
    if (!isRecord(payload) || payload.protocolVersion !== 2) return isDiagnosticSnapshotV1(payload);
    const { tabs, pendingUpdateVersion, ...base } = payload;
    return isRecord(tabs) && hasOnlyKeys(tabs, ['wb', 'wbSeller', 'ozon']) && ['wb', 'wbSeller', 'ozon'].every((key) => isTabReadiness(tabs[key])) &&
        (pendingUpdateVersion === undefined || (typeof pendingUpdateVersion === 'string' && PENDING_UPDATE_VERSION_PATTERN.test(pendingUpdateVersion))) &&
        isDiagnosticSnapshotV1({ ...base, protocolVersion: 1 });
};
const isDiagnosticSnapshotV1 = (payload) =>
    isRecord(payload) &&
    hasOnlyKeys(payload, ['protocolVersion', 'observedAt', 'extensionVersion', 'capabilities', 'activationIdentity', 'storageRead', 'ports']) &&
    Object.keys(payload).length === 7 && payload.protocolVersion === 1 &&
    typeof payload.observedAt === 'string' && payload.observedAt.length <= 64 &&
    typeof payload.extensionVersion === 'string' && payload.extensionVersion.length <= 128 &&
    Array.isArray(payload.capabilities) && payload.capabilities.every((item) => typeof item === 'string' && item.length <= 128) &&
    isRecord(payload.activationIdentity) && Object.keys(payload.activationIdentity).length === 1 &&
    ['present', 'absent', 'unknown'].includes(payload.activationIdentity.state) &&
    isRecord(payload.storageRead) && Object.keys(payload.storageRead).length === 1 &&
    ['passed', 'failed', 'unknown'].includes(payload.storageRead.state) &&
    isRecord(payload.ports) && hasOnlyKeys(payload.ports, ['wb', 'wbSeller', 'ozon']) && Object.keys(payload.ports).length === 3 &&
    ['wb', 'wbSeller', 'ozon'].every((key) => typeof payload.ports[key] === 'boolean' || payload.ports[key] === 'unknown');
const isNonNegativeSafeInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hasOnlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const isBoundedString = (value, maxLength) => typeof value === 'string' && value.length > 0 && value.length <= maxLength;
const isValidBase64Chunk = (value) => {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_BASE64_STREAM_CHUNK_LENGTH ||
        !BASE64_PATTERN.test(value)
    ) {
        return false;
    }
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value && decoded.byteLength <= MAX_STREAM_CHUNK_BYTES;
};
export const isValidOzonReportPhase = (value) =>
    isRecord(value) && hasOnlyKeys(value, ['family', 'frameId', 'itemIndex', 'phase']) &&
    ['promotion', 'analytics'].includes(value.family) && isBoundedString(value.frameId, 128) &&
    isNonNegativeSafeInteger(value.itemIndex) && value.itemIndex < MAX_OZON_REPORT_PACKAGE_ITEMS &&
    ['pre_create', 'create_dispatched', 'create_settled', 'polling', 'downloading', 'streaming'].includes(value.phase);

export const isValidSellerOperation = (value) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ['exportIndex', 'isAnswered', 'stage', 'reportId'])) return false;
    if (
        !isNonNegativeSafeInteger(value.exportIndex) ||
        typeof value.isAnswered !== 'boolean' ||
        !isSellerOperationStage(value.stage)
    ) {
        return false;
    }
    return value.stage === SELLER_OPERATION_STAGES.create
        ? value.reportId === undefined
        : typeof value.reportId === 'string' && value.reportId.length > 0 && value.reportId.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
};
export const isValidSellerStreamStart = (value) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['mimeType', 'declaredSize']) &&
    value.mimeType === XLSX_MIME_TYPE &&
    (value.declaredSize === undefined ||
        (isNonNegativeSafeInteger(value.declaredSize) && value.declaredSize <= ARTIFACT_MAX_FILE_BYTES));
export const isValidSellerStreamChunk = (value) =>
    isRecord(value) && hasOnlyKeys(value, ['index', 'data']) && isNonNegativeSafeInteger(value.index) && isValidBase64Chunk(value.data);
export const isValidSellerStreamEnd = (value) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['size', 'sha256']) &&
    isNonNegativeSafeInteger(value.size) &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256);
export const isValidOzonPromotionOperation = (value) => {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ['dateFrom', 'dateTo', 'deadlineAt']) ||
        !Number.isSafeInteger(value.deadlineAt) ||
        value.deadlineAt <= 0
    ) {
        return false;
    }
    try {
        parseOzonPromotionPeriod(value.dateFrom, value.dateTo);
        return true;
    } catch {
        return false;
    }
};
const isValidOzonStreamStart = (value, indexed = false) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['frameId', 'itemIndex', 'name', 'mimeType', 'declaredSize']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedString(value.frameId, MAX_ID_LENGTH) &&
    isBoundedString(value.name, MAX_BROWSER_JOB_TEXT_LENGTH) &&
    value.mimeType === XLSX_MIME_TYPE &&
    (value.declaredSize === undefined ||
        (isNonNegativeSafeInteger(value.declaredSize) && value.declaredSize <= ARTIFACT_MAX_FILE_BYTES));
const isValidOzonStreamChunk = (value, indexed = false) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['frameId', 'itemIndex', 'index', 'data']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedString(value.frameId, MAX_ID_LENGTH) &&
    isNonNegativeSafeInteger(value.index) &&
    isValidBase64Chunk(value.data);
const isValidOzonStreamEnd = (value, indexed = false) =>
    isRecord(value) &&
    hasOnlyKeys(value, ['frameId', 'itemIndex', 'size', 'sha256']) &&
    (!indexed || isNonNegativeSafeInteger(value.itemIndex)) &&
    (indexed || value.itemIndex === undefined) &&
    isBoundedString(value.frameId, MAX_ID_LENGTH) &&
    isNonNegativeSafeInteger(value.size) &&
    value.size <= ARTIFACT_MAX_FILE_BYTES &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256);
const isValidOzonResult = (value, allowSkipped = false) => {
    // Promotion may carry date context; analytics below deliberately requires its own exact error keys.
    if (!isRecord(value) || !hasOnlyKeys(value, ['ok', 'status', 'error'])) return false;
    if (value.ok === true) return Object.keys(value).length === 1;
    const skipped = allowSkipped && value.status === 'skipped' && Object.keys(value).length === 3;
    if (value.ok !== false || (!skipped && Object.keys(value).length !== 2) || !isRecord(value.error)) return false;
    const error = value.error;
    if (
        !hasOnlyKeys(error, ['code', 'stage', 'retryable', 'message', 'dateFrom', 'dateTo', 'details']) ||
        (Object.hasOwn(error, 'details') && (!allowSkipped || !isOzonExecutionInterruptionDetails(error.code, error.details))) ||
        typeof error.message !== 'string' ||
        error.message.length === 0 ||
        error.message.length > MAX_SAFE_MESSAGE_LENGTH
    ) {
        return false;
    }
    try {
        safeOzonPromotionToolError(error);
        if ((error.dateFrom === undefined) !== (error.dateTo === undefined)) return false;
        if (error.dateFrom !== undefined) parseOzonPromotionPeriod(error.dateFrom, error.dateTo);
        return true;
    } catch {
        return false;
    }
};
const isValidIndexedOzonResult = (value, family) => {
    if (!isRecord(value) || !isNonNegativeSafeInteger(value.itemIndex)) return false;
    const { itemIndex: _itemIndex, ...result } = value;
    if (family === 'promotion') return isValidOzonResult(result, true);
    if (!isRecord(result) || !hasOnlyKeys(result, ['ok', 'status', 'error'])) return false;
    if (result.ok === true) return Object.keys(result).length === 1;
    const skipped = result.status === 'skipped' && Object.keys(result).length === 3;
    if (result.ok !== false || (!skipped && Object.keys(result).length !== 2) || !isRecord(result.error)) return false;
    const error = result.error;
    return (
        hasOnlyKeys(error, ['code', 'stage', 'retryable', 'message', 'details']) &&
        (!Object.hasOwn(error, 'details') || (!skipped && isOzonAnalyticsTerminalDetails(error.code, error.details)) ||
            isOzonExecutionInterruptionDetails(error.code, error.details)) &&
        OZON_ANALYTICS_TERMINAL_CODE_STAGES[error.code] === error.stage &&
        error.retryable === false &&
        typeof error.message === 'string' &&
        error.message.length > 0 &&
        error.message.length <= MAX_SAFE_MESSAGE_LENGTH
    );
};
const MAX_OZON_SEARCH_POSITIONS_LABEL_LENGTH = 32;
const MAX_OZON_REGION_CANDIDATES = 5;
const isValidOzonSearchPositionsCell = (cell) =>
    isRecord(cell) && Object.keys(cell).length === 2 && Number.isSafeInteger(cell.sku) && cell.sku > 0 &&
    ((Number.isSafeInteger(cell.position) && cell.position > 0) || cell.found === false || cell.returned === false ||
        isBoundedString(cell.label, MAX_OZON_SEARCH_POSITIONS_LABEL_LENGTH));
// Only a failed item that actually ran may explain its preflight stop; a skipped item carries no details.
export const isValidOzonSearchPositionsDetails = (code, details) =>
    isRecord(details) && Object.keys(details).length === 1 &&
    ((code === 'OZON_REGION_UNAVAILABLE' && Array.isArray(details.candidates) && details.candidates.length >= 1 &&
        details.candidates.length <= MAX_OZON_REGION_CANDIDATES &&
        details.candidates.every((candidate) => isBoundedString(candidate, MAX_OZON_SEARCH_POSITIONS_TEXT_LENGTH))) ||
        (code === 'OZON_SKU_LIMIT_EXCEEDED' && Number.isSafeInteger(details.limit) && details.limit > 0));
// `skus` is the signed SKU list: cells are exactly one per SKU in that order. Without it (the wire
// parser, before correlation) the cell SKUs must still form a valid signed list. EMPTY has no cells:
// «no data for this query» must never read as «not found» for every SKU.
export const isValidOzonSearchPositionsResult = (payload, skus) => {
    if (!isRecord(payload) || !isNonNegativeSafeInteger(payload.itemIndex) || payload.itemIndex >= MAX_OZON_REPORT_PACKAGE_ITEMS) {
        return false;
    }
    if (payload.ok === true) {
        if (
            !hasOnlyKeys(payload, ['itemIndex', 'ok', 'status', 'checkedAt', 'positions']) || Object.keys(payload).length !== 5 ||
            // The last millisecond of year 9999: toISOString() keeps the four-digit year the output schema requires.
            !Number.isSafeInteger(payload.checkedAt) || payload.checkedAt <= 0 || payload.checkedAt > 253402300799999 || !Array.isArray(payload.positions)
        ) return false;
        if (payload.status === 'empty') return payload.positions.length === 0;
        if (payload.status !== 'complete' || !payload.positions.every(isValidOzonSearchPositionsCell)) return false;
        const cellSkus = payload.positions.map(({ sku }) => sku);
        return skus === undefined
            ? isSearchPositionsSkuList(cellSkus)
            : cellSkus.length === skus.length && cellSkus.every((sku, index) => sku === skus[index]);
    }
    if (payload.ok !== false || !hasOnlyKeys(payload, ['itemIndex', 'ok', 'status', 'error']) || !isRecord(payload.error)) return false;
    const skipped = payload.status === 'skipped';
    if (!skipped && Object.hasOwn(payload, 'status')) return false;
    const { error } = payload;
    return (
        hasOnlyKeys(error, ['code', 'stage', 'retryable', 'message', 'details']) &&
        Object.hasOwn(OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES, error.code) &&
        OZON_SEARCH_POSITIONS_TERMINAL_CODE_STAGES[error.code] === error.stage &&
        error.retryable === false &&
        isBoundedString(error.message, MAX_SAFE_MESSAGE_LENGTH) &&
        (!Object.hasOwn(error, 'details') || (!skipped && isValidOzonSearchPositionsDetails(error.code, error.details)))
    );
};
export const parseExtensionServerMessage = (value) => {
    if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        value.id.length === 0 ||
        value.id.length > MAX_ID_LENGTH ||
        typeof value.type !== 'string' ||
        (!EXTENSION_TO_CLIENT_MESSAGE_TYPES.includes(value.type) &&
            !OZON_PROMOTION_SERVER_MESSAGE_TYPES.includes(value.type) &&
            !OZON_ANALYTICS_SERVER_MESSAGE_TYPES.includes(value.type) && value.type !== MESSAGE_TYPES.ozonReportPhase &&
            value.type !== MESSAGE_TYPES.ozonSearchPositionsResult) ||
        !isRecord(value.payload)
    ) {
        return { ok: false };
    }

    const { payload, type } = value;
    if (type === MESSAGE_TYPES.browserJobAuthorizeResult && payload.browserJobRejection !== undefined && !parseBrowserJobRejection(payload.error?.code, payload.browserJobRejection)) {
        return { ok: true, message: { ...value, payload: { ...payload, browserJobRejection: undefined } } };
    }
    if (type === MESSAGE_TYPES.diagnosticSnapshotResult && !isDiagnosticSnapshot(payload)) return { ok: false };
    if (type === MESSAGE_TYPES.ozonReportPhase && !isValidOzonReportPhase(payload)) return { ok: false };
    if (type === MESSAGE_TYPES.wbFetchStreamStart) {
        if (!isValidSellerStreamStart(payload)) return { ok: false };
    }
    if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
        if (!isValidSellerStreamChunk(payload)) return { ok: false };
    }
    if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
        if (!isValidSellerStreamEnd(payload)) return { ok: false };
    }
    if (type === MESSAGE_TYPES.browserJobAuthorizationReleaseResult) {
        const validSuccess = payload.released === true && Object.keys(payload).length === 1;
        const validError =
            isRecord(payload.error) &&
            hasOnlyKeys(payload, ['error']) &&
            Object.keys(payload).length === 1 &&
            hasOnlyKeys(payload.error, ['code', 'message']) &&
            Object.keys(payload.error).length === 2 &&
            typeof payload.error.code === 'string' &&
            typeof payload.error.message === 'string';
        if (!validSuccess && !validError) return { ok: false };
    }
    if (
        type === MESSAGE_TYPES.ozonPromotionStreamStart &&
        !isValidOzonStreamStart(payload, Object.hasOwn(payload, 'itemIndex'))
    )
        return { ok: false };
    if (
        type === MESSAGE_TYPES.ozonPromotionStreamChunk &&
        !isValidOzonStreamChunk(payload, Object.hasOwn(payload, 'itemIndex'))
    )
        return { ok: false };
    if (type === MESSAGE_TYPES.ozonPromotionStreamEnd && !isValidOzonStreamEnd(payload, Object.hasOwn(payload, 'itemIndex')))
        return { ok: false };
    if (
        type === MESSAGE_TYPES.ozonPromotionResult &&
        !(Object.hasOwn(payload, 'itemIndex') ? isValidIndexedOzonResult(payload, 'promotion') : isValidOzonResult(payload))
    )
        return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamStart && !isValidOzonStreamStart(payload, true)) return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamChunk && !isValidOzonStreamChunk(payload, true)) return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsStreamEnd && !isValidOzonStreamEnd(payload, true)) return { ok: false };
    if (type === MESSAGE_TYPES.ozonAnalyticsResult && !isValidIndexedOzonResult(payload, 'analytics')) return { ok: false };
    if (type === MESSAGE_TYPES.ozonSearchPositionsResult && !isValidOzonSearchPositionsResult(payload)) return { ok: false };

    return { ok: true, message: value };
};

// The closed evidence a `wb_fetch_result` failure may carry beside its code (contract `wbFetchResultFields`).
export const fetchFailureDetails = (code, response) => {
    const details = {};
    if (code === 'WB_FETCH_TIMEOUT' && WB_FETCH_TIMEOUT_PHASES.includes(response.phase)) details.phase = response.phase;
    if (SELLER_FAILURE_REASONS[code]?.includes(response.reason)) details.reason = response.reason;
    if (SELLER_FAILURE_CLASSES.includes(response.class) && typeof response.wbRefused === 'boolean') {
        Object.assign(details, { class: response.class, wbRefused: response.wbRefused });
        if (Number.isSafeInteger(response.httpStatus) && response.httpStatus >= 100 && response.httpStatus <= 599) details.httpStatus = response.httpStatus;
    }
    const recovery = wbaasRecoveryOutcome(response.wbaasRecovery);
    if (recovery) details.recovery = recovery;
    return Object.keys(details).length ? Object.freeze(details) : undefined;
};

// The broker refused a frame this process sent, or the client refused one before writing it. Either way the request
// cannot reach the extension, and the cause is ours, not the seller's.
export const bridgeFrameRefusal = (refusalCode) => {
    const refusal = typeof refusalCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(refusalCode) ? refusalCode : 'UNKNOWN';
    const error = bridgeCauseError({ code: 'BRIDGE_FRAME_TOO_LARGE', refusal });
    error.details = Object.freeze({ refusalCode: refusal });
    return error;
};

// Nothing reached the extension, so one retry is safe.
const DISCONNECTED_RETRY = 'Retry once; if it repeats, check local_bridge_status.';
export const extensionDisconnectedError = (what = 'The e-Comet extension is not connected to this agent.') =>
    new ToolExecutionError('EXTENSION_DISCONNECTED', `${what} ${DISCONNECTED_RETRY}`, 'extension', true);
// The extension may have applied the request already, so this text never invites repeating a create.
const extensionDisconnectedInFlightError = () => new ToolExecutionError('EXTENSION_DISCONNECTED',
    'The browser connection closed while the request was running; check local_bridge_status. A read can be repeated, ' +
        "but do not repeat a report create without the user's decision.", 'extension', true);

const isBrowserContext = (context) => isRecord(context) && Object.keys(context).length === 2 &&
    typeof context.wbTabConnected === 'boolean' && typeof context.sellerTabConnected === 'boolean';

/**
 * Runs today's extension session over a broker session. The broker owns the handshake: `openSession` receives the
 * extension facts it read from `hello_ack`, and the frames that follow are plain objects.
 */
export const createExtensionProtocol = ({ connections, requestBroker, log, broadcastStatus = () => undefined }) => {
    // Every correlated collection the extension (or the broker) can answer for one request id. Ownership decides the
    // collection: `a() || b()` would always touch the first and log a false late response for the others.
    const rejectRequest = (id, rejection) =>
        requestBroker.hasPendingDiagnosticSnapshot?.(id)
            ? requestBroker.rejectDiagnosticSnapshot(id, rejection)
            : requestBroker.hasPendingAuthorization(id)
              ? requestBroker.rejectAuthorization(id, rejection)
              : requestBroker.hasPendingAuthorizationRelease(id)
                ? requestBroker.rejectAuthorizationRelease(id, rejection)
                : requestBroker.hasPendingOzonPromotionOperation(id)
                  ? requestBroker.rejectOzonPromotionReport(id, rejection)
                  : requestBroker.hasPendingOzonReportPackage(id)
                    ? requestBroker.rejectOzonReportPackage(id, rejection)
                    : requestBroker.hasPendingSellerOperation(id)
                      ? requestBroker.rejectSellerOperation(id, rejection)
                      : requestBroker.rejectFetch(id, rejection);

    const updateBrowserContext = (session, context) => {
        if (isBrowserContext(context) && connections.updateBrowserContext(session, context)) broadcastStatus();
    };

    const openSession = (session, facts, browserContext) => {
        if (connections.extensionSession && connections.extensionSession !== session) requestBroker.invalidateAuthorizationWork();
        const capabilities = Array.isArray(facts?.capabilities) ? facts.capabilities : [];
        const previous = connections.connectExtension(session, {
            browserJobSupported: capabilities.includes('browser_job'),
            ozonSellerPromotionReportSupported: capabilities.includes(OZON_PROMOTION_CAPABILITY),
            ozonSellerPromotionReportsSupported: capabilities.includes(OZON_PROMOTION_PACKAGE_CAPABILITY),
            ozonSellerAnalyticsReportSupported: capabilities.includes(OZON_ANALYTICS_CAPABILITY),
            ozonSearchPositionsSupported: capabilities.includes(OZON_SEARCH_POSITIONS_CAPABILITY),
            diagnosticSnapshotSupported: capabilities.includes(DIAGNOSTIC_SNAPSHOT_CAPABILITY),
            diagnosticSnapshotV2Supported: capabilities.includes(DIAGNOSTIC_SNAPSHOT_V2_CAPABILITY),
            version: typeof facts?.extensionVersion === 'string' ? facts.extensionVersion : undefined,
        });
        previous?.close();
        // connectExtension resets the context of a new session, so the one a running broker already holds goes after it.
        if (isBrowserContext(browserContext)) connections.updateBrowserContext(session, browserContext);
        log(`extension connected, version ${facts?.extensionVersion || 'unknown'}`);
        broadcastStatus();
    };

    const handleMessage = async (session, message) => {
        if (message?.type === 'session_state') return void updateBrowserContext(session, message.browserContext);
        // The broker closes the connection right after it, and the close ends the session.
        if (message?.type === 'session_end') return;
        if (message?.type === 'broker_refusal') {
            if (typeof message.id !== 'string') return void log(`broker refused a frame without an id: ${message.code}`);
            const settled = rejectRequest(message.id, bridgeFrameRefusal(message.code));
            log(`broker refused message ${message.id}: ${message.code}${settled ? '' : ' (no pending request)'}`);
            return;
        }

        const parsed = parseExtensionServerMessage(message);
        if (!parsed.ok) {
            // Коррелированный снимок неверной формы закрывает свой запрос сразу. Без этого он
            // оседал молча, e_comet_diagnose ждал полный таймаут и сообщал причину «unknown»
            // вместо наблюдаемого отказа по форме. Содержимое payload не логируем.
            if (message?.type === MESSAGE_TYPES.diagnosticSnapshotResult &&
                typeof message.id === 'string' && requestBroker.hasPendingDiagnosticSnapshot?.(message.id)) {
                requestBroker.rejectDiagnosticSnapshot(message.id, new ToolExecutionError('EXTENSION_DIAGNOSTIC_INVALID',
                    'The extension diagnostic snapshot did not match the negotiated diagnostic_snapshot_v1 shape.', 'extension', false));
                log(`rejected malformed diagnostic snapshot result ${message.id}`);
            }
            return;
        }
        message = parsed.message;

        const { payload, type } = message;
        // Конверт уровня протокола (невалидный payload, слишком большое сообщение,
        // неизвестный тип). Его id совпадает с id исходного сообщения, поэтому он
        // закрывает ровно тот запрос, который расширение отвергло. Без этой ветки
        // вызов висел до полного таймаута без всякой диагностики.
        if (type === MESSAGE_TYPES.error) {
            const code = typeof payload.code === 'string' ? payload.code : 'EXTENSION_PROTOCOL_ERROR';
            const detail = typeof payload.message === 'string' ? payload.message : 'The extension rejected the message.';
            // stage: 'execution' — отвергнутое на протоколе сообщение проваливает свою
            // единицу, а не авторизацию. Со стадией 'authorization' задание обрывалось
            // целиком, и агент шёл жечь новый JWT на задании, которое упадёт так же.
            const rejection = safeExternalToolError(
                { code, message: detail, stage: 'execution', retryable: false },
                'The extension rejected a local-agent message.'
            );
            const settled = rejectRequest(message.id, rejection);
            log(`extension rejected message ${message.id}: ${code}${settled ? '' : ' (no pending request)'}`);
            return;
        }

        if (type === MESSAGE_TYPES.browserJobAuthorizeResult) {
            if (payload.error) {
                requestBroker.rejectAuthorization(message.id, safeExternalToolError({ ...payload.error, browserJobRejection: payload.browserJobRejection }));
            } else if (!requestBroker.resolveAuthorization(message.id, payload.authorization)) {
                // A grant that arrives after its request timed out would hold the seller cabinet until the token expires.
                const authorizationId = payload.authorization?.authorizationId;
                if (typeof authorizationId === 'string' && authorizationId.length > 0) {
                    void requestBroker
                        .requestAuthorizationRelease(authorizationId, ({ requestId }) =>
                            session.send(localMessage(requestId, MESSAGE_TYPES.browserJobAuthorizationRelease, { authorizationId })))
                        .catch((error) => log('failed to release a late browser-job authorization:', error.code ?? error.message));
                } else {
                    log(`late browser-job authorization ${message.id} carried no authorization id to release`);
                }
            }
            return;
        }

        if (type === MESSAGE_TYPES.diagnosticSnapshotResult) {
            requestBroker.resolveDiagnosticSnapshot(message.id, payload);
            return;
        }

        if (type === MESSAGE_TYPES.browserJobAuthorizationReleaseResult) {
            if (payload.error) {
                requestBroker.rejectAuthorizationRelease(
                    message.id,
                    safeExternalToolError(
                        { ...payload.error, stage: 'extension', retryable: false },
                        'The extension could not confirm browser job authorization release.'
                    )
                );
            } else {
                requestBroker.resolveAuthorizationRelease(message.id);
            }
            return;
        }

        if (type === MESSAGE_TYPES.wbFetchStreamStart) {
            await requestBroker.startSellerStream(message.id, payload);
            return;
        }

        if (type === MESSAGE_TYPES.wbFetchStreamChunk) {
            await requestBroker.appendSellerStreamChunk(message.id, payload.index, payload.data);
            return;
        }

        if (type === MESSAGE_TYPES.wbFetchStreamEnd) {
            await requestBroker.endSellerStream(message.id, payload);
            return;
        }

        if (type === MESSAGE_TYPES.ozonReportPhase) {
            const handled = await requestBroker.recordOzonReportPackagePhase(message.id, payload.family, payload);
            if (handled) session.send(localMessage(message.id,
                payload.family === 'promotion' ? MESSAGE_TYPES.ozonPromotionStreamAck : MESSAGE_TYPES.ozonAnalyticsStreamAck,
                { frameId: payload.frameId }));
            return;
        }
        if (type === MESSAGE_TYPES.ozonPromotionStreamStart) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.startOzonReportPackageStream(message.id, 'promotion', payload)
                : await requestBroker.startOzonPromotionStream(message.id, payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonPromotionStreamChunk) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.appendOzonReportPackageStreamChunk(message.id, 'promotion', payload)
                : await requestBroker.appendOzonPromotionStreamChunk(message.id, payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonPromotionStreamEnd) {
            const handled = Object.hasOwn(payload, 'itemIndex')
                ? await requestBroker.endOzonReportPackageStream(message.id, 'promotion', payload)
                : await requestBroker.endOzonPromotionStream(message.id, payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonPromotionStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonPromotionResult) {
            if (Object.hasOwn(payload, 'itemIndex')) {
                const { itemIndex, ...result } = payload;
                await requestBroker.resolveOzonReportPackageItem(message.id, 'promotion', itemIndex, result);
            } else if (requestBroker.hasPendingOzonReportPackage(message.id)) {
                requestBroker.rejectOzonReportPackage(message.id, new ToolExecutionError(
                    'ARTIFACT_REJECTED',
                    'The Ozon report package received a result without its item index.',
                    'artifact',
                    false
                ));
            } else if (payload.ok) requestBroker.resolveOzonPromotionReport(message.id, payload);
            else requestBroker.rejectOzonPromotionReport(message.id, safeOzonPromotionToolError(payload.error));
            return;
        }

        if (
            type === MESSAGE_TYPES.ozonAnalyticsStreamStart ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamChunk ||
            type === MESSAGE_TYPES.ozonAnalyticsStreamEnd
        ) {
            const handled =
                type === MESSAGE_TYPES.ozonAnalyticsStreamStart
                    ? await requestBroker.startOzonReportPackageStream(message.id, 'analytics', payload)
                    : type === MESSAGE_TYPES.ozonAnalyticsStreamChunk
                      ? await requestBroker.appendOzonReportPackageStreamChunk(message.id, 'analytics', payload)
                      : await requestBroker.endOzonReportPackageStream(message.id, 'analytics', payload);
            if (handled) {
                session.send(localMessage(message.id, MESSAGE_TYPES.ozonAnalyticsStreamAck, { frameId: payload.frameId }));
            }
            return;
        }

        if (type === MESSAGE_TYPES.ozonAnalyticsResult || type === MESSAGE_TYPES.ozonSearchPositionsResult) {
            const { itemIndex, ...result } = payload;
            const family = type === MESSAGE_TYPES.ozonAnalyticsResult ? 'analytics' : 'positions';
            await requestBroker.resolveOzonReportPackageItem(message.id, family, itemIndex, result);
            return;
        }

        if (type !== MESSAGE_TYPES.wbFetchResult) return;
        if (typeof payload.response?.error === 'string') {
            const code = typeof payload.response.code === 'string' ? payload.response.code : UNCLASSIFIED_FETCH_ERROR_CODE;
            const authorizationFailure = AUTHORIZATION_FETCH_ERROR_CODES.includes(code);
            const retryable = RETRYABLE_FETCH_ERROR_CODES.includes(code);
            const details = fetchFailureDetails(code, payload.response);
            const rejection = safeExternalToolError(
                {
                    code,
                    message: fetchFailureGuidance(code, details) ?? payload.response.error,
                    stage: authorizationFailure ? 'authorization' : 'execution',
                    retryable,
                },
                'Wildberries request failed.'
            );
            if (details) rejection.details = details;
            if (requestBroker.hasPendingSellerOperation(message.id)) requestBroker.rejectSellerOperation(message.id, rejection);
            else requestBroker.rejectFetch(message.id, rejection);
        } else if (requestBroker.hasPendingSellerOperation(message.id)) {
            requestBroker.resolveSellerOperation(message.id, payload.response);
        } else {
            requestBroker.resolveFetch(message.id, payload.response, { includeRequestId: true });
        }
    };

    // In-flight work ends with EXTENSION_DISCONNECTED and is never repeated: a repeated create could duplicate a report.
    const onSessionEnd = (session) => {
        if (!connections.disconnectExtension(session)) return false;
        requestBroker.rejectPendingRequests(extensionDisconnectedInFlightError());
        requestBroker.rejectPendingAuthorizations(extensionDisconnectedInFlightError());
        log('extension disconnected');
        broadcastStatus();
        return true;
    };

    return { openSession, handleMessage, onSessionEnd };
};
