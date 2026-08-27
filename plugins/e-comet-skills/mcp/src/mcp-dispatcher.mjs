import { randomUUID } from 'node:crypto';

import {
    BRIDGE_VERSION,
    DEFAULT_IMAGE_PHOTOS,
    DEFAULT_RETURNED_PRODUCTS,
    IMAGE_CONCURRENCY,
    LATEST_MCP_PROTOCOL_VERSION,
    MAX_IMAGE_BASKET,
    SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from './config.mjs';
import { createArtifactWriter, releaseArtifactJob } from './artifact-store.mjs';
import { executeAuthorizedBrowserJob, executeSellerReviewsJob, extractBrowserJobToken, validateAuthorizedJobLimits } from './browser-job.mjs';
import { mcpError, mcpResult, resourceLinkResult, textResult } from './mcp-protocol.mjs';
import { createJobWriter } from './result-store.mjs';
import { executeOzonPromotionJob, getOzonPromotionArtifactResource } from './ozon-promotion-job.mjs';
import { parseOzonPromotionPeriod } from './ozon-promotion-domain.mjs';
import { serverInstructions, tools, validateToolArguments } from './tool-catalog.mjs';
import { safeOzonPromotionToolError, ToolExecutionError, toolFailure } from './tool-errors.mjs';
import { createConcurrencyLimiter, discoverImageBasket, imageExists, normalizeStatus, runWithConcurrency } from './wb-domain.mjs';

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
    createSellerArtifactWriter = createArtifactWriter,
    releaseSellerArtifactJob = releaseArtifactJob,
    createOzonArtifactWriter = createArtifactWriter,
    releaseOzonArtifactJob = releaseArtifactJob,
    renderOzonResult = resourceLinkResult,
    sendError = mcpError,
    sendResult = mcpResult,
    createJobWriter: createWriter = createJobWriter,
    probeImageExists = imageExists,
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
            sendResult(
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
                throw new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'Open an authenticated Wildberries tab, then retry the e-Comet request.',
                    'extension',
                    true
                );
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
                throw new ToolExecutionError(
                    'LOCAL_STORAGE_FAILED',
                    'The local result file could not be created.',
                    'storage',
                    true,
                    { cause: error }
                );
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
            sendResult(
                id,
                textResult(
                    {
                        ...result,
                        resultPath: writer.resultPath,
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
                    ...(writer.persistedBytes > 0 ? { resultPath: writer.resultPath } : {}),
                    ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((writeError) => writeError.message) } : {}),
                };
            }
            if (error instanceof ToolExecutionError && error.code === 'BROWSER_JOB_DESCRIPTOR_INVALID' && error.cause instanceof Error) {
                log('rejected signed browser job descriptor:', error.cause.message);
            }
            sendResult(
                id,
                textResult(
                    {
                        ...toolFailure(error, {
                            code: 'BROWSER_JOB_EXECUTION_FAILED',
                            message: 'The authorized Wildberries job could not be completed.',
                            stage: 'execution',
                            retryable: false,
                        }),
                        ...partialResult,
                    },
                    true
                )
            );
        }
    };

    const handleProductImages = async (id, args = {}) => {
        const nmIds = args.nmIds;
        const maxPhotos = args.maxPhotos ?? DEFAULT_IMAGE_PHOTOS;
        const maxBasket = args.maxBasket ?? MAX_IMAGE_BASKET;
        const size = args.size ?? 'big';
        const timeout = args.timeout ?? 5000;
        if (!validateToolArguments('wb_product_images', args)) {
            sendResult(
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
        const closeWriter = async () => {
            if (!writer) return [];
            const currentWriter = writer;
            writer = undefined;
            return currentWriter.close();
        };
        try {
            writer = await createWriter(jobId);
            const currentWriter = writer;
            const resultPath = writer.resultPath;
            const limitedImageExists = createConcurrencyLimiter(IMAGE_CONCURRENCY, (url, requestTimeout) =>
                probeImageExists(url, requestTimeout, shutdownSignal)
            );
            const products = await runWithConcurrency(nmIds, IMAGE_CONCURRENCY, async (nmId) => {
                const discovered = await discoverImageBasket(nmId, maxBasket, size, timeout, limitedImageExists);
                if (!discovered) {
                    const result = { nmId, status: 'not_found', imageUrls: [] };
                    await currentWriter.append(result);
                    return result;
                }
                const imageUrls = (
                    await runWithConcurrency(
                        Array.from({ length: maxPhotos }, (_, index) => index + 1),
                        IMAGE_CONCURRENCY,
                        async (photo) => {
                            const url = `${discovered.baseUrl}/${size}/${photo}.webp`;
                            return (await limitedImageExists(url, timeout)) ? url : null;
                        }
                    )
                ).filter(Boolean);
                const result = {
                    nmId,
                    status: imageUrls.length > 0 ? 'ok' : 'not_found',
                    basket: discovered.basket,
                    baseUrl: discovered.baseUrl,
                    imageUrls,
                };
                await currentWriter.append(result);
                return result;
            });
            const writeErrors = await closeWriter();
            const succeeded = products.filter((product) => product.status === 'ok').length;
            // A completed probe with only not_found rows is a normal negative result; only execution failures set MCP isError below.
            sendResult(
                id,
                textResult({
                    ok: succeeded > 0,
                    status: normalizeStatus(succeeded, products.length),
                    jobId,
                    total: products.length,
                    succeeded,
                    failed: products.length - succeeded,
                    size,
                    products,
                    resultPath,
                    ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((error) => error.message) } : {}),
                })
            );
        } catch (error) {
            const partialWriter = writer;
            const writeErrors = await closeWriter().catch(() => []);
            const partialResult = partialWriter
                ? {
                      ...(partialWriter.persistedBytes > 0 ? { resultPath: partialWriter.resultPath } : {}),
                      ...(writeErrors.length > 0 ? { storageWarnings: writeErrors.map((writeError) => writeError.message) } : {}),
                  }
                : {};
            sendResult(
                id,
                textResult(
                    {
                        ...toolFailure(error, {
                            code: 'IMAGE_LOOKUP_FAILED',
                            message: 'The Wildberries image lookup could not be completed.',
                            stage: 'images',
                            retryable: true,
                        }),
                        ...partialResult,
                    },
                    true
                )
            );
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
            if (!(await waitForExtensionReady())) {
                throw new ToolExecutionError(
                    'EXTENSION_DISCONNECTED',
                    'Open an authenticated Wildberries tab, then retry the e-Comet request.',
                    'extension',
                    true
                );
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
            sendResult(id, terminalResult);
        } finally {
            try {
                await releaseSellerArtifactJob(artifactJobId);
            } catch (error) {
                log('failed to release seller artifact pins after terminal response:', error?.message);
            }
        }
    };

    const handleOzonPromotionReport = async (id, args = {}) => {
        const toolName = 'ozon_seller_promotion_report';
        const dateFrom = args?.dateFrom;
        const dateTo = args?.dateTo;
        const artifactJobId = randomUUID();
        let authorizationLease;
        let terminalResult;
        let periodValidated = false;
        const failureResult = (error) => {
            let normalized;
            try {
                if (error instanceof ToolExecutionError) normalized = safeOzonPromotionToolError(error);
            } catch {
                normalized = undefined;
            }
            const safeError = normalized
                ? { code: normalized.code, message: normalized.message, stage: normalized.stage, retryable: false }
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
            try {
                authorizationLease = await requestBrowserJobAuthorization(extractBrowserJobToken(args.triggerUrl));
            } catch (error) {
                throw new ToolExecutionError(
                    'OZON_AUTHORIZATION_REJECTED',
                    'The Ozon promotion report authorization was rejected.',
                    'authorization',
                    false,
                    { cause: error }
                );
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
            sendResult(id, terminalResult);
        } finally {
            try {
                await releaseOzonArtifactJob(artifactJobId, { deferWhileActive: true });
            } catch (error) {
                log('failed to release Ozon promotion artifact pins after terminal response:', error?.message);
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
