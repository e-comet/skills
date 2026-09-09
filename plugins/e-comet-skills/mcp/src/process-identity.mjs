import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DECIMAL = /^\d{1,20}$/;
const START_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
const validScope = value => {
    if (!value || typeof value !== 'object') return false;
    if (value.platform === 'win32' || value.platform === 'darwin') return true;
    return value.platform === 'linux' && typeof value.bootId === 'string' && UUID.test(value.bootId) &&
        typeof value.namespace === 'string' && /^pid:\[\d+\]$/.test(value.namespace);
};

const validIdentity = value => {
    if (!value || typeof value !== 'object' || typeof value.started !== 'string') return false;
    if (value.platform === 'win32') return DECIMAL.test(value.started);
    if (typeof value.bootId !== 'string' || !UUID.test(value.bootId)) return false;
    if (value.platform === 'linux') {
        return DECIMAL.test(value.started) && typeof value.namespace === 'string' && /^pid:\[\d+\]$/.test(value.namespace);
    }
    return value.platform === 'darwin' && START_DATE.test(value.started) && Number.isFinite(Date.parse(`${value.started} UTC`));
};

// These helpers only read OS metadata. Bound their lifetime/output so a missing or
// restricted system utility cannot block the MCP event loop or storage indefinitely.
const run = (file, args, timeout) => new Promise((resolve, reject) => {
    execFile(file, args, {
        encoding: 'utf8', windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 4096,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
});

export const readProcessIdentity = async (pid, timeoutMs = 2000) => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(timeoutMs) || timeoutMs < 1) return null;
    const timeout = Math.floor(Math.min(timeoutMs, 2000));
    try {
        let identity;
        if (process.platform === 'win32') {
            const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            // Keep the native 64-bit value as text; a JS number would lose precision.
            const started = await run(executable, ['-NoProfile', '-NonInteractive', '-Command',
                `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)`], timeout);
            identity = { platform: 'win32', started };
        } else if (process.platform === 'linux') {
            const [status, bootId, namespace] = await Promise.all([
                readFile(`/proc/${pid}/stat`, 'utf8'),
                readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
                readlink('/proc/self/ns/pid'),
            ]);
            // comm may itself contain spaces and parentheses; fields after its
            // final ')' begin at field 3, making starttime (field 22) index 19.
            const end = status.lastIndexOf(')');
            if (end < 0 || !status.startsWith(`${pid} (`)) return null;
            const started = status.slice(end + 1).trim().split(/\s+/)[19];
            identity = { platform: 'linux', started, bootId: bootId.trim(), namespace };
        } else if (process.platform === 'darwin') {
            const [started, bootId] = await Promise.all([
                run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], timeout),
                run('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], timeout),
            ]);
            identity = { platform: 'darwin', started, bootId: bootId.toLowerCase() };
        }
        return validIdentity(identity) ? identity : null;
    } catch {
        // Lookup denial, process exit during lookup, malformed output or an
        // unavailable helper is not proof that the recorded owner has ended.
        return null;
    }
};

let ownIdentity;
export const getOwnProcessIdentity = () => ownIdentity ??= readProcessIdentity(process.pid).then(identity => {
    // A transient denied/timed-out probe must not disable recovery for the rest
    // of this MCP session. Only a successful, immutable self identity is cached.
    if (!identity) ownIdentity = undefined;
    return identity;
});

// PID absence and PID reuse need different evidence. Windows/macOS have one PID
// space on the supported local host; Linux scope is observable without starttime.
export const readCurrentProcessScope = async () => {
    const scope = { platform: process.platform };
    try {
        if (process.platform === 'linux') {
            const [bootId, namespace] = await Promise.all([
                readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid'),
            ]);
            Object.assign(scope, { bootId: bootId.trim(), namespace });
        }
        return validScope(scope) ? scope : null;
    } catch { return null; }
};

export const hasComparableProcessScope = (recorded, observer) => {
    if (!validIdentity(recorded) || !validScope(observer) || recorded.platform !== observer.platform) return false;
    return recorded.platform !== 'linux' || recorded.bootId !== observer.bootId || recorded.namespace === observer.namespace;
};

export const isDifferentProcess = (recorded, current) => {
    // Scope alone permits checking ESRCH, never inferring a different live process.
    if (!validIdentity(current) || !hasComparableProcessScope(recorded, current)) return false;
    if (recorded.platform !== 'win32') {
        // Result storage is local to one OS host. PID spaces from simultaneous
        // Linux namespaces cannot identify one another's still-running owners.
        if (recorded.bootId !== current.bootId) return true;
    }
    // macOS ps exposes seconds: equal dates remain protected even if distinct
    // incarnations happened to start within that same second.
    return recorded.started !== current.started;
};

const processPresence = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'ESRCH' ? false : undefined; }
};

// Every owner-record consumer uses the same distinction: absent PID in a known
// scope is dead; a live PID needs a different full birth identity to prove reuse.
export const classifyProcessOwner = async (pid, recorded, {
    scope,
    selfIdentity,
    lookup = readProcessIdentity,
    isProcessAlive = processPresence,
}) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
    if (recorded !== null && !hasComparableProcessScope(recorded, scope)) return 'unknown';
    let present;
    try { present = await isProcessAlive(pid); } catch { return 'unknown'; }
    if (present === false) return 'dead';
    if (recorded === null) return present === true ? 'alive' : 'unknown';
    let current;
    try { current = pid === process.pid ? selfIdentity : await lookup(pid); } catch { return 'unknown'; }
    if (!validIdentity(current) || !hasComparableProcessScope(recorded, current)) return 'unknown';
    return isDifferentProcess(recorded, current) ? 'dead' : 'alive';
};
