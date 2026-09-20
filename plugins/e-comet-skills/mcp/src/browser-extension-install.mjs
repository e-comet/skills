import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { diagnosticCheck } from './diagnostic-facts.mjs';
import { safeExtensionVersion } from './tool-errors.mjs';
import { extensionInstallFactsSchema, validateSchemaValue } from './tool-schemas.mjs';

export const EXTENSION_ID = 'apeallgchpgibifmbgefkhifidihmodh';

// Chrome roots: Chromium docs/user_data_dir.md. Other vendor roots follow the observed layouts in spec §4.2.
export const browserUserDataDirectories = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
        const roaming = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
        return [
            { browser: 'chrome', path: win32.join(local, 'Google', 'Chrome', 'User Data') },
            { browser: 'edge', path: win32.join(local, 'Microsoft', 'Edge', 'User Data') },
            { browser: 'yandex', path: win32.join(local, 'Yandex', 'YandexBrowser', 'User Data') },
            { browser: 'opera', path: win32.join(roaming, 'Opera Software', 'Opera Stable') },
        ];
    }
    if (platform === 'darwin') {
        const support = posix.join(home, 'Library', 'Application Support');
        return [
            { browser: 'chrome', path: posix.join(support, 'Google', 'Chrome') },
            { browser: 'edge', path: posix.join(support, 'Microsoft Edge') },
            { browser: 'yandex', path: posix.join(support, 'Yandex', 'YandexBrowser') },
            { browser: 'opera', path: posix.join(support, 'com.operasoftware.Opera') },
        ];
    }
    const config = env.XDG_CONFIG_HOME || posix.join(home, '.config');
    return [
        { browser: 'chrome', path: posix.join(config, 'google-chrome') },
        { browser: 'edge', path: posix.join(config, 'microsoft-edge') },
        { browser: 'yandex', path: posix.join(config, 'yandex-browser') },
        { browser: 'opera', path: posix.join(config, 'opera') },
    ];
};

