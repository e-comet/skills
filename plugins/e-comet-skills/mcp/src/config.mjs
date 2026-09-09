import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLocalStateDir, resolvePeerTokenDir } from './state-paths.mjs';
import { resolveStorageLayout } from './storage-layout.mjs';

const readBuildVersion = () => {
    for (const metadataUrl of [new URL('../package.json', import.meta.url), new URL('../../.codex-plugin/plugin.json', import.meta.url)]) {
        try {
            const version = JSON.parse(readFileSync(metadataUrl, 'utf8')).version;
            if (typeof version === 'string' && version.length > 0) return version;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    throw new Error('Unable to resolve the local bridge build version');
};

export const HOST = '127.0.0.1';
const validPort = (value, fallback) => {
    // Port 0 is intentionally available only through test/development overrides so integration tests can reserve an ephemeral port.
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return fallback;
    const port = Number(value);
    return port <= 65535 ? port : fallback;
};
export const resolveBridgePort = ({ env = process.env } = {}) => {
    const mode = env.NODE_ENV;
    const allowOverride = mode === 'test' || mode === 'development';
    return allowOverride ? validPort(env.ECOMET_LOCAL_BRIDGE_PORT, 17361) : 17361;
};
export const PORT = resolveBridgePort();
export const EXTENSION_PATH = '/extension';
export const PEER_PATH = '/mcp-peer';
// Deliberately unchanged by the peer-token move: the `/mcp-peer` frames are wire-identical on both sides of
// it, and the compatibility promise in AGENTS.md is what keeps drain-and-takeover upgrades possible. The move
// is a change of pairing *secret*, not of protocol — on Windows a mixed pair reads two different token files
// and fails the proof, which correctly reports `authentication_failed`; the remedy after an upgrade is to
// restart both applications, as the release notes state. Raise this only when a frame actually changes shape.
//
// Peer-only: the Chrome extension never reads this field. Its contract pins `extensionProtocolVersion`.
export const CONTROL_PROTOCOL_VERSION = 1;
export const EXTENSION_PROTOCOL_VERSION = 4;
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-06-18'];
export const LATEST_MCP_PROTOCOL_VERSION = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
// 5: a build that can proxy indexed Ozon report packages must replace an already-running generation-4 primary;
// otherwise the capable secondary remains behind a primary that cannot advertise or route the package operation.
const DEFAULT_BRIDGE_GENERATION = 5;
export const resolveBridgeGeneration = ({ env = process.env } = {}) => {
    const mode = env.NODE_ENV;
    if (mode !== 'test' && mode !== 'development') return DEFAULT_BRIDGE_GENERATION;
    const generation = Number(env.ECOMET_LOCAL_BRIDGE_GENERATION);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : DEFAULT_BRIDGE_GENERATION;
};
export const BRIDGE_GENERATION = resolveBridgeGeneration();
export const BRIDGE_VERSION = readBuildVersion();
export const HANDOFF_RECONNECT_GRACE_MS = 2000;
// The grace a peer_handoff frame carries is peer-supplied input. Accepting it verbatim would let a single
// frame park this instance's listener arbitrarily far into the future, so observers clamp it to this ceiling.
export const HANDOFF_RECONNECT_GRACE_MAX_MS = 30_000;
export const HANDOFF_DRAIN_POLL_MS = 25;
export const EXTENSION_READINESS_WAIT_MS = 2000;
export const PEER_RECONNECT_BASE_MS = 500;
// Reconnection never gives up. Once the exponential delay reaches this ceiling the secondary is degraded and
// keeps retrying at that cadence, so saturation is derived from the delay itself rather than from an attempt
// ceiling that would have to be kept in sync with the backoff curve.
export const PEER_RECONNECT_MAX_MS = 30_000;
// A tool call may pull the next attempt forward, but no more often than this.
export const PEER_WAKE_COOLDOWN_MS = 2000;
// A peer that has neither connected nor completed a handshake by now is wedged, not slow. Without this the
// socket would sit open and silent, emitting no close and so scheduling no further attempt.
export const PEER_HANDSHAKE_TIMEOUT_MS = 5000;
export const PEER_TOKEN_READ_TIMEOUT_MS = 1000;
export const PEER_TOKEN_CREATE_TIMEOUT_MS = 5000;
export const PEER_PENDING_UPGRADE_LIMIT = 16;
// close() only starts the closing handshake; a peer that never answers the Close frame would otherwise hold
// the TCP handle in CLOSING until the process exits — one leaked handle per retry against a silent listener.
// After this grace the client transport destroys its socket outright.
export const WS_CLIENT_CLOSE_GRACE_MS = 1000;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 45000;
// Cabinet restoration can include a portal ping, activation/reload and a retry. Keep its acknowledgement
// budget independent from the shorter per-request default so a successful export is not reported failed early.
export const AUTHORIZATION_RELEASE_TIMEOUT_MS = 75_000;
// Расширение отсчитывает свой таймаут от момента получения wb_fetch, то есть позже
// нас. Без запаса наш таймер всегда срабатывал первым, и типизированный
// WB_FETCH_TIMEOUT не доезжал до агента никогда.
export const REQUEST_TIMEOUT_GRACE_MS = 2000;
export const MIN_REQUEST_TIMEOUT_MS = 1000;
export const MAX_REQUEST_TIMEOUT_MS = 120000;
// A seller download streams the whole workbook as base64 frames, so its budget must cover the page-side
// encode plus every chunk rather than the single JSON round trip the generic default was sized for.
// Observed downloads finish in seconds, tens of seconds at worst, so this is headroom over the real
// worst case and not a capacity estimate — keep it tight enough that a wedged stream still surfaces.
export const SELLER_DOWNLOAD_TIMEOUT_MS = 60_000;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;
export const MAX_BROWSER_JOB_TOKEN_BYTES = 128 * 1024;
// Пределы дескриптора: те же значения применяет расширение, объявлены в манифесте.
export const MAX_BROWSER_JOB_URL_LENGTH = 4096;
export const MAX_BROWSER_JOB_TEXT_LENGTH = 512;
export const MAX_PRODUCT_ARTICLES = 20;
export const MAX_PRODUCT_CARD_PRODUCTS = 1000;
export const MAX_PRODUCT_CARD_REQUEST_UNITS = 2000;
export const PRODUCT_CARD_CONCURRENCY = 4;
export const MAX_SEARCH_PAGES_PER_QUERY = 50;
export const MAX_SEARCH_REQUEST_UNITS = 1000;
export const SEARCH_CONCURRENCY = 4;
export const MAX_CHECK_QUERIES = 100;
export const MAX_CHECK_PAGES_PER_QUERY = 10;
export const MAX_CHECK_SEARCH_REQUESTS = 1000;
// Keep per-job in-flight work conservative; the extension independently owns
// the service-worker-wide dispatch budget of 30 WB requests per 2.5 seconds.
export const CHECK_QUERY_CONCURRENCY = 4;
export const MAX_RECOMMENDATION_PAGES_PER_PRODUCT = 50;
export const MAX_RECOMMENDATION_REQUEST_UNITS = 1000;
export const MAX_SELLER_REVIEW_EXPORTS = 50;
export const MAX_SELLER_REVIEW_PHYSICAL_REPORTS = 100;
export const MAX_SELLER_REVIEW_POLLS_PER_REPORT = 100;
export const MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS = 2;
// Порог приёмки расширения. Здесь он объявлен только ради сверки контракта: применяет его
// расширение, а агент держит собственный, заведомо больший темп.
export const MIN_SELLER_OPERATION_INTERVAL_MS = 1000;
// Политика локального агента, а не подписанный лимит: расширение ограничивает, сколько операций
// вправе потратить скоуп, а это — как долго агент продолжает тратить их в отказывающий эндпоинт.
export const MAX_CONSECUTIVE_SELLER_POLL_FAILURES = 3;
export const MAX_CONSECUTIVE_SELLER_EXPORT_FAILURES = 3;
// Темп со стороны агента. Намеренно выше порога приёмки расширения: часы двух процессов и
// round-trip по WebSocket независимы, поэтому равные значения давали бы ложные срабатывания порога.
export const MIN_SELLER_OPERATION_AGENT_INTERVAL_MS = 1500;
export const RECOMMENDATION_PAGE_SIZE = 100;
export const RECOMMENDATION_CONCURRENCY = 4;
export const MAX_RETURNED_PRODUCTS = 200;
export const DEFAULT_RETURNED_PRODUCTS = 30;
export const MAX_IMAGE_ARTICLES = 20;
export const MAX_IMAGE_PHOTOS = 30;
export const DEFAULT_IMAGE_PHOTOS = 15;
export const MAX_IMAGE_BASKET = 60;
export const IMAGE_CONCURRENCY = 8;
// Переопределяются только в test/development — как порт и поколение моста. В проде
// это параметры хранения результатов пользователя, а не настройка.
export const positiveIntegerEnv = (name, fallback, { env = process.env } = {}) => {
    if (env.NODE_ENV !== 'test' && env.NODE_ENV !== 'development') return fallback;
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
export const AUTHORIZATION_SCOPE_MAX_MS = positiveIntegerEnv('ECOMET_AUTHORIZATION_SCOPE_MAX_MS', 10 * 60 * 1000);
// A seller export creates, polls and downloads many reports under one signed scope, so the generic
// single-round-trip ceiling would expire it mid-job. Its executor stops one poll cadence before this
// deadline, so the scope outlives the work instead of cancelling it.
export const SELLER_AUTHORIZATION_SCOPE_MAX_MS = positiveIntegerEnv('ECOMET_SELLER_AUTHORIZATION_SCOPE_MAX_MS', 60 * 60 * 1000);
// The executor reserves this much of the signed token for the tail of a job, and the reserve has to
// cover every download attempt the retry loop may make, not just the first. Reserving one attempt
// here while the executor reserves all of them is what left a token outliving the scope ceiling with
// a 60s gap between the job deadline and the scope timer: the second attempt then died as
// BROWSER_JOB_REAUTHORIZATION_REQUIRED instead of the accurate SELLER_JOB_DEADLINE_EXCEEDED.
export const SELLER_JOB_DOWNLOAD_RESERVE_MS = SELLER_DOWNLOAD_TIMEOUT_MS * MAX_SELLER_REVIEW_DOWNLOAD_ATTEMPTS;
export const sellerJobDurationMs = (scopeMaxMs, configuredDuration) => {
    if (!Number.isSafeInteger(scopeMaxMs) || scopeMaxMs <= 0) {
        throw new RangeError('Seller authorization scope maximum must be a positive safe integer');
    }
    const scopeCeiling = Math.max(1, scopeMaxMs - MIN_REQUEST_TIMEOUT_MS);
    const defaultDuration = scopeMaxMs - SELLER_JOB_DOWNLOAD_RESERVE_MS;
    const candidate = Number.isSafeInteger(configuredDuration) && configuredDuration > 0 ? configuredDuration : defaultDuration;
    return Math.min(Math.max(1, candidate > 0 ? candidate : scopeCeiling), scopeCeiling);
};
export const SELLER_JOB_MAX_DURATION_MS = sellerJobDurationMs(
    SELLER_AUTHORIZATION_SCOPE_MAX_MS,
    positiveIntegerEnv('ECOMET_SELLER_JOB_MAX_DURATION_MS', SELLER_AUTHORIZATION_SCOPE_MAX_MS - SELLER_JOB_DOWNLOAD_RESERVE_MS)
);
export const HANDOFF_MAX_DRAIN_MS = positiveIntegerEnv('ECOMET_HANDOFF_MAX_DRAIN_MS', 10_000);
export const MAX_ACTIVE_AUTHORIZATION_SCOPES = positiveIntegerEnv('ECOMET_MAX_ACTIVE_AUTHORIZATION_SCOPES', 32);
export const RESULT_RETENTION_MS = positiveIntegerEnv('ECOMET_RESULT_RETENTION_MS', 24 * 60 * 60 * 1000);
export const RESULT_ACTIVE_STALE_MS = positiveIntegerEnv('ECOMET_RESULT_ACTIVE_STALE_MS', 24 * 60 * 60 * 1000);
export const RESULT_MAX_TOTAL_BYTES = positiveIntegerEnv('ECOMET_RESULT_MAX_TOTAL_BYTES', 512 * 1024 * 1024);
export const RESULT_MAX_FILE_BYTES = positiveIntegerEnv('ECOMET_RESULT_MAX_FILE_BYTES', 64 * 1024 * 1024);
export const RESULT_MAX_FILES = positiveIntegerEnv('ECOMET_RESULT_MAX_FILES', 1000);
export const IMAGE_BASKET_BOUNDS = [
    143, 287, 431, 719, 1007, 1061, 1115, 1169, 1313, 1601, 1655, 1919, 2045, 2189, 2405, 2621, 2837, 3053, 3269, 3485, 3701, 3917, 4133,
    4349, 4565, 4877, 5189, 5501, 5813, 6125, 6437, 6749, 7061, 7373, 7685, 7997, 8309, 8741, 9173, 9605, 10373, 11141, 11909, 12677, 13445,
    14213,
];
export { resolveLocalStateDir, resolvePeerTokenDir };

// Result-directory relocation is intentionally user-configurable in production; quota and retention overrides above are not.
export const resolveResultDir = (options = {}) => resolveStorageLayout(options).results;
export const resolveArtifactDir = (options = {}) => resolveStorageLayout(options).marketplaceArtifacts;
export const resolveFeedbackArtifactDir = (options = {}) => resolveStorageLayout(options).feedbackArtifacts;

export const PEER_TOKEN_DIR = resolvePeerTokenDir();
export const LEGACY_LOCAL_STATE_DIR = resolveLocalStateDir();
export const LEGACY_RESULT_DIR = LEGACY_LOCAL_STATE_DIR;
export const LEGACY_ARTIFACT_DIR = join(LEGACY_LOCAL_STATE_DIR, 'artifacts');
export const LEGACY_FEEDBACK_ARTIFACT_DIR = join(LEGACY_LOCAL_STATE_DIR, 'feedback-artifacts');
export const STORAGE_LAYOUT = resolveStorageLayout();
export const RESULT_STORAGE = STORAGE_LAYOUT.results;
export const ARTIFACT_STORAGE = STORAGE_LAYOUT.marketplaceArtifacts;
export const FEEDBACK_ARTIFACT_STORAGE = STORAGE_LAYOUT.feedbackArtifacts;
export const ARTIFACT_RETENTION_MS = positiveIntegerEnv('ECOMET_ARTIFACT_RETENTION_MS', 24 * 60 * 60 * 1000);
export const ARTIFACT_MAX_TOTAL_BYTES = positiveIntegerEnv('ECOMET_ARTIFACT_MAX_TOTAL_BYTES', 512 * 1024 * 1024);
export const ARTIFACT_MAX_FILE_BYTES = positiveIntegerEnv('ECOMET_ARTIFACT_MAX_FILE_BYTES', 100 * 1024 * 1024);
export const ARTIFACT_MAX_JOB_BYTES = positiveIntegerEnv('ECOMET_ARTIFACT_MAX_JOB_BYTES', 500 * 1024 * 1024);
export const ARTIFACT_MAX_FILES = positiveIntegerEnv('ECOMET_ARTIFACT_MAX_FILES', 1000);
export const ARTIFACT_MAX_CHUNK_BYTES = 256 * 1024;
export const FEEDBACK_MAX_SUMMARY_LENGTH = 512;
// This is the remote report_issue contract. Every local validator must consume this one list so a report that
// prepares successfully cannot later be rejected while requesting its upload grant.
export const FEEDBACK_KINDS = Object.freeze(['bug', 'wrong_data', 'missing_capability', 'unclear_contract']);
export const FEEDBACK_MAX_BYTES = 32 * 1024 * 1024;
export const FEEDBACK_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES = positiveIntegerEnv('ECOMET_FEEDBACK_ARTIFACT_MAX_TOTAL_BYTES', 64 * 1024 * 1024);
export const FEEDBACK_ARTIFACT_MAX_FILES = positiveIntegerEnv('ECOMET_FEEDBACK_ARTIFACT_MAX_FILES', 100);
export const SESSION_NONCE = randomUUID();
export const OFFICIAL_EXTENSION_ID = 'apeallgchpgibifmbgefkhifidihmodh';
export const EXTENSION_ID_OVERRIDE_ENABLED =
    process.env.ECOMET_ENABLE_EXTENSION_ID_OVERRIDE === '1' && ['test', 'development'].includes(process.env.NODE_ENV);
const extensionIdOverride = new Set(
    (process.env.ECOMET_ALLOWED_EXTENSION_IDS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
);
export const ALLOWED_EXTENSION_IDS = EXTENSION_ID_OVERRIDE_ENABLED ? extensionIdOverride : new Set([OFFICIAL_EXTENSION_ID]);
