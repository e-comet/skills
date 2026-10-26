// The local MCP's side of the native bridge. It finds brokers through their rendezvous entries, proves an endpoint is
// the broker that wrote the entry by the secret `brokerNonce` in its hello reply, and keeps one session until that
// session closes. The nonce never leaves this module: not in entries it lists, log lines or session facts.
import { join } from 'node:path';

import {
    CLIENT_PROTOCOL_VERSION,
    MAX_FRAME_BYTES,
    MAX_HOST_TO_BROWSER_BYTES,
    createFrameReader,
    encodeFrame,
} from './native-framing.mjs';

const ENTRY_NAME = /^(\d+)\.json$/;
const RECORD_NAME = /^(\d+)\.failed$/;
// The two shapes `createEndpointPath` makes: a random local pipe, or a socket in a private `/tmp` directory from
// `fs.mkdtemp`, whose suffix is alphanumeric. Anything else, a UNC path above all, is never dialled.
const PIPE_ENDPOINT = /^\\\\\.\\pipe\\e-comet-bridge-[0-9a-f]{32}$/;
const SOCKET_ENDPOINT = /^\/tmp\/e-comet-[A-Za-z0-9]+\/b\.sock$/;
// Nothing listens there, so the broker that wrote the entry is gone.
const STALE_CONNECT_CODES = new Set(['ENOENT', 'ECONNREFUSED']);
// The broker measures a client frame after adding its id prefix, and the prefix plus the id is at most 128 characters.
const PREFIX_ALLOWANCE_BYTES = 128;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const pidOf = (pattern, name) => {
    const pid = Number(pattern.exec(name)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

// A missing process proves the broker gone. A live one proves nothing, because Windows reuses pids.
const processGone = (pid) => {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return error?.code === 'ESRCH';
    }
};

/** @param {unknown} endpoint @param {string} platform */
export function isLocalEndpoint(endpoint, platform) {
    return typeof endpoint === 'string' && (platform === 'win32' ? PIPE_ENDPOINT : SOCKET_ENDPOINT).test(endpoint);
}

/**
 * @param {{ rendezvousDir: string, platform: string, pluginVersion: string, instanceId: string,
 *   net: { connect: (path: string) => import('node:net').Socket }, fs: typeof import('node:fs/promises'),
 *   now: () => number, log: (line: string) => void, connectTimeoutMs?: number, helloTimeoutMs?: number }} options
 */
export function createBrokerClient({ rendezvousDir, platform, pluginVersion, instanceId, net, fs, now, log,
    connectTimeoutMs = 2000, helloTimeoutMs = 5000 }) {
    let current = null;
    let attempt = null;
    // The socket of the entry being tried, so stop() can end an attempt in flight.
    let dialling = null;
    let lastSessionAtMs = null;
    let discoveryTimer = null;
    let onSession = null;
    let stopped = false;
    // Discovery and status re-read every few seconds, so a failure is logged when it starts or changes, not each time.
    let directoryProblem = null;
    let lastFailure = null;

    const stoppedError = () => Object.assign(new Error('The broker client is stopped.'), { code: 'BROKER_CLIENT_STOPPED' });

    const readDirectory = async () => {
        try {
            const names = await fs.readdir(rendezvousDir);
            directoryProblem = null;
            return names;
        } catch (error) {
            const code = error?.code ?? 'unknown';
            if (code === 'ENOENT') directoryProblem = null;
            else if (code !== directoryProblem) {
                directoryProblem = code;
                log(`e-comet broker client: rendezvous not readable (${code})`);
            }
            return [];
        }
    };

    // The bytes are kept so a stale file is deleted only while it still holds them.
    const readJson = async (name) => {
        try {
            const raw = await fs.readFile(join(rendezvousDir, name));
            const value = JSON.parse(raw.toString('utf8'));
            return isRecord(value) ? { raw, value } : null;
        } catch {
            return null;
        }
    };

    // Windows has no compare-and-delete: a broker that reuses the pid and renames its entry in between this re-read and
    // the rm loses that entry, and clients find it again only after its next start.
    // Accepted residual "Stale-entry delete races a reused pid": docs/local-agent-architecture.md#accepted-residuals.
    const removeIfUnchanged = async (name, raw) => {
        const path = join(rendezvousDir, name);
        try {
            if ((await fs.readFile(path)).equals(raw)) await fs.rm(path, { force: true });
        } catch {
            // Already gone: nothing to delete.
        }
    };

    // Valid entries, newest start first. An unreadable entry or a foreign endpoint is no entry at all.
    // Accepted residual "Several brokers: the most recently started is used": docs/local-agent-architecture.md#accepted-residuals.
    const readEntries = async () => {
        const entries = [];
        for (const name of await readDirectory()) {
            const pid = pidOf(ENTRY_NAME, name);
            if (pid === null) continue;
            const read = await readJson(name);
            const entry = read?.value;
            if (!entry || !isLocalEndpoint(entry.endpoint, platform) || typeof entry.brokerNonce !== 'string' ||
                entry.brokerNonce.length === 0 || !Number.isFinite(entry.startedAt)) continue;
            entries.push({ pid, name, raw: read.raw, entry });
        }
        return entries.sort((a, b) => b.entry.startedAt - a.entry.startedAt);
    };

    const listEntries = async () => (await readEntries())
        .filter(({ pid }) => !processGone(pid))
        .map(({ pid, entry }) => ({
            pid,
            browser: entry.browser,
            extensionVersion: entry.extensionVersion,
            brokerVersion: entry.brokerVersion,
            startedAt: entry.startedAt,
        }));

    const dial = (endpoint) => new Promise((resolve) => {
        const socket = net.connect(endpoint);
        dialling = socket;
        const settle = (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
        };
        const timer = setTimeout(() => {
            socket.destroy();
            settle({ code: 'ETIMEDOUT' });
        }, connectTimeoutMs);
        // Kept for the socket's life: an error without a listener would crash the process.
        socket.on('error', (/** @type {NodeJS.ErrnoException} */ error) => settle({ code: error?.code ?? 'unknown' }));
        // stop() destroys a connecting socket without an error.
        socket.once('close', () => settle({ code: 'ECLOSED' }));
        socket.once('connect', () => settle({ socket }));
    });

    // Sends the client hello and resolves with a session once the reply carries the entry's nonce. Nothing else is sent
    // before that check.
    const handshake = (socket, brokerNonce, pid) => new Promise((resolve) => {
        let session = null;
        let frameHandler = null;
        let closeHandler = null;
        let closed = false;
        // Frames that follow the hello reply in the same read arrive before the caller can register its handler.
        const queued = [];
        const timer = setTimeout(() => {
            socket.destroy();
            resolve({ result: 'unresponsive', detail: `no broker_hello within ${helloTimeoutMs} ms` });
        }, helloTimeoutMs);
        const settle = (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
        };
        const reader = createFrameReader({
            maxBytes: MAX_FRAME_BYTES,
            onFrame: (frame) => {
                if (socket.destroyed) return;
                if (session) return void (frameHandler ? frameHandler(frame) : queued.push(frame));
                if (frame.type !== 'broker_hello' || frame.brokerNonce !== brokerNonce) {
                    socket.destroy();
                    return void settle({ result: 'stale', detail: 'nonce mismatch' });
                }
                const extension = isRecord(frame.extension) ? frame.extension : {};
                session = {
                    // The broker this session runs through, as its entry names it.
                    pid,
                    // The broker refuses an oversized frame by closing the connection, which would end every request
                    // of this process; refused here instead, before anything is written.
                    send: (message) => {
                        const encoded = encodeFrame(message);
                        if (encoded.readUInt32LE(0) + PREFIX_ALLOWANCE_BYTES > MAX_HOST_TO_BROWSER_BYTES) {
                            throw Object.assign(new Error(`The frame is over the ${MAX_HOST_TO_BROWSER_BYTES}-byte browser limit.`), { code: 'FRAME_TOO_LARGE' });
                        }
                        if (!socket.destroyed) socket.write(encoded);
                    },
                    close: () => socket.destroy(),
                    facts: {
                        extensionVersion: extension.extensionVersion,
                        capabilities: extension.capabilities,
                        protocolVersion: extension.protocolVersion,
                        browser: extension.browser,
                    },
                    brokerVersion: frame.brokerVersion,
                    brokerProtocolVersion: frame.clientProtocolVersion,
                    browserContext: isRecord(frame.session) ? frame.session.browserContext ?? null : null,
                    onFrame: (handler) => {
                        frameHandler = handler;
                        for (const early of queued.splice(0)) handler(early);
                    },
                    onClose: (handler) => {
                        if (closed) handler();
                        else closeHandler = handler;
                    },
                };
                settle({ session });
            },
            // A length-prefixed stream cannot resynchronise after a bad frame.
            onError: (error) => {
                log(`e-comet broker client: closing a broker connection (${error.code})`);
                socket.destroy();
            },
        });
        socket.on('data', (chunk) => reader.push(chunk));
        socket.on('close', () => {
            closed = true;
            if (!session) return void settle({ result: 'unresponsive', detail: 'closed before its hello reply' });
            if (current === session) current = null;
            closeHandler?.();
        });
        socket.write(encodeFrame({ type: 'client_hello', clientProtocolVersion: CLIENT_PROTOCOL_VERSION, pluginVersion, instanceId }));
    });

    // Each outcome carries the line that describes it; the attempt decides whether to log it.
    // Accepted residual "A hung newest broker costs a hello wait per attempt": docs/local-agent-architecture.md#accepted-residuals.
    const tryEntry = async ({ pid, name, raw, entry }) => {
        const stale = async (why) => {
            await removeIfUnchanged(name, raw);
            return { result: 'stale', note: `entry of broker ${pid} is stale (${why})` };
        };
        if (processGone(pid)) return stale('no such process');
        const dialled = await dial(entry.endpoint);
        if (!dialled.socket) {
            if (STALE_CONNECT_CODES.has(dialled.code)) return stale(dialled.code);
            return { result: 'unresponsive', note: `broker ${pid} did not accept (${dialled.code})` };
        }
        const outcome = await handshake(dialled.socket, entry.brokerNonce, pid);
        if (outcome.result === 'stale') return stale(outcome.detail);
        if (outcome.result === 'unresponsive') return { ...outcome, note: `broker ${pid} is unresponsive (${outcome.detail})` };
        return { ...outcome, note: `connected to broker ${pid} (${entry.brokerVersion})` };
    };

    const connectOnce = async () => {
        const candidates = await readEntries();
        const notes = [];
        let unresponsive = false;
        for (const candidate of candidates) {
            if (stopped) break;
            const outcome = await tryEntry(candidate);
            dialling = null;
            notes.push(`e-comet broker client: ${outcome.note}`);
            if (outcome.session && !stopped) {
                current = outcome.session;
                lastSessionAtMs = now();
                lastFailure = null;
                for (const note of notes) log(note);
                // The one place a new session opens, so it reaches the handler exactly once whoever started the attempt.
                onSession?.(current);
                return { ok: true, session: current };
            }
            outcome.session?.close();
            if (outcome.result === 'unresponsive') unresponsive = true;
        }
        if (stopped) throw stoppedError();
        const failure = notes.join('\n');
        if (failure !== lastFailure) for (const note of notes) log(note);
        lastFailure = failure;
        if (candidates.length === 0) return { ok: false, reason: 'no_entries' };
        return { ok: false, reason: unresponsive ? 'unresponsive' : 'stale_only' };
    };

    /**
     * Every caller gets the same session while it is open, and concurrent callers share one attempt. After stop() it
     * rejects with BROKER_CLIENT_STOPPED instead of dialling: a stopped client has no cause to report.
     */
    const connect = () => {
        if (stopped) return Promise.reject(stoppedError());
        if (current) return Promise.resolve({ ok: true, session: current });
        attempt ??= connectOnce().finally(() => { attempt = null; });
        return attempt;
    };

    return {
        connect,
        listEntries,

        // Accepted residual "Failure records pile up where no broker ever succeeds": docs/local-agent-architecture.md#accepted-residuals.
        /**
         * Failure records newer than the newest live entry, the manifest write and this process's last successful
         * session. Older ones are settled by a later start, a repair or a working session, so they are deleted.
         * @param {{ manifestWrittenAtMs?: number | null }} [options]
         */
        async listFailureRecords({ manifestWrittenAtMs } = {}) {
            const newestEntry = (await listEntries())[0]?.startedAt;
            const cutoff = Math.max(newestEntry ?? -Infinity, manifestWrittenAtMs ?? -Infinity, lastSessionAtMs ?? -Infinity);
            const records = [];
            for (const name of await readDirectory()) {
                const pid = pidOf(RECORD_NAME, name);
                if (pid === null) continue;
                const read = await readJson(name);
                if (!read || !Number.isFinite(read.value.at)) continue;
                if (read.value.at < cutoff) await removeIfUnchanged(name, read.raw);
                else records.push({ pid, name: read.value.name, code: read.value.code, at: read.value.at });
            }
            return records.sort((a, b) => b.at - a.at);
        },

        /**
         * Re-lists the directory while no session is open. `onSession` receives every new session exactly once, whether
         * a tick or a connect() call opened it.
         */
        startBackgroundDiscovery({ intervalMs = 5000, onSession: handler }) {
            if (discoveryTimer || stopped) return;
            onSession = handler;
            const tick = () => {
                if (current || attempt || stopped) return;
                connect().catch((error) => {
                    if (!stopped) log(`e-comet broker client: discovery failed (${error?.code ?? error?.name ?? 'unknown'})`);
                });
            };
            discoveryTimer = setInterval(tick, intervalMs);
            discoveryTimer.unref?.();
            tick();
        },

        /** Ends discovery, any attempt in flight and the open session. */
        stop() {
            stopped = true;
            clearInterval(discoveryTimer);
            discoveryTimer = null;
            dialling?.destroy();
            current?.close();
        },
    };
}
