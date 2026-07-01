// Auto-injection of memory into system prompts. Builds a markdown block
// from the agent's memory files and contributes it via the
// `system-prompt:augment` service hook.
//
// Design note — "Relevant Documents" section at chat-start time:
//   At `system-prompt:augment` time there is no incoming user message to
//   query against. Three options were considered:
//     (a) Use a sentinel query (agent persona, etc.) — brittle.
//     (b) Skip retrieval at this seam. ← CHOSEN.
//     (c) Plumb chat:start's message payload through the kernel. Out of scope.
//   Option (b) keeps the spec honest: auto-injection at chat:start carries
//   only `## User Profile` + `## Recent`. The agent uses the `memory_search`
//   tool for per-turn relevance. If a future phase plumbs the user message
//   into chat:start (or adds a chat:turn augment seam), add the retriever
//   call back at that point.
//
// `buildMemoryBlock` accepts an optional `lastUserMessage` arg so future
// code can pass it; when present, a `## Relevant Documents` section is
// appended. Both paths are tested.

import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type {
  HookBus,
  AgentContext,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { agentTierAvailable, AGENT_TIER_MEMORY_ROOT } from './agent-tier-sync.js';
import { systemFile, recentFile, mapFile } from './paths.js';
import { retrieve } from './retriever.js';

const PLUGIN_NAME = '@ax/memory-strata';

/**
 * Default soft cap on the WHOLE auto-injected block (I21). Bumped from 1500 to
 * 3500 in TASK-190 to make room for the always-injected `## Memory Map` (its
 * own ~2k-token soft-cap, {@link DEFAULT_MAP_MAX_TOKENS}) alongside profile +
 * recent + a few relevant docs. The block never exceeds this cap; drop strategy
 * below. 4 chars/token is the standard rough estimate.
 */
export const DEFAULT_MAX_TOKENS = 3500;

/**
 * Default soft cap on the `## Memory Map` section alone (TASK-190). ~2k tokens.
 * The map is bounded to this BEFORE the whole-block I21 cap is applied: map
 * entries are dropped from the tail (the map is sorted by category/slug, not by
 * rank, so the tail is the documented, arbitrary-but-stable drop edge). The map
 * remains a derived index the agent can also reach via `memory_search`, so when
 * the total cap is tight the map yields before the smaller, higher-value
 * profile/recent sections (see {@link assembleUnderCap}).
 */
export const DEFAULT_MAP_MAX_TOKENS = 2000;

export interface BuildMemoryBlockInput {
  /** Workspace root for file lookups. */
  workspaceRoot: string;
  /**
   * The chat's incoming user message, if known at the seam. When provided,
   * the block includes a `## Relevant Documents` section built from
   * `memory:index:search`. At `system-prompt:augment` time we don't have
   * this, so the section is omitted. Future: plumb a per-turn augment seam.
   */
  lastUserMessage?: string;
  /** Max approximate tokens (chars / 4) for the WHOLE block. Default DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** Max approximate tokens for the Memory Map section. Default DEFAULT_MAP_MAX_TOKENS. */
  mapMaxTokens?: number;
  /** topK for retrieve(); default 3. Only used when lastUserMessage is set. */
  topK?: number;
}

/**
 * Build the auto-injected memory block for a given workspace. Contains:
 *   ## User Profile      — contents of permanent/memory/system/user.md (body only)
 *   ## Recent            — contents of permanent/memory/system/recent.md (body only)
 *   ## Memory Map        — contents of permanent/memory/system/map.md (TASK-190)
 *   ## Relevant Documents — only when lastUserMessage is set (retriever results)
 *
 * The returned string is bounded to approximately `maxTokens` tokens
 * (I21: default DEFAULT_MAX_TOKENS, heuristic 4 chars/token). Drop strategy
 * (highest-value sections survive longest):
 *   1. Drop lowest-rank retrieved doc summaries first.
 *   2. Truncate ## Memory Map (drop tail entries) — it's a derived index the
 *      agent can re-reach via memory_search.
 *   3. Truncate ## Recent body.
 *   4. Truncate ## User Profile body as last resort.
 * The Memory Map is ALSO independently soft-capped to `mapMaxTokens`
 * (DEFAULT_MAP_MAX_TOKENS ≈ 2k) before the whole-block cap is applied.
 *
 * Returns '' when all source files are missing (no memory seeded yet).
 */
export async function buildMemoryBlock(
  bus: HookBus,
  ctx: AgentContext,
  input: BuildMemoryBlockInput,
): Promise<string> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const mapMaxTokens = input.mapMaxTokens ?? DEFAULT_MAP_MAX_TOKENS;
  const topK = input.topK ?? 3;

  // TASK-182: when memory lives in the per-agent `/agent` git tier (k8s), read
  // the injected system files from THERE (owner-routed by ctx) — the host FS
  // `workspaceRoot` is the shared host CWD and holds no per-agent memory. The
  // CLI path keeps reading the agent's own workspace root on the host FS.
  const useTier = agentTierAvailable(bus);
  const userProfileBody = useTier
    ? await readTierSystemBody(bus, ctx, 'user')
    : await readSystemBody(input.workspaceRoot, 'user');
  const recentBody = useTier
    ? await readTierSystemBody(bus, ctx, 'recent')
    : await readSystemBody(input.workspaceRoot, 'recent');
  const rawMapBody = useTier
    ? await readTierSystemBody(bus, ctx, 'map')
    : await readSystemBody(input.workspaceRoot, 'map');
  // Soft-cap the map to its own budget BEFORE the whole-block cap, dropping
  // tail entries (TASK-190). Bounding it here keeps a runaway map from
  // crowding out profile/recent under the total cap.
  const mapBody = capMapBody(rawMapBody, mapMaxTokens);

  let docsLines: string[] = [];
  if (input.lastUserMessage !== undefined && input.lastUserMessage.length > 0) {
    // retrieve() returns results sorted by score DESC (highest rank first).
    // We rely on that ordering so that dropping from the tail removes the
    // lowest-rank results first (I21 drop strategy step 1).
    const results = await retrieve(bus, ctx, {
      query: input.lastUserMessage,
      topK,
    });
    // Sort defensively — spec says retrieve() returns DESC but be explicit.
    const sorted = [...results].sort((a, b) => b.score - a.score);
    docsLines = sorted.map((r) => `- [${r.docId}] ${r.summary}`);
  }

  return assembleUnderCap({ userProfileBody, recentBody, mapBody, docsLines, maxTokens });
}

