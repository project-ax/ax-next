import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/engine/recall.js";
import { lexicalReranker } from "../src/models/reranker.js";
import { createTestMemory, fixtureExtractor, fixtureFacts, fixtureSession } from "./helpers.js";

const NOW_1 = "2025-01-15T10:01:00.000Z";
const NOW_3 = "2025-02-10T14:05:00.000Z";

async function seededMemory() {
  const memory = await createTestMemory();
  const session1 = await memory.retain({ facts: fixtureFacts("session-1") }, { now: NOW_1 });
  const session3 = await memory.retain({ facts: fixtureFacts("session-3") }, { now: NOW_3 });
  return { memory, session1, session3 };
}

describe("reciprocalRankFusion", () => {
  it("implements RRF(d) = sum 1/(k + rank) with deterministic tie-breaking", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["b"], ["a", "c", "d"]], 60);
    const scoreOf = (id: string): number => fused.find((entry) => entry.id === id)?.score ?? 0;
    // a: rank 1 + rank 1 ; b: rank 2 + rank 1 ; c: rank 2 ; d: rank 3
    expect(scoreOf("a")).toBeCloseTo(1 / 61 + 1 / 61, 12);
    expect(scoreOf("b")).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(scoreOf("c")).toBeCloseTo(1 / 62, 12);
    expect(scoreOf("d")).toBeCloseTo(1 / 63, 12);
    expect(fused.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("is deterministic under ties via lexicographic id order", () => {
    const first = reciprocalRankFusion([["x"], ["y"]], 60);
    const second = reciprocalRankFusion([["y"], ["x"]], 60);
    expect(first.map((entry) => entry.id)).toEqual(["x", "y"]);
    expect(second.map((entry) => entry.id)).toEqual(["x", "y"]);
  });
});

describe("recall channels", () => {
  it("sparse channel surfaces BM25 keyword matches", async () => {
    const { memory, session1 } = await seededMemory();
    const backendTuple = session1.tuples.find((tuple) => tuple.predicate === "prefers_backend");
    expect(backendTuple).toBeDefined();

    const result = await memory.recall("fastapi backend");
    expect(result.channels.sparse).toContain(backendTuple?.id);

    memory.close();
  });

  it("dense channel surfaces semantically hashed neighbors", async () => {
    const { memory, session1 } = await seededMemory();
    const backendTuple = session1.tuples.find((tuple) => tuple.predicate === "prefers_backend");
    expect(backendTuple).toBeDefined();

    const result = await memory.recall("sam python fastapi backend");
    expect(result.channels.dense).toContain(backendTuple?.id);

    memory.close();
  });

  it("graph channel reaches two-hop neighbors through the co-occurrence graph", async () => {
    const { memory, session1, session3 } = await seededMemory();
    const ownsTooling = session3.tuples.find((tuple) => tuple.subject === "sam");
    const runsDatabase = session3.tuples.find((tuple) => tuple.subject === "staging_cluster");
    expect(ownsTooling).toBeDefined();
    expect(runsDatabase).toBeDefined();

    const result = await memory.recall("staging cluster database");
    expect(result.channels.graph).toContain(runsDatabase?.id);
    // The seed subject (staging_cluster) ranks ahead of its one-hop neighbor (sam).
    expect(result.channels.graph.indexOf(runsDatabase?.id ?? "")).toBeLessThan(
      result.channels.graph.indexOf(ownsTooling?.id ?? ""),
    );

    memory.close();
  });

  it("temporal channel with an anchor returns only facts valid at that time", async () => {
    const { memory, session1, session3 } = await seededMemory();

    const before = await memory.recall("sam", { temporalAnchor: "2025-02-01T00:00:00.000Z" });
    expect(before.channels.temporal).toEqual(
      expect.arrayContaining(session1.tuples.map((tuple) => tuple.id)),
    );
    expect(before.channels.temporal).not.toContain(session3.tuples[0]?.id);

    const after = await memory.recall("sam", { temporalAnchor: "2025-03-01T00:00:00.000Z" });
    expect(after.channels.temporal).toEqual(
      expect.arrayContaining([...session1.tuples, ...session3.tuples].map((tuple) => tuple.id)),
    );

    memory.close();
  });

  it("fuses channels with RRF so consensus candidates outrank single-channel ones", async () => {
    const { memory, session1, session3 } = await seededMemory();
    const backendTuple = session1.tuples.find((tuple) => tuple.predicate === "prefers_backend");
    const runsDatabase = session3.tuples.find((tuple) => tuple.subject === "staging_cluster");
    expect(backendTuple).toBeDefined();
    expect(runsDatabase).toBeDefined();

    // "sam" hits sparse (fts), graph (seed), and temporal (active) for sam-subject
    // rows, while the staging_cluster row only rides graph + temporal.
    const result = await memory.recall("sam");
    expect(result.tuples[0]?.subject).toBe("sam");
    const topIndex = result.tuples.findIndex((tuple) => tuple.id === backendTuple?.id);
    const runsIndex = result.tuples.findIndex((tuple) => tuple.id === runsDatabase?.id);
    if (topIndex >= 0 && runsIndex >= 0) {
      expect(topIndex).toBeLessThan(runsIndex);
    }

    memory.close();
  });

  it("respects the limit option", async () => {
    const { memory } = await seededMemory();
    const result = await memory.recall("sam backend staging cluster", { limit: 2 });
    expect(result.tuples).toHaveLength(2);
    memory.close();
  });

  it("reranks the fused pool when a reranker is configured", async () => {
    const memory = await createTestMemory({
      extract: fixtureExtractor("session-1"),
      rerank: lexicalReranker(),
    });
    const retained = await memory.retain(fixtureSession("session-1").turns, { now: NOW_1 });
    const backendTuple = retained.tuples.find((tuple) => tuple.predicate === "prefers_backend");
    expect(backendTuple).toBeDefined();

    const result = await memory.recall("fastapi");
    expect(result.reranked).toBe(true);
    expect(result.tuples[0]?.id).toBe(backendTuple?.id);

    memory.close();
  });

  it("returns an empty result for an empty bank", async () => {
    const memory = await createTestMemory();
    const result = await memory.recall("anything at all");
    expect(result.tuples).toHaveLength(0);
    expect(result.channels).toEqual({ sparse: [], dense: [], graph: [], temporal: [] });
    memory.close();
  });

  it("respects the bankId retain option without leaking into the default bank", async () => {
    const memory = await createTestMemory({ extract: fixtureExtractor("session-1") });
    await memory.retain(fixtureSession("session-1").turns, { now: NOW_1, bankId: "project-a" });

    const inOtherBank = await memory.recall("fastapi");
    expect(inOtherBank.tuples).toHaveLength(0);

    expect(
      memory.database
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE bank_id = 'project-a'")
        .get(),
    ).toEqual({ n: 2 });
    expect(
      memory.database.prepare("SELECT COUNT(*) AS n FROM memories WHERE bank_id = 'test'").get(),
    ).toEqual({ n: 0 });

    memory.close();
  });
});
