// ---------------------------------------------------------------------------
// Sandbox-side executor for the `artifact_publish` tool (TASK-68, out-of-git
// Part C). The model calls the tool through the SDK MCP transport; the
// sandbox-MCP bridge (sandbox-mcp-server.ts) dispatches to this function via the
// runner's local-dispatcher.
//
// The validation order is unchanged (it's the security floor):
//   1. Allowlist (pure-path) — now /ephemeral/artifacts/** + /permanent/workspace/**.
//   2. lstat → catches symlinks before any byte read.
//   3. Size cap.
//   4. read + sha256.
//   5. mediaType sniff (extension only — no content sniffing v1).
//
// What CHANGED: durability. Before, the executor just returned metadata and the
// turn-end git commit captured the bytes (fuzzy, late). Now the executor STREAMS
// the bytes to the host's content-addressed blob store (blob.put — the new
// REQUEST-direction binary IPC channel) and records the metadata row
// (artifact.publish). Durability is observable EXACTLY at this function's return:
// a blob.put success means the bytes are durable, independent of any commit.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolCall } from '@ax/ipc-protocol';
import type { IpcClient } from '@ax/ipc-protocol';
import {
  checkPublishablePath,
  MAX_ARTIFACT_BYTES,
  type PublishRoot,
} from '@ax/tool-artifact-publish';

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function mediaTypeFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[ext] ?? 'application/octet-stream';
}

export interface CreateArtifactPublishExecutorOptions {
  /** Absolute filesystem path the model's `/permanent/...` maps onto. */
  workspaceRoot: string;
  /**
   * Absolute filesystem path the model's `/ephemeral/...` maps onto. When
   * undefined, publishing from `/ephemeral/artifacts/**` is rejected (the
   * deployment has no ephemeral tier wired) — `/permanent/workspace/**` still
   * works.
   */
  ephemeralRoot?: string;
  /**
   * IPC client to the host. The executor streams artifact bytes to `blob.put`
   * and records the metadata row via `artifact.publish`. When undefined (older
   * call sites / tests that only exercise validation), the executor returns the
   * computed metadata WITHOUT a durable store — see `publishToHost`.
   */
  client?: Pick<IpcClient, 'callBinaryUpload' | 'call'>;
  /**
   * The conversation this session is bound to. Required to record the artifact
   * row (it's the ownership scope). When null/undefined, the executor still
   * stores the blob but cannot record a metadata row, so it returns metadata
   * without calling artifact.publish.
   */
  conversationId?: string | null;
}

export interface ArtifactPublishOutput {
  artifactId: string;
  downloadUrl: string;
  path: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

function rootBaseFor(
  root: PublishRoot,
  opts: CreateArtifactPublishExecutorOptions,
): string | undefined {
  return root === 'ephemeral' ? opts.ephemeralRoot : opts.workspaceRoot;
}

export function createArtifactPublishExecutor(
  opts: CreateArtifactPublishExecutorOptions,
) {
  return async function execute(
    call: ToolCall,
  ): Promise<ArtifactPublishOutput> {
    const input = call.input as { path?: unknown; displayName?: unknown };
    if (typeof input?.path !== 'string' || input.path.length === 0) {
      throw new Error('artifact_publish: input.path is required (string)');
    }
    if (
      input.displayName !== undefined &&
      typeof input.displayName !== 'string'
    ) {
      throw new Error(
        'artifact_publish: input.displayName must be a string when provided',
      );
    }

    const check = checkPublishablePath(input.path);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    const relativePath = check.relativePath;

    // Map the sandbox-absolute path onto the real filesystem root for its tier.
    const base = rootBaseFor(check.root, opts);
    if (base === undefined) {
      throw new Error(
        `artifact_publish: the ${check.root} tier is not available in this deployment`,
      );
    }
    const absInRoot = path.join(base, relativePath);

    // lstat — NOT stat — so symlinks register as symlinks instead of their
    // resolved target. We reject symlinks defensively.
    let lst;
    try {
      lst = await fs.lstat(absInRoot);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error(
          `artifact_publish: file not found: ${input.path} (ENOENT)`,
        );
      }
      throw err;
    }

    if (lst.isSymbolicLink()) {
      throw new Error('artifact_publish: refusing to publish a symlink');
    }
    if (!lst.isFile()) {
      throw new Error('artifact_publish: target is not a regular file');
    }
    if (lst.size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact_publish: file too large (${lst.size} bytes, max ${MAX_ARTIFACT_BYTES} = 100 MiB)`,
      );
    }

    const bytes = await fs.readFile(absInRoot);
    const localSha = createHash('sha256').update(bytes).digest('hex');

    const filename = path.basename(absInRoot);
    const displayName =
      typeof input.displayName === 'string' ? input.displayName : filename;
    const mediaType = mediaTypeFromExtension(filename);

    // Stream the bytes to the host blob store + record the metadata row. The
    // host computes the authoritative sha256 (we sent the bytes; it hashes them),
    // so `publishToHost` returns that — `localSha` is a sanity reference.
    const published = await publishToHost({
      opts,
      bytes,
      localSha,
      relativePath,
      displayName,
      mediaType,
      sizeBytes: lst.size,
    });

    return {
      artifactId: published.artifactId,
      downloadUrl: published.downloadUrl,
      path: relativePath,
      displayName,
      mediaType,
      sizeBytes: lst.size,
      sha256: published.sha256,
    };
  };
}

/**
 * Store the artifact durably on the host and record its metadata row. Durability
 * is observable at the `blob.put` success. When no IPC client / conversationId
 * is wired (older call sites, validation-only tests), fall back to the prior
 * "compute metadata only" behavior with the locally-computed sha + id.
 */
async function publishToHost(args: {
  opts: CreateArtifactPublishExecutorOptions;
  bytes: Buffer;
  localSha: string;
  relativePath: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
}): Promise<{ artifactId: string; downloadUrl: string; sha256: string }> {
  const { opts, bytes, localSha } = args;
  if (opts.client === undefined) {
    // No host wiring (validation-only path): return the computed metadata
    // without a durable store. Used by call sites that only exercise the
    // path/symlink/size checks.
    const artifactId = localSha.slice(0, 16);
    return { artifactId, downloadUrl: `ax://artifact/${artifactId}`, sha256: localSha };
  }

  // 1) Stream the bytes to the content-addressed blob store (REQUEST-direction
  //    binary channel). The host returns the authoritative content hash.
  const put = (await opts.client.callBinaryUpload('blob.put', bytes)) as {
    sha256: string;
    size: number;
  };

  if (opts.conversationId === undefined || opts.conversationId === null) {
    // Bytes are durable in the blob store, but with no conversation binding we
    // can't record an ownership row. Return blob-derived metadata; the artifact
    // is reachable only once a row exists, so this is a degraded path.
    const artifactId = put.sha256.slice(0, 16);
    return { artifactId, downloadUrl: `ax://artifact/${artifactId}`, sha256: put.sha256 };
  }

  // 2) Record the metadata row (ownership + display). Returns the stable id.
  const pub = (await opts.client.call('artifact.publish', {
    conversationId: opts.conversationId,
    sha256: put.sha256,
    path: args.relativePath,
    displayName: args.displayName,
    mediaType: args.mediaType,
    size: args.sizeBytes,
  })) as { artifactId: string; downloadUrl: string };

  return {
    artifactId: pub.artifactId,
    downloadUrl: pub.downloadUrl,
    sha256: put.sha256,
  };
}
