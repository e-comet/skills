import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feedbackHandoffFlows } from '../plugins/e-comet-skills/mcp/src/composition/feedback-handoff.composition.mjs';
import { moduleNameOf } from '../plugins/e-comet-skills/mcp/src/composition/module-names.composition.mjs';
import { projectFeedbackToolOutcome } from '../plugins/e-comet-skills/mcp/src/composition/tool-names.composition.mjs';
import { isRecord } from '../plugins/e-comet-skills/mcp/src/shared/values.mjs';
import { isHostRuntimeVersion } from '../plugins/e-comet-skills/mcp/src/transport/diagnostics/facts.mjs';
import { useModuleNames } from '../plugins/e-comet-skills/mcp/src/transport/failures/evidence.mjs';
import { AccountService } from './adapters/account/account-service.mjs';
import { createAccount } from './adapters/account/account.mjs';
import { registerMcpClients } from './adapters/account/runtime.mjs';
import { renderStatusContext } from './adapters/account/status-context.mjs';
import { createFeedbackHandoff } from './adapters/feedback/handoff.mjs';
import { createNativeFeedbackServices } from './adapters/feedback/services.mjs';
import { createAdapter, installAdapter } from './adapters/tool-runtime/runtime.mjs';
useModuleNames(moduleNameOf);
// A package manifest's version field.
const versionOf = (manifest) => (isRecord(manifest) ? manifest.version : undefined);
// The npm package's version, read once from the manifest beside this package.
const packageVersion = versionOf(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
const PACKAGE_VERSION = typeof packageVersion === 'string' ? packageVersion : undefined;
// The host resolves a declared peer to its own runtime package, and every DSH runtime package carries the one
// runtime version the host's compatibility check names; the Desktop product version is not exposed to plugins.
// A developer who exports ECOMET_HOST_RUNTIME_VERSION under another host labels their own reports: see "Native
// DeepSeek host runtime version from the environment" in docs/architecture/residuals/deepseek.md.
function hostRuntimeVersion() {
    try {
        const version = versionOf(JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-subprocess/package.json')), 'utf8')));
        return typeof version === 'string' && isHostRuntimeVersion(version) ? version : undefined;
    }
    catch {
        return undefined;
    }
}
export const name = 'e-comet-integration';
export const inject = ['tools', 'skills', 'systemPrompt', 'typert'];
export async function apply(ctx) {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const dataDirectory = join(homedir(), '.e-comet-deepseek-harness', 'handoff');
    await mkdir(dataDirectory, { recursive: true });
    const feedbackServices = createNativeFeedbackServices(ctx, { dataDirectory });
    const feedback = createFeedbackHandoff({
        services: feedbackServices,
        flows: feedbackHandoffFlows({ env: { ...process.env, PLUGIN_DATA: dataDirectory, CLAUDE_PLUGIN_DATA: dataDirectory } }),
    });
    const adapter = createAdapter({ dataDirectory, feedback });
    installAdapter(ctx, adapter);
    ctx.plugin(filesystemSkills, {
        providerName: 'e-comet',
        includeDefaultRoots: false,
        customSkillDirs: [join(root, 'skills')],
        watch: false,
    });
    const hostVersion = hostRuntimeVersion();
    // Our own name: the host scrubs inherited DSH_* names from the child; the local module reports this in bug reports.
    const env = {
        PLUGIN_DATA: dataDirectory,
        CLAUDE_PLUGIN_DATA: dataDirectory,
        ELECTRON_RUN_AS_NODE: '1',
        ...(hostVersion ? { ECOMET_HOST_RUNTIME_VERSION: hostVersion } : {}),
    };
    // Callbacks read it before the account exists, so it starts undefined.
    let account = undefined;
    const runtime = await registerMcpClients(ctx, {
        adapter,
        version: PACKAGE_VERSION,
        projectToolOutcome: projectFeedbackToolOutcome,
        local: {
            command: process.execPath,
            args: [join(root, '..', 'plugins', 'e-comet-skills', 'mcp', 'src', 'server.mjs')],
            env,
            cwd: dataDirectory,
        },
        onUnavailable: (kind, reason) => {
            if (kind === 'remote')
                account?.remoteLost(reason);
        },
    });
    // Own the mounted local MCP before anything else can fail this activation.
    ctx.effect(() => async () => {
        try {
            await adapter.settle();
        }
        catch {
            ctx.logger?.warn('e-Comet could not persist pending feedback handoff. The prepared archive remains available; inspect feedback diagnostics before continuing.');
        }
        await account?.dispose();
        await runtime.dispose();
    });
    account = createAccount({
        connectRemote: runtime.connectRemote,
        disconnectRemote: runtime.disconnectRemote,
        isRemoteConnected: () => runtime.statuses.remote === 'connected',
    });
    // Adapter-owned state the host never sees. Empty while everything is connected, so the normal case costs nothing;
    // the host re-sends the snapshot only when the text changes. Only this registration supplies it: matching text
    // inside a tool result, page or message is untrusted. The fixed name assumes one live plugin instance: see
    // "Native DeepSeek registrations assume one live plugin instance" in docs/architecture/residuals/deepseek.md.
    ctx.systemPrompt.context({
        name: 'e-comet:status',
        order: 130,
        text: () => renderStatusContext({ account: account.getStatus(), connections: runtime.statuses }),
    });
    await ctx.plugin(AccountService, { account, connections: runtime.statuses, localStatus: runtime.localStatus });
    account.initialize();
}
