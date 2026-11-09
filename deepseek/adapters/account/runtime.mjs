import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isDeepStrictEqual } from 'node:util';
import { isOneOf, isRecord } from '../../../plugins/e-comet-skills/mcp/src/shared/values.mjs';
import { STRUCTURED_MCP_EVIDENCE_MARKER } from '../../../plugins/e-comet-skills/mcp/src/support/feedback/contract/tool-calls.mjs';
import { connectRemoteClient, isLoginRequired } from './remote-client.mjs';
import { createRetry, RECONNECT_DELAYS_MS } from './retry.mjs';
// Parse boundary: an MCP result as a server sent it, read field by field.
function renderMcp(_args, value) {
    const content = isRecord(value) && Array.isArray(value.content) ? value.content : [];
    const projected = content.map((block) => {
        const fields = isRecord(block) ? block : {};
        if (fields.type === 'text' && typeof fields.text === 'string')
            return { type: 'text', text: fields.text };
        if (fields.type === 'resource_link' && typeof fields.uri === 'string') {
            return {
                type: 'text',
                text: `MCP resource: ${JSON.stringify({ name: fields.name, uri: fields.uri, mimeType: fields.mimeType })}`,
            };
        }
        return { type: 'text', text: `[MCP ${fields.type ?? 'unknown'} content is available in the canonical tool result]` };
    });
    return projected.length ? projected : [{ type: 'text', text: '(No text content returned.)' }];
}
// The account card polls while it is open; this keeps the bridge read to one per window.
const BRIDGE_STATUS_TTL_MS = 4_000;
const BRIDGE_STATUS_TIMEOUT_MS = 3_000;
const LONG_TOOL_TIMEOUT_MS = 7_200_000;
/**
 * The extension route as `local_bridge_status` observes it, read from its closed cause `code`. Anything unreadable, an
 * error result and a status without a code keep the process status.
 */
function extensionRoute(result) {
    try {
        if (!isRecord(result) || !Array.isArray(result.content))
            return 'connected';
        const block = result.content.find((item) => isRecord(item) && item.type === 'text');
        if (!isRecord(block))
            return 'connected';
        const status = JSON.parse(String(block.text));
        if (result.isError === true ||
            !isRecord(status) ||
            status.ok !== true ||
            status.extensionConnected === true ||
            status.code === 'connected')
            return 'connected';
        if (status.code === 'connecting')
            return 'checking';
        // Their user step is the offline card's: open the browser, or click the e-Comet icon in the one that runs (a connector
        // that answered once and is gone now asks for the same click first).
        const offline = ['BRIDGE_NO_BROWSER', 'BRIDGE_HOST_NOT_STARTED', 'BRIDGE_PERMISSION_REQUIRED', 'BRIDGE_BROKER_NOT_VISIBLE'];
        if (isOneOf(offline, status.code))
            return 'extension_offline';
        return typeof status.code === 'string' ? 'bridge_unavailable' : 'connected';
    }
    catch {
        return 'connected';
    }
}
/**
 * The closed class of a failed call, read from the SDK error type and the transport state; the error text never leaves
 * this process.
 * The SDK clears the transport before it rejects in-flight requests, so `transportClosed` tells its own closed
 * connection (`network`) from a server-sent -32000 (`protocol`). A server-sent -32001 still reads as `timeout`,
 * and a call cut by a transport this adapter closed reads as `network`: see "Native DeepSeek `cause` for a closed
 * transport and SDK-reserved error numbers" in docs/architecture/residuals/deepseek.md.
 */
// Node's fetch rejects with a TypeError whose cause carries the socket, DNS, TLS or undici connection code; only these
// are network facts. Any other code (a malformed redirect target, a bad argument, an oversized answer) stays unknown,
// so the doctor never sends the user to check VPN, proxy or firewall for a malformed service answer.
const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EAI_FAIL',
    'ETIMEDOUT',
    'EPIPE',
    'EPROTO',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
