import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticCheck } from '../../../../transport/diagnostics/vocabulary.mjs';
// The doctor runs from a copy of its own module closure, so this reader imports no shared helpers.
const isNotFound = (error) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
const readJson = async (path) => {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value)
            ? { state: 'passed', value }
            : { state: 'failed', cause: 'corrupt' };
    }
    catch (error) {
        return { state: 'failed', cause: isNotFound(error) ? 'missing' : error instanceof SyntaxError ? 'corrupt' : 'io_error' };
    }
};
const fileCheck = async (path, observedAt) => {
    try {
        const isFile = (await stat(path)).isFile();
        return diagnosticCheck({
            check: 'entrypoint',
            state: isFile ? 'passed' : 'failed',
            observedAt,
            source: 'filesystem_metadata',
            executionPlane: 'device',
            ...(isFile ? {} : { cause: 'missing' }),
        });
    }
    catch (error) {
        return diagnosticCheck({
            check: 'entrypoint',
            state: 'failed',
            observedAt,
            source: 'filesystem_metadata',
            executionPlane: 'device',
            cause: isNotFound(error) ? 'missing' : 'io_error',
        });
    }
};
/** The doctor's reads of one installed plugin: its package metadata and the server entrypoint the MCP configuration names. */
export const createInstallationReader = ({ packageRoot, pluginRoot }) => ({
    readPackage: () => readJson(join(packageRoot, 'package.json')),
    readCodexManifest: () => readJson(join(pluginRoot, '.codex-plugin', 'plugin.json')),
    readMcpConfiguration: () => readJson(join(pluginRoot, '.mcp.json')),
    checkEntrypoint: (configuration, observedAt) => fileCheck(configuration ? join(pluginRoot, configuration.cwd, configuration.args[0]) : join(packageRoot, 'src', 'server.mjs'), observedAt),
});
