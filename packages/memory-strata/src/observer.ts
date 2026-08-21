import type { AgentMessage, LlmCallInput, LlmCallOutput } from '@ax/core';
import { writeInboxObservation } from './inbox-store.js';
import { filterSensitive, type RejectionKind } from './sensitive-gate.js';
import { raceTimeout, TimeoutError } from './timeout.js';
import type { Observation } from './types.js';

// Observer (design § "1. Observer"). Pure async function on
// (transcript, llmCall, fsWriter, now). The plugin wires this up
// behind a chat:end subscriber; the Observer itself doesn't know
// about the bus, which makes it test-driveable without a HookBus.

export type LlmCallFn = (input: LlmCallInput) => Promise<LlmCallOutput>;

export interface RunObserverInput {
  messages: AgentMessage[];
  llmCall: LlmCallFn;
  /** Absolute path to the agent's workspace root. */
  workspaceRoot: string;
  /** Current time. Injected for deterministic tests. */
  now: Date;
  /**
   * Hard deadline for the LLM call. Per I6, exceeding this drops the run
   * cleanly with no inbox writes — we'd rather lose an observation than
   * block the next turn behind a slow extraction.
   */
  timeoutMs: number;
  /** Model id passed verbatim to `llm:call:*`'s `model` field. */
  model: string;
  /**
   * Durable id of the conversation these messages belong to
   * (`AgentContext.conversationId`). Stamped onto every written inbox
   * observation so the Consolidator can later count DISTINCT conversations
   * for the skill-crystallization recurrence gate (TASK-187). Undefined when
   * the turn had no conversation (canary/ephemeral contexts) — those
   * observations carry no conversation id and contribute nothing to recurrence.
   */
  conversationId?: string | undefined;
  /**
   * Optional logger sink for `late` audit lines. Defaults to a no-op.
   * The plugin wires this to `ctx.logger.warn`.
   */
  onLate?: (info: { reason: string; timeoutMs: number }) => void;
}

export interface ObservationWritten {
  /** Inbox path written, relative to workspaceRoot. */
  path: string;
  observation: Observation;
}

export interface RejectedObservation {
  observation: Observation;
  kinds: RejectionKind[];
}

export type RunObserverResult =
  | { kind: 'skipped'; reason: 'no-user-content' }
  | { kind: 'timeout' }
  | { kind: 'parse-error'; rawLength: number }
  | {
      kind: 'written';
      written: ObservationWritten[];
      rejected: RejectedObservation[];
      /**
       * Set when the model's JSON array was truncated (max_tokens) and we kept
       * the complete objects instead of losing the whole batch. Surfaced so a
       * production truncation shows up as a log line rather than as a silent
       * quality drop — see plugin.ts's observer audit log.
       */
      salvagedFromTruncation?: true;
    };

