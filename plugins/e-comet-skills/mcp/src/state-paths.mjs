import { homedir, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

export const resolveLocalStateDir = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
    if (platform === 'win32') {
        return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'e-comet', 'local-agent');
    }
    if (platform === 'darwin') {
        return posix.join(home, 'Library', 'Application Support', 'e-comet', 'local-agent');
    }
    // Accepted residual "Linux agent hosts with different XDG variables": docs/local-agent-architecture.md#accepted-residuals.
    return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'e-comet', 'local-agent');
};

// The home directory of the OS account, read from the account database rather than from HOME or USERPROFILE.
// A host that launches a process with a remapped HOME (a sandbox, a test harness, a packaged app) must not be
// able to give it a private profile, because the profile is where independent processes meet.
export const resolveAccountHome = ({ userInfo: accountInfo = userInfo, homedir: environmentHome = homedir } = {}) => {
    try {
        const accountHome = accountInfo().homedir;
        if (typeof accountHome === 'string' && accountHome) return accountHome;
    } catch {
        // No account entry (for example a container user without a passwd record): the environment is all there is.
    }
    return environmentHome();
};

// The profile state directory holds what every local e-Comet process of one user must share: the feedback hook
// secret, the broker rendezvous entries and the versioned broker copies. It must
// live outside every per-application sandbox. On Windows an MSIX-packaged host redirects writes under
// %LOCALAPPDATA% into its own package container, which silently gives each agent a private copy, so brokers and the
// hook secret would never be found; the user profile root is not redirected. Other platforms have no such redirection,
// so it stays with the rest of the local state there.
// ECOMET_TEST_STATE_DIR is honoured only under NODE_ENV test or development: pointing a shared secret at an
// attacker-chosen directory is a footgun in production, and a test that remaps HOME no longer moves this path.
export const resolveProfileStateDir = ({ platform = process.platform, env = process.env, home = resolveAccountHome() } = {}) => {
    const override = env.ECOMET_TEST_STATE_DIR;
    if ((env.NODE_ENV === 'test' || env.NODE_ENV === 'development') && typeof override === 'string' && override.trim()) {
        return override;
    }
    if (platform === 'win32') return win32.join(home, '.e-comet', 'local-agent');
    return resolveLocalStateDir({ platform, env, home });
};
