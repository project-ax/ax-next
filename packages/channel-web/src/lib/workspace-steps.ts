/**
 * workspace-steps — what the agent actually DID, shaped once for both paths.
 *
 * The workspace shows a turn twice: live, off SSE frames read in the browser,
 * and again on reload, off the stored transcript read by
 * `GET /api/workspace/agents/:id`. Until TASK-352 both showed the turn's text
 * and nothing else, so a turn that ran six tools looked identical to a turn
 * that answered from memory. This module is the producer the `steps`
 * `ThreadMessage` variant never had.
 *
 * WHY ONE MODULE AND NOT TWO PRODUCERS. The two paths start from different
 * inputs — live `tool-use` / `tool-result` frames on one side, persisted
 * `tool_use` / `tool_result` content blocks on the other — and that is exactly
 * the shape that drifts. A seam that exists only because two call sites format
 * independently is a seam nobody introduced on purpose and nobody notices for
 * months. So each path normalizes its own input into {@link WorkspaceToolCall}
 * and then BOTH call {@link shapeSteps}; the wording, the count and the status
 * ordering have one home (invariant 4).
 *
 * WHAT THAT DOES AND DOES NOT BUY, because "symmetry" claimed flatly would be
 * an overclaim. It buys the SENTENCES: no step can read one way live and
 * another way after a reload, and no second formatter exists to make it. It
 * does NOT buy the GROUPING. The SDK splits a multi-step reply into one
 * assistant turn per message and `@ax/agent-claude-sdk-runner-host`'s parser
 * deliberately does not coalesce across them, while the live wire carries no
 * message boundary at all — so reload draws one panel per assistant turn where
 * live draws one for the whole reply. That difference predates this module (a
 * reply already arrives live as one accumulating bubble and comes back as
 * several) and closing it means teaching the live path about turn boundaries.
 * `src/__tests__/workspace-steps-seam.test.tsx` pins both halves: the
 * sentences agree, the panel counts are allowed to differ.
 *
 * WHAT IS DELIBERATELY NOT HERE: thinking. The model's scratchpad does not
 * reach this surface on either path and this module has no branch for it. The
 * workspace route calls `conversations:get` UNFILTERED — chat gates reasoning
 * behind `?includeThinking=true` and the workspace has no such gate — so
 * `renderableText`'s text-blocks-only filter is the only thing keeping
 * chain-of-thought off this wire (invariant J4). Tool steps are additive to
 * that filter, never a relaxation of it.
 *
 * No React, no chat imports: the server route imports this too. That is also
 * why the relative imports below carry `.js`: this module is loaded by Node
 * (through `server/routes-workspace.ts`) as well as by the browser bundle, and
 * Node's ESM resolver does not guess extensions. Most of `lib/` is
 * browser-only and gets away without them; anything the server can reach
 * cannot. `__tests__/server-import-extensions.test.ts` checks the whole
 * server-reachable graph rather than trusting this note.
 */
import { fenceLine } from './fence-line.js';
import { stripMcpToolPrefix } from './tool-name.js';

/**
 * Where one tool call got to.
 *
 * The same four words `lib/tool-step-status.ts` classifies chat's tool parts
 * into, and the same ordering rule: **running → waiting → failed → done**. A
 * hold sits ABOVE a failure per call, because a call waiting on a person has
 * not run and has not failed, and calling a pending decision a failure tells
 * the reader the thing is over when it is in fact waiting on them.
 *
 * We restate the union rather than importing that module's classifier, for a
 * concrete reason and not a stylistic one: `toolStepStatus` resolves `waiting`
 * by looking the call id up in `tool-held.ts`'s module-global map, and the only
 * writers to that map are `lib/transport.ts` and `lib/history-adapter.ts` —
 * chat's two readers, neither of which runs on this surface. Reusing it here
 * would return `waiting` never, which is the one answer that must not be wrong.
 */
export type WorkspaceStepStatus = 'running' | 'waiting' | 'failed' | 'done';

/** One tool call, normalized out of whichever path saw it. */
export interface WorkspaceToolCall {
  /** The call id. A dedup/merge key only — never rendered. */
  id: string;
  /**
   * The tool's wire name, `mcp__<server>__` prefix and all. Stripped here, so
   * neither caller has to remember to (TASK-260/TASK-271): nobody should read
   * `mcp__linear__create_issue` on screen.
   */
  name: string;
  /**
   * The host-authored activity phrase when the producer had one. Preferred
   * over the tool name, which is why it is carried separately rather than
   * pre-resolved by the caller — resolving it in two places is how the live
   * row and the reloaded row end up reading differently.
   */
  phrase?: string | undefined;
  status: WorkspaceStepStatus;
}

/** The two fields the `steps` `ThreadMessage` variant carries. */
export interface WorkspaceStepPanel {
  /** The disclosure header. Always opens with the step COUNT — see below. */
  label: string;
  /** One line per call, in call order. `label`'s count is `steps.length`. */
  steps: string[];
}

/**
 * How much of a tool name or activity phrase reaches the panel.
 *
 * A step row is a line in a list, so it gets a line's worth. The number is a
 * size because "however long the MCP server felt like" is not a size — the
 * same reasoning the decision caps in `routes-workspace.ts` are written to.
 */
export const STEP_NAME_MAX_CHARS = 80;

/**
 * What a step is called when nothing legible survives fencing — a tool name
 * made entirely of control characters, or an empty one.
 *
 * A row still appears. Dropping it would make the count disagree with what
 * happened, and "the agent ran something we cannot name" is a fact worth
 * showing; a silently shorter list is not.
 */
export const UNNAMED_STEP = 'Unnamed step';

