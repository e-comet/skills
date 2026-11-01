import fs from 'node:fs/promises';
import { homedir, uptime as osUptime } from 'node:os';
import { posix, win32 } from 'node:path';
import { compareBrokerVersions } from './bridge-registration.mjs';
import { NATIVE_EXTENSION_MIN_VERSION } from './config.mjs';
import { EXTENSION_INSTALL_VOCABULARY, diagnosticCheck } from './diagnostic-facts.mjs';
import { safeExtensionVersion } from './tool-errors.mjs';
import { extensionInstallFactsSchema, validateSchemaValue } from './tool-schemas.mjs';

export const EXTENSION_ID = 'apeallgchpgibifmbgefkhifidihmodh';

// Chromium extensions/browser/disable_reason.h: DISABLE_USER_ACTION = 1 << 0, DISABLE_PERMISSIONS_INCREASE = 1 << 1,
// DISABLE_RELOAD = 1 << 2. Read from the header; a real profile with this reason is still to be captured
// (test/fixtures/secure-preferences/README.md).
export const DISABLE_REASON_PERMISSIONS_INCREASE = 2;

// Chrome roots: Chromium docs/user_data_dir.md. Other vendor roots follow the observed layouts in spec §4.2.
// Accepted residual "A browser outside the probe's list": docs/local-agent-architecture.md#accepted-residuals.
export const browserUserDataDirectories = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
        const roaming = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
        return [
            { browser: 'chrome', path: win32.join(local, 'Google', 'Chrome', 'User Data') },
            { browser: 'edge', path: win32.join(local, 'Microsoft', 'Edge', 'User Data') },
            { browser: 'brave', path: win32.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
            { browser: 'yandex', path: win32.join(local, 'Yandex', 'YandexBrowser', 'User Data') },
            { browser: 'opera', path: win32.join(roaming, 'Opera Software', 'Opera Stable') },
        ];
    }
    if (platform === 'darwin') {
        const support = posix.join(home, 'Library', 'Application Support');
        return [
            { browser: 'chrome', path: posix.join(support, 'Google', 'Chrome') },
            { browser: 'edge', path: posix.join(support, 'Microsoft Edge') },
            { browser: 'brave', path: posix.join(support, 'BraveSoftware', 'Brave-Browser') },
            { browser: 'yandex', path: posix.join(support, 'Yandex', 'YandexBrowser') },
            { browser: 'opera', path: posix.join(support, 'com.operasoftware.Opera') },
        ];
    }
    const config = env.XDG_CONFIG_HOME || posix.join(home, '.config');
    return [
        { browser: 'chrome', path: posix.join(config, 'google-chrome') },
        { browser: 'edge', path: posix.join(config, 'microsoft-edge') },
        { browser: 'brave', path: posix.join(config, 'BraveSoftware', 'Brave-Browser') },
        { browser: 'yandex', path: posix.join(config, 'yandex-browser') },
        { browser: 'opera', path: posix.join(config, 'opera') },
    ];
};

const MAX_REASON_MASK = 2 ** 31 - 1;
const { maxDisableReason, maxDisableReasons } = EXTENSION_INSTALL_VOCABULARY;
// Chromium 155 stores the reasons as a list of reason values (measured), which is kept as it is; older builds stored one
// integer bitmask, which is split into its set bits. Anything else is undefined.
const reasonsOf = (value) => {
    if (value === undefined) return [];
    if (Array.isArray(value)) {
        const reasons = [...new Set(value)].sort((a, b) => a - b);
        return reasons.length <= maxDisableReasons && reasons.every((reason) => Number.isInteger(reason) && reason >= 1 && reason <= maxDisableReason) ? reasons : undefined;
    }
    if (!Number.isInteger(value) || value < 0 || value > MAX_REASON_MASK) return undefined;
    const bits = [];
    for (let bit = 1; bit <= value; bit *= 2) if (value & bit) bits.push(bit);
    return bits;
};

