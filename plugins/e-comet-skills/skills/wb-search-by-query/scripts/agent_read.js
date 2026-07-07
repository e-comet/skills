// Чтение результатов agent-джобы e-Comet: сводки list() + полные тела read().
// Замените __JOB_ID__ на строку с родительским jobId из ответа browser_job.
// Замените __UNIT_IDS__ на массив производных id для чтения полных тел
// (например ['<jobId>__nm791050753__detail']) либо на null, чтобы прочитать все
// завершённые юниты сразу. Полные тела бывают большими: при батчах из многих
// юнитов читайте их порциями по 1-2 за вызов.
(async () => {
    if (typeof window.__ecometAgent === 'undefined') {
        return { error: 'ecomet-agent-rpc-not-available' };
    }
    const jobId = __JOB_ID__;
    const unitIds = __UNIT_IDS__;
    const summaries = await window.__ecometAgent.list(jobId);
    const targets = unitIds || summaries.filter((s) => s.status === 'done').map((s) => s.jobId);
    const results = {};
    for (const unitId of targets) {
        results[unitId] = await window.__ecometAgent.read(unitId);
    }
    return { summaries, results };
})();
