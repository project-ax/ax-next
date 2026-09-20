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
  /**
   * The short "which one" of this call — the command a `Bash` ran, the file a
   * `Write` wrote — already derived and fenced by {@link stepDetail}.
   *
   * ALREADY DERIVED is the point, and it is a capability decision (invariant
   * 5), not a style one. A tool's raw input is model-authored and this surface
   * has no renderer for it, so neither path hands the input itself to a step
   * row: each normalizer calls `stepDetail` at its own edge and passes on the
   * one bounded line that comes back. The live path keeps dropping `input` at
   * `workspace-api.ts` exactly as it did before.
   */
  detail?: string | undefined;
  status: WorkspaceStepStatus;
}

/**
 * One row in the panel: the sentence, and the state that sentence is in.
 *
 * WHY THE STATUS RIDES ALONG rather than being baked into the sentence and
 * thrown away. Until TASK-419 a row was a bare string, so a failed step and a
 * finished one reached the renderer as the same kind of thing and were drawn
 * the same way — same colour, same weight, no mark — with the difference
 * carried entirely by three trailing words in identical grey. A walk against
 * the live deployment read a step that had failed as one that had worked,
 * which is worse than an uninformative row: it is a false one.
 *
 * Everywhere else in the product a failure is `text-destructive` and a hold is
 * `text-warning` (the activity feed, chat's tool panel). The renderer cannot
 * apply those from a string without matching our own copy back out of it,
 * which would put two modules in charge of one sentence. So it gets the state.
 */
export interface WorkspaceStep {
  /** What the row says. Already named, qualified and fenced. */
  text: string;
  status: WorkspaceStepStatus;
}

/** The two fields the `steps` `ThreadMessage` variant carries. */
export interface WorkspaceStepPanel {
  /** The disclosure header. Always opens with the step COUNT — see below. */
  label: string;
  /** One row per call, in call order. `label`'s count is `steps.length`. */
  steps: WorkspaceStep[];
}

/**
 * How much of a step row — tool name, and the qualifier beside it — reaches
 * the panel.
 *
 * ONE NUMBER, AND IT IS A FENCE, NOT A LAYOUT CLAMP. There used to be two:
 * 80 for the name and 60 for the detail, sized so that a row would fit on a
 * line. That made `fenceLine` do the LAYOUT — it writes a literal `…` when it
 * cuts — and a literal `…` on this surface has two costs TASK-436 measured.
 * It is indistinguishable from an ellipsis the model actually emitted, and it
 * corrupts a copy-paste of the row. Worse, it was the only copy: nothing else
 * carried the characters it removed, so a deep path or a long command was
 * unrecoverable by any means short of the API.
 *
 * So the line is now clamped in CSS (`truncate` on the row's span, with the
 * whole string in its `title`), and this number goes back to being what it
 * always should have been: the bound on how much untrusted text crosses onto
 * the surface at all (invariant 5). "However long the MCP server felt like"
 * is not a size — the same reasoning the decision caps in
 * `routes-workspace.ts` are written to.
 *
 * WHY 200 AND NOT 400, which is what the decision/rail caps use. This one
 * still bounds untrusted text: `call.phrase` is host-authored, but
 * `call.name` is whatever an MCP server called its tool. 200 is a line's
 * worth of name with room to spare and no more.
 *
 * THE NAME AND THE QUALIFIER GET DIFFERENT NUMBERS, and they have to.
 * Collapsing them into one was the first draft of this card, and review
 * caught what it cost: see {@link STEP_DETAIL_MAX_CHARS}.
 */
export const STEP_NAME_MAX_CHARS = 200;

/**
 * How much of a call's INPUT reaches the row beside the tool name.
 *
 * SMALLER THAN THE NAME CAP ON PURPOSE, and the reason is no longer layout —
 * CSS clamps the line now, so this number governs only two things: how much
 * survives into the `title` (and therefore into a copy-paste), and how much
 * untrusted text is on the surface at all.
 *
 * Which makes it a SECURITY ceiling, because this is the model/tool-authored
 * half. Two of {@link DETAIL_KEYS} — `prompt` and `description` — hold text
 * the model wrote, and the workspace has no thinking gate (invariant J4).
 * Worse, {@link namesASecret} filters key NAMES, not values: a credential
 * arriving under an innocent name (`value`, `arg`, `data`) reaches the
 * fallback and is drawn up to this cap.
 *
 * That is why this is 120 and not 200. `fenceLine` returns a value UNCHANGED
 * when it fits, so the cap is the line between "a masked prefix" and "the
 * whole thing": most tokens in the 120–200 range stay masked at 120 and would
 * have been rendered entire at 200. 120 is `DECISION_SUMMARY_MAX_CHARS`, it
 * still holds an ordinary command and all but the deepest workspace paths,
 * and it costs roughly half the worst case that one shared number did.
 *
 * A row can therefore carry up to both caps together — name, `: `, qualifier.
 * That is the surface's real per-row budget for untrusted text; the number
 * that matters for exposure is this one, because it is the half a secret can
 * ride in on.
 */
