import { describe, expect, it } from "vitest";
import {
  replayBank,
  sessionPrefix,
  type ReplayFact,
  type ReplayStats,
  type Rule,
} from "../bench/supersession-replay.js";
import type { Slot } from "../bench/slots.js";

/**
 * Hermetic pins on the two invalidation rules the replay compares.
 *
 * `bench/supersession-replay.ts` reports what each rule does to 130,779 real facts; these
 * tests pin what each rule IS, on fixtures small enough to read. The measurement can only
 * be trusted if the rule it implements is the rule the design describes — and two of these
 * cases (two-sided closure, provenance immunity) CANNOT be exercised by the corpus at all,
 * so a unit test is the only place they are checked.
 */

function stats(rule: Rule): ReplayStats {
  return {
    scope: "lifetime",
    rule,
    order: "session",
    banks: 0,
    ingests: 0,
    flagged: 0,
    flagsWithPrior: 0,
    slotted: 0,
    closers: 0,
    rowsClosed: 0,
    selfClosed: 0,
    twoSidedMisses: 0,
    closedPerCloser: [],
    byKey: new Map(),
  };
}

function fact(
  subject: string,
  predicate: string,
  object: string,
  validStart: string,
  extra: Partial<ReplayFact> = {},
): ReplayFact {
  return {
    subject,
    predicate,
    object,
    validStart,
    invalidatesPrevious: false,
    provenance: "extracted",
    seq: 0,
    ...extra,
  };
}

/** The eight-slot map, reduced to what each fixture needs. */
const slotOf =
  (map: Record<string, Slot>) =>
  (predicate: string): Slot | null =>
    map[predicate] ?? null;

const LIVES = slotOf({ lives_in: "lives_in", moved_to: "lives_in", home_city: "lives_in" });
const NONE = (): Slot | null => null;

describe("sessionPrefix", () => {
  it("strips a trailing session index", () => {
    expect(sessionPrefix("94bc18df_3")).toBe("94bc18df");
    expect(sessionPrefix("sharegpt_0mQbhwr_0")).toBe("sharegpt_0mQbhwr");
  });

  it("leaves an id with no underscore alone", () => {
    expect(sessionPrefix("f10be626")).toBe("f10be626");
  });
});

describe("DEM's rule, as `memory-repository.ts` codes it", () => {
  it("closes an active prior on an exact (subject, predicate) match", () => {
    const s = stats("dem");
    replayBank(
      [
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
        fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z", {
          invalidatesPrevious: true,
        }),
      ],
      "dem",
      s,
      NONE,
    );
    expect(s.flagged).toBe(1);
    expect(s.flagsWithPrior).toBe(1);
    expect(s.rowsClosed).toBe(1);
  });

  it("finds nothing when the prior used a different predicate spelling", () => {
    // 91.8% of flags land here on the real corpus. `current_routine` vs
    // `changed_water_change_routine` is a measured example.
    const s = stats("dem");
    replayBank(
      [
        fact("user", "current_routine", "weekly", "2023-01-01T00:00:00.000Z"),
        fact("user", "changed_water_change_routine", "biweekly", "2023-06-01T00:00:00.000Z", {
          invalidatesPrevious: true,
        }),
      ],
      "dem",
      s,
      NONE,
    );
    expect(s.flagged).toBe(1);
    expect(s.flagsWithPrior).toBe(0);
    expect(s.rowsClosed).toBe(0);
  });

  it("is ONE-DIRECTIONAL: a backdated fact leaves a later prior active beside it", () => {
    // `valid_start <= ?` is the whole of it. The design calls this the two-sided gap.
    const s = stats("dem");
    replayBank(
      [
        fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z"),
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z", {
          invalidatesPrevious: true,
        }),
      ],
      "dem",
      s,
      NONE,
    );
    expect(s.rowsClosed).toBe(0);
    expect(s.twoSidedMisses).toBe(1);
  });

  it("closes EVERY active row under one key — the lifetime over-closure", () => {
    // `assistant | recommended` closed 360 rows on one statement in the real lifetime bank.
    const s = stats("dem");
    const facts = Array.from({ length: 12 }, (_, i) =>
      fact("assistant", "recommended", `thing ${i}`, `2023-0${(i % 9) + 1}-01T00:00:00.000Z`),
    );
    facts.push(
      fact("assistant", "recommended", "one more", "2023-12-01T00:00:00.000Z", {
        invalidatesPrevious: true,
      }),
    );
    replayBank(facts, "dem", s, NONE);
    expect(s.rowsClosed).toBe(12);
    expect(s.byKey.get("assistant | recommended")?.max).toBe(12);
  });
});

