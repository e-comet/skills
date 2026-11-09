import { collectStaticFacts, diagnosticCheck, MCP_CONFIGURATION_FACTS, } from '../../../transport/diagnostics/vocabulary.mjs';
// The doctor runs from a copy of its own module closure, so it keeps this check instead of importing the shared one.
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const metadataCheck = (check, observation, observedAt, facts) => diagnosticCheck({
    check,
    state: observation.state,
    observedAt,
    source: 'package_metadata',
    executionPlane: 'device',
    ...(observation.cause ? { cause: observation.cause } : {}),
    ...(facts ? { facts } : {}),
});
const VERSION = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const safeVersion = (value) => (typeof value === 'string' && value.length <= 128 && VERSION.test(value) ? value : undefined);
const validateMcpConfiguration = (observation) => {
    if (observation.state !== 'passed')
        return observation;
    const servers = isRecord(observation.value) ? observation.value.mcpServers : undefined;
    const local = isRecord(servers) ? servers['e-comet-local'] : undefined;
    return isRecord(local) &&
        local.type === MCP_CONFIGURATION_FACTS.transport &&
        local.command === MCP_CONFIGURATION_FACTS.command &&
        Array.isArray(local.args) &&
        local.args.length === 1 &&
        local.args[0] === MCP_CONFIGURATION_FACTS.entrypoint &&
        local.cwd === MCP_CONFIGURATION_FACTS.cwd
        ? { state: 'passed', value: local }
        : { state: 'failed', cause: 'corrupt' };
};
/**
 * The installation checks of one plugin, read through `installation`; the storage layout, OS release and clock values come
 * from the root.
 */
export const doctorReport = async ({ installation, storageLayout, osRelease, platform, arch, nodeVersion, observedAt, }) => {
    const packageObservation = await installation.readPackage();
    const bridgeVersion = safeVersion(isRecord(packageObservation.value) ? packageObservation.value.version : undefined);
    const checks = collectStaticFacts({
        platform,
        arch,
        // An unsafe package version is left out, as the facts allow.
        versions: { node: nodeVersion, ...(bridgeVersion ? { bridge: bridgeVersion } : {}), os: osRelease },
        storageLayout,
        observedAt,
    });
    checks.push(diagnosticCheck({
        check: 'package_layout',
        state: 'passed',
        observedAt,
        source: 'module_location',
        executionPlane: 'device',
        facts: { layout: 'installed_plugin' },
    }));
    const codexObservation = await installation.readCodexManifest();
    const codex = codexObservation.state === 'passed' && isRecord(codexObservation.value) ? codexObservation.value : undefined;
    const codexVersion = safeVersion(codex?.version);
    const validCodex = codex?.name === 'e-comet-skills' && codexVersion && codex.mcpServers === './.mcp.json';
    checks.push(metadataCheck('codex_manifest', validCodex ? codexObservation : { state: 'failed', cause: codexObservation.cause ?? 'corrupt' }, observedAt, validCodex ? { name: 'e-comet-skills', version: codexVersion } : undefined));
    const mcpObservation = validateMcpConfiguration(await installation.readMcpConfiguration());
    checks.push(metadataCheck('mcp_configuration', mcpObservation, observedAt, mcpObservation.state === 'passed' ? MCP_CONFIGURATION_FACTS : undefined));
    // A passed observation is the shipped configuration itself, so the entrypoint is the one it names.
    checks.push(await installation.checkEntrypoint(mcpObservation.state === 'passed'
        ? { cwd: MCP_CONFIGURATION_FACTS.cwd, args: [MCP_CONFIGURATION_FACTS.entrypoint] }
        : undefined, observedAt));
    return {
        schemaVersion: 1,
        checks,
        limitations: {
            hostInstallation: 'not_checked',
            hostEnablement: 'not_checked',
            hookTrust: 'not_checked',
            otherExecutionPlanes: 'not_checked',
        },
    };
};
