import { deliverReportResult } from './report-delivery.mjs';
import { randomUUID } from 'node:crypto';

import {
    ARTIFACT_STORAGE,
    BRIDGE_VERSION,
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    IMAGE_CONCURRENCY,
    LATEST_MCP_PROTOCOL_VERSION,
    MAX_IMAGE_BASKET,
    RUN_RESULT_RETENTION_MS,
    RUN_WAIT_MS,
    SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from './config.mjs';
import { createArtifactWriter } from './artifact-store.mjs';
import { BRIDGE_CODES, bridgeCauseError } from './bridge-cause.mjs';
import { prepareECometFeedback, submitECometFeedback } from './feedback-tools.mjs';
import { FeedbackPreparationError, feedbackPreparationFailure, feedbackSubmissionFailure } from './feedback-errors.mjs';
import { collectFeedbackDeviceEvidence } from './feedback-device-evidence.mjs';
import { collectExtensionLog as collectExtensionLogFromDisk, readExtensionLogRows as readExtensionLogRowsFromDisk } from './extension-log.mjs';
import { feedbackDiagnostics, safeFeedbackProperty, withFeedbackOperation } from './feedback-diagnostics.mjs';
import { feedbackArtifactIdSchema, feedbackDiagnosticsSchema, validateSchemaValue } from './tool-schemas.mjs';
import { executeAuthorizedBrowserJob, executeSellerReviewsJob, extractBrowserJobToken, validateAuthorizedJobLimits } from './browser-job.mjs';
import { mcpError, mcpResult, resourceLinkResult, textResult } from './mcp-protocol.mjs';
import { createJobWriter } from './result-store.mjs';
import { requireStorageTarget, resolveStorageLayout, StorageUnavailableError } from './storage-layout.mjs';
import {
    EXTENSION_UPDATE_URL,
    OZON_ANALYTICS_CAPABILITY,
    OZON_PROMOTION_PACKAGE_CAPABILITY,
    OZON_SEARCH_POSITIONS_CAPABILITY,
    PENDING_UPDATE_VERSION_PATTERN,
} from './extension-vocabulary.mjs';
import {
    executeOzonPromotionJob,
    executeOzonPromotionPackageJob,
    getOzonPromotionArtifactResource,
} from './ozon-promotion-job.mjs';
import { executeOzonAnalyticsJob, safeOzonAnalyticsToolError } from './ozon-analytics-job.mjs';
import { getOzonReportPackageArtifactResources } from './ozon-report-package-job.mjs';
import { rejectedOzonPackage } from './ozon-report-package-result.mjs';
import { parsePromotionPeriods } from './ozon-report-package-domain.mjs';
import { canonicalSearchPositionsRequest } from './ozon-search-positions-domain.mjs';
import { executeOzonSearchPositionsJob, rejectedOzonSearchPositions } from './ozon-search-positions-job.mjs';
import { parseAnalyticsDateRange } from './ozon-analytics-domain.mjs';
import { parseOzonPromotionPeriod } from './ozon-promotion-domain.mjs';
import { invalidArgumentsMessage, serverInstructions, tools, validateToolArguments } from './tool-catalog.mjs';
import {
    ozonExtensionOutdatedError,
    browserJobRejectionDetails,
    failureDetails,
    LOCAL_STORAGE_MESSAGES,
    OZON_EXTENSION_OUTDATED_REASON,
    ozonRouteUnavailableError,
    rejectionGuidance,
    safeOzonPromotionToolError,
    ToolExecutionError,
    toolFailure,
    withPendingUpdate,
} from './tool-errors.mjs';
import { createConcurrencyLimiter, discoverImageBasket, imageExists, runWithConcurrency } from './wb-domain.mjs';
import { sanitizeClientInfo } from './diagnostic-facts.mjs';
import { collectDiagnosis } from './diagnose.mjs';
import { createOperationDiagnostics, decorateOperationResult, operationFactsFromResult } from './operation-diagnostics.mjs';
import { describeToolContract } from './tool-contracts.mjs';
import { createRunRegistry } from './run-registry.mjs';

// No automatic repeat: the original call may have created marketplace reports (product principle 4).
const RUN_RESULT_UNAVAILABLE_MESSAGE = 'This run\'s result is no longer on this device: the run expired or e-Comet restarted. ' +
    'The original operation\'s outcome is unknown, which is not the same as failed. ' +
    'Do not repeat it automatically: tell the user, and run the original tool again only if the user asks.';

const OZON_AUTHORIZATION_ROUTE_CODES = new Set([
    'EXTENSION_DISCONNECTED',
    'BROWSER_JOB_AUTHORIZATION_TIMEOUT',
    'EXTENSION_UPDATE_REQUIRED',
]);

const storageCreationEvidence = new WeakMap();
const resultCreationFailure = (cause) => {
    const messages = LOCAL_STORAGE_MESSAGES;
    const code = safeFeedbackProperty(cause, 'code');
    const known = typeof code === 'string' && Object.hasOwn(messages, code);
    const error = new ToolExecutionError('LOCAL_STORAGE_FAILED', known ? messages[code] : 'The local result file could not be created.',
        'storage', true, { cause });
    if (known) storageCreationEvidence.set(error, { operation: 'create_result', systemCode: code });
    return error;
};

// The authorization lease is built by this process; a wrong shape is an e-Comet defect, not the seller's.
const leaseInvalid = () => new ToolExecutionError('BROWSER_JOB_LEASE_INVALID',
    'The local MCP received an invalid browser job authorization lease; this is an e-Comet defect. Offer to report it; do not repeat browser_job.',
    'local', false);
const OZON_LEASE_DEFECT = 'This is an e-Comet defect: offer to report it; do not request another authorization.';
// The one closed `details` a WB or Seller tool failure carries.
const errorDetails = (error) => {
    const details = storageCreationEvidence.get(error) ?? browserJobRejectionDetails(error) ?? failureDetails(error);
    return details ? { details } : {};
};

// A failing call waits at most this long for the snapshot that may name a downloaded update.
const PENDING_UPDATE_SNAPSHOT_TIMEOUT_MS = 3000;

// The e-Comet signer issues filters_by_query, so an extension refusing that job type (invalid_job/job_type) predates it. Without
// this an outdated extension reads as our defect. Older WB jobs are known to every supported extension. The refusal details are
// not passed on: DIAGNOSTICS.md reads invalid_job as our defect, which would contradict the update advice.
const outdatedExtensionForJobType = (toolName, error) => {
    const rejection = browserJobRejectionDetails(error)?.browserJobRejection;
    if (toolName !== 'wb_filters_by_query' || rejection?.reason !== 'invalid_job' || rejection.diagnostic !== 'job_type') return error;
    return new ToolExecutionError(
        'EXTENSION_UPDATE_REQUIRED',
        `The connected e-Comet extension does not support ${toolName}. Update the e-Comet extension at ${EXTENSION_UPDATE_URL}, then request a new authorization and retry.`,
        'extension',
        false,
        { cause: error }
    );
};

// Package capability floor, also enforced by scripts/extension_gate.py for publication.
// The released singular @1 tool intentionally retains its independent 1.5.6 floor.
const OZON_PACKAGE_MIN_EXTENSION_VERSION = '1.5.7';
const OZON_PACKAGE_FAMILIES = Object.freeze({
    promotion: { name: 'Ozon promotion report package', minVersion: OZON_PACKAGE_MIN_EXTENSION_VERSION,
        supportField: 'ozonSellerPromotionReportsSupported', capability: OZON_PROMOTION_PACKAGE_CAPABILITY, code: 'OZON_ROUTE_NOT_READY', stage: 'route' },
    analytics: { name: 'Ozon analytics report package', minVersion: OZON_PACKAGE_MIN_EXTENSION_VERSION,
        supportField: 'ozonSellerAnalyticsReportSupported', capability: OZON_ANALYTICS_CAPABILITY, code: 'OZON_ANALYTICS_CAPABILITY_UNAVAILABLE', stage: 'context' },
    // The first extension release announcing this capability is not served yet: its version is set here at release.
    positions: { name: 'Ozon search positions operation', minVersion: '1.5.13',
        supportField: 'ozonSearchPositionsSupported', capability: OZON_SEARCH_POSITIONS_CAPABILITY, code: 'OZON_SEARCH_POSITIONS_CAPABILITY_UNAVAILABLE', stage: 'context' },
});
// Only this dispatcher can attest a missing capability from bridge status.
// Remote error fields and message text cannot select the public stop reason.
const ozonPackageCapabilityErrors = new WeakSet();
const ozonPackageCapabilityFailure = (family, status) => {
    const { name, minVersion, supportField, capability, code, stage } = OZON_PACKAGE_FAMILIES[family];
    if (status?.extensionConnected !== true || status[supportField] !== false) return undefined;
    const error = new ToolExecutionError(
        code,
        `The connected extension does not announce ${capability} and cannot run this ${name}. ` +
            `Update the e-Comet extension${minVersion ? ` to ${minVersion} or newer` : ''} at ${EXTENSION_UPDATE_URL}, then request a new authorization and retry.`,
        stage,
        false
    );
    ozonPackageCapabilityErrors.add(error);
    return error;
};

// The host hook failed, not the marketplace: another browser_job only spends one more authorization the same way.
const missingHandoff = () => new ToolExecutionError('BROWSER_JOB_HANDOFF_REQUIRED',
    'Browser authorization handoff is required: the host plugin hook did not pass the signed authorization to this tool. ' +
    'In Codex this usually means the e-Comet hooks await approval again after a plugin update. ' +
    'For an mcp__remote-devices__ tool, pass trigger_url from the same browser_job result, unchanged, as triggerUrl and call this tool once more. ' +
    'Do not repeat browser_job until that is resolved.', 'handoff', false);

export const classifyOzonAuthorizationFailure = (error, status, packageFamily) => {
    // A trigger URL that is not a browser job is the same failed handoff as a missing one.
    if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_HANDOFF_REQUIRED') {
        return new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The trusted browser-job hook did not provide Ozon authorization.',
            'authorization', false, { cause: error });
    }
    // No broker answered, or the broker refused the authorization frame: nothing reached Ozon. The contract pins only
    // the authorization stage, so the cause and its step ride in details.bridgeCode and the message.
    if (error instanceof ToolExecutionError && BRIDGE_CODES.includes(error.code)) {
        const rejected = new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', error.message, 'authorization', false, { cause: error });
        rejected.details = { bridgeCode: error.code };
        return rejected;
    }
    const familySpec = packageFamily === undefined ? undefined : OZON_PACKAGE_FAMILIES[packageFamily];
    if (packageFamily !== undefined) {
        const capabilityFailure = ozonPackageCapabilityFailure(packageFamily, status);
        if (capabilityFailure) return capabilityFailure;
    }
    if (packageFamily === undefined && error instanceof ToolExecutionError && OZON_AUTHORIZATION_ROUTE_CODES.has(error.code)
        && status?.extensionConnected === true && status.ozonSellerPromotionReportSupported === false) {
        return ozonExtensionOutdatedError(status.extensionVersion);
    }
    if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT') {
        // No Seller probe has occurred. A missing authorization response cannot
        // establish a tab/company prerequisite or authorize repeating a create.
        return new ToolExecutionError('OZON_AUTHORIZATION_REJECTED',
            'The Ozon report authorization response timed out. The cause is not established; no report operation was dispatched by this call. ' +
            'Inspect local_bridge_status and include this authorization failure in a bug report if it persists.',
            'authorization', false, { cause: error });
    }
    if (error instanceof ToolExecutionError && OZON_AUTHORIZATION_ROUTE_CODES.has(error.code)) {
        // The browser connection closed under the authorization; a page cannot reopen it, status names the cause.
        if (error.code === 'EXTENSION_DISCONNECTED') return ozonRouteUnavailableError('disconnected');
        if (familySpec !== undefined) {
            return new ToolExecutionError(
                'OZON_ROUTE_NOT_READY',
                'The Ozon report authorization route did not complete; its cause is not established. ' +
                    `Ensure e-Comet extension ${familySpec.minVersion ? `${familySpec.minVersion} or newer ` : ''}is enabled in the same browser profile, refresh an authenticated Ozon Seller page, then request a new authorization and retry.`,
                'route', false
            );
        }
        if (status?.extensionConnected === true && status.ozonSellerPromotionReportSupported === false) {
            return ozonExtensionOutdatedError(status.extensionVersion);
        }
        return ozonRouteUnavailableError(error.code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT' ? 'timeout' : 'unavailable');
    }
    let message = familySpec === undefined ? 'The Ozon promotion report authorization was rejected.'
        : `The ${familySpec.name} authorization was rejected.`;
    if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_REJECTED'
        && error.message === 'Extension is not authenticated with e-Comet') {
        message = 'The e-Comet extension is not signed in. Open the e-Comet extension and sign in to the same e-Comet account used for this request.';
    } else if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_ACCOUNT_MISMATCH') {
        message = 'The e-Comet extension is signed in to a different e-Comet account. Open the e-Comet extension and sign in to the same e-Comet account used for this request.';
    }
    const rejection = browserJobRejectionDetails(error);
    const classified = new ToolExecutionError(
        'OZON_AUTHORIZATION_REJECTED',
        rejectionGuidance(rejection?.browserJobRejection) ?? message,
        'authorization',
        false,
        { cause: error }
    );
    if (rejection) classified.details = rejection;
    return classified;
};

