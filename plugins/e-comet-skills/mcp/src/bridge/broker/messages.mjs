// The session messages this MCP process handles (refactor spec §6.3, §7.4): the broker's own frames (`session_state`,
// `session_end`, `broker_refusal`), the extension's error envelope routed by `id`, browser-job authorization and its
// release, and the diagnostic snapshot. Every other frame is a family operation's, which the caller handles. Hello, ping
// and pong live in broker.mjs.
import { safeExternalToolError } from './sanitize.mjs';
import { bridgeCauseError } from '../cause.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { hasOnlyOwnKeys, isNonNegativeSafeInteger, isOneOf, isRecord } from '../../shared/values.mjs';
import { DIAGNOSTIC_SNAPSHOT_CAPABILITY, DIAGNOSTIC_SNAPSHOT_V2_CAPABILITY, EXTENSION_TO_CLIENT_MESSAGE_TYPES, localMessage, MESSAGE_TYPES, OZON_ANALYTICS_CAPABILITY, OZON_PROMOTION_CAPABILITY, OZON_PROMOTION_PACKAGE_CAPABILITY, OZON_SEARCH_POSITIONS_CAPABILITY, PENDING_UPDATE_VERSION_PATTERN, } from '../../transport/extension/wire.mjs';
import { parseBrowserJobRejection } from '../../transport/failures/rejection.mjs';
// The frame checks the family validators share.
export const MAX_ID_LENGTH = 128;
// Parse boundary: every check below reads a frame the extension or the broker wrote, field by field.
const isTabReadiness = (value) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['ready', 'lastPingAgeMs']) &&
    typeof value.ready === 'boolean' &&
    (value.lastPingAgeMs === undefined || isNonNegativeSafeInteger(value.lastPingAgeMs));
// Version 2 is version 1 plus tab readiness and a downloaded update, served only behind diagnostic_snapshot_v2.
export const isDiagnosticSnapshot = (payload) => {
    if (!isRecord(payload) || payload.protocolVersion !== 2)
        return isDiagnosticSnapshotV1(payload);
    const { tabs, pendingUpdateVersion, ...base } = payload;
    return (isRecord(tabs) &&
        hasOnlyOwnKeys(tabs, ['wb', 'wbSeller', 'ozon']) &&
        ['wb', 'wbSeller', 'ozon'].every((key) => isTabReadiness(tabs[key])) &&
        (pendingUpdateVersion === undefined ||
            (typeof pendingUpdateVersion === 'string' && PENDING_UPDATE_VERSION_PATTERN.test(pendingUpdateVersion))) &&
        isDiagnosticSnapshotV1({ ...base, protocolVersion: 1 }));
};
const isPorts = (ports) => isRecord(ports) &&
    hasOnlyOwnKeys(ports, ['wb', 'wbSeller', 'ozon']) &&
    Object.keys(ports).length === 3 &&
    ['wb', 'wbSeller', 'ozon'].every((key) => typeof ports[key] === 'boolean' || ports[key] === 'unknown');
const isDiagnosticSnapshotV1 = (payload) => isRecord(payload) &&
    hasOnlyOwnKeys(payload, [
        'protocolVersion',
        'observedAt',
        'extensionVersion',
        'capabilities',
        'activationIdentity',
        'storageRead',
        'ports',
    ]) &&
    Object.keys(payload).length === 7 &&
    payload.protocolVersion === 1 &&
    typeof payload.observedAt === 'string' &&
    payload.observedAt.length <= 64 &&
    typeof payload.extensionVersion === 'string' &&
    payload.extensionVersion.length <= 128 &&
    Array.isArray(payload.capabilities) &&
    payload.capabilities.every((item) => typeof item === 'string' && item.length <= 128) &&
    isRecord(payload.activationIdentity) &&
    Object.keys(payload.activationIdentity).length === 1 &&
    isOneOf(['present', 'absent', 'unknown'], payload.activationIdentity.state) &&
    isRecord(payload.storageRead) &&
    Object.keys(payload.storageRead).length === 1 &&
    isOneOf(['passed', 'failed', 'unknown'], payload.storageRead.state) &&
    isPorts(payload.ports);
/**
 * One extension frame: a string id within the contract's bound, a type of the extension's vocabulary or of the caller's
 * operation types, and a payload object. Session payloads are checked here; `isValidOperationPayload(type, payload)`
 * checks the rest.
 */
