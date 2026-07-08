// Чтение результатов agent-джобы e-Comet через postMessage-RPC (работает без CDP,
// из изолированного JS-мира агента). Выполнять на той же вкладке wildberries.ru.
// Замените __JOB_ID__ на строку с родительским jobId из ответа submit/browser_job.
// Замените __UNIT_IDS__ на массив производных id для чтения конкретных единиц
// (например ['<jobId>__nm791050753__detail']) либо на null — тогда все тела
// задания читаются одним вызовом readAll (results будет массивом; удобно для
// 1-2 артикулов). Полные тела бывают большими: при батчах из многих единиц
// передавайте __UNIT_IDS__ порциями по 1-2 за вызов.
(async () => {
    function ecometRpc(method, params, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const id = 'rpc-' + Math.random().toString(36).slice(2) + Date.now();
            const timer = setTimeout(() => {
                window.removeEventListener('message', onMessage);
                reject(new Error('e-Comet extension did not respond'));
            }, timeoutMs);
            const onMessage = (event) => {
                const d = event.data;
                if (!d || d.source !== 'ecomet-agent-rpc-result' || d.id !== id) return;
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                d.ok ? resolve(d.result) : reject(new Error(d.error));
            };
            window.addEventListener('message', onMessage);
            window.postMessage({ source: 'ecomet-agent-rpc', id, method, params }, window.location.origin);
        });
    }
    try {
        const jobId = __JOB_ID__;
        const unitIds = __UNIT_IDS__;
        const summaries = await ecometRpc('list', { parentJobId: jobId });
        if (unitIds == null) {
            const results = await ecometRpc('readAll', { parentJobId: jobId });
            return { summaries, results };
        }
        const results = {};
        for (const unitId of unitIds) {
            results[unitId] = await ecometRpc('read', { jobId: unitId });
        }
        return { summaries, results };
    } catch (e) {
        return { error: String((e && e.message) || e) };
    }
})();
