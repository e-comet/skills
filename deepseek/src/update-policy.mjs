const PACKAGE = 'dsh-e-comet-skills';
const primaryRegistries = new WeakMap();

/** Let the installing pnpm resolve its own age policy, exclusions and registry settings. */
export async function readProfileUpdate(ctx, { currentVersion, signal }) {
  signal.throwIfAborted();
  const profile = ctx.get('profileContext');
  const subprocess = ctx.get('subprocess');
  if (!profile?.dir || !subprocess) throw new Error('Package policy inspection is unavailable.');
  const invocation = profile.packageManager ?? {
    command: await subprocess.resolveExecutable('pnpm', undefined, signal), args: [],
  };
  signal.throwIfAborted();
  // Native Desktop supplies an executable and prefix arguments. Do not turn an
  // Windows shell shim into a shell command while inspecting policy. See the
  // accepted residual "Windows CLI package-manager shims" in the architecture.
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(invocation.command)) throw new Error('Package policy inspection needs an executable invocation.');
  const manager = ctx.get('pluginManager');
  const identity = manager[Symbol.for('cordis.original')] ?? manager;
  if (!primaryRegistries.has(identity)) {
    // The primary registry is constructor configuration. Do not repeat the host's
    // unused pnpm-registry discovery; a replacement manager owns a fresh value.
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const registries = await Promise.race([manager.registries(), aborted]);
      signal.throwIfAborted();
      primaryRegistries.set(identity, registries.registry);
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  signal.throwIfAborted();
  const registry = primaryRegistries.get(identity);
  // Primary registry only; see "Native DeepSeek update-check registry fallback"
  // in docs/local-agent-architecture.md#accepted-residuals.
  const handle = subprocess.spawn({
    argv: [invocation.command, ...invocation.args, 'outdated', PACKAGE, '--format', 'json',
      ...(registry ? [`--config.registry=${registry}`] : [])],
    cwd: profile.dir, env: invocation.env, signal, graceMs: 1_000,
    // A single filtered package normally produces less than 1 KiB. Refuse a
    // truncated answer instead of treating incomplete registry output as current.
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 4096 } },
  });
  const outcome = await handle.done;
  signal.throwIfAborted();
  const output = handle.collected.stdout.readFrom(0);
  if (![0, 1].includes(outcome.exitCode) || output.lossy) throw new Error('Package policy inspection failed.');
  const packages = JSON.parse(output.text);
  if (!packages || typeof packages !== 'object' || Array.isArray(packages) || packages.error)
    throw new Error('Package policy inspection returned an invalid answer.');
  const selected = packages[PACKAGE];
  if (selected !== undefined && (!selected || typeof selected !== 'object' || typeof selected.latest !== 'string'))
    throw new Error('Package policy inspection returned an invalid version.');
  return { name: PACKAGE, version: selected?.latest ?? currentVersion };
}
