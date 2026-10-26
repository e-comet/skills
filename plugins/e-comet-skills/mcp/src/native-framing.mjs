// Leaf module: imports nothing, so the dependency-free broker can load it beside `broker.mjs`.
// `config.mjs` re-exports the shared constants from here instead of redefining them.

export const NATIVE_HOST_NAME = 'io.ecomet.bridge';
export const EXTENSION_ORIGIN = 'chrome-extension://apeallgchpgibifmbgefkhifidihmodh/';
export const EXTENSION_PROTOCOL_VERSION = 4;
export const CLIENT_PROTOCOL_VERSION = 1;
// Chrome refuses a host-to-browser message above 1 MiB. The broker applies the same bound to client frames it relays.
export const MAX_HOST_TO_BROWSER_BYTES = 1_048_576;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const CLIENT_BUFFER_LIMIT_BYTES = 64 * 1024 * 1024;

const HEADER_BYTES = 4;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** @param {unknown} message @returns {Buffer} uint32 little-endian byte length, then the UTF-8 JSON. */
export const encodeFrame = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
};

const frameError = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {{ maxBytes: number, onFrame: (message: Record<string, unknown>) => void, onError: (error: Error & { code: string }) => void }} options
 * `maxBytes` bounds the body length declared by the header. The error is reported once and the reader then ignores input.
 */
export const createFrameReader = ({ maxBytes, onFrame, onError }) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
    /** @type {Buffer[]} */
    let chunks = [];
    let buffered = 0;
    // Bytes that must be buffered before parsing can make progress: a header, then that frame's header plus body.
    let needed = HEADER_BYTES;
    let stopped = false;

    const fail = (code, message) => {
        stopped = true;
        chunks = [];
        buffered = 0;
        onError(frameError(code, message));
    };

    const parse = (body) => {
        try {
            const message = JSON.parse(utf8.decode(body));
            if (message !== null && typeof message === 'object' && !Array.isArray(message)) return message;
        } catch {
            // Reported below as one stable code.
        }
        return undefined;
    };

    return {
        /**
         * Not reentrant: `onFrame` and `onError` must not call `push` on the same reader.
         * @param {Uint8Array} chunk A Buffer or Uint8Array the caller does not mutate afterwards: it is kept until its frame completes.
         */
        push(chunk) {
            if (stopped) return;
            chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            buffered += chunk.byteLength;
            if (buffered < needed) return;
            // One concatenation per push that can make progress, then frames are read from it by offset.
            const data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
            let offset = 0;
            // Reset first: an onFrame that throws leaves the loop without setting it for the kept tail.
            needed = HEADER_BYTES;
            try {
                while (true) {
                    if (data.length - offset < HEADER_BYTES) {
                        needed = HEADER_BYTES;
                        return;
                    }
                    const bodyBytes = data.readUInt32LE(offset);
                    // Refused on the header alone, before any body byte is kept.
                    if (bodyBytes > maxBytes) return fail('FRAME_TOO_LARGE', `Frame of ${bodyBytes} bytes exceeds ${maxBytes}`);
                    if (data.length - offset < HEADER_BYTES + bodyBytes) {
                        needed = HEADER_BYTES + bodyBytes;
                        return;
                    }
                    const body = data.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + bodyBytes);
                    offset += HEADER_BYTES + bodyBytes;
                    const message = parse(body);
                    if (message === undefined) return fail('FRAME_MALFORMED', 'Frame is not a JSON object');
                    onFrame(message);
                }
            } finally {
                if (!stopped) {
                    // Keep only the unread tail, copied so a small tail does not pin the whole parent buffer.
                    const tail = offset === 0 ? data : Buffer.from(data.subarray(offset));
                    chunks = tail.length > 0 ? [tail] : [];
                    buffered = tail.length;
                }
            }
        },
    };
};
