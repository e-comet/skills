// Why no broker answers, decided from what this process observed: the platform, the registration, the native messaging
// policies, the extension_install probe, the broker entries and failure records, and the last connect attempt (spec §5.8).
// Each cause carries the one step the seller can take (spec §8), so the agent never has to guess one.
import { existsSync, readFileSync } from 'node:fs';
import { win32 } from 'node:path';

import { BRIDGE_CODES, BRIDGE_IDENTIFIER, BRIDGE_OWNERS, bridgeOwner } from './bridge-codes.mjs';
import { isNativeCapableVersion } from './browser-extension-install.mjs';
import { NATIVE_HOST_NAME } from './native-framing.mjs';
import { ToolExecutionError } from './tool-errors.mjs';

export { BRIDGE_CODES, BRIDGE_OWNERS, bridgeOwner };

// English agent texts condensed from spec §8 "Seller-facing action". Russian UI labels are quoted as the browser shows
// them; {browser} is filled with the browser the cause names, or "the browser". Each fits 400 characters filled in.
export const BRIDGE_ACTIONS = Object.freeze({
    // The store link does not fit beside the puzzle-button hint in 400 characters, so the store is named instead.
    BRIDGE_NO_BROWSER: "Ask the user to open {browser} on the agent's computer with the e-Comet extension (install it from the Chrome Web Store if missing), " +
        'click the e-Comet icon (under the Extensions puzzle button if it is not pinned), accept the permission under ' +
        '«Требуется действие» if shown, and repeat the request. If it still fails, apply the update on app.e-comet.io or ' +
        'restart the browser; then report it.',
    // The browser runs, so opening it cannot help; a click opens the popup, which restarts the extension's search. The
    // front's support chat can attach the extension's log (Chatwoot setLogFileCallback), which a report from here cannot.
    BRIDGE_HOST_NOT_STARTED: "e-Comet is enabled in {browser}, which is running, but its local connector has not started. Ask the user to click the " +
        'e-Comet icon in the profile where it is installed (open that profile if it is closed) and repeat the request. If it still ' +
        "fails, offer to report it and ask the user to also message e-Comet support in that profile's app.e-comet.io chat, which can " +
        "attach the extension's log.",
    // The four below come from the extension's own log read from disk (extension-log.mjs, spec §3): the browser's close
    // text decided them, so none asks for a step that text rules out.
    BRIDGE_HOST_NOT_FOUND: "{browser} cannot see e-Comet's local connector registration on this computer, although it has been in place " +
        'for a while. Repeating the request will not help, and the user has nothing to change: this is an e-Comet issue, so offer to ' +
        'report it to e-Comet.',
    BRIDGE_HOST_FORBIDDEN: "{browser} refuses to start e-Comet's local connector for this copy of the e-Comet extension: either this " +
        'copy is not from the Chrome Web Store, or this is an e-Comet defect. Repeating the request will not help; offer to report it to e-Comet.',
    // Accepted residual "A broker that fails before its own code runs": docs/local-agent-architecture.md#accepted-residuals.
    // The extension pauses after failed starts until an icon click or a browser start, so a plain repeat cannot wake it.
    BRIDGE_HOST_START_FAILED: "{browser} tried to start e-Comet's local connector, but something on this computer stopped it before it " +
        'ran. Ask the user which security program is installed and to check its quarantine or blocked list for e-Comet, then click ' +
        "the e-Comet icon in {browser} and repeat the request. If that does not help, follow the e-Comet doctor's guided steps and offer to report it.",
    // A profile closed in a running browser leaves the same log as a connector another account runs, so the open-profile
    // step comes first.
    BRIDGE_BROKER_NOT_VISIBLE: "e-Comet's local connector last answered in {browser}, but this agent cannot reach it. Ask the user to click " +
        'the e-Comet icon in the profile where it is installed (open that profile if it is closed) and repeat the request. If it still ' +
        'fails, the connector may run under another user account or app on this computer: offer to report it to e-Comet.',
    // Accepted residual "Chrome disables the extension until the permission is accepted": docs/local-agent-architecture.md#accepted-residuals.
    BRIDGE_PERMISSION_REQUIRED: 'e-Comet stays off in {browser} until the user accepts its new permission. Ask the user to press ' +
        '«Требуется действие» right of the address bar (or the ⋮ menu) → «Расширение "e-Comet" отключено» → «Разрешить», then ' +
        'repeat the request. Turning e-Comet on at chrome://extensions, edge://extensions or browser://extensions asks for the same permission.',
    // Accepted residual "An extension update not yet applied when the plugin arrives": docs/local-agent-architecture.md#accepted-residuals.
    BRIDGE_EXTENSION_OUTDATED: 'The e-Comet extension in the browser is too old for this plugin. Ask the user to apply the extension ' +
        'update offered on app.e-comet.io or restart the browser, press «Разрешить» when the browser asks for the new permission ' +
        'under «Требуется действие», and repeat the request. Report it to e-Comet if the version stays old.',
    BRIDGE_EXTENSION_DISABLED: 'The e-Comet extension is turned off in the browser. Ask the user to turn e-Comet on in the ' +
        'extensions page (chrome://extensions, edge://extensions or browser://extensions) and repeat the request.',
    BRIDGE_USER_HOSTS_DISABLED: 'An administrator policy (NativeMessagingUserLevelHosts) stops {browser} on this computer from ' +
        'starting apps installed per user, so it cannot start e-Comet. This is not an e-Comet or user fault: whoever manages the ' +
        'computer can allow it. After that, restart {browser} and repeat the request.',
    BRIDGE_HOST_BLOCKED: "An administrator policy (NativeMessagingBlocklist) blocks e-Comet's local connector in {browser} on this computer. " +
        `This is not an e-Comet or user fault: whoever manages the computer can allow ${NATIVE_HOST_NAME} in NativeMessagingAllowlist. ` +
        'After that, restart {browser} and repeat the request.',
    BRIDGE_BROKER_UNRESPONSIVE: "The browser started e-Comet's local connector, but it does not answer. Ask the user to restart " +
        'the browser and repeat the request; report it to e-Comet if it repeats.',
    // A registration failure (disk, permissions) and a broker failure record both land here, so the text names no owner:
    // the step and system code it carries tell support which one it was, as {refusal} does below.
    BRIDGE_BROKER_FAILED: "e-Comet's local connector could not be set up or failed to start on this computer (failed at {step}, code " +
        '{code}). No step for the user is known: offer to report it to e-Comet so support can see why.',
    // Every broker_refusal code and the client's own size check land here. The text carries the refusal code itself:
    // every tool-result serializer keeps a fixed key set, so the message is the one field that reaches the agent.
    BRIDGE_FRAME_TOO_LARGE: 'The local e-Comet bridge refused a message for the extension ({refusal}). This is an ' +
        'e-Comet defect; report it to e-Comet with that code.',
    BRIDGE_MACOS_FOLDER_ACCESS: 'macOS did not let the agent app register e-Comet with the browser. Ask the user to open System ' +
        'Settings → Privacy & Security → Files & Folders, allow the browser for the app that runs the agent, and repeat the request.',
    BRIDGE_UNAVAILABLE_IN_WSL: 'The agent runs inside WSL and cannot reach the browser on Windows. Ask the user to run the agent on ' +
        'Windows; in Codex Desktop, turn off running the agent in WSL.',
    BRIDGE_UNSUPPORTED_PLATFORM: 'The agent runs on an operating system where e-Comet cannot reach a browser. Ask the user to use ' +
        'the agent on Windows, macOS or Linux.',
});

