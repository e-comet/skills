import { AsyncLocalStorage } from 'node:async_hooks';

import { RUN_RESULT_RETENTION_MS, RUN_WAIT_MS } from './config.mjs';

const currentRun = new AsyncLocalStorage();

// Best-effort progress for the run this call belongs to: counts settled units. The meter is captured here, so a callback
// that a socket event invokes later still counts.
export const countRunProgress = (total, unit) => {
    const meter = currentRun.getStore();
    if (!meter) return unit;
    const progress = { completed: 0, total };
    meter.progress = progress;
    return async (...args) => {
        try { return await unit(...args); } finally { progress.completed += 1; }
    };
};

// Each run's handler answers to an opaque object key instead of the request id, so a client reusing that id after a
// "running" answer never has its new request captured.
// Accepted residual "Long bridge jobs hand over to e_comet_run_result after 30 s": docs/local-agent-architecture.md#accepted-residuals.
export const createRunRegistry = ({ now = Date.now, randomUUID, waitMs = RUN_WAIT_MS, retentionMs = RUN_RESULT_RETENTION_MS }) => {
    const runs = new Map();
    const runsByKey = new WeakMap();

    const start = (tool, execute) => {
        const key = {};
        let resolveFinished;
        const run = {
            runId: randomUUID(), tool, startedAt: now(), meter: {}, finished: new Promise((resolve) => { resolveFinished = resolve; }),
        };
        // Accepted residual "A run that never settles answers running until restart": docs/local-agent-architecture.md#accepted-residuals.
        run.finish = (outcome) => {
            if (run.outcome) return;
            run.outcome = outcome;
            resolveFinished(outcome);
            run.expiry = setTimeout(() => runs.delete(run.runId), retentionMs);
            run.expiry.unref();
        };
        runs.set(run.runId, run);
        runsByKey.set(key, run);
        // Only the meter enters the async context: a socket or timer the handler creates keeps that context alive, and
        // it must not hold the answer.
        currentRun.run(run.meter, async () => execute(key)).then(
            () => run.finish({ error: new Error(`${tool} settled without an answer`) }),
            (error) => run.finish({ error })
        );
        return run;
    };

    // Any later answer for a key is swallowed: it must never go out under an object id.
    const settle = (key, result) => {
        const run = typeof key === 'object' && key !== null ? runsByKey.get(key) : undefined;
        if (!run) return false;
        run.finish({ result });
        return true;
    };

    // The wait timer stays referenced: a caller is waiting for this answer. Only the retention timer is unref'd.
    const wait = (run) => run.outcome ? Promise.resolve(run.outcome) : new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        void run.finished.then((outcome) => {
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
            ...(progress?.total > 0 ? { progress: { completed: Math.min(progress.completed, progress.total), total: progress.total } } : {}),
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
