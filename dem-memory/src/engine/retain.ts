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
  type ExtractFn,
  type IngestionPayload,
  type MemoryTuple,
} from "../types.js";

export interface RetainOptions {
  bankId?: string;
  now?: string;
}

export interface RetainResult {
  bankId: string;
  transactionTime: string;
  tuples: MemoryTuple[];
  invalidatedCount: number;
}

export const EXTRACTION_SYSTEM_PROMPT = [
  "You are a memory-extraction engine. You convert dialogue transcripts into discrete relational facts.",
  "",
  "Rules:",
  "- Each fact is a quadruple: subject, predicate, object.",
  "- Canonicalize subjects to snake_case entity identifiers (e.g. sam, postgres_database).",
  "- Normalize predicates to snake_case relationships or properties (e.g. prefers_backend, works_at).",
  "- Keep objects concise: a phrase, a value, or an outcome.",
  "- Classify each fact:",
  "  - world: objective, verifiable assertions about external entities or domain rules.",
  "  - experience: first-person records of user interactions, assistant actions, or recommendations.",
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
    const facts = IngestionPayloadSchema.parse(payload).facts;

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

    return { bankId, transactionTime, tuples, invalidatedCount };
  }
}