// `entry` is the extension's `extensions.settings.<id>` record. An undetermined state never claims the extension is
// enabled or disabled.
export const classifyExtensionSettings = (entry) => {
    const unknown = { state: 'unknown', disableReasons: [], permissionsIncrease: false };
    const disableReasons = isRecord(entry) ? reasonsOf(entry.disable_reasons) : undefined;
    if (!disableReasons) return unknown;
    if (disableReasons.length > 0) return { state: 'disabled', disableReasons, permissionsIncrease: disableReasons.includes(DISABLE_REASON_PERMISSIONS_INCREASE) };
    // Chromium deletes the reasons when it enables an extension again and writes no `state`; the legacy `state: 1` agrees.
    return entry.state === undefined || entry.state === 1 ? { state: 'enabled', disableReasons, permissionsIncrease: false } : unknown;
};

export const isNativeCapableVersion = (version) => compareBrokerVersions(version, NATIVE_EXTENSION_MIN_VERSION) >= 0;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const failureCause = (error) => ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'io_error';
const recordFailure = (facts, cause) => { facts.readFailures += 1; facts.failureCause ??= cause; };
const readJson = async (fileSystem, path) => {
    try { return { ok: true, value: JSON.parse(await fileSystem.readFile(path, 'utf8')) }; }
    catch (error) { return { ok: false, absent: error?.code === 'ENOENT', cause: failureCause(error) }; }
};
// A name from `Local State` becomes a path, so it has to be one plain segment.
const plainSegment = (name) => name.length > 0 && name !== '.' && name !== '..' && !/[\\/\u0000:]/u.test(name);
const directory = async (fileSystem, path) => {
    try { return { exists: (await fileSystem.stat(path)).isDirectory() }; }
    catch (error) { return error?.code === 'ENOENT' ? { exists: false } : { exists: false, cause: failureCause(error) }; }
};

// Chromium keeps an installed copy in `Extensions/<id>/<version>_<n>`. Only its name is read: the version is the
// fallback for a record without a stored manifest.
const installedCopies = async (fileSystem, join, path, extensionId, facts) => {
    const root = join(path, 'Extensions', extensionId);
    const ext = await directory(fileSystem, root);
    if (ext.cause) { recordFailure(facts, ext.cause); return {}; }
    if (!ext.exists) return {};
    let names;
    try { names = await fileSystem.readdir(root); }
    catch (error) { recordFailure(facts, failureCause(error)); return {}; }
    let present = false;
    let version;
    for (const name of names) {
        const match = /^([^/\\]+)_[0-9]+$/.exec(name);
        if (!match) continue;
        const candidate = await directory(fileSystem, join(root, name));
        if (candidate.cause) { recordFailure(facts, candidate.cause); continue; }
        if (!candidate.exists) continue;
        present = true;
        const folderVersion = safeExtensionVersion(match[1]);
        if (folderVersion && (version === undefined || compareBrokerVersions(folderVersion, version) > 0)) version = folderVersion;
    }
    return { present, version };
};

// Chromium rewrites each profile's preference files while the browser runs, so their newest modification time is a
// recency hint for that profile. The files are stat'ed, never read, and the facts get a whole number of days, never a
// timestamp. `Local State` is left out: it changes when any profile is used.
const DAY_MS = 24 * 60 * 60 * 1000;
const newestModification = async (fileSystem, paths) => {
    let newest;
    for (const path of paths) {
        try { const { mtimeMs } = await fileSystem.stat(path); if (Number.isFinite(mtimeMs) && (newest === undefined || mtimeMs > newest)) newest = mtimeMs; }
        catch { /* absence or denial: recency stays unknown for this file */ }
    }
    return newest;
};
const daysAgo = (mtimeMs, nowMs) => Math.max(0, Math.floor((nowMs - mtimeMs) / DAY_MS));

