// The closed causes `local_bridge_status` reports when no extension route is available. A leaf module: the status
// schema and the feedback projection both import it, and it imports nothing.
export const BRIDGE_CODES = Object.freeze([
    'BRIDGE_NO_BROWSER',
    'BRIDGE_HOST_NOT_STARTED',
    'BRIDGE_HOST_NOT_FOUND',
    'BRIDGE_HOST_FORBIDDEN',
    'BRIDGE_HOST_START_FAILED',
    'BRIDGE_BROKER_NOT_VISIBLE',
    'BRIDGE_PERMISSION_REQUIRED',
    'BRIDGE_EXTENSION_OUTDATED',
    'BRIDGE_EXTENSION_DISABLED',
    'BRIDGE_USER_HOSTS_DISABLED',
    'BRIDGE_HOST_BLOCKED',
    'BRIDGE_BROKER_UNRESPONSIVE',
    'BRIDGE_BROKER_FAILED',
    'BRIDGE_FRAME_TOO_LARGE',
    'BRIDGE_MACOS_FOLDER_ACCESS',
    'BRIDGE_UNAVAILABLE_IN_WSL',
    'BRIDGE_UNSUPPORTED_PLATFORM',
]);

// A step or system code a cause names (a registration step and its code, or a broker failure record's error name and
// code): short identifiers only, since anything longer or looser can carry a path, a message or a user name.
export const BRIDGE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// Who can act on a cause (spec §3), on the diagnostic and report surfaces only: a tool error carries its owner in the
// message wording. HOST_START_FAILED is unknown until a fact names it: an invalid ComSpec (`detail: 'comspec'`) is the
// administrator's.
export const BRIDGE_OWNERS = Object.freeze(['user', 'administrator', 'e_comet', 'unknown']);
const OWNER_OF = Object.freeze({
    // BROKER_NOT_VISIBLE's first step is the user's, as HOST_NOT_STARTED's: a closed profile leaves the same log.
    BRIDGE_NO_BROWSER: 'user', BRIDGE_HOST_NOT_STARTED: 'user', BRIDGE_BROKER_NOT_VISIBLE: 'user', BRIDGE_PERMISSION_REQUIRED: 'user',
    BRIDGE_EXTENSION_OUTDATED: 'user', BRIDGE_EXTENSION_DISABLED: 'user', BRIDGE_MACOS_FOLDER_ACCESS: 'user', BRIDGE_UNAVAILABLE_IN_WSL: 'user',
    BRIDGE_UNSUPPORTED_PLATFORM: 'user',
    BRIDGE_USER_HOSTS_DISABLED: 'administrator', BRIDGE_HOST_BLOCKED: 'administrator',
    BRIDGE_BROKER_FAILED: 'e_comet', BRIDGE_BROKER_UNRESPONSIVE: 'e_comet', BRIDGE_FRAME_TOO_LARGE: 'e_comet', BRIDGE_HOST_NOT_FOUND: 'e_comet',
    BRIDGE_HOST_FORBIDDEN: 'e_comet',
});
/** @returns {'user' | 'administrator' | 'e_comet' | 'unknown'} */
export const bridgeOwner = (/** @type {unknown} */ code, /** @type {string | undefined} */ detail = undefined) => {
    if (code === 'BRIDGE_HOST_START_FAILED' && detail === 'comspec') return 'administrator';
    return typeof code === 'string' && Object.hasOwn(OWNER_OF, code) ? OWNER_OF[/** @type {keyof typeof OWNER_OF} */ (code)] : 'unknown';
};

// Every value the status `code` field takes: the two healthy states and the causes above. A route lost mid-job is the
// failing tool call's EXTENSION_DISCONNECTED, never a status code: status names the cause found since.
export const BRIDGE_STATUS_CODES = Object.freeze(['connected', 'connecting', ...BRIDGE_CODES]);

// The closed lists of the registration record the status reports. The status schema and the feedback projection both
// read them from here, so a value one accepts is never silently dropped by the other.
export const BRIDGE_REGISTRATION_STATES = Object.freeze(['registered', 'current', 'disabled', 'failed', 'denied']);
export const BRIDGE_RUNTIMES = Object.freeze(['path_node', 'host_executable']);
export const BRIDGE_RUNTIME_RECHECKS = Object.freeze(['not_run', 'passed', 'repaired', 'failed', 'inconclusive']);
export const BRIDGE_COMSPEC_STATES = Object.freeze(['valid', 'invalid', 'unknown']);
