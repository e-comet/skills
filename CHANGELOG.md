# Changelog

## [2026.6.2] - 2026-06-21

### Breaking changes
- None.

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

### Breaking changes
- None.

### Added
- Added the initial `wb-product-images` skill for resolving live Wildberries image URLs by article, product ID, nm ID,
  nmId, or SKU.
- Added public skill-pack compatibility metadata.
