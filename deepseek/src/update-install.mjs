import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { retryTransientFileOperation } from '../../plugins/e-comet-skills/hooks/transient-file-operation.mjs';

/** pnpm restores its manifest/lockfile on failure, but not partially replaced package files. */
export async function installSafely({ packageRoot, backupRoot, pause, resume, install }) {
  await mkdir(backupRoot, { recursive: true });
  const backup = await mkdtemp(join(backupRoot, 'update-'));
  const saved = join(backup, 'package');
  // Dependencies belong to the host package manager, not this bundle's recovery snapshot.
  const owned = path => !relative(packageRoot, path).split(sep).includes('node_modules');
  let paused = false;
  let preserve = false;
  try {
    await cp(packageRoot, saved, { recursive: true, filter: owned });
    paused = true;
    await pause();
    let result, failure;
    try { result = await install(); } catch (error) { failure = error; }
    if (!failure && ['restart-required', 'applied'].includes(result?.application)) return result;
    try {
      await retryTransientFileOperation(async () => {
        // Restore the exact snapshot: files the partial install added (a newer skill) must not survive.
        // A failed install may have removed the directory itself; cp below recreates it.
        const entries = await readdir(packageRoot).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const entry of entries) {
          if (entry !== 'node_modules') await rm(join(packageRoot, entry), { recursive: true, force: true });
        }
        await cp(saved, packageRoot, { recursive: true, force: true });
      });
      await resume();
      paused = false;
    } catch (error) {
      preserve = true;
      // Preserve the exact backup location for support; the card exposes only the recovery-required status.
      throw Object.assign(new Error(`ECOMET_UPDATE_RECOVERY_FAILED: Previous package files are preserved at ${backup}`, { cause: error }), { code: 'ECOMET_UPDATE_RECOVERY_FAILED', backupDirectory: backup });
    }
    if (failure) throw failure;
    return result;
  } catch (error) {
    if (paused && !preserve) await resume().catch(() => {});
    throw error;
  } finally {
    if (!preserve) await retryTransientFileOperation(() => rm(backup, { recursive: true, force: true })).catch(() => {});
  }
}
