import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const resolveLocalStateDir = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
    if (platform === 'win32') {
        return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'e-comet', 'local-agent');
    }
    if (platform === 'darwin') {
        return posix.join(home, 'Library', 'Application Support', 'e-comet', 'local-agent');
    }
    return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'e-comet', 'local-agent');
};

// The peer token is the shared secret both local agents authenticate with, so it must live outside every
// per-application sandbox. On Windows an MSIX-packaged host redirects writes under %LOCALAPPDATA% into its own
// package container, which silently gives each agent a private token and makes the peer handshake fail forever.
// The user profile root is not redirected. Other platforms have no such redirection, so the token stays with the
// rest of the local state there. Deliberately not env-configurable: pointing a shared secret at an
// attacker-chosen directory is a footgun, and tests inject `directory` directly.
export const resolvePeerTokenDir = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
    if (platform === 'win32') return win32.join(home, '.e-comet', 'local-agent');
    return resolveLocalStateDir({ platform, env, home });
};
