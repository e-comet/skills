// The values only the bridge reads (refactor spec §7.5): the correlation broker's release timeout, deadline grace, default
// scope and lease cap, the profile probes' extension-log limits, and the registration origin with its development gate.
import { EXTENSION_ORIGIN } from '../native-framing.mjs';
// Cabinet restoration can include a portal ping, activation/reload and a retry. Keep its acknowledgement
// budget independent from the shorter per-request default so a successful export is not reported failed early.
export const AUTHORIZATION_RELEASE_TIMEOUT_MS = 75_000;
// Расширение отсчитывает свой таймаут от момента получения wb_fetch, то есть позже
// нас. Без запаса наш таймер всегда срабатывал первым, и типизированный
// WB_FETCH_TIMEOUT не доезжал до агента никогда.
export const REQUEST_TIMEOUT_GRACE_MS = 2000;
export const AUTHORIZATION_SCOPE_MAX_MS = 10 * 60 * 1000;
export const MAX_ACTIVE_AUTHORIZATION_SCOPES = 32;
// Bounds for reading the extension's own connection log from a browser profile on disk (profile/leveldb.mts), on the
// failure path only. The log value is at most 3,000 rows, about 1-2 MiB of JSON; LevelDB rolls its write-ahead log at a
// 4 MiB write buffer, so 8 MiB per file covers a full log or a large table; the rest of our storage's keys fit in
// 32 MiB, the total of the one pass that reads both log keys of a profile. A file or total over its limit is not read
// and the reader reports `truncated` instead of guessing. One profile is read: that of the browser the cause names.
// timeoutMs bounds every file read of that pass: a failing call already waits up to a minute for the broker and for
// the repair of its registration, so the read adds seconds, never another wait.
export const EXTENSION_LOG_LIMITS = { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024, timeoutMs: 2000 };
/**
 * The origin the broker registration admits: the published extension, or the first unpacked one a test or development
 * run names through the extension-id override. The override is honoured only under NODE_ENV test or development:
 * without the gate, another extension origin could start the broker in production.
 */
export const registrationOrigin = (env) => {
    if (env.ECOMET_ENABLE_EXTENSION_ID_OVERRIDE !== '1' || !['test', 'development'].includes(env.NODE_ENV ?? ''))
        return EXTENSION_ORIGIN;
    const [first] = (env.ECOMET_ALLOWED_EXTENSION_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    return first === undefined ? EXTENSION_ORIGIN : `chrome-extension://${first}/`;
};
