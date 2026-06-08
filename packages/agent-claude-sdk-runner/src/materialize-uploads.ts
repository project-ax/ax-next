// ---------------------------------------------------------------------------
// TASK-68 (out-of-git Part C): materialize a conversation's committed uploads
// into the sandbox's working copy so the agent can Read them.
//
// TASK-78 (bug fix): materialize at the SAME path advertised to the model —
// `<workspaceRoot>/.ax/uploads/<conv>/<turn>/<file>` (the absolute form of the
// `.ax/uploads/...` key the system-prompt workspace note tells the agent to
// open). Previously we wrote under `<ephemeralRoot>/uploads/` (a DIFFERENT root,
// `.ax/` dropped), so an agent that followed the prompt and Read
// `/agent/.ax/uploads/...` — or `cat`'d it via Bash, whose command string is
// not re-rooted — found nothing. Anchoring the materialized path to the
// advertised path removes that mismatch.
//
// Uploads left git. The durable home is the content-addressed blob store; the
// sandbox only needs a READABLE working copy. On each (re)materialize the runner:
//   1. WIPES `<workspaceRoot>/.ax/uploads/` so no stale cross-conversation
//      residue from a prior session/conversation survives on the persistent
//      `/agent` tier or a warm runner,
//   2. enumerates the bound conversation's uploads (`attachments.list`),
//   3. pulls each blob (`blob.get` — the response-direction binary channel,
//      streamed to a temp file), and
//   4. writes it to `<workspaceRoot>/.ax/uploads/<conv>/<turn>/<file>`.
//
// `.ax/uploads/` is git-ignored by scaffoldWorkspaceGitignore, so these bytes do
// NOT round-trip into the commit/bundle (which would re-create the git-era blob
// duplication TASK-68 removed). The blob store stays the single source of truth.
//
// Best-effort: a missing/failed blob is skipped + logged, never fatal — the same
// degradation posture as the workspace materialize (a single missing upload must
// not abort the whole session boot). The transcript still carries the upload's
// provenance, and the download path serves the bytes from the blob store
// directly, so a skipped materialization only affects in-sandbox Read access.
//
// Path safety: the `path` comes from the host's `attachments.list` (server-minted
// `.ax/uploads/<conv>/<turn>/<file>` with a sanitized filename), but we STILL
// reject any `..` segment and confine every write under
// `<workspaceRoot>/.ax/uploads` — defense in depth against a compromised host or
// a future path shape.
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IpcClient } from '@ax/ipc-protocol';
import { AttachmentsListResponseSchema } from '@ax/ipc-protocol';

export interface MaterializeUploadsDeps {
  client: Pick<IpcClient, 'call' | 'callBinary'>;
  conversationId: string;
  /**
   * The workspace root (AX_WORKSPACE_ROOT, e.g. `/agent`). Uploads land at
   * `<workspaceRoot>/.ax/uploads/` — the absolute form of the `.ax/uploads/...`
   * key the model is told to open (see system-prompt.ts `workspaceNote`).
   */
  workspaceRoot: string;
  /** Optional logger; defaults to console.error for warnings. */
  warn?: (msg: string) => void;
}

const UPLOADS_KEY_PREFIX = '.ax/uploads/';

/**
 * The on-disk uploads base for a workspace root: `<workspaceRoot>/.ax/uploads`.
 * Centralised so the materialize loop, the residue wipe, and any reader resolve
 * the same directory.
 */
export function uploadsBaseDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ax', 'uploads');
}

/**
 * Resolve the on-disk materialized path for a transcript upload key, confined
 * under `<uploadsBase>`. Returns null if the key is malformed or would escape.
 *
 * `uploadsBase` is `<workspaceRoot>/.ax/uploads`; the key is
 * `.ax/uploads/<conv>/<turn>/<file>`. We strip the `.ax/uploads/` key prefix and
 * re-join the remainder under the base — so the materialized path keeps the
 * advertised `.ax/uploads/` shape (the base already carries it).
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
 * Materialize the conversation's uploads into `<workspaceRoot>/.ax/uploads/`.
 * Returns the count materialized. Best-effort — never throws; a per-file failure
 * is logged and skipped.
 *
 * Idempotent + safe to re-run on a warm-runner rebind (a later turn that brings
 * a new upload): the uploads dir is wiped first, then the FULL current upload set
 * for this conversation is written, so the set on disk always matches the host's
 * authoritative list — no stale cross-conversation residue, no missing
 * just-uploaded file.
 */
export async function materializeUploads(deps: MaterializeUploadsDeps): Promise<number> {
  const warn = deps.warn ?? ((m: string) => process.stderr.write(m + '\n'));
  const uploadsBase = uploadsBaseDir(deps.workspaceRoot);

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

  // Wipe any prior residue under `.ax/uploads/` BEFORE writing this
  // conversation's set. On a warm runner — or a `/agent` tier that persisted
  // from a prior conversation — stale uploads from another conversation could
  // otherwise linger and be Read by the agent (a cross-conversation leak). We
  // let the per-file mkdir below re-create what's needed. Best-effort: a wipe
  // failure is logged, not fatal (we still try to materialize on top).
  try {
    await fs.rm(uploadsBase, { recursive: true, force: true });
  } catch (err) {
    warn(
      `runner: failed to clear stale uploads under ${uploadsBase}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
