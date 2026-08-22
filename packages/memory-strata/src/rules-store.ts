// ---------------------------------------------------------------------------
// The human tier's read/write path (TASK-234 / plan task AW-13).
//
// `human-tier.ts` says what no automatic writer may do. This file is the one
// thing that may: it backs the `memory:rules:read` / `memory:rules:write`
// service hooks, and nothing else in the package calls it.
//
// It also reads the agent's own always-injected system docs, so the Memory tab
// can show BOTH sides of the split — the human's rules and the agent's working
// notes — from one place. Those reads share the tier-vs-host branching with
// `inject.ts` deliberately: the tab must show the same bytes the system prompt
// was built from, or it is describing a different agent than the one running.
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type {
  AgentContext,
  FileChange,
  HookBus,
  WorkspaceReadInput,
  WorkspaceReadOutput,
  WorkspaceVersion,
} from '@ax/core';
import { agentTierAvailable, applyTierChanges } from './agent-tier-sync.js';
import { HUMAN_TIER_TIER_PATHS, normalizeRulesBody } from './human-tier.js';
import {
  AGENT_TIER_MEMORY_ROOT,
  MEMORY_ROOT,
  mapFile,
  recentFile,
  rulesFile,
  systemFile,
} from './paths.js';

/** `permanent/memory/x` → `memory/x`. */
function toTierPath(rel: string): string {
  return posix.join(AGENT_TIER_MEMORY_ROOT, rel.slice(MEMORY_ROOT.length + 1));
}

/**
 * Read one memory file as text, tier-aware.
 *
 * Under the k8s preset the host's `ctx.workspace.rootPath` is a single shared
 * directory that holds no per-agent memory, so the read goes through
 * `workspace:read`, owner-routed by `ctx`. Returns '' on a miss: an absent file
 * and an empty one mean the same thing to every reader here.
 */
async function readMemoryText(
  bus: HookBus,
  ctx: AgentContext,
  workspaceRoot: string,
  rel: string,
): Promise<string> {
  if (agentTierAvailable(bus)) {
    try {
      const out = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        ctx,
        { path: toTierPath(rel) },
      );
      if (!out.found) return '';
      return new TextDecoder('utf-8').decode(out.bytes);
    } catch {
      // Same posture as inject's tier read: a hiccup degrades a READ to
      // "nothing written yet". The write path below does NOT swallow.
      return '';
    }
  }
  try {
    return await readFile(join(workspaceRoot, rel), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** The human tier's raw text, verbatim. '' when nothing has been written. */
export async function readRules(
  bus: HookBus,
  ctx: AgentContext,
  workspaceRoot: string,
): Promise<string> {
  return readMemoryText(bus, ctx, workspaceRoot, rulesFile());
}

/**
 * Write the human tier. The ONLY writer of `rules.md` in the codebase.
 *
 * Under a git tier the bytes go out through `workspace:apply` — this function
 * does not touch the file itself, because `/agent` is canonical and a host-FS
 * write would land in a shared directory no runner ever reads.
 *
 * Two facts from prior regressions apply here and are load-bearing:
 *
 *   - `workspace:apply` does NOT fire `workspace:applied` for host-side
 *     callers; only the runner→host commit-notify does. Nothing needs to react
 *     to a rules write today (the runner re-materializes `/agent` when it
 *     spawns), so we deliberately do not fire it. A future subscriber must fire
 *     it explicitly HERE rather than assume apply did.
 *   - `workspace:apply` routes by `(userId, agentId)` from the CALLER's ctx.
 *     A caller that hands us the wrong ctx lands this write in the wrong
 *     agent's workspace, which is why the `memory:rules:write` hook checks the
 *     payload's `agentId` against `ctx.agentId` before it gets here.
 *
 * Errors propagate. A Save that failed must not report success.
 */
export async function writeRules(
  bus: HookBus,
  ctx: AgentContext,
  workspaceRoot: string,
  body: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(normalizeRulesBody(body));

  if (agentTierAvailable(bus)) {
    const tierPath = HUMAN_TIER_TIER_PATHS[0]!;
    // CAS parent: the version we last saw for this file. A never-written file
    // reads back as a miss, which the apply contract takes as "no parent yet".
    let parent: WorkspaceVersion | null = null;
    try {
      const out = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
        'workspace:read',
        ctx,
        { path: tierPath },
      );
      if (out.found && out.version !== undefined) parent = out.version;
    } catch {
      // No readable head. Apply against null and let applyTierChanges's
      // rebase-on-mismatch retry reconcile against the tier's actual parent.
    }
    const changes: FileChange[] = [{ path: tierPath, kind: 'put', content: bytes }];
    await applyTierChanges(bus, ctx, changes, parent, 'memory:rules:write');
    return;
  }

  // CLI preset: no workspace backend is loaded, so the agent's own localdir
  // workspace root IS canonical — the same place every other memory file goes.
  const abs = join(workspaceRoot, rulesFile());
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

/** One of the agent's own always-injected working docs. */
export interface LearnedDoc {
  /** Stable, human-meaningful name. Not a path — see the boundary review. */
  name: string;
  /** The file's text, frontmatter included. Untrusted: it is model output. */
  body: string;
}

/**
 * The three docs the agent writes for itself and reads back every turn.
 *
 * These are exactly the always-injected files `inject.ts` builds the memory
 * block from, minus the human tier — which is the whole point of listing them
 * under a separate heading in the UI. Empty bodies are dropped: a heading over
 * nothing reads as a broken panel, not as an honest empty.
 */
export async function readLearnedDocs(
  bus: HookBus,
  ctx: AgentContext,
  workspaceRoot: string,
): Promise<LearnedDoc[]> {
  const wanted: Array<{ name: string; rel: string }> = [
    { name: 'What it knows about you', rel: systemFile('user') },
    { name: 'What it is working on', rel: recentFile() },
    { name: 'Index of everything it remembers', rel: mapFile() },
  ];
  const out: LearnedDoc[] = [];
  for (const w of wanted) {
    const body = await readMemoryText(bus, ctx, workspaceRoot, w.rel);
    if (body.trim().length === 0) continue;
    out.push({ name: w.name, body });
  }
  return out;
}
