import { describe, expect, it } from "vitest";
import { INFINITY_SENTINEL } from "../src/types.js";
import { createTestMemory, queuedExtractor } from "./helpers.js";

const T1 = "2025-01-15T10:00:00.000Z";
const T2 = "2025-03-01T09:00:00.000Z";
const T3 = "2025-06-01T09:00:00.000Z";
const MID = "2025-02-01T00:00:00.000Z";

function backendFact(object: string, validStart: string, invalidatesPrevious: boolean) {
  return {
    facts: [
      {
        network: "experience" as const,
        subject: "sam",
        predicate: "prefers_backend",
        object,
        validStart,
        invalidatesPrevious,
      },
    ],
  };
}

async function updatedMemory() {
  const memory = await createTestMemory({
    extract: queuedExtractor([
      backendFact("Python FastAPI", T1, false),
      backendFact("Go on raw SQL", T2, true),
      backendFact("Rust on axum", T3, true),
    ]),
  });
  await memory.retain("session one", { now: T1 });
  await memory.retain("session two", { now: T2 });
  return { memory, retainThird: () => memory.retain("session three", { now: T3 }) };
}

function backendRows(memory: Awaited<ReturnType<typeof updatedMemory>>["memory"]) {
  return memory.database
    .prepare(
      "SELECT object, valid_start, valid_end FROM memories WHERE subject = 'sam' AND predicate = 'prefers_backend' ORDER BY valid_start",
    )
    .all() as Array<{ object: string; valid_start: string; valid_end: string }>;
}

describe("temporal invalidation", () => {
  it("closes the old record and reports only the new fact for current-state queries", async () => {
    const { memory } = await updatedMemory();

    const rows = backendRows(memory);
    expect(rows).toEqual([
      { object: "Python FastAPI", valid_start: T1, valid_end: T2 },
      { object: "Go on raw SQL", valid_start: T2, valid_end: INFINITY_SENTINEL },
    ]);

    const result = await memory.recall("what backend does sam prefer");
    const backendTuples = result.tuples.filter((tuple) => tuple.predicate === "prefers_backend");
    expect(backendTuples).toHaveLength(1);
    expect(backendTuples[0]?.object).toBe("Go on raw SQL");

    memory.close();
  });

  it("returns the historically valid fact for anchor dates inside its interval", async () => {
    const { memory } = await updatedMemory();

    const historical = await memory.recall("what backend does sam prefer", { temporalAnchor: MID });
    const backendTuples = historical.tuples.filter((tuple) => tuple.predicate === "prefers_backend");
    expect(backendTuples).toHaveLength(1);
    expect(backendTuples[0]?.object).toBe("Python FastAPI");
    expect(historical.channels.temporal).toHaveLength(1);

    const current = await memory.recall("what backend does sam prefer", { temporalAnchor: T2 });
    const currentTuples = current.tuples.filter((tuple) => tuple.predicate === "prefers_backend");
    expect(currentTuples).toHaveLength(1);
    expect(currentTuples[0]?.object).toBe("Go on raw SQL");

    memory.close();
  });

  it("re-invalidation never rewrites previously closed intervals", async () => {
    const { memory, retainThird } = await updatedMemory();
    const third = await retainThird();
    expect(third.invalidatedCount).toBe(1);

    const rows = backendRows(memory);
    expect(rows).toEqual([
      { object: "Python FastAPI", valid_start: T1, valid_end: T2 },
      { object: "Go on raw SQL", valid_start: T2, valid_end: T3 },
      { object: "Rust on axum", valid_start: T3, valid_end: INFINITY_SENTINEL },
    ]);

    const midResult = await memory.recall("backend", { temporalAnchor: MID });
    expect(midResult.channels.temporal).toHaveLength(1);

    memory.close();
  });

  it("invalidation without matching active records is a no-op", async () => {
    const memory = await createTestMemory({
      extract: queuedExtractor([backendFact("Go on raw SQL", T2, true)]),
    });
    const result = await memory.retain("session", { now: T2 });
    expect(result.invalidatedCount).toBe(0);
    expect(memory.database.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 1 });
    memory.close();
  });

  it("excludes superseded records from every recall channel", async () => {
    const { memory } = await updatedMemory();
    const oldId = (
      memory.database
        .prepare("SELECT id FROM memories WHERE object = 'Python FastAPI'")
        .get() as { id: string } | undefined
    )?.id;
    expect(oldId).toBeDefined();

    const result = await memory.recall("sam backend python fastapi");
    const allChannelIds = [
      ...result.channels.sparse,
      ...result.channels.dense,
      ...result.channels.graph,
      ...result.channels.temporal,
    ];
    expect(allChannelIds).not.toContain(oldId);

    memory.close();
  });
});
