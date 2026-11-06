// ---------------------------------------------------------------------------
// Sandbox-side executor for the `artifact_publish` tool (TASK-68, out-of-git
// Part C). The model calls the tool through the SDK MCP transport; the
// sandbox-MCP bridge (sandbox-mcp-server.ts) dispatches to this function via the
// runner's local-dispatcher.
//
// The validation order (it's the security floor):
//   0. Input shape: a non-blank `title` of at most ARTIFACT_TITLE_MAX, an
//      optional string `artifactId`, a `path` with no control, format or bidi
//      character (the class `@ax/core/surface-text` owns), and a conversation
//      to publish into.
//   1. Allowlist (pure-path) — the session's REAL files root, <userFilesRoot>/**
//      and nothing else (C2). A relative path is taken relative to that root
//      first: the agent's artifact list names files that way. See
//      @ax/tool-artifact-publish.
//   2. lstat → catches a symlinked final component before any byte read.
//   3. realpath containment → catches a symlinked INTERMEDIATE directory, which
//      the textual check structurally cannot see (step 1 does no I/O) and which
//      lstat does not catch either (it follows every component but the last).
//   4. Size cap.
//   5. read, then stream the bytes to the host's content-addressed blob store
//      (blob.put — the REQUEST-direction binary IPC channel).
//   6. artifact.publish: the host adds a version to the artifact published
//      from this path (or named by `artifactId`), or makes a new one. Media
//      type and size are the host's to decide (from the path, from the store).
//
// The result names the artifact by id and `ax://artifact/<id>` — never a share
// code (C1) — plus the root-relative `path`, which auto-attach keys on so the
// published file gets no `agent_file` chip next to its card.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { REWRITES_THE_SURFACE } from '@ax/core/surface-text';
import {
  ARTIFACT_TITLE_MAX,
  type ArtifactKind,
  type ArtifactPublishResponse,
  type IpcClient,
  type ToolCall,
} from '@ax/ipc-protocol';
import {
  checkPublishablePath,
  describeRoots,
  MAX_ARTIFACT_BYTES,
  type PublishRoots,
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

/**
 * A file's media type, from its extension alone (no content sniffing). Labels
 * the files auto-attach references (`generated-files.ts`). A published
 * artifact's media type is the host's to decide, from the path.
 */
export function mediaTypeFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[ext] ?? 'application/octet-stream';
}

export interface CreateArtifactPublishExecutorOptions {
  /**
   * The agent's files folder (`AX_USERFILES_ROOT`). The only publishable place
   * (C2) — it is the agent's cwd and holds only its own files. Required: the
   * runner refuses to start without it.
   */
  userFilesRoot: string;
  /**
   * IPC client to the host. The executor streams the bytes to `blob.put` and
   * adds the version via `artifact.publish`.
   */
  client: Pick<IpcClient, 'callBinaryUpload' | 'call'>;
  /**
   * The conversation this session is bound to: the ownership scope of the
   * publish. With none, the executor refuses before any byte leaves.
   */
  conversationId?: string | null;
}

export interface ArtifactPublishOutput {
  artifactId: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  extension: string;
  /** `ax://artifact/<id>` — never a share code (C1). */
  url: string;
  /** Relative to the files folder; the re-publish key. */
  path: string;
}

function fail(message: string): never {
  throw new Error(`artifact_publish: ${message}`);
}

