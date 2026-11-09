import { assertHookFields, loadHookSecret, verifyHookSignature } from '../../../../handoff/signature.mjs';
import { safeArtifactId, submitError, submitOutcome } from '../../application/submit.mjs';
import { FeedbackPreparationError } from '../../domain/converters/errors.converter.mjs';
import { withFeedbackOperation } from '../../../../transport/failures/evidence.mjs';
// The two MCP feedback tools decide their route here, before any use case runs: a hook-signed call is verified, an
// unsigned one goes the unsigned route, a call that says neither is refused.
const signatureInvalid = () => Object.assign(new Error('The trusted feedback handoff claim could not be verified.'), {
    code: 'FEEDBACK_CLAIM_INVALID',
    feedbackReason: 'claim_signature_invalid',
});
/**
 * Verifies the fields the trusted hook injected against the shared local secret. A malformed request
 * fails as a binding mismatch before any filesystem access; only a well-formed one reads the secret.
 */
export const verifyHookFields = async ({ tool, sessionHash, signature, fields }) => {
    try {
        assertHookFields({ tool, sessionHash, fields });
        const secret = await loadHookSecret({ create: false });
        if (!verifyHookSignature({ secret, tool, sessionHash, fields, signature }))
            throw signatureInvalid();
    }
    catch (error) {
        throw withFeedbackOperation(error, 'claim_consume');
    }
};
// Codex runs its hooks beside this process and asks to trust them again after every plugin update. An unsigned call
// from it means its hooks did not run, so it fails closed before report_issue spends one of the few authorizations the
// service issues per hour. Claude Code is left out: an older Cowork device bridge also named itself claude-code.
const HOOKED_CLIENTS = new Set(['codex-mcp-client']);
const claimInvalid = (cause) => new FeedbackPreparationError('FEEDBACK_CLAIM_INVALID', cause);
const hookHandoffUnavailable = (cause) => new FeedbackPreparationError('FEEDBACK_HOOK_HANDOFF_UNAVAILABLE', cause);
/** The route of one preparation, or the refusal to answer. */
export const routePrepare = async (
// Parse boundary: the call's arguments, already checked against the tool's input schema.
input, { clientName, verifySignature }) => {
    const { includeTranscript, transcriptPath, feedbackClaim, feedbackSession } = input;
    // WHY: a host whose hook cannot change this call (Cowork since 2026-10-30) calls it unsigned. Such a report
    // never carries history: only a signed hook may name a transcript path, so a model cannot point this process at a
    // file. Accepted residual "Cowork reports go unsigned and without history".
    const signed = feedbackClaim !== undefined || feedbackSession !== undefined || transcriptPath !== undefined;
    if (!signed && (includeTranscript === true || HOOKED_CLIENTS.has(clientName))) {
        return { kind: 'handoff_unavailable', error: hookHandoffUnavailable() };
    }
    if (signed) {
        const hookFields = transcriptPath === undefined ? {} : { transcriptPath };
        try {
            // WHY: hook fields are only data until this process verifies the trusted signature over them.
            // Verifying first prevents a skipped or untrusted hook from reaching a transcript or artifact write.
            await verifySignature({
                tool: 'prepare_e_comet_feedback',
                sessionHash: feedbackSession,
                signature: feedbackClaim,
                fields: hookFields,
            });
        }
        catch (error) {
            return { kind: 'claim_invalid', error: claimInvalid(error) };
        }
    }
    return { kind: 'routed', route: signed ? 'native' : 'unsigned' };
};
/** The route of one submission (signed or not), or the refusal to answer. */
export const routeSubmit = async (
// Parse boundary: the call's arguments, already checked against the tool's input schema.
input, { verifySignature }) => {
    const artifactId = safeArtifactId(input.artifactId);
    if (artifactId !== undefined &&
        input.uploadUrl === undefined &&
        input.requiredHeaders === undefined &&
        input.objectKey === undefined &&
        input.expiresAt === undefined &&
        input.expectedSize === undefined &&
        input.expectedSha256 === undefined &&
        input.feedbackClaim === undefined &&
        input.feedbackSession === undefined) {
        return submitOutcome(submitError(artifactId, 'failed', 'FEEDBACK_HOOK_HANDOFF_UNAVAILABLE', 'The trusted e-Comet hook handoff is unavailable.', 'handoff', false, undefined, 'handoff_submit'));
    }
    // Native authority is a signature. A grant the model copied (Cowork, whose hook cannot change this call) has
    // none, so only e-Comet's own storage may receive it: accepted residual "Cowork reports go unsigned and without
    // history".
    const signed = input.feedbackClaim !== undefined || input.feedbackSession !== undefined;
    if (signed) {
        const hookFields = {
            artifactId: input.artifactId,
            uploadUrl: input.uploadUrl,
            requiredHeaders: input.requiredHeaders,
            objectKey: input.objectKey,
            expiresAt: input.expiresAt,
            expectedSize: input.expectedSize,
            expectedSha256: input.expectedSha256,
        };
        try {
            // WHY: verify before artifact reads or request creation so raw transport values never confer
            // authority. The signature covers this artifactId, so a swapped one cannot reuse another grant.
            await verifySignature({
                tool: 'submit_e_comet_feedback',
                sessionHash: input.feedbackSession,
                signature: input.feedbackClaim,
                fields: hookFields,
            });
        }
        catch (error) {
            return submitOutcome(submitError(artifactId, 'failed', 'UPLOAD_GRANT_INVALID', 'The trusted feedback handoff claim could not be verified.', 'grant', false, error, 'claim_verification'));
        }
    }
    return { kind: 'routed', signed };
};
/** A preparation as the MCP tool runs it: routed and verified here, then prepared by the in-port. */
export const prepareThroughRoute = async (flows, input, context, verifySignature = verifyHookFields) => {
    const routed = await routePrepare(input, { clientName: context.clientName, verifySignature });
    return routed.kind === 'routed' ? flows.prepare(input, routed.route, context) : routed;
};
/** A submission as the MCP tool runs it: routed and verified here, then submitted by the in-port. */
export const submitThroughRoute = async (flows, input, dependencies, verifySignature = verifyHookFields) => {
    const routed = await routeSubmit(input, { verifySignature });
    return routed.kind === 'routed' ? flows.submit(input, routed.signed, dependencies) : routed;
};
