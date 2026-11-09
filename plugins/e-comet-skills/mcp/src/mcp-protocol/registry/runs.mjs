import { runResultTool } from '../generic-tools.mjs';
import { invalidArgumentsMessage, validateArguments } from './validate.mjs';
import { textResult, toolFailure } from '../results/serialize.mjs';
import { ToolExecutionError } from '../../shared/coded-error.mjs';
import { currentRun } from '../../shared/run-progress.mjs';
import { isRecord } from '../../shared/values.mjs';
// A long tool answers within this wait, and so does each result call: Cowork's cloud drops a device call after 60 s,
// and that budget also carries the answer over the bridge. Accepted residual "Long bridge jobs hand over to
// e_comet_run_result after 30 s": docs/architecture/residuals/signed-flow.md.
export const RUN_WAIT_MS = 30_000;
export const RUN_RESULT_RETENTION_MS = 30 * 60 * 1000;
// No automatic repeat: the original call may have created marketplace reports (product principle 4).
const RUN_RESULT_UNAVAILABLE_MESSAGE = "This run's result is no longer on this device: the run expired or e-Comet restarted. " +
    "The original operation's outcome is unknown, which is not the same as failed. " +
    'Do not repeat it automatically: tell the user, and run the original tool again only if the user asks.';
// Each run's handler answers to an opaque object key instead of the request id, so a client reusing that id after a
// "running" answer never has its new request captured.
// Accepted residual "Long bridge jobs hand over to e_comet_run_result after 30 s": docs/architecture/residuals/signed-flow.md.
export const createRunRegistry = ({ now = Date.now, randomUUID, waitMs = RUN_WAIT_MS, retentionMs = RUN_RESULT_RETENTION_MS, }) => {
    const runs = new Map();
    const runsByKey = new WeakMap();
    const start = (tool, execute) => {
        const key = {};
        let resolveFinished;
        const run = {
            runId: randomUUID(),
            tool,
            startedAt: now(),
            meter: {},
            finished: new Promise((resolve) => {
                resolveFinished = resolve;
            }),
            // Accepted residual "A run that never settles answers running until restart": docs/architecture/residuals/signed-flow.md.
            finish: (outcome) => {
                if (run.outcome)
                    return;
                run.outcome = outcome;
                resolveFinished(outcome);
                run.expiry = setTimeout(() => runs.delete(run.runId), retentionMs);
                run.expiry.unref();
            },
        };
        runs.set(run.runId, run);
        runsByKey.set(key, run);
        // Only the meter enters the async context: a socket or timer the handler creates keeps that context alive, and
        // it must not hold the answer.
        currentRun
            .run(run.meter, async () => execute(key))
            .then(() => run.finish({ error: new Error(`${tool} settled without an answer`) }), (error) => run.finish({ error }));
        return run;
    };
    // Any later answer for a key is swallowed: it must never go out under an object id.
    const settle = (key, result) => {
        const run = typeof key === 'object' && key !== null ? runsByKey.get(key) : undefined;
        if (!run)
            return false;
        run.finish({ result });
        return true;
    };
    // The wait timer stays referenced: a caller is waiting for this answer. Only the retention timer is unref'd.
    // Resolves undefined when the wait ends first.
    const wait = (run) => run.outcome
        ? Promise.resolve(run.outcome)
        : new Promise((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            run.finished.then((outcome) => {
                clearTimeout(timer);
                resolve(outcome);
            });
        });
    const runningAnswer = (run) => {
        const progress = run.meter.progress;
        return {
            ok: true,
            status: 'running',
            runId: run.runId,
            tool: run.tool,
            elapsedSeconds: Math.max(0, Math.floor((now() - run.startedAt) / 1000)),
            // An absent meter compares as undefined > 0, which is false.
            ...(progress !== undefined && progress.total > 0
                ? { progress: { completed: Math.min(progress.completed, progress.total), total: progress.total } }
                : {}),
            nextStep: `Not finished yet. Tell the user the progress in one line, then call e_comet_run_result with {"runId": "${run.runId}"}.`,
        };
    };
    // The expiry timer holds the run and its answer, so forgetting a run clears it as well.
    const forget = (run) => {
        clearTimeout(run.expiry);
        runs.delete(run.runId);
    };
    return { start, settle, get: (runId) => runs.get(runId), forget, wait, runningAnswer };
};
// The captured answer goes out unchanged. A handler failure is rethrown, so the transport answers -32603 as it
// would without the wait.
// Resolves true when the final answer went out, false for a "running" answer.
const answerRun = async (runs, send, id, run) => {
    const outcome = await runs.wait(run);
    if (outcome?.error)
        throw outcome.error;
    send(id, outcome ? outcome.result : textResult(runs.runningAnswer(run)));
    return Boolean(outcome);
};
// Any bridge job may outlast a host's call deadline: past the wait it answers "running" and keeps working.
export const callWithHandoff = async (runs, send, id, tool, execute) => {
    const run = runs.start(tool, execute);
    let delivered = true;
    // A run answered in full here never showed its runId, so nobody can fetch it later.
    try {
        delivered = await answerRun(runs, send, id, run);
    }
    finally {
        if (delivered)
            runs.forget(run);
    }
};
// e_comet_run_result: the run's final answer, or "running" again after the wait.
// Parse boundary: the arguments are what the client sent; the schema check narrows them.
export const answerRunResult = async (runs, send, id, args) => {
    const validation = validateArguments(runResultTool.inputSchema, args);
    if (!validation.ok) {
        send(id, textResult(toolFailure(new ToolExecutionError('INVALID_TOOL_ARGUMENTS', invalidArgumentsMessage('e_comet_run_result', validation), 'arguments', false)), true));
        return;
    }
    const runId = isRecord(args) ? args.runId : undefined;
    const run = typeof runId === 'string' ? runs.get(runId) : undefined;
    if (!run) {
        send(id, textResult(toolFailure(new ToolExecutionError('RUN_RESULT_UNAVAILABLE', RUN_RESULT_UNAVAILABLE_MESSAGE, 'result', false)), true));
        return;
    }
    await answerRun(runs, send, id, run);
};