// Parse boundary: whatever the call threw, read by its type and code.
export function callFailureCause(error, { transportClosed = false } = {}) {
    if (error instanceof StreamableHTTPError) {
        // A status-less HTTP error reads as neither class.
        const status = error.code ?? 0;
        return status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : 'protocol';
    }
    if (error instanceof McpError)
        return error.code === ErrorCode.RequestTimeout
            ? 'timeout'
            : error.code === ErrorCode.ConnectionClosed && transportClosed
                ? 'network'
                : 'protocol';
    if (error instanceof TypeError) {
        const code = isRecord(error.cause) ? error.cause.code : undefined;
        return typeof code === 'string' && NETWORK_CODES.has(code) ? 'network' : 'unknown';
    }
    if (isRecord(error) && error.name === 'TimeoutError')
        return 'timeout';
    return 'unknown';
}
// Node's spawn failures for the host executable; anything else is the handshake's own failure class.
const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM', 'E2BIG', 'ENOEXEC']);
/** Why the local module is not running: a closed class plus an allowlisted system code, never the error text. */
// The child's exit code is not reported: see "Native DeepSeek local exit code not reported" in
// docs/architecture/residuals/deepseek.md.
export function localFailureOf(error) {
    const code = isRecord(error) ? error.code : undefined;
    if (typeof code === 'string' && SPAWN_CODES.has(code))
        return { cause: 'spawn_failed', systemCode: code };
    if (error instanceof McpError)
        return {
            cause: error.code === ErrorCode.RequestTimeout ? 'timeout' : error.code === ErrorCode.ConnectionClosed ? 'exited' : 'protocol',
        };
    return { cause: 'unknown' };
}
// A closed failure the host shows the model as the tool's result (the tool runtime adapter has its own).
const failure = (code, message, stage = 'handoff', extra = {}) => Object.assign(new Error(JSON.stringify({ ok: false, code, stage, ...extra, message })), { code });
/**
 * Owned registrations keep the private handoff inside the actual MCP call body. `version` is the package version the
 * root read; `projectToolOutcome` the feedback tool-names port's projection of a failed remote grant's evidence.
 */
