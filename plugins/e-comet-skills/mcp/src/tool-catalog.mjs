import { toolInputSchemas, toolOutputSchemas, validateSchemaValue } from './tool-schemas.mjs';

const liveToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
};

const authorizationWorkflow =
    'This typed local tool owns the workflow: select it based on user intent, then call the remote e-Comet browser_job exactly once with the matching typed job and immediately invoke this tool. ' +
    'In Claude and Codex, model-authored arguments must omit both triggerUrl and trigger_url so the trusted host hook can inject the transport-only authorization immediately before this local call. ' +
    'Never decode, print, edit, copy, or expose the authorization. Do not infer an authorization failure from client status: attempt the actual remote call, retry tool discovery up to three times if necessary, and report only the confirmed error in user-friendly language. ';

const ozonAuthorizationWorkflow =
    'This typed local tool owns the Ozon workflow. First call the remote browser_job({job:{type:"ozon_seller_promotion_report",dateFrom,dateTo}}) exactly once, then immediately invoke this tool with the same dates. ' +
    'The trusted Claude or Codex host hook injects the opaque transport-only triggerUrl; model-authored arguments must omit both triggerUrl and trigger_url. Never decode, print, edit, copy, or expose that authorization. ' +
    'local_bridge_status reports legacy WB browser context and must not be used to gate this Ozon tool; the Ozon capability and typed operation result are authoritative. ';

const resultPathGuidance =
    'resultPath is only a fallback for the current call when the compact result is insufficient; it is not a cache and must not be reused for another request.';

export const serverInstructions =
    'Для живых данных Wildberries сначала выберите локальный типизированный инструмент по намерению пользователя: ' +
    'остаток, остатки, сток, наличие, склады, размеры, цена, описание, характеристики или карточка товара — wb_product_card; ' +
    'поиск, поисковая выдача, позиция, место или топ товаров по запросу — wb_search_by_query; ' +
    'проверка, находится ли конкретный артикул в поиске по одной или нескольким фразам — wb_check_by_query; ' +
    'рекомендации, похожие товары или рекомендательная полка — wb_recommendations_by_product; ' +
    'скачать или экспортировать отчёт по отзывам продавца — wb_seller_reviews; ' +
    'скачать отчёт Ozon Seller по аналитике продвижения за период — ozon_seller_promotion_report; ' +
    'фото, фотографии, картинки, изображения или галерея — wb_product_images. ' +
    'Не начинайте с browser_job. После выбора подписанного локального инструмента следуйте его описанию: ' +
    'browser_job используется только следующим шагом для получения подписанной авторизации выбранного задания.';

