import { resourceLinkResult } from '../mcp-protocol/results/serialize.mjs';
import { validateAuthorizedJobLimits as validateOzonJobLimits } from '../ozon-seller/application/job-limits.mjs';
import { createAuthorize } from '../ozon-seller/in/mcp/authorize.mjs';
import { createPackageTool } from '../ozon-seller/in/mcp/package.tool.mjs';
import { createPromotionReportTool } from '../ozon-seller/in/mcp/promotion-report.tool.mjs';
import { createSearchPositionsTool } from '../ozon-seller/in/mcp/search-positions.tool.mjs';
import { createArtifacts } from '../ozon-seller/out/artifacts/xlsx.mjs';
import { createAuthorization } from '../ozon-seller/out/extension/authorization.mjs';
import { isRecord } from '../shared/values.mjs';
import { validateAuthorizedJobLimits as validateBuyerJobLimits } from '../wb-client/application/job-limits.mjs';
import { BUYER_JOB_TYPES } from '../wb-client/domain/constants/descriptors.const.mjs';
import { validateAuthorizedJobLimits as validateSellerJobLimits } from '../wb-seller/application/job-limits.mjs';
// The buyer, filters and seller descriptor checks an Ozon job reads for a foreign signed job (ozon-seller's foreign-jobs
// port): each context checks its own job types.
export const foreignJobs = {
    validate: (authorization) => {
        const jobType = isRecord(authorization) ? authorization.jobType : undefined;
        if (BUYER_JOB_TYPES.has(jobType)) {
            validateBuyerJobLimits(authorization);
            return true;
        }
        if (jobType === 'seller_reviews') {
            validateSellerJobLimits(authorization);
            return true;
        }
        return false;
    },
};
// The descriptor check of every signed job type, as an Ozon job runs it.
// Parse boundary: the signed grant, read field by field.
export const validateAuthorizedJobLimits = (authorization) => validateOzonJobLimits(authorization, foreignJobs);
/**
 * The ozon-seller tools' handlers the MCP root registers: `registry` is the dispatcher's (answer with its receipt, a
 * failure carrying a downloaded update), `options` the root's collaborators: the bridge status, the broker connect, the
 * authorization request, the Ozon promotion and package state machines over the root's request broker, the artifact
 * root and the host's report copy folder. Tests replace the workbook writer, the result rendering and the clock.
 */
export const ozonSellerTools = (registry, { getBridgeStatus, ensureBroker, requestBrowserJobAuthorization, ozonPromotion, ozonPackage, artifactStorageTarget = undefined, createOzonArtifactWriter = undefined, renderOzonResult = resourceLinkResult, reportOutputDirectory = undefined, now = Date.now, }) => {
    const authorization = createAuthorization({ ensureBroker, requestBrowserJobAuthorization });
    const authorize = createAuthorize({ authorization, getBridgeStatus });
    const artifacts = createArtifacts({
        ...(artifactStorageTarget === undefined ? {} : { storageTarget: artifactStorageTarget }),
        ...(createOzonArtifactWriter === undefined ? {} : { createArtifactWriter: createOzonArtifactWriter }),
    });
    const shared = {
        authorize,
        artifacts,
        withDownloadedUpdate: registry.withDownloadedUpdate,
        renderOzonResult,
        reportOutputDirectory,
        now,
        foreignJobs,
    };
    return [
        [
            'ozon_seller_promotion_report',
            createPromotionReportTool({ ...shared, answer: registry.answer('ozon_seller_promotion_report'), authorization, ozonPromotion }),
        ],
        [
            'ozon_seller_promotion_reports',
            createPackageTool({ ...shared, family: 'promotion', answer: registry.answer('ozon_seller_promotion_reports'), ozonPackage }),
        ],
        [
            'ozon_seller_analytics_report',
            createPackageTool({ ...shared, family: 'analytics', answer: registry.answer('ozon_seller_analytics_report'), ozonPackage }),
        ],
        ['ozon_search_positions', createSearchPositionsTool({ ...shared, answer: registry.answer('ozon_search_positions'), ozonPackage })],
    ];
};