// Exported so a test can assert the assistant-content contract survives future
// edits. The BEHAVIORAL check — does Haiku actually comply? — is
// test/bench/repro-extract.ts against real transcripts; a stub can't prove it.
export const EXTRACTION_PROMPT_SYSTEM = `\
You extract durable, atomic facts from chat transcripts for a memory system. \
A "durable" fact is one likely to still matter a week from now. Skip small talk, \
greetings, and ephemeral acknowledgments. Each fact must be a single sentence. \
Assign a subject (the entity the fact is about, or "general"), a factType, and a \
confidence between 0 and 1.

Extract TWO kinds of fact.

1. USER facts — what the user told you: preferences, decisions, deadlines, \
identities, project state. factType: entity, preference, decision, episode, or general.

2. ASSISTANT facts — substantive content YOU (the assistant) provided that the user \
may later ask you to recall: recommendations, named places/titles/products, specific \
values and numbers, and lists you gave them. factType: answer.

Rules for ASSISTANT facts:
- Attribute them. Write from the assistant's side, starting with "The assistant" \
(recommended / listed / stated / explained). Never merge what the assistant said \
with what the user said — recording the wrong speaker is worse than recording nothing.
- Keep a list whole and in order. Store a numbered or bulleted list the assistant \
gave as ONE fact that preserves the original order and item count, e.g. "The \
assistant listed 10 work-from-home jobs for seniors: 1. Virtual assistant, 2. \
Bookkeeper, ... 7. Transcriptionist, ...". Do NOT split it into one fact per item — \
the user may ask which item was 7th. If a list runs longer than 10 items, record the \
first 10 and state the total count.
- Keep the specifics. The point is the detail — the name, the number, the color, the \
process — not the topic. "The assistant discussed dinosaur illustrations" is useless; \
"The assistant said the Plesiosaur in the image had a blue scaly body" is the fact.
- No speculation. Skip anything the assistant hedged, guessed at, or flagged as \
uncertain ("might be", "possibly", "I'm not sure"). Memory must not turn a guess into \
a fact.
- No echoes. If the assistant merely repeated something the user said, record it once, \
as a USER fact.
- Be selective: at most 5 assistant facts per transcript, each under 400 characters. \
Skip generic advice, pleasantries, and anything the user could trivially re-derive.

Give an assistant fact the SAME subject as the related user fact (the topic they were \
talking about), so both are stored together.

Respond with ONLY a JSON array, no prose, no markdown fences:
[{ "fact": string, "subject": string, "factType": string, "confidence": number }]

If nothing durable is in the transcript, respond with [].`;

// Raised 1024 → 2048 (2026-07-29) alongside assistant-content extraction. A
// session now emits both user facts and assistant facts — and an assistant fact
// can be a whole enumerated list in one sentence — so 1024 puts real sessions on
// the truncation cliff, where a cut-off array used to lose EVERY fact in the
// session. Cost is only actually-emitted output tokens (Haiku, $5/M out).
const MAX_EXTRACTION_TOKENS = 2048;
const OBSERVER_TEMPERATURE = 0.2;

export async function runObserver(input: RunObserverInput): Promise<RunObserverResult> {
  const userContent = input.messages.some((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!userContent) {
    return { kind: 'skipped', reason: 'no-user-content' };
  }

  const userPrompt = formatTranscript(input.messages);

  // Bound the LLM call. The hook surface doesn't carry an AbortSignal
  // (LlmCallInput is { model, maxTokens, system, messages, temperature }
  // — no signal field), so we race a setTimeout. The slow LLM call
  // continues in the background and its eventual result is discarded.
  // Phase 2 should add `signal` to LlmCallInput so we can actually cancel
  // the round-trip; Phase 1 just bounds the wait.
  let raced: LlmCallOutput;
  try {
    raced = await raceTimeout(
      input.llmCall({
        model: input.model,
        maxTokens: MAX_EXTRACTION_TOKENS,
        system: EXTRACTION_PROMPT_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: OBSERVER_TEMPERATURE,
      }),
      input.timeoutMs,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      input.onLate?.({ reason: 'observer-llm-timeout', timeoutMs: input.timeoutMs });
      return { kind: 'timeout' };
    }
    throw err;
  }

  const parsed = parseObservations(raced.text);
  if (parsed === null) {
    return { kind: 'parse-error', rawLength: raced.text.length };
  }
  const candidates = parsed.observations;

  const written: ObservationWritten[] = [];
  const rejected: RejectedObservation[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const obs = candidates[i]!;
    // Gate BOTH fact and subject through the sensitive-content filter (I7).
    // `subject` is LLM-chosen — unvalidated model output, same trust level as
    // `fact` — and it doesn't stay quarantined in the inbox: it's written
    // verbatim into the frontmatter, carried onto the promoted doc, and
    // rendered into system/recent.md, which gets injected into every future
    // turn. A credential-shaped subject that only the `fact` gate covered
    // would round-trip straight back into context — the exact automatic-exfil
    // channel this gate exists to close. Per CLAUDE.md invariant 5, untrusted
    // content stays untrusted at every hop; mirrors the same fix already
    // applied to the agent-authored path in tools/memory-note.ts (I20).
    const factGate = filterSensitive(obs.fact);
    const subjectGate = filterSensitive(obs.subject);
    if (!factGate.kept || !subjectGate.kept) {
      // Merge + dedupe kinds across both gates, first-seen order (fact first)
      // — a caller sees each distinct kind once, never which field it came from.
      const seen = new Set<string>();
      const kinds: RejectionKind[] = [];
      for (const r of [...factGate.rejections, ...subjectGate.rejections]) {
        if (!seen.has(r.kind)) {
          seen.add(r.kind);
          kinds.push(r.kind);
        }
      }
      rejected.push({ observation: obs, kinds });
      continue;
    }
    const path = await writeInboxObservation(
      input.workspaceRoot,
      obs,
      input.now,
      i,
      input.messages.length,
      input.conversationId,
    );
    written.push({ path, observation: obs });
  }

  return {
    kind: 'written',
    written,
    rejected,
    ...(parsed.salvaged ? { salvagedFromTruncation: true as const } : {}),
  };
}

function formatTranscript(messages: AgentMessage[]): string {
  const lines = messages.map((m) => `${m.role}: ${m.content}`);
  return `Transcript:\n\n${lines.join('\n\n')}`;
}

interface ParsedObservations {
  observations: Observation[];
  /** True when the input was a truncated array and complete objects were recovered. */
  salvaged: boolean;
}

function parseObservations(text: string): ParsedObservations | null {
  // The LLM should return raw JSON. Be defensive, in three escalating steps:
  //   1. strict JSON.parse
  //   2. hunt for a top-level array (model wrapped it in prose)
  //   3. salvage complete objects from a TRUNCATED array (max_tokens cut it
  //      mid-object) — otherwise one over-long extraction loses every fact in
  //      the session, user facts included.
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        parsed = undefined;
      }
    }
    if (parsed === undefined) {
      const salvaged = salvageTruncatedArray(trimmed);
      if (salvaged === null) return null;
      const observations = coerceObservations(salvaged);
      return observations.length > 0 ? { observations, salvaged: true } : null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  return { observations: coerceObservations(parsed), salvaged: false };
}

