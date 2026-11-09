import { realpathSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStorageLayout } from './storage/files/layout.mjs';
import { doctorReport } from './support/diagnostics/application/doctor.mjs';
import { createInstallationReader } from './support/diagnostics/out/fs-probe/installation.mjs';
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(sourceDirectory);
const pluginRoot = dirname(packageRoot);
const installation = createInstallationReader({ packageRoot, pluginRoot });
// The CLI doctor and the installation diagnosis: this root knows where the installed plugin lies.
export const collectDoctorReport = async ({ env = process.env, platform = process.platform, arch = process.arch, nodeVersion = process.version, observedAt = new Date().toISOString(), } = {}) => doctorReport({
    installation,
    storageLayout: resolveStorageLayout({ env, platform }),
    osRelease: release(),
    platform,
    arch,
    nodeVersion,
    observedAt,
});
const main = async () => {
    if (process.argv.length !== 3 || process.argv[2] !== '--json')
        throw new TypeError('Usage: node doctor.mjs --json');
    process.stdout.write(`${JSON.stringify(await collectDoctorReport())}\n`);
};
const isEntryPoint = (invokedPath) => {
    if (typeof invokedPath !== 'string' || invokedPath.length === 0)
        return false;
    const modulePath = fileURLToPath(import.meta.url);
    const invoked = resolve(invokedPath);
    if (invoked === modulePath)
        return true;
    try {
        return realpathSync(invoked) === modulePath;
    }
    catch {
        return false;
    }
};
if (isEntryPoint(process.argv[1])) {
    main().catch(() => {
        process.exitCode = 1;
    });
}
