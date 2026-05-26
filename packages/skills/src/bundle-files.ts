/**
 * Bundle extra-file validation — the canonical rules for the non-SKILL.md
 * files a skill bundle may carry (JIT Phase 1a, design §9.2).
 *
 * Pure function; deliberately re-implemented (NOT imported) at the
 * sandbox-protocol wire schema and at the two runner extract boundaries per
 * invariant I2 (no cross-plugin import across a trust boundary). This is the
 * `validateMcpEntry` defense-in-depth pattern: each trust hop re-validates the
 * untrusted bundle independently, so a buggy/compromised host can't smuggle a
 * path-traversal or a reserved SDK-config file into the sandbox.
 *
 * A valid extra-file path is relative, POSIX, lowercase, dot/dash/underscore
 * only, with no `..`, no leading `/`, no backslashes; and is NOT a reserved or
 * generated path (`SKILL.md` is reconstructed from the manifest columns;
 * `.mcp.json` is generated from `mcpServers`; `.claude/*` and `.git/*` are SDK
 * / git auto-config that a bundle must never ship).
 */
export interface BundleFile {
  path: string;
  contents: string;
}

const PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;
const RESERVED = new Set(['SKILL.md', '.mcp.json']);
const MAX_FILES = 16;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_PATH_LEN = 256;

export function validateBundleFiles(files: BundleFile[]): void {
  if (files.length > MAX_FILES) {
    throw new Error(`bundle may declare at most 16 extra files, got ${files.length}`);
  }
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (typeof f.path !== 'string' || f.path.length === 0 || f.path.length > MAX_PATH_LEN) {
      throw new Error(`invalid bundle file path: ${JSON.stringify(f.path)}`);
    }
    if (f.path.includes('..') || f.path.startsWith('/') || !PATH_RE.test(f.path)) {
      throw new Error(`invalid path (must be relative, lowercase, no ../): ${f.path}`);
    }
    if (RESERVED.has(f.path) || f.path.startsWith('.claude/') || f.path.startsWith('.git/')) {
      throw new Error(`reserved bundle path may not be supplied: ${f.path}`);
    }
    if (seen.has(f.path)) throw new Error(`duplicate bundle path: ${f.path}`);
    seen.add(f.path);
    if (typeof f.contents !== 'string') {
      throw new Error(`bundle file '${f.path}' contents must be a string`);
    }
    const bytes = Buffer.byteLength(f.contents, 'utf-8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`bundle file '${f.path}' exceeds 256 KiB`);
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`bundle extra files exceed 512 KiB total`);
}
