import { fileURLToPath } from 'node:url';
// Bug reports name the module a failure was thrown in by its logical name: the flat file name it had when the report
// format was published (spec §7.6). A module keeps its logical name forever; when a file moves or splits, only its paths
// here change. Paths are relative to this file, whose folder depth is fixed.
const F = '../support/feedback';
export const MODULE_FILES = {
    'feedback-diagnostics.mjs': ['../transport/failures/evidence.mjs'],
    'feedback-errors.mjs': [`${F}/domain/converters/errors.converter.mjs`],
    'feedback-tools.mjs': [
        `${F}/application/prepare.mjs`,
        `${F}/application/submit.mjs`,
        `${F}/out/transcript/file.mjs`,
        `${F}/in/mcp/routes.mjs`,
        `${F}/domain/policies/transcript-tail.policy.mjs`,
    ],
    'feedback-upload.mjs': [`${F}/out/upload/http.mjs`, `${F}/domain/policies/upload-destination.policy.mjs`],
    'hook-signature.mjs': ['../handoff/signature.mjs'],
    'feedback-artifact-store.mjs': [`${F}/out/artifacts/store.mjs`],
    'feedback-metadata.mjs': [`${F}/domain/converters/metadata.converter.mjs`],
    'feedback-report.mjs': [`${F}/domain/converters/report.converter.mjs`],
    'feedback-zip.mjs': [`${F}/out/artifacts/archive.mjs`],
    'mcp-dispatcher.mjs': ['../mcp-protocol/registry/dispatcher.mjs', `${F}/in/mcp/prepare.tool.mjs`, `${F}/in/mcp/submit.tool.mjs`],
    'tool-schemas.mjs': [`${F}/contract/report.mjs`],
};
// A stack frame names its file by URL or, for some hosts, by path: both resolve to the same logical name.
const names = new Map(Object.entries(MODULE_FILES).flatMap(([name, paths]) => paths.flatMap((path) => {
    const url = new URL(path, import.meta.url);
    return [
        [url.href, name],
        [fileURLToPath(url), name],
    ];
})));
export const moduleNameOf = (location) => names.get(location);