/**
 * Recover the complete top-level objects from a JSON array cut off mid-object.
 *
 * Scans for balanced `{…}` spans, tracking string state so a brace inside a fact
 * string (or an escaped quote) doesn't throw off the depth count. The trailing
 * partial object is simply never closed, so it's dropped. Returns null when no
 * complete object survives.
 */
function salvageTruncatedArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  const out: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth += 1; continue; }
    if (ch === '}') {
      // Floor at 0 (review fix): an unmatched stray '}' before the first '{'
      // would otherwise drive depth negative permanently, so `depth === 0` below
      // never fires again and every later complete object is silently dropped.
      depth = Math.max(0, depth - 1);
      if (depth === 0 && objStart !== -1) {
        try {
          out.push(JSON.parse(text.slice(objStart, i + 1)));
        } catch {
          // A malformed complete-looking span: skip it, keep scanning.
        }
        objStart = -1;
      }
    }
  }
  return out.length > 0 ? out : null;
}

/** Coerce a parsed array into Observations, defensively (unchanged semantics). */
function coerceObservations(parsed: unknown[]): Observation[] {
  const out: Observation[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const fact = typeof r['fact'] === 'string' ? (r['fact'] as string).trim() : '';
    if (fact === '') continue;
    const subject = typeof r['subject'] === 'string' ? (r['subject'] as string) : 'general';
    const factTypeRaw = typeof r['factType'] === 'string' ? (r['factType'] as string) : 'general';
    const factType = (
      ['entity', 'preference', 'decision', 'episode', 'answer', 'general'].includes(factTypeRaw)
        ? factTypeRaw
        : 'general'
    ) as Observation['factType'];
    const confRaw = r['confidence'];
    const confidence =
      typeof confRaw === 'number' && Number.isFinite(confRaw)
        ? Math.max(0, Math.min(1, confRaw))
        : 0.5;
    out.push({ fact, subject, factType, confidence });
  }
  return out;
}


