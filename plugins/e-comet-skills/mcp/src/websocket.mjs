import { createHash, randomBytes } from 'node:crypto';

import { MAX_FRAME_BYTES } from './config.mjs';
import { ToolExecutionError } from './tool-errors.mjs';

// The WHATWG readyState values, spelled locally. Callers compare against these rather than the platform
// `WebSocket.*` constants: the peer transport is this package's own `connectWebSocket`, not a platform
// WebSocket, and that global is unflagged only from Node 22.4 while the package supports Node 22.0 —
// touching it there throws. They live here, beside the framing both sides share, so the bridge runtime
// depends on the protocol rather than on one concrete transport implementation.
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// RFC 6455 §4.2.2: both ends derive the same value, the server to answer an upgrade and the client to
// verify that answer, so one spelling keeps a correction to either side from missing the other.
export const websocketAccept = (key) => createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');

const frameHeader = (opcode, length, masked) => {
    const maskBit = masked ? 0x80 : 0x00;
    let header;
    if (length < 126) {
        header = Buffer.from([0x80 | opcode, maskBit | length]);
    } else if (length <= 0xffff) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = maskBit | 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x80 | opcode;
        header[1] = maskBit | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    return header;
};

export const encodeFrame = (payload, opcode = 0x1) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    return Buffer.concat([frameHeader(opcode, data.length, false), data]);
};

// Client-to-server frames MUST be masked (RFC 6455 §5.1); the server parser below enforces the same rule
// from its side, so the local client cannot speak to the local server through the unmasked encoder above.
export const encodeMaskedFrame = (payload, opcode = 0x1) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(data.length);
    for (let index = 0; index < data.length; index += 1) {
        masked[index] = data[index] ^ mask[index % 4];
    }
    return Buffer.concat([frameHeader(opcode, data.length, true), mask, masked]);
};
export const sendWs = (socket, message) => {
    if (!socket || socket.destroyed || !socket.writable) {
        // Propagating callers use this helper for the extension route; peer-control callers catch the error and treat it as route loss.
        throw new ToolExecutionError(
            'EXTENSION_DISCONNECTED',
            'The e-Comet Chrome extension is not connected. Open an authenticated Wildberries tab and retry.',
            'extension',
            true
        );
    }
    socket.write(encodeFrame(JSON.stringify(message)));
};


// The largest header this parser can face: 2 prefix bytes + 8 extended-length bytes + 4 mask bytes.
const HEADER_MAX_BYTES = 14;

// Everything received but not yet merged into `state.buffer`, so a frame that spans many reads is copied
// once instead of once per read. Appending each chunk to a single Buffer was quadratic in frame size: a
// 32 MB `peer_wb_fetch_result` arriving in 64 KB reads spent ~1.9 s in Buffer.concat and blocked the event
// loop for all of it. Lazily initialised so every existing parse-state literal keeps working unchanged.
const pendingChunks = (state) => {
    if (state.pending === undefined) {
        state.pending = [];
        state.pendingBytes = 0;
    }
    return state.pending;
};

const bufferedBytes = (state) => state.buffer.length + state.pendingBytes;

// Merges only as much as the caller actually needs: the header first, and the rest of a frame solely once
// the whole frame has arrived. A partial frame therefore costs no copying at all while it accumulates.
const materialize = (state, needed) => {
    if (state.buffer.length >= needed || state.pending.length === 0) return;
    const merged = [state.buffer];
    let mergedBytes = state.buffer.length;
    while (mergedBytes < needed && state.pending.length > 0) {
        const next = state.pending.shift();
        state.pendingBytes -= next.length;
        mergedBytes += next.length;
        merged.push(next);
    }
    state.buffer = Buffer.concat(merged, mergedBytes);
};

// Discards every unparsed byte. Callers that stop reading mid-stream — the client transport after a received
// Close frame — need both halves of the representation cleared, which is why this lives beside it.
export const resetFrameBuffer = (state) => {
    state.buffer = Buffer.alloc(0);
    state.pending = [];
    state.pendingBytes = 0;
};

