// Опрос прогресса agent-джобы e-Comet через postMessage-RPC (работает без CDP,
// из изолированного JS-мира агента). Выполнять на той же вкладке wildberries.ru.
// Замените __JOB_ID__ на строку с jobId из ответа submit/browser_job, либо на
// null для агрегата по всем заданиям вкладки.
// Снипет НЕ ждёт сам: выполняйте его повторно раз в 2-3 секунды, пока
// progress.status не станет 'done'. Большие батчи выполняются волнами с дросселем
// и могут занимать десятки минут — читайте готовые единицы по мере появления.
// Если вернулся setupError — прекратите опрос и покажите message пользователю как есть.
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
        const globalProgress = await ecometRpc('progress', {});
        if (globalProgress && globalProgress.setupError) {
            return { setupError: globalProgress.setupError };
        }
        const jobId = __JOB_ID__;
        const progress = jobId ? await ecometRpc('progress', { parentJobId: jobId }) : globalProgress;
        return { progress };
    } catch (e) {
        return { error: String((e && e.message) || e) };
    }
})();