// A profile is listed when its record or an installed copy shows the extension. `name` is its report label. Its path,
// whether its window was focused last, whether it has an open window (only when the browser keeps that list) and its
// last use in ms go only to `profilePaths`, never into the facts.
const probeProfile = async (fileSystem, join, path, name, extensionId, facts, nowMs, profilePaths, { focused, open }) => {
    const copies = await installedCopies(fileSystem, join, path, extensionId, facts);
    const recordIn = (read) => (read.ok && isRecord(read.value) ? read.value.extensions?.settings?.[extensionId] : undefined);
    let preferences = await readJson(fileSystem, join(path, 'Secure Preferences'));
    // Chromium protects the records only on Windows and macOS (chrome_pref_service_factory.cc): elsewhere `Secure
    // Preferences` holds only `protection`, and the records are in `Preferences`. A protected file with records but none
    // for e-Comet answers for the profile, so its `Preferences` is not read.
    if (preferences.absent || (preferences.ok && !isRecord(preferences.value?.extensions?.settings))) preferences = await readJson(fileSystem, join(path, 'Preferences'));
    if (!preferences.ok && !preferences.absent) recordFailure(facts, preferences.cause);
    const entry = recordIn(preferences);
    if (!copies.present && !isRecord(entry)) return;
    // Command-line and unpacked extensions keep no manifest in their record (Chromium extension_prefs.cc), so the
    // installed copy's folder names their version. A stored manifest always wins, and an unusable stored version is dropped.
    const version = isRecord(entry?.manifest) ? safeExtensionVersion(entry.manifest.version) : copies.version;
    // A delayed install (an update waiting for the extension to become idle) keeps the new manifest under `idle_install_info`.
    const pendingVersion = safeExtensionVersion(entry?.idle_install_info?.manifest?.version);
    const newest = await newestModification(fileSystem, [join(path, 'Preferences'), join(path, 'Secure Preferences')]);
    const settings = classifyExtensionSettings(entry);
    const lastUsed = newest === undefined ? {} : { lastUsedDaysAgo: daysAgo(newest, nowMs) };
    facts.profiles.push({
        profile: name,
        ...settings,
        ...(version === undefined ? {} : { version }),
        ...(pendingVersion === undefined ? {} : { pendingVersion }),
        ...lastUsed,
    });
    profilePaths?.push({ browser: facts.browser, path, state: settings.state, ...lastUsed, ...(newest === undefined ? {} : { lastUsedAtMs: newest }),
        lastFocused: focused, ...(open === undefined ? {} : { open }) });
};

// Whether the browser runs, from the process singleton Chromium keeps in its user-data folder, with plain reads and no
// new process. Windows: a `lockfile` held open delete-on-close, so it exists only while the browser runs, even after a
// crash, and its modification time is the start; a power loss leaves it behind, so one written before the system booted
// (`bootMs`) is no running browser. Elsewhere: a `SingletonLock` symlink to `<hostname>-<pid>` that a crash leaves
// behind. One made before the system booted is no running browser, whatever process has its pid now; otherwise the
// process is checked with signal 0 (EPERM: it exists), whatever the host name, which macOS changes with the network:
// Chromium itself takes another host's lock as live while its pid runs (process_singleton_posix.cc); accepted residual
// "Another computer's browser lock in a shared home folder". `running` is null when it cannot be told.
const runningState = async ({ fileSystem, platform, path, kill, bootMs }) => {
    try {
        if (platform === 'win32') {
            const { mtimeMs } = await fileSystem.stat(win32.join(path, 'lockfile'));
            return mtimeMs < bootMs ? { running: false } : { running: true, runningSince: new Date(mtimeMs).toISOString() };
        }
        const lock = posix.join(path, 'SingletonLock');
        const owner = /^(.*)-(\d+)$/.exec(await fileSystem.readlink(lock));
        const pid = Number(owner?.[2]);
        if (!owner || !Number.isSafeInteger(pid) || pid < 1) return { running: null };
        const { mtimeMs } = await fileSystem.lstat(lock);
        if (mtimeMs < bootMs) return { running: false };
        try {
            kill(pid, 0);
        } catch (error) {
            if (error?.code !== 'EPERM') return { running: false };
        }
        return { running: true, runningSince: new Date(mtimeMs).toISOString() };
    } catch (error) {
        return { running: error?.code === 'ENOENT' ? false : null };
    }
};