export async function registerMcpClients(ctx, { adapter, remote, local, onUnavailable = () => { }, retryDelaysMs = RECONNECT_DELAYS_MS, version = '0.0.0-development', projectToolOutcome, }) {
    const connections = new Map();
    const statuses = { remote: 'disconnected' };
    let disposed = false;
    const mounting = new Set();
    let remoteChange = Promise.resolve();
    let bridgeRead;
    let bridgeCache;
    // Local tools carry no account state, so a lost local process is simply started again.
    let localRestarts = 0;
    const localRestart = createRetry(async () => {
        if (disposed || connections.has('local'))
            return true;
        localRestarts += 1;
        await mount('local', 'e-comet-local');
        return statuses.local === 'connected';
    }, { delays: retryDelaysMs });
    async function unmount(kind, forgetLogin = false) {
        const connection = connections.get(kind);
        connections.delete(kind);
        if (connection) {
            if (forgetLogin)
                await connection.client.forgetLogin?.();
            for (const unregister of connection.owned.reverse())
                unregister();
            await connection.client.close().catch(() => { });
        }
        statuses[kind] = 'disconnected';
    }
    const dispose = async () => {
        if (disposed)
            return;
        disposed = true;
        localRestart.stop();
        // A restart already inside mount() would register tools after this snapshot.
        await Promise.allSettled([remoteChange, ...mounting]);
        await Promise.allSettled([...connections.keys()].map((kind) => unmount(kind)));
    };
    async function mount(kind, namespace) {
        if (disposed)
            return;
        const task = open(kind, namespace);
        mounting.add(task);
        try {
            await task;
        }
        finally {
            mounting.delete(task);
        }
    }
    async function open(kind, namespace) {
        let client;
        let spawnError;
        const owned = [];
        try {
            if (kind === 'remote')
                client = await connectRemoteClient({ ...remote, version });
            else {
                client = new Client({ name: 'e-comet-deepseek-harness', version }, { capabilities: {} });
                // A module started again learns the closed class of the failure before it and how often it was started again,
                // so a bug report it prepares shows more than MCP_CALL_FAILED.
                const restart = {
                    ...(statuses.localFailure ? { ECOMET_HOST_LAST_FAILURE: statuses.localFailure.cause } : {}),
                    ...(localRestarts > 0 ? { ECOMET_HOST_RESTARTS: String(localRestarts) } : {}),
                };
                const transport = new StdioClientTransport({
                    ...local,
                    env: { ...scrubbedParentEnv(), ...local.env, ...restart },
                    stderr: 'inherit',
                });
                // On Windows the SDK's spawn falls back to a shell wrapper when the executable does not resolve, so a missing
                // executable surfaces as a transport error followed by a closed connection; keep the spawn code for the class.
                transport.onerror = (error) => {
                    const code = isRecord(error) ? error.code : undefined;
                    if (typeof code === 'string' && SPAWN_CODES.has(code))
                        spawnError ??= error;
                };
                await client.connect(transport);
            }
            const connected = client;
            const instructions = connected.getInstructions();
            if (instructions && ctx.systemPrompt) {
                owned.push(ctx.systemPrompt.section({ name: `e-comet:${kind}:instructions`, order: 180, text: instructions, interpolate: false }));
            }
            const tools = [];
            const cursors = new Set();
            let cursor;
            do {
                // Keep SDK output validation; catalog compilation is an accepted residual
                // in docs/architecture/residuals/deepseek.md.
                const page = await connected.listTools(cursor === undefined ? {} : { cursor });
                tools.push(...page.tools);
                cursor = page.nextCursor;
                if (cursor !== undefined && cursors.has(cursor))
                    throw new Error('Repeated tool-list cursor');
                if (cursor !== undefined)
                    cursors.add(cursor);
            } while (cursor !== undefined);
            for (const tool of tools) {
                const name = `mcp__${namespace}__${tool.name}`;
                if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
                    ctx.logger?.warn(`e-Comet ${kind} MCP tool skipped: its namespaced name is incompatible with the DeepSeek tool-name contract.`);
                    continue;
                }
                // No presentResult: the pinned Web Client ignores presenters; see "Native DeepSeek `presentResult` not
                // implemented" in docs/architecture/residuals/deepseek.md.
                const definition = adapter.wrapToolDefinition({
                    name,
                    description: tool.description ?? tool.name,
                    parameters: tool.inputSchema,
                    timeoutMs: LONG_TOOL_TIMEOUT_MS,
                    output: { schema: {}, render: renderMcp },
                    async execute(args, exec) {
                        let called;
                        // The host validated the arguments against the tool's own schema.
                        const toolArguments = isRecord(args) ? args : undefined;
                        try {
                            called = await connected.callTool({ name: tool.name, arguments: toolArguments }, undefined, {
                                signal: exec.signal,
                                timeout: LONG_TOOL_TIMEOUT_MS,
                                ...(kind === 'remote' ? { maxTotalTimeout: LONG_TOOL_TIMEOUT_MS } : {}),
                                resetTimeoutOnProgress: true,
                            });
                        }
                        catch (error) {
                            if (kind === 'remote' && isLoginRequired(error)) {
                                if (connections.get(kind)?.client === connected) {
                                    connections.delete(kind);
                                    for (const unregister of owned.reverse())
                                        unregister();
                                    statuses[kind] = 'unavailable';
                                    // Report before awaiting the close so a status read in between cannot lose the reason.
                                    onUnavailable(kind, 'login_required');
                                    await connected.close().catch(() => { });
                                }
                                throw failure('ECOMET_LOGIN_REQUIRED', 'Ask the user to open Plugins → e-Comet Skills in DeepSeek and connect the e-Comet account again.', 'authorization');
                            }
                            // Cancellation stops waiting; it does not establish whether upstream work completed.
                            if (exec.signal.aborted)
                                throw failure('ECOMET_CALL_STOPPED', 'Waiting for this call stopped. Remote completion is unknown; check existing results before retrying.', 'cancellation');
                            if (kind === 'remote' && error instanceof StreamableHTTPError && isOneOf([401, 404], error.code)) {
                                // A failed post-refresh retry can leave SDK authentication exhausted until a new transport.
                                // Settle the failed call before closing that transport or an expired session; never replay it.
                                // A queued close must not withdraw a newer connection after a manual reconnect.
                                setImmediate(() => {
                                    if (connections.get(kind)?.client === connected)
                                        connected.close().catch(() => { });
                                });
                            }
                            // Keep arbitrary remote exception text out of history until a safe structured projection is available.
                            throw failure('MCP_CALL_FAILED', 'The e-Comet call failed; its class is in cause and its completion status is unknown. Check existing results before retrying; do not retry automatically.', 'call', { cause: callFailureCause(error, { transportClosed: connected.transport === undefined }) });
                        }
                        // The SDK checked the result against its schema; its fields are read one by one.
                        const result = isRecord(called) ? called : {};
                        if (result.isError === true) {
                            if (kind === 'remote' && ['browser_job', 'report_issue'].includes(tool.name)) {
                                // Even failed grant responses may contain credentials. Preserve only
                                // closed evidence; absent evidence cannot diagnose connection or consent.
                                // See "Unstructured remote tool failures" in the architecture's accepted residuals.
                                const evidence = result.structuredContent === undefined
                                    ? result.content
                                    : [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
                                // A remote failure without the projection throws here, as it always has without one.
                                if (!projectToolOutcome)
                                    throw new TypeError('The remote failure projection is unavailable.');
                                throw new Error(JSON.stringify({
                                    ...projectToolOutcome(evidence, true, name),
                                    ok: false,
                                    message: tool.name === 'browser_job'
                                        ? 'Remote browser-job request failed. Use safe error fields when present; otherwise the cause is unknown. Do not retry automatically.'
                                        : 'Remote feedback authorization failed. Preserve the prepared report; do not repeat authorization automatically.',
                                }));
                            }
                            // A failed package may still contain completed artifacts and per-filter
                            // failures. Preserve that evidence so recovery cannot repeat completed work.
                            let textContainsEvidence = false;
                            const only = Array.isArray(result.content) && result.content.length === 1 ? result.content[0] : undefined;
                            if (isRecord(only) && only.type === 'text') {
                                try {
                                    textContainsEvidence = isDeepStrictEqual(JSON.parse(String(only.text)), result.structuredContent);
                                }
                                catch {
                                    /* Summaries and malformed text still need structured evidence. */
                                }
                            }
                            // Multiple rendered blocks are not a JSON document, even when their
                            // first block is JSON. Keep their suffix for native feedback extraction.
                            const evidence = result.structuredContent === undefined || textContainsEvidence
                                ? ''
                                : `${STRUCTURED_MCP_EVIDENCE_MARKER}${JSON.stringify(result.structuredContent)}`;
                            throw new Error(renderMcp(args, result)
                                .map((block) => block.text)
                                .join('\n') + evidence);
                        }
                        return {
                            content: result.content,
                            ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
                        };
                    },
                });
                // Fixed names assume one live plugin instance: see "Native DeepSeek registrations assume one live plugin
                // instance" in docs/architecture/residuals/deepseek.md.
                owned.push(ctx.tools.register(definition));
                if (kind === 'remote' && tool.annotations?.destructiveHint === true) {
                    owned.push(ctx.on('tools/pre-execute', async (exec, next) => {
                        const decision = await next();
                        if (exec.name !== name || decision.kind !== 'allow')
                            return decision;
                        // ToolRuntime allows a call without an agent; there is no session to resolve permission for.
                        const session = exec.agent?.session;
                        if (!session)
                            return { kind: 'deny', reason: 'An e-Comet settings change needs a chat session to confirm it.' };
                        const approval = ctx.get('approval');
                        // Resolve per call: switching presets or using another chat must not reuse permission.
                        // Only the shipped Full access combination skips our ask; never override a host ask/deny.
                        const fullAccess = ctx.get('sandboxPolicy')?.resolve({ session }).mode === 'danger-full-access' &&
                            (approval?.overrideOf?.(session) ?? approval?.config?.policy ?? 'ask') === 'never';
                        return fullAccess
                            ? decision
                            : {
                                kind: 'ask',
                                reason: 'Confirm the requested e-Comet settings change.',
                                displayReason: {
                                    en: 'Allow this e-Comet settings change?',
                                    ru: 'Разрешить это изменение настроек e-Comet?',
                                },
                            };
                    }, { prepend: true }));
                }
            }
            // Keep everything after the last listTools await synchronous: a transport close is delivered only on a
            // later event-loop turn, so it cannot slip in before this handler; a close during listTools rejects it.
            connections.set(kind, { client: connected, owned });
            statuses[kind] = 'connected';
            if (kind === 'local')
                delete statuses.localFailure;
            connected.onclose = () => {
                if (connections.get(kind)?.client !== connected)
                    return;
                connections.delete(kind);
                for (const unregister of owned.reverse())
                    unregister();
                statuses[kind] = 'unavailable';
                // A post-handshake crash loop re-enters here about every 5 s: see "Native DeepSeek snapshot flapping during a
                // crash loop" in docs/architecture/residuals/deepseek.md.
                if (kind === 'local')
                    statuses.localFailure = { cause: 'exited' };
                if (disposed)
                    return;
                if (kind === 'local')
                    localRestart.schedule();
                else
                    onUnavailable(kind, 'closed');
            };
        }
        catch (error) {
            for (const unregister of owned.reverse())
                unregister();
            // Catalog/bootstrap failure discards the client before it becomes an owned connection.
            await client?.forgetLogin?.();
            await client?.close().catch(() => { });
            statuses[kind] = 'unavailable';
            // The card, the model's runtime context and the log see the same closed class; the error text stays here.
            const localFailure = kind === 'local' ? localFailureOf(spawnError ?? error) : undefined;
            if (localFailure)
                statuses.localFailure = localFailure;
            ctx.logger?.warn(`e-Comet ${kind} MCP is unavailable${localFailure ? ` (${localFailure.cause}${localFailure.systemCode ? ` ${localFailure.systemCode}` : ''})` : ''}. Inspect that connection's diagnostics; the other connection remains independent.`);
            // Account recovery must distinguish a refused login from an unavailable service.
            if (kind === 'remote')
                throw error;
        }
    }
    function connectRemote() {
        remoteChange = remoteChange
            .catch(() => { })
            .then(async () => {
            if (disposed)
                throw new Error('e-Comet integration has stopped.');
            if (connections.has('remote'))
                return;
            await mount('remote', 'e-comet');
            if (statuses.remote !== 'connected')
                throw new Error('e-Comet remote MCP is unavailable.');
        });
        return remoteChange;
    }
    function disconnectRemote({ forgetLogin = false } = {}) {
        remoteChange = remoteChange.catch(() => { }).then(() => unmount('remote', forgetLogin));
        return remoteChange;
    }
    /** Local MCP status refined by whether the browser extension currently has a route. */
    function localStatus() {
        const client = connections.get('local')?.client;
        if (!client)
            return Promise.resolve(statuses.local ?? 'disconnected');
        if (bridgeCache?.client === client && Date.now() - bridgeCache.at < BRIDGE_STATUS_TTL_MS)
            return Promise.resolve(bridgeCache.value);
        // A direct read: the status tool is read-only, and it must not count as agent tool activity.
        bridgeRead ??= client
            .callTool({ name: 'local_bridge_status', arguments: {} }, undefined, { timeout: BRIDGE_STATUS_TIMEOUT_MS })
            .then(extensionRoute, () => 'connected')
            .then((value) => {
            bridgeCache = { client, at: Date.now(), value };
            return value;
        })
            .finally(() => {
            bridgeRead = undefined;
        });
        return bridgeRead;
    }
    await mount('local', 'e-comet-local');
    if (statuses.local !== 'connected')
        localRestart.schedule();
    return { dispose, statuses, connectRemote, disconnectRemote, localStatus };
}