export const createMcpMessageHandler = ({
    getBridgeStatus,
    // Connects to a live broker, or waits for one about to appear, and otherwise names why none answers.
    ensureBroker,
    // Refreshes policy and, when selected, returns that pass's profile probe for the same diagnosis.
    refreshBridgeFacts = async (_options = {}) => undefined,
    // Called once the initialize result is sent: the bridge starts looking for a broker only after the handshake.
    onInitialized = () => undefined,
    // Non-blocking: starts a broker connect attempt unless one is in flight. Applied once at the tools/call dispatch
    // point to every tool declaring `needsBridge`, so a call that returns early still starts it.
    kick = () => undefined,
    requestBrowserJobAuthorization,
    requestExtensionDiagnosticSnapshot = undefined,
    // Whether the connected extension announced diagnostic_snapshot_v2.
    diagnosticSnapshotV2Ready = () => false,
    artifactStorageTarget = ARTIFACT_STORAGE,
    reportOutputDirectory = undefined,
    createSellerArtifactWriter = createArtifactWriter,
    createOzonArtifactWriter = createArtifactWriter,
    renderOzonResult = resourceLinkResult,
    sendError = mcpError,
    sendResult: sendMcpResult = mcpResult,
    runWaitMs = RUN_WAIT_MS,
    runRetentionMs = RUN_RESULT_RETENTION_MS,
    createJobWriter: createWriter = createJobWriter,
    probeImageExists = imageExists,
    prepareFeedback = prepareECometFeedback,
    submitFeedback = submitECometFeedback,
    shutdownSignal,
    log = (..._args) => undefined,
    now = Date.now,
    randomUUID: createUuid = randomUUID,
    storageLayout = resolveStorageLayout(),
    collectInstallation = undefined,
    probeExtensionInstall = undefined,
    collectHookPermissions = undefined,
    collectExtensionLog = undefined,
    readExtensionLogRows = undefined,
    extensionLogTarget = () => ({}),
    // A runtime diagnosis's fresh read of the extension's log, which status then judges instead of the one it kept.
    replaceExtensionLog = (_evidence) => undefined,
}) => {
    let clientInfo = null;
    let negotiatedProtocolVersion = null;
    let clientObservedAt = null;
    const currentBridgeStatus = () => getBridgeStatus({ clientInfo, protocolVersion: negotiatedProtocolVersion, clientObservedAt });
    // The extension's own log is found through the same profile probe, so an injected probe keeps it off this machine. It
    // is the log of the browser the runtime names: the connected extension's own, else the chooser's pick under the policies.
    const logReaderOptions = () => ({ now, ...(probeExtensionInstall ? { probeExtensionInstall } : {}), ...extensionLogTarget() });
    const collectLog = collectExtensionLog ?? (() => collectExtensionLogFromDisk(logReaderOptions()));
    const readLogRows = readExtensionLogRows ?? (() => readExtensionLogRowsFromDisk(logReaderOptions()));
    // Feedback preparation carries the passive status plus bounded read-only evidence; every probe is
    // injectable so tests never read this machine's packages, profiles or Codex configuration.
    const collectDeviceEvidence = () => collectFeedbackDeviceEvidence({
        getBridgeStatus: currentBridgeStatus, requestExtensionDiagnosticSnapshot, now, collectExtensionLog: collectLog,
        ...(collectInstallation ? { collectInstallation } : {}),
        ...(probeExtensionInstall ? { probeExtensionInstall } : {}),
        ...(collectHookPermissions ? { collectHookPermissions } : {}),
    });
    const operationDiagnostics = createOperationDiagnostics({ now, randomUUID: createUuid });
    // A capability the extension lacks while its update is downloaded: the version 2 snapshot names that update.
    const withDownloadedUpdate = async (error) => {
        const missingCapability = error instanceof ToolExecutionError && (error.code === 'EXTENSION_UPDATE_REQUIRED' ||
            ozonPackageCapabilityErrors.has(error) || error.details?.reason === OZON_EXTENSION_OUTDATED_REASON);
        // Only a version 2 snapshot can name the update; an older extension is not asked.
        if (!missingCapability || !diagnosticSnapshotV2Ready() || typeof requestExtensionDiagnosticSnapshot !== 'function') return error;
        try {
            const version = (await requestExtensionDiagnosticSnapshot(PENDING_UPDATE_SNAPSHOT_TIMEOUT_MS))?.pendingUpdateVersion;
            return typeof version === 'string' && PENDING_UPDATE_VERSION_PATTERN.test(version) ? withPendingUpdate(error, version) : error;
        } catch {
            return error;
        }
    };
    const runs = createRunRegistry({ now, randomUUID: createUuid, waitMs: runWaitMs, retentionMs: runRetentionMs });
    // A bridge tool's handler answers to its run key; every other answer goes out as before.
    const sendResult = (id, result) => runs.settle(id, result) || sendMcpResult(id, result);
    // The captured answer goes out unchanged. A handler failure is rethrown, so the transport answers -32603 as it
    // would without the wait.
    // Resolves true when the final answer went out, false for a "running" answer.
    const answerRun = async (id, run) => {
        const outcome = await runs.wait(run);
        if (outcome?.error) throw outcome.error;
        sendMcpResult(id, outcome ? outcome.result : textResult(runs.runningAnswer(run)));
        return Boolean(outcome);
    };
    const sendOperationResult = async (id, toolName, result) => {
        let decorated = result;
        try {
            const receipt = operationDiagnostics.record(operationFactsFromResult(toolName, result));
            decorated = decorateOperationResult(result, receipt);
        } catch { /* A diagnostic must never replace the business result. */ }
        return sendResult(id, decorated);
    };
    // Scope revocation occurs before the release route's acknowledgement can suspend, so callers can safely
    // deliver a terminal result without letting an extension round trip delay it.
    const releaseAuthorizationInBackground = (lease, context) => {
        if (!lease) return;
        const reportFailure = (releaseError) => {
            let message;
            try {
                message = typeof releaseError?.message === 'string' ? releaseError.message : String(releaseError);
            } catch {
                message = 'unknown release failure';
            }
            console.error(`[McpDispatcher] Failed to release browser-job authorization ${context}:`, message);
        };
        try {
            void Promise.resolve(lease.release()).catch(reportFailure);
        } catch (releaseError) {
            reportFailure(releaseError);
        }
    };

    const handleBrowserJob = async (id, toolName, expectedJobType, args = {}) => {
        const triggerUrl = args.triggerUrl;
        let productLimitPerScope = DEFAULT_RETURNED_PRODUCTS;
        if (expectedJobType === 'search_by_query') productLimitPerScope = args.productLimitPerQuery ?? DEFAULT_RETURNED_PRODUCTS;
        else if (expectedJobType === 'recommendations_by_product') {
            productLimitPerScope = args.productLimitPerSource ?? DEFAULT_RETURNED_PRODUCTS;
        }
        const productNmIds = args.productNmIds;
        const validation = validateToolArguments(toolName, args);
        if (!validation.ok) {
            await sendOperationResult(
                id,
                toolName,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'INVALID_TOOL_ARGUMENTS',
                            invalidArgumentsMessage(toolName, validation),
                            'arguments',
                            false
                        )
                    ),
                    true
                )
            );
            return;
        }
        if (typeof triggerUrl !== 'string' || !triggerUrl) {
            await sendOperationResult(
                id,
                toolName,
                textResult(
                    toolFailure(missingHandoff()),
                    true
                )
            );
            return;
        }
        let writer;
        let authorizationLease;
        const releaseAuthorization = (context) => {
            if (!authorizationLease) return;
            const currentLease = authorizationLease;
            authorizationLease = undefined;
            releaseAuthorizationInBackground(currentLease, context);
        };
        try {
            const route = await ensureBroker();
            if (!route.ok) throw bridgeCauseError(route);
            const token = extractBrowserJobToken(triggerUrl);
            authorizationLease = await requestBrowserJobAuthorization(token);
            const authorization = authorizationLease?.authorization;
            if (
                !authorizationLease ||
                typeof authorizationLease.requestWbFetch !== 'function' ||
                typeof authorizationLease.release !== 'function' ||
                !authorization ||
                typeof authorization.authorizationId !== 'string' ||
                typeof authorization.jobType !== 'string' ||
                !authorization.job ||
                typeof authorization.job !== 'object'
            ) {
                throw leaseInvalid();
            }
            if (authorization.jobType !== expectedJobType) {
                throw new ToolExecutionError(
                    'BROWSER_JOB_TYPE_MISMATCH',
                    `Signed ${authorization.jobType} job cannot be executed as ${toolName}.`,
                    'authorization',
                    false
                );
            }
            // Fail descriptor validation before creating an empty result file; the executor repeats this for direct callers.
            validateAuthorizedJobLimits(authorization);
            try {
                writer = await createWriter(authorization.job.jobId);
            } catch (error) {
                if (error instanceof StorageUnavailableError) throw error;
                throw resultCreationFailure(error);
            }
            const result = await executeAuthorizedBrowserJob({
                authorization,
                requestWbFetch: authorizationLease.requestWbFetch,
                writer,
                productLimitPerScope,
                productNmIds,
            });
            releaseAuthorization('after job completion');
            const writeErrors = await writer.close();
            await sendOperationResult(
                id,
                toolName,
                textResult(
                    {
                        ...result,
                        ...(writer.published !== false ? { resultPath: writer.resultPath } : {}),
                        ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
                    },
                    !result.ok
                )
            );
        } catch (caught) {
            releaseAuthorization('after job failure');
            const error = await withDownloadedUpdate(outdatedExtensionForJobType(toolName, caught));
            let partialResult = {};
            if (writer) {
                const writeErrors = await writer.close().catch(() => []);
                partialResult = {
                    ...(writer.published !== false && writer.persistedBytes > 0 ? { resultPath: writer.resultPath } : {}),
                    ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((writeError) => writeError.message) } : {}),
                };
            }
            if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_DESCRIPTOR_INVALID' && error.cause instanceof Error) {
                log('rejected signed browser job descriptor:', error.cause.message);
            }
            await sendOperationResult(
                id,
                toolName,
                textResult(
                    {
                        ...toolFailure(error, {
                            code: 'BROWSER_JOB_EXECUTION_FAILED',
                            message: 'The authorized Wildberries job could not be completed.',
                            stage: 'execution',
                            retryable: false,
                        }),
                        // Public-only evidence: shared toolFailure is a strict serializer and
                        // must not gain these extra keys.
                        ...errorDetails(error),
                        ...partialResult,
                    },
                    true
                )
            );
        } finally {
            try { await writer?.release?.(); }
            catch { log('result ownership cleanup failed after browser job response; result remains protected'); }
        }
    };

    const feedbackPrepareFailure = (error) => {
        const failure = feedbackPreparationFailure(error);
        console.error('[McpDispatcher] Feedback preparation failed:', JSON.stringify(failure.error));
        return failure;
    };

    const handleFeedbackPrepare = async (id, args = {}) => {
        if (!validateToolArguments('prepare_e_comet_feedback', args).ok) {
            sendOperationResult(id, 'prepare_e_comet_feedback', textResult(feedbackPrepareFailure(new FeedbackPreparationError('FEEDBACK_INPUT_INVALID')), true));
            return;
        }
        let operation = 'prepare';
        try {
            const prepared = await prepareFeedback(args, { getBridgeStatus: collectDeviceEvidence, readExtensionLogRows: readLogRows, clientName: clientInfo?.name });
            operation = 'prepare_result';
            const reportResource = prepared?.reportResource;
            if (!reportResource || reportResource.name !== 'report.md') throw new Error('missing report resource');
            sendOperationResult(id, 'prepare_e_comet_feedback', resourceLinkResult(prepared, JSON.stringify(prepared), [reportResource]));
        } catch (error) {
            sendOperationResult(id, 'prepare_e_comet_feedback', textResult(feedbackPrepareFailure(operation === 'prepare_result' ? withFeedbackOperation(error, operation) : error), true));
        }
    };

    const handleFeedbackSubmit = async (id, args = {}) => {
        if (!validateToolArguments('submit_e_comet_feedback', args).ok) {
            // The authored artifactId is carried through when it is usable, so a caller can attribute the refusal.
            sendOperationResult(id, 'submit_e_comet_feedback', textResult({
                ok: false,
                status: 'failed',
                ...(validateSchemaValue(safeFeedbackProperty(args, 'artifactId'), feedbackArtifactIdSchema) ? { artifactId: args.artifactId } : {}),
                error: { code: 'UPLOAD_GRANT_INVALID', message: 'The feedback upload grant is invalid or has expired.', stage: 'grant', retryable: false, details: feedbackDiagnostics(undefined, 'input_validation') },
            }, true));
            return;
        }
        try {
            const submitted = await submitFeedback(args);
            if (!submitted.ok) {
                const details = safeFeedbackProperty(safeFeedbackProperty(submitted, 'error'), 'details');
                if (validateSchemaValue(details, feedbackDiagnosticsSchema)) console.error('[McpDispatcher] Feedback submission failed:', JSON.stringify(details));
            }
            sendOperationResult(id, 'submit_e_comet_feedback', textResult(submitted, !submitted.ok));
        } catch (error) {
            const failure = feedbackSubmissionFailure(error, args.artifactId);
            console.error('[McpDispatcher] Feedback submission failed:', JSON.stringify(failure.error));
            sendOperationResult(id, 'submit_e_comet_feedback', textResult(failure, true));
        }
    };

    const handleProductImages = async (id, args = {}) => {
        const nmIds = args.nmIds;
        const maxPhotos = args.maxPhotos ?? DEFAULT_IMAGE_PHOTOS;
        const maxBasket = args.maxBasket ?? MAX_IMAGE_BASKET;
        const size = args.size ?? 'big';
        const timeout = args.timeout ?? 5000;
        const validation = validateToolArguments('wb_product_images', args);
        if (!validation.ok) {
            await sendOperationResult(
                id,
                'wb_product_images',
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'INVALID_TOOL_ARGUMENTS',
                            invalidArgumentsMessage('wb_product_images', validation),
                            'arguments',
                            false
                        )
                    ),
                    true
                )
            );
            return;
        }

        const jobId = randomUUID();
        let writer;
        let writerClosePromise;
        const closeWriter = async () => {
            if (!writer) return [];
            writerClosePromise ??= writer.close();
            return writerClosePromise;
        };
        try {
            try { writer = await createWriter(jobId); }
            catch (error) {
                if (error instanceof StorageUnavailableError) throw error;
                throw resultCreationFailure(error);
            }
            const currentWriter = writer;
            const resultPath = writer.resultPath;
            let rateLimitError;
            const stopProbes = new AbortController();
            const probeSignal = shutdownSignal ? AbortSignal.any([shutdownSignal, stopProbes.signal]) : stopProbes.signal;
            const limitedImageExists = createConcurrencyLimiter(IMAGE_CONCURRENCY, async (url, requestTimeout, markStarted) => {
                if (rateLimitError) throw rateLimitError;
                markStarted();
                try { return await probeImageExists(url, requestTimeout, probeSignal); }
                catch (error) {
                    if (error?.code === 'WB_IMAGE_RATE_LIMITED') {
                        rateLimitError ??= error;
                        stopProbes.abort();
                    }
                    throw rateLimitError ?? error;
                }
            });
            const imageError = (error) => ({
                code: error?.code === 'WB_IMAGE_RATE_LIMITED' ? 'WB_IMAGE_RATE_LIMITED' : 'WB_IMAGE_PROBE_FAILED',
                message: error?.code === 'WB_IMAGE_RATE_LIMITED'
                    ? 'Wildberries limited image requests. Further probes were skipped; found URLs are preserved. Do not retry automatically.'
                    : 'The image lookup could not establish whether all requested images exist.',
                stage: 'images', retryable: false,
            });
            const products = await runWithConcurrency(nmIds, IMAGE_CONCURRENCY, async (nmId) => {
                const imageUrls = [];
                let discovered;
                let failure;
                let started = false;
                const probe = (url, requestTimeout) => limitedImageExists(url, requestTimeout, () => { started = true; });
                const skipped = Boolean(rateLimitError);
                try {
                    if (skipped) throw rateLimitError;
                    discovered = await discoverImageBasket(nmId, maxBasket, size, timeout, probe);
                    if (discovered) {
                        // Discovery already proved photo 1 exists; retain it even if later probes stop.
                        imageUrls.push(`${discovered.baseUrl}/${size}/1.webp`);
                        const outcomes = await runWithConcurrency(
                            Array.from({ length: maxPhotos - 1 }, (_, index) => index + 2), IMAGE_CONCURRENCY,
                            async (photo) => {
                                const url = `${discovered.baseUrl}/${size}/${photo}.webp`;
                                try { return (await probe(url, timeout)) ? { url } : {}; }
                                catch (error) { return { error }; }
                            });
                        for (const outcome of outcomes) {
                            if (outcome.url) imageUrls.push(outcome.url);
                            if (outcome.error) failure ??= outcome.error;
                        }
                    }
                } catch (error) { failure = error; }
                const result = {
                    nmId,
                    status: failure ? (!started ? 'skipped' : imageUrls.length ? 'partial' : 'failed')
                        : imageUrls.length ? 'ok' : 'not_found',
                    ...(discovered ? { basket: discovered.basket, baseUrl: discovered.baseUrl } : {}),
                    imageUrls,
                    ...(failure ? { error: imageError(failure) } : {}),
                };
                await currentWriter.append(result);
                return result;
            });
            const writeErrors = await closeWriter();
            const succeeded = products.filter((product) => product.imageUrls.length > 0).length;
            const complete = products.every(product => product.status === 'ok');
            const hasErrors = products.some(product => product.error);
            // A completed probe with only not_found rows is a normal negative result; only execution failures set MCP isError below.
            await sendOperationResult(
                id,
                'wb_product_images',
                textResult({
                    ok: succeeded > 0,
                    status: complete ? 'done' : succeeded > 0 ? 'partial' : 'failed',
                    ...(rateLimitError ? { stopReason: 'rate_limited' } : {}),
                    jobId,
                    total: products.length,
                    succeeded,
                    failed: products.length - succeeded,
                    size,
                    products,
                    ...(writer.published !== false ? { resultPath } : {}),
                    ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
                }, hasErrors)
            );
        } catch (error) {
            const partialWriter = writer;
            const writeErrors = await closeWriter().catch(() => []);
            const partialResult = partialWriter
                ? {
                      ...(partialWriter.published !== false && partialWriter.persistedBytes > 0 ? { resultPath: partialWriter.resultPath } : {}),
                      ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((writeError) => writeError.message) } : {}),
                  }
                : {};
            await sendOperationResult(
                id,
                'wb_product_images',
                textResult(
                    {
                        ...toolFailure(error, {
                            code: 'IMAGE_LOOKUP_FAILED',
                            message: 'The Wildberries image lookup could not be completed.',
                            stage: 'images',
                            retryable: true,
                        }),
                        ...(storageCreationEvidence.has(error) ? { details: storageCreationEvidence.get(error) } : {}),
                        ...partialResult,
                    },
                    true
                )
            );
        } finally {
            try { await writer?.release?.(); }
            catch { log('result ownership cleanup failed after image lookup response; result remains protected'); }
        }
    };

    const handleSellerReviewsExport = async (id, args = {}) => {
        const toolName = 'wb_seller_reviews';
        const validation = validateToolArguments(toolName, args);
        if (!validation.ok) {
            sendOperationResult(
                id,
                'wb_seller_reviews',
                textResult(
                    toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage(toolName, validation), 'arguments', false)),
                    true
                )
            );
            return;
        }
        const triggerUrl = args.triggerUrl;
        if (typeof triggerUrl !== 'string' || !triggerUrl) {
            sendOperationResult(
                id,
                'wb_seller_reviews',
                textResult(
                    toolFailure(missingHandoff()),
                    true
                )
            );
            return;
        }
        let authorizationLease;
        let terminalResult;
        let sellerResult;
        let sellerArtifacts = [];
        // One byte counter per call: every writer of this export shares it (spec §4.2).
        const jobBudget = { bytes: 0 };
        try {
            requireStorageTarget(artifactStorageTarget, 'marketplace-artifacts');
            const route = await ensureBroker();
            if (!route.ok) throw bridgeCauseError(route);
            authorizationLease = await requestBrowserJobAuthorization(extractBrowserJobToken(triggerUrl));
            const authorization = authorizationLease?.authorization;
            if (
                !authorization ||
                typeof authorization.authorizationId !== 'string' ||
                authorization.jobType !== 'seller_reviews' ||
                !authorization.job ||
                typeof authorizationLease.requestSellerOperation !== 'function' ||
                typeof authorizationLease.release !== 'function'
            ) {
                if (authorization?.jobType && authorization.jobType !== 'seller_reviews') {
                    throw new ToolExecutionError(
                        'BROWSER_JOB_TYPE_MISMATCH',
                        `Signed ${authorization.jobType} job cannot be executed as ${toolName}.`,
                        'authorization',
                        false
                    );
                }
                throw leaseInvalid();
            }
            sellerResult = await executeSellerReviewsJob({
                authorization,
                requestSellerOperation: authorizationLease.requestSellerOperation,
                createArtifactWriter: createSellerArtifactWriter,
                jobBudget,
            });
            sellerArtifacts = sellerResult.exports.flatMap((item) =>
                item.status === 'complete' && 'artifact' in item ? [item.artifact] : []
            );
            const summary = `Seller review export ${sellerResult.status}: ${sellerArtifacts.length} of ${sellerResult.exports.length} XLSX artifact(s) available.`;
            terminalResult = resourceLinkResult(sellerResult, summary, sellerArtifacts, !sellerResult.ok);
        } catch (caught) {
            const error = await withDownloadedUpdate(caught);
            terminalResult = textResult(
                { ...toolFailure(error, {
                    code: 'SELLER_REVIEWS_EXPORT_FAILED', message: 'The authorized seller review export could not be completed.',
                    stage: 'execution', retryable: false,
                }), ...errorDetails(error) },
                true
            );
        }
        try {
            await authorizationLease?.release?.();
        } catch (error) {
            const failure = toolFailure(
                new ToolExecutionError(
                    'SELLER_AUTHORIZATION_RELEASE_FAILED',
                    'The seller organization could not be restored safely after the export.',
                    'extension',
                    false,
                    { cause: error }
                )
            );
            // A restore failure must not erase the per-export report: the workbooks exist and only the
            // export list says which filters each one covers. Carry the failure alongside that report.
            if (sellerResult) {
                terminalResult = resourceLinkResult(
                    { ...sellerResult, ok: false, releaseError: failure },
                    `Seller review export ${sellerResult.status}: ${sellerArtifacts.length} of ${sellerResult.exports.length} XLSX artifact(s) available, but seller cabinet restoration failed.`,
                    sellerArtifacts,
                    true
                );
            } else {
                terminalResult = textResult(failure, true);
            }
        }
        sendOperationResult(id, 'wb_seller_reviews', await deliverReportResult(terminalResult, sellerArtifacts, reportOutputDirectory));
    };

    // Диагноз строится только по статусу, который явно сообщил про возможность. Статус без этого
    // поля (нет расширения, старый соседний процесс, тестовая заглушка) оставляет прежнее поведение.
    const currentOzonStatus = () => {
        try {
            return getBridgeStatus();
        } catch {
            return undefined;
        }
    };

    const ozonExtensionOutdated = (status) => {
        if (status?.extensionConnected !== true || status.ozonSellerPromotionReportSupported !== false) return undefined;
        return ozonExtensionOutdatedError(status.extensionVersion);
    };

    const handleOzonPromotionReport = async (id, args = {}) => {
        const toolName = 'ozon_seller_promotion_report';
        const dateFrom = args?.dateFrom;
        const dateTo = args?.dateTo;
        // One byte counter per call: every writer of this export shares it (spec §4.2).
        const jobBudget = { bytes: 0 };
        let authorizationLease;
        let terminalResult;
        let reportArtifacts = [];
        let periodValidated = false;
        const failureResult = (error) => {
            let normalized;
            try {
                if (error instanceof ToolExecutionError) normalized = safeOzonPromotionToolError(error);
                else if (error instanceof StorageUnavailableError) normalized = error;
            } catch {
                normalized = undefined;
            }
            const safeError = normalized
                ? {
                      code: normalized.code,
                      message: normalized.message,
                      stage: normalized.stage,
                      retryable: false,
                      ...(normalized instanceof ToolExecutionError && normalized.details !== undefined
                          ? { details: normalized.details }
                          : {}),
                  }
                : { code: 'ARTIFACT_REJECTED', message: 'The Ozon promotion report could not be completed safely.', stage: 'artifact', retryable: false };
            return {
                ok: false,
                status: 'failed',
                jobType: 'ozon_seller_promotion_report',
                ...(periodValidated ? { dateFrom, dateTo } : {}),
                error: safeError,
            };
        };
        try {
            const validation = validateToolArguments(toolName, args);
            if (!validation.ok) throw new ToolExecutionError('PREFLIGHT_FAILED', invalidArgumentsMessage(toolName, validation), 'preflight', false);
            try {
                parseOzonPromotionPeriod(dateFrom, dateTo);
            } catch (error) {
                throw new ToolExecutionError('PREFLIGHT_FAILED', 'The Ozon promotion period is invalid.', 'preflight', false, {
                    cause: error,
                });
            }
            periodValidated = true;
            if (typeof args.triggerUrl !== 'string' || !args.triggerUrl) {
                throw new ToolExecutionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    'The trusted browser-job hook did not provide Ozon authorization.',
                    'authorization',
                    false
                );
            }
            requireStorageTarget(artifactStorageTarget, 'marketplace-artifacts');
            // Проверка до авторизации, а не только на маршрутизации. Расширение без объявленной
            // возможности отвергает подписанное задание Ozon как неизвестный тип ещё в ответе на
            // browser_job_authorize, поэтому до маршрута дело не доходит и пользователь получил бы
            // отказ авторизации вместо диагноза. Заодно не тратится одноразовая подписанная
            // авторизация на заведомо неисполнимую операцию.
            const outdatedExtension = ozonExtensionOutdated(currentOzonStatus());
            if (outdatedExtension) throw outdatedExtension;
            const route = await ensureBroker();
            if (!route.ok) throw classifyOzonAuthorizationFailure(bridgeCauseError(route), currentOzonStatus());
            // WHY: readiness can attach an older extension after the first snapshot; do not spend its signed authorization.
            const readyExtensionOutdated = ozonExtensionOutdated(currentOzonStatus());
            if (readyExtensionOutdated) throw readyExtensionOutdated;
            try {
                authorizationLease = await requestBrowserJobAuthorization(extractBrowserJobToken(args.triggerUrl));
            } catch (error) {
                throw classifyOzonAuthorizationFailure(error, currentOzonStatus());
            }
            if (
                !authorizationLease ||
                typeof authorizationLease.requestOzonPromotionReport !== 'function' ||
                typeof authorizationLease.release !== 'function'
            ) {
                throw new ToolExecutionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    `The extension returned an invalid Ozon promotion authorization. ${OZON_LEASE_DEFECT}`,
                    'authorization',
                    false
                );
            }
            const result = await executeOzonPromotionJob({
                authorization: authorizationLease.authorization,
                dateFrom,
                dateTo,
                requestOzonPromotionReport: authorizationLease.requestOzonPromotionReport,
                createArtifactWriter: createOzonArtifactWriter,
                jobBudget,
                now,
            });
            reportArtifacts = [getOzonPromotionArtifactResource(result)];
            terminalResult = renderOzonResult(
                result,
                `Ozon Seller promotion report complete: one XLSX workbook for ${dateFrom} through ${dateTo}.`,
                [getOzonPromotionArtifactResource(result)]
            );
        } catch (error) {
            terminalResult = textResult(failureResult(await withDownloadedUpdate(error)), true);
        } finally {
            const currentLease = authorizationLease;
            authorizationLease = undefined;
            releaseAuthorizationInBackground(currentLease, 'after Ozon promotion report completion');
        }
        sendOperationResult(id, 'ozon_seller_promotion_report', await deliverReportResult(terminalResult, reportArtifacts, reportOutputDirectory));
    };

    // Every Ozon package family refuses an unannounced capability before and after readiness, so an older
    // extension never spends the one-use signed authorization; the caller's own preflight runs in between.
    const authorizeOzonPackage = async (family, triggerUrl, beforeWait = () => undefined) => {
        if (typeof triggerUrl !== 'string' || !triggerUrl) {
            throw new ToolExecutionError(
                'OZON_AUTHORIZATION_REJECTED',
                'The trusted browser-job hook did not provide Ozon authorization.',
                'authorization',
                false
            );
        }
        const unavailableBeforeWait = ozonPackageCapabilityFailure(family, currentOzonStatus());
        beforeWait();
        if (unavailableBeforeWait) throw unavailableBeforeWait;
        const route = await ensureBroker();
        if (!route.ok) throw classifyOzonAuthorizationFailure(bridgeCauseError(route), currentOzonStatus(), family);
        const unavailableAfterWait = ozonPackageCapabilityFailure(family, currentOzonStatus());
        if (unavailableAfterWait) throw unavailableAfterWait;
        let lease;
        try {
            lease = await requestBrowserJobAuthorization(extractBrowserJobToken(triggerUrl));
        } catch (error) {
            throw classifyOzonAuthorizationFailure(error, currentOzonStatus(), family);
        }
        if (!lease || typeof lease.requestOzonReportPackage !== 'function' || typeof lease.release !== 'function') {
            releaseAuthorizationInBackground(lease, `after an invalid ${OZON_PACKAGE_FAMILIES[family].name} authorization`);
            throw new ToolExecutionError(
                'OZON_AUTHORIZATION_REJECTED',
                `The extension returned an invalid ${OZON_PACKAGE_FAMILIES[family].name} authorization. ${OZON_LEASE_DEFECT}`,
                'authorization',
                false
            );
        }
        return lease;
    };

    // Keep package admission/result shaping distinct from the released singular contract:
    // valid pre-execution failures preserve item order/cardinality and a package stopReason,
    // while singular errors retain their legacy details schema and extension version floor.
    // Both handlers start background lease release before publication and release pins after
    // the terminal response; neither waits for the extension to acknowledge lease cleanup.
    const handleOzonReportPackage = async (id, toolName, family, args = {}) => {
        const itemProperty = family === 'promotion' ? 'periods' : 'reports';
        const items = args?.[itemProperty];
        // One byte counter per call: every writer of this export shares it (spec §4.2).
        const jobBudget = { bytes: 0 };
        let authorizationLease;
        let terminalResult;
        let reportArtifacts = [];
        let argumentsValid = false;
        const safeFailure = (error) => {
            if (error instanceof StorageUnavailableError) {
                return { code: error.code, message: error.message, stage: error.stage, retryable: false };
            }
            try {
                const safe =
                    family === 'analytics' ? safeOzonAnalyticsToolError(error) : safeOzonPromotionToolError(error);
                return { code: safe.code, message: safe.message, stage: safe.stage, retryable: false,
                    ...(safe.details === undefined ? {} : { details: safe.details }) };
            } catch {
                return {
                    code: 'ARTIFACT_REJECTED',
                    message: `The Ozon ${family} report package could not be completed safely.`,
                    stage: 'artifact',
                    retryable: false,
                };
            }
        };
        const failedPackage = (error) => {
            if (!argumentsValid) {
                return { ok: false, status: 'failed', jobType: toolName, error: safeFailure(error), stopReason: null };
            }
            const safeItem = (item) => ({
                ...(typeof item?.dateFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.dateFrom)
                    ? { dateFrom: item.dateFrom }
                    : {}),
                ...(typeof item?.dateTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.dateTo)
                    ? { dateTo: item.dateTo }
                    : {}),
                ...(family === 'analytics' && (item?.breakdown === 'period' || item?.breakdown === 'daily')
                    ? { breakdown: item.breakdown }
                    : {}),
            });
            const result = rejectedOzonPackage(toolName, itemProperty, items.map(safeItem), safeFailure(error));
            if (ozonPackageCapabilityErrors.has(error)) result.stopReason = 'capability_unavailable';
            return result;
        };
        try {
            const validation = validateToolArguments(toolName, args);
            if (!validation.ok) throw new ToolExecutionError('PREFLIGHT_FAILED', invalidArgumentsMessage(toolName, validation), 'preflight', false);
            try {
                if (family === 'promotion') parsePromotionPeriods(items);
                else items.forEach(({ dateFrom, dateTo }) => parseAnalyticsDateRange(dateFrom, dateTo));
            } catch {
                throw new ToolExecutionError('PREFLIGHT_FAILED', `The Ozon ${family} report package is invalid.`, 'preflight', false);
            }
            argumentsValid = true;
            authorizationLease = await authorizeOzonPackage(family, args.triggerUrl,
                () => requireStorageTarget(artifactStorageTarget, 'marketplace-artifacts'));
            const sharedExecution = {
                authorization: authorizationLease.authorization,
                requestOzonReportPackage: authorizationLease.requestOzonReportPackage,
                createArtifactWriter: createOzonArtifactWriter,
                jobBudget,
                now,
            };
            const result =
                family === 'promotion'
                    ? await executeOzonPromotionPackageJob({ ...sharedExecution, periods: items })
                    : await executeOzonAnalyticsJob({ ...sharedExecution, reports: items });
            const resources = getOzonReportPackageArtifactResources(result);
            reportArtifacts = resources;
            terminalResult = renderOzonResult(
                result,
                `Ozon Seller ${family} report package ${result.status}: ${resources.length} of ${items.length} XLSX workbook(s) available.`,
                resources,
                !result.ok
            );
        } catch (error) {
            terminalResult = textResult(failedPackage(await withDownloadedUpdate(error)), true);
        } finally {
            const currentLease = authorizationLease;
            authorizationLease = undefined;
            releaseAuthorizationInBackground(currentLease, `after Ozon ${family} report package completion`);
        }
        sendOperationResult(id, toolName, await deliverReportResult(terminalResult, reportArtifacts, reportOutputDirectory));
    };

    // The package path without artifact storage: the table is small enough to return inline.
    const handleOzonSearchPositions = async (id, args = {}) => {
        const toolName = 'ozon_search_positions';
        let request;
        let result;
        try {
            const validation = validateToolArguments(toolName, args);
            if (!validation.ok) throw new TypeError(invalidArgumentsMessage(toolName, validation));
            const { queries, skus, region, platform } = args;
            request = canonicalSearchPositionsRequest({ queries, skus, region, platform });
        } catch (error) {
            // Domain messages name the broken rule, never the rejected values.
            result = { ok: false, status: 'failed', jobType: toolName,
                error: { code: 'PREFLIGHT_FAILED', message: error.message, stage: 'preflight', retryable: false }, stopReason: null };
        }
        if (request) {
            let authorizationLease;
            try {
                authorizationLease = await authorizeOzonPackage('positions', args.triggerUrl);
                result = await executeOzonSearchPositionsJob({
                    authorization: authorizationLease.authorization,
                    request,
                    requestOzonReportPackage: authorizationLease.requestOzonReportPackage,
                    now,
                });
            } catch (error) {
                result = rejectedOzonSearchPositions(request, await withDownloadedUpdate(error));
            } finally {
                releaseAuthorizationInBackground(authorizationLease, 'after Ozon search positions completion');
            }
        }
        sendOperationResult(id, toolName, textResult(result, !result.ok));
    };

    // `needsBridge` declares which operational tools depend on the bridge, so the wake-up is applied once at
    // the dispatch point below instead of being remembered inside each handler. A tool added without the flag
    // never nudges; a tool added with it cannot forget to. `local_bridge_status` is deliberately false because
    // its read-only contract forbids a diagnostic call from starting a connect attempt.
    // `wb_product_images` is also false: it is a public image-CDN lookup that never uses the bridge.
    const toolHandlers = new Map([
        [
            'local_bridge_status',
            { needsBridge: false, run: async (id) => sendResult(id, textResult({ ok: true, ...currentBridgeStatus() })) },
        ],
        [
            'e_comet_diagnose',
            { needsBridge: false, run: async (id, args) => {
                const validation = validateToolArguments('e_comet_diagnose', args);
                const invalid = !validation.ok ? validation
                    : args.scope === 'last_operation' && (typeof args.operationHandle !== 'string' || !args.operationHandle)
                        ? { property: 'operationHandle' } : undefined;
                if (invalid) {
                    sendResult(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS',
                        invalidArgumentsMessage('e_comet_diagnose', invalid), 'arguments', false)), true));
                    return;
                }
                // A diagnosis must never fail because a refresh did.
                // Profile reads obey the same explicit probe contract as the collector; passive diagnoses keep stored facts.
                // A runtime extension_log probe reads the profiles too: status judges the fresh log against the profile
                // probe, which macOS never reads at start or in the background and elsewhere can be 30 s old.
                const withProbe = args.mode === 'safe_probes'
                    && ((args.scope === 'installation' && args.probes?.includes('extension_install') === true)
                        || (args.scope === 'runtime' && args.probes?.includes('extension_log') === true));
                const extensionInstall = await Promise.resolve().then(() => refreshBridgeFacts({ withProbe })).catch(() => undefined);
                const diagnosis = await collectDiagnosis({ ...args, operationDiagnostics, getBridgeStatus: currentBridgeStatus,
                    requestExtensionDiagnosticSnapshot, storageLayout, now, clientName: clientInfo?.name,
                    randomUUID: createUuid, ...(collectInstallation ? { collectInstallation } : {}),
                    ...(extensionInstall ? { probeExtensionInstall: async () => extensionInstall }
                        : probeExtensionInstall ? { probeExtensionInstall } : {}),
                    ...(collectHookPermissions ? { collectHookPermissions } : {}), collectExtensionLog: collectLog, replaceExtensionLog });
                sendResult(id, textResult(diagnosis));
            } },
        ],
        [
            'describe_e_comet_tool',
            { needsBridge: false, run: async (id, args) => {
                const validation = validateToolArguments('describe_e_comet_tool', args);
                if (!validation.ok) {
                    sendResult(id, textResult(toolFailure(new ToolExecutionError(
                        'INVALID_TOOL_ARGUMENTS',
                        invalidArgumentsMessage('describe_e_comet_tool', validation),
                        'arguments',
                        false
                    )), true));
                    return;
                }
                sendResult(id, textResult(describeToolContract(args.name)));
            } },
        ],
        [
            'wb_product_card',
            { needsBridge: true, run: (id, args) => handleBrowserJob(id, 'wb_product_card', 'product_card', args) },
        ],
        [
            'wb_search_by_query',
            { needsBridge: true, run: (id, args) => handleBrowserJob(id, 'wb_search_by_query', 'search_by_query', args) },
        ],
        [
            'wb_check_by_query',
            { needsBridge: true, run: (id, args) => handleBrowserJob(id, 'wb_check_by_query', 'check_by_query', args) },
        ],
        [
            'wb_filters_by_query',
            { needsBridge: true, run: (id, args) => handleBrowserJob(id, 'wb_filters_by_query', 'filters_by_query', args) },
        ],
        [
            'wb_recommendations_by_product',
            {
                needsBridge: true,
                run: (id, args) => handleBrowserJob(id, 'wb_recommendations_by_product', 'recommendations_by_product', args),
            },
        ],
        ['wb_seller_reviews', { needsBridge: true, run: (id, args) => handleSellerReviewsExport(id, args) }],
        ['ozon_seller_promotion_report', { needsBridge: true, run: (id, args) => handleOzonPromotionReport(id, args) }],
        [
            'ozon_seller_promotion_reports',
            { needsBridge: true, run: (id, args) => handleOzonReportPackage(id, 'ozon_seller_promotion_reports', 'promotion', args) },
        ],
        [
            'ozon_seller_analytics_report',
            { needsBridge: true, run: (id, args) => handleOzonReportPackage(id, 'ozon_seller_analytics_report', 'analytics', args) },
        ],
        ['ozon_search_positions', { needsBridge: true, run: (id, args) => handleOzonSearchPositions(id, args) }],
        ['prepare_e_comet_feedback', { needsBridge: false, run: (id, args) => handleFeedbackPrepare(id, args) }],
        ['submit_e_comet_feedback', { needsBridge: false, run: (id, args) => handleFeedbackSubmit(id, args) }],
        ['wb_product_images', { needsBridge: false, run: (id, args) => handleProductImages(id, args) }],
        [
            'e_comet_run_result',
            { needsBridge: false, run: async (id, args) => {
                const validation = validateToolArguments('e_comet_run_result', args);
                if (!validation.ok) {
                    sendResult(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS',
                        invalidArgumentsMessage('e_comet_run_result', validation), 'arguments', false)), true));
                    return;
                }
                const run = runs.get(args.runId);
                if (!run) {
                    sendResult(id, textResult(toolFailure(new ToolExecutionError(
                        'RUN_RESULT_UNAVAILABLE', RUN_RESULT_UNAVAILABLE_MESSAGE, 'result', false)), true));
                    return;
                }
                await answerRun(id, run);
            } },
        ],
    ]);

    return async (message) => {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            if (message?.id !== undefined) sendError(message.id, -32600, 'Invalid Request');
            return;
        }

        const { id, method, params } = message;
        if (method === 'notifications/initialized' || id === undefined) return;
        if (method === 'initialize') {
            const requestedProtocolVersion = params?.protocolVersion;
            negotiatedProtocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedProtocolVersion)
                ? requestedProtocolVersion : LATEST_MCP_PROTOCOL_VERSION;
            clientInfo = sanitizeClientInfo(params?.clientInfo);
            clientObservedAt = new Date(now()).toISOString();
            sendResult(id, {
                protocolVersion: negotiatedProtocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'e-comet-local-bridge', version: BRIDGE_VERSION },
                instructions: serverInstructions,
            });
            onInitialized();
            return;
        }
        if (method === 'ping') {
            sendResult(id, {});
            return;
        }
        if (method === 'tools/list') {
            sendResult(id, { tools });
            return;
        }
        if (method !== 'tools/call') {
            sendError(id, -32601, `Method not found: ${method}`);
            return;
        }

        const tool = toolHandlers.get(params?.name);
        if (!tool) {
            sendError(id, -32602, `Unknown tool: ${params?.name}`);
            return;
        }
        if (!tool.needsBridge) {
            await tool.run(id, params?.arguments ?? {});
            return;
        }
        // Before the handler runs, so the first call starts a connect attempt rather than waiting for the next
        // re-list — including the signed-call forms that return early, before they ever reach ensureBroker.
        kick();
        // Any bridge job may outlast a host's call deadline: past the wait it answers "running" and keeps working.
        const run = runs.start(params.name, (key) => tool.run(key, params?.arguments ?? {}));
        let delivered = true;
        // A run answered in full here never showed its runId, so nobody can fetch it later.
        try { delivered = await answerRun(id, run); } finally { if (delivered) runs.forget(run); }
    };
};
