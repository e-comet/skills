import { randomBytes } from 'node:crypto';
import { request } from 'node:http';

import { WS_CLIENT_CLOSE_GRACE_MS } from './config.mjs';
import {
    encodeMaskedFrame,
    parseFrames,
    resetFrameBuffer,
    websocketAccept,
    WS_CLOSED,
    WS_CLOSING,
    WS_CONNECTING,
    WS_OPEN,
} from './websocket.mjs';

/**
 * A WHATWG-shaped WebSocket client that owns its TCP transport.
 *
 * The platform WebSocket cannot serve as the peer client: its close() only *starts* the closing handshake,
 * and a peer that accepts the upgrade and never answers the Close frame leaves that socket in CLOSING
 * forever with no force-destroy — one TCP handle leaked per reconnect attempt against a silent listener,
 * accumulating until the process exits. Owning the `net.Socket` makes every path into CLOSING arm a bounded
 * destroy, so a wedged peer costs one grace period, never a handle.
 *
 * The surface mirrors the WHATWG socket exactly as far as the bridge uses it: numeric `readyState`
 * (compared against the `WS_*` constants in `./websocket.mjs`, never the platform `WebSocket` global),
 * `send`, `close`, and `addEventListener` for `open`, `message` (with `event.data`), `close`, and
 * `error` — including `{ once: true }`.
 */
export const connectWebSocket = (url, { closeGraceMs = WS_CLIENT_CLOSE_GRACE_MS } = {}) => {
    const target = new URL(url);
    const key = randomBytes(16).toString('base64');
    const expectedAccept = websocketAccept(key);

    /** @type {Map<string, Set<{ listener: (event: any) => void, once: boolean }>>} */
    const listeners = new Map();
    // Dispatched asynchronously, as the WHATWG socket does: a close() that emits inside the caller's own
    // stack would race listeners the caller has not attached yet.
    const emit = (type, event) => {
        queueMicrotask(() => {
            const entries = listeners.get(type);
            if (!entries) return;
            for (const entry of [...entries]) {
                if (entry.once) entries.delete(entry);
                try {
                    entry.listener(event);
                } catch (error) {
                    // One listener's failure must not swallow the listeners queued behind it, and a throw
                    // straight out of queueMicrotask is an uncaughtException that would take the whole MCP
                    // process down. Rethrown from its own microtask so the default crash-loud behaviour is
                    // preserved for a genuine bug, just without deciding the fate of the other listeners.
                    queueMicrotask(() => {
                        throw error;
                    });
                }
            }
        });
    };

    let readyState = WS_CONNECTING;
    /** @type {import('node:net').Socket | null} */
    let rawSocket = null;
    // Detaches the frame reader and drops what it had buffered. Set once the upgrade succeeds, because only
    // then is there a reader to stop.
    let stopReading = () => undefined;
    /** @type {NodeJS.Timeout | null} */
    let destroyTimer = null;
    let closeEmitted = false;

    // Terminal state; safe to reach more than once (a destroy can race the peer's own FIN).
    const finalize = () => {
        if (destroyTimer !== null) clearTimeout(destroyTimer);
        readyState = WS_CLOSED;
        if (closeEmitted) return;
        closeEmitted = true;
        emit('close', { type: 'close' });
    };

    // The reason this transport exists: entering CLOSING always arms the destroy the WHATWG socket lacks.
    // If the peer completes the closing handshake first, the socket's own 'close' event clears the timer.
    const enterClosing = () => {
        if (readyState >= WS_CLOSING) return;
        readyState = WS_CLOSING;
        destroyTimer = setTimeout(() => rawSocket?.destroy(), closeGraceMs);
        destroyTimer.unref?.();
    };

    const clientRequest = request({
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': key,
        },
    });

    clientRequest.on('upgrade', (response, socket, head) => {
        rawSocket = socket;
        socket.on('close', finalize);
        socket.on('error', (error) => emit('error', { type: 'error', error }));
        if (response.headers['sec-websocket-accept'] !== expectedAccept) {
            emit('error', { type: 'error', error: new Error('WebSocket upgrade failed the accept-key check') });
            socket.destroy();
            return;
        }

        const parseState = {
            socket,
            buffer: Buffer.alloc(0),
            fragmentOpcode: null,
            fragments: [],
            fragmentBytes: 0,
            awaitingPong: false,
        };
        const feed = (chunk) => {
            try {
                parseFrames(
                    parseState,
                    chunk,
                    (message) => emit('message', { type: 'message', data: message }),
                    // parseFrames already echoed the close frame (masked) and half-closed the socket; the
                    // peer still owes a FIN it may never send, so the bounded destroy is armed regardless.
                    // Nothing after a received Close is processed (RFC 6455 §5.5.1).
                    () => {
                        enterClosing();
                        stopReading();
                    },
                    { requireMasked: false, replyEncoder: encodeMaskedFrame }
                );
            } catch (error) {
                emit('error', { type: 'error', error });
                socket.destroy();
            }
        };
        // Either end can start the close, and both leave the socket readable for the whole destroy grace, so
        // both have to stop the reader: anything still buffered or arriving afterwards would otherwise be
        // dispatched as a message on a connection this transport has already declared CLOSING.
        stopReading = () => {
            socket.off('data', feed);
            resetFrameBuffer(parseState);
        };
        socket.on('data', feed);
        readyState = WS_OPEN;
        emit('open', { type: 'open' });
        if (head !== undefined && head.length > 0) feed(head);
    });

    // The peer answered with a plain HTTP response instead of switching protocols.
    clientRequest.on('response', (response) => {
        emit('error', { type: 'error', error: new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode}`) });
        clientRequest.destroy();
        finalize();
    });

    // Connection-stage failures (ECONNREFUSED, resets before the upgrade). After a successful upgrade the
    // socket is detached from the request and errors arrive on the socket handler above instead.
    clientRequest.on('error', (error) => {
        if (closeEmitted) return;
        emit('error', { type: 'error', error });
        finalize();
    });
    clientRequest.end();

    return {
        get readyState() {
            return readyState;
        },
        // Discards silently outside OPEN, matching the WHATWG socket for CLOSING/CLOSED; every caller
        // either checks readyState first or treats the connection as lost through the close event.
        send(data) {
            if (readyState !== WS_OPEN || rawSocket === null || rawSocket.destroyed || !rawSocket.writable) return;
            rawSocket.write(encodeMaskedFrame(data));
        },
        close() {
            if (readyState >= WS_CLOSING) return;
            if (rawSocket === null) {
                // Still CONNECTING: there is no WebSocket to close politely, only a request to abort.
                readyState = WS_CLOSING;
                clientRequest.destroy();
                finalize();
                return;
            }
            if (!rawSocket.destroyed && rawSocket.writable) rawSocket.write(encodeMaskedFrame(Buffer.alloc(0), 0x8));
            enterClosing();
            // Having sent the Close frame this side has nothing left to read: the peer's echo is not needed
            // (the bounded destroy covers a peer that never sends one), and the handshake deadline and the
            // protocol's own close path both reach here while a replacement connection may already be in
            // flight, where a late frame would otherwise be handled against superseded state.
            stopReading();
        },
        addEventListener(type, listener, { once = false } = {}) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add({ listener, once });
        },
    };
};
