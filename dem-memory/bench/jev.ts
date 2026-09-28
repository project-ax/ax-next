/**
 * A small client for OpenRouter's Decisions API, and the slot question the Jev arm of the
 * normalizer eval asks through it.
 *
 * Jev (`typesafe/jev-1.13`) is a decision model: it answers typed questions (`noul` / `choice`
 * / `score`) with a probability distribution instead of text, so `llm.ts` — a
 * `/chat/completions` client — cannot call it. The schema below was taken from the live
 * reference (`docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request`)
 * on 2026-09-28 and confirmed with one real call before any of this was written:
 *
 *   POST https://openrouter.ai/api/alpha/decisions
 *   { model, state, questions: { <id>: { type: "choice", instructions, criteria: {opt: why} } } }
 *   -> { id, model, provider,
 *        answers: { <id>: { type: "choice", choice, confidence?, probabilities?: {opt: p} } },
 *        usage: { input_tokens, output_tokens, cost? } }
 *
 * Two properties of the response the parser has to tolerate rather than assert:
 *  - `probabilities` are ROUNDED to two places, so they need not sum to exactly 1 (a known
 *    report against Effect's decision-model client rejects Jev for exactly that);
 *  - `confidence` is how concentrated the distribution is, NOT the chosen option's
 *    probability — `{name: 0.93}` came back with `confidence: 0.91`. The threshold here reads
 *    the chosen option's probability, which is the number that means "how sure that it is
 *    THIS slot", and falls back to `confidence` only when `probabilities` is absent.
 *
 * Everything that decides anything is a pure function and is pinned by `tests/jev.test.ts`;
 * the network, the cache and the spend meter are the only impure parts.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SLOTS, SLOT_DESCRIPTIONS, SLOT_SYNONYMS, relationToWords, type Slot } from "../src/slots.js";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

/** The explicit no-match option. A choice question without one is forced to pick a slot. */
export const NO_SLOT = "none";
export type SlotOption = Slot | typeof NO_SLOT;

/**
 * The question, word for word as the design phrases it.
 *
 * *Single-valued* is the load-bearing word: `visited` is not `lives_in`, because a person
 * visits many places and closure on a visit deletes their true home.
 */
export const SLOT_QUESTION =
  "Is this relation a single-valued profile property of its subject? If so, which one?";

/**
 * The options: the eight slots, each with its one-line description, plus `none`.
 *
 * The descriptions are `SLOT_DESCRIPTIONS` — the same wording the embedding arm scored
 * against — so the two arms differ in the decision procedure and not in what they were told
 * a slot means. `none` states the refusal case in the design's own terms, because a choice
 * model can only refuse through an option it was offered.
 */
export function slotCriteria(): Record<SlotOption, string> {
  const criteria = {} as Record<SlotOption, string>;
  for (const slot of SLOTS) criteria[slot] = SLOT_DESCRIPTIONS[slot];
  criteria[NO_SLOT] =
    "not a single-valued profile property of the subject: an event, action, opinion, plan, " +
    "possession, recommendation, or anything a person can have many of at once";
  return criteria;
}

/** A fact as the Jev arm sees it. `about` is the subject, `value` the object. */
export interface FactTriple {
  about: string;
  relation: string;
  value: string;
}

/**
 * The two input modes.
 *
 *  - `relation`: the relation alone, snake_case split to words — the same unit the embedding
 *    eval scores, so the two arms' numbers compare directly.
 *  - `fact`: `about | relation | value` for one representative fact, to see whether context
 *    separates `born_in` from `lives_in`.
 */
export type InputMode = "relation" | "fact";

export type DecisionState = Record<string, string | Record<string, string>>;

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionsRequest {
  model: string;
  state: string | DecisionState;
  questions: Record<string, ChoiceQuestion>;
}

/** One item to classify: the relation, and (for `fact` mode) the fact it came from. */
export interface SlotItem {
  relation: string;
  fact?: FactTriple;
}

function itemState(item: SlotItem, mode: InputMode): string | Record<string, string> {
  if (mode === "relation") return relationToWords(item.relation);
  const fact = item.fact ?? { about: "", relation: item.relation, value: "" };
  return { about: fact.about, relation: relationToWords(fact.relation), value: fact.value };
}

/**
 * Build one request for one or more items.
 *
 * A single item keeps the state flat (`{relation: "lives in"}`) so the question reads exactly
 * as designed. Several items share one call by keying the state (`{r0: ..., r1: ...}`) and
 * pointing each question at its own key — the Decisions API evaluates the questions of one
 * request independently over a shared state, which is what makes this legal, and the eval's
 * gate phase checks it agrees with the one-per-call answers before the sweep relies on it.
 */
