// Registers the native messaging broker for the browsers (spec §5.3). Every local MCP process runs it after its MCP
// handshake: it protects the per-user state directory, stages a versioned copy of the broker files there, writes a
// launcher and a host manifest, and points the browsers at the manifest. It also reads the policies that can forbid
// user-level hosts or block our host, so those cases are named instead of being reported as "no browser".
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { delimiter, dirname, join, posix, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { EXTENSION_ORIGIN, NATIVE_HOST_NAME } from './native-framing.mjs';
import { resolveAccountHome } from './state-paths.mjs';

const DEVELOPMENT_VERSION = '0.0.0-development';
const BROKER_FILES = ['broker.mjs', 'native-framing.mjs'];
const STAMP_FILE = 'broker.json';
const MIN_NODE_MAJOR = 22;
// Antivirus scanners hold freshly written files for a moment on Windows.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MS = 100;
const RENAME_RETRY_LIMIT_MS = 3000;
// A directory staged this recently may be one another process is about to register.
const PRUNE_MIN_AGE_MS = 60_000;
// A staging directory lives for milliseconds; one this old was left by a process killed while staging.
const STAGING_ORPHAN_AGE_MS = 60 * 60_000;
// Accepted residual "Opera's native messaging registration is unverified": docs/local-agent-architecture.md#accepted-residuals.
// Accepted residual "macOS not tested live": docs/local-agent-architecture.md#accepted-residuals.
const MACOS_BROWSER_FOLDERS = [
    'Google/Chrome', 'Chromium', 'Microsoft Edge', 'Yandex/YandexBrowser', 'BraveSoftware/Brave-Browser', 'com.operasoftware.Opera',
];
// Each browser's user data folder under the XDG configuration directory; its per-user hosts are read from inside it.
// Accepted residual "Snap and Flatpak browsers on Linux cannot start the broker": docs/local-agent-architecture.md#accepted-residuals.
const LINUX_BROWSER_FOLDERS = [
    'google-chrome', 'chromium', 'microsoft-edge', 'yandex-browser', 'BraveSoftware/Brave-Browser', 'opera', 'vivaldi',
];
// `linux` is the folder of managed JSON policies; Yandex Browser and Opera document none there, so they stay unobserved.
const POLICY_BROWSERS = [
    { browser: 'chrome', vendor: 'Google\\Chrome', bundle: 'com.google.Chrome', linux: '/etc/opt/chrome/policies/managed' },
    { browser: 'edge', vendor: 'Microsoft\\Edge', bundle: 'com.microsoft.Edge', linux: '/etc/opt/edge/policies/managed' },
    { browser: 'brave', vendor: 'BraveSoftware\\Brave', bundle: 'com.brave.Browser', linux: '/etc/brave/policies/managed' },
    { browser: 'yandex', vendor: 'YandexBrowser', bundle: 'ru.yandex.desktop.yandex-browser', linux: null },
    // Opera has no documented policy key on Windows.
    { browser: 'opera', vendor: null, bundle: 'com.operasoftware.Opera', linux: null },
];

const execFileAsync = promisify(execFile);
/** The `run` registration expects: asynchronous, hidden, killed after 5 s unless the caller grants more. */
export const runBounded = (file, args, { timeout = 5000, env = undefined } = {}) => execFileAsync(file, args, { timeout, windowsHide: true, ...(env ? { env } : {}) });
// A cold Windows PowerShell can take over ten seconds to start on a loaded machine; the bound only stops a hang.
const REGISTRY_WRITE_TIMEOUT_MS = 60_000;

const isText = (value) => typeof value === 'string' && value.length > 0;
const randomHex = () => randomBytes(8).toString('hex');
// Full paths: Windows searches the working directory, which a host may set to a project folder, before PATH.
const system32 = (env, name) => win32.join(env.SystemRoot || 'C:\\Windows', 'System32', name);
// PowerShell also ends a single-quoted string at the typographic quotes U+2018–U+201B, as in a profile named В’ячеслав.
const psLiteral = (value) => `'${value.replace(/['\u2018-\u201B]/g, (quote) => quote + quote)}'`;

// A packaged host's child can inherit its private registry view without carrying package identity. StdRegProv writes
// the current user's physical hive; reading it back through that same provider verifies what the browser can see.
// Replies go through Write-Output: a script policy (App Control, AppLocker) runs this in ConstrainedLanguage, which
// refuses [Console] calls after the key is already written. Accepted residual: "Registry provider unreachable".
// The key is read before it is written, and the reply says how it was found (OK_SAME, OK_DIFFERENT, OK_MISSING): a
// key that was missing or different means the browser could not have found the registration until now. A read that
// fails counts as missing.
const writeWindowsRegistration = async ({ env, run, key, manifestPath }) => {
    const script = [
        "$ErrorActionPreference='Stop'; $stage='CONNECT'; try {",
        "$provider=[wmiclass]'\\\\.\\root\\default:StdRegProv';",
        `$key=${psLiteral(key.slice('HKCU\\'.length))}; $value=${psLiteral(manifestPath)};`,
        "$stage='READ'; $before=$provider.GetStringValue([uint32]2147483649,$key,'');",
        "$previous=if ($before.ReturnValue -ne 0) { 'MISSING' } elseif ($before.sValue -ceq $value) { 'SAME' } else { 'DIFFERENT' };",
        "$stage='CREATE'; $created=$provider.CreateKey([uint32]2147483649,$key);",
        'if ($created.ReturnValue -ne 0) { Write-Output "WMI_CREATE_$($created.ReturnValue)"; return };',
        "$stage='WRITE'; $written=$provider.SetStringValue([uint32]2147483649,$key,'',$value);",
        'if ($written.ReturnValue -ne 0) { Write-Output "WMI_WRITE_$($written.ReturnValue)"; return };',
        "$stage='READ'; $read=$provider.GetStringValue([uint32]2147483649,$key,'');",
        'if ($read.ReturnValue -ne 0) { Write-Output "WMI_READ_$($read.ReturnValue)"; return };',
        "if ($read.sValue -cne $value) { Write-Output 'WMI_VERIFY_MISMATCH'; return };",
        'Write-Output "OK_$previous"',
        // PowerShell wraps the provider's failure, and every wrapper reports 80131501: the innermost exception's ErrorCode
        // (a ManagementException's WMI status) or HResult is the cause. Property reads only, because ConstrainedLanguage
        // refuses method calls such as GetBaseException(). Unsigned hex, as HRESULTs are read; a negative decimal's
        // hyphen is not an identifier a bug report keeps.
        "} catch { $e=$_.Exception; while ($e.InnerException) { $e=$e.InnerException };",
        "$n=if ($null -ne $e.ErrorCode) { [int]$e.ErrorCode } else { $e.HResult };",
        "Write-Output \"WMI_$($stage)_HRESULT_$('{0:X8}' -f $n)\" }",
    ].join(' ');
    const { stdout } = await run(system32(env, 'WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: REGISTRY_WRITE_TIMEOUT_MS });
    const reply = stdout.replace(/^\uFEFF/, '').trim();
    const found = /^OK_(SAME|DIFFERENT|MISSING)$/.exec(reply);
    if (!found) {
        const code = /^(?:WMI_(?:CONNECT|CREATE|WRITE|READ)_(?:\d+|HRESULT_[0-9A-F]{8})|WMI_VERIFY_MISMATCH)$/.test(reply)
            ? reply : 'REGISTRY_PROVIDER_INVALID_REPLY';
        throw Object.assign(new Error('Native host registration was not verified'), { code });
    }
    return { previous: /** @type {'same' | 'different' | 'missing'} */ (found[1].toLowerCase()) };
};
// Anything but a clear "not there" counts as present, so a guarded folder is attempted and reported, not skipped.
const exists = (fs, path) => fs.stat(path).then(() => true, (error) => !['ENOENT', 'ENOTDIR'].includes(error?.code));
// Name and code only: a message can carry a path. `name` is the registration step, which is what support needs.
const failure = (name, error) => {
    const code = error?.code;
    return { name, code: typeof code === 'string' ? code : Number.isInteger(code) ? `EXIT_${code}` : error?.killed ? 'TIMEOUT' : null };
};

const injectionHonoured = (env) => env.NODE_ENV === 'test' || env.NODE_ENV === 'development';
const injected = (env, name) => (injectionHonoured(env) && typeof env[name] === 'string' && env[name].trim() ? env[name].trim() : null);

/** Numeric dotted comparison of stamped versions; anything else, `0.0.0-development` included, compares as 0.0.0. */
export function compareBrokerVersions(a, b) {
    const parts = (version) => (typeof version === 'string' && /^\d+(?:\.\d+)*$/.test(version) ? version.split('.').map(Number) : [0]);
    const left = parts(a);
    const right = parts(b);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
}

export const resolveNativeHostName = ({ env }) => injected(env, 'ECOMET_TEST_NATIVE_HOST_NAME') ?? NATIVE_HOST_NAME;

/**
 * Where the browsers are pointed at the manifest: `{ injected, key }` on Windows, `{ injected, manifestDirs }` elsewhere,
 * or null when nothing may be registered. A target and the state directory are injected together or not at all: the
 * Windows manifest lives in the state directory, so an injected key alone would rewrite the file the real Chrome key
 * names, and an injected state directory alone would point the real key into a test directory. Under test only an
 * injected pair is ever written.
 */
export const resolveRegistrationTarget = ({ env, platform, hostName, home }) => {
    const stateDir = injected(env, 'ECOMET_TEST_STATE_DIR');
    const key = injected(env, 'ECOMET_TEST_REGISTRY_KEY');
    const dirs = injected(env, 'ECOMET_TEST_MANIFEST_DIRS');
    if (stateDir && platform === 'win32' && key) return { injected: true, key: `HKCU\\Software\\${key}` };
    if (stateDir && platform !== 'win32' && dirs) return { injected: true, manifestDirs: dirs.split(delimiter).filter(Boolean) };
    if (env.NODE_ENV === 'test' || stateDir || key || dirs) return null;
    if (platform === 'win32') return { injected: false, key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}` };
    if (platform === 'darwin') {
        return {
            injected: false,
            manifestDirs: MACOS_BROWSER_FOLDERS.map((folder) => posix.join(home, 'Library', 'Application Support', folder, 'NativeMessagingHosts')),
        };
    }
    if (platform !== 'linux') return null;
    const config = env.XDG_CONFIG_HOME || posix.join(home, '.config');
    return { injected: false, manifestDirs: LINUX_BROWSER_FOLDERS.map((folder) => posix.join(config, folder, 'NativeMessagingHosts')) };
};

// Accepted residual "A DeepSeek-only seller without Node": docs/local-agent-architecture.md#accepted-residuals.
/**
 * `node` from PATH, in order and without resolving links, so a version manager's upgrade does not remove it; it must
 * answer `node -v` with 22 or newer. Otherwise the registering process's own executable, which needs
 * ELECTRON_RUN_AS_NODE unless it is Node itself (DeepSeek's).
 */
export async function resolveBrokerRuntime({ env, platform, execPath, exists: present, runNodeVersion }) {
    const path = platform === 'win32' ? win32 : posix;
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
    for (const entry of (pathKey ? env[pathKey] : '').split(platform === 'win32' ? ';' : ':')) {
        const directory = entry.trim().replace(/^"(.*)"$/, '$1');
        if (!path.isAbsolute(directory)) continue;
        const candidate = path.join(directory, platform === 'win32' ? 'node.exe' : 'node');
        if (!(await present(candidate))) continue;
        try {
            const major = Number(/^v(\d+)\./.exec(String(await runNodeVersion(candidate)).trim())?.[1]);
            if (major >= MIN_NODE_MAJOR) return { path: candidate, electronRunAsNode: false, source: 'path_node' };
        } catch {
            // A Node that does not answer is skipped like an old one.
        }
    }
    if (!isText(execPath) || !(await present(execPath))) return null;
    return { path: execPath, electronRunAsNode: !/^node(?:\.exe)?$/i.test(path.basename(execPath)), source: 'host_executable' };
}

// UTF-8 without a BOM (a BOM breaks `@echo off`), CRLF. `@echo off` keeps stdout clean for the first frame, chcp 65001
// lets a Cyrillic runtime path work, and %~dp0 is the launcher's own directory.
export function renderWindowsLauncher({ runtimePath, electronRunAsNode }) {
    return [
        '@echo off',
        '%SystemRoot%\\System32\\chcp.com 65001 >nul',
        ...(electronRunAsNode ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
        `"${runtimePath.replaceAll('%', '%%')}" "%~dp0broker.mjs" %*`,
        '',
    ].join('\r\n');
}

export function renderPosixLauncher({ runtimePath, electronRunAsNode }) {
    return [
        '#!/bin/sh',
        ...(electronRunAsNode ? ['export ELECTRON_RUN_AS_NODE=1'] : []),
        `exec '${runtimePath.replaceAll("'", "'\\''")}' "$(dirname "$0")/broker.mjs" "$@"`,
        '',
    ].join('\n');
}

export function renderHostManifest({ hostName, launcherPath, allowedOrigin }) {
    return JSON.stringify({ name: hostName, description: 'e-Comet local agent bridge', path: launcherPath, type: 'stdio', allowed_origins: [allowedOrigin] }, null, 2);
}

// The runtime a launcher records, read back from the two shapes rendered above.
const launcherRuntime = (text) => {
    const windows = /^"(.*)" "%~dp0broker\.mjs" %\*\r?$/m.exec(text);
    if (windows) return windows[1].replaceAll('%%', '%');
    const shell = /^exec '(.*)' "\$\(dirname "\$0"\)\/broker\.mjs" "\$@"$/m.exec(text);
    return shell ? shell[1].replaceAll("'\\''", "'") : null;
};

/**
 * Whether the runtime a launcher records still runs as Node 22 or newer: `-v`, started the way the launcher starts it
 * (with ELECTRON_RUN_AS_NODE when it sets it), through the bounded `run`. Only a repair asks, so an ordinary start and a
 * healthy tool call start no extra process. `env` is the environment the variable is added to.
 * True when it answers v22 or newer; false when it is missing (ENOENT) or answers an older version; null when the answer
 * proves nothing: the launcher is shared, so it may name another host's packaged executable this process may not start
 * (EACCES, EPERM), and a timeout, an exit code or an answer that is no version say nothing about the browser's start.
 * @returns {Promise<boolean | null>}
 */
export async function runtimeRuns({ run, launcherText, platform, env = process.env }) {
    const runtime = launcherRuntime(launcherText);
    if (runtime === null) return false;
    const electron = new RegExp(`^${platform === 'win32' ? 'set "ELECTRON_RUN_AS_NODE=1"' : 'export ELECTRON_RUN_AS_NODE=1'}\\r?$`, 'm').test(launcherText);
    let stdout;
    try {
        ({ stdout } = await (electron ? run(runtime, ['-v'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }) : run(runtime, ['-v'])));
    } catch (error) {
        return error?.code === 'ENOENT' ? false : null;
    }
    const major = Number(/^v(\d+)\./.exec(String(stdout).trim())?.[1]);
    return Number.isInteger(major) ? major >= MIN_NODE_MAJOR : null;
}

const renameWithRetry = async (fs, from, to, settled = async () => false) => {
    const deadline = Date.now() + RENAME_RETRY_LIMIT_MS;
    for (;;) {
        try {
            await fs.rename(from, to);
            return;
        } catch (error) {
            if (await settled()) return;
            if (!RENAME_RETRY_CODES.has(error?.code) || Date.now() >= deadline) throw error;
            await delay(RENAME_RETRY_MS);
        }
    }
};

// Written next to its target and renamed, never in os.tmpdir(): a rename keeps the source's permissions, and the
// shared temporary folder grants other accounts write access to code the browser later runs as the user.
const writeAtomically = async (fs, path, content, mode) => {
    const temporary = `${path}.${randomHex()}.tmp`;
    try {
        await fs.writeFile(temporary, content);
        if (mode !== undefined) await fs.chmod(temporary, mode);
        await renameWithRetry(fs, temporary, path);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
};

/**
 * Makes the state directory owner-only before anything secret lands in it: on Windows one icacls call replaces the
 * inherited ACEs with inheritable grants for the user and SYSTEM, so files already inside, such as the hook secret,
 * keep access; elsewhere mode 0700. Only icacls's exit code is checked.
 */
export async function protectStateDirectory({ dir, platform, run, fs, env }) {
    try {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        if (platform !== 'win32') {
            await fs.chmod(dir, 0o700);
            return { ok: true };
        }
        const { stdout } = await run(system32(env, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
        const sid = /"(S-1-[\d-]+)"/.exec(stdout)?.[1];
        if (!sid) return { ok: false, error: { name: 'StateDirectoryProtection', code: 'SID_UNREADABLE' } };
        await run(system32(env, 'icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: failure('StateDirectoryProtection', error) };
    }
}

// Stages `bridge/<dir>` as a whole through `bridge/.tmp-<hex>`. A version already in place is kept, except that under
// NODE_ENV=development a working tree whose broker files changed, or a copy missing files, is rewritten in place.
// Returns whether files were rewritten in place, or null when this process's own broker files are gone.
const stageVersion = async ({ fs, srcDir, bridgeDir, ownDir, stamp, compareSources }) => {
    let sources;
    try {
        sources = await Promise.all(BROKER_FILES.map(async (name) => /** @type {const} */ ([name, await fs.readFile(join(srcDir, name))])));
    } catch (error) {
        // Codex deletes an older plugin version in place on update while this process keeps running from it.
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    const files = new Map([...sources, [STAMP_FILE, Buffer.from(JSON.stringify(stamp))]]);
    const staged = await Promise.all([...files.keys()].map((name) => fs.readFile(join(ownDir, name)).catch(() => null)));
    if (staged.every(Boolean)) {
        if (!compareSources || BROKER_FILES.every((name, index) => staged[index].equals(files.get(name)))) return false;
    } else if (!(await exists(fs, ownDir))) {
        const temporary = join(bridgeDir, `.tmp-${randomHex()}`);
        try {
            await fs.mkdir(temporary, { recursive: true });
            for (const [name, content] of files) await fs.writeFile(join(temporary, name), content);
            // Another process staging the same version may win: its directory is as good as ours.
            await renameWithRetry(fs, temporary, ownDir, () => exists(fs, ownDir));
        } finally {
            await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        }
        return false;
    }
    for (const [name, content] of files) await writeAtomically(fs, join(ownDir, name), content);
    return true;
};

// The registration a manifest names: its version directory (only one inside our own bridge directory) and that
// directory's stamp, which carries the version compared, never the directory name.
const readStamp = async (fs, dir) => {
    try {
        const stamp = JSON.parse(await fs.readFile(join(dir, STAMP_FILE), 'utf8'));
        return isText(stamp?.version) && isText(stamp.allowedOrigin) ? stamp : null;
    } catch {
        return null;
    }
};

const readRegistered = async (fs, bridgeDir, manifestPath) => {
    try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const dir = dirname(manifest.path);
        if (dirname(dir) !== bridgeDir) return null;
        const stamp = await readStamp(fs, dir);
        return stamp && { dir, stamp, origins: manifest.allowed_origins };
    } catch {
        return null;
    }
};

// Prunes an old version directory only when it is older than the registered version, so a newer one another process
// has just staged survives, is not this process's own, and was last modified over a minute ago. A staging directory
// is pruned once it is an hour old. A directory a running broker holds on Windows refuses removal; the next
// registration tries again.
// Accepted residual "An older plugin re-stages a pruned version directory": docs/local-agent-architecture.md#accepted-residuals.
const prune = async ({ fs, bridgeDir, keep, registeredVersion, now }) => {
    const names = await fs.readdir(bridgeDir).catch(() => []);
    for (const name of names) {
        const directory = join(bridgeDir, name);
        const staging = name.startsWith('.tmp-');
        if (keep.includes(directory)) continue;
        try {
            const info = await fs.stat(directory);
            if (!info.isDirectory() || now() - info.mtimeMs <= (staging ? STAGING_ORPHAN_AGE_MS : PRUNE_MIN_AGE_MS)) continue;
            // A directory whose stamp an interrupted removal already took counts as the lowest version.
            if (!staging && compareBrokerVersions((await readStamp(fs, directory))?.version, registeredVersion) >= 0) continue;
            await fs.rm(directory, { recursive: true, force: true });
        } catch {
            // In use, already gone or unreadable.
        }
    }
};

// Accepted residual "Removing the plugin leaves the broker registered": docs/local-agent-architecture.md#accepted-residuals.
/**
 * Makes sure the browsers can start the broker. Idempotent and safe to run from several processes at once.
 * deps = { platform, env, stateDir, srcDir, hostName, allowedOrigin, version, execPath, home?, now, fs, run, log }
 * `verifiedSinceMs` is since when the registration the browser reads has stayed unchanged: the newest of the manifest
 * and launcher modification times and, on Windows, the time the key was last found missing or different. A repair also
 * checks that the launcher's runtime still runs (`runtimeRecheck`) and re-points a launcher whose runtime is proven gone
 * or too old to another runtime: `repaired`; `failed` when no other runtime exists, `inconclusive` when the check proves
 * nothing, and the launcher is left as it is in both.
 * @returns {Promise<{ state: 'registered' | 'current' | 'disabled' | 'failed' | 'denied', version: string,
 *   runtime: 'path_node' | 'host_executable' | null, manifestWrittenAtMs: number | null, verifiedSinceMs: number | null,
 *   runtimeRecheck: 'not_run' | 'passed' | 'repaired' | 'failed' | 'inconclusive', error: { name: string, code: string | null } | null }>}
 */
export async function ensureRegistration(deps) {
    const { platform, env, stateDir, srcDir, hostName, allowedOrigin, version, execPath, now, fs, run, log } = deps;
    const result = (state, fields = {}) => ({ state, version, runtime: null, manifestWrittenAtMs: null, verifiedSinceMs: null,
        runtimeRecheck: /** @type {'not_run' | 'passed' | 'repaired' | 'failed' | 'inconclusive'} */ ('not_run'), error: null, ...fields });
    const target = resolveRegistrationTarget({ env, platform, hostName, home: deps.home ?? resolveAccountHome() });
    if (!target) return result('disabled');
    let step = 'Staging';
    try {
        // Applied at every registration. A failure is logged and registration goes on: the next run applies it again,
        // and stopping here would leave the seller without a broker.
        const protection = await protectStateDirectory({ dir: stateDir, platform, run, fs, env });
        if (!protection.ok) log(`e-comet registration: state directory protection not applied (${protection.error.code ?? 'unknown'})`);

        const development = version === DEVELOPMENT_VERSION || target.injected || hostName !== NATIVE_HOST_NAME || allowedOrigin !== EXTENSION_ORIGIN;
        const bridgeDir = join(stateDir, 'bridge');
        const ownDir = join(bridgeDir, development
            ? `${version}-dev-${createHash('sha256').update(allowedOrigin + hostName).digest('hex').slice(0, 8)}`
            : version);
        const stamp = { version, allowedOrigin, ...(development ? { development: true } : {}) };
        const staged = await stageVersion({ fs, srcDir, bridgeDir, ownDir, stamp, compareSources: env.NODE_ENV === 'development' });
        const refreshed = staged === true;

        // Resolved before the registration is read, so the `node -v` calls do not widen the window in which a newer
        // process can register between this read and the manifest write below. What remains of that race is healed by
        // the newer version's next ensure or repair.
        // Accepted residual "Two plugin versions registering at once": docs/local-agent-architecture.md#accepted-residuals.
        const runtime = await resolveBrokerRuntime({
            env,
            platform,
            execPath,
            exists: (path) => exists(fs, path),
            runNodeVersion: async (path) => (await run(path, ['-v'])).stdout,
        });

        step = 'RegistrationRead';
        const manifestPaths = [];
        if (target.key) manifestPaths.push(join(bridgeDir, `${hostName}.json`));
        // A real browser gets a manifest only when its user-data folder exists; an injected folder always does.
        else for (const folder of target.manifestDirs) {
            if (target.injected || (await exists(fs, dirname(folder)))) manifestPaths.push(join(folder, `${hostName}.json`));
        }
        let registered = null;
        for (const manifestPath of manifestPaths) {
            const candidate = await readRegistered(fs, bridgeDir, manifestPath);
            if (candidate && (!registered || compareBrokerVersions(candidate.stamp.version, registered.stamp.version) > 0)) registered = candidate;
        }
        // With no readable manifest, a newer staged version still wins over this process's own older one.
        if (!registered) {
            for (const name of await fs.readdir(bridgeDir).catch(() => [])) {
                const candidateDir = join(bridgeDir, name);
                const candidate = name.startsWith('.') ? null : await readStamp(fs, candidateDir);
                if (candidate && compareBrokerVersions(candidate.version, registered?.stamp.version ?? version) > 0) {
                    registered = { dir: candidateDir, stamp: candidate, origins: [candidate.allowedOrigin] };
                }
            }
        }

        // Equal versions never rewrite each other and an older process never downgrades the registration. A changed
        // working tree under NODE_ENV=development, and an injected origin the registration does not carry, take over;
        // a production run never stays on a development registration, whatever its version.
        const comparison = registered ? compareBrokerVersions(version, registered.stamp.version) : 1;
        const originTakeover = allowedOrigin !== EXTENSION_ORIGIN && JSON.stringify(registered?.origins) !== JSON.stringify([allowedOrigin]);
        const developmentTakeover = !development && registered?.stamp.development === true;
        const takeOver = comparison > 0 || (comparison === 0 && refreshed) || originTakeover || developmentTakeover;
        // Without its own files this process can keep the registration in the state directory, which needs nothing
        // from the plugin tree, but it cannot stage one of its own: answering BRIDGE_BROKER_FAILED there would hide
        // the seller's real step (open the browser) behind a failure this process alone has.
        if (staged === null && takeOver) {
            step = 'Staging';
            throw Object.assign(new Error('Broker files missing'), { code: 'ENOENT' });
        }
        const dir = takeOver ? ownDir : registered.dir;
        const dirStamp = takeOver ? stamp : registered.stamp;
        const launcherPath = join(dir, platform === 'win32' ? 'broker.cmd' : 'broker.sh');
        let wrote = false;
        const launcherText = await fs.readFile(launcherPath, 'utf8').catch(() => '');
        const recorded = launcherRuntime(launcherText);
        let rewrite = takeOver || recorded === null || !(await exists(fs, recorded));
        const renderLauncher = (/** @type {{ path: string, electronRunAsNode: boolean }} */ chosen) => (platform === 'win32'
            ? renderWindowsLauncher({ runtimePath: chosen.path, electronRunAsNode: chosen.electronRunAsNode })
            : renderPosixLauncher({ runtimePath: chosen.path, electronRunAsNode: chosen.electronRunAsNode }));
        // A runtime that is still there can be one that no longer runs (a downgraded Node): a repair asks it, unless this
        // pass has just asked the same PATH node while resolving the runtime. Only a runtime proven gone or too old is
        // replaced, and only by a launcher that differs: the launcher is shared, and a check that proves nothing (another
        // host's packaged executable, a timeout) leaves it as it is.
        /** @type {'not_run' | 'passed' | 'repaired' | 'failed' | 'inconclusive'} */
        let runtimeRecheck = 'not_run';
        if (!rewrite && deps.repair) {
            const runs = runtime?.source === 'path_node' && runtime.path === recorded ? true : await runtimeRuns({ run, launcherText, platform, env });
            rewrite = runs === false && runtime !== null && renderLauncher(runtime) !== launcherText;
            runtimeRecheck = runs === null ? 'inconclusive' : runs ? 'passed' : rewrite ? 'repaired' : 'failed';
        }
        if (rewrite) {
            step = 'LauncherWrite';
            if (!runtime) throw Object.assign(new Error('No runtime for the broker'), { code: 'RUNTIME_NOT_FOUND' });
            await writeAtomically(fs, launcherPath, renderLauncher(runtime), platform === 'win32' ? undefined : 0o755);
            wrote = true;
        }

        step = 'ManifestWrite';
        // An unchanged manifest is not rewritten: its age tells a client that a broker may be about to start.
        const manifest = renderHostManifest({ hostName, launcherPath, allowedOrigin: dirStamp.allowedOrigin });
        let denied = null;
        // Browser folders that hold the current manifest after this pass, against which a refused folder is weighed.
        let registeredFolders = 0;
        for (const manifestPath of manifestPaths) {
            if ((await fs.readFile(manifestPath, 'utf8').catch(() => null)) === manifest) {
                registeredFolders += 1;
                continue;
            }
            try {
                await fs.mkdir(dirname(manifestPath), { recursive: true });
                await writeAtomically(fs, manifestPath, manifest);
                wrote = true;
                registeredFolders += 1;
            } catch (error) {
                // A browser folder can refuse this user (macOS guards them per app with EPERM; a root-owned folder answers
                // EACCES); the other browsers can still be registered.
                if (platform === 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;
                // The first refusal is kept, except that macOS's guard, which has a user step, wins over any other.
                if (!denied || (platform === 'darwin' && error.code === 'EPERM')) denied = failure(step, error);
            }
        }
        let keyVerifiedSinceMs = null;
        if (target.key) {
            step = 'RegistryWrite';
            // The key names a manifest path that does not change, so a verified write is remembered and an ordinary start
            // starts no PowerShell. A repair, a tool call that found no broker, writes it anyway: a key removed since is
            // restored when it is needed. Accepted residual: "A restored Windows key is found on the next call".
            // The stamp also keeps since when the key has been found as written; only the key and value decide a write.
            // Accepted residual "Released plugins rewrite the registry stamp".
            const registryStamp = join(bridgeDir, 'registry.json');
            const stamp = await fs.readFile(registryStamp, 'utf8').then(JSON.parse).catch(() => null);
            const matches = stamp?.key === target.key && stamp?.value === manifestPaths[0];
            keyVerifiedSinceMs = matches && Number.isFinite(stamp.verifiedSinceMs) ? stamp.verifiedSinceMs : null;
            if (deps.repair || !matches) {
                const { previous } = await writeWindowsRegistration({ env, run, key: target.key, manifestPath: manifestPaths[0] });
                // Only a pass that changed the time writes the stamp: one that found the key as written would put back the
                // time it read before, over a newer one another process's repair wrote meanwhile.
                // Accepted residual "Two processes each run a repair": docs/local-agent-architecture.md#accepted-residuals.
                if (previous !== 'same' || keyVerifiedSinceMs === null) {
                    keyVerifiedSinceMs = now();
                    // A stamp that cannot be written only means the next start verifies the key again.
                    await writeAtomically(fs, registryStamp, JSON.stringify({ key: target.key, value: manifestPaths[0], verifiedSinceMs: keyVerifiedSinceMs }))
                        .catch(() => undefined);
                }
            }
        }

        // A denied folder may still name a directory this run no longer registers, so nothing is pruned then.
        // Accepted residual "A permanent browser-folder refusal stops pruning": docs/local-agent-architecture.md#accepted-residuals.
        if (!denied) await prune({ fs, bridgeDir, keep: [ownDir, dir], registeredVersion: dirStamp.version, now });
        const mtimes = await Promise.all(manifestPaths.map((path) => fs.stat(path).then((info) => info.mtimeMs, () => null)));
        const written = mtimes.filter((mtime) => mtime !== null);
        const changes = [...written, await fs.stat(launcherPath).then((info) => info.mtimeMs, () => null), keyVerifiedSinceMs].filter((at) => at !== null);
        // Only macOS's per-app folder guard has a step for the user (System Settings). Any other refusal fails the
        // registration only when no browser folder took the manifest: a failed registration is the cause of every
        // missing broker, and a seller whose own browser is registered must still hear that it is closed. The refusal
        // stays in `error` either way.
        // Accepted residual "A refused folder is weighed against any registered browser, not the seller's": docs/local-agent-architecture.md#accepted-residuals.
        const refused = denied && (platform === 'darwin' && denied.code === 'EPERM' ? 'denied' : registeredFolders === 0 ? 'failed' : null);
        return result(refused || (wrote ? 'registered' : 'current'), {
            runtime: runtime?.source ?? null,
            manifestWrittenAtMs: written.length > 0 ? Math.max(...written) : null,
            verifiedSinceMs: changes.length > 0 ? Math.max(...changes) : null,
            runtimeRecheck,
            error: denied,
        });
    } catch (error) {
        const detail = failure(step, error);
        log(`e-comet registration: ${step} failed (${detail.code ?? 'unknown'})`);
        return result('failed', { error: detail });
    }
}

// A tool call that finds no broker runs the same pass: the key is written every time, a launcher or manifest only when
// missing or stale, and broker files only into this process's own version, so a repair never downgrades the broker.
export const repairRegistration = (deps) => ensureRegistration({ ...deps, repair: true });

// The three policies that decide whether a browser may start our host, each null when unset or unreadable: whether
// NativeMessagingUserLevelHosts allows hosts registered per user, and the NativeMessagingBlocklist and
// NativeMessagingAllowlist host names. `failed` marks a read that observed nothing, which is not "no policy".
const UNSET = Object.freeze({ allowed: null, blocklist: null, allowlist: null, failed: false });
// reg.exe and plutil exit 1 for a key or file that does not exist, whatever the system language; a timeout, a tool
// that cannot start or any other exit is a read that failed.
const readFailed = (error) => error?.code !== 1;
const hostList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : null);

// One `reg query <key> /s` per root prints the vendor key and every subkey under its full root name. Only the vendor
// key's DWORD and the REG_SZ values of its exact list subkeys are read: Chromium honours these policies only when they
// are mandatory, so `\Recommended` and every other subkey are ignored.
const REGISTRY_ROOTS = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER' };
const readWindowsPolicy = async ({ run, env, vendor }) => {
    if (!vendor) return UNSET;
    const query = async (root) => {
        const found = { allowed: null, blocklist: null, allowlist: null, failed: false };
        let stdout;
        try {
            ({ stdout } = await run(system32(env, 'reg.exe'), ['query', `${root}\\Software\\Policies\\${vendor}`, '/s']));
        } catch (error) {
            // A missing key exits 1 with its localized "unable to find" text; a timeout or any other failure observes nothing.
            found.failed = readFailed(error);
            return found;
        }
        const key = `${REGISTRY_ROOTS[root]}\\Software\\Policies\\${vendor}`.toLowerCase();
        const sections = { [key]: 'allowed', [`${key}\\nativemessagingblocklist`]: 'blocklist', [`${key}\\nativemessagingallowlist`]: 'allowlist' };
        let section = null;
        for (const line of stdout.split(/\r?\n/)) {
            if (/^HKEY_/i.test(line)) {
                section = sections[line.trim().toLowerCase()] ?? null;
                continue;
            }
            const value = /^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/.exec(line);
            if (!value || !section) continue;
            const [, name, type, data] = value;
            if (section === 'allowed' && type === 'REG_DWORD' && name.toLowerCase() === 'nativemessaginguserlevelhosts') {
                found.allowed = Number.parseInt(data, 16) !== 0;
            } else if (section !== 'allowed' && type === 'REG_SZ') {
                (found[section] ??= []).push(data);
            }
        }
        return found;
    };
    const [machine, user] = await Promise.all([query('HKLM'), query('HKCU')]);
    // Machine policy wins over user policy, per policy.
    return { allowed: machine.allowed ?? user.allowed, blocklist: machine.blocklist ?? user.blocklist, allowlist: machine.allowlist ?? user.allowlist,
        failed: machine.failed || user.failed };
};

// Each policy is taken from the first plist that sets it, the user's before the computer's.
const readMacPolicy = async ({ run, user, bundle }) => {
    const plists = [`/Library/Managed Preferences/${user}/${bundle}.plist`, `/Library/Managed Preferences/${bundle}.plist`];
    let failed = false;
    const first = async (name, format, parse) => {
        for (const plist of plists) {
            let stdout;
            try {
                ({ stdout } = await run('/usr/bin/plutil', ['-extract', name, format, '-o', '-', plist]));
            } catch (error) {
                // Absent here: the next location decides.
                failed ||= readFailed(error);
                continue;
            }
            try {
                const value = parse(stdout.trim());
                if (value !== null) return value;
            } catch {
                // No value of its kind: the next location decides.
            }
        }
        return null;
    };
    const flag = (value) => (value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : null);
    const allowed = await first('NativeMessagingUserLevelHosts', 'raw', flag);
    const blocklist = await first('NativeMessagingBlocklist', 'json', (value) => hostList(JSON.parse(value)));
    const allowlist = await first('NativeMessagingAllowlist', 'json', (value) => hostList(JSON.parse(value)));
    return { allowed, blocklist, allowlist, failed };
};

// Every JSON file in the folder is a source; a false anywhere wins, because then the browser may ignore user hosts, and
// a list in any file applies.
const readLinuxPolicy = async ({ dir, fs }) => {
    let policies = [];
    try {
        // Chromium reads every file in the folder, whatever its name, and skips a leading UTF-8 byte order mark.
        const names = await fs.readdir(dir);
        policies = await Promise.all(names.map(async (name) => {
            try {
                return JSON.parse((await fs.readFile(posix.join(dir, name), 'utf8')).replace(/^\uFEFF/, ''));
            } catch {
                return null; // An unreadable or malformed file sets nothing.
            }
        }));
    } catch {
        // No folder, or one that cannot be read: nothing observed.
    }
    const values = policies.map((policy) => policy?.NativeMessagingUserLevelHosts).filter((value) => typeof value === 'boolean');
    const merged = (name) => {
        const lists = policies.map((policy) => hostList(policy?.[name])).filter((list) => list !== null);
        return lists.length === 0 ? null : lists.flat();
    };
    // A file this user cannot read is one the browser, running as the same user, cannot read either: no read failure.
    return { allowed: values.length === 0 ? null : !values.includes(false), blocklist: merged('NativeMessagingBlocklist'), allowlist: merged('NativeMessagingAllowlist'),
        failed: false };
};

// Chromium MessageService::IsNativeMessagingHostAllowed: a block list holding "*" or the host blocks it unless the
// allow list names it; null when no block list was read.
const blocksHost = ({ blocklist, allowlist }, hostName) => (blocklist === null ? null
    : (blocklist.includes('*') || blocklist.includes(hostName)) && !(allowlist ?? []).includes(hostName));

const accountName = () => {
    try {
        return userInfo().username;
    } catch {
        return '';
    }
};

// Accepted residual "Per-user native hosts forbidden by policy": docs/local-agent-architecture.md#accepted-residuals.
// Accepted residual "Managed native-messaging block and allow lists": docs/local-agent-architecture.md#accepted-residuals.
/**
 * Per browser, whether its NativeMessagingUserLevelHosts policy allows user-level hosts (`allowed`) and whether its
 * NativeMessagingBlocklist and NativeMessagingAllowlist block `hostName` (`hostBlocked`): true, false or null (unset).
 * `readFailed: true` when a read observed nothing (a timeout, a tool that did not start), so a null there is unknown.
 */
export async function readUserLevelHostsPolicy({ platform, run, env = process.env, user = accountName(), fs = { readdir, readFile },
    hostName = NATIVE_HOST_NAME }) {
    return Promise.all(POLICY_BROWSERS.map(async ({ browser, vendor, bundle, linux }) => {
        const policy = platform === 'win32'
            ? await readWindowsPolicy({ run, env, vendor })
            : platform === 'darwin' ? (user ? await readMacPolicy({ run, user, bundle }) : UNSET)
                : platform === 'linux' && linux ? await readLinuxPolicy({ dir: linux, fs }) : UNSET;
        return { browser, allowed: policy.allowed, hostBlocked: blocksHost(policy, hostName), ...(policy.failed ? { readFailed: true } : {}) };
    }));
}