/**
 * Soft-cap the Memory Map body to ~`maxTokens` (TASK-190). Keeps the leading
 * heading + category headers and drops trailing `- ` entry lines until the
 * section fits. The map is sorted by category/slug (not by rank), so the tail
 * is an arbitrary-but-stable drop edge. Returns '' for an empty/whitespace map.
 */
export function capMapBody(mapBody: string, maxTokens: number): string {
  const trimmed = mapBody.trim();
  if (trimmed.length === 0) return '';
  const maxChars = maxTokens * 4;
  if (trimmed.length <= maxChars) return trimmed;

  const lines = trimmed.split('\n');
  // Drop trailing lines until under the char budget. Never drop below the
  // first line (the `# Memory Map` heading) so a single huge map still yields
  // a non-empty, well-formed section that the whole-block cap can finish.
  while (lines.length > 1 && lines.join('\n').length > maxChars) {
    lines.pop();
  }
  return lines.join('\n').trim();
}

/**
 * Read `system/map.md`'s BODY (frontmatter stripped), tier-aware — the
 * retrieval orchestrator's one piece of filesystem I/O (TASK-191 Task 3).
 * Reuses the SAME tier-vs-host branching {@link buildMemoryBlock} already
 * does for the auto-injected map section (`readTierSystemBody`/`readSystemBody`),
 * so the orchestrator reads the same on-disk file the agent's system prompt is
 * built from. NOTE: this returns the FULL, UNCAPPED body — unlike the injected
 * `## Memory Map` section, which `buildMemoryBlock` soft-caps via `capMapBody`
 * (~2k tokens, tail-dropped) to fit the whole-block budget. The orchestrator
 * deliberately gets the whole map (more recall for the retrieval planner; it
 * emits a handful of ops, not a token-bounded prompt section). Returns '' on a
 * miss (no map yet) — the caller (`runOrchestratedRetrieve`) treats an empty
 * map as "nothing to orchestrate over" and falls back to BM25.
 */
export async function readInjectedMapBody(
  bus: HookBus,
  ctx: AgentContext,
  workspaceRoot: string,
): Promise<string> {
  return agentTierAvailable(bus)
    ? await readTierSystemBody(bus, ctx, 'map')
    : await readSystemBody(workspaceRoot, 'map');
}

type InjectedSystemName = 'user' | 'recent' | 'map';