export const STEP_DETAIL_MAX_CHARS = 120;

/**
 * What a step is called when nothing legible survives fencing — a tool name
 * made entirely of control characters, or an empty one.
 *
 * A row still appears. Dropping it would make the count disagree with what
 * happened, and "the agent ran something we cannot name" is a fact worth
 * showing; a silently shorter list is not.
 */
export const UNNAMED_STEP = 'Unnamed step';

/**
 * The input keys that answer "which one", in preference order.
 *
 * WHY A LIST AND NOT THE WHOLE OBJECT. A step row had no detail at all until
 * TASK-419, which is how a turn that ran `Bash` three times drew three rows
 * reading `Bash`, `Bash`, `Bash` — a list that reports a count and tells the
 * reader nothing else. The fix is the smallest thing that distinguishes one
 * call from the next, not the argument blob: `Write`'s input carries the whole
 * file it is writing, and a row is a line.
 *
 * The order is the order a person would ask in: what was run, then what it was
 * run on, then what was searched for or fetched. `content`-shaped keys are
 * deliberately absent — they are never the answer to "which one", and every
 * tool that has one also has a path or a command above it here.
 */
const DETAIL_KEYS = [
  'command',
  'file_path',
  'path',
  'notebook_path',
  'pattern',
  'query',
  'url',
  'title',
  'description',
  'prompt',
] as const;

/**
 * Key NAMES that must never choose a row's qualifier, whatever they hold.
 *
 * The ordered list above is safe by construction — nothing in it is a secret —
 * but the fallback takes the first string an UNKNOWN tool carries, and MCP
 * servers name their arguments whatever they like. A tool called as
 * `{ token: 'sk-live-…', resource: 'issues' }` would have drawn its row as the
 * leading {@link STEP_DETAIL_MAX_CHARS} characters of the token. That is a
 * prefix of a secret on screen, which is a worse worst case than "a less
 * useful string" — and it is why that cap is a fence and not a layout number.
 *
 * THE GUARD IS ON THE NAME, SO IT IS NOT THE WHOLE ANSWER. A secret under a
 * name this cannot recognise still reaches the fallback, which is the other
 * reason {@link STEP_DETAIL_MAX_CHARS} is kept small: the guard decides
 * WHETHER a value is drawn, the cap decides HOW MUCH of one that slipped past
 * it is.
 *
 * Matched WORD BY WORD rather than as substrings, so `apiKey`, `api_key` and
 * `AUTH_TOKEN` are all caught while `keyword`, `passenger` and `authored` are
 * not. A skipped key simply hands the choice to the next candidate; the row
 * falls back to its bare name if nothing else qualifies, which is where it was
 * before this card and is never worse than showing the secret.
 *
 * THE SMUSHED FORMS ARE ENUMERATED, and they have to be. `namesASecret` can
 * only find a boundary at a separator or a camel hump, so a delimiter-free
 * compound in one case — `apikey`, `APIKEY`, `authtoken` — stays a single
 * token and has to be in this set by name. The first review of this guard
 * caught it leaking on `apikey`: the smushed spelling of its OWN motivating
 * example, while `apiKey`, `api_key` and `API_KEY` were all handled. Measured
 * against ~50 names.
 *
 * And no, this cannot be a suffix rule instead. "Ends with `key`" would catch
 * `apikey` and also `monkey`, `donkey`, `turkey`, `hockey` and `whiskey` — the
 * `monkey` case is pinned in the tests. Enumeration is incomplete by nature
 * and a name nobody listed will get through; it is still the only rule here
 * that does not blank rows at random. **If you meet a spelling this misses,
 * add it — do not "generalise" it into a substring or suffix match.**
 *
 * ABBREVIATIONS BELONG HERE TOO. `pwd`, `pass`, `pat`, `creds` and `sig` are
 * among the commonest secret field names in the wild, and whole-word matching
 * means `pass` does NOT eat `passenger` any more than `key` eats `keyword` —
 * so the anti-substring reasoning never justified leaving them out.
 *
 * WHAT THIS DOES NOT DO, said out loud so nobody reads more into it: it filters
 * argument NAMES, not values. A secret pasted into a `Bash` command still
 * reaches the row, because `command` is exactly the thing a step row exists to
 * show and no heuristic can tell a password from an argument inside it. That is
 * the same exposure chat's tool panel has always had, to the same reader — the
 * signed-in owner of the agent, looking at their own agent's work.
 */
