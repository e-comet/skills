import { ozonPackageAuthorizationWorkflow, ozonPackageError, ozonTriggerUrlProperty, packageItemSchemas, packageResultSchema, promotionPeriodFields, reportToolAnnotations, } from './reports.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from '../domain/constants/limits.const.mjs';
import { OZON_ANALYTICS_TERMINAL_CODE_STAGES } from '../../transport/extension/wire.mjs';
import { BRIDGE_FAILURE_GUIDANCE, authorizationEndGuidance, completeContractGuidance, packageSafety, rejectionAndHandoffGuidance, reportDeliveryGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, nonNegativeInteger, object } from '../../transport/mcp/schema.mjs';
const ozonAnalyticsArtifactSchema = object({
    name: { type: 'string', pattern: '^ozon-seller-analytics-(period|daily)-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}\\.xlsx$' },
    mimeType: { const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    size: nonNegativeInteger,
    sha256: { type: 'string', minLength: 64, maxLength: 64 },
}, ['name', 'mimeType', 'size', 'sha256']);
const analyticsReportFields = {
    ...promotionPeriodFields,
    breakdown: { type: 'string', enum: ['period', 'daily'] },
};
const analyticsPackageItems = packageItemSchemas(analyticsReportFields, ozonAnalyticsArtifactSchema, ozonPackageError(OZON_ANALYTICS_TERMINAL_CODE_STAGES, true));
const analyticsPackageContract = 'Download an ordered package of up to 50 Ozon Seller general analytics XLSX workbooks. ' +
    ozonPackageAuthorizationWorkflow('ozon_seller_analytics_report', 'reports:[{dateFrom,dateTo,breakdown},...]') +
    reportDeliveryGuidance +
    rejectionAndHandoffGuidance +
    BRIDGE_FAILURE_GUIDANCE +
    'Each report independently uses canonical inclusive dates, an explicit breakdown:"period" or breakdown:"daily", at most 731 inclusive days, and the signed Moscow issuance window. ' +
    'daily means daily rows inside one XLSX workbook for that report; never create one report per day unless the user explicitly requests separate date items. ' +
    'REPORT_TERMINAL_FAILURE may include details.marketplaceErrorCode: retain this observed numeric code in a consented bug report, but never invent its business meaning or treat it as permission to retry create. ' +
    'Ranges may overlap and need not be chronological; the same range with different breakdowns is valid, exact duplicate descriptors are rejected, and there is no aggregate-day cap. ' +
    'One browser authorization and one local call cover the whole ordered package. Completed workbooks remain available when later items fail; return every completed resource_link and report every failed and skipped item from the ordered result. ' +
    'Check that the connected extension advertises the analytics capability; tool presence alone is not readiness. ' +
    'Promotion analytics remains a separate Ozon workflow. The operation may create saved reports in Ozon, but it does not change products, campaigns, budgets, or seller settings. ' +
    'Returns compact metadata and one private resource_link per completed workbook. The resource_link contains a local file URI; workbook bytes, base64, company context, report identifiers, and request details are not included in model content.';
export const contract = {
    name: 'ozon_seller_analytics_report',
    description: 'Download Ozon Seller general analytics XLSX in an ordered package with period or daily breakdown. daily means daily rows in one workbook per report, not one report per day. ' +
        signedDiscovery('ozon_seller_analytics_report', 'ozon_seller_analytics_report') +
        packageSafety +
        completeContractGuidance,
    inputSchema: object({
        reports: array(object(analyticsReportFields, ['dateFrom', 'dateTo', 'breakdown']), {
            minItems: 1,
            maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS,
            uniqueItems: true,
        }),
        triggerUrl: ozonTriggerUrlProperty,
    }, ['reports']),
    outputSchema: withRunningAnswer(withOperationDiagnostic(packageResultSchema('ozon_seller_analytics_report', 'reports', analyticsPackageItems))),
    annotations: reportToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'ozon_seller_analytics_report'],
        text: `${analyticsPackageContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
