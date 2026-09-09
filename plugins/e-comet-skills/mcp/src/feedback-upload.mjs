import { request as httpsRequest } from 'node:https';
import { validateHeaderValue } from 'node:http';
import { recordFeedbackHttpStatus, withFeedbackOperation } from './feedback-diagnostics.mjs';

import { FEEDBACK_MAX_BYTES } from './config.mjs';

const MAX_UPLOAD_URL_BYTES = 8 * 1024;
const MAX_REQUIRED_HEADERS = 32;
const MAX_HEADER_NAME_BYTES = 128;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_UPLOAD_TIMEOUT_MS = 180_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

class FeedbackUploadError extends Error {
    constructor(code, message, cause = undefined) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'FeedbackUploadError';
        this.code = code;
    }
}

const grantInvalid = (cause = undefined) => new FeedbackUploadError('UPLOAD_GRANT_INVALID', 'The feedback upload grant is invalid or has expired.', cause);
const rejected = (status) => {
    const error = new FeedbackUploadError('UPLOAD_REJECTED', 'The feedback archive upload was rejected by the storage service.');
    recordFeedbackHttpStatus(error, status);
    return error;
};
const uncertain = (cause = undefined) => new FeedbackUploadError('UPLOAD_UNCERTAIN', 'The feedback archive upload outcome is uncertain.', cause);
const timeout = () => Object.assign(new Error('Feedback upload deadline elapsed.'), { code: 'ETIMEDOUT', feedbackReason: 'network_timeout' });

/** @param {{ uploadUrl?: string, requiredHeaders?: Record<string, string>, expiresAt?: number, bytes?: Buffer }} grant @param {() => number} now */
const assertGrant = ({ uploadUrl, requiredHeaders, expiresAt, bytes }, now, maxBytes) => {
    if (typeof uploadUrl !== 'string' || Buffer.byteLength(uploadUrl, 'utf8') === 0 || Buffer.byteLength(uploadUrl, 'utf8') > MAX_UPLOAD_URL_BYTES) {
        throw grantInvalid();
    }
    let target;
    try {
        target = new URL(uploadUrl);
    } catch (error) {
        throw grantInvalid(error);
    }
    if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw grantInvalid();
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maxBytes) throw grantInvalid();
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
        // WHY: reject deterministic header serialization errors before request creation, not as uncertain delivery.
        try { validateHeaderValue(name, value); } catch (error) {
            const invalid = grantInvalid(error);
            Object.defineProperty(invalid, 'feedbackReason', { value: 'invalid_headers' });
            throw invalid;
        }
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
 * @param {{ requestImpl?: typeof httpsRequest, now?: () => number, timeoutMs?: number, maxBytes?: number, setTimeoutImpl?: (callback: () => void, milliseconds: number) => unknown, clearTimeoutImpl?: (timer: unknown) => void }} options
 */
export const putFeedbackArchive = async (grant, options = {}) => {
    const { requestImpl = httpsRequest, now = Date.now, timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS, maxBytes = FEEDBACK_MAX_BYTES, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = options;
    if (typeof requestImpl !== 'function' || typeof now !== 'function' || typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_UPLOAD_TIMEOUT_MS || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > FEEDBACK_MAX_BYTES) {
        throw grantInvalid();
    }
    let validated;
    try { validated = assertGrant(grant ?? {}, now, maxBytes); } catch (error) { throw withFeedbackOperation(error, 'grant_validation'); }
    const { target, headers } = validated;
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
                finish(reject, uncertain(timeout()));
                try {
                    request?.destroy();
                } catch { /* Request cleanup cannot alter the observed timeout. */ }
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
                        finish(reject, rejected(response.statusCode));
                    }
                }
            );
            request.once('error', (error) => finish(reject, uncertain(error)));
            request.setTimeout(timeoutMs, () => {
                finish(reject, uncertain(timeout()));
                try {
                    request.destroy();
                } catch { /* Request cleanup cannot alter the observed timeout. */ }
            });
            request.end(grant.bytes);
        } catch (error) {
            finish(reject, uncertain(error));
        }
    });
};
