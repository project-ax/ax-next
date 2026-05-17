// ---------------------------------------------------------------------------
// Sandbox-side executor for the `artifact_publish` tool. The model calls
// the tool through the SDK MCP transport; the sandbox-MCP bridge
// (sandbox-mcp-server.ts) dispatches to this function via the runner's
// local-dispatcher.
//
// Reads /permanent/<...> directly (no IPC). The path the model supplies
// is the sandbox-absolute path (e.g. /permanent/workspace/report.pdf);
// we rewrite it onto the real workspace root configured at runner startup.
//
// Validation order matches the design doc:
//   1. Allowlist (pure-path).
//   2. lstat → catches symlinks before any byte read.
//   3. Size cap.
//   4. read + sha256.
//   5. mediaType sniff (extension only — no content sniffing v1).
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolCall } from '@ax/ipc-protocol';
import {
  checkPublishablePath,
  MAX_ARTIFACT_BYTES,
} from '@ax/tool-artifact-publish';

const SANDBOX_PERMANENT_PREFIX = '/permanent/';

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

    // Map /permanent/<rel> onto <workspaceRoot>/<rel>. The model never
    // supplies a path that doesn't start with /permanent/ (caught by
    // checkPublishablePath), so this slice is safe.
    const absInWorkspace = path.join(
      opts.workspaceRoot,
      input.path.slice(SANDBOX_PERMANENT_PREFIX.length),
    );

    // lstat — NOT stat — so symlinks register as symlinks instead of
    // their resolved target. We reject symlinks defensively.
    let lst;
    try {
      lst = await fs.lstat(absInWorkspace);
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

    const bytes = await fs.readFile(absInWorkspace);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifactId = sha256.slice(0, 16);

    const filename = path.basename(absInWorkspace);
    const displayName =
      typeof input.displayName === 'string' ? input.displayName : filename;

    return {
      artifactId,
      downloadUrl: `ax://artifact/${artifactId}`,
      path: relativePath,
      displayName,
      mediaType: mediaTypeFromExtension(filename),
      sizeBytes: lst.size,
      sha256,
    };
  };
}
