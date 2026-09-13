import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { resolvePeerTokenDir } from './state-paths.mjs';

const HOOK_SECRET_FILE = 'feedback-hook-secret';
const HOOK_SECRET_BYTES = 32;
const HOOK_SIGNATURE_CONTEXT = 'e-comet-feedback-hook-signature-v1';
const HOOK_SIGNATURE_VERSION = 1;
const SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TRANSCRIPT_PATH_BYTES = 4096;
// One validated grant plus the fixed submit envelope stays far below this bound.
const MAX_SIGNED_MESSAGE_BYTES = 64 * 1024;
const SECRET_RETRY_DELAY_MS = 25;
const SECRET_RETRY_LIMIT = 20;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const wait = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
const bindingMismatch = () => Object.assign(
    new Error('The trusted feedback handoff claim could not be verified.'),
    { feedbackReason: 'claim_binding_mismatch' },
);
const secretUnavailable = (cause, code = 'ENOENT') => Object.assign(
    new Error('The trusted feedback hook secret is unavailable.', cause === undefined ? undefined : { cause }),
    { code: typeof cause?.code === 'string' ? cause.code : code },
);

// Prepare authenticates injected fields, not full report text, one-use or expiry. Captured bearer
// replay requires reconsidering the documented same-user boundary, not an implicit nonce store.
const validPrepareFields = (fields) => {
    const keys = Object.keys(fields);
    if (keys.length === 0) return true;
    return keys.length === 1 && keys[0] === 'transcriptPath'
        && typeof fields.transcriptPath === 'string' && fields.transcriptPath.length > 0
        && Buffer.byteLength(fields.transcriptPath, 'utf8') <= MAX_TRANSCRIPT_PATH_BYTES;
};

const validSubmitFields = (fields) => {
    const expected = ['artifactId', 'expectedSha256', 'expectedSize', 'expiresAt', 'objectKey', 'requiredHeaders', 'uploadUrl'];
    return Object.keys(fields).sort().join('\0') === expected.join('\0')
        && typeof fields.artifactId === 'string' && ARTIFACT_ID_PATTERN.test(fields.artifactId)
        && typeof fields.uploadUrl === 'string' && fields.uploadUrl.length > 0
        && typeof fields.objectKey === 'string' && fields.objectKey.length > 0
        && isRecord(fields.requiredHeaders)
        && Object.values(fields.requiredHeaders).every((value) => typeof value === 'string')
        && Number.isSafeInteger(fields.expiresAt) && fields.expiresAt > 0
        && Number.isSafeInteger(fields.expectedSize) && fields.expectedSize > 0
        && typeof fields.expectedSha256 === 'string' && SHA256_PATTERN.test(fields.expectedSha256);
};

const SIGNABLE_FIELDS = {
    prepare_e_comet_feedback: validPrepareFields,
    submit_e_comet_feedback: validSubmitFields,
};

/**
 * The hook signs exactly the fields it injects, so an unsignable shape is a binding failure, never a
 * silently weaker signature.
 * @param {{ tool?: string, sessionHash?: unknown, fields?: unknown }} request
 */
export const assertHookFields = ({ tool, sessionHash, fields }) => {
    const valid = typeof tool === 'string' && Object.hasOwn(SIGNABLE_FIELDS, tool) ? SIGNABLE_FIELDS[tool] : undefined;
    if (
        valid === undefined ||
        typeof sessionHash !== 'string' ||
        !SESSION_HASH_PATTERN.test(sessionHash) ||
        !isRecord(fields) ||
        !valid(fields)
    ) {
        throw bindingMismatch();
    }
};

const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
};

const signedMessage = ({ tool, sessionHash, fields }) => {
    // JSON member order is transport formatting; the signed value is the sorted canonical form.
    const message = JSON.stringify(canonical({ v: HOOK_SIGNATURE_VERSION, tool, session: sessionHash, fields }));
    if (Buffer.byteLength(message, 'utf8') > MAX_SIGNED_MESSAGE_BYTES) throw bindingMismatch();
    return message;
};

const assertSecret = (secret) => {
    if (!Buffer.isBuffer(secret) || secret.length !== HOOK_SECRET_BYTES) {
        throw new TypeError('The feedback hook secret must be 32 bytes');
    }
    return secret;
};

/**
 * @param {{ secret: Buffer, tool: string, sessionHash?: unknown, fields: Record<string, unknown> }} request
 * @returns {string} 43-character base64url HMAC-SHA256, matching the published hook-only field pattern.
 */
export const signHookFields = ({ secret, tool, sessionHash, fields }) => {
    assertHookFields({ tool, sessionHash, fields });
    return createHmac('sha256', assertSecret(secret))
        .update(HOOK_SIGNATURE_CONTEXT, 'utf8')
        .update('\0')
        .update(signedMessage({ tool, sessionHash, fields }), 'utf8')
        .digest('base64url');
};

/**
 * @param {{ secret: Buffer, tool: string, sessionHash?: unknown, fields: Record<string, unknown>, signature?: unknown }} request
 * @returns {boolean}
 */
