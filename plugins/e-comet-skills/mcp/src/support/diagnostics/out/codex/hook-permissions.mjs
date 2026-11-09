import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { validateSchemaValue } from '../../../../shared/schema-validate.mjs';
import { isOneOf, isRecord } from '../../../../shared/values.mjs';
import { queryCodexAppServer } from './app-server.mjs';
import { hookPermissionsFactsSchema } from '../../../../transport/diagnostics/facts.mjs';
import { diagnosticCheck } from '../../../../transport/diagnostics/vocabulary.mjs';
import { CHECKING_PLUGIN_VERSION, RESTORING_BROWSER_AUTHORIZATION, RESTORING_FEEDBACK_AUTHORIZATION, SECURING_BROWSER_AUTHORIZATION, SECURING_FEEDBACK_AUTHORIZATION, } from '../../../../transport/mcp/hook-status.mjs';
const PLUGIN_ID = 'e-comet-skills';
const EXPECTED_HOOKS = new Set([
    'preToolUse:browser_authorization_restore',
    'preToolUse:update_check',
    'preToolUse:feedback_authorization_restore',
    'postToolUse:browser_authorization_capture',
    'postToolUse:feedback_authorization_capture',
]);
const EVENT_NAMES = ['preToolUse', 'postToolUse', 'postToolUseFailure'];
const TRUST_STATUSES = ['trusted', 'untrusted', 'modified', 'managed'];
// Parse boundary: Codex hook entries from hooks/list, narrowed by each reader.
const isPluginHook = (hook) => isRecord(hook) && typeof hook.pluginId === 'string' && (hook.pluginId === PLUGIN_ID || hook.pluginId.startsWith(`${PLUGIN_ID}@`));
const hookFamily = (hook) => {
    const key = `${String(hook.eventName)}:${String(hook.statusMessage)}`;
    const families = {
        [`preToolUse:${RESTORING_BROWSER_AUTHORIZATION}`]: 'browser_authorization_restore',
        [`postToolUse:${SECURING_BROWSER_AUTHORIZATION}`]: 'browser_authorization_capture',
        [`preToolUse:${CHECKING_PLUGIN_VERSION}`]: 'update_check',
        [`preToolUse:${RESTORING_FEEDBACK_AUTHORIZATION}`]: 'feedback_authorization_restore',
        [`postToolUse:${SECURING_FEEDBACK_AUTHORIZATION}`]: 'feedback_authorization_capture',
    };
    return (Object.hasOwn(families, key) ? families[key] : undefined) ?? 'plugin_hook';
};
const samePath = (left, right) => {
    // A path that is not a string fails as resolving it did.
    if (typeof left !== 'string')
        return false;
    try {
        return process.platform === 'win32'
            ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
            : resolve(left) === resolve(right);
    }
    catch {
        return false;
    }
};
// Parse boundary: the app server's hooks/list result, narrowed here.
export const summarizeCodexHooks = (result, cwd, inspector = 'transient_config_reader') => {
    const data = isRecord(result) ? result.data : undefined;
    const matching = Array.isArray(data)
        ? data.filter((entry) => isRecord(entry) && samePath(entry.cwd, cwd))
        : [];
    if (matching.length !== 1)
        return {
            state: 'unknown',
            cause: 'unknown',
            facts: {
                host: 'codex',
                context: 'configuration_snapshot',
                configured: 0,
                enabled: 0,
                trust: { trusted: 0, untrusted: 0, modified: 0, managed: 0 },
                hooks: [],
                warnings: false,
                errors: true,
                status: 'incomplete_inventory',
                inspector,
                installationMatch: 'not_verified',
                currentApplicationMatch: 'not_verified',
            },
        };
    const entries = matching;
    const hooks = entries.flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : [])).filter(isPluginHook);
    const warnings = entries.some((entry) => Array.isArray(entry.warnings) && entry.warnings.length > 0);
    const errors = entries.some((entry) => Array.isArray(entry.errors) && entry.errors.length > 0);
    const trust = { trusted: 0, untrusted: 0, modified: 0, managed: 0 };
    for (const hook of hooks) {
        if (hook.isManaged || hook.trustStatus === 'managed')
            trust.managed += 1;
        else if (isOneOf(TRUST_STATUSES, hook.trustStatus))
            trust[hook.trustStatus] += 1;
    }
    const enabled = hooks.filter((hook) => hook.enabled === true).length;
    const safeHooks = hooks.map((hook) => ({
        eventName: isOneOf(EVENT_NAMES, hook.eventName) ? hook.eventName : 'unknown',
        family: hookFamily(hook),
        enabled: hook.enabled === true,
        trustStatus: hook.isManaged || hook.trustStatus === 'managed'
            ? 'managed'
            : isOneOf(['trusted', 'untrusted', 'modified'], hook.trustStatus)
                ? hook.trustStatus
                : 'unknown',
    }));
    const base = {
        host: 'codex',
        context: 'configuration_snapshot',
        configured: hooks.length,
        enabled,
        trust,
        hooks: safeHooks,
        warnings,
        errors,
        inspector,
        installationMatch: 'not_verified',
        currentApplicationMatch: 'not_verified',
    };
    const observedKeys = safeHooks.map((hook) => `${hook.eventName}:${hook.family}`);
    const missing = [...EXPECTED_HOOKS].filter((key) => !observedKeys.includes(key));
    const duplicate = observedKeys.some((key, index) => observedKeys.indexOf(key) !== index);
    if (errors || warnings)
        return { state: 'unknown', cause: 'unknown', facts: { ...base, status: 'incomplete_inventory' } };
    if (hooks.length === 0)
        return { state: 'failed', cause: 'missing', facts: { ...base, status: 'missing' } };
    if (missing.length > 0 ||
        duplicate ||
        safeHooks.some(({ family, trustStatus }) => family === 'plugin_hook' || trustStatus === 'unknown'))
        return { state: 'unknown', cause: 'unknown', facts: { ...base, status: 'incomplete_inventory', missing } };
    if (enabled !== hooks.length)
        return { state: 'failed', cause: 'permission_denied', facts: { ...base, status: 'disabled' } };
    if (trust.untrusted > 0 || trust.modified > 0)
        return { state: 'failed', cause: 'permission_denied', facts: { ...base, status: 'review_required' } };
    if (trust.trusted + trust.managed !== hooks.length)
        return { state: 'unknown', cause: 'unsupported', facts: { ...base, status: 'unsupported' } };
    return { state: 'passed', facts: { ...base, status: 'ready' } };
};
// A cold `hooks/list` measured 5.5-9.7 s in Codex Desktop; a 5 s kill also kept it from ever warming. 20 s matches the
// sibling `codex mcp list` probe; feedback preparation passes its own shorter deadline.
export const collectCodexHookPermissions = async ({ cwd = process.cwd(), observedAt, now = Date.now, timeoutMs = 20_000, spawnProcess = spawn, } = {}) => {
    let result;
    try {
        result = await queryCodexAppServer({
            args: ['--stdio'],
            method: 'hooks/list',
            params: { cwds: [cwd] },
            timeoutMs,
            spawnProcess,
            clientName: 'e-comet-hook-permissions',
        });
    }
    catch (error) {
        const thrown = isRecord(error) ? error : {};
        const failure = { reason: thrown.reason ?? 'protocol_error', phase: thrown.phase ?? 'startup' };
        const facts = { host: 'codex', context: 'configuration_probe', inspector: 'transient_config_reader', status: 'failed', failure };
        const cause = failure.reason === 'permission_denied' ? 'permission_denied' : failure.reason === 'process_missing' ? 'missing' : 'unavailable';
        return diagnosticCheck({
            check: 'hook_permissions',
            state: 'not_checked',
            observedAt: observedAt ?? new Date(now()).toISOString(),
            source: 'codex_hooks_list',
            executionPlane: 'device',
            cause,
            facts,
        });
    }
    const summary = summarizeCodexHooks(result, cwd);
    if (summary.facts && !validateSchemaValue(summary.facts, hookPermissionsFactsSchema))
        return diagnosticCheck({
            check: 'hook_permissions',
            state: 'unknown',
            observedAt: observedAt ?? new Date(now()).toISOString(),
            source: 'codex_hooks_list',
            executionPlane: 'device',
            cause: 'unknown',
        });
    return diagnosticCheck({
        check: 'hook_permissions',
        observedAt: observedAt ?? new Date(now()).toISOString(),
        source: 'codex_hooks_list',
        executionPlane: 'device',
        ...summary,
    });
};
