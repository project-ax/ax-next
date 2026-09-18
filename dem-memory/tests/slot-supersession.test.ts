import { describe, expect, it } from "vitest";
import { createDemMemory, type DemMemory } from "../src/index.js";
import { hashEmbedder } from "../src/models/embeddings.js";
import { INFINITY_SENTINEL, type ExtractedFact, type Provenance } from "../src/types.js";
import type { Slot } from "../src/slots.js";

/**
 * §3.4 of the DEM-first design, against a real SQLite store.
 *
 * `tests/supersession-replay.test.ts` pins the same rules as PURE FUNCTIONS over a fixture,
 * which is what the bench replay measures. This file pins them THROUGH THE WRITE PATH —
 * normalizer, transaction, columns, and the retrieval consequence — because the two can
 * disagree: a rule that is correct in the replay and not wired into `retain` would leave the
 * bench right and the product wrong.
 *
 * Two of these rules cannot be exercised by the LongMemEval corpus at all (every cached fact
 * is `provenance: extracted`, and sorting a bank by `validStart` makes two-sided closure
 * vacuous), so this file is the ONLY place they are checked.
 */

function fact(
  subject: string,
  predicate: string,
  object: string,
  validStart: string,
  invalidatesPrevious = false,
): ExtractedFact {
  return { network: "world", subject, predicate, object, validStart, invalidatesPrevious };
}

function slotMemory(options: { normalizer?: (relation: string) => Slot | null } = {}): DemMemory {
  return createDemMemory({
    path: ":memory:",
    bankId: "bank",
    embed: hashEmbedder(),
    rerank: "none",
    supersession: "slot",
    ...(options.normalizer ? { slotNormalizer: options.normalizer } : {}),
    extract: async () => {
      throw new Error("these tests hand facts in directly");
    },
    generate: async () => {
      throw new Error("no answers here");
    },
  });
}

/** Every row of the bank, active or not, oldest first. */
function rows(
  memory: DemMemory,
): Array<{ object: string; valid_end: string; slot: string | null; closed_by: string | null; provenance: string }> {
  return memory.database
    .prepare(
      `SELECT object, valid_end, slot, closed_by, provenance FROM memories ORDER BY rowid`,
    )
    .all() as Array<{
    object: string;
    valid_end: string;
    slot: string | null;
    closed_by: string | null;
    provenance: string;
  }>;
}

const active = (memory: DemMemory): string[] =>
  rows(memory)
    .filter((row) => row.valid_end === INFINITY_SENTINEL)
    .map((row) => row.object);

async function write(
  memory: DemMemory,
  facts: ExtractedFact[],
  provenance?: Provenance,
): Promise<{ invalidatedCount: number; selfClosedCount: number }> {
  const result = await memory.retain(
    { facts },
    { now: "2024-01-01T00:00:00.000Z", ...(provenance ? { provenance } : {}) },
  );
  return { invalidatedCount: result.invalidatedCount, selfClosedCount: result.selfClosedCount };
}

describe("slot derivation on the write path", () => {
  it("stores the derived slot for a relation the synonym table knows", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    expect(rows(memory)[0]?.slot).toBe("lives_in");
    memory.close();
  });

  it("maps a SYNONYM of a slot, not just its own name", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "resides_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    expect(rows(memory)[0]?.slot).toBe("lives_in");
    memory.close();
  });

  it("leaves slot NULL for everything else — the safe default and most of the corpus", async () => {
    const memory = slotMemory();
    await write(memory, [
      fact("assistant", "recommended", "a restaurant", "2023-01-01T00:00:00.000Z"),
      fact("user", "likes_artist", "Khalid", "2023-01-01T00:00:00.000Z"),
    ]);
    expect(rows(memory).map((row) => row.slot)).toEqual([null, null]);
    memory.close();
  });

  it("does not derive a slot at all under the default mode", async () => {
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
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    expect(rows(memory)[0]?.slot).toBeNull();
    memory.close();
  });

  it("takes an injected normalizer, which is how the measured-off embedding stage opts in", async () => {
    const memory = slotMemory({ normalizer: (relation) => (relation === "dwells" ? "lives_in" : null) });
    await write(memory, [
      fact("user", "dwells", "Boston", "2023-01-01T00:00:00.000Z"),
      fact("user", "lives_in", "Denver", "2023-02-01T00:00:00.000Z"),
    ]);
    // The injected normalizer REPLACES the table rather than extending it, so `lives_in`
    // itself no longer maps and the two rows do not interact.
    expect(rows(memory).map((row) => row.slot)).toEqual(["lives_in", null]);
    expect(active(memory)).toEqual(["Boston", "Denver"]);
    memory.close();
  });
});

