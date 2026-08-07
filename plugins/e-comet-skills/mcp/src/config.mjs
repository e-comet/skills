import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

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
export const CONTROL_PROTOCOL_VERSION = 1;
export const EXTENSION_PROTOCOL_VERSION = 1;
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-06-18'];
export const LATEST_MCP_PROTOCOL_VERSION = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
const DEFAULT_BRIDGE_GENERATION = 2;
export const resolveBridgeGeneration = ({ env = process.env } = {}) => {
    const mode = env.NODE_ENV;
    if (mode !== 'test' && mode !== 'development') return DEFAULT_BRIDGE_GENERATION;
    const generation = Number(env.ECOMET_LOCAL_BRIDGE_GENERATION);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : DEFAULT_BRIDGE_GENERATION;
};
export const BRIDGE_GENERATION = resolveBridgeGeneration();
export const BRIDGE_VERSION = readBuildVersion();
export const HANDOFF_RECONNECT_GRACE_MS = 2000;
export const HANDOFF_DRAIN_POLL_MS = 25;
export const EXTENSION_READINESS_WAIT_MS = 2000;
export const PEER_RECONNECT_BASE_MS = 500;
export const PEER_RECONNECT_MAX_MS = 30_000;
export const PEER_RECONNECT_MAX_ATTEMPTS = 8;
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 45000;
// Расширение отсчитывает свой таймаут от момента получения wb_fetch, то есть позже
// нас. Без запаса наш таймер всегда срабатывал первым, и типизированный
// WB_FETCH_TIMEOUT не доезжал до агента никогда.
export const REQUEST_TIMEOUT_GRACE_MS = 2000;
export const MIN_REQUEST_TIMEOUT_MS = 1000;
export const MAX_REQUEST_TIMEOUT_MS = 120000;
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
export const MAX_RECOMMENDATION_PAGES_PER_PRODUCT = 50;
export const MAX_RECOMMENDATION_REQUEST_UNITS = 1000;
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
export const resolveLocalStateDir = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
    if (platform === 'win32') {
        return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'e-comet', 'local-agent');
    }
    if (platform === 'darwin') {
        return posix.join(home, 'Library', 'Application Support', 'e-comet', 'local-agent');
    }
    return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'e-comet', 'local-agent');
};

// Result-directory relocation is intentionally user-configurable in production; quota and retention overrides above are not.
export const resolveResultDir = (options = {}) =>
    options.env?.ECOMET_LOCAL_AGENT_RESULT_DIR || (!options.env && process.env.ECOMET_LOCAL_AGENT_RESULT_DIR) || resolveLocalStateDir(options);

export const LOCAL_STATE_DIR = resolveLocalStateDir();
export const RESULT_DIR = resolveResultDir();
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
