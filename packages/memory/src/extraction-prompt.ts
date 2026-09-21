import { createHash } from 'node:crypto';

/**
 * The extraction prompt, carried VERBATIM from dem-memory
 * (`dem-memory/src/engine/retain.ts`). Design §3.0.
 *
 * ## Why it is copied rather than imported
 *
 * `dem-memory/` is a research tree committed to this repo, not a workspace
 * package: it has its own `package-lock.json`, is absent from
 * `pnpm-workspace.yaml`, and nothing under `packages/` depends on it.
 * Copying is the only way to carry it, and the fingerprint test in
 * `src/__tests__/extraction-prompt.test.ts` is what keeps the copy honest —
 * it fails the moment either side is reworded.
 *
 * ## Why it may not be touched
 *
 * MEASURED: the extractor is worth ~57 points (gpt-4.1-nano 26.0% vs
 * glm-5.3-flash 83-88% on identical questions and answerer) while the
 * answerer is worth ~nothing (McNemar p=1.000). The assistant-content
 * contract inside it moved single-session-assistant 45.5 -> 81.8 in BOTH
 * answer arms. Rewording it invalidates every number the design rests on and
 * makes the normalizer's effect (TASK-489) unmeasurable in isolation.
 *
 * So: do not reword it, do not "improve" it, do not reformat it.
 *
 * ## The fingerprint is `e7466bf4`/`06414f62`, NOT `f4752a79`
 *
 * The epic's cards and `docs/plans/2026-09-18-dem-first-memory-design.md`
 * §3.0 both name the pinned prompt `f4752a79`. MEASURED over
 * `dem-memory/src/engine/retain.ts` at `3fae262e`, it is not: the prompt as
 * it stands fingerprints `e7466bf4` prompt-only and `06414f62` prompt+model.
 *
 * `f4752a79` names the generation BEFORE the 2026-09-17 removal of
 * `confidence` from the schema, tuple, DB column, extraction prompt, evidence
 * table and CLI — a removal recorded in `.claude/memory/context.md` and
 * `.claude/memory/decisions.md` as having deliberately re-keyed the cache
 * `f4752a79` -> `06414f62`, accepted because no code ever branched on the
 * field.
 *
 * Carrying the prompt verbatim and pinning it at `f4752a79` are therefore
 * mutually exclusive, and this file chooses VERBATIM: the living prompt in
 * `dem-memory` is the thing the design says not to change, and a fingerprint
 * is only a label for it. Pinning the label over the text would have meant
 * re-introducing a deliberately-deleted line to make a hash match.
 */

/**
 * The extraction contract.
 *
 * The assistant-content half is not decoration. At n=100 the weak type was
 * single-session-assistant (45.5%, identical in both answer arms), and dumping
 * what actually reached the table showed the right session's facts ranked 1-7
 * in five of six failures with the asked-for detail compressed out of them.
 * The instruction that did it was "Keep objects concise: a phrase, a value, or
 * an outcome" — do not reintroduce it.
 */
