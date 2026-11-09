import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '../../../plugins/e-comet-skills/mcp/src/shared/values.mjs';
import { RETRY_POLICIES, retryTransientFileOperation } from '../../../plugins/e-comet-skills/mcp/src/storage/files/transient-retry.mjs';
// Any object reads as a store: only this process writes the file, and its fields keep the shapes it wrote.
const isCredentials = (value) => isRecord(value);
export const REMOTE_URL = 'https://mcp.e-comet.io/mcp';
export const OAUTH_ISSUER_ORIGIN = 'https://auth.mcp.e-comet.io';
export const CREDENTIAL_DIRECTORY = join(homedir(), '.e-comet-deepseek-harness', 'account');
export class LoginRequiredError extends Error {
    constructor() {
        super('e-Comet login required. Open Plugins → e-Comet Skills in DeepSeek and connect your account.');
        this.name = 'LoginRequiredError';
    }
}
/** SDK OAuthClientProvider. Credentials are never returned as MCP content. */
export class FileOAuthProvider {
    #savingStopped = false;
    #writes = new Set();
    constructor({ directory = CREDENTIAL_DIRECTORY, redirectUrl, onAuthorization, } = {}) {
        this.directory = directory;
        this.file = join(directory, 'credentials.json');
        this.callbackUrl = redirectUrl;
        this.onAuthorization = onAuthorization;
        this.oauthState = randomBytes(32).toString('hex');
    }
    get redirectUrl() {
        return this.callbackUrl ?? 'http://127.0.0.1/callback';
    }
    get clientMetadata() {
        return {
            client_name: 'e-Comet DeepSeek Harness',
            redirect_uris: [this.redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_post',
        };
    }
    state() {
        return this.oauthState;
    }
    async read() {
        try {
            const state = JSON.parse(await readFile(this.file, 'utf8'));
            return isCredentials(state) ? state : {};
        }
        catch (error) {
            if ((isRecord(error) && error.code === 'ENOENT') || error instanceof SyntaxError)
                return {};
            // Other failures keep automatic reconnection: "Native DeepSeek unreadable credential store"
            // in docs/architecture/residuals/deepseek.md.
            throw new Error('Cannot read e-Comet login state. Check access to the credentials directory.', { cause: error });
        }
    }
    async stopSaving() {
        this.#savingStopped = true;
        // A rename already in flight must finish before the account owner deletes credentials.
        await Promise.allSettled(this.#writes);
    }
    update(patch) {
        if (this.#savingStopped)
            return Promise.resolve();
        const writing = this.#write(patch);
        this.#writes.add(writing);
        writing.then(() => this.#writes.delete(writing), () => this.#writes.delete(writing));
        return writing;
    }
    async #write(patch) {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await chmod(this.directory, 0o700);
        const temporary = join(this.directory, `credentials-${randomBytes(8).toString('hex')}.tmp`);
        try {
            await writeFile(temporary, JSON.stringify({ ...(await this.read()), ...patch }), { mode: 0o600, flag: 'wx' });
            await retryTransientFileOperation(() => rename(temporary, this.file), RETRY_POLICIES.FEEDBACK);
            await chmod(this.file, 0o600);
        }
        finally {
            // Preserve the publication error and other profiles' active files; see
            // docs/architecture/residuals/deepseek.md for permanent refusal and refresh races.
            await retryTransientFileOperation(() => rm(temporary, { force: true }), RETRY_POLICIES.FEEDBACK).catch(() => { });
        }
    }
    async tokens() {
        return (await this.read()).tokens;
    }
    async saveTokens(tokens) {
        await this.update({ tokens });
    }
    async clientInformation() {
        return (await this.read()).clientInformation;
    }
    async saveClientInformation(clientInformation) {
        await this.update({ clientInformation, redirectUrl: this.redirectUrl });
    }
    async saveCodeVerifier(codeVerifier) {
        await this.update({ codeVerifier });
    }
    async codeVerifier() {
        const verifier = (await this.read()).codeVerifier;
        if (!verifier)
            throw new LoginRequiredError();
        return verifier;
    }
    async redirectToAuthorization(url) {
        if (!this.onAuthorization) {
            // The SDK also reaches this fallback after an unavailable refresh; rejected
            // grants/clients are cleared first. Retained credentials do not prove expiry.
            if ((await this.tokens())?.refresh_token)
                throw new Error('e-Comet token refresh could not complete. Check connection diagnostics before retrying.');
            throw new LoginRequiredError();
        }
        if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('Invalid OAuth authorization URL.');
        await this.onAuthorization(url);
    }
    async validateResourceURL(serverUrl, resource) {
        if (new URL(serverUrl).origin !== new URL(REMOTE_URL).origin)
            throw new Error('Untrusted MCP resource.');
        if (resource && new URL(resource).origin !== new URL(REMOTE_URL).origin)
            throw new Error('Untrusted OAuth resource.');
        return new URL(resource ?? REMOTE_URL);
    }
    async invalidateCredentials(scope) {
        const patch = {};
        if (scope === 'all' || scope === 'tokens')
            patch.tokens = undefined;
        if (scope === 'all' || scope === 'client')
            patch.clientInformation = undefined;
        if (scope === 'all' || scope === 'verifier')
            patch.codeVerifier = undefined;
        await this.update(patch);
    }
}
// e-Comet's MCP log tells hosts apart only by User-Agent, and Node's default `node` is also every script's.
export const CLIENT_NAME = 'e-comet-deepseek-harness';
/** Only e-Comet and the HTTPS issuer advertised by its protected-resource metadata. */
export function createTrustedFetch(fetchImpl = fetch, userAgent = CLIENT_NAME) {
    const resourceOrigin = new URL(REMOTE_URL).origin;
    const allowedOrigins = new Set([resourceOrigin]);
    let issuer;
    // The URL parser reads any value as its string form.
    function secure(value) {
        const url = new URL(String(value));
        if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('OAuth requires HTTPS without embedded credentials.');
        return url;
    }
    return async (input, options = {}) => {
        const url = secure(typeof input === 'object' && 'url' in input ? input.url : String(input));
        if (!allowedOrigins.has(url.origin))
            throw new Error('OAuth endpoint is not trusted by e-Comet discovery.');
        const headers = new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set('User-Agent', userAgent);
        const response = await fetchImpl(input, { ...options, headers, redirect: 'error' });
        if (response.ok && url.pathname.includes('/.well-known/')) {
            // Parse boundary: discovery metadata as the server sent it. JSON null has no fields to read; other
            // non-objects read every field as absent.
            const metadata = await response.clone().json();
            if (metadata === null)
                throw new TypeError('OAuth discovery metadata is null.');
            const field = (key) => (isRecord(metadata) ? metadata[key] : undefined);
            if (url.origin === resourceOrigin && url.pathname.includes('oauth-protected-resource')) {
                if (secure(field('resource')).origin !== resourceOrigin)
                    throw new Error('Untrusted protected resource metadata.');
                const servers = field('authorization_servers');
                // Read the first entry the way an index read always did, whatever the server sent.
                const server = typeof servers === 'string' || Array.isArray(servers) ? servers[0] : isRecord(servers) ? servers['0'] : undefined;
                if (!server)
                    throw new Error('e-Comet did not advertise an OAuth issuer.');
                issuer = secure(server);
                if (issuer.origin !== OAUTH_ISSUER_ORIGIN)
                    throw new Error('Untrusted e-Comet OAuth issuer.');
                allowedOrigins.add(issuer.origin);
            }
            else if (field('issuer')) {
                if (!issuer || secure(field('issuer')).href !== issuer.href)
                    throw new Error('OAuth issuer differs from e-Comet discovery.');
                for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
                    if (field(key) && secure(field(key)).origin !== issuer.origin)
                        throw new Error('OAuth endpoint differs from the discovered issuer.');
                }
            }
        }
        return response;
    };
}
/** One login attempt owns an ephemeral loopback listener and unpredictable OAuth state. */
export async function startCallback(expectedState, { timeoutMs = 300_000 } = {}) {
    let resolveCode;
    let rejectCode;
    const code = new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });
    // A timeout may precede the caller awaiting the promise during discovery.
    code.catch(() => { });
    const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        let url;
        // Request targets must not become URL authorities or escape this event handler as parse errors.
        const target = request.url ?? '';
        if (/^\/(?![\\/])/.test(target)) {
            try {
                url = new URL(target, 'http://127.0.0.1');
            }
            catch {
                /* reject below */
            }
        }
        if (!url || request.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== expectedState) {
            response.writeHead(400);
            response.end('Invalid OAuth callback.');
            return;
        }
        if (url.searchParams.has('error')) {
            response.writeHead(400);
            response.end('Authorization was declined. Return to the e-Comet panel in the app.');
            rejectCode(Object.assign(new Error('e-Comet authorization was declined.'), { errorCode: 'authorization-declined' }));
            clearTimeout(timer);
            server.close();
            return;
        }
        const authorizationCode = url.searchParams.get('code');
        if (!authorizationCode) {
            response.writeHead(400);
            response.end('Missing authorization code.');
            return;
        }
        response.end('Authorization received. Return to the e-Comet panel in the app.');
        resolveCode(authorizationCode);
        clearTimeout(timer);
        server.close();
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    // The handler cannot run before this line: a request arrives only after the listen continuation.
    const timer = setTimeout(() => {
        rejectCode(Object.assign(new Error('OAuth login timed out.'), { errorCode: 'connection-timeout' }));
        server.close();
    }, timeoutMs);
    // A listening TCP server has its address.
    const address = server.address();
    if (address === null || typeof address === 'string')
        throw new Error('The OAuth callback listener has no address.');
    return {
        url: `http://127.0.0.1:${address.port}/callback`,
        code,
        close() {
            clearTimeout(timer);
            rejectCode(new Error('OAuth login cancelled.'));
            server.close();
        },
    };
}
