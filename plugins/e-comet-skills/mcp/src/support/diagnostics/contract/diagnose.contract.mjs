import { DIAGNOSTIC_STATES } from '../../../transport/diagnostics/vocabulary.mjs';
import { argumentRefusalSchema, operationDiagnosticSchema } from '../../../transport/mcp/results.mjs';
import { array, boolean, described, object, objectUnion, string } from '../../../transport/mcp/schema.mjs';
export const codexMcpAuthFactsSchema = object({
    host: { const: 'codex' },
    context: { const: 'configuration_snapshot' },
    inspector: { const: 'cli_config_reader' },
    status: { type: 'string', enum: ['not_logged_in', 'credentials_present', 'unknown_status', 'missing', 'ambiguous'] },
    installationMatch: { const: 'not_verified' },
    servers: array(object({
        role: { type: 'string', enum: ['remote', 'local'] },
        authStatus: { type: 'string', enum: ['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'] },
        enabled: boolean,
    }, ['role', 'authStatus'])),
}, ['host', 'context', 'inspector', 'status', 'installationMatch', 'servers']);
const diagnosisCheckSchema = described(object({
    check: described(string, 'Stable identifier for this bounded diagnostic observation.'),
    state: described({ type: 'string', enum: DIAGNOSTIC_STATES }, 'Observation result, preserving unknown, unsupported, and not_checked separately.'),
    observedAt: described(string, 'ISO timestamp at which this check made its observation.'),
    source: described(string, 'Component that produced the check without implying another execution plane.'),
    executionPlane: described(string, 'Execution plane on which this check actually ran.'),
    facts: described({ type: 'object', additionalProperties: true }, 'Check-specific sanitized facts defined in DIAGNOSTICS.md; omitted when unavailable.'),
    cause: described(string, 'Safe cause classification defined for this check; omitted when none was observed.'),
    evidenceRefs: described(array(described(string, 'One safe reference to separately retained evidence, not an embedded path or raw error.')), 'Safe references to separately retained evidence; omitted when none exist.'),
    nextCheck: described(string, 'Smallest named observation that can discriminate remaining uncertainty.'),
}, ['check', 'state', 'observedAt', 'source', 'executionPlane']), 'One bounded diagnostic observation with explicit provenance and omission semantics.');
const diagnosisSchema = described(object({
    schemaVersion: described({ const: 1 }, 'Version of the scoped diagnosis response contract.'),
    scope: described({ type: 'string', enum: ['installation', 'runtime', 'last_operation'] }, 'Diagnostic scope actually evaluated by this response.'),
    mode: described({ type: 'string', enum: ['passive', 'safe_probes'] }, 'Requested observation mode; safe_probes runs only explicitly allowlisted probes.'),
    checks: described(array(described(diagnosisCheckSchema, 'One bounded DiagnosticCheck in response order.')), 'Ordered bounded checks produced for the selected scope and mode.'),
    operation: described(operationDiagnosticSchema, 'Receipt for the exact requested operation handle; omitted outside a matched last_operation diagnosis.'),
}, ['schemaVersion', 'scope', 'mode', 'checks']), 'Scoped technical diagnosis response that preserves uncertainty and never repeats business work.');
export const contract = {
    name: 'e_comet_diagnose',
    description: "Collect scoped technical evidence for installation, current runtime, or the exact last operation handle. Diagnosis never pre-approves or repeats a business tool. A passed check applies only to its named observation plane and time. Never repeat an indeterminate create or upload. Safe probes run only when explicitly requested and do not obtain authorization or call a marketplace. The installation extension_install probe reads Chromium profile metadata to report where the e-Comet extension is installed and enabled; it never proves the extension is connected. The runtime extension_log probe reads the e-Comet extension's own connection log from the browser profile to tell why no connector answers; it never proves a connection. The installation hook_permissions and codex_mcp_auth probes read native Codex configuration state (hook trust; remote-server sign-in status); they do not prove that a hook ran or that the current task is authorized, and answer unsupported under any client other than Codex (Cowork, DeepSeek). For exact input, output, field, and enum semantics, load the packaged mcp/DIAGNOSTICS.md reference.",
    inputSchema: described(object({
        scope: described({ type: 'string', enum: ['installation', 'runtime', 'last_operation'] }, 'Evidence domain to inspect: packaged installation, current bridge runtime, or one exact operation receipt.'),
        mode: described({ type: 'string', enum: ['passive', 'safe_probes'] }, 'Passive reads existing facts; safe_probes additionally runs only the explicitly selected allowlisted probes.'),
        operationHandle: described(string, 'Opaque handle returned by the exact terminal operation; required only for last_operation and never substitutes the latest result.'),
        probes: described(array(described({
            type: 'string',
            enum: [
                'storage_write',
                'extension_snapshot',
                'hook_permissions',
                'codex_mcp_auth',
                'extension_install',
                'extension_log',
            ],
        }, 'storage_write, hook_permissions, codex_mcp_auth and extension_install apply only to installation; extension_snapshot and extension_log apply only to runtime.'), { uniqueItems: true }), 'Allowlisted probes requested for safe_probes mode; an inapplicable requested probe is not executed and is omitted from checks.'),
    }, ['scope', 'mode']), 'Selects one diagnostic scope and observation mode without authorizing a business operation.'),
    outputSchema: described(objectUnion(diagnosisSchema, argumentRefusalSchema), 'The diagnosis report, or the refusal of invalid arguments.'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
