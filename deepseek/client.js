window.__ModuleLoader__.load({
  id: 'dsh-e-comet-skills',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'eComet.account';
    const russian = {
      available: 'Подключено', local: 'Живые данные WB и отчёты Ozon', remote: 'Аналитика и настройки рекламы',
      unavailable: 'Недоступно', disconnected: 'Не подключено', title: 'Аккаунт e-Comet',
      checking: 'Подключение',
      connect: 'Связать с аккаунтом e-Comet', open: 'Открыть страницу входа ещё раз', cancel: 'Отменить вход',
      disconnect: 'Отвязать аккаунт',
      loginFailed: 'Не удалось начать вход. Попробуйте ещё раз.', statusFailed: 'Не удалось проверить подключение. Повторите проверку.',
      connectionFailed: 'Не удалось подключить e-Comet. Попробуйте ещё раз.',
      connectionTimeout: 'Время ожидания входа истекло. Попробуйте ещё раз.',
      authorizationDeclined: 'Вход не завершён. Попробуйте ещё раз.',
      loginExpired: 'Срок действия входа истёк. Свяжите аккаунт e-Comet ещё раз.',
      cancelFailed: 'Не удалось отменить вход. Попробуйте ещё раз.', disconnectFailed: 'Не удалось отвязать аккаунт. Попробуйте ещё раз.',
      promptLead: 'Спросите агента:', prompt: 'Что умеет e-Comet?', promptCopy: 'Скопировать запрос «Что умеет e-Comet?»', promptCopied: 'Запрос скопирован',
      afterLogin: 'после входа', afterRestart: 'после перезапуска',
      badgeReady: 'Готово к работе', badgeAction: 'Нужно действие', badgeWaiting: 'Ожидание входа', badgeError: 'Нужно внимание', badgeOff: 'Не подключено', badgeChecking: 'Подключение',
      badgeReconnecting: 'Переподключение', reconnecting: 'Переподключение',
      reconnectNow: 'Переподключить сейчас',
      extension_offline: 'Расширение не на связи', localOfflineBefore: 'Откройте любую страницу ', localOfflineAfter: ' в браузере с расширением e-Comet — оно подключится само.',
      localDoctorHint: 'Не помогло? Напишите агенту «Диагностируй e-Comet»',
      bridge_unavailable: 'Мост e-Comet недоступен', localBridgeHint: 'Попросите агента проверить подключение e-Comet — напишите ему «Диагностируй e-Comet»',
      localUnavailableBefore: 'Локальный модуль e-Comet не запущен; плагин перезапускает его сам. Если через несколько минут статус не изменился, перезапустите DeepSeek, а если не помогло — напишите в поддержку через виджет на ', localUnavailableAfter: '.',
      updateChecking: 'Проверка обновлений', updateCurrent: 'Доступных обновлений нет',
      updateAvailable: 'Доступно обновление e-Comet:', updateInstalling: 'Обновление e-Comet',
      updateRestart: 'Обновление установлено. Перезапустите DeepSeek, чтобы использовать версию',
      updateFailed: 'Не удалось обновить e-Comet. Попробуйте ещё раз.',
      updateIncompatible: 'Обновление', updateIncompatibleTail: 'несовместимо с DeepSeek', updateSupport: 'Обновите DeepSeek или напишите в поддержку',
      updateRecovery: 'Не удалось восстановить плагин после ошибки обновления. Резервная копия сохранена. Обратитесь в поддержку e-Comet.',
      updatePaused: 'Приостановлено',
      updatePausedHint: 'Соединения приостановлены на время обновления, повторный вход не нужен',
      updateCheckFailed: 'Не удалось проверить обновления. Попробуйте ещё раз.',
      updateToolActive: 'Агент сейчас использует e-Comet. Обновить можно после завершения текущих операций.', updateButton: 'Обновить',
      updateLoginActive: 'Обновить можно после входа в аккаунт.',
      updateAccountActive: 'Обновить можно после завершения операции с аккаунтом.',
      updateInstalled: 'Установлена версия',
      updateRestartNote: 'Соединения приостановлены до перезапуска, входить заново не нужно', changelog: 'Что нового',
      checkUpdates: 'Проверить обновления',
    };
    // This seller-facing page stays Russian independently of the host application's locale.
    const dictionaries = { ru: russian, en: russian, zh: russian };

    // The login page opens straight from the user's click, like the Host's own external links; the card keeps a
    // reopen link only as a fallback for a blocked or closed tab.
    const openExternal = (url) => { try { if (typeof window.open === 'function') window.open(url, '_blank', 'noopener,noreferrer'); } catch {} };
    function createAccountController(api, { open = openExternal } = {}) {
      let snapshot = { state: 'checking', busy: false, authorizationUrl: null, notice: null };
      let disposed = false;
      let revision = 0;
      let updateRevision = 0;
      let timer;
      let read;
      const listeners = new Set();
      const schedule = () => {
        clearTimeout(timer);
        // Poll only while an account view observes the status; explicit reads remain one-shot.
        if (!disposed && listeners.size && !snapshot.busy && !read) timer = setTimeout(() => { void refresh(); },
          ['checking', 'connecting'].includes(snapshot.state) || ['checking', 'updating'].includes(snapshot.updates?.state) || snapshot.updates?.toolActive ? 1000 : 5000);
      };
      const set = (patch) => {
        if (disposed) return;
        snapshot = { ...snapshot, ...patch };
        for (const listener of listeners) listener();
        schedule();
      };
      const unwrap = (result) => {
        if (!result?.ok) throw new Error('native remote failed');
        return result.value;
      };
      const safeLoginUrl = (value) => {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe login link');
        return url.href;
      };
      const updateStatus = (status) => status ? {
        state: status.state, currentVersion: status.currentVersion, availableVersion: status.availableVersion,
        toolActive: status.toolActive === true, errorCode: status.errorCode,
      } : null;
      async function refresh() {
        if (disposed || snapshot.busy || read) return read;
        const current = revision;
        const currentUpdate = updateRevision;
        read = (async () => {
          try {
            const status = unwrap(await api.getStatus());
            if (current !== revision || disposed) return;
            set({ state: status.state, notice: null, errorCode: typeof status.errorCode === 'string' ? status.errorCode : null, connections: status.connections ?? null, authorizationUrl: status.state === 'connecting' ? (status.authorizationUrl ? safeLoginUrl(status.authorizationUrl) : snapshot.authorizationUrl) : null,
              ...(currentUpdate === updateRevision && !snapshot.updateBusy ? { updates: updateStatus(status.updates) } : {}) });
          } catch {
            // The page may mount before the Host account service. Keep waiting instead of showing a false error
            // (owner decision: docs/local-agent-architecture.md#accepted-residuals).
            if (current === revision) set({ notice: snapshot.state === 'checking' ? null : 'statusFailed' });
          } finally {
            read = null;
            schedule();
          }
        })();
        return read;
      }
      async function action(method, notice) {
        if (disposed || (snapshot.busy && method !== 'cancelLogin')) return;
        const current = ++revision;
        set({ busy: true, operation: method, notice: null, errorCode: null, ...(method === 'startLogin' ? { state: 'connecting', authorizationUrl: null } : {}) });
        try {
          const result = unwrap(await api[method]());
          if (current !== revision || disposed) return;
          if (method === 'startLogin') {
            if (result.authorizationUrl) {
              const authorizationUrl = safeLoginUrl(result.authorizationUrl);
              set({ state: 'connecting', authorizationUrl });
              open(authorizationUrl);
            } else if (['connected', 'error', 'logged_out'].includes(result.state)) {
              // Saved-account recovery and pre-browser failures can finish without a login URL.
              set({ state: result.state, errorCode: typeof result.errorCode === 'string' ? result.errorCode : null, authorizationUrl: null });
            } else throw new Error('missing login link');
          } else set({ state: result.state, authorizationUrl: null });
        } catch {
          if (current === revision) set({ notice, ...(method === 'startLogin' ? { state: 'logged_out' } : {}) });
        } finally {
          if (current === revision) set({ busy: false, operation: null });
        }
      }
      async function updateAction(method) {
        if (disposed || snapshot.updateBusy || snapshot.updates?.state === 'restart-required') return;
        // Account actions pause polling; the last remote toolActive value can still be false.
        if (method === 'installUpdate' && (!snapshot.updates?.availableVersion || snapshot.updates.toolActive || snapshot.busy || snapshot.state === 'connecting')) return;
        const current = ++updateRevision;
        set({ updateBusy: true, updates: method === 'installUpdate'
          ? { ...snapshot.updates, state: 'updating', errorCode: undefined }
          : { state: 'checking', currentVersion: snapshot.updates?.currentVersion } });
        try {
          let updates;
          try { updates = updateStatus(unwrap(await api[method]())); }
          catch { updates = { ...snapshot.updates, state: 'error', errorCode: method === 'installUpdate' ? 'install-failed' : 'registry-unavailable' }; }
          if (current !== updateRevision || disposed) return;
          if (method === 'installUpdate') {
            // Drain a paused-era poll, then read fresh state before removing the update mask.
            await read;
            if (current !== updateRevision || disposed) return;
            set({ state: 'checking', errorCode: null, notice: null });
            await refresh();
          }
          if (current === updateRevision && !disposed) set({ updates });
        } finally {
          if (current === updateRevision) { updateRevision++; set({ updateBusy: false }); }
        }
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          if (disposed) return () => {};
          const first = listeners.size === 0;
          listeners.add(listener);
          if (first) { clearTimeout(timer); void refresh(); }
          return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
        },
        refresh,
        startLogin: () => action('startLogin', 'loginFailed'),
        cancelLogin: () => action('cancelLogin', 'cancelFailed'),
        disconnect: () => action('disconnect', 'disconnectFailed'),
        installUpdate: () => updateAction('installUpdate'),
        checkUpdates: () => updateAction('checkUpdates'),
        dispose() { disposed = true; revision++; updateRevision++; clearTimeout(timer); listeners.clear(); },
      };
    }

    // Identical to the Host contribution; the bundle needs no browser imports or build step.
    const ACCOUNT_REMOTE = {
      package: 'dsh-e-comet-skills',
      descriptors: ['getStatus', 'startLogin', 'cancelLogin', 'disconnect', 'installUpdate', 'checkUpdates'].map((method) => ({
        id: `dsh-e-comet-skills#eCometAccount/${method}`,
        service: 'eCometAccount', namespace: 'eCometAccount', method,
        invocation: { kind: 'direct' }, parameters: [], result: { mode: 'src-json' },
      })),
    };
    return {
      inject: ['slots', 'locale', 'remote'],
      createAccountController,
      ACCOUNT_REMOTE,
      async apply(ctx) {
        let phase = 'native account API mounting';
        try {
          await ctx.remote.$mount(ACCOUNT_REMOTE);
          phase = 'locale registration';
          ctx.effect(() => ctx.locale.register(NS, dictionaries), 'e-Comet account dictionaries');
          phase = 'native account namespace lookup';
          const account = ctx.get('remote.eCometAccount');
          if (!account) throw new Error('e-Comet account namespace did not mount');
          const controller = createAccountController(account);
          ctx.effect(() => () => controller.dispose(), 'e-Comet account lifecycle');
          void controller.refresh();
          ctx.on('connection/reset', () => { void controller.refresh(); });
          // Neutrals follow the Host theme through currentColor; brand and status accents are fixed, and the warning
          // text tone is mixed with currentColor so it darkens on a light theme and lightens on a dark one.
          // The owner retained this palette; see "Native DeepSeek fixed palette" in docs/local-agent-architecture.md.
          const cardCss = `
            .ec-card{font:inherit;color:inherit;width:100%;box-sizing:border-box;padding:8px 0 12px}
            .ec-card *{box-sizing:border-box}
            .ec-panel{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;overflow:hidden}
            .ec-head{display:flex;gap:10px 16px;align-items:center;justify-content:space-between;flex-wrap:wrap;min-height:60px;padding:16px 20px}
            .ec-head-main{flex:1 1 240px;min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px}
            .ec-head-main p{margin:0;font-size:14px;line-height:20px}.ec-muted{opacity:.72}
            .ec-pill{display:inline-flex;align-items:center;gap:7px;min-height:28px;padding:4px 12px;border:1px solid transparent;border-radius:999px;font-size:13px;line-height:18px;font-weight:600;white-space:nowrap}
            .ec-badge{background:color-mix(in srgb,currentColor 8%,transparent)}
            .ec-badge[data-tone=ready]{background:rgba(16,185,129,.14)}.ec-badge[data-tone=waiting]{background:rgba(240,188,116,.3)}.ec-badge[data-tone=error]{background:rgba(225,29,72,.12)}
            .ec-dot{width:8px;height:8px;border-radius:50%;background:#9a9a9a;flex:none}
            @keyframes ec-pulse{0%,100%{opacity:1}50%{opacity:.35}}
            .ec-badge[data-busy] .ec-dot,.ec-updates[data-busy]>.ec-icon{animation:ec-pulse 1.6s ease-in-out infinite}
            @media(prefers-reduced-motion:reduce){.ec-badge[data-busy] .ec-dot,.ec-updates[data-busy]>.ec-icon{animation:none}}
            [data-tone=ready] .ec-dot{background:#10b981}[data-tone=waiting] .ec-dot{background:#d59a06}[data-tone=error] .ec-dot{background:#e11d48}
            .ec-prompt{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font-size:13px;line-height:18px;font-weight:400}
            .ec-chip{gap:8px;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font:inherit;font-size:13px;line-height:18px;font-weight:600;cursor:pointer}
            .ec-chip:hover{background:color-mix(in srgb,currentColor 12%,transparent)}.ec-chip:active{background:color-mix(in srgb,currentColor 18%,transparent)}.ec-chip:focus-visible{outline:2px solid currentColor;outline-offset:3px}
            .ec-chip .ec-icon{width:13px;height:13px;opacity:.6}.ec-chip[data-copied]{background:rgba(16,185,129,.18)}.ec-chip[data-copied] .ec-icon{opacity:1;stroke:#10b981}
            .ec-icon{flex:none;width:20px;height:20px}
            .ec-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
            .ec-tip{position:relative;display:inline-flex}
            .ec-tip:focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:8px}
            .ec-tip-bubble{position:absolute;bottom:100%;left:0;padding-bottom:8px;display:none;z-index:2}.ec-tip-bubble[data-align=end]{left:auto;right:0}
            .ec-tip:hover .ec-tip-bubble,.ec-tip:focus-within .ec-tip-bubble{display:block}
            .ec-tip-box{position:relative;width:max-content;max-width:300px;padding:8px 10px;border-radius:6px;background:#2c2c30;color:#efeff1;font-size:12px;line-height:16px;font-weight:500;text-align:left;box-shadow:0 4px 8px rgba(0,0,0,.4),0 0 4px rgba(0,0,0,.4);white-space:normal}
            .ec-tip-box::after{content:"";position:absolute;top:100%;left:14px;border:5px solid transparent;border-top-color:#2c2c30}[data-align=end]>.ec-tip-box::after{left:auto;right:14px}
            .ec-tip-box a{color:#ffce54;text-decoration:underline dashed rgba(255,206,84,.3) 1px;text-underline-offset:4px;white-space:nowrap}
            .ec-tip-term{text-decoration:underline dashed 1px;text-decoration-color:color-mix(in srgb,currentColor 50%,transparent);text-underline-offset:4px;cursor:help}
            .ec-slot{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.ec-slot[data-open]{grid-template-rows:1fr}.ec-slot>div{overflow:hidden;min-height:0}
            @media(prefers-reduced-motion:reduce){.ec-slot{transition:none}}
            .ec-ext{width:13px;height:13px;flex:none;margin-left:4px;vertical-align:-1px}
            .ec-box{display:flex;align-items:center;gap:12px;margin:0 20px 14px;padding:12px 16px;border-radius:8px;border:1px solid transparent;background:color-mix(in srgb,currentColor 5%,transparent);font-size:13px;line-height:18px}
            .ec-box p{margin:0}.ec-box[data-tone=error]{background:rgba(240,69,39,.08);border-color:rgba(240,69,39,.32);font-weight:600}
            .ec-side{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
            .ec-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:32px;padding:4px 12px;border-radius:8px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
            .ec-button:hover{background:color-mix(in srgb,currentColor 6%,transparent)}.ec-button:active:not(:disabled){background:color-mix(in srgb,currentColor 12%,transparent)}.ec-button:focus-visible{outline:2px solid currentColor;outline-offset:3px}.ec-button:disabled{opacity:.45;cursor:not-allowed}
            .ec-button-primary{background:#f0bc74;border-color:#f0bc74;color:#2c3046;font-weight:700}.ec-button-primary:hover{background:#eeb15d;border-color:#eeb15d}.ec-button-primary:active:not(:disabled){background:#e3a447;border-color:#e3a447}
            .ec-button-quiet{border-color:transparent;opacity:.72}.ec-button-quiet:hover,.ec-button-quiet:active{opacity:1}
            .ec-links{margin:0 20px}
            .ec-link{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}.ec-link:last-child{padding-bottom:16px}
            .ec-link>.ec-icon{width:16px;height:16px;margin-top:2px;opacity:.72}
            .ec-link-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px}
            .ec-link-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:2px 10px}.ec-link-title{font-size:14px;line-height:20px;font-weight:700}
            .ec-status{font-size:13px;line-height:18px;font-weight:600;white-space:nowrap}
            .ec-link[data-tone=off],.ec-link[data-tone=paused]{opacity:.7}
            .ec-link[data-tone=waiting]>.ec-icon{opacity:1;stroke:color-mix(in srgb,#d59a06 65%,currentColor)}.ec-link[data-tone=waiting] .ec-status{color:color-mix(in srgb,#d59a06 65%,currentColor)}
            .ec-link[data-tone=error]>.ec-icon{opacity:1;stroke:#e11d48}.ec-link[data-tone=error] .ec-status{color:color-mix(in srgb,#e11d48 80%,currentColor)}
            .ec-updates{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:12px 20px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 3%,transparent)}
            .ec-updates>.ec-icon{width:16px;height:16px;margin-top:2px}
            .ec-updates p{margin:0;flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:2px;font-size:14px;line-height:20px}
            .ec-updates p strong{font-weight:700}.ec-updates p span{font-size:13px;line-height:18px;opacity:.72}
            .ec-updates[data-tone=warning]{background:rgba(240,188,116,.22)}.ec-updates[data-tone=info]{background:rgba(52,124,206,.08)}.ec-updates[data-tone=error]{background:rgba(240,69,39,.08)}.ec-updates[data-tone=done]{background:rgba(16,185,129,.1)}
            /* Keep end-aligned explanations inside the panel when the footer wraps. */
            .ec-update-actions{display:flex;flex-wrap:wrap;gap:8px;align-self:center;margin-left:auto}
            @media(max-width:560px){.ec-head,.ec-updates{padding-left:16px;padding-right:16px}.ec-box,.ec-links{margin-left:16px;margin-right:16px}}
          `;
          const ICONS = {
            chart: ['M4 20V10M10 20V4M16 20v-7M22 20H2'],
            alert: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 7.5v5.5', 'M12 16.5v.01'],
            check: ['M20 6 9 17l-5-5'],
            copy: ['M9 9h11v11H9z', 'M5 15V5a1 1 0 0 1 1-1h10'],
            download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
            refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
            clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 7v5l3 2'],
            browser: ['M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 8h18', 'M8 22h8'],
          };
          // The same glyph the e-Comet front puts after every external link (react-icons/rx RxOpenInNewWindow).
          const externalIcon = () => h('svg', { className: 'ec-ext', viewBox: '0 0 15 15', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M12 13a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2.5a.5.5 0 0 0 1 0V3h9v9H9.5a.5.5 0 0 0 0 1H12ZM6.5 8.5l-4 4a.5.5 0 0 1-.7-.7l4-4H3.5a.5.5 0 0 1 0-1h3.9a.5.5 0 0 1 .5.5v3.9a.5.5 0 0 1-1 0V8.5Z', fill: 'currentColor', fillRule: 'evenodd', clipRule: 'evenodd' }));
          const icon = (name, color) => h('svg', { className: 'ec-icon', viewBox: '0 0 24 24', fill: 'none', stroke: color || 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            ...ICONS[name].map((d) => h('path', { key: d, d })));
          // The async clipboard needs a focused secure document; a hidden textarea with execCommand is the fallback.
          const copyText = async (text) => {
            try { await navigator.clipboard.writeText(text); return true; } catch {}
            try {
              const area = document.createElement('textarea');
              area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
              document.body.appendChild(area); area.select();
              const ok = document.execCommand('copy');
              area.remove();
              return ok;
            } catch { return false; }
          };
          // The starter prompt is a copy button: the Host offers a client plugin no way to open a Session with a draft, so
          // one click puts the exact phrase on the clipboard and the icon confirms it for a moment without moving the text.
          function PromptChip({ t }) {
            const [copied, setCopied] = React.useState(false);
            React.useEffect(() => { if (!copied) return undefined; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
            return h('span', { className: 'ec-prompt' },
              h('span', { className: 'ec-muted' }, t('promptLead')),
              h('button', { type: 'button', className: 'ec-pill ec-chip', 'aria-label': t('promptCopy'), 'data-copied': copied ? '' : undefined,
                onClick: () => { void copyText(t('prompt')).then((ok) => { if (ok) setCopied(true); }); } }, t('prompt'), icon(copied ? 'check' : 'copy')),
              h('span', { className: 'ec-sr', role: 'status', 'aria-live': 'polite' }, copied ? t('promptCopied') : ''));
          }
          function AccountCard({ t }) {
            const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            const reconnecting = state.state === 'error' && state.errorCode === 'reconnecting';
            // Polling clears transient RPC notices; a retained account failure still needs an explanation.
            const accountNotice = state.notice || (state.state === 'error' ? {
              'connection-failed': 'connectionFailed', 'connection-timeout': 'connectionTimeout',
              'authorization-declined': 'authorizationDeclined', 'login-expired': 'loginExpired',
              'unlink-failed': 'disconnectFailed',
            }[state.errorCode] : null);
            const update = state.updates;
            const updateBlocked = state.busy || state.state === 'connecting' || update?.toolActive;
            const updateBlockedReason = t(state.state === 'connecting' ? 'updateLoginActive'
              : state.busy ? 'updateAccountActive' : 'updateToolActive');
            const updatePaused = ['updating','restart-required'].includes(update?.state) || update?.errorCode === 'recovery-required';
            const connected = state.state==='connected';
            // One verdict for the whole plugin: a connection that needs the user's action lowers the badge from "ready".
            const rows = ['remote','local'].map((kind) => {
              const observed = state.connections?.[kind] || 'disconnected';
              // Disconnected is provisional while the saved account is still being restored.
              const current = updatePaused ? (update?.state === 'restart-required' ? 'afterRestart' : 'updatePaused')
                : kind==='remote' && reconnecting && observed!=='connected' ? 'reconnecting'
                : state.state==='checking' && observed==='disconnected' ? 'checking'
                // Without an account nothing works, the local bridge included: both rows wait for the sign-in whatever they observe.
                : !connected && !reconnecting && state.state!=='checking' ? 'afterLogin' : observed;
              const signal = current==='connected' ? 'ready' : ['unavailable','bridge_unavailable'].includes(current) ? 'error'
                : ['extension_offline','reconnecting'].includes(current) ? 'waiting' : updatePaused ? 'paused' : 'off';
              return { kind, current, signal };
            });
            const worstRow = rows.some((row) => row.signal==='error') ? 'error' : rows.some((row) => row.signal==='waiting') ? 'waiting' : 'ready';
            const tone = updatePaused ? 'waiting' : reconnecting ? 'waiting' : connected ? worstRow : state.state === 'connecting' ? 'waiting' : 'off';
            const badgeKey = updatePaused ? 'updatePaused' : reconnecting ? 'badgeReconnecting'
              : connected ? { ready:'badgeReady', waiting:'badgeAction', error:'badgeError' }[worstRow]
              : { connecting:'badgeWaiting', checking:'badgeChecking' }[state.state] || 'badgeOff';
            // A slow pulse on the dot says the state is in progress; the noun labels carry no ellipsis.
            const busy = updatePaused ? update?.state==='updating' : reconnecting || ['checking','connecting'].includes(state.state);
            const badge = h('span', { className:'ec-pill ec-badge', 'data-tone':tone, 'data-busy':busy?'':undefined, role:'status', 'aria-live':'polite' }, h('span',{className:'ec-dot','aria-hidden':true}), t(badgeKey));
            // A double-click can reach Cancel after the first click starts login; keyboard clicks have detail 0.
            const button = (label, handler, primary=false, disabled=state.busy, quiet=false, external=false) => h('button',{type:'button',className:'ec-button'+(primary?' ec-button-primary':'')+(quiet?' ec-button-quiet':''),disabled,onClick:(event)=>{if(event?.detail>1)return;void handler();}},t(label),external && externalIcon());
            const notice = (text, signal, name, role) => h('div',{className:'ec-box','data-tone':signal,role},icon(name,signal==='error'?'#f04527':undefined),h('p',null,text));
            // The head never explains: the badge is the verdict, and every explanation sits beside the element it is
            // about — a caption next to the button, a line in the update footer, the words in the broken row.
            // The head keeps one shape: badge and chip on the left, every account action on the right.
            // The starter prompt only makes sense when the plugin can actually work.
            const headline = connected && !updatePaused && worstRow==='ready' ? h(PromptChip,{t}) : null;
            // A problem row carries its own status words and the one action the user can take; a healthy row only says so
            // to assistive technology, since the badge above already gives the verdict.
            const connection = ({ kind, current, signal }) => {
              const problem = signal==='waiting' || signal==='error';
              const statusKey = current==='connected' ? 'available' : current;
              // The explanation and its link live in a tooltip on the dashed status word, so a broken row stays one line.
              const tip = current==='extension_offline' ? h('div',{className:'ec-tip-box'},
                  t('localOfflineBefore'), h('a',{href:'https://www.wildberries.ru/',target:'_blank',rel:'noopener noreferrer'},'wildberries.ru',externalIcon()), t('localOfflineAfter'),
                  h('br'), h('span',{style:{opacity:.7}},t('localDoctorHint')))
                : current==='bridge_unavailable' ? h('div',{className:'ec-tip-box'},t('localBridgeHint'))
                // The local module is not running and the adapter keeps restarting it: the row names the wait and the two user steps itself.
                : kind==='local' && current==='unavailable' ? h('div',{className:'ec-tip-box'},
                  t('localUnavailableBefore'), h('a',{href:'https://app.e-comet.io/',target:'_blank',rel:'noopener noreferrer'},'app.e-comet.io',externalIcon()), t('localUnavailableAfter')) : null;
              const status = tip
                ? h('span',{className:'ec-tip'},h('span',{className:'ec-status ec-tip-term',tabIndex:0},t(statusKey)),h('div',{className:'ec-tip-bubble','data-align':'end',role:'tooltip'},tip))
                // Words only where the row differs from the badge: a reconnecting row repeats the badge, so it keeps the icon alone.
                : h('span',{className:signal==='ready'||['checking','reconnecting'].includes(current)?'ec-sr':'ec-status'},t(statusKey));
              return h('div',{className:'ec-link','data-tone':signal,key:kind},
                icon(kind==='remote'?'chart':'browser'),
                h('div',{className:'ec-link-text'},
                  h('div',{className:'ec-link-head'},h('span',{className:'ec-link-title'},t(kind)),status)));
            };
            const loginRunning = state.state==='connecting';
            const side = h('div',{className:'ec-side'},
              updatePaused ? button('disconnect',controller.disconnect,false,true,true)
              : loginRunning ? h(React.Fragment,null,
                  button('cancel',controller.cancelLogin,false,state.busy&&state.operation!=='startLogin',true),
                  state.authorizationUrl && h('a',{href:state.authorizationUrl,target:'_blank',rel:'noopener noreferrer',className:'ec-button'},t('open'),externalIcon()))
              : reconnecting ? h(React.Fragment,null,
                  button('reconnectNow',controller.startLogin,false,state.busy),
                  button('disconnect',controller.disconnect,false,state.busy,true))
              : connected ? button('disconnect',controller.disconnect,false,state.busy,true)
              : state.errorCode === 'unlink-failed' ? h(React.Fragment,null,
                  button('connect',controller.startLogin,true,state.busy,false,true),
                  button('disconnect',controller.disconnect,false,state.busy,true))
              : state.state==='checking' ? null
              // Connect opens the login page in the browser: an external step, so it carries the front's external glyph.
              : button('connect',controller.startLogin,true,state.busy,false,true));
            const updateMessage = { 'recovery-required':'updateRecovery' }[update?.errorCode] || { checking:'updateChecking', current:'updateCurrent', available:'updateAvailable', updating:'updateInstalling', 'restart-required':'updateRestart', error:update?.availableVersion?'updateFailed':'updateCheckFailed' }[update?.state] || 'updateCheckFailed';
            const installable = !['recovery-required','host-incompatible'].includes(update?.errorCode) && update?.availableVersion && ['available','error'].includes(update.state);
            const versionLine = update?.currentVersion ? t('updateInstalled')+' '+update.currentVersion : null;
            // The footer is always two lines, so an arriving update changes words, tint and the button slot, never the height.
            // An update the host refuses is a warning, not a failure: the installed plugin keeps working.
            const incompatible = update?.errorCode==='host-incompatible';
            const updateTone = update?.state==='restart-required' ? 'done' : incompatible ? 'warning' : (update?.state==='error' || update?.errorCode) ? 'error' : ['available','updating'].includes(update?.state) ? 'info' : undefined;
            const updateSub = update?.state==='updating' ? t('updatePausedHint') : update?.state==='restart-required' ? t('updateRestartNote')
              : [incompatible ? t('updateSupport') : null, versionLine].filter(Boolean).join(' · ');
            const updateIcon = incompatible ? ['alert','#d59a06'] : { current:['check','#10b981'], available:['download','#347cce'], 'restart-required':['refresh','#10b981'], error:['alert','#f04527'], updating:['clock'] }[update?.state] || ['refresh'];
            const checkButton = h('button',{type:'button',className:'ec-button ec-button-quiet',disabled:state.updateBusy || ['checking','updating','restart-required'].includes(update?.state),onClick:()=>{void controller.checkUpdates();}},t('checkUpdates'));
            return h('section', {'aria-label':t('title'),className:'ec-card'},
              h('style',null,cardCss),
              h('div',{className:'ec-panel'},
                h('div',{className:'ec-head'},
                  h('div',{className:'ec-head-main'},badge,headline),
                  side),
                h('div',{className:'ec-slot','data-open':!updatePaused && accountNotice ? '' : undefined},h('div',null,!updatePaused && accountNotice && notice(t(accountNotice),'error','alert','alert'))),
                h('div',{className:'ec-links'},...rows.map(connection)),
                update && h('div',{className:'ec-updates','data-tone':updateTone,'data-busy':['checking','updating'].includes(update.state)?'':undefined},
                  icon(updateIcon[0],updateIcon[1]),
                  h('p',{role:'status','aria-live':'polite'},
                    h('strong',null,incompatible ? t('updateIncompatible')+' '+update.availableVersion+' '+t('updateIncompatibleTail') : t(updateMessage)+(['available','restart-required'].includes(update.state) ? ' '+update.availableVersion : '')),
                    updateSub && h('span',null,updateSub)),
                  h('div',{className:'ec-update-actions'},
                    // A disabled button cannot receive keyboard focus. Its labelled group exposes the reason
                    // without enabling installation or adding an alternative action handler.
                    installable && h('span',{className:'ec-tip',tabIndex:updateBlocked?0:undefined,role:updateBlocked?'group':undefined,'aria-label':updateBlocked?updateBlockedReason:undefined},
                      h('button',{type:'button',className:'ec-button ec-button-primary',disabled:state.updateBusy===true || updateBlocked,onClick:()=>{void controller.installUpdate();}},t('updateButton')),
                      // The service counts a pending browser login as tool activity too, so the login state names the real cause.
                      updateBlocked && h('div',{className:'ec-tip-bubble','data-align':'end',role:'tooltip'},h('div',{className:'ec-tip-box'},updateBlockedReason))),
                    // A found update makes the check button pointless; it stays where a check is the next action. The
                    // service ignores checks while a restart or a failed recovery is pending, so the button is left out there.
                    !installable && update.state!=='restart-required' && update.errorCode!=='recovery-required' && checkButton,
                    installable && h('a',{href:'https://github.com/e-comet/skills/blob/main/CHANGELOG.md',target:'_blank',rel:'noopener noreferrer',className:'ec-button ec-button-quiet'},t('changelog'),externalIcon()))
                )
              )
            );
          }
          phase = 'account page registration';
          ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-e-comet-skills', locale: NS }, AccountCard));
        } catch (error) {
          console.error('[dsh-e-comet-skills] Client bootstrap failed during ' + phase);
          throw error;
        }
      },
    };
  },
});
