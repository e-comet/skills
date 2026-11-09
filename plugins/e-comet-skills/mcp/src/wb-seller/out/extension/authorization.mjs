import { bridgeCauseError } from '../../../bridge/cause.mjs';
import { extractBrowserJobToken } from '../../../handoff/call-result.mjs';
/**
 * A signed job's lease: the bridge must have a broker, whose absence is its cause, and the extension authorizes the token
 * the trigger URL carries.
 */
export const createAuthorization = ({ ensureBroker, requestBrowserJobAuthorization, }) => ({
    authorize: async (triggerUrl) => {
        const route = await ensureBroker();
        if (!route.ok)
            throw bridgeCauseError(route);
        return requestBrowserJobAuthorization(extractBrowserJobToken(triggerUrl));
    },
});