describe("rule 1 — close the prior, and only the prior", () => {
  it("closes exactly the previous row of the same (subject, slot)", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    const { invalidatedCount } = await write(memory, [
      fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z"),
    ]);
    expect(invalidatedCount).toBe(1);
    expect(active(memory)).toEqual(["Seattle"]);
    memory.close();
  });

  it("closes across DIFFERENT relations that share a slot — what exact-predicate matching cannot do", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    await write(memory, [fact("user", "resides_in", "Seattle", "2023-06-01T00:00:00.000Z")]);
    expect(active(memory)).toEqual(["Seattle"]);
    memory.close();
  });

  it("leaves other slots and other subjects alone", async () => {
    const memory = slotMemory();
    await write(memory, [
      fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
      fact("user", "works_at", "Acme", "2023-01-01T00:00:00.000Z"),
      fact("alice", "lives_in", "Denver", "2023-01-01T00:00:00.000Z"),
    ]);
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")]);
    expect(active(memory).sort()).toEqual(["Acme", "Denver", "Seattle"]);
    memory.close();
  });

  it("ignores invalidatesPrevious entirely — the flag is not consulted in slot mode", async () => {
    const memory = slotMemory();
    await write(memory, [
      fact("assistant", "recommended", "one", "2023-01-01T00:00:00.000Z"),
      fact("assistant", "recommended", "two", "2023-02-01T00:00:00.000Z", true),
    ]);
    expect(active(memory)).toEqual(["one", "two"]);
    memory.close();
  });

  it("records closed_by, so a closure is auditable and reversible", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")]);
    const [boston, seattle] = rows(memory);
    const ids = memory.database.prepare(`SELECT id, object FROM memories`).all() as Array<{
      id: string;
      object: string;
    }>;
    const seattleId = ids.find((row) => row.object === "Seattle")?.id;
    expect(boston?.closed_by).toBe(seattleId);
    expect(boston?.valid_end).toBe("2023-06-01T00:00:00.000Z");
    expect(seattle?.closed_by).toBeNull();
    memory.close();
  });

  it("settles a slot WITHIN one batch, in the order the facts arrive", async () => {
    const memory = slotMemory();
    // DEM's own rule runs before any insert, so a batch's facts were never candidates for
    // each other. The slot rule settles each statement as it lands, which is why one
    // `chat:end` emitting two `lives_in` facts leaves one active row rather than two.
    await write(memory, [
      fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
      fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z"),
    ]);
    expect(active(memory)).toEqual(["Seattle"]);
    memory.close();
  });
});

describe("rule 2 — two-sided closure", () => {
  it("closes the BACKDATED row itself rather than letting both stay active", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")]);
    const { invalidatedCount, selfClosedCount } = await write(memory, [
      fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
    ]);
    expect(invalidatedCount).toBe(0);
    expect(selfClosedCount).toBe(1);
    expect(active(memory)).toEqual(["Seattle"]);
    memory.close();
  });

  it("bounds the backdated row at the EARLIEST later row, not the latest", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Denver", "2023-09-01T00:00:00.000Z")]);
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")]);
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    const boston = rows(memory).find((row) => row.object === "Boston");
    // Bounded by Seattle (the earliest row after it), not by Denver.
    expect(boston?.valid_end).toBe("2023-06-01T00:00:00.000Z");
    expect(active(memory)).toEqual(["Denver"]);
    memory.close();
  });

  it("reports the closure on the returned tuple, not just in the store", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")]);
    const result = await memory.retain(
      { facts: [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")] },
      { now: "2024-01-01T00:00:00.000Z" },
    );
    // A caller reading validEnd off the result must not be told the row is still active.
    expect(result.tuples[0]?.validEnd).toBe("2023-06-01T00:00:00.000Z");
    expect(result.tuples[0]?.closedBy).toBeTruthy();
    memory.close();
  });
});

