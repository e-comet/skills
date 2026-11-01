// Holds this process's one extension session through a browser-started broker. Sessions come only from the broker
// client's discovery handler, so kick(), the background re-list and a tool call share one connect attempt and a second
// session can never replace a live one. Without a session it keeps what it last observed, so status() and a tool call
// can name why no broker answers (spec §5.7, §5.8).
import { bridgeOwner, chooseBridgeCause, chosenBrowser, shouldWaitForBroker } from './bridge-cause.mjs';
import { EXTENSION_INSTALL_VOCABULARY } from './diagnostic-facts.mjs';
import { bridgeFrameRefusal, extensionDisconnectedError } from './extension-protocol.mjs';
import { createTransportEvents } from './transport-events.mjs';

const iso = (ms) => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null);
const text = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined);
// A failed step and its system code as one identifier, `ManifestWrite_EPERM`: step names carry no underscore.
const stepCode = (/** @type {unknown} */ name, /** @type {unknown} */ code) => [text(name), text(code)].filter(Boolean).join('_').slice(0, 64);
// Frames the broker writes itself: they say nothing about whether the extension still answers.
const BROKER_FRAMES = new Set(['session_end', 'broker_refusal']);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REFRESH_INTERVAL_MS = 30_000;
const WAIT_MS = 30_000;
const POLL_MS = 500;

const publicRegistration = (result) => result && {
    state: result.state,
    version: result.version,
    runtime: result.runtime ?? null,
    manifestWrittenAt: iso(result.manifestWrittenAtMs),
    verifiedSinceAt: iso(result.verifiedSinceMs),
    runtimeRecheck: result.runtimeRecheck ?? 'not_run',
    error: result.error ? { name: String(result.error.name), code: typeof result.error.code === 'string' ? result.error.code : null } : null,
};

/**
 * @param {{ brokerClient: any, registration: (options?: { repair?: boolean }) => Promise<any>, extensionProtocol: any, connections: any,
 *   log: (...args: any[]) => void, env?: Record<string, string | undefined>, platform?: string, platformCause?: string | null,
 *   readPolicy?: () => Promise<any>, probe?: () => Promise<any>, now?: () => number,
 *   readExtensionLog?: (options: { browser: string }) => Promise<import('./extension-log.mjs').ExtensionLogEvidence | null>,
 *   comspec?: () => 'valid' | 'invalid' | 'unknown' | 'not_applicable', transportEvents?: ReturnType<typeof createTransportEvents> }} options
 * `registration` both ensures and repairs: one idempotent pass, where `repair` also rewrites the Windows key.
 * `readPolicy` and `probe` read the native messaging policies and the extension_install probe; either may answer null
 * when it read nothing. `readExtensionLog` reads the extension's own log from disk and `comspec` the ComSpec variable;
 * both only when a tool call found no broker (ComSpec also when a diagnosis hands over its own read of the log), never
 * in the background or for status. `transportEvents` keeps what
 * otherwise reaches only stderr; server.mjs shares it with the request broker for late answers.
 */
