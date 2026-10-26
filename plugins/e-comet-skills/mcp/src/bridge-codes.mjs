// The closed causes `local_bridge_status` reports when no extension route is available. A leaf module: the status
// schema and the feedback projection both import it, and it imports nothing.
export const BRIDGE_CODES = Object.freeze([
    'BRIDGE_NO_BROWSER',
    'BRIDGE_HOST_NOT_STARTED',
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

// Every value the status `code` field takes: the two healthy states and the causes above. A route lost mid-job is the
// failing tool call's EXTENSION_DISCONNECTED, never a status code: status names the cause found since.
export const BRIDGE_STATUS_CODES = Object.freeze(['connected', 'connecting', ...BRIDGE_CODES]);

// The closed lists of the registration record the status reports. The status schema and the feedback projection both
// read them from here, so a value one accepts is never silently dropped by the other.
export const BRIDGE_REGISTRATION_STATES = Object.freeze(['registered', 'current', 'disabled', 'failed', 'denied']);
export const BRIDGE_RUNTIMES = Object.freeze(['path_node', 'host_executable']);
