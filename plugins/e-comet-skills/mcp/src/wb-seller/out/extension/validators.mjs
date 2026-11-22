import { hasExactOwnKeys, hasOnlyOwnKeys, hasOwnKeys, isBoundedText, isCanonicalIsoDay, isHttpStatus, isNonNegativeSafeInteger, isOneOf, isRecord, isUnknownArray, UUID_V4, } from '../../../shared/values.mjs';
import { ARTIFACT_MAX_FILE_BYTES } from '../../../storage/limits.mjs';
import { COMPARISON_ARCHIVE_MIME_TYPE, COMPARISON_CREATE_OUTCOMES, COMPARISON_FAILURE_CODE, COMPARISON_FILE_STATUSES, COMPARISON_LOCAL_MINUTE_PATTERN, COMPARISON_STAGES, COMPARISON_STREAM_DEADLINE, isSellerOperationStage, parseComparisonArticles, parseComparisonDateBasis, parseComparisonDates, parseComparisonFailure, SELLER_OPERATION_STAGES, } from '../../../transport/extension/wire.mjs';
import { comparisonRelayFailureDetails, isComparisonRelayFailureCode } from '../../../transport/failures/vocabulary.mjs';
import { MAX_BROWSER_JOB_TEXT_LENGTH } from '../../../transport/mcp/limits.mjs';
// The Seller frames the extension may send and the operations this process may request: today's wire validators.
const MAX_STREAM_CHUNK_BYTES = 256 * 1024;
const MAX_BASE64_STREAM_CHUNK_LENGTH = 4 * Math.ceil(MAX_STREAM_CHUNK_BYTES / 3);
export const SELLER_XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const isValidBase64Chunk = (value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_STREAM_CHUNK_LENGTH || !BASE64_PATTERN.test(value)) {
        return false;
    }
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value && decoded.byteLength <= MAX_STREAM_CHUNK_BYTES;
};
// Parse boundary: an operation or frame payload of any shape, narrowed field by field.
export const isValidSellerOperation = (value) => {
    if (!isRecord(value) || !hasOnlyOwnKeys(value, ['exportIndex', 'isAnswered', 'stage', 'reportId']))
        return false;
    if (!isNonNegativeSafeInteger(value.exportIndex) || typeof value.isAnswered !== 'boolean' || !isSellerOperationStage(value.stage)) {
        return false;
    }
    return value.stage === SELLER_OPERATION_STAGES.create
        ? value.reportId === undefined
        : typeof value.reportId === 'string' && value.reportId.length > 0 && value.reportId.length <= MAX_BROWSER_JOB_TEXT_LENGTH;
};
export const isValidSellerStreamStart = (value) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['mimeType', 'declaredSize']) &&
    isOneOf([SELLER_XLSX_MIME_TYPE, COMPARISON_ARCHIVE_MIME_TYPE], value.mimeType) &&
    (value.declaredSize === undefined || (isNonNegativeSafeInteger(value.declaredSize) && value.declaredSize <= ARTIFACT_MAX_FILE_BYTES));
export const isValidSellerStreamChunk = (value) => isRecord(value) && hasOnlyOwnKeys(value, ['index', 'data']) && isNonNegativeSafeInteger(value.index) && isValidBase64Chunk(value.data);
export const isValidSellerStreamEnd = (value) => isRecord(value) &&
    hasOnlyOwnKeys(value, ['size', 'sha256']) &&
    isNonNegativeSafeInteger(value.size) &&
    typeof value.sha256 === 'string' &&
    SHA256_PATTERN.test(value.sha256);