// A cause a fact narrows further has its own text: an invalid ComSpec is the administrator's to fix, not unknown, and a
// policy that could not be read stays a possible cause of a connector that never started.
export const BRIDGE_DETAIL_ACTIONS = Object.freeze({
    BRIDGE_HOST_NOT_STARTED: Object.freeze({
        policy_unread: "e-Comet is enabled in {browser}, which is running, but its local connector has not started; an administrator " +
            'policy on this computer may block it (it could not be read). Ask the user to click the e-Comet icon in the profile where ' +
            "it is installed and repeat the request. If it still fails, offer to report it and ask the user to also message e-Comet " +
            "support in that profile's app.e-comet.io chat.",
    }),
    BRIDGE_HOST_START_FAILED: Object.freeze({
        comspec: "Windows cannot start e-Comet's local connector for {browser}: the ComSpec environment variable does not point to " +
            'cmd.exe. This is not an e-Comet or user fault: whoever manages the computer can restore ComSpec to ' +
            '%SystemRoot%\\System32\\cmd.exe, then restart {browser} and the agent app and repeat the request.',
    }),
});

// Failures with no supported user step, and setups the user cannot change in place: repeating the request cannot help.
const FINAL_CODES = new Set(['BRIDGE_BROKER_FAILED', 'BRIDGE_UNAVAILABLE_IN_WSL', 'BRIDGE_UNSUPPORTED_PLATFORM', 'BRIDGE_FRAME_TOO_LARGE',
    'BRIDGE_HOST_NOT_FOUND', 'BRIDGE_HOST_FORBIDDEN']);