describe("the slot rule (§3.3-3.4)", () => {
  it("closes EXACTLY the prior for a slot relation, not everything under the subject", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
        fact("user", "likes_artist", "Khalid", "2023-02-01T00:00:00.000Z"),
        fact("user", "has_sibling", "Sophia", "2023-03-01T00:00:00.000Z"),
        fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z"),
      ],
      "slot",
      s,
      LIVES,
    );
    expect(s.rowsClosed).toBe(1);
    expect(s.byKey.get("user | lives_in")?.rowsClosed).toBe(1);
    // The multi-valued relations are untouched: closure never leaves the slot.
    expect([...s.byKey.keys()]).toEqual(["user | lives_in"]);
  });

  it("fires WITHOUT invalidatesPrevious — the flag is not consulted", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
        fact("user", "moved_to", "Seattle", "2023-06-01T00:00:00.000Z"),
      ],
      "slot",
      s,
      LIVES,
    );
    expect(s.rowsClosed).toBe(1);
    expect(s.flagged).toBe(0);
  });

  it("closes a prior recorded under a DIFFERENT relation in the same slot", () => {
    // This is the half DEM's exact-predicate match cannot do: `home_city` supersedes
    // `lives_in` because they share a slot, not a spelling.
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
        fact("user", "home_city", "Seattle", "2023-06-01T00:00:00.000Z"),
      ],
      "slot",
      s,
      LIVES,
    );
    expect(s.rowsClosed).toBe(1);
  });

  it("is TWO-SIDED: a backdated row is closed by the later row already active", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z"),
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
      ],
      "slot",
      s,
      LIVES,
    );
    // The backdated Boston row does not close Seattle...
    expect(s.rowsClosed).toBe(0);
    // ...it closes ITSELF at Seattle's start, so "active" still means one row.
    expect(s.selfClosed).toBe(1);
  });

  it("bounds a backdated row at the EARLIEST later row, not the latest", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Denver", "2023-09-01T00:00:00.000Z"),
        fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z"),
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
      ],
      "slot",
      s,
      LIVES,
    );
    // Seattle is bounded by Denver; Boston is bounded by Seattle (the earliest later row),
    // and neither closes anything ahead of it.
    expect(s.selfClosed).toBe(2);
    expect(s.rowsClosed).toBe(0);
  });

  it("gives PROVENANCE IMMUNITY: an extracted row cannot close a human one", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Seattle", "2023-01-01T00:00:00.000Z", { provenance: "human" }),
        fact("user", "lives_in", "Boston", "2023-06-01T00:00:00.000Z", { provenance: "extracted" }),
      ],
      "slot",
      s,
      LIVES,
    );
    expect(s.rowsClosed).toBe(0);
  });

  it("lets a human row close an extracted one", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z", { provenance: "extracted" }),
        fact("user", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z", { provenance: "human" }),
      ],
      "slot",
      s,
      LIVES,
    );
    expect(s.rowsClosed).toBe(1);
  });

  it("closes an equal-`when` prior — the later transaction time wins", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
        fact("user", "lives_in", "Seattle", "2023-01-01T00:00:00.000Z"),
      ],
      "slot",
      s,
      LIVES,
    );
    expect(s.rowsClosed).toBe(1);
  });

  it("closes NOTHING for a relation with no slot, however often it repeats", () => {
    // THE RUNG-0 GATE. `assistant | recommended` is the worst over-closer under DEM's rule
    // (360 rows on one statement in the lifetime bank). Under the slot design it has no
    // slot, so it closes nothing — and the flag does not change that.
    const s = stats("slot");
    const facts = Array.from({ length: 40 }, (_, i) =>
      fact("assistant", "recommended", `thing ${i}`, `2023-01-0${(i % 9) + 1}T00:00:00.000Z`, {
        invalidatesPrevious: i % 3 === 0,
      }),
    );
    replayBank(facts, "slot", s, LIVES);
    expect(s.rowsClosed).toBe(0);
    expect(s.slotted).toBe(0);
    expect(s.byKey.size).toBe(0);
  });

  it("keeps different subjects apart — one person's move does not close another's", () => {
    const s = stats("slot");
    replayBank(
      [
        fact("user:alice", "lives_in", "Boston", "2023-01-01T00:00:00.000Z"),
        fact("user:bob", "lives_in", "Denver", "2023-02-01T00:00:00.000Z"),
        fact("user:alice", "lives_in", "Seattle", "2023-06-01T00:00:00.000Z"),
      ],
      "slot",
      s,
      LIVES,
    );
    expect(s.rowsClosed).toBe(1);
    expect(s.byKey.get("user:alice | lives_in")?.rowsClosed).toBe(1);
    expect(s.byKey.has("user:bob | lives_in")).toBe(false);
  });
});
