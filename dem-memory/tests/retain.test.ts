import { describe, expect, it } from "vitest";
import { INFINITY_SENTINEL, ExtractedFactSchema, IngestionPayloadSchema } from "../src/types.js";
import { createTestMemory, FIXTURE, fixtureExtractor, fixtureSession, queuedExtractor } from "./helpers.js";

const T1 = "2025-01-15T10:00:00.000Z";
const T2 = "2025-03-01T09:00:00.000Z";

describe("retain", () => {
  it("persists quadruples across the relational, full-text, and vector stores atomically", async () => {
    const memory = await createTestMemory({ extract: fixtureExtractor("session-1") });
    const result = await memory.retain(fixtureSession("session-1").turns, { now: T1 });

    expect(result.tuples).toHaveLength(2);
    expect(result.invalidatedCount).toBe(0);
    expect(result.transactionTime).toBe(T1);

    const db = memory.database;
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories_fts").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories_vec").get()).toEqual({ n: 2 });

    for (const tuple of result.tuples) {
      expect(tuple.bankId).toBe("test");
      expect(tuple.validEnd).toBe(INFINITY_SENTINEL);
      expect(tuple.transactionTime).toBe(T1);
    }
    const networks = result.tuples.map((tuple) => tuple.network).sort();
    expect(networks).toEqual(["experience", "opinion"]);
    expect(result.tuples.find((tuple) => tuple.network === "opinion")).toBeDefined();

    memory.close();
  });

  it("hands the extractor a flattened transcript plus the evaluation clock", async () => {
    const seen: Array<{ dialogue: string; now: string }> = [];
    const memory = await createTestMemory({
      extract: async (dialogue, context) => {
        seen.push({ dialogue, now: context.now });
        return { facts: [] };
      },
    });

    await memory.retain(
      [{ role: "user", content: "hello world", at: "2025-01-01T00:00:00.000Z" }],
      { now: "2025-06-01T12:00:00.000Z" },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.dialogue).toContain("[2025-01-01T00:00:00.000Z] user: hello world");
    expect(seen[0]?.now).toBe("2025-06-01T12:00:00.000Z");

    memory.close();
  });

  it("updates the Hebbian co-occurrence graph per conversational batch", async () => {
    const memory = await createTestMemory({ extract: fixtureExtractor("session-3") });
    await memory.retain(fixtureSession("session-3").turns, { now: "2025-02-10T14:05:00.000Z" });

    const stats = memory.stats();
    expect(stats.graphNodes).toBe(2);
    expect(stats.graphEdges).toBe(1);

    memory.close();
  });

  it("closes superseded records when invalidatesPrevious is set", async () => {
    const memory = await createTestMemory({
      extract: queuedExtractor([
        {
          facts: [
            {
              network: "experience",
              subject: "sam",
              predicate: "prefers_backend",
              object: "Python FastAPI",
              validStart: T1,
              invalidatesPrevious: false,
            },
          ],
        },
        {
          facts: [
            {
              network: "experience",
              subject: "sam",
              predicate: "prefers_backend",
              object: "Go on raw SQL",
              validStart: T2,
              invalidatesPrevious: true,
            },
          ],
        },
      ]),
    });

    await memory.retain("session one", { now: T1 });
    const second = await memory.retain("session two", { now: T2 });

    expect(second.invalidatedCount).toBe(1);
    const rows = memory.database
      .prepare(
        "SELECT object, valid_start, valid_end FROM memories WHERE subject = 'sam' AND predicate = 'prefers_backend' ORDER BY valid_start",
      )
      .all() as Array<{ object: string; valid_start: string; valid_end: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ object: "Python FastAPI", valid_start: T1, valid_end: T2 });
    expect(rows[1]?.valid_end).toBe(INFINITY_SENTINEL);

    memory.close();
  });

  it("rejects malformed payloads through the zod schema", async () => {
    expect(() =>
      ExtractedFactSchema.parse({
        network: "gossip",
        subject: "sam",
        predicate: "likes",
        object: "tea",
        validStart: T1,
        invalidatesPrevious: false,
      }),
    ).toThrow();

    const parsed = IngestionPayloadSchema.parse({
      facts: [
        {
          network: "world",
          subject: "sam",
          predicate: "likes",
          object: "tea",
          validStart: T1,
          invalidatesPrevious: false,
        },
      ],
    });
    // `confidence` was removed entirely: of 130,779 extracted facts 99.73% sat above 0.7 with
    // an absolute floor of 0.5, so it had no discriminative power, and no code ever branched on
    // it. An extractor that emits a fact has already decided the fact exists; asking it to
    // self-score that decision zero-shot yields a constant. A payload that still carries one is
    // accepted and the value ignored.
    expect(parsed.facts[0]).not.toHaveProperty("confidence");
  });

  it("normalizes date-only validStart values to full ISO-8601 UTC", async () => {
    const raw = FIXTURE.expectedFacts["session-1"]?.[0];
    if (!raw) throw new Error("fixture fact missing");
    const fact = structuredClone(raw);
    fact.validStart = "2025-01-15";
    const memory = await createTestMemory({
      extract: async () => ({ facts: [fact] }),
    });
    const result = await memory.retain("dialogue", { now: T1 });
    expect(result.tuples[0]?.validStart).toBe("2025-01-15T00:00:00.000Z");
    memory.close();
  });
});

describe("malformed extractor output", () => {
  it("skips a fact with an unparseable validStart instead of losing the whole batch", async () => {
    // Observed in the wild: GLM emitted a three-digit year, and normalizeTimestamp threw
    // out of the middle of retain() -- taking all 45 sessions of that question's ingest
    // with it. One bad date must cost one fact, not the batch.
    const memory = await createTestMemory();
    const result = await memory.retain(
      {
        facts: [
          {
            network: "world",
            subject: "user",
            predicate: "studied_period",
            object: "ancient rome",
            validStart: "135-01-01T00:00:00Z",
            invalidatesPrevious: false,
          },
          {
            network: "world",
            subject: "user",
            predicate: "lives_in",
            object: "Austin",
            validStart: "2023-01-01T00:00:00.000Z",
            invalidatesPrevious: false,
          },
        ],
      },
      { now: "2023-05-01T00:00:00.000Z" },
    );

    expect(result.tuples).toHaveLength(1);
    expect(result.tuples[0]?.predicate).toBe("lives_in");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("validStart");
    expect(result.skipped[0]?.fact.predicate).toBe("studied_period");
    expect(memory.stats().total).toBe(1);

    memory.close();
  });

  it("does not let a malformed fact suppress an invalidation carried by a later one", async () => {
    const memory = await createTestMemory();
    await memory.retain(
      {
        facts: [
          {
            network: "world",
            subject: "user",
            predicate: "lives_in",
            object: "Boston",
            validStart: "2023-01-01T00:00:00.000Z",
            invalidatesPrevious: false,
          },
        ],
      },
      { now: "2023-01-01T00:00:00.000Z" },
    );
    const result = await memory.retain(
      {
        facts: [
          {
            network: "world",
            subject: "user",
            predicate: "broken",
            object: "x",
            validStart: "not-a-date",
            invalidatesPrevious: true,
          },
          {
            network: "world",
            subject: "user",
            predicate: "lives_in",
            object: "Austin",
            validStart: "2023-06-01T00:00:00.000Z",
            invalidatesPrevious: true,
          },
        ],
      },
      { now: "2023-06-01T00:00:00.000Z" },
    );

    expect(result.skipped).toHaveLength(1);
    expect(result.invalidatedCount).toBe(1);
    expect(memory.stats().active).toBe(1);

    memory.close();
  });
});
