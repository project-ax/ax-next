import { randomUUID } from "node:crypto";
import type { MemoryRepository } from "../db/memory-repository.js";
import type { CoOccurrenceGraph } from "../graph/co-occurrence-graph.js";
import {
  INFINITY_SENTINEL,
  IngestionPayloadSchema,
  flattenDialogue,
  memoryStatement,
  normalizeTimestamp,
  type DialogueTurn,
  type EmbeddingFn,
  type ExtractedFact,
  type ExtractFn,
  type IngestionPayload,
  type MemoryTuple,
} from "../types.js";

export interface RetainOptions {
  bankId?: string;
  now?: string;
}

export interface SkippedFact {
  fact: ExtractedFact;
  reason: string;
}

export interface RetainResult {
  bankId: string;
  transactionTime: string;
  tuples: MemoryTuple[];
  invalidatedCount: number;
  /**
   * Facts the extractor produced that could not be stored, with the reason. Surfaced rather
   * than thrown: extractor output is model output, and one unusable fact must not cost the
   * whole batch. Surfaced rather than swallowed, so bad extraction stays observable.
   */
  skipped: SkippedFact[];
}

/**
 * The extraction contract.
 *
 * The assistant-content half is not decoration. At n=100 the weak type was
 * single-session-assistant (45.5%, identical in both answer arms), and dumping what actually
 * reached the table showed the right session's facts ranked 1-7 in five of six failures with
 * the asked-for detail compressed out of them: "assistant generated song: sad song with
 * lyrics and note sequences" for a question about the chorus's chord progression. Retrieval
 * was doing its job; the prompt had thrown the answer away at ingest. The instruction that
 * did it was "Keep objects concise: a phrase, a value, or an outcome" — do not reintroduce it.
 *
 * The shape of the fix is ported from `@ax/memory-strata`'s 2026-08-02 assistant-content
 * extraction (`packages/memory-strata/src/observer.ts`), which moved the same LongMemEval type
 * 25.9% -> 83.3% with no other type regressing.
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
  "- Each fact is a triple — subject, predicate, object — plus a network, a date, and a confidence.",
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
  "  - opinion: subjective beliefs or inferred user preferences; assign confidence below 1.0.",
  "- validStart: ISO-8601 UTC date-time marking when the statement became true. Use dialogue timestamps",
  "  when present; otherwise use the current time provided in the prompt. Never output a future time.",
  "- invalidatesPrevious: true only when this fact updates or supersedes a prior state that would share",
  "  the same subject and predicate (e.g. a changed preference, a moved location, a completed migration).",
  "- Extract only durable, memory-worthy facts. No small talk. No duplicates.",
].join("\n");

export function buildExtractionPrompt(dialogue: string, now: string): string {
  return [
    `Current time: ${now}`,
    "",
    "Reply with ONLY a JSON object of exactly this shape (no prose, no code fences):",
    '{"facts": [{"network": "world" | "experience" | "opinion", "subject": "<snake_case entity>", "predicate": "<snake_case relation>", "object": "<concise statement>", "validStart": "<ISO-8601 UTC date-time>", "confidence": <0.0-1.0>, "invalidatesPrevious": <true|false>}]}',
    "",
    "Dialogue transcript:",
    dialogue,
  ].join("\n");
}

export function createOpenAIExtractor(
  options: { apiKey?: string; model?: string } = {},
): ExtractFn {
  return async (dialogue, { now }) => {
    const { generateObject } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const provider = createOpenAI({ apiKey: options.apiKey });
    const { object } = await generateObject({
      model: provider(options.model ?? process.env.DEM_EXTRACT_MODEL ?? "gpt-4o-mini"),
      schema: IngestionPayloadSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: buildExtractionPrompt(dialogue, now),
    });
    return object;
  };
}

export class RetainEngine {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly graph: CoOccurrenceGraph,
    private readonly embed: EmbeddingFn,
    private readonly extract: ExtractFn,
    private readonly defaultBankId: string,
  ) {}

  async retain(
    input: string | DialogueTurn[] | IngestionPayload,
    options: RetainOptions = {},
  ): Promise<RetainResult> {
    const bankId = options.bankId ?? this.defaultBankId;
    const now = normalizeTimestamp(options.now ?? new Date().toISOString(), "now");

    let payload: IngestionPayload;
    if (typeof input === "string" || Array.isArray(input)) {
      payload = await this.extract(flattenDialogue(input), { now });
    } else {
      payload = input;
    }
    const parsed = IngestionPayloadSchema.parse(payload).facts;

    // Validate every timestamp BEFORE touching the database. `normalizeTimestamp` throwing
    // from the middle of the write loop used to abandon a half-written batch; observed with
    // a three-digit year ("135-01-01T00:00:00Z") out of GLM.
    const facts: ExtractedFact[] = [];
    const skipped: SkippedFact[] = [];
    for (const fact of parsed) {
      try {
        normalizeTimestamp(fact.validStart, "validStart");
        facts.push(fact);
      } catch (error) {
        skipped.push({ fact, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    let invalidatedCount = 0;
    for (const fact of facts) {
      if (fact.invalidatesPrevious) {
        invalidatedCount += this.repository.invalidateMemory(
          bankId,
          fact.subject,
          fact.predicate,
          normalizeTimestamp(fact.validStart, "validStart"),
        );
      }
    }

    const statements = facts.map((fact) =>
      memoryStatement(fact.subject, fact.predicate, fact.object),
    );
    const vectors = await this.embed(statements, "document");

    const transactionTime = now;
    const tuples: MemoryTuple[] = [];
    for (let i = 0; i < facts.length; i += 1) {
      const fact = facts[i];
      const vector = vectors[i];
      if (!fact || !vector) continue;
      const tuple: MemoryTuple = {
        id: randomUUID(),
        bankId,
        network: fact.network,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        confidence: fact.confidence,
        validStart: normalizeTimestamp(fact.validStart, "validStart"),
        validEnd: INFINITY_SENTINEL,
        transactionTime,
      };
      this.repository.insertMemory(tuple, vector);
      tuples.push(tuple);
    }

    this.graph.coOccur(facts.map((fact) => fact.subject));

    return { bankId, transactionTime, tuples, invalidatedCount, skipped };
  }
}
