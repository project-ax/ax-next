import type { LlmCallInput, LlmCallOutput } from '@ax/core';

import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './extraction-prompt.js';
import type { MemoryStatementKind } from './types.js';

/** The `llm:call:<provider>` round trip, narrowed to what extraction needs. */
export type LlmCallFn = (input: LlmCallInput) => Promise<LlmCallOutput>;

/**
 * One fact as the extractor emits it, after validation.
 *
 * The four fields the store reads, plus the one it now carries. The prompt
 * also asks for `invalidatesPrevious`, which is deliberately DROPPED rather
 * than carried:
 *
 * - `network` is design §3.1's `kind`. It is PASSED THROUGH, validated rather
 *   than consumed: `FactStatementInput` carries `kind` and the engine stores
 *   it verbatim, so a supported value survives to `memory:recall` and an
 *   absent one stays absent. A present-but-unrecognized value is a parse
 *   problem — see `parseFacts`, which marks the fact unusable rather than
 *   storing a kind nobody can name. See `MemoryStatementKind` in `types.ts`.
 * - `invalidatesPrevious` is DEM's supersession flag, and design §3.3 lists
 *   it under "Not built": MEASURED over 130,779 facts it fails in both
 *   directions (91.8% of flags find no exact prior; the ones that match close
 *   up to 622 rows on one statement). Slot closure replaces it, and slot
 *   derivation is TASK-489's, not this card's.
 */
export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  validStart: string;
  kind?: MemoryStatementKind;
}

export type ExtractionResult =
  | { kind: 'facts'; facts: ExtractedFact[]; retried: boolean }
  /** Both attempts failed the schema. The batch is dropped; the caller emits the event. */
  | { kind: 'schema-failure'; detail: string; retried: true };

/** How many tokens an extraction may emit. */
const MAX_EXTRACTION_TOKENS = 4096;

const KNOWLEDGE_KINDS: readonly MemoryStatementKind[] = [
  'world',
  'experience',
  'observation',
  'opinion',
];

/**
 * Low but not zero. The prompt asks for a strict JSON shape and a verbatim
 * copy of handles, identifiers and note sequences; sampling noise on this job
 * buys nothing and costs schema compliance.
 */
const EXTRACTION_TEMPERATURE = 0.2;

/**
 * Run one extraction over a dialogue, with ONE schema-echo retry.
 *
 * Design §3.5: "Extraction schema failure -> one retry with the schema echoed
 * (the bench already does this), then drop the batch with an event." The
 * retry earns its keep on a SYSTEMATIC mistake — dem-memory measured
 * gpt-4.1-nano reading the prompt's "USER facts / ASSISTANT facts" framing as
 * if it named the `network` enum and emitting `network: "user"` on every
 * fact; told only that something was invalid it reproduces the same output,
 * so the repair message names what was wrong.
 *
 * Exactly one retry, never a loop: a model that is confidently wrong twice
 * will be wrong a third time, and this runs on every turn.
 */
export async function extractFacts(input: {
  llmCall: LlmCallFn;
  dialogue: string;
  now: string;
  model: string;
}): Promise<ExtractionResult> {
  const first = await callExtractor(input, buildExtractionPrompt(input.dialogue, input.now));
  const parsedFirst = parseFacts(first.text);
  if (parsedFirst.ok) {
    return { kind: 'facts', facts: parsedFirst.facts, retried: false };
  }

  const second = await callExtractor(
    input,
    buildRepairPrompt({
      dialogue: input.dialogue,
      now: input.now,
      previous: first.text,
      detail: parsedFirst.detail,
    }),
  );
  const parsedSecond = parseFacts(second.text);
  if (parsedSecond.ok) {
    return { kind: 'facts', facts: parsedSecond.facts, retried: true };
  }
  return { kind: 'schema-failure', detail: parsedSecond.detail, retried: true };
}