/**
 * The property the three rules exist to produce, asserted directly rather than inferred from
 * them. A rule set can pass every one of its own cases and still leave the store in a state
 * no query can read correctly — which is exactly what the literal reading of §3.4 rule 2 did:
 * newest-first arrival left two rows both claiming where one person lived in July.
 */
describe("the invariant: one (subject, slot) history is a non-overlapping chain", () => {
  const JAN = "2023-01-01T00:00:00.000Z";
  const JUN = "2023-06-01T00:00:00.000Z";
  const SEP = "2023-09-01T00:00:00.000Z";

  /** Every permutation of three values, so no arrival order is privileged. */
  const orders: Array<Array<[string, string]>> = [
    [["Boston", JAN], ["Seattle", JUN], ["Denver", SEP]],
    [["Boston", JAN], ["Denver", SEP], ["Seattle", JUN]],
    [["Seattle", JUN], ["Boston", JAN], ["Denver", SEP]],
    [["Seattle", JUN], ["Denver", SEP], ["Boston", JAN]],
    [["Denver", SEP], ["Boston", JAN], ["Seattle", JUN]],
    [["Denver", SEP], ["Seattle", JUN], ["Boston", JAN]],
  ];

  for (const order of orders) {
    const label = order.map(([city]) => city).join(" -> ");
    it(`holds when the values arrive ${label}`, async () => {
      const memory = slotMemory();
      for (const [city, when] of order) {
        await write(memory, [fact("user", "lives_in", city, when)]);
      }

      const chain = (
        memory.database
          .prepare(
            `SELECT object, valid_start, valid_end FROM memories ORDER BY valid_start`,
          )
          .all() as Array<{ object: string; valid_start: string; valid_end: string }>
      );

      // Whatever order they arrived in, the store reads the same history.
      expect(chain.map((row) => row.object)).toEqual(["Boston", "Seattle", "Denver"]);
      // Exactly one row is active, and it is the newest.
      expect(chain.filter((row) => row.valid_end === INFINITY_SENTINEL).map((r) => r.object)).toEqual([
        "Denver",
      ]);
      // Each row ends exactly where its successor begins: a chain, with no gap and no overlap.
      for (let i = 0; i < chain.length - 1; i += 1) {
        expect(chain[i]?.valid_end, `${chain[i]?.object} should end where ${chain[i + 1]?.object} starts`).toBe(
          chain[i + 1]?.valid_start,
        );
      }
      memory.close();
    });
  }

  it("asks the store as of a past instant and gets exactly one answer", async () => {
    // The consequence a reader actually feels. Under the literal rule this returned two.
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Denver", SEP)]);
    await write(memory, [fact("user", "lives_in", "Seattle", JUN)]);
    await write(memory, [fact("user", "lives_in", "Boston", JAN)]);

    const july = "2023-07-01T00:00:00.000Z";
    const live = memory.database
      .prepare(
        `SELECT object FROM memories WHERE valid_start <= ? AND ? < valid_end ORDER BY valid_start`,
      )
      .all(july, july) as Array<{ object: string }>;
    expect(live.map((row) => row.object)).toEqual(["Seattle"]);
    memory.close();
  });
});

