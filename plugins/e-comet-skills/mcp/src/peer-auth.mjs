import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCAL_STATE_DIR } from './config.mjs';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_FILE = '.peer-token';
const PEER_AUTH_CONTEXT = 'e-comet-local-peer-auth-v1';
const TEMPORARY_TOKEN_STALE_MS = 24 * 60 * 60 * 1_000;
const TEMPORARY_TOKEN_PATTERN = /^\.peer-token\.\d+\.[a-f0-9]{16}\.tmp$/;
const ATOMIC_LINK_UNSUPPORTED_CODES = new Set(['EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']);
const DEFAULT_FILE_SYSTEM = { chmod, link, mkdir, open, readFile, readdir, rm, stat };

const normalizeToken = (value) => value.trim();
const restrictExistingTokenPermissions = async (tokenPath, fileSystem) => {
    if (process.platform === 'win32') {
        await fileSystem.chmod(tokenPath, 0o600).catch(() => undefined);
        return;
    }
    await fileSystem.chmod(tokenPath, 0o600);
};

const removeStaleTemporaryTokens = async (directory, fileSystem, now, staleMs) => {
    const entries = await fileSystem.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || !TEMPORARY_TOKEN_PATTERN.test(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
            const metadata = await fileSystem.stat(path);
            if (now - metadata.mtimeMs > staleMs) {
                await fileSystem.rm(path, { force: true });
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
};

export const peerTokensEqual = (actual, expected) => {
    if (typeof actual !== 'string' || typeof expected !== 'string') return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
};

export const createPeerAuthNonce = () => randomBytes(32).toString('base64url');

export const isValidPeerAuthNonce = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);

export const createPeerAuthProof = (peerToken, role, transcript) =>
    createHmac('sha256', peerToken)
        .update(PEER_AUTH_CONTEXT)
        .update('\0')
        .update(role)
        .update('\0')
        .update(transcript)
        .digest('base64url');

export const loadOrCreatePeerToken = async ({
    directory = LOCAL_STATE_DIR,
    invalidTokenRepairLimit = 2,
    fileSystem: fileSystemOverrides = {},
    waitForContention = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now = Date.now(),
    temporaryTokenStaleMs = TEMPORARY_TOKEN_STALE_MS,
} = {}) => {
    const fileSystem = { ...DEFAULT_FILE_SYSTEM, ...fileSystemOverrides };
    await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
        await fileSystem.chmod(directory, 0o700);
    }
    const cleanupNow = Number.isFinite(now) ? now : Date.now();
    const staleMs =
        Number.isFinite(temporaryTokenStaleMs) && temporaryTokenStaleMs >= 0 ? temporaryTokenStaleMs : TEMPORARY_TOKEN_STALE_MS;
    await removeStaleTemporaryTokens(directory, fileSystem, cleanupNow, staleMs);
    const tokenPath = join(directory, TOKEN_FILE);
    const repairLimit =
        Number.isSafeInteger(invalidTokenRepairLimit) && invalidTokenRepairLimit >= 0 ? Math.min(invalidTokenRepairLimit, 10) : 2;
    let repairAttempts = 0;
    for (;;) {
        try {
            const existing = normalizeToken(await fileSystem.readFile(tokenPath, 'utf8'));
            if (!TOKEN_PATTERN.test(existing)) {
                if (repairAttempts >= repairLimit) {
                    throw new Error('Corrupt local peer token could not be repaired');
                }
                repairAttempts += 1;
                await fileSystem.rm(tokenPath, { force: true });
                continue;
            }
            await restrictExistingTokenPermissions(tokenPath, fileSystem);
            return existing;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const token = randomBytes(32).toString('base64url');
        const temporaryTokenPath = `${tokenPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
        try {
            const handle = await fileSystem.open(temporaryTokenPath, 'wx', 0o600);
            try {
                await handle.writeFile(`${token}\n`, 'utf8');
            } finally {
                await handle.close();
            }
            try {
                await fileSystem.link(temporaryTokenPath, tokenPath);
                return token;
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    if (ATOMIC_LINK_UNSUPPORTED_CODES.has(error.code)) {
                        const unsupportedError = Object.assign(
                            new Error('The local state directory does not support secure atomic peer-token publication.', {
                                cause: error,
                            }),
                            { code: 'PEER_TOKEN_ATOMIC_PUBLISH_UNSUPPORTED' }
                        );
                        throw unsupportedError;
                    }
                    throw error;
                }
            }
            for (let attempt = 0; attempt < 20; attempt += 1) {
                await waitForContention(25);
                try {
                    const existing = normalizeToken(await fileSystem.readFile(tokenPath, 'utf8'));
                    if (TOKEN_PATTERN.test(existing)) return existing;
                } catch (readError) {
                    if (readError.code !== 'ENOENT') throw readError;
                }
            }
            if (repairAttempts >= repairLimit) {
                throw new Error('Corrupt local peer token could not be repaired');
            }
            repairAttempts += 1;
            continue;
        } finally {
            await fileSystem.rm(temporaryTokenPath, { force: true }).catch(() => undefined);
        }
    }
};
