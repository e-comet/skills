import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectStaticFacts, diagnosticCheck } from './diagnostic-facts.mjs';
import { resolveStorageLayout } from './storage-layout.mjs';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(sourceDirectory);
const installedLayout = basename(packageRoot).toLowerCase() === 'mcp';
const pluginRoot = installedLayout ? dirname(packageRoot) : undefined;

const readJson = async (path) => {
    try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value)
            ? { state: 'passed', value }
            : { state: 'failed', cause: 'corrupt' };
    } catch (error) {
        return { state: 'failed', cause: error?.code === 'ENOENT' ? 'missing' : error instanceof SyntaxError ? 'corrupt' : 'io_error' };
    }
};

const fileCheck = async (path, observedAt) => {
    try {
        const isFile = (await stat(path)).isFile();
        return diagnosticCheck({ check: 'entrypoint', state: isFile ? 'passed' : 'failed', observedAt,
            source: 'filesystem_metadata', executionPlane: 'device', ...(isFile ? {} : { cause: 'missing' }) });
    } catch (error) {
        return diagnosticCheck({ check: 'entrypoint', state: 'failed', observedAt, source: 'filesystem_metadata',
            executionPlane: 'device', cause: error?.code === 'ENOENT' ? 'missing' : 'io_error' });
    }
};

const metadataCheck = (check, observation, observedAt, facts) => diagnosticCheck({
    check, state: observation.state, observedAt, source: 'package_metadata', executionPlane: 'device',
    ...(observation.cause ? { cause: observation.cause } : {}), ...(facts ? { facts } : {}),
});

const VERSION = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const safeVersion = (value) => typeof value === 'string' && value.length <= 128 && VERSION.test(value) ? value : undefined;

const validateMcpConfiguration = (observation) => {
    if (observation.state !== 'passed') return observation;
    const local = observation.value?.mcpServers?.['e-comet-local'];
    return local?.type === 'stdio' && local.command === 'node' && Array.isArray(local.args)
        && local.args.length === 1 && local.args[0] === 'mcp/src/server.mjs' && local.cwd === '.'
        ? { state: 'passed', value: local } : { state: 'failed', cause: 'corrupt' };
};

export const collectDoctorReport = async ({ env = process.env, platform = process.platform, arch = process.arch,
    nodeVersion = process.version, observedAt = new Date().toISOString() } = {}) => {
    const packageObservation = await readJson(join(packageRoot, 'package.json'));
    const checks = collectStaticFacts({ platform, arch,
        versions: { node: nodeVersion, bridge: safeVersion(packageObservation.value?.version) },
        storageLayout: resolveStorageLayout({ env, platform }), observedAt });
    checks.push(diagnosticCheck({ check: 'package_layout', state: 'passed', observedAt, source: 'module_location',
        executionPlane: 'device', facts: { layout: installedLayout ? 'installed_plugin' : 'canonical_source' } }));

    let entrypointPath = join(packageRoot, 'src', 'server.mjs');
    if (!installedLayout) {
        const validPackage = packageObservation.state === 'passed'
            && packageObservation.value?.name === '@e-comet/local-mcp' && safeVersion(packageObservation.value?.version);
        checks.push(metadataCheck('package_metadata', validPackage ? packageObservation : { state: 'failed', cause: packageObservation.cause ?? 'corrupt' },
            observedAt, validPackage ? { name: '@e-comet/local-mcp', version: packageObservation.value.version } : undefined));
    } else {
        const codexObservation = await readJson(join(pluginRoot, '.codex-plugin', 'plugin.json'));
        const validCodex = codexObservation.state === 'passed' && codexObservation.value?.name === 'e-comet-skills'
            && safeVersion(codexObservation.value?.version) && codexObservation.value?.mcpServers === './.mcp.json';
        checks.push(metadataCheck('codex_manifest', validCodex ? codexObservation : { state: 'failed', cause: codexObservation.cause ?? 'corrupt' },
            observedAt, validCodex ? { name: 'e-comet-skills', version: codexObservation.value.version } : undefined));
        const mcpObservation = validateMcpConfiguration(await readJson(join(pluginRoot, '.mcp.json')));
        checks.push(metadataCheck('mcp_configuration', mcpObservation, observedAt,
            mcpObservation.state === 'passed' ? { transport: 'stdio', command: 'node', cwd: '.', entrypoint: 'mcp/src/server.mjs' } : undefined));
        if (mcpObservation.state === 'passed') entrypointPath = join(pluginRoot, mcpObservation.value.cwd, mcpObservation.value.args[0]);
    }

    checks.push(await fileCheck(entrypointPath, observedAt));
    return Object.freeze({ schemaVersion: 1, checks, limitations: Object.freeze({
        hostInstallation: 'not_checked', hostEnablement: 'not_checked', hookTrust: 'not_checked', otherExecutionPlanes: 'not_checked',
    }) });
};

const main = async () => {
    if (process.argv.length !== 3 || process.argv[2] !== '--json') throw new TypeError('Usage: node doctor.mjs --json');
    process.stdout.write(`${JSON.stringify(await collectDoctorReport())}\n`);
};

const isEntryPoint = (invokedPath) => {
    if (typeof invokedPath !== 'string' || invokedPath.length === 0) return false;
    const modulePath = fileURLToPath(import.meta.url);
    const invoked = resolve(invokedPath);
    if (invoked === modulePath) return true;
    try { return realpathSync(invoked) === modulePath; } catch { return false; }
};

if (isEntryPoint(process.argv[1])) {
    main().catch(() => { process.exitCode = 1; });
}
