import { compareCalVer, normalizeCalVer } from '../../plugins/e-comet-skills/hooks/check-update.mjs';
import { PACKAGE_VERSION } from './version.mjs';
import { readProfileUpdate } from './update-policy.mjs';
import { failure } from './adapter.mjs';
import { FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES } from '../../plugins/e-comet-skills/mcp/src/feedback-diagnostics.mjs';

const PACKAGE = 'dsh-e-comet-skills';
// A stalled package-policy read must not leave the card checking forever.
const METADATA_TIMEOUT_MS = 10_000;
// The Host stays open for days: a release is noticed within hours, and a failed read retries sooner
// with backoff so one npm outage cannot leave the card stale or hammer the registry.
const RECHECK_INTERVAL_MS = 6 * 60 * 60_000;
const RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
const exactVersion = value => {
  const components = normalizeCalVer(value);
  return components !== null && components.join('.') === value;
};

/** Read-only scheduled/manual checks. Only the private UI can request the captured exact npm version. */
export function createUpdates({ ctx, currentVersion = PACKAGE_VERSION, readMetadata = options => readProfileUpdate(ctx, options),
  installBundle = spec => ctx.get('pluginManager').installBundle(spec), metadataTimeoutMs = METADATA_TIMEOUT_MS,
  recheckIntervalMs = RECHECK_INTERVAL_MS, retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  let snapshot = { state: 'checking', currentVersion };
  let check;
  let disposed = false;
  let installation;
  let activeTools = 0;
  // Remember the host's refusal for this runtime; a restart can load a different host.
  let rejectedVersion;
  let failedChecks = 0;
  let nextCheck;
  const metadataAbort = new AbortController();
  const getStatus = () => ({ ...snapshot, toolActive: activeTools > 0 });
  const halted = () => snapshot.state === 'restart-required' || snapshot.errorCode === 'recovery-required';
  const unref = timer => { timer.unref?.(); return timer; };

  function scheduleCheck() {
    clearTimeout(nextCheck);
    if (disposed || halted()) return;
    const delay = failedChecks ? retryDelaysMs[Math.min(failedChecks, retryDelaysMs.length) - 1] : recheckIntervalMs;
    nextCheck = unref(setTimeout(() => { void checkUpdates(); }, delay));
  }

  function checkUpdates() {
    if (disposed || installation || halted()) return Promise.resolve(getStatus());
    if (check) return check;
    const installedVersion = snapshot.currentVersion;
    snapshot = { state: 'checking', currentVersion: installedVersion };
    check = (async () => {
      try {
        const signal = AbortSignal.any([metadataAbort.signal, AbortSignal.timeout(metadataTimeoutMs)]);
        const metadata = await readMetadata({ currentVersion: installedVersion, signal });
        if (metadata?.name !== PACKAGE || !exactVersion(metadata.version) || !exactVersion(installedVersion)) {
          snapshot = { state: 'error', currentVersion: installedVersion, errorCode: 'metadata-invalid' }; return;
        }
        snapshot = compareCalVer(installedVersion, metadata.version) < 0
          ? { state: metadata.version === rejectedVersion ? 'error' : 'available', currentVersion: installedVersion,
            availableVersion: metadata.version, ...(metadata.version === rejectedVersion ? { errorCode: 'host-incompatible' } : {}) }
          : { state: 'current', currentVersion: installedVersion };
      } catch {
        snapshot = { state: 'error', currentVersion: installedVersion, errorCode: 'check-failed' };
      }
    })().finally(() => {
      check = undefined;
      // Count observations, not timer scheduling: installation also schedules after its eligibility check.
      failedChecks = snapshot.state === 'error' && snapshot.errorCode !== 'host-incompatible' ? failedChecks + 1 : 0;
      scheduleCheck();
    }).then(() => getStatus());
    return check;
  }

  function installUpdate() {
    if (installation) return installation;
    if (disposed || !snapshot.availableVersion || snapshot.availableVersion === rejectedVersion || halted()) return Promise.resolve(getStatus());
    if (activeTools > 0) return Promise.resolve(getStatus());
    const version = snapshot.availableVersion;
    const eligibility = checkUpdates();
    installation = (async () => {
      await eligibility;
      if (disposed || snapshot.state !== 'available' || snapshot.availableVersion !== version) return getStatus();
      // A call or login may start during the policy read. Another explicit UI request
      // is required after it finishes; checks and operation completion never install.
      if (activeTools > 0) return getStatus();
      const installedVersion = snapshot.currentVersion;
      snapshot = { state: 'updating', currentVersion: installedVersion, availableVersion: version };
      try {
        const result = await installBundle(`${PACKAGE}@${version}`);
        // installSafely leaves this instance's transports paused after either success, so both need a restart.
        if (['restart-required', 'applied'].includes(result?.application)) snapshot = { state: 'restart-required', currentVersion: installedVersion, availableVersion: version };
        else if (result?.error?.code === 'incompatible-version') {
          rejectedVersion = version;
          snapshot = { state: 'error', currentVersion: installedVersion, availableVersion: version, errorCode: 'host-incompatible' };
        }
        else snapshot = { state: 'error', currentVersion: installedVersion, availableVersion: version, errorCode: 'install-failed' };
        return { ...getStatus(), result };
      } catch (error) {
        snapshot = { state: 'error', currentVersion: installedVersion, availableVersion: version, errorCode: error.code === 'ECOMET_UPDATE_RECOVERY_FAILED' ? 'recovery-required' : 'install-failed' };
        if (snapshot.errorCode === 'recovery-required') {
          const systemCode = error.cause?.code;
          try {
            ctx.logger?.error('ECOMET_UPDATE_RECOVERY_FAILED: %s', JSON.stringify({
              backupDirectory: error.backupDirectory,
              ...(FEEDBACK_DIAGNOSTIC_FILESYSTEM_CODES.includes(systemCode) ? { systemCode } : {}),
            }));
          } catch { /* A failed diagnostic sink must not hide the terminal recovery state. */ }
          return getStatus();
        }
        throw error;
      }
    })().finally(() => { installation = undefined; scheduleCheck(); });
    return installation;
  }

  async function runTool(execute) {
    if (snapshot.state === 'updating' || halted()) throw failure('ECOMET_UPDATE_IN_PROGRESS',
      snapshot.errorCode === 'recovery-required' ? 'An e-Comet update failed and the previous files could not be restored. Ask the user to contact e-Comet support; do not retry e-Comet tools.'
        : snapshot.state === 'restart-required' ? 'An e-Comet update is installed. Ask the user to restart DeepSeek (Application → Exit, then open it again) before using e-Comet tools; this call was not started.'
          : 'e-Comet is installing an update. Wait for it to finish, then retry; this call was not started.', 'update');
    activeTools++;
    try { return await execute(); } finally { activeTools--; }
  }

  function dispose() { disposed = true; clearTimeout(nextCheck); metadataAbort.abort(); }
  return { checkUpdates, getStatus, installUpdate, runTool, dispose };
}