export function createArtifactPublishExecutor(
  opts: CreateArtifactPublishExecutorOptions,
) {
  return async function execute(
    call: ToolCall,
  ): Promise<ArtifactPublishOutput> {
    const input = (call.input ?? {}) as { path?: unknown; title?: unknown; artifactId?: unknown };
    if (typeof input.path !== 'string' || input.path.length === 0) {
      fail('input.path is required (string)');
    }
    // `title` is model output the host stores and shows. The host normalizes
    // it; a blank or over-long one is refused here, with a message the model
    // can act on, rather than as a wire error.
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      fail('input.title is required: a short human name, like "Q3 pipeline report"');
    }
    if (input.title.length > ARTIFACT_TITLE_MAX) {
      fail(`title too long (${input.title.length} chars, max ${ARTIFACT_TITLE_MAX})`);
    }
    if (input.artifactId !== undefined && typeof input.artifactId !== 'string') {
      fail('input.artifactId must be a string when provided');
    }
    // The path is stored and shown back to the agent and the person; a control
    // or bidi character could make it read as a different name.
    if (REWRITES_THE_SURFACE.test(input.path)) {
      fail('the path holds a control or invisible character; rename the file first');
    }
    const conversationId = opts.conversationId;
    if (conversationId === undefined || conversationId === null) {
      fail('this session is not bound to a conversation, so there is nowhere to publish to');
    }

    const roots: PublishRoots = { userFilesRoot: opts.userFilesRoot };
    // The agent's artifact list names files relative to the files folder, so a
    // relative path is taken relative to it. `..` cannot escape: the allowlist
    // resolves and re-checks containment.
    const requested = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(opts.userFilesRoot, input.path);
    const check = checkPublishablePath(requested, roots);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    const { base, relativePath } = check;
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

    // Containment re-check, AFTER the symlink reject and BEFORE any byte read.
    //
    // The allowlist is a pure function, so it can only reason about the path as
    // TEXT — `path.resolve` kills `..`, but it cannot know that
    // `<root>/reports` is a symlink to `/etc`. `lstat` does not close that
    // either: it declines to follow only the FINAL component, and happily
    // traverses symlinked directories on the way there. Since the agent now has
    // a whole folder of its own to publish from, and it writes every byte of it,
    // planting such a directory is trivial. Resolving both sides and re-testing
    // containment is what actually enforces "inside the folder".
    //
    // Residual, stated rather than papered over: this is a check-then-read, so a
    // component swapped between `realpath` and `readFile` would still be
    // followed. Closing that needs per-component `openat`, which node does not
    // expose. The bounded impact is the sandbox's own container filesystem — the
    // pod carries no service-account token and mounts no host paths beyond the
    // agent's own tiers.
    let realBase: string;
    let realTarget: string;
    try {
      realBase = await fs.realpath(base);
      realTarget = await fs.realpath(absInRoot);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error(
          `artifact_publish: file not found: ${input.path} (ENOENT)`,
        );
      }
      throw err;
    }
    if (
      realTarget !== realBase &&
      !realTarget.startsWith(realBase + path.sep)
    ) {
      throw new Error(
        `artifact_publish: resolved outside the files folder — ${describeRoots(roots)}`,
      );
    }

    if (lst.size > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `artifact_publish: file too large (${lst.size} bytes, max ${MAX_ARTIFACT_BYTES} = 100 MiB)`,
      );
    }

    const bytes = await fs.readFile(absInRoot);

    const published = await publishBytesToHost({
      client: opts.client,
      conversationId,
      bytes,
      path: relativePath,
      title: input.title,
      ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
    });
    // The client checked the answer against the wire schema; only the fields
    // named here reach the model.
    return {
      artifactId: published.artifactId,
      version: published.version,
      title: published.title,
      kind: published.kind,
      extension: published.extension,
      url: `ax://artifact/${published.artifactId}`,
      path: relativePath,
    };
  };
}
/**
 * The put-then-publish pair: stream the bytes to the content-addressed blob
 * store (`blob.put`, the REQUEST-direction binary channel), then add the
 * version (`artifact.publish`). The host hashes the bytes it stored and that
 * hash is what the version records. Shared by `artifact_publish` and
 * `show_visual`.
 */
export async function publishBytesToHost(args: {
  client: Pick<IpcClient, 'callBinaryUpload' | 'call'>;
  conversationId: string;
  bytes: Buffer;
  /** Relative to the files folder (or a reserved key); the re-publish key. */
  path: string;
  title: string;
  artifactId?: string;
  /** A chat visual (show_visual only): kept out of the Artifacts list. */
  visual?: true;
}): Promise<ArtifactPublishResponse> {
  const put = (await args.client.callBinaryUpload('blob.put', args.bytes)) as { sha256: string };
  return (await args.client.call('artifact.publish', {
    conversationId: args.conversationId,
    sha256: put.sha256,
    path: args.path,
    title: args.title,
    ...(args.artifactId !== undefined ? { artifactId: args.artifactId } : {}),
    ...(args.visual === true ? { visual: true } : {}),
  })) as ArtifactPublishResponse;
}
