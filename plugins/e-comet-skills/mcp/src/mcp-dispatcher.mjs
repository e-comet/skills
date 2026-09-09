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
    SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from './config.mjs';
import { createArtifactWriter, releaseArtifactJob } from './artifact-store.mjs';
import { prepareECometFeedback, submitECometFeedback } from './feedback-tools.mjs';
import { FeedbackPreparationError, feedbackPreparationFailure, feedbackSubmissionFailure } from './feedback-errors.mjs';
import { feedbackDiagnostics, safeFeedbackProperty, withFeedbackOperation } from './feedback-diagnostics.mjs';
import { feedbackDiagnosticsSchema, validateSchemaValue } from './tool-schemas.mjs';
import { executeAuthorizedBrowserJob, executeSellerReviewsJob, extractBrowserJobToken, validateAuthorizedJobLimits } from './browser-job.mjs';
import { mcpError, mcpResult, resourceLinkResult, textResult } from './mcp-protocol.mjs';
import { createJobWriter } from './result-store.mjs';
import { requireStorageTarget, StorageUnavailableError } from './storage-layout.mjs';
import { EXTENSION_UPDATE_URL, OZON_ANALYTICS_CAPABILITY, OZON_PROMOTION_PACKAGE_CAPABILITY } from './extension-vocabulary.mjs';
import {
    executeOzonPromotionJob,
    executeOzonPromotionPackageJob,
    getOzonPromotionArtifactResource,
} from './ozon-promotion-job.mjs';
import { executeOzonAnalyticsJob, safeOzonAnalyticsToolError } from './ozon-analytics-job.mjs';
import { getOzonReportPackageArtifactResources } from './ozon-report-package-job.mjs';
import { rejectedOzonPackage } from './ozon-report-package-result.mjs';
import { parsePromotionPeriods } from './ozon-report-package-domain.mjs';
import { parseAnalyticsDateRange } from './ozon-analytics-domain.mjs';
import { parseOzonPromotionPeriod } from './ozon-promotion-domain.mjs';
import { serverInstructions, tools, validateToolArguments } from './tool-catalog.mjs';
import {
    ozonExtensionOutdatedError,
    ozonRouteUnavailableError,
    safeOzonPromotionToolError,
    ToolExecutionError,
    toolFailure,
} from './tool-errors.mjs';
import { createConcurrencyLimiter, discoverImageBasket, imageExists, runWithConcurrency } from './wb-domain.mjs';

// Diagnose from a fresh locally-owned status only. Peer text and stale pre-wait snapshots
// cannot establish a login failure or turn a local bind problem into a marketplace chore.
const bridgeUnavailableError = (status) => {
    const explanations = {
        token_permission_denied: 'The local bridge cannot access its pairing file. Restore filesystem access for the agent process.',
        token_unavailable: 'The local bridge pairing state is unavailable. Inspect local_bridge_status and report persistent failure to e-Comet.',
        listen_failed: 'The local bridge could not bind its listener. Inspect local_bridge_status; opening a marketplace tab cannot repair the listener.',
        authentication_failed: 'The local peer handshake failed authentication. Inspect local_bridge_status; this is not a marketplace login failure.',
        protocol_mismatch: 'The local bridge processes use incompatible peer protocols. Restart the agent hosts to load the same plugin version.',
        handshake_required: 'The local peer handshake did not complete. Inspect local_bridge_status and report persistent failure to e-Comet.',
        connection_failed: 'The local bridge could not connect to its peer. Inspect local_bridge_status and report persistent failure to e-Comet.',
    };
    const reason = status?.peerRejection?.code ?? (status?.state === 'listen_failed' ? 'listen_failed' : undefined);
    if (Object.hasOwn(explanations, reason)) return new ToolExecutionError(
        `LOCAL_BRIDGE_${reason.toUpperCase()}`, `${explanations[reason]} Observed reason: ${reason}.`, 'local', false);
    return new ToolExecutionError('EXTENSION_DISCONNECTED',
        'The extension route did not become ready; the cause is not established. Inspect local_bridge_status before choosing a recovery action.',
        'extension', true);
};

