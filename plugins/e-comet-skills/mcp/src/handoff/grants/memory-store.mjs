import { GRANT_POLICIES, isEntryFresh } from './policy.mjs';
import { HandoffError } from '../hook-io.mjs';
// DeepSeek's tool runtime keeps its browser_job grants in the adapter's memory (spec §7.2): the browser-job policy of
// the file store, without a disk round-trip. A restarted adapter has none and refuses as a missing grant.
export const createMemoryGrantStore = () => {
    const grants = new Map();
    const key = (sessionId, targetTool) => JSON.stringify([sessionId, targetTool]);
    const store = {
        open: () => store,
        stage: ({ sessionId, targetTool, triggerUrl, nowMs }) => {
            const pending = (grants.get(key(sessionId, targetTool)) ?? []).filter((grant) => nowMs - grant.createdAtMs <= GRANT_POLICIES.BROWSER_JOB.lifetimeMs);
            pending.push({ createdAtMs: nowMs, triggerUrl });
            grants.set(key(sessionId, targetTool), pending);
        },
        claim: async ({ sessionId, targetTool, nowMs }) => {
            const pending = grants.get(key(sessionId, targetTool)) ?? [];
            grants.delete(key(sessionId, targetTool)); // A competing local call cannot claim these grants.
            // browser_job registers its grant only after it returns, so a local call issued beside it finds none yet.
            if (!pending.length)
                throw new HandoffError('HANDOFF_MISSING', 'If browser_job ran in the same parallel step as this call, retry this local tool alone once, without a new browser_job; otherwise call browser_job once for this session and matching local tool.');
            const fresh = pending.filter((grant) => isEntryFresh(grant, nowMs));
            const [grant] = fresh;
            if (!grant)
                throw new HandoffError('HANDOFF_EXPIRED', 'Call browser_job once for a fresh matching authorization.');
            // Authorizations are sequential, so two waiting ones cannot both be the intended job: both are invalidated.
            if (fresh.length > 1) {
                throw new HandoffError('HANDOFF_MISSING', 'Several browser authorizations were waiting for this conversation; all of them were invalidated.', 'No usable matching authorization remains. Call browser_job once for the intended local tool, then retry without model-authored authorization fields.');
            }
            return grant.triggerUrl;
        },
    };
    return store;
};
