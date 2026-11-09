import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { CLIENT_NAME, FileOAuthProvider, REMOTE_URL, createTrustedFetch, LoginRequiredError } from './oauth.mjs';
export const isLoginRequired = (error) => error instanceof LoginRequiredError || error instanceof UnauthorizedError || error instanceof InvalidGrantError;
// `version` is the package version the root read.
const isTransport = (value) => ['start', 'send', 'close'].every((method) => typeof Reflect.get(value, method) === 'function');
export async function connectRemoteClient({ provider = new FileOAuthProvider(), version = '0.0.0-development', fetchImpl = createTrustedFetch(fetch, `${CLIENT_NAME}/${version}`), } = {}) {
    if (!(await provider.tokens())?.access_token)
        throw new LoginRequiredError();
    const unlink = new AbortController();
    // Transport close does not cancel the SDK's detached OAuth flow. Explicit unlink and
    // abandoned bootstrap stop it; an ordinary close retains a finishing refresh.
    const client = Object.assign(new Client({ name: CLIENT_NAME, version }, { capabilities: {} }), {
        forgetLogin: async () => {
            const stopped = provider.stopSaving?.();
            unlink.abort();
            await stopped;
        },
    });
    const transport = new StreamableHTTPClientTransport(new URL(REMOTE_URL), {
        authProvider: provider,
        fetch: (input, init = {}) => fetchImpl(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, unlink.signal]) : unlink.signal }),
    });
    // The SDK's transport declares `sessionId` as possibly undefined, which its Transport type, read with
    // exactOptionalPropertyTypes, does not admit; the check proves the methods the client calls.
    if (!isTransport(transport))
        throw new TypeError('The MCP transport is incomplete.');
    try {
        await client.connect(transport);
        return client;
    }
    catch (error) {
        // Runtime never receives this client, so it cannot fence a later OAuth save on unlink.
        await client.forgetLogin();
        await client.close().catch(() => { });
        if (isLoginRequired(error))
            throw new LoginRequiredError();
        throw error;
    }
}
