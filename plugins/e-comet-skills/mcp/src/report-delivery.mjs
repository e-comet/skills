import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SYSTEM_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EDQUOT', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EROFS', 'EMFILE', 'ENFILE', 'EIO', 'ENAMETOOLONG']);
const REASONS = new Set(['invalid_output_directory', 'invalid_artifact_metadata', 'source_not_file', 'integrity_mismatch']);

const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

// Read bounded chunks through the owned handles. Never expose workbook bytes to MCP content.
const digest = async (file, size, destination = undefined) => {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        if (position > size) throw new Error('integrity_mismatch');
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (destination) await destination.writeFile(chunk);
    }
    if (position !== size) throw new Error('integrity_mismatch');
    return hash.digest('hex');
};

const copyReport = async (artifact, directory, stage) => {
    // The host exports a resolved path. Validate its actual filesystem target; literal
    // dollar/percent/tilde characters in an existing directory are not expressions.
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('invalid_output_directory');
    if (!/^[^<>:"/\\|?*\x00-\x1f]+\.xlsx$/i.test(artifact.name)
        || !Number.isSafeInteger(artifact.size) || artifact.size < 0
        || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('invalid_artifact_metadata');
    const root = await realpath(directory);
    if (!(await lstat(root)).isDirectory()) throw new Error('invalid_output_directory');
    stage('source');
    const sourcePath = await realpath(artifact.path);
    stage('output_directory');
    const child = path.join(directory, 'e-comet-reports');
    // The delivery copy must never become subject to the original store's retention.
    if (within(path.dirname(sourcePath), path.join(root, 'e-comet-reports'))) throw new Error('invalid_output_directory');
    try { await mkdir(child); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(child)).isDirectory() || (await lstat(child)).isSymbolicLink()) throw new Error('invalid_output_directory');
    const physicalChild = await realpath(child);
    if (path.relative(root, physicalChild) !== 'e-comet-reports') throw new Error('invalid_output_directory');
    stage('source');
    const source = await open(sourcePath, 'r');
    let destination;
    let outputPath;
    let owned;
    let operationError;
    try {
        if (!(await source.stat()).isFile()) throw new Error('source_not_file');
        stage('copy');
        outputPath = path.join(child, artifact.name);
        try { destination = await open(outputPath, 'wx+'); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            outputPath = path.join(child, `${artifact.name.slice(0, -5)}-${randomUUID()}.xlsx`);
            destination = await open(outputPath, 'wx+');
        }
        owned = await destination.stat();
        if (await digest(source, artifact.size, destination) !== artifact.sha256) throw new Error('integrity_mismatch');
        stage('verification');
        await destination.sync();
        if (await digest(destination, artifact.size) !== artifact.sha256) throw new Error('integrity_mismatch');
        // Preserve the host's logical path. A packaged Windows host may virtualize it;
        // its file presenter recognizes this namespace, while private originals retain native paths.
        return { ...artifact, path: outputPath, uri: pathToFileURL(outputPath).href };
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        // Each handle gets its own close attempt. A close rejection must not skip
        // the other handle or replace an earlier copy/verification failure.
        const closed = await Promise.allSettled([destination, source].filter(Boolean)
            .map(handle => Promise.resolve().then(() => handle.close())));
        const closeFailure = closed.find(result => result.status === 'rejected');
        if ((operationError || closeFailure) && owned) {
            const current = await lstat(outputPath).catch(() => undefined);
            if (current?.ino === owned.ino && current?.dev === owned.dev) await unlink(outputPath).catch(() => undefined);
        }
        if (!operationError && closeFailure) throw closeFailure.reason;
    }
};

// Called after marketplace execution and before terminal publication/pin release.
// Failure preserves the completed report; it must never repeat a marketplace create.
export const deliverReportResult = async (result, artifacts, directory) => {
    if (directory === undefined || !artifacts.length) return result;
    const replacements = new Map();
    const failures = [];
    for (const [resourceIndex, artifact] of artifacts.entries()) {
        let stage = 'output_directory';
        try { replacements.set(artifact.uri, await copyReport(artifact, directory, value => { stage = value; })); }
        catch (error) {
            failures.push({ resourceIndex, code: 'REPORT_DELIVERY_FAILED', stage,
                reason: REASONS.has(error?.message) ? error.message : (SYSTEM_CODES.has(error?.code) ? 'filesystem_error' : 'unexpected_error'),
                ...(SYSTEM_CODES.has(error?.code) ? { systemCode: error.code } : {}),
            });
        }
    }
    const rewrite = (value) => {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(rewrite);
        const replacement = replacements.get(value.uri);
        const updated = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
        return replacement ? { ...updated, uri: replacement.uri, ...('path' in value ? { path: replacement.path } : {}) } : updated;
    };
    const fileDelivery = {
        status: failures.length ? (replacements.size ? 'partial' : 'failed') : 'complete',
        copied: replacements.size,
        failures,
    };
    return {
        ...result,
        content: [...rewrite(result.content), { type: 'text', text: failures.length
            ? 'Report generation is preserved, but copying one or more files into the host project directory failed. Original resource links remain for those files. Do not regenerate reports or ask to mount internal plugin/session storage; diagnose local file delivery using fileDelivery.'
            : 'Verified report copies are available in the host project e-comet-reports directory. Present the returned resource links.' }],
        structuredContent: { ...rewrite(result.structuredContent), fileDelivery },
        isError: result.isError || failures.length > 0,
    };
};
