import { describe, expect, it } from "vitest";
import { createDemMemory, type DemMemory, type IdStrategy } from "../src/index.js";
import { hashEmbedder } from "../src/models/embeddings.js";
import type { ExtractedFact } from "../src/types.js";

/**
 * Retrieval order must not depend on chance.
 *
 * `bench/reproducibility-probe.ts` measures this on the real corpus — 12/12 questions get a
 * different top-15 under `random`, 0/12 under `content`. This file pins the same property
 * hermetically, so a regression surfaces in CI rather than in a bench run somebody has to pay
 * for, and so the CAUSE stays visible: every ranking tie-break in `recall.ts` is
 * `id.localeCompare(id)`, which means the id scheme decides the order whenever RRF ties.
 */

function fact(subject: string, predicate: string, object: string, validStart: string): ExtractedFact {
  return { network: "world", subject, predicate, object, validStart, invalidatesPrevious: false };
}

/**
 * Forty rows of one subject, differing only in `validStart`.
 *
 * WHAT THIS FIXTURE CANNOT DO, said out loud so nobody reads it as more than it is: it does
 * not reproduce the RRF tie groups that make the id decide the evidence table. The temporal
 * channel orders by `validStart`, which gives these rows a total order, so every RRF score is
 * distinct and the tie-break never fires. Two drafts tried and neither worked — the first
 * with slightly-different text, the second with identical text — and both "passed" with a
 * random id spliced into the content path, which is to say both were asserting nothing.
 *
 * Real tie groups need channels to return OVERLAPPING-BUT-DIFFERENTLY-RANKED sets, which is
 * what a 330-fact haystack produces and what a hand-built fixture would have to engineer.
 * So the division of labour is: this file pins the MECHANISM (ids are deterministic, and that
 * is mutation-proven), and `bench/reproducibility-probe.ts` measures the CONSEQUENCE on the
 * real corpus — 12/12 questions get a different top-15 under `random`, 0/12 under `content`.
 */
const FACTS: ExtractedFact[] = Array.from({ length: 40 }, (_, i) =>
  fact(
    "garden",
    "has_property",
    "a statement about gardening and soil",
    `2023-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  ),
);

function store(idStrategy: IdStrategy): DemMemory {
  return createDemMemory({
    path: ":memory:",
    // The SAME bank each time. `:memory:` gives every instance its own private database, so
    // these are independent stores of one bank — and a content id includes the bank, because
    // `id` is the primary key of a table all banks share.
    bankId: "bank",
    embed: hashEmbedder(),
    // `none`, not a reranker: a reranker re-scores the pool by content and would mask the
    // tie-break under test behind a deterministic second opinion.
    rerank: "none",
    idStrategy,
    extract: async () => {
      throw new Error("facts are handed in directly");
    },
    generate: async () => {
      throw new Error("no answers here");
    },
  });
}

async function ingestAndRecall(
  idStrategy: IdStrategy,
): Promise<{ ids: string[]; order: string[] }> {
  const memory = store(idStrategy);
  await memory.retain({ facts: FACTS }, { now: "2024-01-01T00:00:00.000Z" });
  const ids = (
    memory.database.prepare(`SELECT id FROM memories ORDER BY rowid`).all() as Array<{ id: string }>
  ).map((row) => row.id);
  const recalled = await memory.recall("gardening soil", { limit: 15 });
  // Compare by `validStart`, the only thing that distinguishes these rows. NOT by id: under
  // `random` the ids differ by construction, so comparing them would prove nothing about what
  // the answerer actually sees.
  const order = recalled.tuples.map((tuple) => tuple.validStart);
  memory.close();
  return { ids, order };
}

describe("idStrategy: content", () => {
  it("gives the same store the same ids for the same ingest sequence", async () => {
    const a = await ingestAndRecall("content");
    const b = await ingestAndRecall("content");
    expect(a.ids).toEqual(b.ids);
  });

  it("gives the same evidence table (NOT DISCRIMINATING here — see the fixture note)", async () => {
    // Kept because it would catch the table changing for some OTHER reason, and deliberately
    // labelled: on this fixture it also passes under `random`, so it is not evidence about
    // the tie-break. The evidence for that is `bench/reproducibility-probe.ts`.
    const a = await ingestAndRecall("content");
    const b = await ingestAndRecall("content");
    expect(a.order).toEqual(b.order);
    expect(a.order).toHaveLength(15);
  });

  it("keeps ids unique when a batch carries the same statement twice", async () => {
    // Real: 13 exact duplicates in the n=100 sample. Two rows cannot share a primary key, so
    // the digest carries the within-batch ordinal.
    const memory = store("content");
    const duplicate = fact("user", "likes", "tea", "2023-01-01T00:00:00.000Z");
    await memory.retain({ facts: [duplicate, duplicate] }, { now: "2024-01-01T00:00:00.000Z" });
    const ids = (
      memory.database.prepare(`SELECT id FROM memories`).all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    memory.close();
  });

  it("separates banks, because `id` is the primary key of a table they share", async () => {
    const memory = store("content");
    const one = fact("user", "likes", "tea", "2023-01-01T00:00:00.000Z");
    await memory.retain({ facts: [one] }, { now: "2024-01-01T00:00:00.000Z" });
    await memory.retain({ facts: [one] }, { now: "2024-01-01T00:00:00.000Z", bankId: "other" });
    const ids = (
      memory.database.prepare(`SELECT id FROM memories`).all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(new Set(ids).size).toBe(2);
    memory.close();
  });
});

describe("idStrategy: random — what DEM shipped until 2026-09-18", () => {
  it("gives different ids for the same ingest sequence", async () => {
    const a = await ingestAndRecall("random");
    const b = await ingestAndRecall("random");
    expect(a.ids).not.toEqual(b.ids);
  });

  it("is no longer the default — `content` is, after its measured arms", async () => {
    const memory = createDemMemory({
      path: ":memory:",
      bankId: "bank",
      embed: hashEmbedder(),
      rerank: "none",
      extract: async () => {
        throw new Error("unused");
      },
      generate: async () => {
        throw new Error("unused");
      },
    });
    await memory.retain(
      { facts: [fact("user", "likes", "tea", "2023-01-01T00:00:00.000Z")] },
      { now: "2024-01-01T00:00:00.000Z" },
    );
    const { id } = memory.database.prepare(`SELECT id FROM memories`).get() as { id: string };
    // A sha1 hex digest, not a uuid. This is the line that reddens if the default moves, which
    // is the whole reason it is asserted rather than assumed.
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    memory.close();
  });
});
