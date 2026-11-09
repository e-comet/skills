import { invalidArgumentsMessage, validateArguments } from '../../../mcp-protocol/registry/validate.mjs';
import { deliverReportResult } from '../../../mcp-protocol/results/links.mjs';
import { textResult } from '../../../mcp-protocol/results/serialize.mjs';
import { executeOzonPromotionJob, getOzonPromotionArtifactResource } from '../../application/promotion.mjs';
import { contract } from '../../contract/promotion-report.contract.mjs';
import { OZON_LEASE_DEFECT } from '../../domain/constants/errors.const.mjs';
import { OZON_PROMOTION_OPERATION_MAX_MS } from '../../domain/constants/limits.const.mjs';
import { classifyOzonAuthorizationFailure, isOzonPackageCapabilityFailure, safeOzonPromotionToolError, } from '../../domain/converters/errors.converter.mjs';
import { parseOzonPromotionPeriod } from '../../domain/policies/promotion.policy.mjs';
import { releaseAuthorizationInBackground } from './authorize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { StorageUnavailableError } from '../../../shared/storage-unavailable.mjs';
import { isRecord } from '../../../shared/values.mjs';
/**
 * ozon_seller_promotion_report: one signed promotion workbook for one period. The period is checked before anything else,
 * an extension that does not announce the promotion capability is refused before and after the broker wait so its
 * one-use authorization is not spent, and the operation runs under the lease through the promotion state machine.
 */
export const createPromotionReportTool = ({ answer, authorization, authorize, ozonPromotion, artifacts, withDownloadedUpdate, renderOzonResult, reportOutputDirectory, now, foreignJobs, }) => ({
    needsBridge: true,
    // Parse boundary: the call's arguments, checked against the contract first.
    run: async (id, args = {}) => {
        const toolName = 'ozon_seller_promotion_report';
        const { dateFrom, dateTo, triggerUrl } = isRecord(args) ? args : {};
        // One byte counter per call: every writer of this export shares it (spec §4.2).
        const jobBudget = { bytes: 0 };
        let authorizationLease;
        let terminalResult;
        let reportArtifacts = [];
        let periodValidated = false;
        const failureResult = (error) => {
            let normalized;
            try {
                if (error instanceof ToolExecutionError)
                    normalized = safeOzonPromotionToolError(error);
                else if (error instanceof StorageUnavailableError)
                    normalized = error;
            }
            catch {
                normalized = undefined;
            }
            const safeError = normalized
                ? {
                    code: normalized.code,
                    message: normalized.message,
                    stage: normalized.stage,
                    retryable: false,
                    ...(normalized instanceof ToolExecutionError && normalized.details !== undefined
                        ? { details: normalized.details }
                        : {}),
                }
                : {
                    code: 'ARTIFACT_REJECTED',
                    message: 'The Ozon promotion report could not be completed safely.',
                    stage: 'artifact',
                    retryable: false,
                };
            return {
                ok: false,
                status: 'failed',
                jobType: 'ozon_seller_promotion_report',
                ...(periodValidated ? { dateFrom, dateTo } : {}),
                error: safeError,
            };
        };
        try {
            const validation = validateArguments(contract.inputSchema, args);
            if (!validation.ok)
                throw new ToolExecutionError('PREFLIGHT_FAILED', invalidArgumentsMessage(toolName, validation), 'preflight', false);
            try {
                parseOzonPromotionPeriod(dateFrom, dateTo);
            }
            catch (error) {
                throw new ToolExecutionError('PREFLIGHT_FAILED', 'The Ozon promotion period is invalid.', 'preflight', false, {
                    cause: error,
                });
            }
            periodValidated = true;
            if (typeof triggerUrl !== 'string' || !triggerUrl) {
                throw new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', 'The trusted browser-job hook did not provide Ozon authorization.', 'authorization', false);
            }
            artifacts.requireTarget();
            // Проверка до авторизации, а не только на маршрутизации. Расширение без объявленной
            // возможности отвергает подписанное задание Ozon как неизвестный тип ещё в ответе на
            // browser_job_authorize, поэтому до маршрута дело не доходит и пользователь получил бы
            // отказ авторизации вместо диагноза. Заодно не тратится одноразовая подписанная
            // авторизация на заведомо неисполнимую операцию.
            const outdatedExtension = authorize.ozonExtensionOutdated(authorize.currentOzonStatus());
            if (outdatedExtension)
                throw outdatedExtension;
            const unavailable = await authorization.connect();
            if (unavailable)
                throw classifyOzonAuthorizationFailure(unavailable, authorize.currentOzonStatus());
            // WHY: readiness can attach an older extension after the first snapshot; do not spend its signed authorization.
            const readyExtensionOutdated = authorize.ozonExtensionOutdated(authorize.currentOzonStatus());
            if (readyExtensionOutdated)
                throw readyExtensionOutdated;
            try {
                authorizationLease = await authorization.authorize(triggerUrl);
            }
            catch (error) {
                throw classifyOzonAuthorizationFailure(error, authorize.currentOzonStatus());
            }
            // A lease bound to no scope cannot run the operation: that is our defect.
            if (!authorizationLease || typeof authorizationLease.scopeId !== 'string') {
                throw new ToolExecutionError('OZON_AUTHORIZATION_REJECTED', `The extension returned an invalid Ozon promotion authorization. ${OZON_LEASE_DEFECT}`, 'authorization', false);
            }
            const lease = authorizationLease;
            const result = await executeOzonPromotionJob({
                authorization: authorizationLease.authorization,
                dateFrom,
                dateTo,
                requestOzonPromotionReport: (operation, handlers, timeout = OZON_PROMOTION_OPERATION_MAX_MS) => ozonPromotion.run(operation, handlers, timeout, lease),
                createArtifactWriter: artifacts.create,
                jobBudget,
                now,
                foreignJobs,
            });
            // A completed job has its workbook.
            const resource = getOzonPromotionArtifactResource(result);
            reportArtifacts = resource ? [resource] : [];
            terminalResult = renderOzonResult(result, `Ozon Seller promotion report complete: one XLSX workbook for ${dateFrom} through ${dateTo}.`, reportArtifacts);
        }
        catch (error) {
            terminalResult = textResult(failureResult(await withDownloadedUpdate(error, isOzonPackageCapabilityFailure(error))), true);
        }
        finally {
            releaseAuthorizationInBackground(authorizationLease, 'after Ozon promotion report completion');
        }
        answer(id, await deliverReportResult(terminalResult, reportArtifacts, reportOutputDirectory));
    },
});