const probeBrowser = async (fileSystem, join, target, extensionId, nowMs, profilePaths) => {
    const facts = { browser: target.browser, profileSource: 'local_state', readFailures: 0, profiles: [], failureCause: undefined };
    const local = await readJson(fileSystem, join(target.path, 'Local State'));
    // Chromium's `profile.last_used` names the profile whose window was focused last, and `profile.last_active_profiles`
    // the profiles with an open window; both followed the windows on Chrome 156 (stand, 2026-10-27).
    const lastUsed = local.ok ? local.value?.profile?.last_used : undefined;
    const lastActive = local.ok && Array.isArray(local.value?.profile?.last_active_profiles) ? local.value.profile.last_active_profiles : undefined;
    const windowsOf = (name) => ({ focused: typeof lastUsed === 'string' && name === lastUsed, open: lastActive?.includes(name) });
    let names = [];
    if (local.ok && isRecord(local.value?.profile?.info_cache)) names = Object.keys(local.value.profile.info_cache);
    else {
        facts.profileSource = 'default_only';
        names = ['Default'];
        if (!local.ok && !local.absent) recordFailure(facts, local.cause);
    }
    if (target.browser === 'opera') {
        const rootExt = await directory(fileSystem, join(target.path, 'Extensions'));
        if (rootExt.cause) recordFailure(facts, rootExt.cause);
    }
    for (const name of names) {
        // Past the cap the rest stay unseen: accepted residual "Device projection caps are a measured margin".
        if (facts.profiles.length >= EXTENSION_INSTALL_VOCABULARY.maxProfiles) break;
        if (!plainSegment(name)) { recordFailure(facts, 'io_error'); continue; }
        const path = join(target.path, name);
        const result = await directory(fileSystem, path);
        if (result.cause) { recordFailure(facts, result.cause); continue; }
        if (result.exists) {
            // A directory the browser did not name by its own scheme is judged like any other, and reported as `other`
            // only if it holds the extension: its name may identify its owner and never reaches a report.
            await probeProfile(fileSystem, join, path, EXTENSION_INSTALL_VOCABULARY.profile.test(name) ? name : 'other', extensionId, facts, nowMs, profilePaths,
                windowsOf(name));
        } else if (target.browser === 'opera') {
            // Opera keeps its one profile in the root folder, whatever `Local State` calls it.
            await probeProfile(fileSystem, join, target.path, 'Default', extensionId, facts, nowMs, profilePaths, windowsOf(name));
            break;
        }
    }
    const { failureCause: cause, ...publicFacts } = facts;
    return { facts: publicFacts, cause };
};

// `profilePaths`, when given, receives `{ browser, path, state, lastUsedDaysAgo?, lastUsedAtMs?, lastFocused, open? }` for
// every listed profile: the extension log reader's input, kept out of the facts.
export const probeBrowserExtensionInstall = async (/** @type {any} */ { observedAt, now = Date.now, platform = process.platform, env = process.env,
    home = homedir(), fileSystem = fs, extensionId = EXTENSION_ID, kill = (pid, signal) => process.kill(pid, signal), uptime = osUptime,
    profilePaths } = {}) => {
    const base = { check: 'extension_install', observedAt: observedAt ?? new Date(now()).toISOString(), source: 'browser_profile_metadata', executionPlane: 'device' };
    const join = platform === 'win32' ? win32.join : posix.join;
    // Accepted residual "A clock stepped forward after boot hides a running browser": docs/local-agent-architecture.md#accepted-residuals.
    const bootMs = now() - uptime() * 1000;
    const browsers = [];
    let cause;
    for (const target of browserUserDataDirectories({ platform, env, home })) {
        const root = await directory(fileSystem, target.path);
        if (root.cause) { cause ??= root.cause; continue; }
        if (!root.exists) continue;
        const result = await probeBrowser(fileSystem, join, target, extensionId, now(), profilePaths);
        cause ??= result.cause;
        browsers.push({ ...result.facts, ...(await runningState({ fileSystem, platform, path: target.path, kill, bootMs })) });
    }
    const facts = { extensionId, browsers };
    if (!validateSchemaValue(facts, extensionInstallFactsSchema)) return diagnosticCheck({ ...base, state: 'unknown', cause: 'unknown' });
    if (cause) return diagnosticCheck({ ...base, state: 'unknown', cause, facts });
    if (browsers.length === 0) return diagnosticCheck({ ...base, state: 'not_checked', cause: 'directory_absent', facts });
    return diagnosticCheck({ ...base, state: 'passed', facts });
};