/** Map an injected-section name to its workspace-relative FS path. */
function systemRelPath(name: InjectedSystemName): string {
  if (name === 'recent') return recentFile();
  if (name === 'map') return mapFile();
  return systemFile(name);
}

/**
 * Read the body of a system markdown file (user.md / recent.md / map.md).
 * Strips the YAML frontmatter block (--- ... ---) and returns the
 * remaining text. Returns '' when the file doesn't exist (ENOENT).
 */
async function readSystemBody(
  workspaceRoot: string,
  name: InjectedSystemName,
): Promise<string> {
  const rel = systemRelPath(name);
  const abs = join(workspaceRoot, rel);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
  return stripFrontmatter(raw);
}

/**
 * Tier variant of {@link readSystemBody} (TASK-182). Reads `memory/system/<name>.md`
 * from the per-agent `/agent` git tier via `workspace:read` (owner-routed by
 * `ctx`). Returns '' on a miss (not-found, or any read error) so injection
 * degrades to an empty section rather than failing the system-prompt augment.
 */
async function readTierSystemBody(
  bus: HookBus,
  ctx: AgentContext,
  name: InjectedSystemName,
): Promise<string> {
  // FS rel paths are `permanent/memory/system/<name>.md` (MEMORY_ROOT =
  // `permanent/memory`, two segments). The tier drops that whole host-layout
  // prefix and re-roots the tail under `memory/` → `memory/system/<name>.md`.
  const fsRel = systemRelPath(name);
  const tierPath = posix.join(
    AGENT_TIER_MEMORY_ROOT,
    fsRel.split('/').slice(2).join('/'),
  );
  try {
    const out = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>(
      'workspace:read',
      ctx,
      { path: tierPath },
    );
    if (!out.found) return '';
    return stripFrontmatter(new TextDecoder('utf-8').decode(out.bytes));
  } catch {
    return '';
  }
}

/**
 * Strip the leading YAML frontmatter fence (`---\n...\n---\n`) from a
 * markdown file. Returns the body text that follows, trimmed of leading
 * and trailing blank lines, with a single trailing newline.
 * If no frontmatter fence is present, returns the full text as-is.
 */
function stripFrontmatter(text: string): string {
  const FENCE = '---';
  // Must start with '---' (possibly after a BOM or leading whitespace stripped)
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(FENCE)) return text.trim();

  // Find the closing fence. Start searching after the opening fence line.
  const afterOpen = trimmed.indexOf('\n') + 1;
  const closeIdx = trimmed.indexOf(`\n${FENCE}`, afterOpen);
  if (closeIdx === -1) return text.trim();

  // Body starts after the closing fence line (skip the '\n---' + newline).
  const bodyStart = closeIdx + `\n${FENCE}`.length;
  const body = trimmed.slice(bodyStart);
  return body.trim();
}

interface AssembleInput {
  userProfileBody: string;
  recentBody: string;
  /** Memory Map body, already soft-capped to its own budget (TASK-190). */
  mapBody: string;
  docsLines: string[];
  maxTokens: number;
}

/**
 * Assemble the memory block sections under the whole-block token cap (I21).
 *
 * Sections render in fixed order: User Profile, Recent, Memory Map, Relevant
 * Documents. The DROP order (when over cap) is the reverse of section value,
 * so the highest-value content survives longest:
 *   1. Drop lowest-rank relevant-doc lines from the tail.
 *   2. Drop Memory Map entry lines from the tail (it's a derived index,
 *      re-reachable via memory_search).
 *   3. Truncate the Recent body.
 *   4. Truncate the User Profile body (last resort).
 * Always terminates; never throws. Returns '' when even a 1-char profile
 * doesn't fit (a pathologically tiny cap).
 *
 * We measure the ACTUAL assembled length at each step rather than computing
 * per-section overhead arithmetic — simpler to reason about and robust to
 * adding sections. Each truncation slices in one shot (no byte-by-byte
 * nibbling), so the cost is O(sections), not O(chars).
 */