export const verifyHookSignature = ({ secret, tool, sessionHash, fields, signature }) => {
    // A signature that does not even have the published shape is a binding failure of the request,
    // decided before any secret is consulted; only a well-formed signature can be merely wrong.
    if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) throw bindingMismatch();
    const expected = Buffer.from(signHookFields({ secret, tool, sessionHash, fields }), 'utf8');
    const candidate = Buffer.from(signature, 'utf8');
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
};

/**
 * The rendezvous the claim store used: shared profile state outside every per-application sandbox, so
 * a hook and a local MCP started by different hosts meet on one secret. On Windows an MSIX host
 * redirects %LOCALAPPDATA% into its package container, so the profile root is deliberate.
 * @param {Record<string, string | undefined>} [env]
 */
export const resolveHookSecretDirectory = (env = process.env) => {
    const configuredHome = env?.USERPROFILE || env?.HOME;
    const configuredStateRoot = env?.LOCALAPPDATA || env?.XDG_DATA_HOME || configuredHome;
    const pluginData = env?.CLAUDE_PLUGIN_DATA || env?.PLUGIN_DATA;
    if ((!configuredStateRoot || typeof configuredStateRoot !== 'string') && typeof pluginData === 'string' && pluginData.trim()) {
        return resolve(pluginData);
    }
    return resolvePeerTokenDir({
        env,
        ...(typeof configuredHome === 'string' && configuredHome.trim() ? { home: resolve(configuredHome) } : {}),
    });
};

/** @param {Record<string, string | undefined>} [env] */
export const resolveHookSecretPath = (env = process.env) => join(resolveHookSecretDirectory(env), HOOK_SECRET_FILE);

const readHookSecret = async (path) => {
    try {
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || !metadata.isFile()) throw secretUnavailable(undefined, 'EIO');
        if (metadata.size !== HOOK_SECRET_BYTES) return 'incomplete';
        const bytes = await readFile(path);
        return bytes.length === HOOK_SECRET_BYTES ? bytes : 'incomplete';
    } catch (error) {
        if (error?.code === 'ENOENT') return 'absent';
        throw secretUnavailable(error);
    }
};

// Removes the secret file only while it is observed absent or wrong-sized: a complete secret that
// another creator published meanwhile is never taken away from the signatures it already produced,
// and neither is one whose state a transient refusal (EACCES, EBUSY, EIO) left unknown.
const removeUnlessComplete = async (path) => {
    const current = await readHookSecret(path).catch(() => undefined);
    if (current !== 'absent' && current !== 'incomplete') return;
    await rm(path, { force: true }).catch(() => undefined);
};

/**
 * Reads the shared hook secret, creating it exclusively when `create` is set. Whoever asks first wins
 * the `wx` create; every later caller reads the same bytes, and nothing ever replaces them.
 * @param {{ env?: Record<string, string | undefined>, create?: boolean, retryDelayMs?: number, retryLimit?: number }} options
 * @returns {Promise<Buffer>}
 */
export const loadHookSecret = async ({
    env = process.env,
    create = false,
    retryDelayMs = SECRET_RETRY_DELAY_MS,
    retryLimit = SECRET_RETRY_LIMIT,
} = {}) => {
    const path = resolveHookSecretPath(env);
    let replaced = false;
    for (let attempt = 0; ; attempt += 1) {
        const existing = await readHookSecret(path);
        if (Buffer.isBuffer(existing)) return existing;
        if (existing === 'absent') {
            // A reader never mints a secret: an absent file proves no trusted hook signed here.
            if (!create) throw secretUnavailable();
            // A create that keeps reporting an absent file afterwards is a storage fault, not a race
            // another pass will settle: the same retry window bounds it as the incomplete path.
            if (attempt >= retryLimit) throw secretUnavailable(undefined, 'EIO');
            try {
                await mkdir(dirname(path), { recursive: true, mode: 0o700 });
                if (process.platform !== 'win32') await chmod(dirname(path), 0o700);
            } catch (error) {
                throw secretUnavailable(error);
            }
            try {
                await writeFile(path, randomBytes(HOOK_SECRET_BYTES), { flag: 'wx', mode: 0o600 });
            } catch (error) {
                if (error?.code !== 'EEXIST') {
                    // A partial file left by this failed write must not outlive it as a permanently
                    // wrong-sized secret; a complete one that appeared meanwhile is not ours.
                    await removeUnlessComplete(path);
                    throw secretUnavailable(error);
                }
            }
            // The mode was already set at creation, so this only tightens a umask-widened file and never
            // decides the outcome. The bytes returned are always read back from disk: two creators that
            // both replaced the same residue thereby agree on whichever file finally won.
            if (process.platform !== 'win32') await chmod(path, 0o600).catch(() => undefined);
            continue;
        }
        // Only a concurrent creator holds an incomplete file, and only for one write of 32 bytes.
        if (attempt >= retryLimit) {
            // A file still wrong-sized after the whole retry window is the residue of a failed write, not
            // a write in flight. The creator replaces it once; a reader still never mints a secret.
            if (create && !replaced) {
                replaced = true;
                await removeUnlessComplete(path);
                attempt = -1;
                continue;
            }
            throw secretUnavailable(undefined, 'EIO');
        }
        await wait(retryDelayMs);
    }
};
