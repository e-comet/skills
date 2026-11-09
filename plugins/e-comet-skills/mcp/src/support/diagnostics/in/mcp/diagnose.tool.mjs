import { invalidArgumentsMessage, validateArguments } from '../../../../mcp-protocol/registry/validate.mjs';
import { textResult, toolFailure } from '../../../../mcp-protocol/results/serialize.mjs';
import { ToolExecutionError } from '../../../../shared/coded-error.mjs';
import { isRecord } from '../../../../shared/values.mjs';
import { collectDiagnosis } from '../../application/diagnose.mjs';
import { contract } from '../../contract/diagnose.contract.mjs';
// e_comet_diagnose. `diagnosis(extensionInstall)` supplies what the diagnosis reads: the session, the bridge and the
// probes the root wired, with the profile probe answered by the refreshed facts when the refresh returned them.
export const createDiagnoseTool = ({ answer, refreshBridgeFacts, diagnosis, }) => ({
    needsBridge: false,
    // Parse boundary: the client's arguments, validated against the contract first.
    run: async (id, args) => {
        const validation = validateArguments(contract.inputSchema, args);
        const input = isRecord(args) ? args : {};
        const invalid = !validation.ok
            ? validation
            : input.scope === 'last_operation' && (typeof input.operationHandle !== 'string' || !input.operationHandle)
                ? { property: 'operationHandle' }
                : undefined;
        if (invalid) {
            answer(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage('e_comet_diagnose', invalid), 'arguments', false)), true));
            return;
        }
        // A diagnosis must never fail because a refresh did.
        // Profile reads obey the same explicit probe contract as the collector; passive diagnoses keep stored facts.
        // A runtime extension_log probe reads the profiles too: status judges the fresh log against the profile
        // probe, which macOS never reads at start or in the background and elsewhere can be 30 s old.
        // The contract admits only these four properties, each of its own type.
        const scope = typeof input.scope === 'string' ? input.scope : undefined;
        const mode = typeof input.mode === 'string' ? input.mode : undefined;
        const probes = Array.isArray(input.probes) ? input.probes.filter((probe) => typeof probe === 'string') : undefined;
        const withProbe = mode === 'safe_probes' &&
            ((scope === 'installation' && probes?.includes('extension_install') === true) ||
                (scope === 'runtime' && probes?.includes('extension_log') === true));
        const extensionInstall = await Promise.resolve()
            .then(() => refreshBridgeFacts({ withProbe }))
            .catch(() => undefined);
        answer(id, textResult(await collectDiagnosis({ scope, mode, operationHandle: input.operationHandle, probes, ...diagnosis(extensionInstall) })));
    },
});
