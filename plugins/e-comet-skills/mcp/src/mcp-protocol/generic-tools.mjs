import { argumentRefusalSchema } from '../transport/mcp/results.mjs';
import { array, boolean, described, object, objectUnion, string } from '../transport/mcp/schema.mjs';
// The contract data of the two generic tools (spec §6.3), without handlers. describe_e_comet_tool serves the complete
// contract of each signed and feedback tool, whose names the catalog passes in.
export const describeToolContractTool = ({ signed, feedback, }) => {
    const names = [...feedback, ...signed];
    const describedToolName = described({ type: 'string', enum: [...names] }, 'Exact local e-Comet tool whose current supported tool contract is requested.');
    return {
        name: 'describe_e_comet_tool',
        description: `Return the complete current workflow contract. For signed tools (${signed.join(', ')}), call once if not already available in the current task, before browser_job, without feedback consent. ` +
            'Do not insert discovery between successful browser_job and the dependent local call. ' +
            `For ${feedback.join(' or ')}, call this once only after the user has agreed to report an e-Comet problem and before the first feedback tool; ` +
            'do not insert it between successful prepare, report_issue, and submit stages.',
        inputSchema: described(object({ name: describedToolName }, ['name']), 'Selects one current supported tool contract without executing a business operation.'),
        outputSchema: objectUnion(object({
            schemaVersion: { const: 1 },
            type: { const: 'e_comet_tool_contract' },
            requestedTool: { type: 'string', enum: [...names] },
            appliesTo: array({
                type: 'string',
                enum: ['browser_job', ...names, 'report_issue'],
            }, { minItems: 2, maxItems: 3, uniqueItems: true }),
            contract: { type: 'string', minLength: 1 },
        }, ['schemaVersion', 'type', 'requestedTool', 'appliesTo', 'contract']), argumentRefusalSchema),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
};
// describe_e_comet_tool's answer: the requested tool's complete workflow contract, or null for any other name.
export const describeToolContract = (contracts, name) => {
    const workflow = contracts.find((contract) => contract.name === name)?.workflow;
    return workflow
        ? {
            schemaVersion: 1,
            type: 'e_comet_tool_contract',
            requestedTool: name,
            appliesTo: [...workflow.appliesTo],
            contract: workflow.text,
        }
        : null;
};
export const runResultTool = {
    name: 'e_comet_run_result',
    description: 'Get the final answer of a long e-Comet tool call that answered status "running" with a runId. ' +
        'It never starts, repeats or authorizes marketplace work and needs no browser_job. ' +
        'RUN_RESULT_UNAVAILABLE: the result is gone (expired or e-Comet restarted) and the outcome is unknown; tell the user, and run the original tool again only if the user asks. ' +
        'It waits up to 30 s and returns that tool\'s own final answer unchanged, or "running" again with fresh progress: then tell the user the progress in one line and call it again.',
    inputSchema: object({ runId: described({ type: 'string', minLength: 1, maxLength: 64 }, 'The runId from a "running" answer of a long e-Comet tool.') }, ['runId']),
    // Returns any of the ten finished answers unchanged, so only their shared envelope is typed: a union of their schemas
    // would add about 395 KB to tools/list, and the original tools' schemas keep the finished answers typed.
    outputSchema: object({
        ok: boolean,
        status: string,
        runId: string,
        tool: string,
        code: string,
        message: string,
        stage: string,
        retryable: boolean,
    }, ['ok'], true),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