// Each response is read against the correlated operation's own stage. The worker's comparison ID stays out of the
// result the executor can publish. Workbook status metadata consists only of the safe fields of the pinned row.
const comparisonText = (value) => isBoundedText(value, MAX_BROWSER_JOB_TEXT_LENGTH);
const comparisonUuid = new RegExp('^' + UUID_V4 + '$');
const parseComparisonOrg = (value) => {
    if (!isRecord(value) || !hasOwnKeys(value, ['id']) || !hasOnlyOwnKeys(value, ['id', 'name']) || !comparisonText(value.id))
        return;
    if (!Object.hasOwn(value, 'name'))
        return { id: value.id };
    if (comparisonText(value.name))
        return { id: value.id, name: value.name };
};
const localMinutePattern = new RegExp(COMPARISON_LOCAL_MINUTE_PATTERN);
const isComparisonLocalMinute = (value) => typeof value === 'string' && localMinutePattern.test(value) && isCanonicalIsoDay(value.slice(0, 10));
const parseComparisonReport = (value, ready) => {
    if (!isRecord(value) ||
        !hasOwnKeys(value, ['name', 'generatedAt']) ||
        !hasOnlyOwnKeys(value, ['name', 'generatedAt', 'generatedAtLocal', 'startDate', 'endDate']) ||
        !comparisonText(value.name) ||
        (value.generatedAt !== null && !comparisonText(value.generatedAt)) ||
        (Object.hasOwn(value, 'startDate') && !isCanonicalIsoDay(value.startDate)) ||
        (Object.hasOwn(value, 'endDate') && !isCanonicalIsoDay(value.endDate)))
        return;
    const hasLocalTime = Object.hasOwn(value, 'generatedAtLocal');
    const generatedAtLocal = hasLocalTime ? value.generatedAtLocal : undefined;
    if (hasLocalTime && generatedAtLocal !== null && (!ready || value.generatedAt === null || !isComparisonLocalMinute(generatedAtLocal)))
        return;
    return {
        name: value.name,
        generatedAt: value.generatedAt,
        ...(generatedAtLocal === null || typeof generatedAtLocal === 'string' ? { generatedAtLocal } : {}),
        ...(Object.hasOwn(value, 'startDate') && isCanonicalIsoDay(value.startDate) ? { startDate: value.startDate } : {}),
        ...(Object.hasOwn(value, 'endDate') && isCanonicalIsoDay(value.endDate) ? { endDate: value.endDate } : {}),
    };
};
const parseComparisonSuccess = (data, stage) => {
    if (!isRecord(data) || data.stage !== stage)
        return;
    if (stage === 'list_orgs') {
        if (!hasExactOwnKeys(data, ['stage', 'organizations']) ||
            !isUnknownArray(data.organizations) ||
            data.organizations.length === 0 ||
            data.organizations.length > 1000)
            return;
        const organizations = data.organizations.map(parseComparisonOrg);
        if (organizations.every((org) => org !== undefined) && new Set(organizations.map(({ id }) => id)).size === organizations.length)
            return { stage, organizations };
        return;
    }
    if (stage === 'compare') {
        const { org, nmIds, dateFrom, dateTo, comparisonId, source, createOutcome } = data;
        const organization = parseComparisonOrg(org);
        const articles = parseComparisonArticles(nmIds);
        const dates = parseComparisonDates({ dateFrom, dateTo });
        const periodBasis = parseComparisonDateBasis(data.periodBasis);
        if (hasExactOwnKeys(data, [
            'stage',
            'org',
            'nmIds',
            'dateFrom',
            'dateTo',
            'periodBasis',
            'comparisonId',
            'source',
            'createOutcome',
        ]) &&
            organization &&
            articles &&
            dates &&
            periodBasis &&
            comparisonText(comparisonId) &&
            (source === 'history' || source === 'created') &&
            isOneOf(COMPARISON_CREATE_OUTCOMES, createOutcome))
            return { stage, org: organization, nmIds: articles, ...dates, periodBasis, source, createOutcome };
        return;
    }
    const { exportId } = data;
    if (typeof exportId !== 'string' || !comparisonUuid.test(exportId))
        return;
    if (stage === 'create_xlsx') {
        if (hasExactOwnKeys(data, ['stage', 'exportId', 'orderOutcome']) && isOneOf(['confirmed', 'unknown'], data.orderOutcome))
            return { stage, exportId, orderOutcome: data.orderOutcome };
        return;
    }
    if (stage !== 'poll_xlsx' || !isOneOf(COMPARISON_FILE_STATUSES, data.fileStatus))
        return;
    const hasReport = Object.hasOwn(data, 'report');
    const keys = hasReport ? ['stage', 'exportId', 'fileStatus', 'report'] : ['stage', 'exportId', 'fileStatus'];
    if (!hasExactOwnKeys(data, keys))
        return;
    if (!hasReport)
        return { stage, exportId, fileStatus: data.fileStatus };
    const report = parseComparisonReport(data.report, data.fileStatus === 'SUCCESS');
    if (report && data.fileStatus !== 'missing')
        return { stage, exportId, fileStatus: data.fileStatus, report };
};
export const isValidComparisonOperation = (value) => isRecord(value) &&
    hasExactOwnKeys(value, ['kind', 'stage']) &&
    value.kind === 'card_comparison' &&
    isOneOf(COMPARISON_STAGES, value.stage) &&
    value.stage !== 'list_orgs';
