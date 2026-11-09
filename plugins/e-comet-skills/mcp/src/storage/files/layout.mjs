import { realpathSync, statSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { StorageUnavailableError } from '../../shared/storage-unavailable.mjs';
import { resolveLocalStateDir } from './state-paths.mjs';
// Keep these paths and direct overrides stable: earlier releases write the same roots (VERSIONING.md, "Files Of Earlier
// Releases").
const OUTPUT_SUBTREE = 'local-mcp-output-v2';
const UNEXPANDED_BRACED_PATH = /\$\{[^}]+\}/;
const UNEXPANDED_COMPONENT = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%)$/;
const pathApi = (platform) => (platform === 'win32' ? win32 : posix);
const unavailable = (reason) => ({ state: 'unavailable', reason });
export const requireStorageTarget = (target, store) => {
    if (target?.state === 'ready')
        return target.path;
    throw new StorageUnavailableError(store, target?.reason ?? 'plugin_data_invalid');
};
const normalizedAbsolutePath = (value, platform) => {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed !== value || UNEXPANDED_BRACED_PATH.test(trimmed))
        return undefined;
    // Hosts and overrides provide literal paths. Bare variable markers must occupy
    // a whole component; '$' in a username and '%' in separate names are not expansion.
    const components = trimmed.split(platform === 'win32' ? /[\\/]/ : /\//);
    if (components.some((component) => UNEXPANDED_COMPONENT.test(component)))
        return undefined;
    const api = pathApi(platform);
    if (!api.isAbsolute(trimmed))
        return undefined;
    return api.resolve(trimmed);
};
const identity = (value, platform) => (platform === 'win32' ? value.toLowerCase() : value);
// The plugin data root of one flow (spec §7.3). The browser-job and feedback hooks take CLAUDE_PLUGIN_DATA first and
// need a non-blank value; the update check takes PLUGIN_DATA first and needs an existing directory, read through its
// real path; the MCP needs both variables, when declared, to name one valid absolute root.
export const resolvePluginDataRoot = (env = process.env, flow, platform = process.platform) => {
    if (flow === 'browser-job' || flow === 'feedback') {
        const candidate = env?.CLAUDE_PLUGIN_DATA || env?.PLUGIN_DATA;
        return typeof candidate === 'string' && candidate.trim()
            ? { state: 'ready', path: resolve(candidate) }
            : unavailable('plugin_data_missing');
    }
    if (flow === 'update') {
        const candidate = env?.PLUGIN_DATA || env?.CLAUDE_PLUGIN_DATA;
        if (typeof candidate !== 'string')
            return unavailable('plugin_data_missing');
        try {
            const path = realpathSync(candidate);
            return statSync(path).isDirectory() ? { state: 'ready', path } : unavailable('plugin_data_invalid');
        }
        catch {
            return unavailable('plugin_data_invalid');
        }
    }
    // An empty declaration is invalid configuration, not an absent host variable:
    // silently falling back would relocate output the host explicitly tried to own.
    const candidates = [env?.PLUGIN_DATA, env?.CLAUDE_PLUGIN_DATA].filter((value) => value !== undefined);
    if (candidates.length === 0)
        return unavailable('plugin_data_missing');
    const normalized = candidates.map((value) => normalizedAbsolutePath(value, platform));
    const paths = normalized.filter((value) => value !== undefined);
    if (paths.length !== normalized.length)
        return unavailable('plugin_data_invalid');
    const [first] = paths;
    if (first === undefined || new Set(paths.map((value) => identity(value, platform))).size !== 1) {
        return unavailable('plugin_data_conflict');
    }
    return { state: 'ready', path: first };
};
export const explicitOrPluginTarget = (explicitValue, pluginRoot, childName, platform = process.platform, backend = 'plugin_data') => {
    if (explicitValue !== undefined) {
        const path = normalizedAbsolutePath(explicitValue, platform);
        return path === undefined ? unavailable('override_invalid') : { state: 'ready', backend: 'override', path };
    }
    if (pluginRoot.state !== 'ready')
        return pluginRoot;
    const path = pathApi(platform).join(pluginRoot.path, OUTPUT_SUBTREE, childName);
    return { state: 'ready', backend, path };
};
export const resolveStorageLayout = ({ env = process.env, platform = process.platform, home = undefined, } = {}) => {
    let pluginRoot = resolvePluginDataRoot(env, 'mcp', platform);
    let backend = 'plugin_data';
    // Legacy hosts may provide plugin data only to hooks. Missing host metadata permits
    // application storage, but a declared invalid/conflicting path must never select it.
    if (pluginRoot.state === 'unavailable' && pluginRoot.reason === 'plugin_data_missing') {
        backend = 'application_data';
        let path;
        try {
            path = normalizedAbsolutePath(resolveLocalStateDir({ env, platform, home }), platform);
        }
        catch {
            path = undefined;
        }
        pluginRoot = path === undefined ? unavailable('application_data_invalid') : { state: 'ready', path };
    }
    return {
        results: explicitOrPluginTarget(env?.ECOMET_LOCAL_AGENT_RESULT_DIR, pluginRoot, 'results', platform, backend),
        marketplaceArtifacts: explicitOrPluginTarget(env?.ECOMET_LOCAL_AGENT_ARTIFACT_DIR, pluginRoot, 'marketplace-artifacts', platform, backend),
        feedbackArtifacts: explicitOrPluginTarget(env?.ECOMET_FEEDBACK_ARTIFACT_DIR, pluginRoot, 'feedback-artifacts', platform, backend),
    };
};
export const storageStatus = (layout) => Object.fromEntries(Object.entries(layout).map(([name, target]) => [
    name,
    target.state === 'ready' ? { state: target.state, backend: target.backend } : { state: target.state, reason: target.reason },
]));
// The MCP root resolves the layout once at start and passes it here (refactor spec §7.5); a writer called without an
// explicit target uses it. Without a root (an in-process test), it is resolved from the environment once, on first use.
let currentLayout;
export const useStorageLayout = (layout) => {
    currentLayout = layout;
};
export const currentStorageLayout = () => (currentLayout ??= resolveStorageLayout());
