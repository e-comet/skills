import { ozonPackageStopReason, rejectedOzonPackage } from './ozon-report-package-result.mjs';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IMMEDIATE_ABORT_CODES = new Set([
    'OZON_AUTHORIZATION_REJECTED',
    'BROWSER_JOB_REAUTHORIZATION_REQUIRED',
    'OZON_ADMISSION_CAPACITY_EXHAUSTED',
    'OZON_ROUTE_NOT_READY',
    'OZON_ANALYTICS_CAPABILITY_UNAVAILABLE',
    'OZON_CONTEXT_CHANGED',
    'OPERATION_CANCELLED',
    'OZON_RATE_LIMITED',
    'ARTIFACT_REJECTED',
    'OZON_EXECUTION_INTERRUPTED',
    'ARTIFACT_CLEANUP_FAILED',
    'JOB_ARTIFACT_QUOTA_EXCEEDED',
    'ARTIFACT_FILE_QUOTA_EXCEEDED',
    'ARTIFACT_TOTAL_QUOTA_EXCEEDED',
]);
const SYSTEMIC_CODES = new Set([
    'CREATE_SERVICE_UNAVAILABLE',
    'OPERATION_DEADLINE_EXCEEDED',
    'PREFLIGHT_FAILED',
    'POLL_FAILED',
    'POLL_EXHAUSTED',
    'DOWNLOAD_REJECTED',
]);
const PRIVATE_ARTIFACT_CODES = new Set([
    'ARTIFACT_CLEANUP_FAILED',
    'JOB_ARTIFACT_QUOTA_EXCEEDED',
    'ARTIFACT_FILE_QUOTA_EXCEEDED',
    'ARTIFACT_TOTAL_QUOTA_EXCEEDED',
]);
const artifactResources = new WeakMap();

const publicArtifact = ({ name, mimeType, size, sha256 }) => ({ name, mimeType, size, sha256 });
const createOzonPackageAbortPolicy = () => {
    let stopped = false;
    let reason;
    let consecutiveSystemicFailures = 0;
    return {
        record(result) {
            if (stopped) return { stop: true, reason };
            if (result.status === 'complete') consecutiveSystemicFailures = 0;
            else if (result.status === 'failed') {
                const code = result.error?.code;
                if (IMMEDIATE_ABORT_CODES.has(code)) {
                    stopped = true;
                    reason = code;
                } else if (SYSTEMIC_CODES.has(code)) {
                    consecutiveSystemicFailures += 1;
                    if (consecutiveSystemicFailures >= 3) {
                        stopped = true;
                        reason = 'SYSTEMIC_FAILURE_BREAKER';
                    }
                } else {
                    // A confirmed Ozon business outcome, including CREATE_REJECTED and
                    // CREATE_OUTCOME_UNKNOWN, is item-local and breaks a systemic streak.
                    consecutiveSystemicFailures = 0;
                }
            }
            return { stop: stopped, reason };
        },
        get stopped() {
            return stopped;
        },
        get reason() {
            return reason;
        },
    };
};

const packageResult = (jobType, resultProperty, results, stopCode, rejection) => {
    const completed = results.filter(({ status }) => status === 'complete').length;
    return {
        ok: completed > 0,
        status: completed === results.length ? 'complete' : completed > 0 ? 'partial' : 'failed',
        jobType,
        [resultProperty]: results.map((item, itemIndex) => ({ ...item, itemIndex })),
        stopReason: results.some(({ status }) => status === 'skipped') ? ozonPackageStopReason(stopCode) : null,
        ...(results.every(({ status }) => status === 'skipped') && rejection ? { error: rejection } : {}),
    };
};

const artifactFailure = {
    code: 'ARTIFACT_REJECTED',
    message: 'The Ozon report workbook could not be stored safely.',
    stage: 'artifact',
    retryable: false,
};
const unclassifiedFailure = {
    ...artifactFailure,
    message: 'The Ozon report could not be completed safely; the failure could not be classified.',
};

export const getOzonReportPackageArtifactResources = (result) => artifactResources.get(result) ?? [];

