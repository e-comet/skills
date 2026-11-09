import { ozonPackageAuthorizationWorkflow, ozonPackageError, ozonPromotionArtifactSchema, ozonTriggerUrlProperty, packageItemSchemas, packageResultSchema, promotionPeriodFields, reportToolAnnotations, } from './reports.mjs';
import { MAX_OZON_REPORT_PACKAGE_ITEMS } from '../domain/constants/limits.const.mjs';
import { OZON_PROMOTION_TERMINAL_CODE_STAGES } from '../../transport/failures/vocabulary.mjs';
import { BRIDGE_FAILURE_GUIDANCE, authorizationEndGuidance, completeContractGuidance, packageSafety, rejectionAndHandoffGuidance, reportDeliveryGuidance, runningAnswerGuidance, signedDiscovery, } from '../../transport/mcp/prose.mjs';
import { withOperationDiagnostic, withRunningAnswer } from '../../transport/mcp/results.mjs';
import { array, object } from '../../transport/mcp/schema.mjs';
const promotionPackageItems = packageItemSchemas(promotionPeriodFields, ozonPromotionArtifactSchema, ozonPackageError(OZON_PROMOTION_TERMINAL_CODE_STAGES));
const promotionPackageContract = 'Download an ordered package of up to 50 Ozon Seller promotion analytics XLSX workbooks. ' +
    ozonPackageAuthorizationWorkflow('ozon_seller_promotion_reports', 'periods:[{dateFrom,dateTo},...]') +
    reportDeliveryGuidance +
    rejectionAndHandoffGuidance +
    BRIDGE_FAILURE_GUIDANCE +
    'Each period independently uses canonical inclusive dates and may contain at most 89 inclusive days. Periods may overlap and need not be chronological; exact duplicates are rejected and there is no aggregate-day cap. ' +
    'One browser authorization and one local call cover the whole ordered package. Completed workbooks remain available when later items fail; return every completed resource_link and report every failed and skipped item from the ordered result. ' +
    'The operation may create saved reports in Ozon, but it does not change products, campaigns, budgets, or seller settings. ' +
    'Returns compact metadata and one private resource_link per completed workbook. The resource_link contains a local file URI; workbook bytes, base64, company context, report identifiers, and request details are not included in model content.';
export const contract = {
    name: 'ozon_seller_promotion_reports',
    description: 'Download an ordered package of Ozon Seller promotion report XLSX workbooks for requested periods. ' +
        signedDiscovery('ozon_seller_promotion_reports', 'ozon_seller_promotion_reports') +
        packageSafety +
        completeContractGuidance,
    inputSchema: object({
        periods: array(object(promotionPeriodFields, ['dateFrom', 'dateTo']), {
            minItems: 1,
            maxItems: MAX_OZON_REPORT_PACKAGE_ITEMS,
            uniqueItems: true,
        }),
        triggerUrl: ozonTriggerUrlProperty,
    }, ['periods']),
    outputSchema: withRunningAnswer(withOperationDiagnostic(packageResultSchema('ozon_seller_promotion_reports', 'periods', promotionPackageItems))),
    annotations: reportToolAnnotations,
    workflow: {
        appliesTo: ['browser_job', 'ozon_seller_promotion_reports'],
        text: `${promotionPackageContract.trimEnd()} ${authorizationEndGuidance} ${runningAnswerGuidance}`,
    },
};
