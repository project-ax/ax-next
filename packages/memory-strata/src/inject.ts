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
import { join } from 'node:path';
import type { HookBus, AgentContext } from '@ax/core';
import { systemFile, recentFile } from './paths.js';
import { retrieve, type RetrievalResult } from './retriever.js';

const PLUGIN_NAME = '@ax/memory-strata';

/**
 * Default soft cap on the auto-injected block. Roughly 1500 tokens at
 * 4 chars/token (the standard rough estimate). I21 invariant: the block
 * never exceeds the cap; drops lowest-rank docs first, then truncates
 * recent, then truncates user profile body as a last resort.
 */
export const DEFAULT_MAX_TOKENS = 1500;

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
  /** Max approximate tokens (chars / 4). Default DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
  /** topK for retrieve(); default 3. Only used when lastUserMessage is set. */
  topK?: number;
}

/**
 * Build the auto-injected memory block for a given workspace. Contains:
 *   ## User Profile  — contents of permanent/memory/system/user.md (body only)
 *   ## Recent        — contents of permanent/memory/system/recent.md (body only)
 *   ## Relevant Documents  — only when lastUserMessage is set (retriever results)
 *
 * The returned string is bounded to approximately `maxTokens` tokens
 * (I21: default 1500, heuristic 4 chars/token). Drop strategy:
 *   1. Drop lowest-rank retrieved doc summaries first.
 *   2. Truncate ## Recent body if still over cap.
 *   3. Truncate ## User Profile body as last resort.
 *
 * Returns '' when both system files are missing (no memory seeded yet).
 */
export async function buildMemoryBlock(
  bus: HookBus,
  ctx: AgentContext,
  input: BuildMemoryBlockInput,
): Promise<string> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const topK = input.topK ?? 3;

  const userProfileBody = await readSystemBody(input.workspaceRoot, 'user');
  const recentBody = await readSystemBody(input.workspaceRoot, 'recent');

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

  return assembleUnderCap({ userProfileBody, recentBody, docsLines, maxTokens });
}

/**
 * Read the body of a system markdown file (user.md or recent.md).
 * Strips the YAML frontmatter block (--- ... ---) and returns the
 * remaining text. Returns '' when the file doesn't exist (ENOENT).
 */
async function readSystemBody(
  workspaceRoot: string,
  name: 'user' | 'recent',
): Promise<string> {
  const rel = name === 'recent' ? recentFile() : systemFile(name);
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
  docsLines: string[];
  maxTokens: number;
}

/**
 * Assemble the memory block sections under the token cap (I21).
 *
 * Algorithm:
 *   1. Try to assemble with all docs lines.
 *   2. If over cap, drop docs from the end (lowest-rank) one at a time.
 *   3. If still over with no docs left, truncate recentBody.
 *   4. If still over, truncate userProfileBody.
 *   5. Return final string (never throws — always terminates).
 *
 * Truncation uses character-based slicing (the LLM tolerates mid-sentence
 * cuts). A '…' suffix is appended to signal the truncation. Overflow is
 * computed once per iteration and the required bytes are cut in a single
 * slice rather than nibbling byte-by-byte, so the loop terminates in O(1)
 * iterations for any input size.
 */
function assembleUnderCap({
  userProfileBody,
  recentBody,
  docsLines,
  maxTokens,
}: AssembleInput): string {
  // overhead: the section header + surrounding newlines added by buildBlock.
  // We track this separately so we can compute how many body chars fit.
  const maxChars = maxTokens * 4;

  let docs = [...docsLines];

  // Step 1 & 2: drop lowest-rank docs until under cap.
  while (true) {
    const candidate = buildBlock(userProfileBody, recentBody, docs);
    if (candidate.length <= maxChars || docs.length === 0) {
      if (candidate.length <= maxChars) return candidate;
      break;
    }
    docs.pop();
  }

  // Step 3: truncate recent body (no docs remain).
  // Compute the empty-body recent block to measure overhead, then determine
  // how many body chars fit in the remaining budget.
  {
    // Block with profile only, no recent — establishes the profile overhead.
    const profileOnlyBlock = buildBlock(userProfileBody, '', []);
    const profileOnlyLen = profileOnlyBlock.length;

    // Block with profile + a 1-char recent placeholder — overhead for the
    // "## Recent" section header itself.
    const recentPlaceholder = buildBlock(userProfileBody, 'X', []);
    const recentSectionOverhead = recentPlaceholder.length - profileOnlyLen - 1; // -1 for the 'X'

    const recentBodyBudget = maxChars - profileOnlyLen - recentSectionOverhead;

    if (recentBodyBudget > 0 && recentBody.trim().length > 0) {
      const trimmedRecent = recentBody.trim();
      const truncatedRecent =
        trimmedRecent.length <= recentBodyBudget
          ? trimmedRecent
          : trimmedRecent.slice(0, recentBodyBudget - 1) + '…';
      const candidate = buildBlock(userProfileBody, truncatedRecent, []);
      if (candidate.length <= maxChars) return candidate;
      // If still over after computation, recentBodyBudget arithmetic was off
      // (e.g. multi-byte chars in '…') — fall through to step 4.
    } else if (profileOnlyLen <= maxChars) {
      // Profile-only fits; no room for recent. Return profile-only.
      return profileOnlyBlock;
    }
    // Profile alone exceeds cap — fall through to step 4.
  }

  // Step 4: truncate user profile body as last resort.
  {
    // Block with profile + 1-char placeholder — compute profile section overhead.
    const profilePlaceholder = buildBlock('X', '', []);
    const profileSectionOverhead = profilePlaceholder.length - 1; // -1 for 'X'
    const profileBodyBudget = maxChars - profileSectionOverhead;

    if (profileBodyBudget > 0) {
      const trimmedProfile = userProfileBody.trim();
      const truncatedProfile =
        trimmedProfile.length <= profileBodyBudget
          ? trimmedProfile
          : trimmedProfile.slice(0, profileBodyBudget - 1) + '…';
      const candidate = buildBlock(truncatedProfile, '', []);
      if (candidate.length <= maxChars) return candidate;
    }
    // Cap is so tight even a 1-char profile doesn't fit — return empty.
    return '';
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
  docsLines: string[],
): string {
  const parts: string[] = [];

  if (userProfileBody.trim().length > 0) {
    parts.push(`## User Profile\n\n${userProfileBody.trim()}`);
  }

  if (recentBody.trim().length > 0) {
    parts.push(`## Recent\n\n${recentBody.trim()}`);
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
