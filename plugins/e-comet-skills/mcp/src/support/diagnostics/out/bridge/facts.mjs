import { collectExtensionLog, extensionLogCheck } from '../../../../bridge/profile/extension-log.mjs';
import { isRecord } from '../../../../shared/values.mjs';
/**
 * The runtime extension_log probe: the extension's own log from the browser profile, read fresh, and its closed check.
 * A reader that throws is unreadable. `keep` receives every fresh read, so the bridge status judges its cause again.
 */
export const createExtensionLogReader = (collect = collectExtensionLog, keep = () => undefined) => async ({ now, observedAt }) => {
    const evidence = await collect({ now }).catch((error) => ({
        state: 'unreadable',
        ...(isRecord(error) && typeof error.code === 'string' ? { systemCode: error.code } : {}),
        startFailureAtMs: [],
    }));
    keep(evidence);
    return extensionLogCheck(evidence, { observedAt, nowMs: Date.parse(observedAt) });
};