export function createBridgeClientRuntime({ brokerClient, registration, extensionProtocol, connections, log, env = process.env,
    platform = process.platform, platformCause = null, readPolicy = async () => null, probe = async () => null, now = Date.now,
    readExtensionLog = async () => null, comspec = () => 'not_applicable', transportEvents = createTransportEvents({ now }) }) {
    // A spawned test server must never dial the developer's real broker: under test only an injected state directory,
    // and with it a test rendezvous, lets it look.
    const discoveryAllowed = env.NODE_ENV !== 'test' || Boolean(env.ECOMET_TEST_STATE_DIR?.trim());
    let initialized = false;
    let closed = false;
    let firstRefreshDone = false;
    let waiting = 0;
    let refreshTimer = null;
    let registrationResult = null;
    let policy = null;
    let probeResult = null;
    /** @type {import('./extension-log.mjs').ExtensionLogEvidence | null} */
    let extensionLog = null;
    /** @type {'valid' | 'invalid' | 'unknown' | 'not_applicable'} */
    let comspecState = 'not_applicable';
    let lastConnect = null;
    let lastSessionEndAtMs = null;
    // When the extension last sent a frame over a session: the route_freshness observation.
    let routeLastObservedAtMs = null;
    let brokers = [];
    let lastFailureRecord = null;
    // A failure record is one event however many refreshes list it before a later start deletes it.
    const seenFailureRecords = new Set();
    let refreshing = null;
    let refreshAgain = false;

    // The broker list and the newest failure record, re-read after every connect attempt and session change so status()
    // can answer from memory without touching the disk. A change during a read is read again.
    const refresh = () => {
        if (!initialized || !discoveryAllowed || closed) return Promise.resolve();
        if (refreshing) {
            refreshAgain = true;
            return refreshing;
        }
        refreshing = (async () => {
            do {
                refreshAgain = false;
                try {
                    const entries = await brokerClient.listEntries();
                    const records = await brokerClient.listFailureRecords({ manifestWrittenAtMs: registrationResult?.manifestWrittenAtMs ?? null });
                    // Assigned together, so a status read between the two reads never pairs new brokers with an old record.
                    brokers = entries;
                    lastFailureRecord = records.find((record) => text(record.name) && iso(record.at)) ?? null;
                    for (const record of records) {
                        const key = `${record.pid}:${record.at}`;
                        if (seenFailureRecords.has(key)) continue;
                        seenFailureRecords.add(key);
                        transportEvents.add({ kind: 'failure_record_seen', code: stepCode(record.name, record.code) });
                    }
                } catch (error) {
                    log(`e-comet bridge: broker list not read (${error?.code ?? 'unknown'})`);
                }
            } while (refreshAgain && !closed);
        })().finally(() => { refreshing = null; });
        return refreshing;
    };

    // `repair` is a tool call that found no broker: it rewrites what an ordinary start trusts from its last check.
    const runRegistration = async (options = {}) => {
        try {
            registrationResult = await registration(options);
            if (registrationResult?.error) transportEvents.add({ kind: 'registration_step_failed', code: stepCode(registrationResult.error.name, registrationResult.error.code) });
        } catch (error) {
            log(`e-comet registration failed (${error?.code ?? 'unknown'})`);
            transportEvents.add({ kind: 'registration_step_failed', code: text(error?.code) ?? 'unknown' });
        }
    };
    // Calls that find no broker while a repair runs await it: a second pass's PowerShell would find the key this one
    // restored and answer from the older time it read. Accepted residual "Two processes each run a repair":
    // docs/local-agent-architecture.md#accepted-residuals.
    let repairing = null;
    const repair = () => (repairing ??= runRegistration({ repair: true }).finally(() => { repairing = null; }));

    // The policy and the profile probe. macOS 27 guards the profile folders, so there the background skips the probe and
    // only a tool call or an explicitly selected diagnosis probe reads it. The policy is read at start, on a tool call
    // and in a diagnosis, never in the background: on Windows it is eight hidden reg.exe processes for a value only a managed policy changes.
    // Accepted residual "Stale user-level-hosts policy between reads": docs/local-agent-architecture.md#accepted-residuals.
    const readDevice = async ({ withPolicy = true, withProbe }) => {
        const read = async (reader, what) => {
            try {
                return await reader();
            } catch (error) {
                log(`e-comet bridge: ${what} not read (${error?.code ?? 'unknown'})`);
                return null;
            }
        };
        // Only what this pass read is written: a slow background pass must not put back a value a tool call or a
        // diagnosis replaced meanwhile.
        const [nextPolicy, nextProbe] = await Promise.all([withPolicy && read(readPolicy, 'policy'), withProbe && read(probe, 'probe')]);
        if (withPolicy) policy = nextPolicy;
        if (withProbe) probeResult = nextProbe;
        // Return this pass's observation: another refresh may replace the stored value before its caller uses it.
        return nextProbe;
    };

    // Every attempt this process awaits leaves its outcome for the cause. A stopped client answers like a failed attempt.
    // A broker that is there and does not answer is an event; no broker at all is the ordinary state, not one.
    const attempt = () => brokerClient.connect().then((outcome) => {
        lastConnect = outcome;
        if (outcome?.ok === false && outcome.reason !== 'no_entries') transportEvents.add({ kind: 'connect_failed', code: text(outcome.code) ?? text(outcome.reason) ?? 'unknown' });
        return outcome;
    }, (error) => {
        if (error?.code !== 'BROKER_CLIENT_STOPPED') {
            log(`e-comet bridge: connect failed (${error?.code ?? 'unknown'})`);
            transportEvents.add({ kind: 'connect_failed', code: text(error?.code) ?? 'unknown' });
        }
        return { ok: false, reason: 'failed' };
    });

    const cause = () => chooseBridgeCause({
        platformCause, registration: registrationResult, policy, probe: probeResult, entries: brokers,
        failureRecords: lastFailureRecord ? [lastFailureRecord] : [], lastConnect, now: now(), extensionLog, comspec: comspecState,
    });

    // Never throws: a throw here would orphan the session in the broker client.
    const onSession = (session) => {
        try {
            if (closed) return void session.close();
            extensionProtocol.openSession(session, session.facts, session.browserContext);
            // The browser found the connector: what its log said before no longer explains anything.
            extensionLog = null;
            let endReason;
            session.onFrame((frame) => {
                if (frame?.type === 'session_end') endReason = frame.reason;
                if (!BROKER_FRAMES.has(frame?.type)) routeLastObservedAtMs = now();
                // Not awaited: one owner's slow stream write must not hold back another owner's reply. There is no
                // receive window either: see "No client-side receive window over a broker session" in
                // docs/local-agent-architecture.md#accepted-residuals.
                void Promise.resolve(extensionProtocol.handleMessage(session, frame)).catch((error) => {
                    log('extension message handling failed:', error?.message);
                    session.close();
                });
            });
            session.onClose(() => {
                // A browser restart or an extension update ends the session; a tool call shortly after waits for the
                // broker to come back.
                lastSessionEndAtMs = now();
                // The broker's own reason, a stream error the broker client saw, or a plain close.
                transportEvents.add({ kind: 'session_end', code: text(endReason) ?? text(session.endCode) ?? 'closed' });
                // WHY: the profile probe was read before this session opened, and darwin reads none in the background,
                // so after a browser quit it would name a permission step or a running browser that no longer exist.
                probeResult = null;
                extensionProtocol.onSessionEnd(session);
                void refresh();
            });
            void refresh();
        } catch (error) {
            log('extension session could not open:', error?.message);
            session.close();
            // The close handler may not be registered yet, and a half-opened session must not stay current over a
            // closed connection. Ending it twice is harmless: only the current session is ended.
            try {
                extensionProtocol.onSessionEnd(session);
            } catch (endError) {
                log('extension session could not end:', endError?.message);
            }
        }
    };

    const kick = () => {
        if (!initialized || !discoveryAllowed || closed || connections.extensionSession) return;
        void attempt().then(refresh);
    };

    return {
        onInitialized() {
            if (initialized || closed) return;
            initialized = true;
            // The broker list is read as soon as the registration is in, before a session opens, so status lists a
            // running broker from the start.
            const registered = runRegistration().then(refresh);
            if (!discoveryAllowed) return;
            brokerClient.startBackgroundDiscovery({ onSession });
            // Discovery's own re-lists are not seen here, so this one also tries the brokers: status follows a broker that
            // stopped answering or left a failure record without waiting for a tool call.
            refreshTimer = setInterval(() => {
                if (!connections.extensionReady) void Promise.all([attempt(), readDevice({ withPolicy: false, withProbe: platform !== 'darwin' })]).then(refresh);
            }, REFRESH_INTERVAL_MS);
            refreshTimer.unref?.();
            // Discovery's first tick is in flight already; this joins it to learn when the first answer is in. Until the
            // registration, that attempt and the first device read are all in, status says connecting.
            void Promise.all([registered, attempt(), readDevice({ withProbe: platform !== 'darwin' })]).then(refresh).finally(() => {
                firstRefreshDone = true;
            });
        },

        kick,

        /** For a diagnosis: refreshes policy; profile reads require an explicitly selected probe, on macOS too. Never throws. */
        refreshDeviceFacts: ({ withProbe = false } = {}) => readDevice({ withProbe }),

        /**
         * Whose log a diagnosis or a report reads: the browser the connected extension reports, else the policies this
         * runtime last read, so the reader's chooser picks the browser a cause would name.
         * @returns {{ browser: string } | { policy: unknown }}
         */
        extensionLogTarget() {
            const browser = connections.extensionSession?.facts?.browser;
            return EXTENSION_INSTALL_VOCABULARY.browsers.includes(browser) ? { browser } : { policy };
        },

        /**
         * A diagnosis's fresh read of the extension's log, unreadable or not, is the newest account: it replaces the kept
         * one, with ComSpec read again beside it, so status re-judges the cause after the user's step. A connected
         * extension is newer still, so then nothing changes.
         * @param {import('./extension-log.mjs').ExtensionLogEvidence} evidence
         */
        replaceExtensionLog(evidence) {
            if (connections.extensionReady) return;
            extensionLog = evidence;
            comspecState = comspec();
        },

        /**
         * For a tool call: connects to a live broker at once; otherwise repairs the registration, re-reads the probe,
         * waits up to 30 s for a broker about to appear and names the cause. Never repeats a request: nothing has been
         * sent when it answers.
         * @returns {Promise<{ ok: true } | { ok: false, code: string, browser?: string }>}
         */
        async ensureBroker() {
            if (connections.extensionReady) return { ok: true };
            if (!initialized || !discoveryAllowed || closed) return { ok: false, ...cause() };
            let outcome = await attempt();
            if (outcome.ok) return { ok: true };
            if (platformCause) return { ok: false, code: platformCause };
            if (outcome.reason !== 'unresponsive' && !closed) {
                // Discovery may connect while these run; a broker it found is used, not explained away. A repair slower than
                // a host's call deadline is covered by the dispatcher's "running" answer.
                await repair();
                if (connections.extensionReady) return { ok: true };
                await readDevice({ withProbe: true });
                if (connections.extensionReady) return { ok: true };
                if (shouldWaitForBroker({ probe: probeResult, policy, registration: registrationResult, lastSessionEndAtMs, now: now() })) {
                    waiting += 1;
                    try {
                        for (const deadline = now() + WAIT_MS; !closed && now() < deadline;) {
                            await delay(POLL_MS);
                            if (connections.extensionReady) return { ok: true };
                            if (closed) break;
                            outcome = await attempt();
                            if (outcome.ok) return { ok: true };
                            if (outcome.reason === 'unresponsive') break;
                        }
                    } finally {
                        waiting -= 1;
                    }
                }
                // The failure path only: the extension's own account of the connection, read once and kept for status,
                // from the browser the cause names; with no such browser its evidence could name no cause.
                // Accepted residual "A broker that fails before its own code runs": docs/local-agent-architecture.md#accepted-residuals.
                if (!connections.extensionReady && !closed) {
                    const browser = chosenBrowser({ probe: probeResult, policy });
                    let evidence = null;
                    try {
                        evidence = browser === undefined ? null : await readExtensionLog({ browser });
                    } catch (error) {
                        log(`e-comet bridge: extension log not read (${error?.code ?? 'unknown'})`);
                    }
                    // A session that opened during the read has already dropped the log; this older read must not return.
                    if (!connections.extensionReady) {
                        extensionLog = evidence;
                        comspecState = comspec();
                    }
                }
            }
            await refresh();
            // Accepted residual "A broker that appears during the failure path reads as not visible":
            // docs/local-agent-architecture.md#accepted-residuals.
            return connections.extensionReady ? { ok: true } : { ok: false, ...cause() };
        },

        sendExtension(message) {
            const session = connections.extensionSession;
            if (!session) throw extensionDisconnectedError();
            try {
                session.send(message);
            } catch (error) {
                if (error?.code === 'FRAME_TOO_LARGE') throw bridgeFrameRefusal('FRAME_TOO_LARGE');
                throw error;
            }
        },

        status() {
            const session = connections.extensionSession;
            const connected = connections.extensionReady === true;
            const starting = initialized && discoveryAllowed && !firstRefreshDone;
            const found = connected || starting || waiting > 0 ? null : cause();
            return {
                code: connected ? 'connected' : found ? found.code : 'connecting',
                ...(found ? { owner: bridgeOwner(found.code, found.detail) } : {}),
                ...(found?.code === 'BRIDGE_HOST_START_FAILED' && comspecState !== 'not_applicable' ? { comspec: comspecState } : {}),
                ...(extensionLog ? { extensionLog } : {}),
                extensionConnected: connected,
                browserJobSupported: connections.extensionBrowserJobReady === true,
                browserContext: connections.browserContext,
                extensionLastConnectedAtMs: connections.extensionLastConnectedAtMs,
                extensionLastDisconnectedAtMs: connections.extensionLastDisconnectedAtMs,
                ...(connections.extensionVersion === undefined ? {} : { extensionVersion: connections.extensionVersion }),
                // Known only while the extension that announces them is connected.
                ...(connected ? {
                    ozonSellerPromotionReportSupported: connections.extensionOzonPromotionReady === true,
                    ozonSellerPromotionReportsSupported: connections.extensionOzonPromotionPackageReady === true,
                    ozonSellerAnalyticsReportSupported: connections.extensionOzonAnalyticsReady === true,
                    ozonSearchPositionsSupported: connections.extensionOzonSearchPositionsReady === true,
                } : {}),
                registration: publicRegistration(registrationResult),
                // A failed read is listed apart, so each entry keeps its closed shape and a null there is not "no policy".
                userLevelHosts: Array.isArray(policy) ? policy.map(({ readFailed, ...entry }) => entry) : [],
                policyReadFailed: Array.isArray(policy) ? policy.filter((entry) => entry.readFailed === true).map((entry) => entry.browser) : [],
                extensionInstall: probeResult ?? null,
                brokers: brokers.flatMap((entry) => {
                    const startedAt = iso(entry.startedAt);
                    if (!Number.isSafeInteger(entry.pid) || entry.pid < 1 || !text(entry.browser) || !text(entry.brokerVersion) || !startedAt) return [];
                    return [{
                        pid: entry.pid,
                        browser: entry.browser,
                        ...(text(entry.extensionVersion) ? { extensionVersion: entry.extensionVersion } : {}),
                        brokerVersion: entry.brokerVersion,
                        startedAt,
                        current: session?.pid === entry.pid,
                    }];
                }),
                lastFailureRecord: lastFailureRecord && {
                    name: lastFailureRecord.name,
                    code: typeof lastFailureRecord.code === 'string' ? lastFailureRecord.code : null,
                    at: iso(lastFailureRecord.at),
                },
                brokerProtocolVersion: Number.isSafeInteger(session?.brokerProtocolVersion) ? session.brokerProtocolVersion : null,
                brokerVersion: text(session?.brokerVersion) ?? null,
                routeLastObservedAtMs,
                transportEvents: transportEvents.list(),
            };
        },

        // Never awaits connect(): stop() ends the attempt in flight and the open session, and a wait ends at its next poll.
        close() {
            if (closed) return;
            closed = true;
            clearInterval(refreshTimer);
            brokerClient.stop();
        },
    };
}
