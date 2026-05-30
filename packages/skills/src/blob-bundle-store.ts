/**
 * @ax/skills content-addressed bundle byte-store, blob-backed (out-of-git
 * design Part D2 — "kills the TASK-40 git-tree backing").
 *
 * Stores a skill bundle's EXTRA (non-SKILL.md) files as ONE content-addressed
 * object in the shared `blob:*` store (TASK-65 / @ax/blob-store-fs|s3) instead
 * of a bare isomorphic-git repo the plugin owns. A skill row's `bundle_tree_sha`
 * column now holds the blob's sha256 (a content hash, NOT a git oid) pointing
 * into that store. This finishes the unification (design I4): every opaque
 * skill-bundle byte lives in the one blob store, with the one GC story
 * (reference-counted blobs), instead of a third skills-private git substrate.
 *
 * SERIALIZATION. The file set is canonicalized — sorted by path, then
 * JSON-encoded — so an identical file set always produces identical bytes and
 * therefore an identical sha (dedup preserved, the property the git-tree backing
 * bought via shared OIDs). The blob store hashes the bytes itself, so the
 * pointer can't be forged by the caller.
 *
 * READ-SIDE VALIDATION (the extract boundary, design §9.2 / the validateMcpEntry
 * pattern — invariant I2). `readTree` re-runs `validateBundleFiles` on the
 * reconstructed paths, independent of the write-side check, so a tampered or
 * malformed blob can't smuggle a path-traversal / reserved-config file into the
 * sandbox. (The git backing's mode/symlink guards are not needed here — the JSON
 * encoding has no notion of an exec bit or a symlink; only a `{path,contents}`
 * pair survives, and the path is re-validated.)
 *
 * Bus surface: the store talks to the blob store ONLY through `blob:put` /
 * `blob:get` service hooks (the inter-plugin API — NOT a cross-plugin import,
 * invariant I2). The bus AND a stable AgentContext are injected at construction.
 * Using a fixed store-owned ctx (not the request ctx) is CORRECT here: `blob:*`
 * is purely content-addressed and carries NO ownership/conversation scope (see
 * @ax/blob-store-fs and the ipc-core blob handler note), so the ctx only carries
 * the logger — the sha is the whole identity. This keeps the public
 * `BundleStore` interface ctx-free, a drop-in for the retired git-tree store.
 */
import { createHash } from 'node:crypto';
import type { AgentContext, HookBus } from '@ax/core';
import { validateBundleFiles, type BundleFile } from './bundle-files.js';

/** Bump if the on-blob encoding ever changes (forces a new content address). */
const BUNDLE_FORMAT_VERSION = 1;

interface BlobPutOutput {
  sha256: string;
  size: number;
}
type BlobGetOutput = { bytes: Uint8Array } | { found: false };

/**
 * The byte-store interface the three skills stores consume. Identical to the
 * retired git-tree `BundleStore` (ctx-free `writeTree`/`readTree`) so it's a
 * drop-in replacement — only the backing changes (git tree → blob object).
 */
export interface BlobBundleStore {
  /**
   * Canonicalize + write the extra files as ONE content-addressed blob; return
   * its sha256. An empty file set returns `null` (no blob, no row pointer).
   * Caller is responsible for the write-side `validateBundleFiles`.
   */
  writeTree(files: BundleFile[]): Promise<string | null>;
  /**
   * Read a bundle blob back into extra files. Re-validates paths at this trust
   * boundary and returns files sorted by path for determinism. Throws if the
   * blob is missing (a dangling pointer) or malformed.
   */
  readTree(sha256: string): Promise<BundleFile[]>;
}

/**
 * Canonical, order-independent serialization of a bundle file set. Sort by path
 * so the same set always yields the same bytes (the dedup property). JSON keeps
 * it dependency-free and human-inspectable; the files are small text (≤512 KiB
 * total, enforced by validateBundleFiles upstream).
 */
function serializeBundle(files: BundleFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const doc = {
    v: BUNDLE_FORMAT_VERSION,
    files: sorted.map((f) => ({ path: f.path, contents: f.contents })),
  };
  return new TextEncoder().encode(JSON.stringify(doc));
}

function deserializeBundle(bytes: Uint8Array): BundleFile[] {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('skill bundle blob is not valid UTF-8 JSON');
  }
  if (
    typeof doc !== 'object' ||
    doc === null ||
    (doc as { v?: unknown }).v !== BUNDLE_FORMAT_VERSION ||
    !Array.isArray((doc as { files?: unknown }).files)
  ) {
    throw new Error('skill bundle blob has an unexpected shape');
  }
  const out: BundleFile[] = [];
  for (const raw of (doc as { files: unknown[] }).files) {
    if (
      typeof raw !== 'object' ||
      raw === null ||
      typeof (raw as { path?: unknown }).path !== 'string' ||
      typeof (raw as { contents?: unknown }).contents !== 'string'
    ) {
      throw new Error('skill bundle blob entry must be { path, contents }');
    }
    out.push({
      path: (raw as { path: string }).path,
      contents: (raw as { contents: string }).contents,
    });
  }
  return out;
}

export function createBlobBundleStore(bus: HookBus, ctx: AgentContext): BlobBundleStore {
  return {
    async writeTree(files) {
      if (files.length === 0) return null;
      const bytes = serializeBundle(files);
      const out = await bus.call<{ bytes: Uint8Array }, BlobPutOutput>('blob:put', ctx, { bytes });
      return out.sha256;
    },

    async readTree(sha256) {
      const out = await bus.call<{ sha256: string }, BlobGetOutput>('blob:get', ctx, { sha256 });
      if ('found' in out && out.found === false) {
        throw new Error(`skill bundle blob not found: ${sha256}`);
      }
      const files = deserializeBundle((out as { bytes: Uint8Array }).bytes);
      // Extract-boundary re-validation (I2) — independent of the write-side
      // check; a tampered/malformed blob can't smuggle a bad path through.
      validateBundleFiles(files);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return files;
    },
  };
}

/**
 * In-memory, bus-free `BlobBundleStore` for unit tests + as the store default
 * when no blob backend is wired (the same role the old ephemeral git repo
 * played). Uses the identical canonical serialization + extract-boundary
 * re-validation, sha256-addressed in a process-local Map, so dedup + the
 * round-trip behave exactly like the blob-backed store. NOT for production —
 * the plugin always injects the bus-backed store.
 */
export function createInMemoryBundleStore(): BlobBundleStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async writeTree(files) {
      if (files.length === 0) return null;
      const bytes = serializeBundle(files);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (!objects.has(sha)) objects.set(sha, bytes);
      return sha;
    },
    async readTree(sha256) {
      const bytes = objects.get(sha256);
      if (bytes === undefined) throw new Error(`skill bundle blob not found: ${sha256}`);
      const files = deserializeBundle(bytes);
      validateBundleFiles(files);
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return files;
    },
  };
}
