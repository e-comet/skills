export const FEEDBACK_MAX_SUMMARY_LENGTH = 512;
// This is the remote report_issue contract. Every local validator must consume this one list so a report that
// prepares successfully cannot later be rejected while requesting its upload grant.
export const FEEDBACK_KINDS = ['bug', 'wrong_data', 'missing_capability', 'unclear_contract'];
export const FEEDBACK_MAX_BYTES = 32 * 1024 * 1024;
// An upload no trusted hook signed may go only to e-Comet's own storage. The server signs for S3 and hands the URL
// out under the app's storage proxy, which forwards the raw path.
export const FEEDBACK_UPLOAD_DESTINATIONS = [
    { hostname: 'app.e-comet.io', pathPrefix: '/storage/e-comet-prod-mcp-feedback-732537603439/' },
];
// Every probe that gathers evidence while a report is prepared is abandoned after this long: the
// extension's read-only snapshot, the installation reads, the browser-profile scan and the Codex hook
// inspector, whose cold start measured 5.5-9.7 s and is then recorded as the device's own abandonment (its
// diagnosis waits 20 s). Preparation is independent of extension readiness by contract, so a stalled route
// may cost seconds, never the 45-second business deadline, and a report is never lost to the evidence
// gathered for it.
export const FEEDBACK_EVIDENCE_TIMEOUT_MS = 5000;
// The archive's copy of the extension's own log (extension-log.json), newest rows kept. The whole log is at most 3,000
// rows, typically well under 2 MiB, and the 32 MiB report limit also has to hold the transcript.
export const FEEDBACK_EXTENSION_LOG_MAX_BYTES = 4 * 1024 * 1024;
export const FEEDBACK_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000;
// Every feedback error message is bounded the same way. Hook-authored messages import this bound instead
// of restating it, so a published result can never fall out of the schema it is validated against.
export const FEEDBACK_MESSAGE_MAX_LENGTH = 500;
export const FEEDBACK_REPORT_ID_MAX_LENGTH = 1024;
