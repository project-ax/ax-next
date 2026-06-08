// ---------------------------------------------------------------------------
// Sandbox-side executor for the `skill_propose` tool (TASK-74, out-of-git
// Part D / §D1; filestore-user-files Phase 3 / TASK-165). The model writes a
// skill bundle into the draft dir `<root>/.skill-draft/<id>/` — where `<root>` is
// the DURABLE per-agent user-files mount (`AX_USERFILES_ROOT`, e.g. `/workspace`)
// when one is wired, else the ephemeral scratch tier (graceful fallback) — then
// calls this tool with that directory path. The sandbox-MCP bridge dispatches
// here via the runner's local-dispatcher (mirror of artifact_publish).
//
// We:
//   1. validate the draft path (checkDraftPath, against the ACTIVE draft root —
//      durable when wired, else ephemeral: `<root>/.skill-draft/<id>/`);
//   2. read SKILL.md + the extra files from the draft dir — SKILL.md is
//      lstat-hardened (a SKILL.md-as-symlink is rejected, HR2/§7.2) and the
//      extra-file walk already rejects symlinks; this matters because the draft
//      now lives on a DURABLE SHARED NFS mount where a symlink could otherwise
//      point a read at an arbitrary host file;
//   3. split SKILL.md into frontmatter (manifestYaml) + body (bodyMd);
//   4. structurally validate the extra files (path/size — re-implemented at this
//      trust boundary per I2, the validateMcpEntry pattern; the count/byte caps
//      double as the per-draft size guard on durable storage, HR3/§7.3);
//   5. post the bundle via the skill.propose IPC action — the HOST is the
//      authority on the manifest parse + the hybrid gate, so we ship the raw
//      manifestYaml/bodyMd/files and an EMPTY capability proposal (the host
//      re-parses the frontmatter as the proposal source of truth and ignores
//      the wire hint);
//   6. on a successful verdict (active/pending), DELETE the draft dir (cleanup-
//      on-promote, HR3/§7.3) — best-effort, so a failed delete never fails the
//      propose. On `quarantined` (or a throw) the draft is KEPT so the agent can
//      fix it and re-propose without re-authoring. A TTL sweeper for abandoned
//      drafts is a deferred follow-up.
//
// Returns the gate verdict ({ skillId, status, reason? }) to the model. The
// model words its turn from the status (active → "ready next turn"; pending →
// "approve the card"; quarantined → "I'll fix `reason`"). It must NOT try to
// invoke the proposed skill this turn — the tool description carries that
// guidance (design §D6).
// ---------------------------------------------------------------------------

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ToolCall, IpcClient } from '@ax/ipc-protocol';
import { checkDraftPath } from '@ax/tool-skill-propose';

// SKILL.md splitter — re-implemented at this trust boundary (I2: no
// @ax/skills-parser import across the sandbox edge). Mirrors skills-parser's
// splitSkillMd; the host re-splits + re-parses authoritatively. Accepts LF/CRLF.
function splitSkillMd(skillMd: string): { manifestYaml: string; bodyMd: string } | null {
  const re = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*)|$)/;
  const m = re.exec(skillMd);
  if (m === null) return null;
  return { manifestYaml: m[1] ?? '', bodyMd: m[2] ?? '' };
}

// Bundle EXTRA-file limits — re-implemented locally (I2; mirrors @ax/skills'
// validateBundleFiles). The host re-validates authoritatively; this is the
// runner's own defense so it never ships a path-traversal or an oversized blob.
const MAX_FILES = 16;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_PATH_LEN = 256;
const PATH_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)*$/;
const RESERVED = ['SKILL.md', '.mcp.json', '.claude', '.git'];

function isReserved(p: string): boolean {
  return RESERVED.some((r) => p === r || p.startsWith(r + '/'));
}

interface ExtraFile {
  path: string;
  contents: string;
}

function validateExtraFile(relPath: string, contents: string): string | null {
  if (relPath.length === 0 || relPath.length > MAX_PATH_LEN) return `invalid bundle path: ${relPath}`;
  if (relPath.includes('..') || relPath.startsWith('/') || !PATH_RE.test(relPath)) {
    return `invalid bundle path (must be relative, lowercase, no ../): ${relPath}`;
  }
  if (relPath.split('/').some((seg) => seg === '.' || seg === '..')) {
    return `invalid bundle path (no '.'/'..' segments): ${relPath}`;
  }
  if (isReserved(relPath)) return `reserved bundle path may not be supplied: ${relPath}`;
  if (Buffer.byteLength(contents, 'utf-8') > MAX_FILE_BYTES) {
    return `bundle file '${relPath}' exceeds 256 KiB`;
  }
  return null;
}

export interface CreateSkillProposeExecutorOptions {
  /** Durable per-agent user-files root (`AX_USERFILES_ROOT`, e.g. `/workspace`).
   * When set it is the PREFERRED draft root (drafts persist across sessions); the
   * executor reads `<userFilesRoot>/.skill-draft/<id>/`. Absent ⇒ no durable
   * mount; fall back to `ephemeralRoot`. (filestore-user-files Phase 3 / §7.) */
  userFilesRoot?: string;
  /** Ephemeral scratch root the model's draft can also map onto when no durable
   * mount is wired (`<ephemeralRoot>/.skill-draft/<id>/`). The FALLBACK draft root.
   * When BOTH userFilesRoot and ephemeralRoot are undefined, skill_propose is
   * rejected (no draft tier wired). */
  ephemeralRoot?: string;
  /** IPC client to the host. The executor posts skill.propose. When undefined
   * (validation-only tests) the executor returns a synthetic verdict. */
  client?: Pick<IpcClient, 'call'>;
}

