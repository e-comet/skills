import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { FileOAuthProvider, CREDENTIAL_DIRECTORY, REMOTE_URL, OAUTH_ISSUER_ORIGIN, createTrustedFetch, startCallback } from './oauth.mjs';
import { createRetry, RECONNECT_DELAYS_MS } from './retry.mjs';
import { isLoginRequired } from './remote-client.mjs';
import { retryTransientFileOperation } from '../../plugins/e-comet-skills/hooks/transient-file-operation.mjs';

const CONNECTION_FAILED = 'connection-failed';
// A saved account whose connection dropped: the Host keeps retrying with the saved credentials.
const RECONNECTING = 'reconnecting';
const LOGIN_EXPIRED = 'login-expired';

/** Host-only account owner. Its public views never contain credentials. */
export function createAccount({ directory = CREDENTIAL_DIRECTORY, fetchImpl = fetch, connectRemote, disconnectRemote, isRemoteConnected = () => true, timeoutMs = 300_000, retryDelaysMs = RECONNECT_DELAYS_MS } = {}) {
  const saved = new FileOAuthProvider({ directory });
  let status = { state: 'checking' };
  let attempt;
  let disposed = false;
  const getStatus = () => {
    if (status.state === 'connected' && !isRemoteConnected()) status = { state: 'error', errorCode: CONNECTION_FAILED };
    return { ...status };
  };
  const hasSavedLogin = async () => Boolean((await saved.tokens())?.access_token);
  // Reconnecting with saved credentials has no side effect beyond the connection itself, so it
  // never waits for a click. An expired sign-in or an explicit login attempt stops it.
  const reconnect = createRetry(async () => {
    if (disposed || attempt || status.errorCode !== RECONNECTING) return true;
    const recovering = status;
    const ownsRecovery = () => !disposed && !attempt && status === recovering;
    const savedLogin = await hasSavedLogin();
    if (!ownsRecovery()) return true;
    if (!savedLogin) { status = { state: 'logged_out' }; return true; }
    try { await connectRemote(); } catch (error) {
      if (!ownsRecovery()) return true;
      if (isLoginRequired(error)) { status = { state: 'error', errorCode: LOGIN_EXPIRED }; return true; }
      return false;
    }
    if (ownsRecovery()) status = { state: 'connected' };
    return true;
  }, { delays: retryDelaysMs });
  function connectionLost() {
    status = { state: 'error', errorCode: RECONNECTING };
    reconnect.schedule();
  }
  async function initialize() {
    if (disposed || attempt) return getStatus();
    const checking = status = { state: 'checking' };
    // Startup runs independently of Host readiness. A manual action or disposal
    // owns its newer state even when the saved-account handshake finishes later.
    const ownsStatus = () => !disposed && !attempt && status === checking;
    try {
      const savedLogin = await hasSavedLogin();
      if (!ownsStatus()) return getStatus();
      if (!savedLogin) { status = { state: 'logged_out' }; return getStatus(); }
      await connectRemote();
      if (ownsStatus()) status = { state: 'connected' };
    } catch (error) {
      if (ownsStatus()) {
        if (isLoginRequired(error)) status = { state: 'error', errorCode: LOGIN_EXPIRED };
        else connectionLost();
      }
    }
    return getStatus();
  }
  /** The Host reports a remote connection that ended without an account action. */
  function remoteLost(reason) {
    if (disposed || attempt || status.state !== 'connected') return;
    if (reason === 'login_required') { reconnect.reset(); status = { state: 'error', errorCode: LOGIN_EXPIRED }; return; }
    connectionLost();
  }
  async function cancelLogin() {
    const current = attempt;
    if (current) {
      current.cancelled = true;
      current.abort.abort();
      current.callback?.close();
      await current.done;
      if (attempt === current) attempt = undefined;
      status = { state: 'logged_out' };
    } else if (status.state !== 'connected') {
      // The card can cancel while the initial credential read is still pending.
      reconnect.reset();
      status = { state: 'logged_out' };
    }
    return getStatus();
  }
  async function startLogin() {
    if (disposed) throw new Error('e-Comet account service has stopped.');
    // Keep an automatic recovery alive until the manual credential read succeeds.
    // Startup still loses ownership immediately when a manual login begins.
    if (status.errorCode !== RECONNECTING) status = { ...status };
    if (attempt) await cancelLogin();
    if (getStatus().state === 'connected') return getStatus();
    const starting = status;
    const retrySavedConnection = status.errorCode === RECONNECTING;
    const savedLogin = await hasSavedLogin();
    if (disposed || status !== starting) return getStatus();
    // A temporary credential read failure must leave automatic recovery scheduled.
    reconnect.reset();
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const current = { abort: new AbortController(), cancelled: false };
    const signal = AbortSignal.any([current.abort.signal, AbortSignal.timeout(timeoutMs)]);
    attempt = current;
    status = { state: 'connecting' };
    current.done = (async () => {
      let temporary;
      try {
        if (savedLogin) {
          // A valid saved login reconnects without sending the user through the browser again.
          let restored = false;
          try { await connectRemote(); restored = true; }
          catch (error) {
            // An outage does not invalidate the saved login. Only a classified refusal needs OAuth.
            if (!isLoginRequired(error)) {
              if (!current.cancelled) status = { state: 'error', errorCode: RECONNECTING };
              return;
            }
          }
          if (current.cancelled) { if (restored) await disconnectRemote(); return; }
          if (restored) { status = { state: 'connected' }; return; }
        }
        await mkdir(directory, { recursive: true, mode: 0o700 });
        temporary = await mkdtemp(join(directory, 'login-'));
        const provider = new FileOAuthProvider({ directory: temporary, onAuthorization(url) {
          if (url.origin !== OAUTH_ISSUER_ORIGIN) throw new Error('Untrusted authorization URL.');
          if (current.cancelled) throw new Error('OAuth login cancelled.');
          status = { state: 'connecting', authorizationUrl: url.href };
          resolveReady({ state: 'connecting', authorizationUrl: url.href });
        } });
        current.callback = await startCallback(await provider.state(), { timeoutMs });
        // The same deadline owns discovery and token exchange, not just the browser wait.
        current.callback.code.catch(error => current.abort.abort(error));
        if (current.cancelled) { current.callback.close(); throw new Error('OAuth login cancelled.'); }
        provider.callbackUrl = current.callback.url;
        const fetchFn = createTrustedFetch((input, options) => fetchImpl(input, { ...options, signal }));
        const result = await auth(provider, { serverUrl: REMOTE_URL, fetchFn });
        if (result === 'REDIRECT') await auth(provider, { serverUrl: REMOTE_URL, authorizationCode: await current.callback.code, fetchFn });
        if (current.cancelled) throw new Error('OAuth login cancelled.');
        await provider.invalidateCredentials('verifier');
        await saved.update(await provider.read());
        if (current.cancelled) { await saved.invalidateCredentials('all'); return; }
        // Remote bootstrap still uses the SDK's bounded timeout; cancellation
        // at this stage may await that deadline; cancellation is not instantaneous here.
        try { await connectRemote(); }
        catch (error) {
          // OAuth is already saved: a bootstrap outage must recover with those
          // credentials instead of requiring another browser login.
          // Cancellation owns this fresh login even when bootstrap fails; otherwise
          // the next startup would silently restore the cancelled credentials.
          if (current.cancelled) await saved.invalidateCredentials('all');
          else status = { state: 'error', errorCode: isLoginRequired(error) ? LOGIN_EXPIRED : RECONNECTING };
          return;
        }
        if (current.cancelled) { await disconnectRemote(); await saved.invalidateCredentials('all'); return; }
        status = { state: 'connected' };
      } catch (error) {
        if (!current.cancelled) status = { state: 'error', errorCode: error.errorCode === 'authorization-declined' ? 'authorization-declined' : retrySavedConnection ? RECONNECTING : error.name === 'TimeoutError' || error.errorCode === 'connection-timeout' ? 'connection-timeout' : CONNECTION_FAILED };
      } finally {
        current.callback?.close();
        // This attempt owns only its login directory; other profiles may still be signing in.
        // Permanent refusal is an accepted residual in docs/local-agent-architecture.md#accepted-residuals.
        if (temporary) await retryTransientFileOperation(() => rm(temporary, { recursive: true, force: true }))
          .catch(() => console.warn('[e-Comet] Login temporary cleanup failed.'));
        resolveReady(getStatus());
        if (attempt === current) attempt = undefined;
        // Failed manual recovery must not cancel saved-account retries. Schedule
        // only after cleanup: an earlier timer can observe the active attempt and stop.
        if (!disposed && !current.cancelled && status.errorCode === RECONNECTING) reconnect.schedule();
      }
    })();
    return ready;
  }
  async function disconnect() {
    status = { ...status }; // A pending startup read must not begin another connection.
    reconnect.reset();
    await cancelLogin();
    await disconnectRemote({ forgetLogin: true });
    try { await saved.invalidateCredentials('all'); }
    catch (error) {
      // Respect the explicit unlink: retained credentials must not trigger recovery here.
      // See "Native DeepSeek failed unlink" in docs/local-agent-architecture.md#accepted-residuals.
      status = { state: 'error', errorCode: 'unlink-failed' };
      throw error;
    }
    status = { state: 'logged_out' };
    return getStatus();
  }
  async function dispose() { disposed = true; reconnect.stop(); await cancelLogin(); }
  return { initialize, getStatus, startLogin, waitForLogin: () => attempt?.done, cancelLogin, disconnect, dispose, remoteLost };
}