export const parseServerMessage = (value, { operationTypes = [], isValidOperationPayload = () => true, } = {}) => {
    if (!isServerFrame(value, operationTypes))
        return { ok: false };
    const { payload, type } = value;
    if (type === MESSAGE_TYPES.browserJobAuthorizeResult &&
        payload.browserJobRejection !== undefined &&
        !parseBrowserJobRejection(isRecord(payload.error) ? payload.error.code : undefined, payload.browserJobRejection)) {
        return { ok: true, message: { ...value, payload: { ...payload, browserJobRejection: undefined } } };
    }
    if (type === MESSAGE_TYPES.diagnosticSnapshotResult && !isDiagnosticSnapshot(payload))
        return { ok: false };
    if (type === MESSAGE_TYPES.browserJobAuthorizationReleaseResult) {
        const validSuccess = payload.released === true && Object.keys(payload).length === 1;
        const validError = isRecord(payload.error) &&
            hasOnlyOwnKeys(payload, ['error']) &&
            Object.keys(payload).length === 1 &&
            hasOnlyOwnKeys(payload.error, ['code', 'message']) &&
            Object.keys(payload.error).length === 2 &&
            typeof payload.error.code === 'string' &&
            typeof payload.error.message === 'string';
        if (!validSuccess && !validError)
            return { ok: false };
    }
    if (!isValidOperationPayload(type, payload))
        return { ok: false };
    return { ok: true, message: value };
};
const isServerFrame = (value, operationTypes) => isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= MAX_ID_LENGTH &&
    typeof value.type === 'string' &&
    (EXTENSION_TO_CLIENT_MESSAGE_TYPES.includes(value.type) || operationTypes.includes(value.type)) &&
    isRecord(value.payload);
// The broker refused a frame this process sent, or the client refused one before writing it. Either way the request
// cannot reach the extension, and the cause is ours, not the seller's.
export const bridgeFrameRefusal = (refusalCode) => {
    const refusal = typeof refusalCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(refusalCode) ? refusalCode : 'UNKNOWN';
    const error = bridgeCauseError({ code: 'BRIDGE_FRAME_TOO_LARGE', refusal });
    error.details = { refusalCode: refusal };
    return error;
};
// Nothing reached the extension, so one retry is safe.
const DISCONNECTED_RETRY = 'Retry once; if it repeats, check local_bridge_status.';
export const extensionDisconnectedError = (what = 'The e-Comet extension is not connected to this agent.') => new ToolExecutionError('EXTENSION_DISCONNECTED', `${what} ${DISCONNECTED_RETRY}`, 'extension', true);
// The extension may have applied the request already, so this text never invites repeating a create.
const extensionDisconnectedInFlightError = () => new ToolExecutionError('EXTENSION_DISCONNECTED', 'The browser connection closed while the request was running; check local_bridge_status. A read can be repeated, ' +
    "but do not repeat a report create without the user's decision.", 'extension', true);
// A field the frame checks did not pin, read as a record; anything else reads as one with no fields.
const recordOf = (value) => (isRecord(value) ? value : {});
const isBrowserContext = (context) => isRecord(context) &&
    Object.keys(context).length === 2 &&
    typeof context.wbTabConnected === 'boolean' &&
    typeof context.sellerTabConnected === 'boolean';
/**
 * Runs today's extension session over a broker session. The broker owns the handshake: `openSession` receives the
 * extension facts it read from `hello_ack`, and the frames that follow are plain objects. `parseMessage` is the full
 * frame parser, `rejectOperation(id, error)` settles a family operation by its id when no session request owns it, and
 * `handleOperation(session, message)` receives every parsed frame that is no session message.
 */