describe("rule 3 — provenance immunity", () => {
  it("does not let an extracted row close a human one", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-01-01T00:00:00.000Z")], "human");
    const { invalidatedCount } = await write(memory, [
      fact("user", "lives_in", "Boston", "2023-06-01T00:00:00.000Z"),
    ]);
    expect(invalidatedCount).toBe(0);
    expect(active(memory).sort()).toEqual(["Boston", "Seattle"]);
    memory.close();
  });

  it("does not let a human row BOUND an extracted one either — immunity is two-directional", async () => {
    // If rule 3 were applied only to rule 1, an extracted row written after a human set a
    // LATER value would arrive dead on every turn, which is a silent way to stop recording.
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")], "human");
    const { selfClosedCount } = await write(memory, [
      fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
    ]);
    expect(selfClosedCount).toBe(0);
    memory.close();
  });

  it("lets a human row close an extracted one", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    const { invalidatedCount } = await write(
      memory,
      [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")],
      "human",
    );
    expect(invalidatedCount).toBe(1);
    expect(active(memory)).toEqual(["Seattle"]);
    memory.close();
  });

  it("lets an agent row close an extracted one, and not the other way round", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")], "agent");
    expect(active(memory)).toEqual(["Seattle"]);

    const { invalidatedCount } = await write(memory, [
      fact("user", "lives_in", "Denver", "2023-09-01T00:00:00.000Z"),
    ]);
    expect(invalidatedCount).toBe(0);
    expect(active(memory).sort()).toEqual(["Denver", "Seattle"]);
    memory.close();
  });

  it("defaults to `extracted`, because `retain` is the observer's door", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    expect(rows(memory)[0]?.provenance).toBe("extracted");
    memory.close();
  });
});

describe("rule 4 — equal validStart", () => {
  it("lets the later transaction win, because that is what a correction is", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    const { invalidatedCount } = await write(memory, [
      fact("user", "lives_in", "Seattle", "2023-01-01T00:00:00.000Z"),
    ]);
    expect(invalidatedCount).toBe(1);
    expect(active(memory)).toEqual(["Seattle"]);
    memory.close();
  });
});

describe("closure reaches retrieval, which is the point of it", () => {
  it("drops a closed row out of the candidate set", async () => {
    // All four channels apply `validityClause`, which defaults to `valid_end = INFINITY`.
    // If that ever stopped being true, closure would become bookkeeping with no effect and
    // every number measured about it would be meaningless.
    const memory = slotMemory();
    await write(memory, [fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z")]);
    const before = await memory.recall("where does the user live", { limit: 10 });
    expect(before.tuples.map((tuple) => tuple.object)).toContain("Boston");

    await write(memory, [fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z")]);
    const after = await memory.recall("where does the user live", { limit: 10 });
    expect(after.tuples.map((tuple) => tuple.object)).toContain("Seattle");
    expect(after.tuples.map((tuple) => tuple.object)).not.toContain("Boston");
    memory.close();
  });
});

describe("forget — the explicit close", () => {
  it("closes the named rows and reports which it actually closed", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "likes_artist", "Khalid", "2023-01-01T00:00:00.000Z")]);
    const id = (memory.database.prepare(`SELECT id FROM memories`).get() as { id: string }).id;

    expect(memory.forget([id], "2024-01-01T00:00:00.000Z")).toEqual([id]);
    expect(active(memory)).toEqual([]);
    memory.close();
  });

  it("leaves closed_by NULL, which is how a delete is told from a supersession", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "likes_artist", "Khalid", "2023-01-01T00:00:00.000Z")]);
    const id = (memory.database.prepare(`SELECT id FROM memories`).get() as { id: string }).id;
    memory.forget([id], "2024-01-01T00:00:00.000Z");
    expect(rows(memory)[0]?.closed_by).toBeNull();
    memory.close();
  });

  it("refuses an id from another bank, and says so by not listing it", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "likes_artist", "Khalid", "2023-01-01T00:00:00.000Z")]);
    const id = (memory.database.prepare(`SELECT id FROM memories`).get() as { id: string }).id;
    memory.setBank("someone-else");
    expect(memory.forget([id], "2024-01-01T00:00:00.000Z")).toEqual([]);
    memory.setBank("bank");
    expect(active(memory)).toEqual(["Khalid"]);
    memory.close();
  });

  it("is idempotent — closing an already-closed row reports nothing closed", async () => {
    const memory = slotMemory();
    await write(memory, [fact("user", "likes_artist", "Khalid", "2023-01-01T00:00:00.000Z")]);
    const id = (memory.database.prepare(`SELECT id FROM memories`).get() as { id: string }).id;
    memory.forget([id], "2024-01-01T00:00:00.000Z");
    expect(memory.forget([id], "2024-02-01T00:00:00.000Z")).toEqual([]);
    memory.close();
  });
});
