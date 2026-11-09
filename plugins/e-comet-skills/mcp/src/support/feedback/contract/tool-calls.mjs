// Shared with the DeepSeek renderer: compact JSON follows this exact trailing delimiter.
export const STRUCTURED_MCP_EVIDENCE_MARKER = '\nStructured MCP evidence: ';
// The remote e-Comet MCP publishes these, and its failures matter most: `browser_job` authorizes every
// signed live call and runs immediately before it, so a rejection there is the only line support gets.
// A host names that server by its connector id, so these are matched by the whole name rather than by
// the suffix: `info`, `query_metrics` and `campaign_settings` are names another server may legitimately
// publish, and a suffix match would hand it the channel the catalog restriction closes. Matching the
// whole name is what lets every one of them be read without that risk. `report_issue` never reaches
// here, being excluded as a feedback tool. The update hook and the `hooks.json` matcher carry the same set. A method
// the server publishes before our next release is missing from all three until then: accepted residual, see
// docs/architecture/residuals/signed-flow.md.
export const REMOTE_E_COMET_TOOL_NAMES = [
    'browser_job',
    'campaign_clusters_settings',
    'campaign_settings',
    'campaign_target_products_settings',
    'describe_metrics',
    'info',
    'list_entities',
    'org_balance',
    'query_forecast',
    'query_metrics',
    'query_phrase_frequency',
    'search_phrases',
    'subscription',
    'subscription_balance_history',
    'find_account',
    'product_settings',
    'stock_rebalancer_settings',
    'stock_rebalancer_status',
    'update_campaign_settings',
    'update_campaign_clusters_settings',
    'update_campaign_target_products_settings',
    'update_product_settings',
    'update_stock_rebalancer_settings',
    'campaign_comments',
    'product_comments',
    'update_campaign_comments',
    'update_product_comments',
    'campaign_journal',
    'product_journal',
    'account_journal',
    'search_positions',
    'recom_positions',
    'org_balance_history',
    'campaign_budget',
    'campaign_budget_history',
    'order_feed',
    'product_catalog',
];
