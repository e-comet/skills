import { toolFailure } from '../../../mcp-protocol/results/serialize.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
import { fieldOf, isPositiveSafeInteger } from '../../../shared/values.mjs';
export const withSellerJobLease = async (authorization, triggerUrl, jobType, validate, execute, releaseFailure) => {
    let lease;
    let authorized = false;
    let result;
    let failure;
    try {
        lease = await authorization.authorize(triggerUrl);
        const grant = lease?.authorization;
        const attestedType = fieldOf(grant, 'jobType');
        const authorizationId = fieldOf(grant, 'authorizationId');
        const expiresAt = fieldOf(grant, 'expiresAt');
        if (!lease || typeof authorizationId !== 'string' || !authorizationId || !isPositiveSafeInteger(expiresAt)) {
            throw new ToolExecutionError('BROWSER_JOB_LEASE_INVALID', 'The extension returned an invalid Seller authorization lease. Offer to report it to e-Comet.', 'local');
        }
        if (typeof attestedType === 'string' && attestedType !== jobType) {
            throw new ToolExecutionError('BROWSER_JOB_TYPE_MISMATCH', `The signed browser job belongs to a different tool. This operation requires a ${jobType} job.`, 'authorization');
        }
        const { job } = validate(grant);
        authorized = true;
        result = await execute(job, expiresAt, lease);
    }
    catch (error) {
        failure = error;
    }
    let releaseError;
    if (lease) {
        try {
            if (!(await lease.releaseAndWait()))
                releaseError = releaseFailure(authorized);
        }
        catch (error) {
            releaseError = releaseFailure(authorized, error);
        }
    }
    return { result, failure, releaseError };
};
export const unconfirmedSellerRelease = (authorization, cause) => {
    const failure = (code, message) => toolFailure(new ToolExecutionError(code, message, 'extension', false, { cause }));
    const code = cause instanceof ToolExecutionError ? cause.code : undefined;
    if (code === 'EXTENSION_DISCONNECTED')
        return failure(code, `The browser connection closed before e-Comet received confirmation that ${authorization} was released.`);
    if (code === 'BROWSER_JOB_AUTHORIZATION_RELEASE_TIMEOUT')
        return failure(code, `The extension did not confirm release of ${authorization} before the release deadline.`);
    return failure('SELLER_AUTHORIZATION_RELEASE_FAILED', `The extension did not confirm release of ${authorization}.`);
};
