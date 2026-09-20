const classifyFailure = (error) => {
    if (error?.code === 'ENOENT') return 'missing';
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return 'permission_denied';
    if (error?.code === 'PEER_TOKEN_ATOMIC_PUBLISH_UNSUPPORTED') return 'unsupported';
    if (error?.code === 'PEER_TOKEN_CORRUPT') return 'corrupt';
    return 'io_error';
};

const normalizeResult = (value) =>
    typeof value === 'string' ? { ok: true, token: value } : value?.ok === true ? { ok: true, token: value.token } : value;

export const createPeerTokenSource = ({ load, loadOrCreate, readDeadlineMs = 1000, createDeadlineMs = 5000, now = Date.now }) => {
    let cachedToken = null;
    let latestObservation = null;
    let readGeneration = null;
    let createGeneration = null;
    let generation = 0;

    const bounded = (operation, deadlineMs, current) => {
        const identity = ++generation;
        let timer;
        const promise = Promise.race([
            Promise.resolve()
                .then(operation)
                .then(normalizeResult)
                .catch((error) => ({ ok: false, reason: classifyFailure(error) })),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ ok: false, reason: 'io_error', expired: true }), deadlineMs);
            }),
        ]).finally(() => clearTimeout(timer));
        return { identity, promise, current };
    };

    const sharedRead = async () => {
        if (!readGeneration) {
            const entry = bounded(load, readDeadlineMs, () => readGeneration);
            readGeneration = entry;
            entry.promise.finally(() => {
                if (readGeneration === entry) readGeneration = null;
            });
        }
        return readGeneration.promise;
    };

    const sharedCreate = async () => {
        if (!createGeneration) {
            const entry = bounded(loadOrCreate, createDeadlineMs, () => createGeneration);
            createGeneration = entry;
            entry.promise.finally(() => {
                if (createGeneration === entry) createGeneration = null;
            });
        }
        return createGeneration.promise;
    };

    return {
        observation: () => latestObservation,
        async resolve({ allowCreate }) {
            // Наблюдение остаётся от настоящего чтения файла. Переставлять его на попадании в кэш
            // значило бы показывать свежее «passed» для пары, которую с тех пор могли удалить или
            // закрыть, — при том что диск здесь не трогали.
            if (cachedToken) return { ok: true, token: cachedToken };
            const readResult = await sharedRead();
            if (readResult?.ok) {
                cachedToken ??= readResult.token;
                latestObservation = Object.freeze({ state: 'passed', observedAt: new Date(now()).toISOString() });
                return { ok: true, token: cachedToken };
            }
            if (readResult?.reason !== 'missing' || !allowCreate) {
                latestObservation = Object.freeze({ state: 'failed', reason: readResult?.reason ?? 'io_error', observedAt: new Date(now()).toISOString() });
                return { ok: false, reason: readResult?.reason ?? 'io_error' };
            }
            const created = await sharedCreate();
            if (created?.ok) {
                cachedToken ??= created.token;
                latestObservation = Object.freeze({ state: 'passed', observedAt: new Date(now()).toISOString() });
                return { ok: true, token: cachedToken };
            }
            latestObservation = Object.freeze({ state: 'failed', reason: created?.reason ?? 'io_error', observedAt: new Date(now()).toISOString() });
            return { ok: false, reason: created?.reason ?? 'io_error' };
        },
    };
};
