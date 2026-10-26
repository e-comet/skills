// The native messaging host. The browser starts it through the generated launcher as
// `node broker.mjs <origin> [--parent-window=N]`; it owns that browser profile's single extension session on stdio and
// serves local MCP clients on a per-user endpoint found through the rendezvous directory.
// Registration copies this file and the framing leaf beside it, so it imports only `node:` modules and that leaf.
import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import nodeNet from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CLIENT_BUFFER_LIMIT_BYTES,
    CLIENT_PROTOCOL_VERSION,
    EXTENSION_ORIGIN,
    EXTENSION_PROTOCOL_VERSION,
    MAX_FRAME_BYTES,
    MAX_HOST_TO_BROWSER_BYTES,
    createFrameReader,
    encodeFrame,
} from './native-framing.mjs';

const HELLO_ID = 'broker-hello';
const CLIENT_HELLO_TIMEOUT_MS = 5000;
// Bounds the final flush of session_end, so a client that stopped reading cannot keep an ended broker alive.
const SHUTDOWN_FLUSH_MS = 1000;
// The contract bounds the id the extension sees, broker prefix included.
const MAX_ID_LENGTH = 128;
// Only the broker speaks session control to the extension: a second hello would end the session for every client.
const SESSION_CONTROL = new Set(['hello', 'ping', 'pong']);
const REFUSAL_MESSAGES = {
    FRAME_TOO_LARGE: `The frame is over the ${MAX_HOST_TO_BROWSER_BYTES}-byte browser limit.`,
    FRAME_MALFORMED: 'The frame is not a JSON object with a string id.',
    SESSION_CONTROL_FORBIDDEN: 'Only the broker sends hello, ping and pong to the extension.',
    AUTHORIZATION_NOT_OWNED: 'This client does not hold the named authorization.',
    ID_TOO_LONG: `The id is over ${MAX_ID_LENGTH} characters with the broker prefix.`,
};

// Antivirus scanners hold freshly written files for a moment on Windows; registration retries the same refusals. This
// file imports only node: modules and native-framing.mjs, so the policy is repeated here rather than imported.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MS = 100;
const RENAME_RETRY_LIMIT_MS = 3000;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const brokerError = (code) => Object.assign(new Error(code), { code });
// The failure record names the startup step and keeps the system code, so a bug report shows where the broker stopped.
const stepFailure = (step) => (error) => {
    throw Object.assign(new Error(step), { name: step, code: error?.code ?? null });
};

// Accepted residual "Another Windows account can open the broker pipe": docs/local-agent-architecture.md#accepted-residuals.
/** The endpoint shapes clients accept: a random named pipe on Windows, a socket in a private `/tmp` directory elsewhere. */
export const createEndpointPath = async ({ platform, randomBytes, fs }) =>
    platform === 'win32'
        ? `\\\\.\\pipe\\e-comet-bridge-${randomBytes(16).toString('hex')}`
        : `${await fs.mkdtemp('/tmp/e-comet-')}/b.sock`;

// Written next to its target and renamed, so a reader never sees a partial file. Owner-only on POSIX: the entry holds
// the broker nonce, and the 0700 state directory is the first guard, not the only one.
const writeJsonAtomically = async ({ fs, randomBytes }, path, value) => {
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
        for (const deadline = Date.now() + RENAME_RETRY_LIMIT_MS; ;) {
            try {
                await fs.rename(temporary, path);
                return;
            } catch (error) {
                if (!RENAME_RETRY_CODES.has(error?.code) || Date.now() >= deadline) throw error;
                await new Promise((resolveDelay) => setTimeout(resolveDelay, RENAME_RETRY_MS));
            }
        }
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
};

/**
 * Runs one broker session. `brokerDir` is the directory of this file, `<state>/bridge/<version>`; it holds the
 * `broker.json` stamp registration writes. The rendezvous directory is `<state>/bridges`.
 * Resolves once the extension handshake has been started; `exit` is called exactly once when the broker ends.
 */