// Defaults describe the server side of the connection: inbound frames must be masked and control replies go
// out unmasked. The client transport passes `requireMasked: false` (a masked server frame is a protocol
// violation it must fail on, RFC 6455 §5.1) and `replyEncoder: encodeMaskedFrame` so its close echoes and
// pongs stay legal client frames. `maxApplicationMessages` lets the extension route parse exactly one
// application message per turn so it can await its handler before the next frame is decoded; the count of
// messages delivered is returned so that caller can tell an empty parse from a delivered one.
export const parseFrames = (
    state,
    chunk,
    onMessage,
    onClose,
    { requireMasked = true, replyEncoder = encodeFrame, maxApplicationMessages = Infinity } = {}
) => {
    let applicationMessages = 0;
    if (chunk.length > 0) {
        pendingChunks(state).push(chunk);
        state.pendingBytes += chunk.length;
    } else {
        pendingChunks(state);
    }

    for (;;) {
        // Enough to read any header, or everything there is when that is less. The frame body is merged only
        // after the length below proves it has fully arrived.
        materialize(state, Math.min(HEADER_MAX_BYTES, bufferedBytes(state)));
        if (state.buffer.length < 2) return applicationMessages;
        const first = state.buffer[0];
        const second = state.buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if ((first & 0x70) !== 0) {
            throw new Error('Received WebSocket frame with reserved WebSocket bits set');
        }
        if (opcode === 0x2) {
            throw new Error('Binary WebSocket messages are not supported');
        }
        if (![0x0, 0x1, 0x8, 0x9, 0x0a].includes(opcode)) {
            throw new Error('Received a reserved WebSocket opcode');
        }

        if (requireMasked && !masked) {
            throw new Error('Client WebSocket frames must be masked');
        }
        if (!requireMasked && masked) {
            throw new Error('Server WebSocket frames must not be masked');
        }
        if (length === 126) {
            if (state.buffer.length < 4) return applicationMessages;
            length = state.buffer.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (state.buffer.length < 10) return applicationMessages;
            const bigLength = state.buffer.readBigUInt64BE(2);
            if (bigLength > BigInt(MAX_FRAME_BYTES)) {
                throw new Error('WebSocket frame is too large');
            }
            length = Number(bigLength);
            offset = 10;
        }
        if (length > MAX_FRAME_BYTES) {
            throw new Error('WebSocket frame is too large');
        }
        if (opcode >= 0x8) {
            if (!fin) throw new Error('Fragmented WebSocket control frame');
            if (length > 125) throw new Error('WebSocket control frame payload is too large');
        }

        const maskBytes = masked ? 4 : 0;
        const frameLength = offset + maskBytes + length;
        // Measured against everything received, not only what has been merged: a frame still arriving stays
        // in the chunk list untouched, and is copied once here when it is finally complete.
        if (bufferedBytes(state) < frameLength) return applicationMessages;
        materialize(state, frameLength);

        const payload = Buffer.from(state.buffer.subarray(offset + maskBytes, frameLength));
        if (masked) {
            const mask = state.buffer.subarray(offset, offset + 4);
            for (let index = 0; index < payload.length; index += 1) {
                payload[index] ^= mask[index % 4];
            }
        }
        state.buffer = state.buffer.subarray(frameLength);

        if (opcode === 0x0) {
            if (!state.fragmentOpcode) {
                throw new Error('Unexpected WebSocket continuation frame');
            }
            state.fragments.push(payload);
            state.fragmentBytes += payload.length;
            if (state.fragmentBytes > MAX_FRAME_BYTES) {
                throw new Error('Fragmented WebSocket message is too large');
            }
            if (fin) {
                const message = Buffer.concat(state.fragments, state.fragmentBytes);
                state.fragmentOpcode = null;
                state.fragments = [];
                state.fragmentBytes = 0;
                onMessage(message.toString('utf8'));
                applicationMessages += 1;
                if (applicationMessages >= maxApplicationMessages) return applicationMessages;
            }
        } else if (opcode === 0x1) {
            if (state.fragmentOpcode) {
                throw new Error('Received a new data frame before fragmented message completion');
            }
            if (fin) {
                onMessage(payload.toString('utf8'));
                applicationMessages += 1;
                if (applicationMessages >= maxApplicationMessages) return applicationMessages;
            } else {
                state.fragmentOpcode = opcode;
                state.fragments = [payload];
                state.fragmentBytes = payload.length;
            }
        } else if (opcode === 0x8) {
            let closeFrameSent = false;
            if (!state.socket.destroyed && state.socket.writable) {
                state.socket.end(replyEncoder(payload, 0x8));
                closeFrameSent = true;
            }
            onClose(closeFrameSent);
            return applicationMessages;
        } else if (opcode === 0x9) {
            if (!state.socket.destroyed && state.socket.writable) {
                state.socket.write(replyEncoder(payload, 0x0a));
            }
        } else if (opcode === 0x0a) {
            state.awaitingPong = false;
        }
    }
    return applicationMessages;
};
