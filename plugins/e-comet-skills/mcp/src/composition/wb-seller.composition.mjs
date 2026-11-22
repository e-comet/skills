import { currentStorageLayout, requireStorageTarget } from '../storage/files/layout.mjs';
import { createCardComparisonTool, projectCardComparisonReceipt } from '../wb-seller/in/mcp/card-comparison.tool.mjs';
import { createListOrgsTool, projectListOrgsReceipt } from '../wb-seller/in/mcp/list-orgs.tool.mjs';
import { createReviewsTool } from '../wb-seller/in/mcp/reviews.tool.mjs';
import { createComparisonArchiveWriter } from '../wb-seller/out/artifacts/comparison-xlsx.mjs';
import { createArtifacts } from '../wb-seller/out/artifacts/xlsx.mjs';
import { createAuthorization } from '../wb-seller/out/extension/authorization.mjs';
/**
 * The wb-seller tool's handler the MCP root registers: `registry` is the dispatcher's (answer with its receipt, a failure
 * carrying a downloaded update), `options` the root's collaborators: the broker connect, the authorization request, the
 * seller operations adapter over the root's request broker, the artifact root and the host's report copy folder. Tests
 * replace the workbook writer.
 */
export const wbSellerTools = (registry, { ensureBroker, requestBrowserJobAuthorization, sellerOperations, sellerCardComparisonSupported, sellerListOrgsSupported, shutdownSignal, artifactStorageTarget = currentStorageLayout().marketplaceArtifacts, createSellerArtifactWriter = undefined, reportOutputDirectory = undefined, }) => [
    [
        'wb_seller_list_orgs',
        createListOrgsTool({
            answer: registry.answer('wb_seller_list_orgs', projectListOrgsReceipt),
            authorization: createAuthorization({
                ensureBroker,
                requestBrowserJobAuthorization,
                capability: { supported: sellerListOrgsSupported, operation: 'the Wildberries Seller company catalog' },
            }),
            sellerOperations,
            withDownloadedUpdate: registry.withDownloadedUpdate,
        }),
    ],
    [
        'wb_seller_reviews',
        createReviewsTool({
            answer: registry.answer('wb_seller_reviews'),
            authorization: createAuthorization({ ensureBroker, requestBrowserJobAuthorization }),
            sellerOperations,
            artifacts: createArtifacts({
                storageTarget: artifactStorageTarget,
                ...(createSellerArtifactWriter === undefined ? {} : { createArtifactWriter: createSellerArtifactWriter }),
            }),
            withDownloadedUpdate: registry.withDownloadedUpdate,
            reportOutputDirectory,
        }),
    ],
    [
        'wb_seller_card_comparison',
        createCardComparisonTool({
            answer: registry.answer('wb_seller_card_comparison', projectCardComparisonReceipt),
            authorization: createAuthorization({
                ensureBroker,
                requestBrowserJobAuthorization,
                capability: { supported: sellerCardComparisonSupported, operation: 'Wildberries seller card comparison' },
            }),
            sellerOperations,
            requireArtifactTarget: () => {
                requireStorageTarget(artifactStorageTarget, 'marketplace-artifacts');
            },
            createArchiveWriter: (options) => createComparisonArchiveWriter({ ...options, storageTarget: artifactStorageTarget }),
            withDownloadedUpdate: registry.withDownloadedUpdate,
            reportOutputDirectory,
            shutdownSignal,
        }),
    ],
];
