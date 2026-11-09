import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { deliverReportResult } from '../../../mcp-protocol/results/links.mjs';
import { textResult } from '../../../mcp-protocol/results/serialize.mjs';
import { executeOzonAnalyticsJob, safeOzonAnalyticsToolError } from '../../application/analytics.mjs';
import { getOzonReportPackageArtifactResources } from '../../application/package.mjs';
import { executeOzonPromotionPackageJob } from '../../application/promotion.mjs';
import { contract as analyticsContract } from '../../contract/analytics-report.contract.mjs';
import { contract as promotionContract } from '../../contract/promotion-reports.contract.mjs';
import { isOzonPackageCapabilityFailure, safeOzonPromotionToolError } from '../../domain/converters/errors.converter.mjs';
import { rejectedOzonPackage } from '../../domain/converters/package-result.converter.mjs';
import { parseAnalyticsDateRange } from '../../domain/policies/analytics.policy.mjs';
import { parsePromotionPeriods } from '../../domain/policies/package.policy.mjs';
import { releaseAuthorizationInBackground } from './authorize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { StorageUnavailableError } from '../../../shared/storage-unavailable.mjs';
import { isRecord } from '../../../shared/values.mjs';
// The two report packages: ozon_seller_promotion_reports over periods and ozon_seller_analytics_report over reports.
const PACKAGE_TOOLS = {
    promotion: { toolName: 'ozon_seller_promotion_reports', contract: promotionContract },
    analytics: { toolName: 'ozon_seller_analytics_report', contract: analyticsContract },
};
/**
 * A report package of `family`. Keep package admission/result shaping distinct from the released singular contract:
 * valid pre-execution failures preserve item order/cardinality and a package stopReason, while singular errors retain
 * their legacy details schema and extension version floor. Both handlers start background lease release before
 * publication and release pins after the terminal response; neither waits for the extension to acknowledge lease
 * cleanup.
 */
export const createPackageTool = ({ family, answer, authorize, ozonPackage, artifacts, withDownloadedUpdate, renderOzonResult, reportOutputDirectory, now, foreignJobs, }) => {
    const { toolName, contract } = PACKAGE_TOOLS[family];
    return {
        needsBridge: true,
        // Parse boundary: the call's arguments, checked against the contract first.
        run: async (id, args = {}) => {
            const itemProperty = family === 'promotion' ? 'periods' : 'reports';
            const input = isRecord(args) ? args : {};
            const listed = input[itemProperty];
            // The contract admits only item objects; the list is read after it passed.
            const items = Array.isArray(listed) ? listed.filter(isRecord) : [];
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
                    const safe = family === 'analytics' ? safeOzonAnalyticsToolError(error) : safeOzonPromotionToolError(error);
                    return {
                        code: safe.code,
                        message: safe.message,
                        stage: safe.stage,
                        retryable: false,
                        ...(safe.details === undefined ? {} : { details: safe.details }),
                    };
                }
                catch {
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
                // Parse boundary: an item as the caller gave it.
                const safeItem = ({ dateFrom, dateTo, breakdown }) => ({
                    ...(typeof dateFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? { dateFrom } : {}),
                    ...(typeof dateTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? { dateTo } : {}),
                    ...(family === 'analytics' && (breakdown === 'period' || breakdown === 'daily') ? { breakdown } : {}),
                });
                const result = rejectedOzonPackage(toolName, itemProperty, items.map(safeItem), safeFailure(error));
                if (isOzonPackageCapabilityFailure(error))
                    result.stopReason = 'capability_unavailable';
                return result;
            };
            try {
                const validation = validateArguments(contract.inputSchema, args);
                if (!validation.ok)
                    throw new ToolExecutionError('PREFLIGHT_FAILED', invalidArgumentsMessage(toolName, validation), 'preflight', false);
                try {
                    if (family === 'promotion')
                        parsePromotionPeriods(items);
                    else
                        items.forEach(({ dateFrom, dateTo }) => parseAnalyticsDateRange(dateFrom, dateTo));
                }
                catch {
                    throw new ToolExecutionError('PREFLIGHT_FAILED', `The Ozon ${family} report package is invalid.`, 'preflight', false);
                }
                argumentsValid = true;
                authorizationLease = await authorize.authorizeOzonPackage(family, input.triggerUrl, () => artifacts.requireTarget());
                const lease = authorizationLease;
                const sharedExecution = {
                    authorization: authorizationLease.authorization,
                    requestOzonReportPackage: (packageRequest, handlers) => ozonPackage.run(packageRequest, handlers, lease),
                    createArtifactWriter: artifacts.create,
                    jobBudget,
                    now,
                    foreignJobs,
                };
                const result = family === 'promotion'
                    ? await executeOzonPromotionPackageJob({ ...sharedExecution, periods: items })
                    : await executeOzonAnalyticsJob({ ...sharedExecution, reports: items });
                const resources = getOzonReportPackageArtifactResources(result);
                reportArtifacts = resources;
                terminalResult = renderOzonResult(result, `Ozon Seller ${family} report package ${result.status}: ${resources.length} of ${items.length} XLSX workbook(s) available.`, resources, !result.ok);
            }
            catch (error) {
                terminalResult = textResult(failedPackage(await withDownloadedUpdate(error, isOzonPackageCapabilityFailure(error))), true);
            }
            finally {
                releaseAuthorizationInBackground(authorizationLease, `after Ozon ${family} report package completion`);
            }
            answer(id, await deliverReportResult(terminalResult, reportArtifacts, reportOutputDirectory));
        },
    };
};
