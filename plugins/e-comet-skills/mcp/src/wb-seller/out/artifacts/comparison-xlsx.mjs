import { ARTIFACT_MAX_FILE_BYTES } from '../../../storage/limits.mjs';
import { createArtifactWriter } from '../../../storage/writers/artifacts.mjs';
const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const createComparisonArchiveWriter = async ({ maxArchiveBytes = ARTIFACT_MAX_FILE_BYTES, ...options }) => {
    if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes <= 0)
        throw new Error('Comparison archive limit must be a positive integer');
    return createArtifactWriter({ ...options, mimeType: XLSX_MIME_TYPE }, { maxArchiveBytes });
};