export const executeOzonReportPackage = async ({
    family,
    jobType,
    items,
    artifactJobId,
    packageDeadline,
    requestOzonReportPackage,
    createArtifactWriter,
    artifactName,
    normalizeError,
    now = Date.now,
}) => {
    const resultProperty = family === 'promotion' ? 'periods' : 'reports';
    const results = new Array(items.length);
    const streams = new Map();
    const resources = [];
    const abortPolicy = createOzonPackageAbortPolicy();
    let activeIndex = 0;
    const phases = new Map();
    let stopCode;
    let rejection;
    let notStarted = false;

    const normalizedFailure = (item, error) => {
        if (PRIVATE_ARTIFACT_CODES.has(error?.code)) return { ...item, status: 'failed', error: artifactFailure };
        let safe = unclassifiedFailure;
        try {
            safe = normalizeError(error);
        } catch {
            safe = unclassifiedFailure;
        }
        return { ...item, status: 'failed', error: safe };
    };
    const abortStream = async (index, deferCleanup = false) => {
        const stream = streams.get(index);
        if (stream) stream.cancelled = true;
        if (!stream?.writer) return undefined;
        try {
            const cleanup = stream.writer.abort();
            if (deferCleanup) {
                // The broker fenced this item's active writer. Its store retains pending
                // cleanup and pins; a blocked syscall cannot delay the authenticated failure.
                void cleanup.catch(() => undefined);
                return undefined;
            }
            await cleanup;
            return undefined;
        } catch {
            return artifactFailure;
        }
    };
    const stopAt = (index, failure) => {
        results[index] = failure;
        for (let next = index + 1; next < items.length; next += 1) results[next] = { ...items[next], status: 'skipped' };
    };

    try {
        await requestOzonReportPackage(
            { family, items, deadlineAt: packageDeadline },
            {
                onNotStarted: (error) => {
                    notStarted = true;
                    rejection = normalizedFailure(items[0], error).error;
                    stopCode ??= rejection.code;
                },
                onItemPhase: async (itemIndex, phase) => {
                    activeIndex = itemIndex;
                    phases.set(itemIndex, phase);
                },
                onItemStart: async (itemIndex, _metadata, signal) => {
                    activeIndex = itemIndex;
                    if (abortPolicy.stopped) return;
                    if (streams.has(itemIndex)) throw new Error('Ozon package artifact stream started more than once');
                    const stream = {};
                    streams.set(itemIndex, stream);
                    stream.writer = await createArtifactWriter({
                        jobId: artifactJobId,
                        fileName: artifactName(items[itemIndex], itemIndex),
                        mimeType: XLSX_MIME_TYPE,
                        validateXlsx: true,
                        ...(signal === undefined ? {} : { signal }),
                    });
                    if (stream.cancelled) void stream.writer.abort().catch(() => undefined);
                },
                onItemChunk: async (itemIndex, chunkIndex, data) => {
                    activeIndex = itemIndex;
                    const stream = streams.get(itemIndex);
                    if (abortPolicy.stopped) return;
                    if (!stream?.writer || stream.artifact) throw new Error('Ozon package artifact chunk is out of order');
                    await stream.writer.appendChunk(chunkIndex, data);
                },
                onItemEnd: async (itemIndex, metadata) => {
                    activeIndex = itemIndex;
                    const stream = streams.get(itemIndex);
                    if (abortPolicy.stopped) return;
                    if (!stream?.writer || stream.artifact) throw new Error('Ozon package artifact end is out of order');
                    const artifact = await stream.writer.complete(metadata);
                    if (!stream.cancelled) stream.artifact = artifact;
                },
                onItemResult: async (itemIndex, remoteResult, { deferCleanup = false, commitArtifact = () => true } = {}) => {
                    activeIndex = itemIndex;
                    if (abortPolicy.stopped) {
                        await abortStream(itemIndex);
                        if (remoteResult?.status !== 'skipped') {
                            throw new Error('Ozon package remainder did not carry an authenticated skipped terminal.');
                        }
                        results[itemIndex] = { ...items[itemIndex], status: 'skipped' };
                        return;
                    }
                    const stream = streams.get(itemIndex);
                    let itemResult;
                    let cleanupFailure;
                    if (remoteResult?.status === 'skipped') {
                        const safe = normalizedFailure(items[itemIndex], remoteResult.error).error;
                        stopCode ??= abortPolicy.reason ?? safe.code;
                        rejection ??= safe;
                        cleanupFailure = await abortStream(itemIndex);
                        if (cleanupFailure) itemResult = normalizedFailure(items[itemIndex], cleanupFailure);
                        else itemResult = { ...items[itemIndex], status: 'skipped' };
                    } else if (remoteResult?.ok === true && stream?.artifact) {
                        // Publish only after the broker has detached this accepted file
                        // from cancellation. A cancelled/stale handler cannot commit it.
                        if (!commitArtifact()) return;
                        itemResult = { ...items[itemIndex], status: 'complete', artifact: publicArtifact(stream.artifact) };
                        resources.push(stream.artifact);
                    } else {
                        cleanupFailure = await abortStream(itemIndex, deferCleanup);
                        itemResult = normalizedFailure(items[itemIndex], cleanupFailure ?? remoteResult?.error ?? artifactFailure);
                    }
                    results[itemIndex] = itemResult;
                    const decision = abortPolicy.record(itemResult);
                    if (decision.stop) {
                        stopCode ??= decision.reason;
                        if (remoteResult?.ok === false && cleanupFailure === undefined) return;
                        throw Object.assign(new Error(itemResult.error?.message ?? 'The Ozon report package stopped.'), {
                            code: itemResult.error?.code ?? 'ARTIFACT_REJECTED',
                            stage: itemResult.error?.stage ?? 'artifact',
                            retryable: false,
                        });
                    }
                },
                onCancel: () => undefined,
            }
        );
    } catch (error) {
        stopCode ??= error?.code;
        if (notStarted) {
            const result = rejectedOzonPackage(jobType, resultProperty, items, rejection);
            artifactResources.set(result, resources);
            return result;
        } else if (!results[activeIndex]) {
            // The broker has terminated the package and fenced its writer. Private I/O must not
            // delay the terminal response or replace its cause; the store owns deferred cleanup.
            void abortStream(activeIndex);
            const failure = phases.get(activeIndex) === 'create_dispatched'
                ? { code: 'CREATE_OUTCOME_UNKNOWN', stage: 'create', retryable: false,
                    message: 'The Ozon report create outcome could not be confirmed.' }
                : error;
            stopAt(activeIndex, normalizedFailure(items[activeIndex], failure));
        } else {
            for (let index = activeIndex + 1; index < items.length; index += 1) {
                if (!results[index]) results[index] = { ...items[index], status: 'skipped' };
            }
        }
    }

    for (let index = 0; index < items.length; index += 1) {
        if (results[index]) continue;
        const cleanupFailure = await abortStream(index);
        results[index] = abortPolicy.stopped
            ? { ...items[index], status: 'skipped' }
            : normalizedFailure(items[index], cleanupFailure ?? artifactFailure);
    }
    const result = packageResult(jobType, resultProperty, results, stopCode, rejection);
    artifactResources.set(result, resources);
    return result;
};
