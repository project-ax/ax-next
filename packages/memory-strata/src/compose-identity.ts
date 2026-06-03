// ---------------------------------------------------------------------------
// Compose the agent's identity from its `.ax/` files for memory-strata's
// `system/agent.md` seed (TASK-142).
//
// memory-strata seeds `system/agent.md` so the agent can re-read its own
// identity from durable memory on cold-start. Before TASK-142 that body was the
// legacy `system_prompt` string; now it's the agent's own `.ax/IDENTITY.md` +
// `.ax/SOUL.md`, composed the same way the runner injects them in normal mode
// (`## Identity … ## Soul …`).
//
// Layout: memory-strata's `ctx.workspace.rootPath` is the parent of `permanent/`
// (memory files live at `<rootPath>/permanent/memory/…` — see paths.ts), so the
// agent's `.ax/` files — which `workspace:apply` writes under `/permanent` — are
// at `<rootPath>/permanent/.ax/IDENTITY.md`. We read those directly (the same
// direct-fs read inject.ts uses), not via `workspace:read`.
//
// Security (Invariant #5): the `.ax/` files are AGENT-AUTHORED (untrusted model
// output round-tripped through the workspace). The body only flows into the
// agent's OWN durable memory file (read back into its OWN prompt) — never into a
// shell, path, SQL, or HTML — so it stays plain prose for the LLM. We still
// `lstat`-guard each read (reject symlinks/non-regular files so a malicious
// `.ax/SOUL.md → /proc/self/environ` can't leak a secret into agent.md) and cap
// the size, mirroring the runner's prompt-engine `readAxFile`.
// ---------------------------------------------------------------------------

import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

/** Per-file hard cap (mirrors the runner's prompt-engine). A larger file is
 * skipped whole, never truncated. Generous: a real IDENTITY/SOUL file is a few
 * KiB. */
const MAX_AX_FILE_BYTES = 256 * 1024;

/** Read one `.ax/` identity file under `<workspaceRoot>/permanent/.ax/`. Returns
 * undefined on any miss (absent, a symlink / non-regular file, over the cap, or
 * a read error) — the `lstat`-before-read guard rejects a symlink so its target
 * is never opened. */
async function readAxFile(
  workspaceRoot: string,
  name: string,
): Promise<string | undefined> {
  const path = join(workspaceRoot, 'permanent', '.ax', name);
  let info;
  try {
    info = await lstat(path);
  } catch {
    return undefined; // ENOENT (the common case) or any lstat error → absent.
  }
  // Reject a symlink (isFile() is false under lstat), directory, or device — a
  // symlinked `.ax/SOUL.md` could point at a secret outside the workspace.
  if (!info.isFile()) return undefined;
  if (info.size > MAX_AX_FILE_BYTES) return undefined;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Read `.ax/IDENTITY.md` + `.ax/SOUL.md` and compose them into a single
 * markdown body (`## Identity … ## Soul …`), the same shape the runner injects
 * in normal mode. Each section is inject-if-present; the heading appears only
 * when its body is present. Returns '' when neither file exists (a never-
 * identified / still-bootstrapping agent) — the caller seeds a placeholder body.
 */
export async function composeIdentityFromFiles(
  workspaceRoot: string,
): Promise<string> {
  const [identity, soul] = await Promise.all([
    readAxFile(workspaceRoot, 'IDENTITY.md'),
    readAxFile(workspaceRoot, 'SOUL.md'),
  ]);
  const parts: string[] = [];
  if (identity !== undefined && identity.trim().length > 0) {
    parts.push(`## Identity\n\n${identity.trim()}`);
  }
  if (soul !== undefined && soul.trim().length > 0) {
    parts.push(`## Soul\n\n${soul.trim()}`);
  }
  return parts.join('\n\n');
}