/** Suffixes that make a row say what state it is in, rather than implying one. */
const STATUS_SUFFIX: Record<Exclude<WorkspaceStepStatus, 'done'>, string> = {
  // "in progress", not "running": a program runs, a person's errand is in
  // progress, and this surface is written for the person.
  running: 'in progress',
  waiting: 'waiting for you',
  failed: "didn't finish",
};

/** The display name for one call: phrase first, then the stripped tool name. */
function stepName(call: WorkspaceToolCall): string {
  return (
    fenceLine(call.phrase, STEP_NAME_MAX_CHARS) ??
    fenceLine(stripMcpToolPrefix(call.name), STEP_NAME_MAX_CHARS) ??
    UNNAMED_STEP
  );
}

/**
 * The header for a panel of `total` steps.
 *
 * It ALWAYS opens with the count, and the count is always `steps.length` —
 * that is what lets a reader (and a test) check the header against the list
 * underneath it instead of taking the header's word for it.
 *
 * Then, at most one qualifier, in the order failed → waiting → running. That
 * inverts the per-call ordering at the top of this file, deliberately, and for
 * the reason TASK-335 gave chat's collapsed header: per call a hold is not a
 * failure and must not be painted as one, but across a whole panel a hold
 * already announces itself twice over (the composer's hold line, the approval
 * card) while a failure has nowhere else to go. A header that says "3 steps"
 * over a step that failed is a claim of success we did not earn.
 */
function stepsLabel(
  total: number,
  counts: { failed: number; waiting: number; running: number },
): string {
  const base = total === 1 ? '1 step' : `${total} steps`;
  // A comma, not an interpunct. The separator has to read as "and also" to
  // somebody who has never thought about typography, and a `·` reads as
  // decoration to plenty of them.
  if (counts.failed > 0) return `${base}, ${counts.failed} didn't finish`;
  if (counts.waiting > 0) return `${base}, ${counts.waiting} waiting for you`;
  if (counts.running > 0) return `${base}, ${counts.running} in progress`;
  return base;
}

/**
 * Shape a turn's tool calls into the panel both paths render, or `null` when
 * the turn ran no tools at all.
 *
 * `null` rather than an empty panel: a turn that simply answered gets a plain
 * `agent` bubble, and an empty disclosure reading "0 steps" would be a control
 * that opens onto nothing.
 */
export function shapeSteps(
  calls: readonly WorkspaceToolCall[],
): WorkspaceStepPanel | null {
  if (calls.length === 0) return null;
  const steps: string[] = [];
  const counts = { failed: 0, waiting: 0, running: 0 };
  for (const call of calls) {
    const name = stepName(call);
    if (call.status === 'done') {
      steps.push(name);
      continue;
    }
    counts[call.status] += 1;
    steps.push(`${name} — ${STATUS_SUFFIX[call.status]}`);
  }
  return { label: stepsLabel(steps.length, counts), steps };
}

/**
 * Fold a live `tool-use` frame into the calls seen so far.
 *
 * Returns a NEW array (React state), and is idempotent on the call id: a
 * replayed frame updates the row in place rather than adding a second one.
 * `sse-frames.ts` already drops duplicates at or below the seq cursor, so this
 * is the belt to that braces — the cost of being wrong here is a step list
 * that double-counts what the agent did.
 *
 * A fresh call starts `running`: the frame says it was CALLED, and nothing has
 * come back yet. That is the honest reading, and it is what makes a turn that
 * dies mid-tool show the step as running rather than silently as done.
 */
export function applyToolUse(
  calls: readonly WorkspaceToolCall[],
  frame: { toolCallId: string; toolName: string; activityPhrase?: string | undefined },
): WorkspaceToolCall[] {
  const next: WorkspaceToolCall = {
    id: frame.toolCallId,
    name: frame.toolName,
    phrase: frame.activityPhrase,
    status: 'running',
  };
  const at = calls.findIndex((c) => c.id === frame.toolCallId);
  if (at === -1) return [...calls, next];
  const merged = [...calls];
  // Keep the status already reached: a `tool-use` replayed after its result
  // must not walk the row back to `running`.
  merged[at] = { ...next, status: calls[at]!.status };
  return merged;
}

/**
 * Fold a live `tool-result` frame into the calls seen so far.
 *
 * A result for a call we never saw is DROPPED, not synthesized into a row:
 * with no `tool-use` there is no name, and an `Unnamed step` invented from a
 * frame we are missing half of claims more than we know. The seq gap that
 * would cause it is already surfaced as a lost-stream banner.
 *
 * SAY THE ASYMMETRY OUT LOUD: the reload path's `toolOutcomes` is built across
 * every turn before any of them is shaped, so it is order-independent and
 * would show that same call as finished. This is the one input where the two
 * normalizers can disagree. It is not reachable over a healthy wire — a result
 * always follows its own call, and `sse-frames.ts` refuses a stream with a
 * hole in it — so the honest reading of a result with no call is "we are
 * missing frames", which is a banner, not a row.
 *
 * The status ordering is `tool-step-status.ts`'s, held above failed — see
 * {@link WorkspaceStepStatus}. A held result arrives with `isError` omitted,
 * but a row carrying both must still read as waiting.
 */
export function applyToolResult(
  calls: readonly WorkspaceToolCall[],
  frame: { toolCallId: string; isError?: boolean | undefined; held?: boolean | undefined },
): WorkspaceToolCall[] {
  const at = calls.findIndex((c) => c.id === frame.toolCallId);
  if (at === -1) return [...calls];
  const status: WorkspaceStepStatus =
    frame.held === true ? 'waiting' : frame.isError === true ? 'failed' : 'done';
  const merged = [...calls];
  merged[at] = { ...calls[at]!, status };
  return merged;
}