const OZON_AUTHORIZATION_ROUTE_CODES = new Set([
    'EXTENSION_DISCONNECTED',
    'BROWSER_JOB_AUTHORIZATION_TIMEOUT',
    'EXTENSION_UPDATE_REQUIRED',
]);

const storageCreationEvidence = new WeakMap();
const resultCreationFailure = (cause) => {
    const messages = {
        EBUSY: 'Local output storage is busy. Let any other pending work finish, then retry; report a persistent failure to e-Comet.',
        EEXIST: 'A local output path conflicts with an existing entry. Check the configured output location.',
        EACCES: 'The agent process cannot access local output storage. Restore access to the configured output location.',
        EPERM: 'The operating system denied access to local output storage. Check access or a file sharing lock.',
        ENOSPC: 'Local output storage has no free space. Free space before requesting the report again.',
        EDQUOT: 'The local output storage quota is exhausted. Restore available quota before requesting the report again.',
        EROFS: 'Local output storage is read-only. Use a writable output location.',
        ENOTDIR: 'A local output path contains an entry that is not a directory. Check the configured output location.',
    };
    const code = safeFeedbackProperty(cause, 'code');
    const known = typeof code === 'string' && Object.hasOwn(messages, code);
    const error = new ToolExecutionError('LOCAL_STORAGE_FAILED', known ? messages[code] : 'The local result file could not be created.',
        'storage', true, { cause });
    if (known) storageCreationEvidence.set(error, { operation: 'create_result', systemCode: code });
    return error;
};

// Package capability floor, also enforced by scripts/extension_gate.py for publication.
// The released singular @1 tool intentionally retains its independent 1.5.6 floor.
const OZON_PACKAGE_MIN_EXTENSION_VERSION = '1.5.7';
// Only this dispatcher can attest a missing capability from bridge status.
// Remote error fields and message text cannot select the public stop reason.
const ozonPackageCapabilityErrors = new WeakSet();
const ozonPackageCapabilityFailure = (family, status) => {
    const supportField = family === 'analytics' ? 'ozonSellerAnalyticsReportSupported' : 'ozonSellerPromotionReportsSupported';
    if (status?.extensionConnected !== true || status[supportField] !== false) return undefined;
    const capability = family === 'analytics' ? OZON_ANALYTICS_CAPABILITY : OZON_PROMOTION_PACKAGE_CAPABILITY;
    const error = new ToolExecutionError(
        family === 'analytics' ? 'OZON_ANALYTICS_CAPABILITY_UNAVAILABLE' : 'OZON_ROUTE_NOT_READY',
        `The connected extension does not announce ${capability} and cannot run this Ozon ${family} report package. ` +
            `Update the e-Comet extension to ${OZON_PACKAGE_MIN_EXTENSION_VERSION} or newer at ${EXTENSION_UPDATE_URL}, then request a new report authorization and retry.`,
        family === 'analytics' ? 'context' : 'route',
        false
    );
    ozonPackageCapabilityErrors.add(error);
    return error;
};

