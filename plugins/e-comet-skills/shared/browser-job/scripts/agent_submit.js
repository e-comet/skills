// Передача задания расширению e-Comet через postMessage-RPC (работает без CDP,
// из изолированного JS-мира агента). Выполнять на любой открытой вкладке
// wildberries.ru — достаточно https://www.wildberries.ru/.
// Замените __TRIGGER_URL__ на строку trigger_url из ответа browser_job —
// ровно как вернул tool (opaque-строка, без правок).
// Успех: { jobIds: [...] } — задание принято. Ошибка: { error: '<текст>' } —
// это ошибка настройки (не выполнен вход в расширение / в WB и т.п.),
// покажите текст пользователю как есть.
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
        return await ecometRpc('submit', { token: __TRIGGER_URL__ });
    } catch (e) {
        return { error: String((e && e.message) || e) };
    }
})();
