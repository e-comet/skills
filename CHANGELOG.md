# Changelog

## [2026.7.2] - 2026-07-09

### Changed
- Moved shared browser-job instructions and postMessage-RPC snippets for `wb-product-card` and `wb-search-by-query`
  into plugin-root `shared/browser-job/`, removing duplicated skill-local scripts.
- Browser skills now read results with the extension's `summary` API (ready-to-present product/search objects with
  warehouse names and search positions; new shared `agent_summary.js`), falling back to raw bodies only for fields
  the summary lacks.
- Documented the DOM mailbox transport (`#ecomet-agent-bridge`) as the Codex default without CDP, transport caching
  via `ECOMET_AGENT_TRANSPORT`, and job snapshot semantics (re-read the same job instead of re-running `browser_job`).
- Search answers now mark promoted (ad) positions via the summary `promoted` flag.

## [2026.7.1] - 2026-07-08

### Changed
- Migrated `wb-product-card` and `wb-search-by-query` to the new extension agent API: jobs are handed to the
  extension via postMessage-RPC `submit` on any wildberries.ru tab (no navigation to the trigger URL), and results
  are read via the same RPC — works from isolated JS worlds without CDP; `readAll` fetches small batches in one call.
- Documented the new Wildberries login requirement (`wb_not_authenticated` setup error) in both browser skills.

## [2026.7.0] - 2026-07-08

### Added
- Added the `wb-product-card` skill: live WB product card data (price, rating, stock by warehouse and size,
  merged articles) fetched through the user's browser via the e-Comet extension.
- Added the `wb-search-by-query` skill: live WB search results and article positions by query phrase.
- Bundled the e-Comet MCP server (`https://mcp.e-comet.io/mcp`) into the plugin for both Claude Cowork and
  Codex Desktop — no manual MCP setup; authentication is an email-code OAuth login on first use.

### Changed
- Public README now marks each skill with its requirements (MCP server / e-Comet browser extension).

## [2026.6.2] - 2026-06-21

### Fixed
- Updated `wb-product-images` media basket fallback ranges through `basket-46` so high product IDs resolve to the
  current WB image CDN host.
- Added bounded probing beyond the known media ranges for future WB basket growth.

### Changed
- Clarified public install instructions and plugin descriptions.

## [2026.6.1] - 2026-06-21

### Breaking changes
- Moved the installable public plugin from the repository root into `plugins/e-comet-skills/` so the same plugin folder
  can carry both Claude Cowork and Codex manifests.

### Added
- Added root Claude Cowork and Codex marketplace files.
- Added a Claude plugin manifest alongside the existing Codex plugin manifest.
- Added e-Comet icon and logo assets for Codex plugin presentation.

## [2026.6.0] - 2026-06-21

### Added
- Added the initial `wb-product-images` skill for resolving live Wildberries image URLs by article, product ID, nm ID,
  nmId, or SKU.
- Added public skill-pack compatibility metadata.