export const tools = [
    {
        name: 'local_bridge_status',
        description:
            'Reports extensionConnected, the stable state code, and actionable recommendedAction. Translate the stable state into a short user-facing explanation; keep structured protocol codes in English. ' +
            'ready means only that the local bridge, extension protocol, and an observed WB or seller browser context are available; each typed tool still decides its own live WB or seller prerequisites. ' +
            'Use these Russian examples when speaking to a Russian-language user: ' +
            'waiting_for_extension: «Локальный bridge запущен и ждёт подключения расширения.» ' +
            'extension_connected_no_wb_tab: «Расширение подключено; откройте авторизованную вкладку Wildberries.» ' +
            'extension_contended + CLOSE_DUPLICATE_EXTENSIONS: «Похоже, расширение e-Comet работает в нескольких экземплярах — возможно, в разных профилях браузера, — и они отбирают соединение друг у друга. Оставьте включённым только тот профиль, где открыта авторизованная вкладка Wildberries.» ' +
            'Do not assert the number of profiles or which one is at fault: the bridge observes repeated socket takeovers, not the browser layout. extensionTakeovers.count is a count within a recent window, and saturated true means it is a lower bound. Do not tell the user to open a WB tab for this state — a takeover clears the tab context, so the tab is usually already open. ' +
            'extension_context_unknown: «Расширение подключено, но эта версия не сообщает контекст вкладок; обновите расширение. Конкретный инструмент всё ещё проверит свои условия сам.» ' +
            'peer_context_unknown: «Расширение доступно через другой локальный процесс, но он не передаёт контекст вкладок; перезапустите или обновите desktop hosts. Не делайте вывод, что устарело само расширение.» ' +
            'ready: «Локальный bridge и расширение подключены; найдена вкладка Wildberries. Готовность конкретного задания проверит выбранный инструмент.» ' +
            'peer_unavailable + FIX_PEER_TOKEN_PERMISSIONS: «Другой локальный процесс уже владеет bridge, но этот агент не может подключиться из-за ограничений доступа к данным сопряжения в профиле пользователя. Разрешите desktop host доступ к профилю пользователя и повторите запрос.» Use this explanation only for the explicit FIX_PEER_TOKEN_PERMISSIONS action; do not expose raw filesystem paths or errors. ' +
            'peer_unavailable: «Мостом уже владеет другой агент, и связаться с ним не удалось — работайте в нём.»',
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
            'One product occupies exactly one position per phrase in a snapshot: WB does not also list it organically when it is already rendered as реклама. ' +
            'If a product appears as promoted:true, its organic position for that phrase is not observed at all in this snapshot — not "not found", but fundamentally not visible. ' +
            'Do not infer presence or absence of organic ranking from promoted:true, and never claim the product is "absent from organics" / «нет в органике». ' +
            'Correct wording: "position N, рекламная; organic position for this phrase cannot be determined from this snapshot". ' +
            'To observe the organic position, take a snapshot when реклама for that phrase is not running. ' +
            'If a target is absent, claim only that it was not found within the requested pages/positions, never that it is absent from all WB search results or from organics. Group multiple phrases separately and disclose failed pages. ' +
            'Results are a current WB-session snapshot. ' +
            resultPathGuidance,
        inputSchema: toolInputSchemas.wb_search_by_query,
        outputSchema: toolOutputSchemas.wb_search_by_query,
        annotations: liveToolAnnotations,
    },
    {
        name: 'wb_check_by_query',
        description:
            'Check whether one Wildberries article appears in search results for 1-100 phrases. Use for Russian requests about проверка артикула в выдаче, находится ли артикул по фразе, индексируется ли товар, or по каким запросам виден товар. ' +
            authorizationWorkflow +
            'Authorize with job {type:"check_by_query",product_id:integer,queries:[string,...]}; send one positive product ID and 1-100 unique non-empty phrases. Page depth is fixed by the service; do not supply it. ' +
            'Read queries[] separately. For found:true, report only that the product was found for the phrase. For found:false, report only that the product was not found for the phrase. ' +
            'Do not mention pagesChecked, completionReason, page limits, or brand-filtered depth unless the user explicitly asks for diagnostics. Never present pagesChecked as a page, position, rank, or search depth in ordinary unfiltered search. ' +
            'request_failed and card_failed mean the check was incomplete; report that the check was incomplete rather than reporting the product as not found. ' +
            'Do not claim that the product is absent from all Wildberries search results. Results are a current WB-session snapshot. ' +
            resultPathGuidance,
        inputSchema: toolInputSchemas.wb_check_by_query,
        outputSchema: toolOutputSchemas.wb_check_by_query,
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
        name: 'wb_seller_reviews',
        description:
            'Export original Wildberries seller-review XLSX reports for the signed seller_reviews browser_job. ' +
            authorizationWorkflow +
            'Authorize one mixed request with job {type:"seller_reviews",exports:[{product_id?:integer,dateFrom?:"YYYY-MM-DD",dateTo?:"YYYY-MM-DD",isAnswered?:boolean,ratings?:[1|2|3|4|5,...],content?:"media"},...],org?:{id:string}|{name:string}}. ' +
            'Put every requested product, period, answer state, rating filter, and media filter into that single exports array. Omit product_id to export all products in the selected organization. Omitted ratings mean all ratings; content:"media" selects reviews with photo or video, while omitted content means any content. Omitted dates mean all time; otherwise provide both inclusive dates. Omitted isAnswered produces separate answered and unanswered workbooks. ' +
            'Omit org to use the organization active in the seller portal. Include exactly one signed org id or exact name only when the user explicitly selects another organization. ' +
            'Use at most 50 logical exports and 100 physical reports after expanding all. Each XLSX is limited to 100 MiB, the job to 500 MiB, and artifacts are retained for 24 hours. The shared artifact store is limited to 512 MiB and 1000 files; oldest completed artifacts are evicted first. ' +
            'Return every successful resource link (resource_link) and explicitly summarize complete, failed, and skipped exports when status is partial. Do not infer product ownership from an empty workbook. ' +
            'Returns compact metadata and private local resource links only; XLSX bytes never enter the tool result or model context, and base64 is never returned. Do not read or summarize workbook contents unless the user separately asks.',
        inputSchema: toolInputSchemas.wb_seller_reviews,
        outputSchema: toolOutputSchemas.wb_seller_reviews,
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
    {
        name: 'ozon_seller_promotion_report',
        description:
            'Download the Ozon Seller promotion analytics report for one requested period as one XLSX workbook. ' +
            ozonAuthorizationWorkflow +
            'Use canonical inclusive dateFrom/dateTo dates with at most 89 inclusive days. One call produces one period and one workbook. ' +
            'Neighboring analytics are unavailable in this first tool: it does not provide product, traffic, finance, campaign, or other Ozon reports. ' +
            'The operation may create a saved report in Ozon, but it does not change products, campaigns, budgets, or seller settings. ' +
            'Returns compact metadata and exactly one private resource_link; workbook bytes, base64, local paths, company context, report identifiers, and request details never enter model content.',
        inputSchema: toolInputSchemas.ozon_seller_promotion_report,
        outputSchema: toolOutputSchemas.ozon_seller_promotion_report,
        annotations: liveToolAnnotations,
    },
];

export const validateToolArguments = (name, args) => {
    const tool = tools.find((candidate) => candidate.name === name);
    return Boolean(tool && validateSchemaValue(args, tool.inputSchema));
};