export function buildSlotRequest(items: SlotItem[], mode: InputMode, model = JEV_MODEL): DecisionsRequest {
  if (items.length === 0) throw new Error("buildSlotRequest needs at least one item");
  const criteria = slotCriteria();
  const [only] = items;
  if (items.length === 1 && only !== undefined) {
    const inner = itemState(only, mode);
    return {
      model,
      state: typeof inner === "string" ? { relation: inner } : inner,
      questions: { q0: { type: "choice", instructions: SLOT_QUESTION, criteria } },
    };
  }
  const state: DecisionState = {};
  const questions: Record<string, ChoiceQuestion> = {};
  items.forEach((item, index) => {
    state[`r${index}`] = itemState(item, mode);
    questions[`q${index}`] = {
      type: "choice",
      instructions: `Consider only the ${mode === "relation" ? "relation" : "fact"} in state field "r${index}". ${SLOT_QUESTION}`,
      criteria,
    };
  });
  return { model, state, questions };
}

/** One `choice` answer over a fixed option set `O`. */
export interface OptionAnswer<O extends string> {
  choice: O;
  /** The chosen option's probability — what a threshold reads. */
  p: number;
  confidence: number | null;
  probabilities: Partial<Record<O, number>>;
}

export interface ParsedChoices<O extends string> {
  answers: Map<string, OptionAnswer<O>>;
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export type ChoiceAnswer = OptionAnswer<SlotOption>;
export type ParsedResponse = ParsedChoices<SlotOption>;

const OPTIONS: ReadonlySet<SlotOption> = new Set<SlotOption>([...SLOTS, NO_SLOT]);

/**
 * Parse a Decisions response of `choice` answers, strictly about what matters and tolerant
 * about the rest.
 *
 * Strict: every asked question must come back as a `choice` whose choice is one of `options`
 * — an answer outside the offered set is a protocol error, not a label. Tolerant: rounded
 * probabilities that do not sum to 1, an absent `confidence`, an absent `cost`.
 */
export function parseChoiceResponse<O extends string>(
  payload: unknown,
  questionIds: readonly string[],
  options: ReadonlySet<O>,
): ParsedChoices<O> {
  if (typeof payload !== "object" || payload === null) throw new Error("decisions: response is not an object");
  const body = payload as {
    model?: unknown;
    answers?: Record<string, unknown>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown };
  };
  if (typeof body.answers !== "object" || body.answers === null) {
    throw new Error("decisions: response has no answers");
  }
  const offered = options as ReadonlySet<string>;
  const answers = new Map<string, OptionAnswer<O>>();
  for (const id of questionIds) {
    const raw = body.answers[id] as
      | { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown }
      | undefined;
    if (!raw || raw.type !== "choice") throw new Error(`decisions: no choice answer for ${id}`);
    if (typeof raw.choice !== "string" || !offered.has(raw.choice)) {
      throw new Error(`decisions: ${id} chose ${JSON.stringify(raw.choice)}, not an offered option`);
    }
    const choice = raw.choice as O;
    const probabilities: Partial<Record<O, number>> = {};
    if (typeof raw.probabilities === "object" && raw.probabilities !== null) {
      for (const [option, value] of Object.entries(raw.probabilities as Record<string, unknown>)) {
        if (offered.has(option) && typeof value === "number" && Number.isFinite(value)) {
          probabilities[option as O] = value;
        }
      }
    }
    const confidence = typeof raw.confidence === "number" ? raw.confidence : null;
    const p = probabilities[choice] ?? confidence ?? Number.NaN;
    answers.set(id, { choice, p, confidence, probabilities });
  }
  const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    answers,
    model: typeof body.model === "string" ? body.model : "",
    cost: num(body.usage?.cost),
    inputTokens: num(body.usage?.input_tokens),
    outputTokens: num(body.usage?.output_tokens),
  };
}

/** The slot question's parser: {@link parseChoiceResponse} over the eight slots plus `none`. */
export function parseSlotResponse(payload: unknown, questionIds: readonly string[]): ParsedResponse {
  return parseChoiceResponse(payload, questionIds, OPTIONS);
}

/**
 * The threshold rule. A slot only when Jev chose one AND gave it at least `threshold`.
 *
 * `none` is never promoted to a slot however low its probability — a refusal is a refusal —
 * and a NaN probability (no distribution, no confidence) is below every threshold. Both
 * failures land on "no slot", which is the measured baseline rather than a new way to lose data.
 */
export function slotFromAnswer(answer: ChoiceAnswer | undefined, threshold: number): Slot | null {
  if (!answer || answer.choice === NO_SLOT) return null;
  if (!(answer.p >= threshold)) return null;
  return answer.choice;
}

export interface JevAssignment {
  slot: Slot | null;
  via: "synonym" | "jev" | "none";
}

/**
 * The production shape: the synonym table in front, Jev only for what it does not spell.
 *
 * Exactly like `packages/memory/src/slots.ts` `deriveSlot`, with Jev where the killed
 * embedding stage used to be. A table hit never reaches the model, so a model regression
 * cannot unmap `lives_in` itself.
 */
export function assignSlotWithJev(
  relation: string,
  answer: ChoiceAnswer | undefined,
  threshold: number,
): JevAssignment {
  const exact = SLOT_SYNONYMS[relationToWords(relation)];
  if (exact !== undefined) return { slot: exact, via: "synonym" };
  const slot = slotFromAnswer(answer, threshold);
  return slot === null ? { slot: null, via: "none" } : { slot, via: "jev" };
}

