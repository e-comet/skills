import { createBuyerTool, BUYER_TOOLS } from '../wb-client/in/mcp/buyer.tool.mjs';
import { createImagesTool } from '../wb-client/in/mcp/images.tool.mjs';
import { createAuthorization } from '../wb-client/out/extension/authorization.mjs';
import { createResults } from '../wb-client/out/results/ndjson.mjs';
import { imageExists } from '../wb-client/out/wb-cdn/images.mjs';
// The image host a test serves; honoured only under NODE_ENV=test and read when each lookup starts.
const testImageOrigin = () => (process.env.NODE_ENV === 'test' ? process.env.ECOMET_LOCAL_BRIDGE_TEST_IMAGE_ORIGIN : undefined);
/**
 * The wb-client tools' handlers the MCP root registers: `registry` is the dispatcher's (answer with its receipt, a failure
 * carrying a downloaded update), `options` the root's collaborators: the broker connect, the authorization request and the
 * WB fetch adapter over the root's request broker. Tests replace the result writer and the image probe.
 */
export const wbClientTools = (registry, { ensureBroker, requestBrowserJobAuthorization, wbFetch, createJobWriter = undefined, probeImageExists = imageExists, shutdownSignal = undefined, log = (..._args) => undefined, imageOrigin = testImageOrigin, }) => {
    const results = createResults(createJobWriter ? { createJobWriter } : {});
    const authorization = createAuthorization({ ensureBroker, requestBrowserJobAuthorization });
    return [
        ...BUYER_TOOLS.map((tool) => [
            tool.contract.name,
            createBuyerTool(tool, {
                answer: registry.answer(tool.contract.name),
                authorization,
                wbFetch,
                results,
                withDownloadedUpdate: registry.withDownloadedUpdate,
                log,
            }),
        ]),
        [
            'wb_product_images',
            createImagesTool({
                answer: registry.answer('wb_product_images'),
                results,
                images: { exists: probeImageExists },
                shutdownSignal,
                log,
                imageOrigin,
            }),
        ],
    ];
};