const SECRET_WORDS = new Set([
  // Whole words, found either alone or between separators / camel humps.
  'auth',
  'authorization',
  'bearer',
  'cred',
  'credential',
  'credentials',
  'creds',
  'jwt',
  'key',
  'keys',
  'otp',
  'pass',
  'passphrase',
  'passwd',
  'password',
  'pat',
  'pin',
  'pwd',
  'secret',
  'secrets',
  'sig',
  'signature',
  'token',
  'tokens',
  // Delimiter-free compounds, which the splitter cannot break apart. Spelled
  // in lower case because the comparison lowercases, so each of these also
  // covers its all-caps twin (`APIKEY`, `APITOKEN`).
  'accesskey',
  'accesstoken',
  'apikey',
  'apisecret',
  'apitoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'idtoken',
  'privatekey',
  'refreshtoken',
  'secretkey',
  'sessiontoken',
]);

/*
  `session` IS DELIBERATELY ABSENT, and that is a decision rather than an
  oversight. A session *token* is already covered by `token` in every spelling
  that has a boundary (`sessionToken`, `session_token`) and by `sessiontoken`
  in the one that does not. What `session` on its own would blank is
  `sessionId` / `session_id` / `sessionName` — a correlation handle, not a
  credential — and blanking those costs a real qualifier on the one surface
  whose entire job is to say which call this was. `key` and `pin` are kept
  despite the same shape (`keyName`, `pinBoard`) because the secrets they
  cover are far commoner than those two names.
*/

/**
 * Does this argument name announce a secret?
 *
 * Splits on separators AND on camel humps — `apiKey` becomes `api` + `Key` —
 * without a lookbehind, which is not something to rely on across every browser
 * this bundle runs in.
 */
function namesASecret(key: string): boolean {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .some((word) => SECRET_WORDS.has(word.toLowerCase()));
}

/**
 * One tool call's input → the short line that tells it apart, or `undefined`.
 *
 * FENCED HERE, at the edge both paths share. The value is model-authored — it
 * is whatever the model decided to put in the tool's arguments — so it gets
 * the same treatment every other untrusted string on this surface gets: one
 * line, bounded, control and bidi characters neutralised. React escapes
 * markup, so the risk was never script; it is a row that reorders or hides
 * what the reader sees, in our voice (see `fence-line.ts`).
 *
 * `undefined` rather than an empty string when nothing legible survives, so a
 * row falls back to its bare name instead of ending in a dangling separator.
 * An unnamed-key tool (`TodoWrite`, whose input is a list) lands here too, and
 * that is correct: there is no "which one" to show.
 *
 * The fallback past {@link DETAIL_KEYS} is the first string-valued key the
 * object carries, in its own order, SKIPPING any key that names a secret (see
 * {@link SECRET_WORDS}). MCP servers name their arguments whatever they like,
 * and `create_issue` called on `{ title: … }` is exactly the case a fixed list
 * cannot enumerate. Every candidate is bounded and fenced, so the worst case is
 * a row qualified by a less useful string — or by nothing at all.
 */
export function stepDetail(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const args = input as Record<string, unknown>;
  const candidate = (key: string): string | null => {
    const value = args[key];
    if (typeof value !== 'string') return null;
    // The guard runs on the ordered pass too. Nothing in DETAIL_KEYS trips it
    // today; asking here rather than only in the fallback means a key added to
    // that list later cannot quietly opt out of it.
    if (namesASecret(key)) return null;
    return fenceLine(value, STEP_DETAIL_MAX_CHARS);
  };
  for (const key of DETAIL_KEYS) {
    const fenced = candidate(key);
    if (fenced !== null) return fenced;
  }
  for (const key of Object.keys(args)) {
    const fenced = candidate(key);
    if (fenced !== null) return fenced;
  }
  return undefined;
}

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
 * One call's row: what ran, and — when we can say it — which one.
 *
 * A COLON, not the em dash. The dash is already spoken for by the status
 * suffix below, and `Bash — ls -la — in progress` makes the reader work out
 * which half is the machine's and which is ours. `Bash: ls -la — in progress`
 * reads in one pass.
 */
function stepRow(call: WorkspaceToolCall): string {
  const name = stepName(call);
  return call.detail === undefined || call.detail.length === 0
    ? name
    : `${name}: ${call.detail}`;
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
  const steps: WorkspaceStep[] = [];
  const counts = { failed: 0, waiting: 0, running: 0 };
  for (const call of calls) {
    const row = stepRow(call);
    if (call.status === 'done') {
      steps.push({ text: row, status: 'done' });
      continue;
    }
    counts[call.status] += 1;
    // The words stay, ALONGSIDE the status — a colour is not a sentence, and a
    // reader who cannot see the difference between two greys still has to be
    // told what happened.
    steps.push({
      text: `${row} — ${STATUS_SUFFIX[call.status]}`,
      status: call.status,
    });
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
  frame: {
    toolCallId: string;
    toolName: string;
    activityPhrase?: string | undefined;
    /** Already through {@link stepDetail} — see {@link WorkspaceToolCall.detail}. */
    detail?: string | undefined;
  },
): WorkspaceToolCall[] {
  const next: WorkspaceToolCall = {
    id: frame.toolCallId,
    name: frame.toolName,
    phrase: frame.activityPhrase,
    detail: frame.detail,
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