function assembleUnderCap({
  userProfileBody,
  recentBody,
  mapBody,
  docsLines,
  maxTokens,
}: AssembleInput): string {
  const maxChars = maxTokens * 4;

  let profile = userProfileBody.trim();
  let recent = recentBody.trim();
  let map = mapBody.trim();
  const docs = [...docsLines];

  const build = (): string => buildBlock(profile, recent, map, docs);

  // Step 1: drop lowest-rank docs from the tail.
  while (docs.length > 0 && build().length > maxChars) docs.pop();
  if (build().length <= maxChars) return build();

  // Step 2: drop Memory Map entry lines from the tail (keep the heading until
  // the section is empty, then drop it entirely). `set` mutates the live `map`
  // var so the next `build()` reflects the drop.
  dropTailToFit(map, maxChars, build, (v) => { map = v; });
  if (build().length <= maxChars) return build();

  // Step 3: truncate the Recent body (single slice + '…') until the block fits.
  truncateBodyToFit(recent, maxChars, build, (v) => { recent = v; });
  if (build().length <= maxChars) return build();

  // Step 4: truncate the User Profile body as a last resort.
  truncateBodyToFit(profile, maxChars, build, (v) => { profile = v; });
  if (build().length <= maxChars) return build();

  // Cap so tight even a minimal profile doesn't fit — yield nothing.
  return '';
}

/**
 * Drop trailing newline-delimited lines from a section `body` until the whole
 * block (`build().length`) fits `maxChars`, or the section is empty. `set`
 * writes each interim value into the live assembly var so `build()` reflects it.
 */
function dropTailToFit(
  body: string,
  maxChars: number,
  build: () => string,
  set: (v: string) => void,
): void {
  if (body.trim().length === 0) return;
  const lines = body.split('\n');
  while (lines.length > 0 && build().length > maxChars) {
    lines.pop();
    // Collapse to empty once only blanks / a bare heading remain, so the whole
    // section drops rather than leaving a dangling header.
    const next = lines.join('\n').trim();
    set(next.length > 0 && next !== '#' ? next : '');
    if (next.length === 0 || next === '#') break;
  }
}

/**
 * Truncate a section `body` (single slice + '…') until the whole block fits
 * `maxChars`. Halves the kept length while still over (the '…' + section
 * overhead can tip a one-shot slice back over); clears the section if even an
 * empty body doesn't fit. Terminates in O(log len) steps. `set` writes each
 * interim value into the live assembly var so `build()` reflects it.
 */
function truncateBodyToFit(
  body: string,
  maxChars: number,
  build: () => string,
  set: (v: string) => void,
): void {
  const trimmed = body.trim();
  if (trimmed.length === 0) return;
  if (build().length <= maxChars) return;
  const overflow = build().length - maxChars;
  let keep = Math.max(0, trimmed.length - overflow - 1);
  set(keep > 0 ? trimmed.slice(0, keep) + '…' : '');
  while (keep > 0 && build().length > maxChars) {
    keep = Math.floor(keep / 2);
    set(keep > 0 ? trimmed.slice(0, keep) + '…' : '');
  }
}

/**
 * Build the markdown block from its constituent parts.
 * Omits sections whose body is empty. If all sections are empty,
 * returns ''.
 */
function buildBlock(
  userProfileBody: string,
  recentBody: string,
  mapBody: string,
  docsLines: string[],
): string {
  const parts: string[] = [];

  if (userProfileBody.trim().length > 0) {
    parts.push(`## User Profile\n\n${userProfileBody.trim()}`);
  }

  if (recentBody.trim().length > 0) {
    parts.push(`## Recent\n\n${recentBody.trim()}`);
  }

  if (mapBody.trim().length > 0) {
    parts.push(`## Memory Map\n\n${mapBody.trim()}`);
  }

  if (docsLines.length > 0) {
    parts.push(`## Relevant Documents\n\n${docsLines.join('\n')}`);
  }

  if (parts.length === 0) return '';
  return parts.join('\n\n') + '\n';
}

/**
 * Approximate token count using the 4-chars-per-token heuristic.
 * Used only for the I21 cap check — not a production tokenizer.
 */
export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Register memory-strata as the system-prompt:augment provider. */
export function registerInject(bus: HookBus): void {
  bus.registerService<
    Record<string, never>,
    { contributions: Array<{ source: string; body: string }> }
  >(
    'system-prompt:augment',
    PLUGIN_NAME,
    async (ctx, _input) => {
      try {
        const body = await buildMemoryBlock(bus, ctx, {
          workspaceRoot: ctx.workspace.rootPath,
        });
        if (body.trim().length === 0) {
          return { contributions: [] };
        }
        return {
          contributions: [{ source: PLUGIN_NAME, body }],
        };
      } catch (err) {
        ctx.logger.warn('memory_strata_inject_failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
        return { contributions: [] };
      }
    },
  );
}
