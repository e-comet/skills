// Готовая сводка результатов agent-джобы e-Comet через postMessage-RPC (работает
// с CDP-evaluate, см. shared/browser-job/README.md про выбор транспорта).
// Выполнять на той же вкладке wildberries.ru.
// Замените __JOB_ID__ на строку с родительским jobId из ответа submit/browser_job.
// Возвращает { summary }: для product_card — массив ProductSummary (цена, остатки
// по складам/размерам с именами складов, рейтинг, склейка, характеристики), для
// search_by_query — массив SearchSummary на каждую пару (фраза, страница) с
// позициями товаров. Это предпочтительный способ чтения: сырые тела (agent_read.js)
// нужны только для полей, которых нет в сводке.
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
        return { summary: await ecometRpc('summary', { parentJobId: __JOB_ID__ }) };
    } catch (e) {
        return { error: String((e && e.message) || e) };
    }
})();