export const classifyExtensionSettings = (entry) => {
    if (!isRecord(entry)) return 'unknown';
    const reasons = entry.disable_reasons;
    if (Array.isArray(reasons)) {
        if (reasons.length === 0) return 'enabled';
        return reasons.every(Number.isInteger) ? 'disabled' : 'unknown';
    }
    return reasons === undefined && entry.state === 1 ? 'enabled' : 'unknown';
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const failureCause = (error) => ['EACCES', 'EPERM'].includes(error?.code) ? 'permission_denied' : 'io_error';
const recordFailure = (facts, cause) => { facts.readFailures += 1; facts.failureCause ??= cause; };
const readJson = async (fileSystem, path) => {
    try { return { ok: true, value: JSON.parse(await fileSystem.readFile(path, 'utf8')) }; }
    catch (error) { return { ok: false, absent: error?.code === 'ENOENT', cause: failureCause(error) }; }
};
const directory = async (fileSystem, path) => {
    try { return { exists: (await fileSystem.stat(path)).isDirectory() }; }
    catch (error) { return error?.code === 'ENOENT' ? { exists: false } : { exists: false, cause: failureCause(error) }; }
};
const safeProfileName = (name) => name.length > 0 && name !== '.' && name !== '..' && !/[\\/\u0000:]/u.test(name);

const probeProfile = async (fileSystem, join, path, extensionId, facts) => {
    const root = join(path, 'Extensions', extensionId);
    const ext = await directory(fileSystem, root);
    if (ext.cause) { recordFailure(facts, ext.cause); return; }
    if (!ext.exists) return;
    let names;
    try { names = await fileSystem.readdir(root); }
    catch (error) { recordFailure(facts, failureCause(error)); return; }
    let installed = false;
    for (const name of names) {
        if (!/^[^/\\]+_[0-9]+$/.test(name)) continue;
        const candidate = await directory(fileSystem, join(root, name));
        if (candidate.cause) { recordFailure(facts, candidate.cause); continue; }
        if (!candidate.exists) continue;
        const manifest = await readJson(fileSystem, join(root, name, 'manifest.json'));
        if (!manifest.ok) { if (!manifest.absent) recordFailure(facts, manifest.cause); continue; }
        if (!isRecord(manifest.value)) { recordFailure(facts, 'io_error'); continue; }
        installed = true;
        const version = safeExtensionVersion(manifest.value.version);
        if (version) facts.versions.add(version);
    }
    if (!installed) return;
    facts.installedProfiles += 1;
    let settings = await readJson(fileSystem, join(path, 'Secure Preferences'));
    if (!settings.ok && settings.absent) settings = await readJson(fileSystem, join(path, 'Preferences'));
    if (!settings.ok) {
        if (!settings.absent) recordFailure(facts, settings.cause);
        facts.unknownProfiles += 1;
        return;
    }
    if (!isRecord(settings.value)) { facts.unknownProfiles += 1; return; }
    const classification = classifyExtensionSettings(settings.value.extensions?.settings?.[extensionId]);
    if (classification === 'enabled') facts.enabledProfiles += 1;
    else if (classification === 'unknown') facts.unknownProfiles += 1;
};

// Chromium rewrites `Local State` and each profile's preference files while the browser runs, so the
// newest successfully observed modification time is a recency hint for those metadata files. The
// files are stat'ed, never read, and the result is a whole number of days, never a timestamp.
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

const probeBrowser = async (fileSystem, join, target, extensionId, nowMs) => {
    const facts = { browser: target.browser, profileSource: 'local_state', profilesChecked: 0, installedProfiles: 0, enabledProfiles: 0, unknownProfiles: 0, readFailures: 0, versions: new Set(), failureCause: undefined };
    const activityFiles = [join(target.path, 'Local State')];
    const local = await readJson(fileSystem, join(target.path, 'Local State'));
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
        if (!safeProfileName(name)) { recordFailure(facts, 'io_error'); continue; }
        const path = join(target.path, name);
        const result = await directory(fileSystem, path);
        if (result.cause) { recordFailure(facts, result.cause); continue; }
        if (result.exists) {
            facts.profilesChecked += 1;
            activityFiles.push(join(path, 'Preferences'), join(path, 'Secure Preferences'));
            await probeProfile(fileSystem, join, path, extensionId, facts);
        } else if (target.browser === 'opera') {
            facts.profilesChecked += 1;
            activityFiles.push(join(target.path, 'Preferences'), join(target.path, 'Secure Preferences'));
            await probeProfile(fileSystem, join, target.path, extensionId, facts);
            break;
        }
    }
    const newest = await newestModification(fileSystem, activityFiles);
    const { failureCause: cause, versions, ...publicFacts } = facts;
    return { facts: { ...publicFacts, versions: [...versions].sort(), ...(newest === undefined ? {} : { lastUsedDaysAgo: daysAgo(newest, nowMs) }) }, cause };
};

export const probeBrowserExtensionInstall = async (/** @type {any} */ { observedAt, now = Date.now, platform = process.platform, env = process.env,
    home = homedir(), fileSystem = fs, extensionId = EXTENSION_ID } = {}) => {
    const base = { check: 'extension_install', observedAt: observedAt ?? new Date(now()).toISOString(), source: 'browser_profile_metadata', executionPlane: 'device' };
    const join = platform === 'win32' ? win32.join : posix.join;
    const browsers = [];
    let cause;
    for (const target of browserUserDataDirectories({ platform, env, home })) {
        const root = await directory(fileSystem, target.path);
        if (root.cause) { cause ??= root.cause; continue; }
        if (!root.exists) continue;
        const result = await probeBrowser(fileSystem, join, target, extensionId, now());
        cause ??= result.cause;
        browsers.push(result.facts);
    }
    const facts = { extensionId, browsers };
    if (!validateSchemaValue(facts, extensionInstallFactsSchema)) return diagnosticCheck({ ...base, state: 'unknown', cause: 'unknown' });
    if (cause) return diagnosticCheck({ ...base, state: 'unknown', cause, facts });
    if (browsers.length === 0) return diagnosticCheck({ ...base, state: 'not_checked', cause: 'directory_absent', facts });
    return diagnosticCheck({ ...base, state: 'passed', facts });
};
