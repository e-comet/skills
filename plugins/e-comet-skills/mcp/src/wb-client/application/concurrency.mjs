export const createConcurrencyLimiter = (concurrency, worker) => {
    let active = 0;
    const queued = [];
    const acquire = () => {
        if (active < concurrency) {
            active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => queued.push(resolve));
    };
    const release = () => {
        const next = queued.shift();
        if (next)
            next();
        else
            active -= 1;
    };
    return async (...args) => {
        await acquire();
        try {
            return await worker(...args);
        }
        finally {
            release();
        }
    };
};
export const runWithConcurrency = async (items, concurrency, worker) => {
    const results = new Array(items.length);
    // One iterator for every runner: each takes the next item when it is free.
    const entries = items.entries();
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (const [index, item] of entries) {
            results[index] = await worker(item, index);
        }
    });
    await Promise.all(runners);
    return results;
};
