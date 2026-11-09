import { spawn } from 'node:child_process';
import { validateSchemaValue } from '../../../../shared/schema-validate.mjs';
import { isRecord } from '../../../../shared/values.mjs';
import { codexMcpAuthFactsSchema } from '../../contract/diagnose.contract.mjs';
import { diagnosticCheck } from '../../../../transport/diagnostics/vocabulary.mjs';
const ROLES = { 'e-comet': 'remote', 'e-comet-local': 'local' };
const AUTH = {
    unknown: 'unknown',
    unsupported: 'unsupported',
    not_logged_in: 'notLoggedIn',
    bearer_token: 'bearerToken',
    o_auth: 'oAuth',
};
const outcome = (state, status, servers, cause) => ({
    state,
    ...(cause ? { cause } : {}),
    facts: {
        host: 'codex',
        context: 'configuration_snapshot',
        inspector: 'cli_config_reader',
        status,
        installationMatch: 'not_verified',
        servers,
    },
});
// The CLI lists configured names, not attested plugin identities or Desktop runtime state.
// Project only allowlisted roles and status words; foreign metadata never enters facts.
// Parse boundary: the CLI's JSON list, narrowed here.
export const summarizeCodexMcpAuth = (result) => {
    if (!Array.isArray(result) || !result.every(isRecord))
        return outcome('unknown', 'unknown_status', [], 'unknown');
    // Names and statuses are read as the property keys they were, so a non-string one matches as it always did.
    const servers = result
        .filter(isRecord)
        .flatMap((entry) => {
        const name = String(entry.name);
        const status = String(entry.auth_status);
        const role = Object.hasOwn(ROLES, name) ? ROLES[name] : undefined;
        return role === undefined
            ? []
            : [
                {
                    role,
                    authStatus: (Object.hasOwn(AUTH, status) ? AUTH[status] : undefined) ?? 'unknown',
                    ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
                },
            ];
    })
        .sort((left, right) => (left.role === 'remote' ? 0 : 1) - (right.role === 'remote' ? 0 : 1));
    const remote = servers.filter((server) => server.role === 'remote');
    const local = servers.filter((server) => server.role === 'local');
    if (remote.length > 1 || local.length > 1)
        return outcome('unknown', 'ambiguous', servers, 'unknown');
    const target = remote[0];
    if (!target)
        return outcome('not_checked', 'missing', servers, 'missing');
    if (target.enabled === false || target.authStatus === 'unknown')
        return outcome('unknown', 'unknown_status', servers, 'unknown');
    if (target.authStatus === 'notLoggedIn')
        return outcome('passed', 'not_logged_in', servers);
    if (target.authStatus === 'oAuth' || target.authStatus === 'bearerToken')
        return outcome('passed', 'credentials_present', servers);
    return outcome('unknown', 'unknown_status', servers, 'unknown');
};
// 20 s protects the local diagnosis budget; 2 MiB covers normal config listings while
// bounding memory if a user's configured server list contains large foreign metadata.
const readCodexMcpList = ({ spawnProcess, timeoutMs = 20_000 }) => new Promise((resolve, reject) => {
    let child;
    try {
        child = spawnProcess('codex', ['mcp', 'list', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    }
    catch (error) {
        reject(error);
        return;
    }
    let chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value, kill = false) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        child.stdout?.removeListener('error', onError);
        child.stdout?.removeListener('data', onData);
        chunks = [];
        if (kill) {
            try {
                child.kill();
            }
            catch {
                /* best effort */
            }
        }
        if (error)
            reject(error);
        else
            resolve(value);
    };
    const onError = (error) => finish(error, undefined, true);
    const onData = (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
            finish(new Error('mcp list output exceeded bound'), undefined, true);
            return;
        }
        chunks.push(chunk);
    };
    const onClose = (code, signal) => {
        if (code !== 0 || signal) {
            finish(new Error('mcp list failed'));
            return;
        }
        let result;
        try {
            result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            finish(new Error('mcp list returned invalid JSON'));
            return;
        }
        finish(undefined, result);
    };
    const timer = setTimeout(() => finish(new Error('mcp list timed out'), undefined, true), timeoutMs);
    child.on('error', onError);
    child.on('close', onClose);
    // The listing is spawned with piped stdout, so the stream exists.
    if (!child.stdout)
        throw new TypeError('The Codex listing has no piped stdout.');
    child.stdout.on('error', onError);
    child.stdout.on('data', onData);
});
export const collectCodexMcpAuth = async ({ observedAt, now = Date.now, spawnProcess = spawn, timeoutMs = 20_000, } = {}) => {
    const at = observedAt ?? new Date(now()).toISOString();
    const base = { check: 'codex_mcp_auth', observedAt: at, source: 'codex_mcp_list', executionPlane: 'device' };
    let result;
    try {
        result = await readCodexMcpList({ spawnProcess, timeoutMs });
    }
    catch {
        return diagnosticCheck({ ...base, state: 'not_checked', cause: 'unavailable' });
    }
    const summary = summarizeCodexMcpAuth(result);
    if (!validateSchemaValue(summary.facts, codexMcpAuthFactsSchema))
        return diagnosticCheck({ ...base, state: 'unknown', cause: 'unknown' });
    return diagnosticCheck({ ...base, ...summary });
};
