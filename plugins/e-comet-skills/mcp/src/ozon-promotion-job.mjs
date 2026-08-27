import { validateAuthorizedJobLimits } from './browser-job.mjs';
import { assertOzonPromotionPeriodEqual, ozonPromotionArtifactName } from './ozon-promotion-domain.mjs';
import { OZON_PROMOTION_OPERATION_MAX_MS } from './request-broker.mjs';
import { safeOzonPromotionToolError, ToolExecutionError } from './tool-errors.mjs';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SIGNED_EXPIRY_SAFETY_RESERVE_MS = 1000;

const authorizationRejected = (cause) =>
    new ToolExecutionError(
        'OZON_AUTHORIZATION_REJECTED',
        'The signed Ozon promotion authorization does not match this request.',
        'authorization',
        false,
        { cause }
    );

const artifactRejected = (cause) =>
    new ToolExecutionError(
        'ARTIFACT_REJECTED',
        'The Ozon promotion workbook could not be stored safely.',
        'artifact',
        false,
        { cause }
    );

const publicArtifact = ({ name, mimeType, size, sha256 }) => ({ name, mimeType, size, sha256 });
const artifactResources = new WeakMap();

export const getOzonPromotionArtifactResource = (result) => artifactResources.get(result);

export const executeOzonPromotionJob = async ({
    authorization,
    dateFrom,
    dateTo,
    requestOzonPromotionReport,
    createArtifactWriter,
    artifactJobId = authorization?.job?.jobId,
    now = Date.now,
}) => {
    try {
        validateAuthorizedJobLimits(authorization);
        if (authorization.jobType !== 'ozon_seller_promotion_report') throw new Error('Wrong Ozon promotion job type');
        assertOzonPromotionPeriodEqual({ dateFrom, dateTo }, authorization.job);
    } catch (error) {
        throw authorizationRejected(error);
    }
    if (typeof requestOzonPromotionReport !== 'function' || typeof createArtifactWriter !== 'function') {
        throw authorizationRejected(new Error('Ozon promotion execution dependencies are unavailable'));
    }

    const startedAt = now();
    const signedDeadlineAt =
        typeof authorization?.expiresAt === 'number' && Number.isFinite(authorization.expiresAt)
            ? Math.floor(authorization.expiresAt * 1000 - SIGNED_EXPIRY_SAFETY_RESERVE_MS)
            : Infinity;
    const deadlineAt = Math.min(startedAt + OZON_PROMOTION_OPERATION_MAX_MS, signedDeadlineAt);
    const operationTimeoutMs = deadlineAt - startedAt;
    if (operationTimeoutMs < 1000) {
        throw new ToolExecutionError(
            'OPERATION_DEADLINE_EXCEEDED',
            'The signed Ozon promotion authorization does not leave enough time to start the operation.',
            'deadline',
            false
        );
    }
    /** @type {{ writer?: { appendChunk: (index: number, data: string) => Promise<void>, complete: (completion: { size: number, sha256: string }) => Promise<{ name: string, path: string, uri: string, mimeType: string, size: number, sha256: string }>, abort: () => Promise<void> }, completion?: { size: number, sha256: string }, artifact?: { name: string, path: string, uri: string, mimeType: string, size: number, sha256: string } }} */
    const stream = {};
    let published = false;
    try {
        const operationResult = await requestOzonPromotionReport(
            { dateFrom, dateTo, deadlineAt },
            {
                onStart: async (_metadata, signal) => {
                    if (stream.writer) throw artifactRejected(new Error('Ozon artifact stream started more than once'));
                    stream.writer = await createArtifactWriter({
                        jobId: artifactJobId,
                        fileName: ozonPromotionArtifactName(dateFrom, dateTo),
                        mimeType: XLSX_MIME_TYPE,
                        validateXlsx: true,
                        ...(signal === undefined ? {} : { signal }),
                    });
                },
                onChunk: async (index, data) => {
                    if (!stream.writer || stream.completion) throw artifactRejected(new Error('Ozon artifact chunk is out of order'));
                    await stream.writer.appendChunk(index, data);
                },
                onEnd: async (metadata) => {
                    if (!stream.writer || stream.completion) throw artifactRejected(new Error('Ozon artifact end is out of order'));
                    stream.completion = metadata;
                    stream.artifact = await stream.writer.complete(metadata);
                },
            },
            operationTimeoutMs
        );
        if (operationResult?.ok === false) throw safeOzonPromotionToolError(operationResult.error);
        if (operationResult?.ok !== true || !stream.writer || !stream.completion || !stream.artifact) {
            throw artifactRejected(new Error('Ozon operation and artifact stream did not agree'));
        }
        const result = {
            ok: true,
            status: 'complete',
            jobType: 'ozon_seller_promotion_report',
            dateFrom,
            dateTo,
            artifact: publicArtifact(stream.artifact),
        };
        artifactResources.set(result, stream.artifact);
        published = true;
        return result;
    } catch (error) {
        if (stream.writer && !published) {
            const cleanupRunsPrivately =
                error instanceof ToolExecutionError &&
                (error.code === 'OPERATION_CANCELLED' || error.code === 'OPERATION_DEADLINE_EXCEEDED');
            try {
                const cleanup = stream.writer.abort();
                if (cleanupRunsPrivately) void Promise.resolve(cleanup).catch(() => undefined);
                else await cleanup;
            } catch (cleanupError) {
                if (cleanupRunsPrivately) throw error;
                throw artifactRejected(new AggregateError([error, cleanupError], 'Ozon artifact cleanup failed'));
            }
        }
        if (error instanceof ToolExecutionError) throw error;
        throw artifactRejected(error);
    }
};