export const isValidSellerListOrgsOperation = (value) => isRecord(value) && hasExactOwnKeys(value, ['kind']) && value.kind === 'list_orgs';
const COMPARISON_ADMISSION_REFUSALS = ['BROWSER_JOB_EXPIRED', 'BROWSER_JOB_NOT_AUTHORIZED', 'SELLER_OPERATION_NOT_AUTHORIZED'];
const LEGACY_COMPARISON_ADMISSION_REFUSALS = [
    'BROWSER_JOB_NOT_AUTHORIZED',
    'DUPLICATE_REQUEST_ID',
    'TOO_MANY_PENDING_REQUESTS',
    'SELLER_OPERATION_NOT_AUTHORIZED',
    'SELLER_OPERATION_TIMEOUT',
];
const unsentComparisonWrite = (stage) => {
    if (stage === 'compare')
        return { createOutcome: 'not_sent' };
    if (stage === 'create_xlsx')
        return { orderOutcome: 'not_sent' };
};
export const parseComparisonResponse = (response, stage) => {
    if (!isRecord(response))
        return;
    if (hasExactOwnKeys(response, ['data']))
        return parseComparisonSuccess(response.data, stage);
    if (response.code === COMPARISON_FAILURE_CODE) {
        const failure = parseComparisonFailure(response);
        if (failure?.stage !== stage)
            return;
        const { httpStatus, ...evidence } = failure;
        const org = stage !== 'list_orgs' && Object.hasOwn(response, 'org') ? parseComparisonOrg(response.org) : undefined;
        if (failure.periodBasis && !org)
            return;
        return { ...evidence, ...(org ? { org } : {}), ...(httpStatus === undefined ? {} : { details: { httpStatus } }) };
    }
    if (typeof response.error !== 'string' || !isComparisonRelayFailureCode(response.code))
        return;
    const { code, createOutcome, orderOutcome } = response;
    if (Object.hasOwn(response, 'reason') && response.reason === COMPARISON_STREAM_DEADLINE.reason) {
        if (code === COMPARISON_STREAM_DEADLINE.code &&
            stage === COMPARISON_STREAM_DEADLINE.stage &&
            response.stage === stage &&
            hasOnlyOwnKeys(response, ['code', 'error', 'reason', 'stage', 'createOutcome', 'orderOutcome', 'org']) &&
            isOneOf(COMPARISON_CREATE_OUTCOMES, createOutcome) &&
            isOneOf(COMPARISON_CREATE_OUTCOMES, orderOutcome)) {
            const org = Object.hasOwn(response, 'org') ? parseComparisonOrg(response.org) : undefined;
            return {
                code,
                stage,
                createOutcome,
                orderOutcome,
                ...(org ? { org } : {}),
                details: { reason: COMPARISON_STREAM_DEADLINE.reason },
            };
        }
        return;
    }
    const details = comparisonRelayFailureDetails(code, response.reason);
    if (details?.reason === 'multiple_seller_documents' && stage !== 'list_orgs' && stage !== 'compare')
        return;
    const failure = { stage, code, ...(details ? { details } : {}) };
    if (!Object.hasOwn(response, 'stage') && !Object.hasOwn(response, 'createOutcome') && !Object.hasOwn(response, 'orderOutcome')) {
        return hasExactOwnKeys(response, ['code', 'error']) && isOneOf(LEGACY_COMPARISON_ADMISSION_REFUSALS, code)
            ? { ...failure, ...unsentComparisonWrite(stage) }
            : failure;
    }
    // These exact worker replies precede admission. They say nothing about an earlier comparison or order.
    if (response.stage === stage && hasExactOwnKeys(response, ['code', 'error', 'stage']) && isOneOf(COMPARISON_ADMISSION_REFUSALS, code))
        return { ...failure, ...unsentComparisonWrite(stage) };
    if (response.stage === stage &&
        isOneOf(COMPARISON_CREATE_OUTCOMES, createOutcome) &&
        isOneOf(COMPARISON_CREATE_OUTCOMES, orderOutcome)) {
        const org = stage !== 'list_orgs' && Object.hasOwn(response, 'org') ? parseComparisonOrg(response.org) : undefined;
        const settled = { ...failure, createOutcome, orderOutcome, ...(org ? { org } : {}) };
        if (!Object.hasOwn(response, 'httpStatus'))
            return settled;
        const { httpStatus } = response;
        if ((stage === 'list_orgs' || stage === 'compare') &&
            (code === 'SELLER_CABINET_UNAUTHORIZED' || code === 'ENTITY_CATALOG_UNAVAILABLE') &&
            isHttpStatus(httpStatus))
            return { ...settled, details: { ...details, httpStatus } };
    }
};
