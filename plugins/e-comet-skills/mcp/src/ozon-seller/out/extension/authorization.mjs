import { bridgeCauseError } from '../../../bridge/cause.mjs';
import { extractBrowserJobToken } from '../../../handoff/call-result.mjs';
/**
 * A signed Ozon job's authorization in its two steps, since the tools check the extension's capabilities between them:
 * the bridge must have a broker, and without one this answers the cause; then the extension authorizes the token the
 * trigger URL carries.
 */
export const createAuthorization = ({ ensureBroker, requestBrowserJobAuthorization, }) => ({
    connect: async () => {
        const route = await ensureBroker();
        return route.ok ? undefined : bridgeCauseError(route);
    },
    authorize: async (triggerUrl) => requestBrowserJobAuthorization(extractBrowserJobToken(triggerUrl)),
});