export async function runBroker({ argv, stdin, stdout, brokerDir, platform, now, randomBytes, net, fs, log, exit }) {
    const rendezvous = join(resolve(brokerDir, '..', '..'), 'bridges');
    const entryPath = join(rendezvous, `${process.pid}.json`);
    const sessionNonce = randomUUID();
    const brokerNonce = randomBytes(16).toString('hex');
    const pending = new Set();
    // Hello'd clients by id prefix `c<n>.`. A prefix is never reused, so a frame for a departed client finds none.
    const clients = new Map();
    // authorizationId → the client it was granted to.
    const owners = new Map();
    let clientCount = 0;
    let brokerRequestCount = 0;
    let brokerVersion = null;
    let facts = null;
    let browserContext = null;
    let server = null;
    let socketDir = null;
    let startup = null;
    let ending = false;

    // Accepted residual "A broker that fails before its own code runs": docs/local-agent-architecture.md#accepted-residuals.
    const writeFailureRecord = async (error) => {
        // Name and code only: a message or a stack can carry a path.
        const record = { name: typeof error?.name === 'string' ? error.name : 'Error', code: error?.code ?? null, at: now(), brokerVersion };
        try {
            await fs.mkdir(rendezvous, { recursive: true });
            await writeJsonAtomically({ fs, randomBytes }, join(rendezvous, `${process.pid}.failed`), record);
        } catch (writeError) {
            log(`e-comet broker: failure record not written (${writeError?.code ?? 'unknown'})`);
        }
    };

    const shutdown = async (exitCode, failure) => {
        if (ending) return;
        ending = true;
        await startup?.catch(() => undefined);
        for (const socket of pending) socket.destroy();
        const sessionEnd = encodeFrame({ type: 'session_end', reason: 'lost' });
        const closed = [...clients.values()].map(({ socket }) => new Promise((resolveClose) => {
            socket.once('close', resolveClose);
            socket.end(sessionEnd, () => socket.destroy());
        }));
        server?.close();
        if (failure) {
            log(`e-comet broker: ending with ${failure.code ?? failure.name}`);
            await writeFailureRecord(failure);
        }
        await fs.rm(entryPath, { force: true }).catch(() => undefined);
        if (socketDir) await fs.rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
        const flushTimer = setTimeout(() => { for (const { socket } of clients.values()) socket.destroy(); }, SHUTDOWN_FLUSH_MS);
        await Promise.all(closed);
        clearTimeout(flushTimer);
        exit(exitCode);
    };

    // Nobody waits for the answer: it comes back under the `b<n>.` id, which routes to no client.
    const release = (authorizationId) => {
        if (ending) return;
        stdout.write(encodeFrame({ id: `b${++brokerRequestCount}.release`, type: 'browser_job_authorization_release', payload: { authorizationId } }));
    };

    // A departed client's grants would hold the seller cabinet until their tokens expire, so they are released at once.
    // Returns whether the client was still known, so a caller can tell a client already being closed.
    const forget = (client) => {
        if (!clients.delete(client.prefix)) return false;
        for (const [authorizationId, owner] of owners) {
            if (owner !== client) continue;
            owners.delete(authorizationId);
            release(authorizationId);
        }
        return true;
    };

    // stdin is read continuously, so a client that stops reading is dropped instead of buffered without bound.
    const send = (client, message) => {
        client.socket.write(encodeFrame(message));
        if (client.socket.writableLength <= CLIENT_BUFFER_LIMIT_BYTES) return;
        forget(client);
        client.socket.destroy();
    };

    const refusal = (id, code) => ({ type: 'broker_refusal', id, code, message: REFUSAL_MESSAGES[code] });

    // A frame later in the same read can be refused again: a second end() would be a write after end, which destroys the
    // socket before the first refusal has been flushed.
    // Accepted residual "Refused client that never reads": docs/local-agent-architecture.md#accepted-residuals.
    const refuseAndClose = (client, id, code) => {
        if (!forget(client)) return;
        client.socket.end(encodeFrame(refusal(id, code)), () => client.socket.destroy());
    };

    const onClientFrame = (client, frame) => {
        if (ending || !clients.has(client.prefix)) return;
        const id = typeof frame.id === 'string' ? frame.id : null;
        if (SESSION_CONTROL.has(String(frame.type))) return void refuseAndClose(client, id, 'SESSION_CONTROL_FORBIDDEN');
        // The answer could not be routed back without a string id.
        if (id === null) return void refuseAndClose(client, null, 'FRAME_MALFORMED');
        const prefixed = `${client.prefix}${id}`;
        if (prefixed.length > MAX_ID_LENGTH) return void send(client, refusal(id, 'ID_TOO_LONG'));
        const authorizationId = isRecord(frame.payload) ? frame.payload.authorizationId : undefined;
        if (authorizationId !== undefined && owners.get(authorizationId) !== client) {
            return void send(client, refusal(id, 'AUTHORIZATION_NOT_OWNED'));
        }
        const encoded = encodeFrame({ ...frame, id: prefixed });
        if (encoded.readUInt32LE(0) > MAX_HOST_TO_BROWSER_BYTES) return void refuseAndClose(client, id, 'FRAME_TOO_LARGE');
        stdout.write(encoded);
        // The client released this grant itself, so it is not released again when the client leaves.
        if (frame.type === 'browser_job_authorization_release') owners.delete(authorizationId);
    };

    // Every extension frame for a request, results as well as stream, ack and phase frames, carries its request id.
    // Accepted residual "Disconnected diagnostic requester": docs/local-agent-architecture.md#accepted-residuals.
    const routeToClient = (frame) => {
        const id = typeof frame.id === 'string' ? frame.id : '';
        const dot = id.indexOf('.');
        const client = clients.get(id.slice(0, dot + 1));
        const result = frame.type === 'browser_job_authorize_result' && isRecord(frame.payload) && !frame.payload.error ? frame.payload : null;
        const granted = isRecord(result?.authorization) ? result.authorization.authorizationId : undefined;
        if (isText(granted)) {
            if (!client) return void release(granted);
            owners.set(granted, client);
        }
        if (client) send(client, { ...frame, id: id.slice(dot + 1) });
    };

    const onConnection = (socket) => {
        socket.on('error', () => undefined);
        if (ending) return void socket.destroy();
        pending.add(socket);
        let client = null;
        // Nothing is written on a connection before its valid hello, not even a refusal.
        const helloTimer = setTimeout(() => socket.destroy(), CLIENT_HELLO_TIMEOUT_MS);
        const reader = createFrameReader({
            maxBytes: MAX_HOST_TO_BROWSER_BYTES,
            onFrame: (frame) => {
                if (client) return void onClientFrame(client, frame);
                if (!pending.delete(socket)) return;
                clearTimeout(helloTimer);
                const version = /** @type {number} */ (frame.clientProtocolVersion);
                if (ending || frame.type !== 'client_hello' || !Number.isSafeInteger(version) || version < 1) {
                    return void socket.destroy();
                }
                client = { socket, prefix: `c${++clientCount}.` };
                clients.set(client.prefix, client);
                send(client, {
                    type: 'broker_hello',
                    brokerNonce,
                    brokerVersion,
                    clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
                    extension: facts,
                    session: { browserContext },
                });
            },
            // A length-prefixed stream cannot resynchronise after a bad frame.
            onError: (error) => (client ? refuseAndClose(client, null, error.code) : socket.destroy()),
        });
        socket.on('data', (chunk) => reader.push(chunk));
        socket.on('close', () => {
            clearTimeout(helloTimer);
            pending.delete(socket);
            if (client) forget(client);
        });
    };

    const startSession = async () => {
        const endpoint = await createEndpointPath({ platform, randomBytes, fs }).catch(stepFailure('Endpoint'));
        if (platform !== 'win32') socketDir = dirname(endpoint);
        server = net.createServer(onConnection);
        await new Promise((resolveListen, rejectListen) => {
            server.on('error', rejectListen);
            server.listen(endpoint, resolveListen);
        }).catch(stepFailure('Listen'));
        if (ending) return;
        await fs.mkdir(rendezvous, { recursive: true })
            .then(() => writeJsonAtomically({ fs, randomBytes }, entryPath, {
                endpoint,
                pid: process.pid,
                brokerNonce,
                brokerVersion,
                browser: facts.browser,
                extensionVersion: facts.extensionVersion,
                startedAt: now(),
            }))
            .catch(stepFailure('EntryWrite'));
    };

    const onExtensionFrame = (frame) => {
        if (ending) return;
        if (!facts) {
            const ack = frame.payload;
            if (frame.type !== 'hello_ack' || frame.id !== HELLO_ID || !isRecord(ack) ||
                ack.sessionNonce !== sessionNonce || ack.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
                return void shutdown(1, brokerError('HELLO_ACK_INVALID'));
            }
            facts = {
                extensionVersion: typeof ack.extensionVersion === 'string' ? ack.extensionVersion : null,
                capabilities: Array.isArray(ack.capabilities) ? ack.capabilities.filter((name) => typeof name === 'string') : [],
                protocolVersion: ack.protocolVersion,
                browser: typeof ack.browser === 'string' ? ack.browser : 'unknown',
            };
            startup = startSession();
            startup.catch((error) => shutdown(1, error));
            return;
        }
        if (frame.type !== 'ping') return void routeToClient(frame);
        stdout.write(encodeFrame({ id: frame.id, type: 'pong', payload: { at: now() } }));
        if (isRecord(frame.payload) && isRecord(frame.payload.browserContext)) {
            browserContext = frame.payload.browserContext;
            for (const client of clients.values()) send(client, { type: 'session_state', browserContext });
        }
    };

    let stamp;
    try {
        stamp = JSON.parse(await fs.readFile(join(brokerDir, 'broker.json'), 'utf8').catch(stepFailure('StampRead')));
    } catch (error) {
        return shutdown(1, error);
    }
    if (!isText(stamp?.version)) return shutdown(1, brokerError('STAMP_INVALID'));
    brokerVersion = stamp.version;
    // Only a development stamp, which registration writes for injected or development runs, widens the origin; one
    // without an origin accepts none.
    const allowedOrigin = stamp.development === true ? stamp.allowedOrigin : EXTENSION_ORIGIN;
    if (!isText(allowedOrigin) || argv[2] !== allowedOrigin) return shutdown(2, brokerError('ORIGIN_MISMATCH'));

    // Only a frame the reader refuses is our failure. A read or write error on stdio is the browser closing the port
    // (an extension reload, the browser quitting), like the end of stdin: a write racing that close must not leave a
    // failure record behind for a seller who simply closed the browser.
    const reader = createFrameReader({
        maxBytes: MAX_FRAME_BYTES,
        onFrame: onExtensionFrame,
        onError: () => void shutdown(1, brokerError('STDIO_FRAMING')),
    });
    const portClosed = () => void shutdown(0);
    stdout.on('error', portClosed);
    stdin.on('error', portClosed);
    stdin.on('data', (chunk) => { if (!ending) reader.push(chunk); });
    stdin.on('end', portClosed);
    // Accepted residual "Open extension tabs delay a newer broker": docs/local-agent-architecture.md#accepted-residuals.
    stdout.write(encodeFrame({
        id: HELLO_ID,
        type: 'hello',
        payload: {
            protocolVersion: EXTENSION_PROTOCOL_VERSION,
            sessionNonce,
            clientName: 'e-comet-broker',
            clientVersion: brokerVersion,
            browserJobRejectionVersion: 1,
        },
    }));
}

const isEntryPoint = (invokedPath) => {
    if (typeof invokedPath !== 'string' || invokedPath.length === 0) return false;
    const modulePath = fileURLToPath(import.meta.url);
    const invoked = resolve(invokedPath);
    if (invoked === modulePath) return true;
    try { return realpathSync(invoked) === modulePath; } catch { return false; }
};

if (isEntryPoint(process.argv[1])) {
    runBroker({
        argv: process.argv,
        stdin: process.stdin,
        stdout: process.stdout,
        brokerDir: dirname(fileURLToPath(import.meta.url)),
        platform: process.platform,
        now: Date.now,
        randomBytes: cryptoRandomBytes,
        net: nodeNet,
        fs: fsPromises,
        log: (line) => process.stderr.write(`${line}\n`),
        exit: (code) => process.exit(code),
    }).catch(() => process.exit(1));
}
