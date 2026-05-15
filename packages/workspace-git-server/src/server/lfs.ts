import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { writeError } from './listener.js';
import {
  validateWorkspaceId,
  InvalidWorkspaceIdError,
} from '../shared/workspace-id.js';

// ---------------------------------------------------------------------------
// Git LFS server (https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md).
//
// Per-workspace blob store at <repoRoot>/<workspaceId>.lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>.
// Standard LFS layout — keeps `git lfs prune` and friends compatible.
//
// OIDs are sha256 hex (64 chars). Strict regex defends against path traversal
// regardless of what validateWorkspaceId already enforced.
//
// Auth is enforced by the listener's bearer-token gate before dispatch
// reaches us; we don't re-check here.
// ---------------------------------------------------------------------------

const OID_REGEX = /^[a-f0-9]{64}$/;

function lfsBlobPath(repoRoot: string, workspaceId: string, oid: string): string {
  return join(
    repoRoot,
    `${workspaceId}.lfs`,
    'objects',
    oid.slice(0, 2),
    oid.slice(2, 4),
    oid,
  );
}

export interface LfsHandlerOptions {
  repoRoot: string;
  /** Origin used to build the upload/download hrefs returned by batch. */
  baseUrl: string;
}

export async function handleLfsBatch(
  workspaceId: string,
  rawBody: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  opts: LfsHandlerOptions,
): Promise<void> {
  // workspaceId already validated by matchRoute regex, but keep the
  // defense-in-depth check.
  try {
    validateWorkspaceId(workspaceId);
  } catch (err) {
    if (err instanceof InvalidWorkspaceIdError) {
      return writeError(res, 400, 'invalid_workspace_id', 'invalid workspaceId');
    }
    throw err;
  }

  const body = rawBody as {
    operation?: unknown;
    transfers?: unknown;
    objects?: unknown;
  };
  const operation =
    typeof body.operation === 'string' ? body.operation : '';
  const objects = Array.isArray(body.objects) ? body.objects : [];

  const authHeader =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : '';

  const responseObjects = objects.map((obj: unknown) => {
    const o = obj as { oid?: unknown; size?: unknown };
    const oid = typeof o.oid === 'string' ? o.oid : '';
    const size = typeof o.size === 'number' ? o.size : 0;
    if (!OID_REGEX.test(oid)) {
      return { oid, size, error: { code: 422, message: 'invalid oid' } };
    }
    const storageHref = `${opts.baseUrl}/${workspaceId}.git/info/lfs/storage/${oid}`;
    const verifyHref = `${opts.baseUrl}/${workspaceId}.git/info/lfs/verify`;
    const actions: Record<string, { href: string; header: Record<string, string> }> = {};
    if (operation === 'upload') {
      actions.upload = { href: storageHref, header: { authorization: authHeader } };
      actions.verify = { href: verifyHref, header: { authorization: authHeader } };
    } else if (operation === 'download') {
      actions.download = { href: storageHref, header: { authorization: authHeader } };
    }
    return { oid, size, actions };
  });

  res.statusCode = 200;
  res.setHeader('content-type', 'application/vnd.git-lfs+json');
  res.end(JSON.stringify({ transfer: 'basic', objects: responseObjects }));
}

export async function handleLfsStorageUpload(
  workspaceId: string,
  oid: string,
  req: IncomingMessage,
  res: ServerResponse,
  opts: LfsHandlerOptions,
): Promise<void> {
  try {
    validateWorkspaceId(workspaceId);
  } catch (err) {
    if (err instanceof InvalidWorkspaceIdError) {
      return writeError(res, 400, 'invalid_workspace_id', 'invalid workspaceId');
    }
    throw err;
  }
  if (!OID_REGEX.test(oid)) {
    return writeError(res, 400, 'validation', 'invalid oid');
  }

  const finalPath = lfsBlobPath(opts.repoRoot, workspaceId, oid);
  await fs.mkdir(dirname(finalPath), { recursive: true });

  // Collision-safe per-request suffix — process.pid + Date.now() can
  // collide for two concurrent PUTs of the same OID landing in the same
  // millisecond, which would let both writers mutate the same temp file
  // before either rename and corrupt the upload.
  const tempPath = `${finalPath}.tmp.${process.pid}.${randomUUID()}`;
  const writeStream = createWriteStream(tempPath);
  const hash = createHash('sha256');

  try {
    await new Promise<void>((resolve, reject) => {
      let cleanup = false;
      const onError = (err: Error): void => {
        if (cleanup) return;
        cleanup = true;
        writeStream.destroy();
        reject(err);
      };
      req.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        if (!writeStream.write(chunk)) req.pause();
      });
      writeStream.on('drain', () => req.resume());
      req.on('end', () => {
        writeStream.end(() => resolve());
      });
      req.on('error', onError);
      writeStream.on('error', onError);
    });

    const computed = hash.digest('hex');
    if (computed !== oid) {
      await fs.unlink(tempPath).catch(() => {});
      return writeError(res, 422, 'validation', 'oid mismatch');
    }
    await fs.rename(tempPath, finalPath);
    res.statusCode = 200;
    res.end();
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    process.stderr.write(
      `workspace-git-server: lfs upload failed: ${(err as Error).message}\n`,
    );
    return writeError(res, 500, 'internal_error', 'upload failed');
  }
}

export async function handleLfsStorageDownload(
  workspaceId: string,
  oid: string,
  res: ServerResponse,
  opts: LfsHandlerOptions,
): Promise<void> {
  try {
    validateWorkspaceId(workspaceId);
  } catch (err) {
    if (err instanceof InvalidWorkspaceIdError) {
      return writeError(res, 400, 'invalid_workspace_id', 'invalid workspaceId');
    }
    throw err;
  }
  if (!OID_REGEX.test(oid)) {
    return writeError(res, 400, 'validation', 'invalid oid');
  }
  const blobPath = lfsBlobPath(opts.repoRoot, workspaceId, oid);
  let stat;
  try {
    stat = await fs.stat(blobPath);
  } catch {
    return writeError(res, 404, 'workspace_not_found', 'oid not found');
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', String(stat.size));
  createReadStream(blobPath).pipe(res);
}

export async function handleLfsVerify(
  workspaceId: string,
  rawBody: unknown,
  res: ServerResponse,
  opts: LfsHandlerOptions,
): Promise<void> {
  try {
    validateWorkspaceId(workspaceId);
  } catch (err) {
    if (err instanceof InvalidWorkspaceIdError) {
      return writeError(res, 400, 'invalid_workspace_id', 'invalid workspaceId');
    }
    throw err;
  }
  const body = rawBody as { oid?: unknown; size?: unknown };
  const oid = typeof body.oid === 'string' ? body.oid : '';
  if (!OID_REGEX.test(oid)) {
    return writeError(res, 400, 'validation', 'invalid oid');
  }
  const blobPath = lfsBlobPath(opts.repoRoot, workspaceId, oid);
  try {
    const stat = await fs.stat(blobPath);
    if (typeof body.size === 'number' && stat.size !== body.size) {
      return writeError(res, 422, 'validation', 'size mismatch');
    }
    res.statusCode = 200;
    res.end();
  } catch {
    return writeError(res, 404, 'workspace_not_found', 'oid not found');
  }
}
