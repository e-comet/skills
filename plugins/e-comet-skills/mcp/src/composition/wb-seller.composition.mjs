import { createReviewsTool } from '../wb-seller/in/mcp/reviews.tool.mjs';
import { createArtifacts } from '../wb-seller/out/artifacts/xlsx.mjs';
import { createAuthorization } from '../wb-seller/out/extension/authorization.mjs';
/**
 * The wb-seller tool's handler the MCP root registers: `registry` is the dispatcher's (answer with its receipt, a failure
 * carrying a downloaded update), `options` the root's collaborators: the broker connect, the authorization request, the
 * seller operations adapter over the root's request broker, the artifact root and the host's report copy folder. Tests
 * replace the workbook writer.
 */
export const wbSellerTools = (registry, { ensureBroker, requestBrowserJobAuthorization, sellerOperations, artifactStorageTarget = undefined, createSellerArtifactWriter = undefined, reportOutputDirectory = undefined, }) => [
    [
        'wb_seller_reviews',
        createReviewsTool({
            answer: registry.answer('wb_seller_reviews'),
            authorization: createAuthorization({ ensureBroker, requestBrowserJobAuthorization }),
            sellerOperations,
            artifacts: createArtifacts({
                ...(artifactStorageTarget === undefined ? {} : { storageTarget: artifactStorageTarget }),
                ...(createSellerArtifactWriter === undefined ? {} : { createArtifactWriter: createSellerArtifactWriter }),
            }),
            withDownloadedUpdate: registry.withDownloadedUpdate,
            reportOutputDirectory,
        }),
    ],
];
