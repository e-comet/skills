import { posix, win32 } from 'node:path';
import { resolveLocalStateDir } from './state-paths.mjs';

const OUTPUT_SUBTREE = 'local-mcp-output-v2';
const UNEXPANDED_BRACED_PATH = /\$\{[^}]+\}/;
const UNEXPANDED_COMPONENT = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%)$/;

const pathApi = (platform) => (platform === 'win32' ? win32 : posix);
const unavailable = (reason) => Object.freeze({ state: 'unavailable', reason });

export class StorageUnavailableError extends Error {
    constructor(store, reason) {
        super('Local output storage is unavailable.');
        this.name = 'StorageUnavailableError';
        this.code = 'LOCAL_STORAGE_UNAVAILABLE';
        this.stage = 'storage';
        this.retryable = false;
        this.store = store;
        this.reason = reason;
    }
}

export const requireStorageTarget = (target, store) => {
    if (target?.state === 'ready') return target.path;
    throw new StorageUnavailableError(store, target?.reason ?? 'plugin_data_invalid');
};

const normalizedAbsolutePath = (value, platform) => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed !== value || UNEXPANDED_BRACED_PATH.test(trimmed)) return undefined;
    // Hosts and overrides provide literal paths. Bare variable markers must occupy
    // a whole component; '$' in a username and '%' in separate names are not expansion.
    const components = trimmed.split(platform === 'win32' ? /[\\/]/ : /\//);
    if (components.some(component => UNEXPANDED_COMPONENT.test(component))) return undefined;
    const api = pathApi(platform);
    if (!api.isAbsolute(trimmed)) return undefined;
    return api.resolve(trimmed);
};

const identity = (value, platform) => (platform === 'win32' ? value.toLowerCase() : value);

export const resolvePluginDataRoot = (env = process.env, platform = process.platform) => {
    // An empty declaration is invalid configuration, not an absent host variable:
    // silently falling back would relocate output the host explicitly tried to own.
    const candidates = [env?.PLUGIN_DATA, env?.CLAUDE_PLUGIN_DATA]
        .filter((value) => value !== undefined);
    if (candidates.length === 0) return unavailable('plugin_data_missing');
    const normalized = candidates.map((value) => normalizedAbsolutePath(value, platform));
    if (normalized.some((value) => value === undefined)) return unavailable('plugin_data_invalid');
    if (new Set(normalized.map((value) => identity(value, platform))).size !== 1) {
        return unavailable('plugin_data_conflict');
    }
    return Object.freeze({ state: 'ready', path: normalized[0] });
};

export const explicitOrPluginTarget = (explicitValue, pluginRoot, childName, platform = process.platform, backend = 'plugin_data') => {
    if (explicitValue !== undefined) {
        const path = normalizedAbsolutePath(explicitValue, platform);
        return path === undefined
            ? unavailable('override_invalid')
            : Object.freeze({ state: 'ready', backend: 'override', path });
    }
    if (pluginRoot.state !== 'ready') return pluginRoot;
    const path = pathApi(platform).join(pluginRoot.path, OUTPUT_SUBTREE, childName);
    return Object.freeze({ state: 'ready', backend, path });
};

export const resolveStorageLayout = ({ env = process.env, platform = process.platform, home = undefined } = {}) => {
    let pluginRoot = resolvePluginDataRoot(env, platform);
    let backend = 'plugin_data';
    // Legacy hosts may provide plugin data only to hooks. Missing host metadata permits
    // application storage, but a declared invalid/conflicting path must never select it.
    if (pluginRoot.state === 'unavailable' && pluginRoot.reason === 'plugin_data_missing') {
        backend = 'application_data';
        let path;
        try {
            path = normalizedAbsolutePath(resolveLocalStateDir({ env, platform, home }), platform);
        } catch {
            path = undefined;
        }
        pluginRoot = path === undefined
            ? unavailable('application_data_invalid')
            : Object.freeze({ state: 'ready', path });
    }
    return Object.freeze({
        results: explicitOrPluginTarget(env?.ECOMET_LOCAL_AGENT_RESULT_DIR, pluginRoot, 'results', platform, backend),
        marketplaceArtifacts: explicitOrPluginTarget(
            env?.ECOMET_LOCAL_AGENT_ARTIFACT_DIR,
            pluginRoot,
            'marketplace-artifacts',
            platform,
            backend
        ),
        feedbackArtifacts: explicitOrPluginTarget(
            env?.ECOMET_FEEDBACK_ARTIFACT_DIR,
            pluginRoot,
            'feedback-artifacts',
            platform,
            backend
        ),
    });
};

export const storageStatus = (layout) =>
    Object.fromEntries(
        Object.entries(layout).map(([name, target]) => [
            name,
            target.state === 'ready'
                ? Object.freeze({ state: target.state, backend: target.backend })
                : Object.freeze({ state: target.state, reason: target.reason }),
        ])
    );
