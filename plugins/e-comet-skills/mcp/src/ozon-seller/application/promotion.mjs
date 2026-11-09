import { validateAuthorizedJobLimits } from './job-limits.mjs';
import { executeOzonReportPackage } from './package.mjs';
import { OZON_PROMOTION_OPERATION_MAX_MS } from '../domain/constants/limits.const.mjs';
import { ozonDescriptorRejected, safeOzonPromotionToolError } from '../domain/converters/errors.converter.mjs';
import { ozonPackageDeadline } from '../domain/converters/package-result.converter.mjs';
import { parsePromotionPeriods } from '../domain/policies/package.policy.mjs';
import { assertOzonPromotionPeriodEqual, ozonPromotionArtifactName } from '../domain/policies/promotion.policy.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { StorageUnavailableError } from '../../shared/storage-unavailable.mjs';
import { isRecord } from '../../shared/values.mjs';
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SIGNED_EXPIRY_SAFETY_RESERVE_MS = 1000;
const authorizationRejected = (cause) => new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The signed Ozon promotion authorization does not match this request.', 'authorization', false, { cause });
const artifactRejected = (cause) => new ToolExecutionError('ARTIFACT_REJECTED', 'The Ozon promotion workbook could not be stored safely.', 'artifact', false, { cause });
const publicArtifact = ({ name, mimeType, size, sha256 }) => ({ name, mimeType, size, sha256 });
const artifactResources = new WeakMap();
export const getOzonPromotionArtifactResource = (result) => artifactResources.get(result);
export const executeOzonPromotionJob = async ({ authorization, dateFrom: requestedFrom, dateTo: requestedTo, requestOzonPromotionReport, createArtifactWriter, jobBudget = { bytes: 0 }, now = Date.now, foreignJobs = undefined, }) => {
    const grant = isRecord(authorization) ? authorization : {};
    let period;
    try {
        validateAuthorizedJobLimits(authorization, foreignJobs);
        if (grant.jobType !== 'ozon_seller_promotion_report')
            throw new Error('Wrong Ozon promotion job type');
        period = assertOzonPromotionPeriodEqual({ dateFrom: requestedFrom, dateTo: requestedTo }, grant.job);
    }
    catch (error) {
        throw ozonDescriptorRejected(error) ?? authorizationRejected(error);
    }
    // The canonical period is the requested one, unchanged.
    const { dateFrom, dateTo } = period;
    const startedAt = now();
    const signedDeadlineAt = typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt)
        ? Math.floor(grant.expiresAt * 1000 - SIGNED_EXPIRY_SAFETY_RESERVE_MS)
        : Infinity;
    const deadlineAt = Math.min(startedAt + OZON_PROMOTION_OPERATION_MAX_MS, signedDeadlineAt);
    const operationTimeoutMs = deadlineAt - startedAt;
    if (operationTimeoutMs < 1000) {
        throw new ToolExecutionError('OPERATION_DEADLINE_EXCEEDED', 'The signed Ozon promotion authorization does not leave enough time to start the operation.', 'deadline', false);
    }
    const stream = {};
    let published = false;
    try {
        const operationResult = await requestOzonPromotionReport({ dateFrom, dateTo, deadlineAt }, {
            onStart: async (_metadata, signal) => {
                if (stream.writer)
                    throw artifactRejected(new Error('Ozon artifact stream started more than once'));
                stream.writer = await createArtifactWriter({
                    fileName: ozonPromotionArtifactName(dateFrom, dateTo),
                    mimeType: XLSX_MIME_TYPE,
                    validateXlsx: true,
                    jobBudget,
                    ...(signal === undefined ? {} : { signal }),
                });
            },
            onChunk: async (index, data) => {
                if (!stream.writer || stream.completion)
                    throw artifactRejected(new Error('Ozon artifact chunk is out of order'));
                await stream.writer.appendChunk(index, data);
            },
            onEnd: async (metadata) => {
                if (!stream.writer || stream.completion)
                    throw artifactRejected(new Error('Ozon artifact end is out of order'));
                stream.completion = metadata;
                stream.artifact = await stream.writer.complete(metadata);
            },
        }, operationTimeoutMs);
        const outcome = isRecord(operationResult) ? operationResult : {};
        if (outcome.ok === false)
            throw safeOzonPromotionToolError(outcome.error);
        if (outcome.ok !== true || !stream.writer || !stream.completion || !stream.artifact) {
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
    }
    catch (error) {
        if (stream.writer && !published) {
            const cleanupRunsPrivately = error instanceof ToolExecutionError &&
                (error.code === 'OPERATION_CANCELLED' || error.code === 'OPERATION_DEADLINE_EXCEEDED');
            try {
                const cleanup = stream.writer.abort();
                if (cleanupRunsPrivately)
                    Promise.resolve(cleanup).catch(() => undefined);
                else
                    await cleanup;
            }
            catch (cleanupError) {
                if (cleanupRunsPrivately)
                    throw error;
                throw artifactRejected(new AggregateError([error, cleanupError], 'Ozon artifact cleanup failed'));
            }
        }
        if (error instanceof ToolExecutionError || error instanceof StorageUnavailableError)
            throw error;
        throw artifactRejected(error);
    }
};
export const executeOzonPromotionPackageJob = async ({ authorization, periods, requestOzonReportPackage, createArtifactWriter, jobBudget = { bytes: 0 }, now = Date.now, foreignJobs = undefined, }) => {
    const grant = isRecord(authorization) ? authorization : {};
    try {
        validateAuthorizedJobLimits(authorization, foreignJobs);
        if (grant.jobType !== 'ozon_seller_promotion_reports')
            throw new Error('Wrong Ozon promotion package job type');
        const requested = parsePromotionPeriods(periods);
        const signed = parsePromotionPeriods(isRecord(grant.job) ? grant.job.periods : undefined);
        if (JSON.stringify(requested) !== JSON.stringify(signed))
            throw new Error('Signed Ozon promotion periods do not match');
    }
    catch (error) {
        throw ozonDescriptorRejected(error) ?? authorizationRejected(error);
    }
    return executeOzonReportPackage({
        family: 'promotion',
        jobType: 'ozon_seller_promotion_reports',
        // Parsed above: every period is an exact item object.
        items: Array.isArray(periods) ? periods.filter(isRecord) : [],
        packageDeadline: ozonPackageDeadline(authorization, now()),
        requestOzonReportPackage,
        createArtifactWriter,
        jobBudget,
        artifactName: ({ dateFrom, dateTo }) => ozonPromotionArtifactName(dateFrom, dateTo),
        normalizeError: (error) => {
            if (error instanceof StorageUnavailableError) {
                return { code: error.code, message: error.message, stage: error.stage, retryable: false };
            }
            const safe = safeOzonPromotionToolError(error);
            return {
                code: safe.code,
                message: safe.message,
                stage: safe.stage,
                retryable: false,
                ...(['OZON_EXECUTION_INTERRUPTED', 'ARTIFACT_REJECTED'].includes(safe.code) && safe.details
                    ? { details: safe.details }
                    : {}),
            };
        },
    });
};