export const EXTRACTION_SYSTEM_PROMPT = [
  "You are a memory-extraction engine. You convert dialogue transcripts into discrete relational facts.",
  "",
  "Extract TWO kinds of fact, in both directions.",
  "",
  "1. USER facts — what the user told you: preferences, decisions, deadlines, identities, project",
  "   state, and events in their life.",
  "2. ASSISTANT facts — substantive content YOU (the assistant) supplied that the user may later ask",
  "   you to recall: recommendations, named places/titles/products/handles, specific values and",
  "   numbers, schedules and tables, and lists you gave them. These are the ones memory systems drop,",
  "   and dropping them is what makes \"what did you recommend?\" unanswerable a month later.",
  "",
  "Shape:",
  "- Each fact is a triple — subject, predicate, object — plus a network and a date.",
  "- Canonicalize subjects to snake_case entity identifiers (e.g. sam, postgres_database). Use the",
  "  subject `assistant` for a fact about what the assistant itself said, did, or supplied.",
  "- Normalize predicates to snake_case relationships or properties (e.g. prefers_backend, works_at,",
  "  recommended, listed, stated, provided_solution).",
  "- The object is FREE TEXT, written exactly as it should be read back. Do not convert it to",
  "  snake_case, and do not compress away the part that makes it worth remembering.",
  "",
  "Rules for ASSISTANT facts:",
  "- Keep the specifics. The point is the detail — the name, the number, the handle, the measurement,",
  "  the step — not the topic. \"assistant | suggested_projects | some DIY decor ideas\" is worthless;",
  "  \"assistant | recommended_sealant | Mod Podge or another sealant, to seal the newspaper flower",
  "  vase\" is the fact.",
  "- Keep a list, table, schedule, or sequence whole and in order, as ONE fact that preserves the",
  "  original order and item count — the user may ask which item was 7th, or what Admon's Sunday row",
  "  said. Do not split it into one fact per item. Past 10 items, record the first 10 and state the",
  "  total count.",
  "- Copy verbatim strings exactly as written: handles (@name_here), identifiers, code, URLs, file",
  "  paths, chord and note sequences. Never re-space, re-case, or tidy them.",
  "- No speculation. Skip anything the assistant hedged, guessed at, or flagged as uncertain",
  "  (\"might be\", \"possibly\", \"I'm not sure\"). Memory must not turn a guess into a fact.",
  "- No echoes. If the assistant merely repeated something the user said, record it once, as a user fact.",
  "- Be selective: at most 5 assistant facts per transcript, each object under 400 characters. Skip",
  "  generic advice, pleasantries, and anything the user could trivially re-derive.",
  "",
  "Rules for every fact:",
  "- Classify each fact:",
  "  - world: objective, verifiable assertions about external entities or domain rules.",
  "  - experience: first-person records of user interactions, and of what the assistant did, said,",
  "    recommended, or supplied.",
  "  - opinion: subjective beliefs or inferred user preferences.",
  "- validStart: ISO-8601 UTC date-time marking when the statement became true. Use dialogue timestamps",
  "  when present; otherwise use the current time provided in the prompt. Never output a future time.",
  "- invalidatesPrevious: true only when this fact updates or supersedes a prior state that would share",
  "  the same subject and predicate (e.g. a changed preference, a moved location, a completed migration).",
  "- Extract only durable, memory-worthy facts. No small talk. No duplicates.",
].join("\n");

/**
 * The per-batch user message. `now` is the extractor's clock; `dialogue` is
 * the filtered transcript (see `transcript.ts` — user and assistant turns
 * only, string content only).
 */
export function buildExtractionPrompt(dialogue: string, now: string): string {
  return [
    `Current time: ${now}`,
    "",
    "Reply with ONLY a JSON object of exactly this shape (no prose, no code fences):",
    '{"facts": [{"network": "world" | "experience" | "opinion", "subject": "<snake_case entity>", "predicate": "<snake_case relation>", "object": "<concise statement>", "validStart": "<ISO-8601 UTC date-time>", "invalidatesPrevious": <true|false>}]}',
    "",
    "Dialogue transcript:",
    dialogue,
  ].join("\n");
}

/**
 * What the fingerprint is computed OVER — dem-memory's own `promptShape()`
 * (`dem-memory/bench/extraction.ts`), reproduced exactly: the system prompt
 * concatenated with the user prompt built over an empty dialogue and an empty
 * clock, so only the FIXED text is hashed and no per-batch content leaks in.
 */
export function extractionPromptShape(): string {
  return EXTRACTION_SYSTEM_PROMPT + buildExtractionPrompt('', '');
}

/**
 * dem-memory's `extractionFingerprint`, reproduced. Called with no model it
 * is the prompt-only fingerprint; with one it is the cache key's.
 */
export function extractionFingerprint(model?: string): string {
  const hash = createHash('sha1').update(extractionPromptShape());
  if (model !== undefined) hash.update(model);
  return hash.digest('hex').slice(0, 8);
}

/**
 * The prompt-only fingerprint of {@link extractionPromptShape}, measured at
 * `3fae262e`. Pinned by test; see the file header for why this is `e7466bf4`
 * and not the `f4752a79` the design doc names.
 */
export const EXTRACTION_PROMPT_FINGERPRINT = 'e7466bf4';

/**
 * The bare model id the cache fingerprint is measured with (dem-memory's
 * `DEFAULT_EXTRACT_MODEL`). NOT a `provider/model-id` ref — see
 * `DEFAULT_MEMORY_OPS_MODEL` in `observer.ts` for the routed form.
 */
export const EXTRACTION_MODEL_ID = 'z-ai/glm-5.3-flash:nitro';

/**
 * The prompt+model fingerprint under {@link EXTRACTION_MODEL_ID} — the key
 * dem-memory's extraction cache is written under, so facts produced here are
 * addressable by the same string the bench uses.
 */
export const EXTRACTION_PROMPT_MODEL_FINGERPRINT = '06414f62';