async function callExtractor(
  input: { llmCall: LlmCallFn; model: string },
  userPrompt: string,
): Promise<LlmCallOutput> {
  const out = await input.llmCall({
    model: input.model,
    maxTokens: MAX_EXTRACTION_TOKENS,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: EXTRACTION_TEMPERATURE,
  });
  // `== null`, not `=== undefined`: `HookBus.call` returns a handler's RAW
  // value when the hook declares no `returns` schema, so a provider resolving
  // to `null` arrives intact and a `=== undefined` check is FALSE for it.
  // TASK-434 shipped that bug and one misconfigured provider became a
  // deployment-wide write outage.
  if (out == null || typeof out.text !== 'string') {
    throw new Error('llm:call returned no text for the extraction request');
  }
  return out;
}

/**
 * The repair prompt. NOT part of the pinned prompt — it is a second message
 * sent only after a schema failure, so it cannot move the fingerprint and
 * cannot change what a first-attempt extraction sees.
 */
export function buildRepairPrompt(input: {
  dialogue: string;
  now: string;
  previous: string;
  detail: string;
}): string {
  return [
    buildExtractionPrompt(input.dialogue, input.now),
    '',
    'Your previous reply did not match the required shape. What was wrong with it:',
    input.detail,
    '',
    'Note: `network` is the KIND OF KNOWLEDGE, not the speaker. It is always exactly one of',
    '"world", "experience", or "opinion" — never "user" or "assistant". Record the speaker in',
    '`subject` instead (use the subject `assistant` for what the assistant said or supplied).',
    'Every fact needs a non-empty string subject, predicate, object, and validStart.',
    '',
    'Your previous reply (first 600 chars):',
    input.previous.slice(0, 600),
    '',
    'Reply again with ONLY the corrected JSON object.',
  ].join('\n');
}

type ParseOutcome =
  | { ok: true; facts: ExtractedFact[] }
  | { ok: false; detail: string };

/**
 * Model text -> validated facts.
 *
 * ## The mapper IS the validator
 *
 * There is no "parse then map" split here on purpose. A bare field-copy over
 * unchecked model output produces statement-shaped objects full of
 * `undefined`s, which render downstream as real-but-blank memories rather
 * than failing visibly — the defect a review pass caught on TASK-488's array
 * guard, one level down. Validating INSIDE the mapper means no call site can
 * map-and-forget.
 *
 * ## Which fields are required, and why it is not dem-memory's zod schema
 *
 * dem-memory's `ExtractedFactSchema` also requires `network` (enum) and
 * `invalidatesPrevious` (boolean). `invalidatesPrevious` stays dead HERE —
 * see {@link ExtractedFact}. `network` now has somewhere to go, so it is
 * VALIDATED when present (a kind we cannot name is a fact we will not store)
 * but not REQUIRED: an absent `network` stays compatible with extractors that
 * never emit one. Everything the store reads IS validated, and a failure is a
 * batch-level schema failure (one retry) rather
 * than a per-element drop, matching dem's behaviour: an element-level mistake
 * out of a model is almost always systematic, and the retry is what fixes a
 * systematic mistake.
 *
 * `validStart` is checked here only for STRING-ness. Whether the string is a
 * readable instant is settled per-element in `observer.ts`, exactly as
 * dem-memory splits it (`zod` checks the type, `normalizeTimestamp` checks
 * the value) — because one unreadable date out of a model must not cost a
 * whole batch, and dem measured that case in the wild ("135-01-01T00:00:00Z"
 * out of GLM).
 */
