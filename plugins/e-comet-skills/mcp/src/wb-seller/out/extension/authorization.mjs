import { bridgeCauseError } from '../../../bridge/cause.mjs';
import { extractBrowserJobToken } from '../../../handoff/call-result.mjs';
import { ToolExecutionError } from '../../../shared/coded-error.mjs';
/**
 * A signed job's lease: the bridge must have a broker, whose absence is its cause, and the extension authorizes the token
 * the trigger URL carries.
 */
export const createAuthorization = ({ ensureBroker, requestBrowserJobAuthorization, capability, }) => ({
    authorize: async (triggerUrl) => {
        const route = await ensureBroker();
        if (!route.ok)
            throw bridgeCauseError(route);
        if (capability !== undefined) {
            const supported = capability.supported();
            if (supported === undefined)
                throw new ToolExecutionError('EXTENSION_DISCONNECTED', 'The e-Comet extension disconnected before authorizing the job.', 'extension');
            if (!supported)
                throw new ToolExecutionError('EXTENSION_UPDATE_REQUIRED', `Update the connected e-Comet Chrome extension to use ${capability.operation}.`, 'extension');
        }
        return requestBrowserJobAuthorization(extractBrowserJobToken(triggerUrl));
    },
});