export interface SkillProposeOutput {
  skillId: string;
  status: 'active' | 'pending' | 'quarantined';
  reason?: string;
}

const EMPTY_CAPS = {
  allowedHosts: [],
  credentials: [],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
};

export function createSkillProposeExecutor(opts: CreateSkillProposeExecutorOptions) {
  return async function execute(call: ToolCall): Promise<SkillProposeOutput> {
    const input = call.input as { path?: unknown };
    if (typeof input?.path !== 'string' || input.path.length === 0) {
      throw new Error('skill_propose: input.path is required (string)');
    }

    // The active draft root: the durable per-agent mount when wired (drafts
    // persist across sessions), else the ephemeral scratch tier (fallback). When
    // neither is wired there is no place to read a draft from — reject.
    const draftRoot = opts.userFilesRoot ?? opts.ephemeralRoot;
    if (draftRoot === undefined) {
      throw new Error(
        'skill_propose: no durable user-files or ephemeral tier is available in this deployment',
      );
    }

    // Validate against the SAME root the executor will read from — a path rooted
    // at a different tier is rejected (the executor never reads off-root).
    const check = checkDraftPath(input.path, draftRoot);
    if (!check.ok) {
      throw new Error(check.reason);
    }

    const dirAbs = path.join(draftRoot, check.relativeDir);
    const skillMdPath = path.join(dirAbs, 'SKILL.md');

    // HR2 (§7.2): lstat-harden SKILL.md before reading it. On a durable shared NFS
    // mount the agent could plant `SKILL.md` as a symlink pointing at an arbitrary
    // host file; a plain readFile would then ship THAT file's bytes to the host
    // gate as the proposed manifest. Reject a symlinked SKILL.md just like the
    // extra-file walk rejects symlinks. (lstat does NOT follow the link.)
    try {
      const st = await fs.lstat(skillMdPath);
      if (st.isSymbolicLink()) {
        throw new Error('skill_propose: refusing a symlinked SKILL.md in the draft directory');
      }
      if (!st.isFile()) {
        throw new Error('skill_propose: SKILL.md must be a regular file');
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        throw new Error(
          `skill_propose: ${input.path}/SKILL.md not found — write the skill's SKILL.md there first`,
        );
      }
      throw err;
    }

    // Read SKILL.md (required). The lstat above guarantees it is a regular file,
    // so this read can't be redirected through a symlink.
    const skillMdText = await fs.readFile(skillMdPath, 'utf-8');

    const split = splitSkillMd(skillMdText);
    if (split === null) {
      throw new Error(
        'skill_propose: SKILL.md must start with a --- frontmatter fence (name/description/version)',
      );
    }

    // Walk the draft dir for extra (non-SKILL.md) files. Bounded; symlinks and
    // nested-dir traversal are rejected via the relative-path validator.
    const files = await collectExtraFiles(dirAbs);

    // Post to the host gate. The host re-parses the manifest as the proposal
    // SoT and runs the hybrid gate — we send EMPTY caps (a redundant wire hint).
    if (opts.client === undefined) {
      // Validation-only path (tests): no host wiring.
      return { skillId: '(unsent)', status: 'pending' };
    }
    const verdict = (await opts.client.call('skill.propose', {
      manifestYaml: split.manifestYaml,
      bodyMd: split.bodyMd,
      files,
      capabilityProposal: EMPTY_CAPS,
      origin: 'authored',
    })) as SkillProposeOutput;

    // HR3 (§7.3): cleanup-on-successful-promote. The bundle is now in the host's
    // authored store (active) or queued for approval (pending), so the draft dir
    // has served its purpose — delete it so finished/abandoned drafts don't
    // accumulate on the durable mount (which has no auto-GC, unlike the old
    // per-pod emptyDir). KEEP it on `quarantined` so the agent can fix + re-propose
    // without re-authoring. Best-effort: the verdict already shipped, so a failed
    // delete must NOT turn a successful propose into an error. (A TTL sweeper for
    // drafts abandoned before any verdict is a deferred follow-up.)
    if (verdict.status === 'active' || verdict.status === 'pending') {
      await fs.rm(dirAbs, { recursive: true, force: true }).catch(() => {
        // swallow — durable cleanup is best-effort; the propose already succeeded.
      });
    }
    return verdict;
  };
}

/**
 * Read every non-SKILL.md file under the draft dir (one level + nested), as
 * {path (relative, posix), contents}. Enforces the count/size caps + per-file
 * path safety; rejects symlinks. The host re-validates authoritatively.
 */
async function collectExtraFiles(dirAbs: string): Promise<ExtraFile[]> {
  const out: ExtraFile[] = [];
  let total = 0;

  async function walk(absDir: string, relPrefix: string): Promise<void> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const ent of entries) {
      const rel = relPrefix === '' ? ent.name : `${relPrefix}/${ent.name}`;
      const abs = path.join(absDir, ent.name);
      if (ent.isSymbolicLink()) {
        throw new Error(`skill_propose: refusing a symlink in the bundle: ${rel}`);
      }
      if (ent.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (rel === 'SKILL.md') continue; // SKILL.md rides manifestYaml/bodyMd
      if (out.length >= MAX_FILES) {
        throw new Error('skill_propose: a bundle may declare at most 16 extra files');
      }
      const contents = await fs.readFile(abs, 'utf-8');
      const bad = validateExtraFile(rel, contents);
      if (bad !== null) throw new Error(`skill_propose: ${bad}`);
      total += Buffer.byteLength(contents, 'utf-8');
      if (total > MAX_TOTAL_BYTES) {
        throw new Error('skill_propose: bundle extra files exceed 512 KiB total');
      }
      out.push({ path: rel, contents });
    }
  }

  await walk(dirAbs, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
