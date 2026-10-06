import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const isMainModule = moduleUrl => {
    if (!process.argv[1]) return false;
    try {
        // Node resolves module URLs through symlinks; argv retains the launch path.
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
    } catch {
        return false;
    }
};
