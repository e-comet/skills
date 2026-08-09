# Changelog

## [2026.8.4] - 2026-08-09

Reorganised the README: installation is split into a browser-only basic path and a full desktop path, with separate
setup steps for Claude and ChatGPT, and the tool list marks whether each tool reads Wildberries or the seller portal.

## [2026.8.3] - 2026-08-08

### Added
- Added `wb_check_by_query` for checking whether one Wildberries product appears in search results for each requested
  query.
- Added `wb_seller_reviews` for mixed, entity-bound Wildberries seller-review exports with per-report partial results
  and private local XLSX resource links.
- Added bounded artifact streaming and storage with 100 MiB per-file, 500 MiB per-job, and 24-hour retention limits.

### Changed
- Extended the trusted one-use browser authorization handoff to the seller-review export tool while keeping the plugin
  MCP-only.

### Fixed
- The local bridge now resolves its peer token from a location that per-application storage cannot redirect, so two
  desktop agents pair with each other instead of each running without the extension. Reconnection no longer gives up,
  and `local_bridge_status` reports why a peer cannot be reached.

## [2026.8.2] - 2026-08-07

Initial public release of the e-Comet skill pack.

### Added
- Marketplace plugin for Claude Cowork and Codex Desktop that installs the remote e-Comet MCP for seller analytics
  together with a bundled local MCP for live Wildberries data.
- Typed local tools for Wildberries product cards, search results, recommendation shelves, and product images,
  executed through the user's e-Comet browser extension.
- Authorization handoff that keeps the signed browser-job token out of the model's context.
- Full Wildberries responses stay on the user's computer; tool results carry compact summaries and local result paths.
