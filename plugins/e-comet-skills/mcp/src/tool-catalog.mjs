import { toolInputSchemas, toolOutputSchemas, validateSchemaValue } from './tool-schemas.mjs';

const liveToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};

const authorizationWorkflow =
    'This typed local tool owns the workflow: select it based on user intent, then call the remote e-Comet browser_job exactly once with the matching typed job and immediately invoke this tool. ' +
    'In Codex, keep both calls in one atomic exec and pass structuredContent.trigger_url only through a local variable. In Claude, invoke this tool without triggerUrl so the trusted hook injects it. ' +
    'Never decode, print, edit, or manually copy the JWT. Do not infer an authorization failure from client status: attempt the actual remote call, retry tool discovery up to three times if necessary, and report only the confirmed error in user-friendly language. ';

const resultPathGuidance =
    'resultPath is only a fallback for the current call when the compact result is insufficient; it is not a cache and must not be reused for another request.';

export const serverInstructions =
    'Для живых данных Wildberries сначала выберите локальный типизированный инструмент по намерению пользователя: ' +
    'остаток, остатки, сток, наличие, склады, размеры, цена, описание, характеристики или карточка товара — wb_product_card; ' +
    'поиск, поисковая выдача, позиция, место или топ товаров по запросу — wb_search_by_query; ' +
    'рекомендации, похожие товары или рекомендательная полка — wb_recommendations_by_product; ' +
    'фото, фотографии, картинки, изображения или галерея — wb_product_images. ' +
    'Не начинайте с browser_job. После выбора одной из первых трёх локальных tools следуйте её описанию: ' +
    'browser_job используется только следующим шагом для получения подписанной авторизации выбранного задания.';

export const tools = [
    {
        name: 'local_bridge_status',
        description: 'Check whether the local e-Comet Chrome extension is connected to this MCP server.',
        inputSchema: toolInputSchemas.local_bridge_status,
        outputSchema: toolOutputSchemas.local_bridge_status,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    },
    {
        name: 'wb_product_card',
        description:
            'Get live Wildberries product-card data by article ID. Use for Russian requests about остаток, остатки, сток, наличие, склады, размеры, цена, карточка товара, описание, характеристики, or склейка. ' +
            authorizationWorkflow +
            'Authorize with job {type:"product_card",product_ids:[integer,...]}; use 1-1000 positive product IDs. Read products[]. For price use priceRub.product; priceRub.basic is the crossed-out/basic price. ' +
            'For stock use quantity.total, quantity.byWarehouse, and quantity.bySize. Warehouse names are already in warehouse; if absent, display wh <id>. Use colors for merged articles, options for characteristics, and description for description. ' +
            'Translate raw field names for the user and render booleans as yes/no. A product-level ok:false is a failed WB request, not proof that the product does not exist. Report partial item errors. ' +
            'Values are a current WB-session snapshot. ' +
            resultPathGuidance,
        inputSchema: toolInputSchemas.wb_product_card,
        outputSchema: toolOutputSchemas.wb_product_card,
        annotations: liveToolAnnotations,
    },
    {
        name: 'wb_search_by_query',
        description:
            'Get live Wildberries search results, top products, and positions for one or more phrases. Use for Russian requests about поиск, поисковая выдача, позиция товара, место по запросу, or топ товаров. ' +
            authorizationWorkflow +
            'Authorize with job {type:"search_by_query",queries:[{query:string,pages:integer},...]}; use at most 50 pages for each query and 1000 pages total. Start with 1 page for a top list or 2-3 pages when depth is unspecified. ' +
            'For a targeted rank check, put phrases in remote job.queries and target article IDs in local productNmIds. For a top N list, use productLimitPerQuery:N. ' +
            'Read queries[].pages[].products. Use globalPosition only when globalPositionsComplete is true; position is page-local. promoted is always boolean: promoted:true means реклама (paid placement), promoted:false means органика. ' +
            'If a target is absent, claim only that it was not found within the requested pages/positions, never that it is absent from all WB search results. Group multiple phrases separately and disclose failed pages. ' +
            'Results are a current WB-session snapshot. ' +
            resultPathGuidance,
        inputSchema: toolInputSchemas.wb_search_by_query,
        outputSchema: toolOutputSchemas.wb_search_by_query,
        annotations: liveToolAnnotations,
    },
    {
        name: 'wb_recommendations_by_product',
        description:
            'Get live Wildberries recommendation shelves for source article IDs and check whether specific products occur in them. Use for Russian requests about рекомендации, похожие товары, рекомендательная полка, соседние товары, or whether a product встречается в рекомендациях. ' +
            authorizationWorkflow +
            'Authorize with job {type:"recommendations_by_product",products:[{product_id:integer,pages?:integer},...]}; use unique source product IDs, at most 50 pages for each product, and 1000 pages total; an omitted pages value counts as 50 toward the total. ' +
            'For первые N recommendations, explicitly request pages: 1 and pass local productLimitPerSource: N. Omit pages only when the user explicitly needs the whole discovered shelf within local limits. ' +
            'For a membership check, put исходные товары in remote job.products and целевые товары in local productNmIds. Read articles[].pages[].products and group results by sourceNmId. ' +
            'Use globalPosition only when globalPositionsComplete is true. If a target is absent, claim only that it was not found in the successfully requested part of that source shelf. ' +
            'Disclose status partial/failed, failed pages, complete:false, and truncatedByLocalLimit:true. Recommendations are a current WB-session snapshot. ' +
            resultPathGuidance,
        inputSchema: toolInputSchemas.wb_recommendations_by_product,
        outputSchema: toolOutputSchemas.wb_recommendations_by_product,
        annotations: liveToolAnnotations,
    },
    {
        name: 'wb_product_images',
        description:
            'Find public Wildberries product image URLs by article ID. Use for Russian requests about фото, фотографии, картинки, изображения, ссылки на фото, or галерея товара. ' +
            'Call it directly; it needs neither remote browser_job nor the Chrome extension. Send at most 20 IDs per call and preserve input order across batches. ' +
            'Use products[].imageUrls rather than guessing CDN URLs. Report succeeded and failed counts. status "not_found" means the current image-CDN probe found no photos; it does not mean that the product does not exist.',
        inputSchema: toolInputSchemas.wb_product_images,
        outputSchema: toolOutputSchemas.wb_product_images,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
        },
    },
];

export const validateToolArguments = (name, args) => {
    const tool = tools.find((candidate) => candidate.name === name);
    return Boolean(tool && validateSchemaValue(args, tool.inputSchema));
};
