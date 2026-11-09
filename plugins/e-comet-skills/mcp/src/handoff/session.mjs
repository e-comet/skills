import { createHash } from 'node:crypto';
// The longest session ID each flow accepts, in UTF-8 bytes (spec §7.3). The update hook keeps its own copy, because a
// host may copy only hooks/; tests/plugin-update-hook.test.mjs pins the two equal.
export const SESSION_ID_MAX_BYTES = { BROWSER_JOB: 512, FEEDBACK: 512, UPDATE: 1024 };
export const isValidSessionId = (sessionId, maxBytes) => typeof sessionId === 'string' && Buffer.byteLength(sessionId, 'utf8') >= 1 && Buffer.byteLength(sessionId, 'utf8') <= maxBytes;
// Stored state is keyed by this hash, never by the host's session ID itself.
export const hashSessionId = (sessionId) => createHash('sha256').update(sessionId, 'utf8').digest('hex');
