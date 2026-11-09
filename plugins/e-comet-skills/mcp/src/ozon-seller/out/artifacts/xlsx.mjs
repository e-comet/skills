import { currentStorageLayout, requireStorageTarget } from '../../../storage/files/layout.mjs';
import { createArtifactWriter } from '../../../storage/writers/artifacts.mjs';
/**
 * The Ozon reports' XLSX workbooks over storage/writers/artifacts: the marketplace artifacts root must be usable before a
 * report authorizes, and each workbook gets its own writer.
 */
export const createArtifacts = ({ storageTarget = currentStorageLayout().marketplaceArtifacts, createArtifactWriter: createWriter = createArtifactWriter, } = {}) => ({
    requireTarget: () => {
        requireStorageTarget(storageTarget, 'marketplace-artifacts');
    },
    create: (options) => createWriter(options),
});
