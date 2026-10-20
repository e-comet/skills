const CARD = 'Plugins → e-Comet Skills';
const CONNECT = `Ask the user to open ${CARD} in DeepSeek and press «Связать с аккаунтом e-Comet»`;
const SUPPORT = 'contact e-Comet support through the widget on https://app.e-comet.io';
const NO_ACTION = 'Wait; the user needs to do nothing.';
const ATTEMPT_FAILED = {
  'connection-failed': 'the plugin could not connect to e-Comet',
  'connection-timeout': 'the login timed out',
  'authorization-declined': 'the login was not completed in the browser',
};

function updateSentence({ state, errorCode } = {}) {
  if (errorCode === 'recovery-required') return `An e-Comet update failed and its files could not be restored; e-Comet tools are unavailable. Ask the user to ${SUPPORT}; do not retry e-Comet tools.`;
  if (state === 'restart-required') return 'An e-Comet update is installed but inactive until DeepSeek restarts; e-Comet tools stay paused. Ask the user to restart DeepSeek (Application → Exit, then open it again); no new login is needed.';
  if (state === 'updating') return `e-Comet is installing an update; its tools are paused until it finishes, and a refused call was not started. ${NO_ACTION}`;
  return '';
}

function accountSentence({ state, errorCode, authorizationUrl } = {}) {
  if (state === 'connected') return '';
  if (state === 'checking') return 'The e-Comet account is still being checked; wait before calling remote e-Comet tools.';
  // `connecting` without a URL covers a saved-login connect («Связать с аккаунтом e-Comet» or «Переподключить сейчас»
  // with a saved login) and the discovery round trips before a browser login opens; the URL itself is never rendered.
  if (state === 'connecting') return authorizationUrl
    ? 'The e-Comet account login is in progress in the browser; wait for it to finish before calling remote e-Comet tools.'
    : 'The e-Comet account is connecting; wait for it to finish before calling remote e-Comet tools.';
  if (state === 'logged_out') return `No e-Comet account is connected: remote e-Comet tools (analytics, advertising settings, browser authorization) are absent. ${CONNECT}; the login page opens in the browser.`;
  if (state === 'error' && errorCode === 'reconnecting') return `The e-Comet account is reconnecting with the saved login (the connection dropped or could not be established); the plugin retries by itself. ${NO_ACTION} A call cut by the drop has an unknown outcome; repeating it is the user's decision. If it is still reconnecting after a few minutes, suggest checking this computer's internet connection (VPN, proxy, firewall) as a candidate, then ask the user to press «Переподключить сейчас» in ${CARD}; if that does not help, ask the user to ${SUPPORT}.`;
  if (state === 'error' && errorCode === 'login-expired') return `The e-Comet account login expired: remote e-Comet tools are absent. ${CONNECT} again.`;
  if (state === 'error' && errorCode === 'unlink-failed') return `Unlinking the e-Comet account failed and the account is disconnected. Ask the user to press «Отвязать аккаунт» or «Связать с аккаунтом e-Comet» in ${CARD}.`;
  if (state === 'error' && ATTEMPT_FAILED[errorCode]) return `The last e-Comet account connection attempt failed: ${ATTEMPT_FAILED[errorCode]}; remote e-Comet tools are absent. ${CONNECT} again.${errorCode === 'authorization-declined' ? '' : ` If it fails again, suggest checking this computer's internet connection (VPN, proxy, firewall) as a candidate; if that does not help, ask the user to ${SUPPORT}.`}`;
  return `The e-Comet account is not connected (${state}${errorCode ? `, ${errorCode}` : ''}). Ask the user to check ${CARD} in DeepSeek.`;
}

function localSentence({ local, localFailure } = {}) {
  if (local === 'connected') return '';
  if (local !== 'unavailable') return 'The local e-Comet module is starting; wait before calling its tools.';
  const cause = `${localFailure?.cause ?? 'unknown'}${localFailure?.systemCode ? ` ${localFailure.systemCode}` : ''}`;
  // The adapter keeps restarting the module (5 s, 15 s, 60 s, then every five minutes after start failures; about every
  // 5 s after a crash that followed a successful handshake), so the user step comes second.
  // A crash loop makes this text flap with the module: see "Native DeepSeek snapshot flapping during a crash loop" in
  // docs/local-agent-architecture.md#accepted-residuals.
  return `The local e-Comet module (live Wildberries data, Ozon reports, bug reports) is not running (${cause}); its tools are absent and no bug report can be sent from DeepSeek. The plugin restarts it by itself: wait until its tools return; repeating a call is the user's decision. If it stays unavailable for a few minutes, ask the user to restart DeepSeek; if that does not help, ask the user to ${SUPPORT}.`;
}

/**
 * The adapter-owned state the host never sees: account, local module and update pause. Sync and pure,
 * evaluated at every prompt assembly; the host re-sends the snapshot only when it changes, and the
 * normal case renders nothing. An update pause unmounts both connections, so it speaks alone.
 */
export function renderStatusContext({ account, connections, updates } = {}) {
  const paused = updateSentence(updates);
  const sentences = paused ? [paused] : [accountSentence(account), localSentence(connections)].filter(Boolean);
  if (!sentences.length) return '';
  // The host delivers this snapshot to every chat, so the scope clause keeps unrelated chats from relaying the action.
  return `e-Comet plugin status (relevant only when the user's request needs e-Comet): ${sentences.join(' ')} e-Comet never asks for API keys, tokens or passwords in chat; do not request them.`;
}