export function parseFacts(text: string): ParseOutcome {
  const decoded = decodeJsonObject(text);
  if (decoded === undefined) {
    return {
      ok: false,
      detail:
        'the reply was not a JSON object at all (it must start with { and contain a "facts" array)',
    };
  }
  // A missing `facts` array is MALFORMED and must reach the retry. Treating
  // it as an empty extraction would be a clean no-op with no retry and no
  // event — a silent nothing-was-remembered.
  const raw: unknown = (decoded as { facts?: unknown }).facts;
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      detail: `facts: expected an array of facts at the top level, received ${describeShape(raw)}`,
    };
  }

  const facts: ExtractedFact[] = [];
  // Distinct complaints, collapsed with a count so one systematic mistake
  // across 30 facts costs one line rather than 30.
  const problems = new Map<string, number>();
  const note = (message: string): void => {
    problems.set(message, (problems.get(message) ?? 0) + 1);
  };

  for (const element of raw) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      note(`facts[]: expected an object, received ${describeShape(element)}`);
      continue;
    }
    const record = element as Record<string, unknown>;
    const fields: Partial<ExtractedFact> = {};
    let usable = true;
    for (const field of ['subject', 'predicate', 'object', 'validStart'] as const) {
      const value = record[field];
      if (typeof value !== 'string' || value.trim() === '') {
        note(`facts[].${field}: expected a non-empty string, received ${describeShape(value)}`);
        usable = false;
        continue;
      }
      fields[field] = value;
    }
    if (
      record.network !== undefined &&
      !KNOWLEDGE_KINDS.includes(record.network as MemoryStatementKind)
    ) {
      note('facts[].network: expected a supported knowledge kind');
      usable = false;
    }
    if (!usable) continue;
    facts.push({
      subject: fields.subject!,
      predicate: fields.predicate!,
      object: fields.object!,
      validStart: fields.validStart!,
      ...(typeof record.network === 'string'
        ? { kind: record.network as MemoryStatementKind }
        : {}),
    });
  }

  if (problems.size > 0) {
    return {
      ok: false,
      detail: [...problems.entries()]
        .map(([message, count]) => (count > 1 ? `${message} (${count} facts)` : message))
        .slice(0, 5)
        .join('\n'),
    };
  }
  return { ok: true, facts };
}

/**
 * Strict `JSON.parse` first; then, for a model that wrapped its JSON in
 * prose or a code fence, the outermost `{`…`}`. Nothing more clever: a
 * salvage pass that reassembles a truncated object would be guessing at what
 * the model meant, and the retry is the honest answer to a truncated reply.
 */
function decodeJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const attempt = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const direct = attempt(trimmed);
  if (direct !== undefined) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return attempt(trimmed.slice(start, end + 1));
}

/**
 * A short, SAFE description of a value's shape for a repair message.
 *
 * Shape, never the value. The `detail` this builds goes to TWO sinks — back
 * into a model prompt (`buildRepairPrompt`) and into the observer's failure
 * log — so echoing a string's contents here would be a second injection
 * channel wearing an error message's clothes. The one place the reply text IS
 * echoed is `buildRepairPrompt`'s explicit, length-capped "your previous
 * reply" block, where it is labelled as such.
 *
 * ⚠ **Object KEY NAMES are model-chosen**, which is the one place a value
 * could sneak into a "shape" description: a reply of
 * `{"facts": {"IGNORE PREVIOUS INSTRUCTIONS AND …": 1}}` would otherwise put
 * that sentence in both sinks. Hence {@link safeKey} — the key is truncated
 * and reduced to an identifier-ish charset, which is all a key name has to be
 * for the diagnostic to do its job.
 */
function describeShape(raw: unknown): string {
  if (raw === null || raw === undefined) return String(raw);
  if (Array.isArray(raw)) return `an array of ${raw.length}`;
  if (typeof raw === 'object') {
    const keys = Object.keys(raw as Record<string, unknown>);
    return keys.length > 0
      ? `an object with keys ${keys.slice(0, 5).map(safeKey).join(', ')}`
      : 'an empty object';
  }
  return typeof raw;
}

/**
 * A model-chosen key name, reduced to something that cannot carry a sentence.
 *
 * Everything outside `[A-Za-z0-9_.-]` becomes `?` — so whitespace, newlines
 * and punctuation all collapse — and the result is capped at 32 characters.
 * A real field name (`subject`, `validStart`, `network`) survives unchanged,
 * which is the only case the diagnostic exists for.
 */
function safeKey(key: string): string {
  const reduced = key.replace(/[^A-Za-z0-9_.-]/g, '?');
  return reduced.length > 32 ? `${reduced.slice(0, 32)}…` : reduced;
}
