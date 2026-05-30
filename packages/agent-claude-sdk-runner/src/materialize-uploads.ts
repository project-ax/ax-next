// ---------------------------------------------------------------------------
// TASK-68 (out-of-git Part C): materialize a conversation's committed uploads
// into the sandbox's `/ephemeral/uploads/` working copy at session start.
//
// Uploads left git. The durable home is the content-addressed blob store; the
// sandbox only needs a READABLE working copy. At boot the runner:
//   1. enumerates the bound conversation's uploads (`attachments.list`),
//   2. pulls each blob (`blob.get` — the response-direction binary channel,
//      streamed to a temp file), and
//   3. writes it to `<ephemeralRoot>/uploads/<conv>/<turn>/<file>` so a model
//      that Reads the re-rooted path (pre-tool-use.ts) finds a real file.
//
// Best-effort: a missing/failed blob is skipped + logged, never fatal — the same
// degradation posture as the workspace materialize (a single missing upload must
// not abort the whole session boot). The transcript still carries the upload's
// provenance, and the download path serves the bytes from the blob store
// directly, so a skipped materialization only affects in-sandbox Read access.
//
// Path safety: the `path` comes from the host's `attachments.list` (server-minted
// `.ax/uploads/<conv>/<turn>/<file>` with a sanitized filename), but we STILL
// reject any `..` segment and confine every write under `<ephemeralRoot>/uploads`
// — defense in depth against a compromised host or a future path shape.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IpcClient } from '@ax/ipc-protocol';
import { AttachmentsListResponseSchema } from '@ax/ipc-protocol';

export interface MaterializeUploadsDeps {
  client: Pick<IpcClient, 'call' | 'callBinary'>;
  conversationId: string;
  /** The ephemeral root (AX_EPHEMERAL_ROOT). Uploads land under `<root>/uploads/`. */
  ephemeralRoot: string;
  /** Optional logger; defaults to console.error for warnings. */
  warn?: (msg: string) => void;
}

const UPLOADS_KEY_PREFIX = '.ax/uploads/';

/**
 * Resolve the on-disk materialized path for a transcript upload key, confined
 * under `<uploadsBase>`. Returns null if the key is malformed or would escape.
 */
export function resolveMaterializedPath(
  uploadsBase: string,
  transcriptPath: string,
): string | null {
  if (!transcriptPath.startsWith(UPLOADS_KEY_PREFIX)) return null;
  const rel = transcriptPath.slice(UPLOADS_KEY_PREFIX.length); // <conv>/<turn>/<file>
  if (rel.length === 0) return null;
  const segments = rel.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '..' || seg === '.') return null;
  }
  const abs = path.join(uploadsBase, ...segments);
  // Final containment check (belt + suspenders): the joined path must stay under
  // the uploads base.
  const baseWithSep = uploadsBase.endsWith(path.sep) ? uploadsBase : uploadsBase + path.sep;
  if (!abs.startsWith(baseWithSep)) return null;
  return abs;
}

/**
 * Materialize the conversation's uploads into `<ephemeralRoot>/uploads/`.
 * Returns the count materialized. Best-effort — never throws; a per-file failure
 * is logged and skipped.
 */
export async function materializeUploads(deps: MaterializeUploadsDeps): Promise<number> {
  const warn = deps.warn ?? ((m: string) => process.stderr.write(m + '\n'));
  const uploadsBase = path.join(deps.ephemeralRoot, 'uploads');

  let files: Array<{ path: string; sha256: string }>;
  try {
    const raw = await deps.client.call('attachments.list', {
      conversationId: deps.conversationId,
    });
    files = AttachmentsListResponseSchema.parse(raw).files;
  } catch (err) {
    warn(
      `runner: attachments.list failed; skipping upload materialization: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }

  if (files.length === 0) return 0;

  let materialized = 0;
  for (const file of files) {
    const dest = resolveMaterializedPath(uploadsBase, file.path);
    if (dest === null) {
      warn(`runner: skipping upload with unsafe path '${file.path}'`);
      continue;
    }
    let tempPath: string | undefined;
    try {
      const got = await deps.client.callBinary('blob.get', { sha256: file.sha256 });
      tempPath = got.path;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // Copy the streamed temp file to the destination (rename can fail across
      // devices; copyFile is safe everywhere), then drop the temp.
      await fs.copyFile(tempPath, dest);
      materialized += 1;
    } catch (err) {
      warn(
        `runner: failed to materialize upload '${file.path}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      if (tempPath !== undefined) {
        await fs.unlink(tempPath).catch(() => {
          /* best-effort cleanup of the blob.get temp file */
        });
      }
    }
  }
  return materialized;
}
