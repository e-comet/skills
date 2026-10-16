import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { FileOAuthProvider, REMOTE_URL, createTrustedFetch, LoginRequiredError } from './oauth.mjs';
import { PACKAGE_VERSION } from './version.mjs';

export const isLoginRequired = error => error instanceof LoginRequiredError || error instanceof UnauthorizedError || error instanceof InvalidGrantError;

export async function connectRemoteClient({ provider = new FileOAuthProvider(), fetchImpl = createTrustedFetch() } = {}) {
  if (!(await provider.tokens())?.access_token) throw new LoginRequiredError();
  const client = new Client({ name: 'e-comet-deepseek-harness', version: PACKAGE_VERSION }, { capabilities: {} });
  const unlink = new AbortController();
  // Transport close does not cancel the SDK's detached OAuth flow. Explicit unlink and
  // abandoned bootstrap stop it; ordinary mounted pause/close retain a finishing refresh.
  client.forgetLogin = async () => {
    const stopped = provider.stopSaving?.();
    unlink.abort();
    await stopped;
  };
  const transport = new StreamableHTTPClientTransport(new URL(REMOTE_URL), { authProvider: provider,
    fetch: (input, init = {}) => fetchImpl(input, { ...init,
      signal: init.signal ? AbortSignal.any([init.signal, unlink.signal]) : unlink.signal }),
  });
  try { await client.connect(transport); return client; }
  catch (error) {
    // Runtime never receives this client, so it cannot fence a later OAuth save on unlink.
    await client.forgetLogin();
    await client.close().catch(() => {});
    if (isLoginRequired(error)) throw new LoginRequiredError();
    throw error;
  }
}