const BROWSER_NAMES = Object.freeze({ chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave', yandex: 'Yandex Browser', opera: 'Opera' });

/**
 * The tool error for a cause. A code that is no closed cause becomes BRIDGE_NO_BROWSER, which claims nothing more than
 * that no broker answered; a browser outside the probe's list is not named. `refusal` is a closed refusal code the
 * caller validated, and UNKNOWN without one. `step` and `systemCode` name a failed registration step or broker failure
 * record; a value that is no short identifier becomes UNKNOWN. `detail` picks the code's narrower text when it has one.
 * @param {{ code?: unknown, browser?: unknown, refusal?: string, detail?: string, step?: unknown, systemCode?: unknown }} cause
 */
export function bridgeCauseError({ code, browser, refusal = 'UNKNOWN', detail = undefined, step = undefined, systemCode = undefined } = {}) {
    const known = BRIDGE_CODES.includes(/** @type {string} */ (code)) ? /** @type {keyof typeof BRIDGE_ACTIONS} */ (code) : 'BRIDGE_NO_BROWSER';
    const name = Object.hasOwn(BROWSER_NAMES, /** @type {string} */ (browser)) ? BROWSER_NAMES[/** @type {keyof typeof BROWSER_NAMES} */ (browser)] : 'the browser';
    /** @type {Record<string, Record<string, string>>} */
    const details = BRIDGE_DETAIL_ACTIONS;
    const narrower = detail !== undefined && Object.hasOwn(details, known) && Object.hasOwn(details[known], detail) ? details[known][detail] : undefined;
    const identifier = (/** @type {unknown} */ value) => (typeof value === 'string' && BRIDGE_IDENTIFIER.test(value) ? value : 'UNKNOWN');
    const text = (narrower ?? BRIDGE_ACTIONS[known]).replaceAll('{browser}', name).replace('{refusal}', refusal)
        .replace('{step}', identifier(step)).replace('{code}', identifier(systemCode));
    return new ToolExecutionError(known, text, 'local', !FINAL_CODES.has(known));
}

/**
 * Windows starts a native host's launcher through the command interpreter that ComSpec names; without a real cmd.exe
 * there, no host starts. Read in-process from the environment, with no child process. Elsewhere it does not apply.
 * This process sees its host's environment, not the browser's, and a host may leave ComSpec out: an absent value is
 * `unknown`, never `invalid`, which only a value naming something other than an existing cmd.exe is.
 * @returns {'valid' | 'invalid' | 'unknown' | 'not_applicable'}
 */
export function readComspecState({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
    if (platform !== 'win32') return 'not_applicable';
    const name = Object.keys(env).find((key) => key.toUpperCase() === 'COMSPEC');
    const value = name === undefined ? '' : String(env[name]);
    if (value === '') return 'unknown';
    return win32.isAbsolute(value) && /(?:^|[\\/])cmd\.exe$/i.test(value) && exists(value) ? 'valid' : 'invalid';
}

// Accepted residual "Agents inside WSL lose live data": docs/local-agent-architecture.md#accepted-residuals.
/**
 * Registration covers Windows, macOS and Linux. WSL is read from /proc, never from environment variables, which Codex
 * filters out of a server's environment.
 */
export function detectPlatformCause({ platform = process.platform, readFile = (path) => readFileSync(path, 'utf8'), exists = existsSync } = {}) {
    if (platform === 'win32' || platform === 'darwin') return null;
    if (platform !== 'linux') return 'BRIDGE_UNSUPPORTED_PLATFORM';
    let version = '';
    try {
        version = String(readFile('/proc/version'));
    } catch {
        // No /proc/version: only the interop marker can still tell WSL.
    }
    return /microsoft/i.test(version) || exists('/proc/sys/fs/binfmt_misc/WSLInterop') ? 'BRIDGE_UNAVAILABLE_IN_WSL' : null;
}

const RANKS = ['ready', 'permission', 'outdated', 'disabled', 'unknown'];
const rankOf = (profile) => {
    if (profile.state === 'enabled') return isNativeCapableVersion(profile.version) ? 'ready' : profile.version ? 'outdated' : 'unknown';
    if (profile.state === 'disabled') return profile.permissionsIncrease && profile.disableReasons?.length === 1 ? 'permission' : 'disabled';
    return 'unknown';
};
const installsOf = (probe) => (Array.isArray(probe?.facts?.browsers) ? probe.facts.browsers : []);
const recency = (profile) => profile.lastUsedDaysAgo ?? Infinity;
// The most recently used profile where the extension is enabled, otherwise the most recently used one with an install.
const judgedProfile = (profiles) => {
    const byRecency = [...profiles].sort((a, b) => recency(a) - recency(b));
    return byRecency.find((profile) => profile.state === 'enabled') ?? byRecency[0];
};
const nativeReady = (probe) => installsOf(probe).some(({ profiles }) => profiles.some((profile) => rankOf(profile) === 'ready'));
const policyOf = (policy, browser) => policy?.find((item) => item.browser === browser);
// Whether the browser's policy lets it start a host registered per user, ours: false when forbidden or blocked, null
// when a read observed nothing (unknown, not allowed), true otherwise.
const admits = (policy, browser) => {
    const entry = policyOf(policy, browser);
    if (entry?.allowed === false || entry?.hostBlocked === true) return false;
    return entry?.readFailed === true ? null : true;
};
// When the probe saw the browser start, in ms; NaN when it is not seen running.
const startedAt = (probe, browser) => {
    const install = installsOf(probe).find((item) => item.browser === browser);
    return install?.running === true ? Date.parse(install.runningSince) : NaN;
};
// Each browser with an install, ranked by its judged profile; among equal ranks a running browser goes first, and the
// rest keep the probe's browser order.
const judgedBrowsers = (probe) => installsOf(probe)
    .flatMap(({ browser, profiles, running }) => (profiles.length > 0 ? [{ browser, rank: rankOf(judgedProfile(profiles)), running: running === true }] : []))
    .sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) || Number(b.running) - Number(a.running));

/**
 * The browser a cause names for a ready install: the first ready browser whose policy admits the host, else one whose
 * policy could not be read; undefined when none has a ready install or every one's policy forbids or blocks the host.
 * The extension log reader reads this browser's profile, so the evidence and the cause name the same browser.
 * @param {{ probe: any, policy?: any }} facts
 * @returns {string | undefined}
 */
export function chosenBrowser({ probe, policy = null }) {
    const ready = judgedBrowsers(probe).filter(({ rank }) => rank === 'ready');
    return (ready.find(({ browser }) => admits(policy, browser) === true) ?? ready.find(({ browser }) => admits(policy, browser) === null))?.browser;
}

// A browser's extension starts its broker within this long of the browser starting, as after a manifest write.
const WAIT_WINDOW_MS = 30_000;
// The extension searches for a missing host every 15 s (its hostMissingMs) without writing a row; 5 s more is margin.
// A registration unchanged this long has been searched for at least once.
export const HOST_NOT_FOUND_SETTLE_MS = 20_000;
const START_FAILURE_CLASSES = new Set(['host_exited', 'start_failed', 'communication_error']);

/**
 * The extension's own account of the chosen browser (spec §3), or null when it has none. `since` is when the registration
 * last changed, `started` when the probe last saw the browser start (NaN when it is not seen running). Every rule but a
 * refused ID needs rows from this run of the browser: a closed browser's old rows would hide the step today's cause
 * gives (open it), and a browser restarted since the log was read has not written them. The probe's time is used, not the
 * one read with the log, because status keeps the log while the background refreshes the probe.
 * @param {import('./extension-log.mjs').ExtensionLogEvidence} log
 * @returns {{ code: string, detail?: 'comspec' } | null}
 */
const logCause = (log, { since, started, entries, failureRecords, lastConnect, now, comspec }) => {
    // A profile closed in a running browser writes no row (stand, Chrome 156): its rows explain nothing today, and the
    // fallback's step opens that profile.
    if (log.profileOpen === false && Number.isFinite(started)) return null;
    // A close that a later handshake followed is over: the connector answered since (stand, Chrome 156).
    const close = log.lastClose && !(log.lastHandshakeAtMs > log.lastClose.atMs) ? log.lastClose : undefined;
    if ((log.refusedAtMs !== undefined && !(log.lastHandshakeAtMs > log.refusedAtMs)) || (close?.class === 'host_forbidden' && close.atMs > since)) {
        return { code: 'BRIDGE_HOST_FORBIDDEN' };
    }
    if (!Number.isFinite(started)) return null;
    // A policy this process cannot read (a cloud-managed browser keeps it out of the registry) still shows in the close.
    if (close?.class === 'host_blocked' && close.atMs > started) return { code: 'BRIDGE_HOST_BLOCKED' };
    // A streak of not-found or forbidden closes writes one row, its first. While it stays open in this run of the browser,
    // it is current once the registration had stayed unchanged longer than the extension's 15 s search interval when the
    // log was read: status keeps a read, and a later clock would settle a streak no search was seen to leave open.
    // Accepted residual "BRIDGE_HOST_NOT_FOUND and the settled FORBIDDEN arm assume the extension's worker stays alive":
    // docs/local-agent-architecture.md#accepted-residuals.
    const settledStreak = log.streak?.open && close?.atMs > started && (log.readAtMs ?? now) - since >= HOST_NOT_FOUND_SETTLE_MS;
    if (settledStreak && close.class === 'host_forbidden') return { code: 'BRIDGE_HOST_FORBIDDEN' };
    // Accepted residual "A settled not-found streak outranks an unread policy": docs/local-agent-architecture.md#accepted-residuals.
    if (settledStreak && close.class === 'host_not_found') return { code: 'BRIDGE_HOST_NOT_FOUND' };
    // Accepted residual "A security program that removes a connector file": docs/local-agent-architecture.md#accepted-residuals.
    if (close && START_FAILURE_CLASSES.has(close.class) && !close.handshaken && close.atMs > Math.max(since, started)
        && entries.length === 0 && failureRecords.length === 0) {
        return { code: 'BRIDGE_HOST_START_FAILED', ...(comspec === 'invalid' ? { detail: 'comspec' } : {}) };
    }
    // A handshake no close followed: the browser's connector runs, yet this process finds no broker it can use.
    if (log.lastHandshakeAtMs > started && !(close?.atMs >= log.lastHandshakeAtMs) && (entries.length === 0 || lastConnect?.ok === false)) {
        return { code: 'BRIDGE_BROKER_NOT_VISIBLE' };
    }
    return null;
};

/**
 * The first matching cause of spec §5.8. `failureRecords` are the client's, already cut at this process's last good
 * session; the cut at the newest live entry and the manifest write is repeated here against the facts passed in.
 * `extensionLog` is the extension's own log read from disk; `comspec` narrows a start failure on Windows.
 * @param {{ platformCause?: string | null, registration?: any, policy?: any, probe?: any, entries?: any[], failureRecords?: any[],
 *   lastConnect?: any, now?: number, extensionLog?: import('./extension-log.mjs').ExtensionLogEvidence | null,
 *   comspec?: 'valid' | 'invalid' | 'unknown' | 'not_applicable' }} facts
 * @returns {{ code: string, browser?: string, detail?: 'comspec' | 'policy_unread', step?: string, systemCode?: string }}
 */
export function chooseBridgeCause({ platformCause, registration, policy, probe, entries = [], failureRecords = [], lastConnect, now = Date.now(),
    extensionLog = null, comspec = 'not_applicable' }) {
    if (platformCause) return { code: platformCause };
    if (registration?.state === 'denied') return { code: 'BRIDGE_MACOS_FOLDER_ACCESS' };
    const settledAt = Math.max(-Infinity, registration?.manifestWrittenAtMs ?? -Infinity, ...entries.map((entry) => entry.startedAt));
    // A record counts beside an install that should have started the broker, or, whatever the probe saw, when it is newer
    // than the registration's last change: that registration's broker ran and failed.
    const verifiedAt = registration?.verifiedSinceMs ?? Infinity;
    const record = failureRecords.find((failure) => failure.at > settledAt && (nativeReady(probe) || failure.at > verifiedAt));
    const failed = registration?.state === 'failed' ? registration.error : record;
    if (registration?.state === 'failed' || record) {
        return { code: 'BRIDGE_BROKER_FAILED', ...(typeof failed?.name === 'string' ? { step: failed.name } : {}),
            ...(typeof failed?.code === 'string' ? { systemCode: failed.code } : {}) };
    }
    if (entries.length > 0 && lastConnect?.reason === 'unresponsive') return { code: 'BRIDGE_BROKER_UNRESPONSIVE' };

    const browsers = installsOf(probe);
    const judged = judgedBrowsers(probe);
    const best = judged[0];
    const named = (code, browser = best?.browser) => (browser ? { code, browser } : { code });
    if (best?.rank === 'ready') {
        const chosen = chosenBrowser({ probe, policy });
        if (!chosen) {
            const blocked = judged.find(({ browser, rank }) => rank === 'ready' && policyOf(policy, browser)?.hostBlocked === true);
            return blocked ? named('BRIDGE_HOST_BLOCKED', blocked.browser) : named('BRIDGE_USER_HOSTS_DISABLED');
        }
        if (extensionLog?.browser === chosen) {
            const since = registration?.verifiedSinceMs ?? -Infinity;
            const logged = logCause(extensionLog, { since, started: startedAt(probe, chosen), entries, failureRecords, lastConnect, now, comspec });
            if (logged) return { ...logged, browser: chosen };
        }
        // Running that long without an entry, its extension had the time to start the broker: opening it cannot help.
        // Accepted residual "A broker that fails before its own code runs": docs/local-agent-architecture.md#accepted-residuals.
        const notStarted = entries.length === 0 && now - startedAt(probe, chosen) >= WAIT_WINDOW_MS;
        if (notStarted && admits(policy, chosen) === null) return { code: 'BRIDGE_HOST_NOT_STARTED', browser: chosen, detail: 'policy_unread' };
        return named(notStarted ? 'BRIDGE_HOST_NOT_STARTED' : 'BRIDGE_NO_BROWSER', chosen);
    }
    if (best?.rank === 'permission') return named('BRIDGE_PERMISSION_REQUIRED');
    // OUTDATED and DISABLED speak for every install, so they need a probe that read every profile it found.
    const profiles = browsers.flatMap((browser) => browser.profiles);
    const complete = probe?.state === 'passed';
    if (best?.rank === 'outdated' && complete && !profiles.some((profile) => isNativeCapableVersion(profile.version) || rankOf(profile) === 'unknown')) {
        return named('BRIDGE_EXTENSION_OUTDATED');
    }
    if (best?.rank === 'disabled' && complete && profiles.every((profile) => rankOf(profile) === 'disabled')) return named('BRIDGE_EXTENSION_DISABLED');
    return named('BRIDGE_NO_BROWSER');
}

// Accepted residual "Broker restarts with the extension": docs/local-agent-architecture.md#accepted-residuals.
/**
 * Whether a broker is about to appear (spec §5.7): an install is enabled on a native-capable build, and the manifest was
 * written, this process's session ended or a browser with such an install whose policy admits our host started less than
 * 30 s ago (a first registration, an extension update, a browser restart).
 */
export function shouldWaitForBroker({ probe, policy, registration, lastSessionEndAtMs, now }) {
    const recent = (at) => Number.isFinite(at) && now - at < WAIT_WINDOW_MS;
    // A policy that could not be read is not a block: the broker may still be about to appear.
    const starting = installsOf(probe).some(({ browser, profiles }) => profiles.some((profile) => rankOf(profile) === 'ready')
        && admits(policy, browser) !== false && recent(startedAt(probe, browser)));
    return nativeReady(probe) && (recent(registration?.manifestWrittenAtMs) || recent(lastSessionEndAtMs) || starting);
}