export const classifyOzonAuthorizationFailure = (error, status, packageFamily) => {
    if (packageFamily !== undefined) {
        const capabilityFailure = ozonPackageCapabilityFailure(packageFamily, status);
        if (capabilityFailure) return capabilityFailure;
    }
    if (packageFamily === undefined && error instanceof ToolExecutionError && OZON_AUTHORIZATION_ROUTE_CODES.has(error.code)
        && status?.extensionConnected === true && status.ozonSellerPromotionReportSupported === false) {
        return ozonExtensionOutdatedError(status.extensionVersion);
    }
    if (error instanceof ToolExecutionError && error.code === 'EXTENSION_DISCONNECTED' && status?.extensionConnected !== true) {
        const localFailure = bridgeUnavailableError(status);
        // A locally observed pairing/listener failure precedes any Seller probe. Preserve
        // its recovery within the existing Ozon authorization schema, not a Seller diagnosis.
        if (localFailure.stage === 'local') return new ToolExecutionError(
            'OZON_AUTHORIZATION_REJECTED', localFailure.message, 'authorization', false, { cause: error });
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
        if (packageFamily !== undefined) {
            return new ToolExecutionError(
                'OZON_ROUTE_NOT_READY',
                (error.code === 'EXTENSION_DISCONNECTED' ? 'The e-Comet extension is not connected to the local bridge. '
                    : 'The Ozon report authorization route did not complete; its cause is not established. ') +
                    `Ensure e-Comet extension ${OZON_PACKAGE_MIN_EXTENSION_VERSION} or newer is enabled in the same browser profile, refresh an authenticated Ozon Seller page, then request a new report authorization and retry.`,
                'route', false
            );
        }
        if (status?.extensionConnected === true && status.ozonSellerPromotionReportSupported === false) {
            return ozonExtensionOutdatedError(status.extensionVersion);
        }
        return ozonRouteUnavailableError(error.code === 'EXTENSION_DISCONNECTED' ? 'disconnected'
            : error.code === 'BROWSER_JOB_AUTHORIZATION_TIMEOUT' ? 'timeout' : 'unavailable');
    }
    let message = packageFamily === undefined ? 'The Ozon promotion report authorization was rejected.'
        : `The Ozon ${packageFamily} report package authorization was rejected.`;
    if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_REJECTED'
        && error.message === 'Extension is not authenticated with e-Comet') {
        message = 'The e-Comet extension is not signed in. Open the e-Comet extension and sign in to the same e-Comet account used for this request.';
    } else if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_ACCOUNT_MISMATCH') {
        message = 'The e-Comet extension is signed in to a different e-Comet account. Open the e-Comet extension and sign in to the same e-Comet account used for this request.';
    }
    return new ToolExecutionError(
        'OZON_AUTHORIZATION_REJECTED',
        message,
        'authorization',
        false,
        { cause: error }
    );
};

