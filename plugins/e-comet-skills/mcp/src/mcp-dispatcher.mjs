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
import { executeAuthorizedBrowserJob, extractBrowserJobToken, validateAuthorizedJobLimits } from './browser-job.mjs';
import { mcpError, mcpResult, textResult } from './mcp-protocol.mjs';
import { createJobWriter } from './result-store.mjs';
import { serverInstructions, tools, validateToolArguments } from './tool-catalog.mjs';
import { ToolExecutionError, toolFailure } from './tool-errors.mjs';
import { createConcurrencyLimiter, discoverImageBasket, imageExists, normalizeStatus, runWithConcurrency } from './wb-domain.mjs';

export const createMcpMessageHandler = ({
    getBridgeStatus,
    waitForExtensionReady,
    requestBrowserJobAuthorization,
    sendError = mcpError,
    sendResult = mcpResult,
    createJobWriter: createWriter = createJobWriter,
    probeImageExists = imageExists,
    shutdownSignal,
    log = (..._args) => undefined,
}) => {
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
        const releaseAuthorization = () => {
            if (!authorizationLease) return;
            const currentLease = authorizationLease;
            authorizationLease = undefined;
            currentLease.release();
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
            releaseAuthorization();
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
            releaseAuthorization();
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

    const toolHandlers = new Map([
        ['local_bridge_status', async (id) => sendResult(id, textResult({ ok: true, ...getBridgeStatus() }))],
        ['wb_product_card', (id, args) => handleBrowserJob(id, 'wb_product_card', 'product_card', args)],
        ['wb_search_by_query', (id, args) => handleBrowserJob(id, 'wb_search_by_query', 'search_by_query', args)],
        [
            'wb_recommendations_by_product',
            (id, args) => handleBrowserJob(id, 'wb_recommendations_by_product', 'recommendations_by_product', args),
        ],
        ['wb_product_images', (id, args) => handleProductImages(id, args)],
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

        const handler = toolHandlers.get(params?.name);
        if (!handler) {
            sendError(id, -32602, `Unknown tool: ${params?.name}`);
            return;
        }
        await handler(id, params?.arguments ?? {});
    };
};
