import { join } from 'node:path';
import { resolveLocalStateDir } from '../mcp/src/state-paths.mjs';

export const resolveQwenRuntimeEnv = (env = process.env) => {
    // Match the shared hook's `||` precedence, including empty-string fallback.
    // A truthy whitespace/invalid override stays intact so the shared hook rejects it.
    if (env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA) return env;
    return { ...env, PLUGIN_DATA: join(resolveLocalStateDir({ env }), 'qwen') };
};