/**
 * The cache key: `(model, state, questions)`, hashed.
 *
 * Built from the request object the client actually sends, with keys in insertion order —
 * `buildSlotRequest` always inserts in the same order — so the key changes exactly when any
 * byte of what Jev would see changes, including a reworded description.
 */
export function decisionCacheKey(request: DecisionsRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([request.model, request.state, request.questions]))
    .digest("hex");
}

export interface CachedDecision {
  k: string;
  /** The raw response body; re-parsed on read so a parser fix applies to cached rows too. */
  body: unknown;
  latencyMs: number;
}

/**
 * Append-only NDJSON cache of raw responses, read through a `Buffer` a line at a time — the
 * same shape as the slot-cosine cache and for the same reasons (a torn line costs that line;
 * a whole-file utf8 read has a hard ceiling). Appends immediately: a call is cheap, and a
 * resumable run should never re-pay one.
 */
export class DecisionCache {
  private readonly entries = new Map<string, CachedDecision>();

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    const buffer = readFileSync(path);
    let start = 0;
    while (start < buffer.length) {
      let end = buffer.indexOf(0x0a, start);
      if (end === -1) end = buffer.length;
      if (end > start) {
        try {
          const record = JSON.parse(buffer.toString("utf8", start, end)) as CachedDecision;
          if (typeof record.k === "string") this.entries.set(record.k, record);
        } catch {
          /* one torn line costs that decision, not the file */
        }
      }
      start = end + 1;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): CachedDecision | undefined {
    return this.entries.get(key);
  }

  put(record: CachedDecision): void {
    this.entries.set(record.k, record);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

export class SpendCapError extends Error {}

/**
 * A running spend count with a hard stop.
 *
 * `reserve` is called BEFORE a request goes out and refuses once `spent + estimate` would
 * cross the cap, so concurrency cannot overshoot by more than one in-flight estimate per
 * worker; `settle` replaces the estimate with the billed `usage.cost`.
 */
export class SpendMeter {
  spent = 0;
  private inFlight = 0;

  constructor(
    readonly cap: number,
    readonly estimatePerCall: number,
  ) {}

  reserve(): void {
    if (this.spent + this.inFlight + this.estimatePerCall > this.cap) {
      throw new SpendCapError(
        `spend cap $${this.cap.toFixed(2)} reached ($${this.spent.toFixed(4)} spent)`,
      );
    }
    this.inFlight += this.estimatePerCall;
  }

  settle(actual: number): void {
    this.inFlight = Math.max(0, this.inFlight - this.estimatePerCall);
    this.spent += actual;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - this.estimatePerCall);
  }
}

/** Retry on rate limits and upstream trouble; everything else is a bug to surface. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface DecideResult<T = ParsedResponse> {
  parsed: T;
  latencyMs: number;
  cached: boolean;
}

export interface JevClientOptions {
  apiKey: string;
  cache: DecisionCache;
  meter: SpendMeter;
  attempts?: number;
}

export class JevClient {
  constructor(private readonly options: JevClientOptions) {}

  /**
   * Ask one request. `bypassCache` still WRITES the fresh answer (last one wins on reload) —
   * the determinism check needs fresh calls, not a cold cache.
   */
  async decide(request: DecisionsRequest, bypassCache = false): Promise<DecideResult> {
    return this.decideWith(request, parseSlotResponse, bypassCache);
  }

  /** {@link decide} with the caller's parser, for questions other than the slot question. */
  async decideWith<T extends { cost: number }>(
    request: DecisionsRequest,
    parse: (body: unknown, questionIds: readonly string[]) => T,
    bypassCache = false,
  ): Promise<DecideResult<T>> {
    const ids = Object.keys(request.questions);
    const key = decisionCacheKey(request);
    if (!bypassCache) {
      const hit = this.options.cache.get(key);
      if (hit) return { parsed: parse(hit.body, ids), latencyMs: hit.latencyMs, cached: true };
    }
    const attempts = this.options.attempts ?? 6;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.options.meter.reserve();
      let settled = false;
      try {
        const started = performance.now();
        const response = await fetch(DECISIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        });
        const text = await response.text();
        const latencyMs = performance.now() - started;
        if (!response.ok) {
          this.options.meter.release();
          settled = true;
          const error = new Error(`decisions ${response.status}: ${text.slice(0, 300)}`);
          if (!isRetryableStatus(response.status)) throw Object.assign(error, { fatal: true });
          lastError = error;
          await delay(1000 * 2 ** attempt);
          continue;
        }
        const body = JSON.parse(text) as unknown;
        const parsed = parse(body, ids);
        this.options.meter.settle(parsed.cost);
        settled = true;
        this.options.cache.put({ k: key, body, latencyMs });
        return { parsed, latencyMs, cached: false };
      } catch (error) {
        if (!settled) this.options.meter.release();
        if ((error as { fatal?: boolean }).fatal) throw error;
        lastError = error;
        await delay(1000 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
