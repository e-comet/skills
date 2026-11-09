import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeFeedbackProperty } from '../transport/failures/evidence.mjs';
// A cold Windows PowerShell can take over ten seconds to start on a loaded machine; the bound only stops a hang.
const readRegistry = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 30_000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout))));
// PowerShell reads and expands the value and answers with its UTF-16 character codes: reg.exe prints the value in the
// OEM code page, which decoding as UTF-8 turns into another path for a Cyrillic folder, and plain digits need no
// [Console] encoding, which a script policy's ConstrainedLanguage refuses.
const PERSONAL_CODES = "$p=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name Personal).Personal; [int[]][char[]]$p -join ','";
// The user's Documents folder, where a Claude host without a project gets its report copies. Windows may have moved it
// (for example to OneDrive) and keeps the real path, often with %VARIABLES%, as `Personal` in the user's shell folders;
// macOS and Linux use home/Documents. A missing or unexpandable value falls back to home/Documents as well; undefined
// means PowerShell gave no answer (a hang, a failed start), which the next copy may ask again.
export const documentsDirectory = async ({ platform = process.platform, env = process.env, home = homedir(), read = readRegistry, } = {}) => {
    const fallback = path.join(home, 'Documents');
    if (platform !== 'win32')
        return fallback;
    let output;
    try {
        output = (await read(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            PERSONAL_CODES,
        ])).trim();
    }
    catch {
        return undefined;
    }
    const value = /^\d+(?:,\d+)*$/.test(output) ? String.fromCharCode(...output.split(',').map(Number)) : undefined;
    return value && !value.includes('%') && path.win32.isAbsolute(value) ? value : fallback;
};
// Documents for the copies of one process, looked up at the first copy because the lookup starts PowerShell. An answer
// is kept; a copy that got none goes to home/Documents and the next copy asks again.
export const documentsFolder = (lookup = documentsDirectory, home = homedir()) => {
    let answered;
    return async () => answered ?? (answered = await lookup()) ?? path.join(home, 'Documents');
};
// A verified copy of one stored workbook into the host's e-comet-reports folder: the copy is checked against the
// recorded size and SHA-256 twice, and a copy this call created is removed when anything fails. Errors carry a closed
// reason as their message or a filesystem code; `stage` reports how far the copy got.
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
        if (!bytesRead)
            break;
        position += bytesRead;
        if (position > size)
            throw new Error('integrity_mismatch');
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (destination)
            await destination.writeFile(chunk);
    }
    if (position !== size)
        throw new Error('integrity_mismatch');
    return hash.digest('hex');
};
export const copyReport = async (artifact, directory, stage) => {
    // The host exports a resolved path. Validate its actual filesystem target; literal
    // dollar/percent/tilde characters in an existing directory are not expressions.
    if (typeof directory !== 'string' || !path.isAbsolute(directory))
        throw new Error('invalid_output_directory');
    if (!/^[^<>:"/\\|?*\x00-\x1f]+\.xlsx$/i.test(artifact.name) ||
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 0 ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256))
        throw new Error('invalid_artifact_metadata');
    const root = await realpath(directory);
    if (!(await lstat(root)).isDirectory())
        throw new Error('invalid_output_directory');
    stage('source');
    const sourcePath = await realpath(artifact.path);
    stage('output_directory');
    const child = path.join(directory, 'e-comet-reports');
    // The delivery copy must never become subject to the original store's retention.
    if (within(path.dirname(sourcePath), path.join(root, 'e-comet-reports')))
        throw new Error('invalid_output_directory');
    try {
        await mkdir(child);
    }
    catch (error) {
        if (safeFeedbackProperty(error, 'code') !== 'EEXIST')
            throw error;
    }
    const childStat = await lstat(child);
    // lstat accepts only a real directory here; it never follows a symlink.
    if (!childStat.isDirectory())
        throw new Error('invalid_output_directory');
    const physicalChild = await realpath(child);
    if (path.relative(root, physicalChild) !== 'e-comet-reports')
        throw new Error('invalid_output_directory');
    stage('source');
    const source = await open(sourcePath, 'r');
    let destination;
    let outputPath;
    let owned;
    let operationError;
    let failed = false;
    let copy;
    try {
        if (!(await source.stat()).isFile())
            throw new Error('source_not_file');
        stage('copy');
        outputPath = path.join(child, artifact.name);
        try {
            destination = await open(outputPath, 'wx+');
        }
        catch (error) {
            if (safeFeedbackProperty(error, 'code') !== 'EEXIST')
                throw error;
            outputPath = path.join(child, `${artifact.name.slice(0, -5)}-${randomUUID()}.xlsx`);
            destination = await open(outputPath, 'wx+');
        }
        // NTFS file IDs exceed 2^53, so only bigint stats tell neighbouring files apart.
        owned = await destination.stat({ bigint: true });
        if ((await digest(source, artifact.size, destination)) !== artifact.sha256)
            throw new Error('integrity_mismatch');
        stage('verification');
        await destination.sync();
        if ((await digest(destination, artifact.size)) !== artifact.sha256)
            throw new Error('integrity_mismatch');
        // Preserve the host's logical path. A packaged Windows host may virtualize it;
        // its file presenter recognizes this namespace, while private originals retain native paths.
        copy = { ...artifact, path: outputPath, uri: pathToFileURL(outputPath).href };
    }
    catch (error) {
        failed = true;
        operationError = error;
    }
    // Each handle gets its own close attempt. A close rejection must not skip
    // the other handle or replace an earlier copy/verification failure.
    const closed = await Promise.allSettled([destination, source].filter((handle) => handle !== undefined).map((handle) => Promise.resolve().then(() => handle.close())));
    const closeFailure = closed.find((result) => result.status === 'rejected');
    if ((operationError || closeFailure) && owned && outputPath !== undefined) {
        const current = await lstat(outputPath, { bigint: true }).catch(() => undefined);
        if (current?.ino === owned.ino && current?.dev === owned.dev)
            await unlink(outputPath).catch(() => undefined);
    }
    if (!operationError && closeFailure)
        throw closeFailure.reason;
    if (failed || copy === undefined)
        throw operationError;
    return copy;
};
