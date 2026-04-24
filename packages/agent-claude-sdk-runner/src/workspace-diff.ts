// ---------------------------------------------------------------------------
// claude-sdk runner — per-turn workspace diff observer (Task 7c).
//
// The claude-agent-sdk owns the actual file I/O via its built-in `Write`,
// `Edit`, and `MultiEdit` tools. Those tools run inside the SDK's process,
// not through our LocalDispatcher — so the only signal we get is the
// PostToolUse hook, with `tool_name`, `tool_input`, and `tool_response`.
//
// Strategy: classify the tool name. For each known file-mutator, resolve
// the absolute path the tool wrote to (clamped to `workspaceRoot`) and
// read the resulting bytes back from disk. The disk-read is the simplest
// way to get the exact post-tool state for `Edit` / `MultiEdit` (whose
// inputs describe a transformation, not the final content).
//
// We deliberately do NOT try to scrape `Bash` for file-changing commands
// (`rm`, `mv`, etc.) — that's a heuristics rabbit hole. If the model
// deletes a file via `Bash`, the workspace diff misses it; the next turn's
// no-op commit-notify keeps the lineage intact and a future task can add
// a host-side "scan workspace at turn boundary" if it matters.
//
// Path containment: the runner's cwd is `workspaceRoot`, and the SDK
// resolves `file_path` relative to cwd. Even so, we re-resolve and
// reject paths that escape the root — defense in depth, since this code
// observes UNTRUSTED model output crossing into our diff stream.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DiffAccumulator } from '@ax/agent-runner-core';

const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * 1 MiB ceiling matches `@ax/tool-file-io-impl/exec.ts.MAX_FILE_BYTES`.
 * We can't import it directly (cross-plugin import — invariant I2), so we
 * redeclare. The host's workspace plugin is the eventual gatekeeper; this
 * cap exists only to prevent a model that wrote a giant file via `Write`
 * from blowing memory in the runner.
 */
const MAX_FILE_BYTES = 1_048_576;

export interface ObserveOptions {
  workspaceRoot: string;
  diffs: DiffAccumulator;
  /** Test seam — defaults to the real fs. */
  fs?: {
    realpath: (p: string) => Promise<string>;
    readFile: (p: string) => Promise<Buffer>;
  };
}

/**
 * Resolve a model-supplied path to an absolute path INSIDE the workspace.
 * Returns null if the path escapes the root. Mirrors the safePath helper
 * in `@ax/tool-file-io-impl/safe-path.ts` (also redeclared, not imported,
 * to keep this package free of cross-plugin imports).
 */
async function resolveSafe(
  workspaceRoot: string,
  rawPath: string,
  fsLike: ObserveOptions['fs'] = fs,
): Promise<string | null> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const root = await fsLike!.realpath(workspaceRoot);
  // Resolve relative to root regardless of whether the model gave us an
  // absolute path — the SDK's tools accept both forms.
  const candidate = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(root, rawPath);
  // Containment: candidate must be == root or under root + sep.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    return null;
  }
  return candidate;
}

/**
 * Convert an absolute resolved path back to the workspace-relative form
 * we want stored in the diff accumulator. Workspace-relative paths are
 * the wire-shape every workspace backend agrees on (Invariant I1 — no
 * leaking the runner's local mount point).
 */
function toRelative(workspaceRootAbs: string, absPath: string): string {
  const rel = path.relative(workspaceRootAbs, absPath);
  // path.relative on equal paths returns ''. Treat that as the root,
  // which isn't a valid file target — the caller filters this out.
  return rel;
}

/**
 * Observe one PostToolUse event. If the tool is a known file-mutator and
 * the path resolves inside the workspace, read the resulting bytes and
 * record them in the diff accumulator. Errors are swallowed: a failed
 * observation must never break the SDK's turn.
 */
export async function observePostToolUse(
  toolName: string,
  toolInput: unknown,
  opts: ObserveOptions,
): Promise<void> {
  if (!FILE_MUTATING_TOOLS.has(toolName)) return;
  if (typeof toolInput !== 'object' || toolInput === null) return;
  const filePath = (toolInput as { file_path?: unknown }).file_path;
  if (typeof filePath !== 'string') return;

  const fsLike = opts.fs ?? fs;
  let rootAbs: string;
  try {
    rootAbs = await fsLike.realpath(opts.workspaceRoot);
  } catch {
    return;
  }

  const resolved = await resolveSafe(opts.workspaceRoot, filePath, fsLike);
  if (resolved === null) return;
  const rel = toRelative(rootAbs, resolved);
  if (rel.length === 0) return; // root itself isn't a file

  let content: Buffer;
  try {
    content = await fsLike.readFile(resolved);
  } catch {
    // The file may have been deleted between PostToolUse firing and our
    // read; or some other transient. Drop this observation — the diff
    // is best-effort.
    return;
  }
  if (content.length > MAX_FILE_BYTES) return;

  opts.diffs.record({
    path: rel,
    kind: 'put',
    content: new Uint8Array(content),
  });
}
