import { request as httpsRequest } from 'node:https';

const MAX_UPLOAD_URL_BYTES = 8 * 1024;
const MAX_REQUIRED_HEADERS = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_UPLOAD_TIMEOUT_MS = 30_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

class FeedbackUploadError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'FeedbackUploadError';
        this.code = code;
    }
}

const grantInvalid = () => new FeedbackUploadError('UPLOAD_GRANT_INVALID', 'The feedback upload grant is invalid or has expired.');
const rejected = () => new FeedbackUploadError('UPLOAD_REJECTED', 'The feedback archive upload was rejected by the storage service.');
const uncertain = () => new FeedbackUploadError('UPLOAD_UNCERTAIN', 'The feedback archive upload outcome is uncertain.');

/** @param {{ uploadUrl?: string, requiredHeaders?: Record<string, string>, expiresAt?: number, bytes?: Buffer }} grant @param {() => number} now */
const assertGrant = ({ uploadUrl, requiredHeaders, expiresAt, bytes }, now) => {
    if (typeof uploadUrl !== 'string' || Buffer.byteLength(uploadUrl, 'utf8') === 0 || Buffer.byteLength(uploadUrl, 'utf8') > MAX_UPLOAD_URL_BYTES) {
        throw grantInvalid();
    }
    let target;
    try {
        target = new URL(uploadUrl);
    } catch {
        throw grantInvalid();
    }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw grantInvalid();
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw grantInvalid();
    // Signed grants use Unix seconds, matching the rest of the browser-job authorization protocol.
    if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= now()) throw grantInvalid();
    if (!requiredHeaders || typeof requiredHeaders !== 'object' || Array.isArray(requiredHeaders)) throw grantInvalid();
    const entries = Object.entries(requiredHeaders);
    if (entries.length > MAX_REQUIRED_HEADERS) throw grantInvalid();
    const seen = new Set();
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [name, value] of entries) {
        const normalized = name.toLowerCase();
        if (
            !HEADER_NAME.test(name) ||
            Buffer.byteLength(name, 'utf8') > MAX_HEADER_NAME_BYTES ||
            typeof value !== 'string' ||
            Buffer.byteLength(value, 'utf8') > MAX_HEADER_VALUE_BYTES ||
            seen.has(normalized)
        ) {
            throw grantInvalid();
        }
        if (normalized === 'transfer-encoding') throw grantInvalid();
        if (normalized === 'content-length' && value !== String(bytes.length)) throw grantInvalid();
        seen.add(normalized);
        headers[name] = value;
    }
    if (!seen.has('content-length')) headers['Content-Length'] = String(bytes.length);
    return { target, headers };
};

/**
 * Sends one immutable feedback archive to one signed S3-compatible HTTPS URL.
 * @param {{ uploadUrl?: string, requiredHeaders?: Record<string, string>, expiresAt?: number, bytes?: Buffer }} grant
 * @param {{ requestImpl?: typeof httpsRequest, now?: () => number, timeoutMs?: number, setTimeoutImpl?: (callback: () => void, milliseconds: number) => unknown, clearTimeoutImpl?: (timer: unknown) => void }} options
 */
export const putFeedbackArchive = async (grant, options = {}) => {
    const { requestImpl = httpsRequest, now = Date.now, timeoutMs = 15_000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = options;
    if (typeof requestImpl !== 'function' || typeof now !== 'function' || typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_UPLOAD_TIMEOUT_MS) {
        throw grantInvalid();
    }
    const { target, headers } = assertGrant(grant ?? {}, now);
    return new Promise((resolve, reject) => {
        let settled = false;
        let wallTimer;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (wallTimer !== undefined) clearTimeoutImpl(wallTimer);
            callback(value);
        };
        let request;
        try {
            // ClientRequest.setTimeout starts only after a socket exists. This deadline also covers DNS, TCP,
            // and TLS stalls before that event can be armed.
            wallTimer = setTimeoutImpl(() => {
                try {
                    request?.destroy();
                } finally {
                    finish(reject, uncertain());
                }
            }, timeoutMs);
            request = requestImpl(
                {
                    protocol: 'https:',
                    hostname: target.hostname,
                    port: target.port || undefined,
                    path: `${target.pathname}${target.search}`,
                    method: 'PUT',
                    headers,
                },
                (response) => {
                    // A valid status line is the storage service's definitive answer. Body draining is cleanup only;
                    // a later abort must not downgrade an accepted or rejected upload to an uncertain outcome.
                    response.once('aborted', () => undefined);
                    response.once('error', () => undefined);
                    response.resume?.();
                    if (!Number.isInteger(response.statusCode) || response.statusCode < 100 || response.statusCode > 599) {
                        finish(reject, uncertain());
                    } else if ([200, 201, 204].includes(response.statusCode)) {
                        finish(resolve, { status: 'uploaded' });
                    } else {
                        finish(reject, rejected());
                    }
                }
            );
            request.once('error', () => finish(reject, uncertain()));
            request.setTimeout(timeoutMs, () => {
                try {
                    request.destroy();
                } catch {
                    finish(reject, uncertain());
                }
            });
            request.end(grant.bytes);
        } catch {
            finish(reject, uncertain());
        }
    });
};
