import { MAX_FRAME_BYTES } from './config.mjs';
import { ToolExecutionError } from './tool-errors.mjs';

export const encodeFrame = (payload, opcode = 0x1) => {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;

    if (data.length < 126) {
        header = Buffer.from([0x80 | opcode, data.length]);
    } else if (data.length <= 0xffff) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(data.length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
    }

    return Buffer.concat([header, data]);
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


export const parseFrames = (state, chunk, onMessage, onClose) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);

    while (state.buffer.length >= 2) {
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

        if (!masked) {
            throw new Error('Client WebSocket frames must be masked');
        }
        if (length === 126) {
            if (state.buffer.length < 4) return;
            length = state.buffer.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (state.buffer.length < 10) return;
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

        const frameLength = offset + 4 + length;
        if (state.buffer.length < frameLength) return;

        const mask = state.buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(state.buffer.subarray(offset + 4, frameLength));
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
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
            }
        } else if (opcode === 0x1) {
            if (state.fragmentOpcode) {
                throw new Error('Received a new data frame before fragmented message completion');
            }
            if (fin) {
                onMessage(payload.toString('utf8'));
            } else {
                state.fragmentOpcode = opcode;
                state.fragments = [payload];
                state.fragmentBytes = payload.length;
            }
        } else if (opcode === 0x8) {
            let closeFrameSent = false;
            if (!state.socket.destroyed && state.socket.writable) {
                state.socket.end(encodeFrame(payload, 0x8));
                closeFrameSent = true;
            }
            onClose(closeFrameSent);
            return;
        } else if (opcode === 0x9) {
            if (!state.socket.destroyed && state.socket.writable) {
                state.socket.write(encodeFrame(payload, 0x0a));
            }
        } else if (opcode === 0x0a) {
            state.awaitingPong = false;
        }
    }
};
