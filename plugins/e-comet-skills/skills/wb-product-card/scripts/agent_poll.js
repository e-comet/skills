// Опрос прогресса agent-джобы e-Comet на странице wildberries.ru.
// Перед выполнением замените __JOB_ID__ на строку с jobId из ответа browser_job
// (например '3f2c...'), либо на null для агрегата по всем джобам вкладки.
// Снипет НЕ ждёт сам: выполняйте его повторно раз в 2-3 секунды, пока
// progress.status не станет 'done' (разумный предел ~60 попыток).
// Если вернулся setupError — прекратите опрос и покажите message пользователю как есть.
(async () => {
    if (typeof window.__ecometAgent === 'undefined') {
        return { error: 'ecomet-agent-rpc-not-available' };
    }
    const globalProgress = await window.__ecometAgent.progress();
    if (globalProgress && globalProgress.setupError) {
        return { setupError: globalProgress.setupError };
    }
    const jobId = __JOB_ID__;
    const progress = jobId ? await window.__ecometAgent.progress(jobId) : globalProgress;
    return { progress };
})();