export const createSessionMessages = ({ connections, requestBroker, log, broadcastStatus = () => undefined, parseMessage, rejectOperation, handleOperation, }) => {
    // Every correlated collection the extension (or the broker) can answer for one request id. Ownership decides the
    // collection: `a() || b()` would always touch the first and log a false late response for the others.
    const rejectRequest = (id, rejection) => requestBroker.hasPendingDiagnosticSnapshot?.(id)
        ? requestBroker.rejectDiagnosticSnapshot(id, rejection)
        : requestBroker.hasPendingAuthorization(id)
            ? requestBroker.rejectAuthorization(id, rejection)
            : requestBroker.hasPendingAuthorizationRelease(id)
                ? requestBroker.rejectAuthorizationRelease(id, rejection)
                : rejectOperation(id, rejection);
    const updateBrowserContext = (session, context) => {
        if (isBrowserContext(context) && connections.updateBrowserContext(session, context))
            broadcastStatus();
    };
    // Parse boundary: the facts the broker read from the extension's hello.
    const openSession = (session, facts, browserContext) => {
        if (connections.extensionSession && connections.extensionSession !== session)
            requestBroker.invalidateAuthorizationWork();
        const announced = isRecord(facts) ? facts : {};
        const capabilities = Array.isArray(announced.capabilities) ? announced.capabilities : [];
        const previous = connections.connectExtension(session, {
            browserJobSupported: capabilities.includes('browser_job'),
            ozonSellerPromotionReportSupported: capabilities.includes(OZON_PROMOTION_CAPABILITY),
            ozonSellerPromotionReportsSupported: capabilities.includes(OZON_PROMOTION_PACKAGE_CAPABILITY),
            ozonSellerAnalyticsReportSupported: capabilities.includes(OZON_ANALYTICS_CAPABILITY),
            ozonSearchPositionsSupported: capabilities.includes(OZON_SEARCH_POSITIONS_CAPABILITY),
            diagnosticSnapshotSupported: capabilities.includes(DIAGNOSTIC_SNAPSHOT_CAPABILITY),
            diagnosticSnapshotV2Supported: capabilities.includes(DIAGNOSTIC_SNAPSHOT_V2_CAPABILITY),
            version: typeof announced.extensionVersion === 'string' ? announced.extensionVersion : undefined,
        });
        previous?.close();
        // connectExtension resets the context of a new session, so the one a running broker already holds goes after it.
        if (isBrowserContext(browserContext))
            connections.updateBrowserContext(session, browserContext);
        log(`extension connected, version ${announced.extensionVersion || 'unknown'}`);
        broadcastStatus();
    };
    // Parse boundary: a frame as the broker client decoded it.
    const handleMessage = async (session, frame) => {
        const fields = isRecord(frame) ? frame : {};
        if (fields.type === 'session_state') {
            updateBrowserContext(session, fields.browserContext);
            return;
        }
        // The broker closes the connection right after it, and the close ends the session.
        if (fields.type === 'session_end')
            return;
        if (fields.type === 'broker_refusal') {
            if (typeof fields.id !== 'string') {
                log(`broker refused a frame without an id: ${fields.code}`);
                return;
            }
            const settled = rejectRequest(fields.id, bridgeFrameRefusal(fields.code));
            log(`broker refused message ${fields.id}: ${fields.code}${settled ? '' : ' (no pending request)'}`);
            return;
        }
        const parsed = parseMessage(frame);
        if (!parsed.ok) {
            // Коррелированный снимок неверной формы закрывает свой запрос сразу. Без этого он
            // оседал молча, e_comet_diagnose ждал полный таймаут и сообщал причину «unknown»
            // вместо наблюдаемого отказа по форме. Содержимое payload не логируем.
            if (fields.type === MESSAGE_TYPES.diagnosticSnapshotResult &&
                typeof fields.id === 'string' &&
                requestBroker.hasPendingDiagnosticSnapshot?.(fields.id)) {
                requestBroker.rejectDiagnosticSnapshot(fields.id, new ToolExecutionError('EXTENSION_DIAGNOSTIC_INVALID', 'The extension diagnostic snapshot did not match the negotiated diagnostic_snapshot_v1 shape.', 'extension', false));
                log(`rejected malformed diagnostic snapshot result ${fields.id}`);
            }
            return;
        }
        const { message } = parsed;
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
            const rejection = safeExternalToolError({ code, message: detail, stage: 'execution', retryable: false }, 'The extension rejected a local-agent message.');
            const settled = rejectRequest(message.id, rejection);
            log(`extension rejected message ${message.id}: ${code}${settled ? '' : ' (no pending request)'}`);
            return;
        }
        if (type === MESSAGE_TYPES.browserJobAuthorizeResult) {
            if (payload.error) {
                requestBroker.rejectAuthorization(message.id, safeExternalToolError({ ...recordOf(payload.error), browserJobRejection: payload.browserJobRejection }));
            }
            else if (!requestBroker.resolveAuthorization(message.id, payload.authorization)) {
                // A grant that arrives after its request timed out would hold the seller cabinet until the token expires.
                const authorizationId = recordOf(payload.authorization).authorizationId;
                if (typeof authorizationId === 'string' && authorizationId.length > 0) {
                    requestBroker
                        .requestAuthorizationRelease(authorizationId, ({ requestId }) => session.send(localMessage(requestId, MESSAGE_TYPES.browserJobAuthorizationRelease, { authorizationId })))
                        .catch((error) => log('failed to release a late browser-job authorization:', recordOf(error).code ?? recordOf(error).message));
                }
                else {
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
                requestBroker.rejectAuthorizationRelease(message.id, safeExternalToolError({ ...recordOf(payload.error), stage: 'extension', retryable: false }, 'The extension could not confirm browser job authorization release.'));
            }
            else {
                requestBroker.resolveAuthorizationRelease(message.id);
            }
            return;
        }
        await handleOperation(session, message);
    };
    // In-flight work ends with EXTENSION_DISCONNECTED and is never repeated: a repeated create could duplicate a report.
    const onSessionEnd = (session) => {
        if (!connections.disconnectExtension(session))
            return false;
        requestBroker.rejectPendingRequests(extensionDisconnectedInFlightError());
        requestBroker.rejectPendingAuthorizations(extensionDisconnectedInFlightError());
        log('extension disconnected');
        broadcastStatus();
        return true;
    };
    return { openSession, handleMessage, onSessionEnd };
};
