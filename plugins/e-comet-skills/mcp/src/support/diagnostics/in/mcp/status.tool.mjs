import { textResult } from '../../../../mcp-protocol/results/serialize.mjs';
// local_bridge_status answers the current bridge status. Its read-only contract forbids a connect attempt, so it never
// needs the bridge.
export const createStatusTool = ({ answer, bridgeStatus, }) => ({
    needsBridge: false,
    run: async (id) => answer(id, textResult({ ok: true, ...bridgeStatus() })),
});
