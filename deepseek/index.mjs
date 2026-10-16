import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem';
import { createAdapter, installAdapter } from './src/adapter.mjs';
import { registerMcpClients } from './src/runtime.mjs';
import { createAccount } from './src/account.mjs';
import { AccountService } from './src/account-service.mjs';
import { createNativeFeedbackServices } from './src/feedback-services.mjs';
import { createUpdates } from './src/updates.mjs';
import { installSafely } from './src/update-install.mjs';

export const name = 'e-comet-integration';
export const inject = ['tools', 'skills', 'systemPrompt', 'typert'];

export async function apply(ctx) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const dataDirectory = join(homedir(), '.e-comet-deepseek-harness', 'handoff');
  await mkdir(dataDirectory, { recursive: true });
  const updates = createUpdates({ ctx, installBundle: spec => installSafely({
    packageRoot: join(root, '..'), backupRoot: join(dataDirectory, 'updates'),
    pause: async () => { await adapter.settle(); await runtime.pause(); },
    resume: async () => { await runtime.resume(); await account.initialize(); },
    install: () => ctx.get('pluginManager').installBundle(spec),
  }) });
  const feedbackServices = createNativeFeedbackServices(ctx, { dataDirectory });
  const adapter = createAdapter({ dataDirectory, feedbackServices, updates });
  installAdapter(ctx, adapter);
  ctx.plugin(filesystemSkills, {
    providerName: 'e-comet',
    includeDefaultRoots: false,
    customSkillDirs: [join(root, 'skills')],
    watch: false,
  });
  const env = { PLUGIN_DATA: dataDirectory, CLAUDE_PLUGIN_DATA: dataDirectory, ELECTRON_RUN_AS_NODE: '1' };
  let account;
  const runtime = await registerMcpClients(ctx, {
    adapter,
    local: { command: process.execPath, args: [join(root, '..', 'plugins', 'e-comet-skills', 'mcp', 'src', 'server.mjs')], env, cwd: dataDirectory },
    onUnavailable: (kind, reason) => { if (kind === 'remote') account?.remoteLost(reason); },
  });
  // Own the mounted local MCP before anything else can fail this activation.
  ctx.effect(() => async () => {
    updates.dispose();
    try { await adapter.settle(); } catch { ctx.logger?.warn('e-Comet could not persist pending feedback handoff. The prepared archive remains available; inspect feedback diagnostics before continuing.'); }
    await account?.dispose(); await runtime.dispose();
  });
  account = createAccount({ connectRemote: runtime.connectRemote, disconnectRemote: runtime.disconnectRemote, isRemoteConnected: () => runtime.statuses.remote === 'connected' });
  await ctx.plugin(AccountService, { account, connections: runtime.statuses, localStatus: runtime.localStatus, updates });
  void updates.checkUpdates();
  void account.initialize();
}