export const createMcpMessageHandler = ({
    getBridgeStatus,
    waitForExtensionReady,
    // Non-blocking nudge that pulls the next bridge reconnect attempt forward. Applied once at the tools/call
    // dispatch point to every tool declaring `needsBridge`, rather than from inside individual handlers: the
    // wake-up inside waitForExtensionReady is reachable only by a fully-formed signed call, so the calls a
    // degraded agent actually makes first — the status read and the discovery call without a triggerUrl —
    // would otherwise each have to remember to nudge.
    ensureBridgeConnected = () => undefined,
    requestBrowserJobAuthorization,
    artifactStorageTarget = ARTIFACT_STORAGE,
    reportOutputDirectory = undefined,
    createSellerArtifactWriter = createArtifactWriter,
    releaseSellerArtifactJob = releaseArtifactJob,
    createOzonArtifactWriter = createArtifactWriter,
    releaseOzonArtifactJob = releaseArtifactJob,
    renderOzonResult = resourceLinkResult,
    sendError = mcpError,
    sendResult = mcpResult,
    createJobWriter: createWriter = createJobWriter,
    probeImageExists = imageExists,
    prepareFeedback = prepareECometFeedback,
    submitFeedback = submitECometFeedback,
    shutdownSignal,
    log = (..._args) => undefined,
    now = Date.now,
}) => {
    // Scope revocation occurs before the release route's acknowledgement can suspend, so callers can safely
    // deliver a terminal result without letting a peer/extension round trip delay it.
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
        if (!validateToolArguments(toolName, args)) {
            await sendResult(
                id,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'INVALID_TOOL_ARGUMENTS',
                            `Invalid ${toolName} arguments.`,
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
            await sendResult(
                id,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'BROWSER_JOB_HANDOFF_REQUIRED',
                            'Browser authorization handoff is required.',
                            'handoff',
                            true
                        )
                    ),
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
            if (!(await waitForExtensionReady())) {
                throw bridgeUnavailableError(getBridgeStatus());
            }
            const token = extractBrowserJobToken(triggerUrl);
            authorizationLease = await requestBrowserJobAuthorization(token);
            if (
                !authorizationLease ||
                typeof authorizationLease.requestWbFetch !== 'function' ||
                typeof authorizationLease.release !== 'function'
            ) {
                throw new Error('Extension returned an invalid browser job authorization lease');
            }
            const authorization = authorizationLease.authorization;
            if (
                !authorization ||
                typeof authorization.authorizationId !== 'string' ||
                typeof authorization.jobType !== 'string' ||
                !authorization.job ||
                typeof authorization.job !== 'object'
            ) {
                throw new Error('Extension returned an invalid browser job authorization');
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
            await sendResult(
                id,
                textResult(
                    {
                        ...result,
                        ...(writer.published !== false ? { resultPath: writer.resultPath } : {}),
                        ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
                    },
                    !result.ok
                )
            );
        } catch (error) {
            releaseAuthorization('after job failure');
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
            await sendResult(
                id,
                textResult(
                    {
                        ...toolFailure(error, {
                            code: 'BROWSER_JOB_EXECUTION_FAILED',
                            message: 'The authorized Wildberries job could not be completed.',
                            stage: 'execution',
                            retryable: false,
                        }),
                        // Public-only evidence: shared toolFailure is also a strict
                        // peer-wire serializer and must not gain these extra keys.
                        ...(storageCreationEvidence.has(error) ? { details: storageCreationEvidence.get(error) } : {}),
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
        if (!validateToolArguments('prepare_e_comet_feedback', args)) {
            sendResult(id, textResult(feedbackPrepareFailure(new FeedbackPreparationError('FEEDBACK_INPUT_INVALID')), true));
            return;
        }
        let operation = 'prepare';
        try {
            const prepared = await prepareFeedback(args, { getBridgeStatus });
            operation = 'prepare_result';
            const reportResource = prepared?.reportResource;
            if (!reportResource || reportResource.name !== 'report.md') throw new Error('missing report resource');
            sendResult(id, resourceLinkResult(prepared, JSON.stringify(prepared), [reportResource]));
        } catch (error) {
            sendResult(id, textResult(feedbackPrepareFailure(operation === 'prepare_result' ? withFeedbackOperation(error, operation) : error), true));
        }
    };

    const handleFeedbackSubmit = async (id, args = {}) => {
        if (!validateToolArguments('submit_e_comet_feedback', args)) {
            sendResult(
                id,
                textResult(
                    { ok: false, status: 'failed', error: { code: 'UPLOAD_GRANT_INVALID', message: 'The feedback upload grant is invalid or has expired.', stage: 'grant', retryable: false, details: feedbackDiagnostics(undefined, 'input_validation') } },
                    true
                )
            );
            return;
        }
        try {
            const submitted = await submitFeedback(args);
            if (!submitted.ok) {
                const details = safeFeedbackProperty(safeFeedbackProperty(submitted, 'error'), 'details');
                if (validateSchemaValue(details, feedbackDiagnosticsSchema)) console.error('[McpDispatcher] Feedback submission failed:', JSON.stringify(details));
            }
            sendResult(id, textResult(submitted, !submitted.ok));
        } catch (error) {
            const failure = feedbackSubmissionFailure(error, args.artifactId);
            console.error('[McpDispatcher] Feedback submission failed:', JSON.stringify(failure.error));
            sendResult(id, textResult(failure, true));
        }
    };

    const handleProductImages = async (id, args = {}) => {
        const nmIds = args.nmIds;
        const maxPhotos = args.maxPhotos ?? DEFAULT_IMAGE_PHOTOS;
        const maxBasket = args.maxBasket ?? MAX_IMAGE_BASKET;
        const size = args.size ?? 'big';
        const timeout = args.timeout ?? 5000;
        if (!validateToolArguments('wb_product_images', args)) {
            await sendResult(
                id,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'INVALID_TOOL_ARGUMENTS',
                            'Invalid wb_product_images arguments.',
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
            await sendResult(
                id,
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
            await sendResult(
                id,
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
        if (!validateToolArguments(toolName, args)) {
            sendResult(
                id,
                textResult(
                    toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', `Invalid ${toolName} arguments.`, 'arguments', false)),
                    true
                )
            );
            return;
        }
        const triggerUrl = args.triggerUrl;
        if (typeof triggerUrl !== 'string' || !triggerUrl) {
            sendResult(
                id,
                textResult(
                    toolFailure(
                        new ToolExecutionError(
                            'BROWSER_JOB_HANDOFF_REQUIRED',
                            'Browser authorization handoff is required.',
                            'handoff',
                            true
                        )
                    ),
                    true
                )
            );
            return;
        }
        let authorizationLease;
        let terminalResult;
        let sellerResult;
        let sellerArtifacts = [];
        const artifactJobId = randomUUID();
        try {
            requireStorageTarget(artifactStorageTarget, 'marketplace-artifacts');
            if (!(await waitForExtensionReady())) {
                throw bridgeUnavailableError(getBridgeStatus());
            }
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
                throw new Error('Extension returned an invalid seller browser job authorization lease');
            }
            sellerResult = await executeSellerReviewsJob({
                authorization,
                requestSellerOperation: authorizationLease.requestSellerOperation,
                createArtifactWriter: createSellerArtifactWriter,
                artifactJobId,
            });
            sellerArtifacts = sellerResult.exports.flatMap((item) =>
                item.status === 'complete' && 'artifact' in item ? [item.artifact] : []
            );
            const summary = `Seller review export ${sellerResult.status}: ${sellerArtifacts.length} of ${sellerResult.exports.length} XLSX artifact(s) available.`;
            terminalResult = resourceLinkResult(sellerResult, summary, sellerArtifacts, !sellerResult.ok);
        } catch (error) {
            terminalResult = textResult(
                toolFailure(error, {
                    code: 'SELLER_REVIEWS_EXPORT_FAILED',
                    message: 'The authorized seller review export could not be completed.',
                    stage: 'execution',
                    retryable: false,
                }),
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
        try {
            sendResult(id, await deliverReportResult(terminalResult, sellerArtifacts, reportOutputDirectory));
        } finally {
            try {
                // Cancellation may publish a partial response while another writer
                // still owns cleanup. Register this response owner's release now;
                // the store completes it when the final writer/cleanup leaves.
                await releaseSellerArtifactJob(artifactJobId, { deferWhileActive: true });
            } catch (error) {
                log('failed to release seller artifact pins after terminal response:', error?.message);
            }
        }
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
        const artifactJobId = randomUUID();
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
            if (!validateToolArguments(toolName, args)) {
                throw new ToolExecutionError('PREFLIGHT_FAILED', 'The Ozon promotion period is invalid.', 'preflight', false);
            }
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
            if (!(await waitForExtensionReady())) {
                throw classifyOzonAuthorizationFailure(
                    new ToolExecutionError('EXTENSION_DISCONNECTED', 'disconnected', 'extension'), currentOzonStatus());
            }
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
                    'The extension returned an invalid Ozon promotion authorization.',
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
                artifactJobId,
                now,
            });
            reportArtifacts = [getOzonPromotionArtifactResource(result)];
            terminalResult = renderOzonResult(
                result,
                `Ozon Seller promotion report complete: one XLSX workbook for ${dateFrom} through ${dateTo}.`,
                [getOzonPromotionArtifactResource(result)]
            );
        } catch (error) {
            terminalResult = textResult(failureResult(error), true);
        } finally {
            const currentLease = authorizationLease;
            authorizationLease = undefined;
            releaseAuthorizationInBackground(currentLease, 'after Ozon promotion report completion');
        }
        try {
            sendResult(id, await deliverReportResult(terminalResult, reportArtifacts, reportOutputDirectory));
        } finally {
            try {
                await releaseOzonArtifactJob(artifactJobId, { deferWhileActive: true });
            } catch (error) {
                log('failed to release Ozon promotion artifact pins after terminal response:', error?.message);
            }
        }
    };

    // Keep package admission/result shaping distinct from the released singular contract:
    // valid pre-execution failures preserve item order/cardinality and a package stopReason,
    // while singular errors retain their legacy details schema and extension version floor.
    // Both handlers start background lease release before publication and release pins after
    // the terminal response; neither waits for the extension to acknowledge lease cleanup.
    const handleOzonReportPackage = async (id, toolName, family, args = {}) => {
        const itemProperty = family === 'promotion' ? 'periods' : 'reports';
        const items = args?.[itemProperty];
        const artifactJobId = randomUUID();
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
                return { code: safe.code, message: safe.message, stage: safe.stage, retryable: false };
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
        const capabilityFailure = () => {
            return ozonPackageCapabilityFailure(family, currentOzonStatus());
        };
        try {
            if (!validateToolArguments(toolName, args)) {
                throw new ToolExecutionError('PREFLIGHT_FAILED', `The Ozon ${family} report package is invalid.`, 'preflight', false);
            }
            try {
                if (family === 'promotion') parsePromotionPeriods(items);
                else items.forEach(({ dateFrom, dateTo }) => parseAnalyticsDateRange(dateFrom, dateTo));
            } catch {
                throw new ToolExecutionError('PREFLIGHT_FAILED', `The Ozon ${family} report package is invalid.`, 'preflight', false);
            }
            argumentsValid = true;
            if (typeof args.triggerUrl !== 'string' || !args.triggerUrl) {
                throw new ToolExecutionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    'The trusted browser-job hook did not provide Ozon authorization.',
                    'authorization',
                    false
                );
            }
            const unavailableBeforeWait = capabilityFailure();
            requireStorageTarget(artifactStorageTarget, 'marketplace-artifacts');
            if (unavailableBeforeWait) throw unavailableBeforeWait;
            if (!(await waitForExtensionReady())) {
                throw classifyOzonAuthorizationFailure(new ToolExecutionError('EXTENSION_DISCONNECTED', 'disconnected', 'extension'), currentOzonStatus(), family);
            }
            const unavailableAfterWait = capabilityFailure();
            if (unavailableAfterWait) throw unavailableAfterWait;
            try {
                authorizationLease = await requestBrowserJobAuthorization(extractBrowserJobToken(args.triggerUrl));
            } catch (error) {
                throw classifyOzonAuthorizationFailure(error, currentOzonStatus(), family);
            }
            if (
                !authorizationLease ||
                typeof authorizationLease.requestOzonReportPackage !== 'function' ||
                typeof authorizationLease.release !== 'function'
            ) {
                throw new ToolExecutionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    `The extension returned an invalid Ozon ${family} report package authorization.`,
                    'authorization',
                    false
                );
            }
            const sharedExecution = {
                authorization: authorizationLease.authorization,
                requestOzonReportPackage: authorizationLease.requestOzonReportPackage,
                createArtifactWriter: createOzonArtifactWriter,
                artifactJobId,
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
            terminalResult = textResult(failedPackage(error), true);
        } finally {
            const currentLease = authorizationLease;
            authorizationLease = undefined;
            releaseAuthorizationInBackground(currentLease, `after Ozon ${family} report package completion`);
        }
        try {
            sendResult(id, await deliverReportResult(terminalResult, reportArtifacts, reportOutputDirectory));
        } finally {
            try {
                await releaseOzonArtifactJob(artifactJobId, { deferWhileActive: true });
            } catch (error) {
                log(`failed to release Ozon ${family} package artifact pins after terminal response:`, error?.message);
            }
        }
    };

    // `needsBridge` declares which operational tools depend on the bridge, so the wake-up is applied once at
    // the dispatch point below instead of being remembered inside each handler. A tool added without the flag
    // never nudges; a tool added with it cannot forget to. `local_bridge_status` is deliberately false because
    // its read-only contract forbids a diagnostic call from pulling forward peer-token creation.
    // `wb_product_images` is also false: it is a public image-CDN lookup that never uses the bridge.
    const toolHandlers = new Map([
        [
            'local_bridge_status',
            { needsBridge: false, run: async (id) => sendResult(id, textResult({ ok: true, ...getBridgeStatus() })) },
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
        ['prepare_e_comet_feedback', { needsBridge: false, run: (id, args) => handleFeedbackPrepare(id, args) }],
        ['submit_e_comet_feedback', { needsBridge: false, run: (id, args) => handleFeedbackSubmit(id, args) }],
        ['wb_product_images', { needsBridge: false, run: (id, args) => handleProductImages(id, args) }],
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
            sendResult(id, {
                protocolVersion: SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedProtocolVersion)
                    ? requestedProtocolVersion
                    : LATEST_MCP_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'e-comet-local-bridge', version: BRIDGE_VERSION },
                instructions: serverInstructions,
            });
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
        // Before the handler runs, so a degraded agent's very first call starts the reconnect rather than
        // waiting out the retry interval — including the signed-call forms that return early, before they ever
        // reach waitForExtensionReady.
        if (tool.needsBridge) ensureBridgeConnected();
        await tool.run(id, params?.arguments ?? {});
    };
};
