import { describe, expect, it } from "vitest";
import {
  compileEvidenceTable,
  buildReflectSystemPrompt,
  evidenceTableRow,
  relativeTime,
} from "../src/engine/reflect.js";
import { INFINITY_SENTINEL, type IngestionPayload, type MemoryTuple } from "../src/types.js";
import { createTestMemory } from "./helpers.js";

function tuple(overrides: Partial<MemoryTuple> & Pick<MemoryTuple, "id" | "validStart">): MemoryTuple {
  return {
    bankId: "test",
    network: "world",
    subject: "user",
    predicate: "attended_event",
    object: "a thing happened",
    validEnd: INFINITY_SENTINEL,
    transactionTime: overrides.validStart,
    ...overrides,
  };
}

function facts(...entries: Array<Partial<IngestionPayload["facts"][number]>>): IngestionPayload {
  return {
    facts: entries.map((entry) => ({
      network: "world" as const,
      subject: "user",
      predicate: "attended_event",
      object: "a thing happened",
      validStart: "2023-01-01T00:00:00.000Z",
      invalidatesPrevious: false,
      ...entry,
    })),
  };
}

describe("relativeTime", () => {
  // Each case is a real LongMemEval-S temporal question whose gold answer is the
  // elapsed time the answerer failed to compute for itself.
  it.each([
    // 5e1b23de: "How many months ago did I attend the photography workshop?" -> gold 3
    ["2023-11-01T00:00:00.000Z", "2024-02-01T18:06:00.000Z", "3 months ago"],
    // 0bc8ad92: "How many months have passed since I last visited a museum?" -> gold 5
    ["2022-10-22T00:00:00.000Z", "2023-03-25T17:18:00.000Z", "5 months ago"],
    // gpt4_e072b769: "How many weeks ago did I start using Ibotta?" -> gold 3 weeks
    ["2023-04-16T00:00:00.000Z", "2023-05-06T09:18:00.000Z", "3 weeks ago"],
    // gpt4_d6585ce9: "...last Saturday" -> the event is exactly 7 days back
    ["2023-04-15T00:00:00.000Z", "2023-04-22T08:01:00.000Z", "7 days ago"],
  ])("renders %s relative to %s as %s", (from, to, expected) => {
    expect(relativeTime(from, to)).toBe(expected);
  });

  it("labels the reference day itself and future-dated records", () => {
    expect(relativeTime("2024-02-01T09:00:00.000Z", "2024-02-01T18:06:00.000Z")).toBe("today");
    expect(relativeTime("2024-02-08T00:00:00.000Z", "2024-02-01T00:00:00.000Z")).toBe("in 7 days");
  });

  it("counts calendar months, not 30-day blocks", () => {
    // Feb is short: a naive days/30 would call this 2 months.
    expect(relativeTime("2023-12-31T00:00:00.000Z", "2024-03-01T00:00:00.000Z")).toBe("2 months ago");
  });
});

describe("evidence table temporal grounding", () => {
  it("states the event date, its weekday, and its distance from the reference time", () => {
    const row = evidenceTableRow(tuple({ id: "a", validStart: "2023-04-15T00:00:00.000Z" }), {
      asOf: "2023-04-22T08:01:00.000Z",
    });
    expect(row).toContain("2023-04-15");
    expect(row).toContain("Sat");
    expect(row).toContain("7 days ago");
  });

  it("omits the relative clause when no reference time is supplied", () => {
    const row = evidenceTableRow(tuple({ id: "a", validStart: "2023-04-15T00:00:00.000Z" }));
    expect(row).toContain("2023-04-15");
    expect(row).not.toContain("ago");
  });

  it("marks a superseded record with the date it stopped being true", () => {
    const row = evidenceTableRow(
      tuple({ id: "a", validStart: "2023-01-01T00:00:00.000Z", validEnd: "2023-06-01T00:00:00.000Z" }),
      { asOf: "2023-07-01T00:00:00.000Z" },
    );
    expect(row).toContain("2023-01-01");
    expect(row).toContain("superseded");
    expect(row).toContain("2023-06-01");
    expect(row).not.toContain("infinity");
  });

  const unordered = [
    tuple({ id: "c", validStart: "2023-03-01T00:00:00.000Z" }),
    tuple({ id: "a", validStart: "2023-01-01T00:00:00.000Z" }),
    tuple({ id: "b", validStart: "2023-02-01T00:00:00.000Z" }),
  ];

  it("keeps rank order by default so the top-ranked row is read first", () => {
    const compiled = compileEvidenceTable(unordered, { asOf: "2023-04-01T00:00:00.000Z" });
    expect(compiled.rows.map((row) => row.id)).toEqual(["c", "a", "b"]);
  });

  it("orders rows oldest-first only when explicitly asked", () => {
    const compiled = compileEvidenceTable(unordered, {
      asOf: "2023-04-01T00:00:00.000Z",
      chronological: true,
    });
    expect(compiled.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("drops the lowest-RANKED rows when trimming, then orders what survives by date", () => {
    // Rank order is c, a, b (as passed). A budget for two rows must keep c and a --
    // sorting before trimming would silently discard the top-ranked row instead.
    const ranked = [
      tuple({ id: "c", validStart: "2023-03-01T00:00:00.000Z" }),
      tuple({ id: "a", validStart: "2023-01-01T00:00:00.000Z" }),
      tuple({ id: "b", validStart: "2023-02-01T00:00:00.000Z" }),
    ];
    const twoRowBudget = compileEvidenceTable(ranked.slice(0, 2), {
      asOf: "2023-04-01T00:00:00.000Z",
      chronological: true,
    }).tokens;
    const compiled = compileEvidenceTable(ranked, {
      asOf: "2023-04-01T00:00:00.000Z",
      chronological: true,
      maxTokens: twoRowBudget,
    });
    expect(compiled.rows).toHaveLength(2);
    expect(compiled.rows.map((row) => row.id)).toEqual(["a", "c"]);
  });
});

describe("reflect prompt", () => {
  it("tells the model what 'now' is so relative questions are answerable", () => {
    const prompt = buildReflectSystemPrompt("| table |", undefined, {
      asOf: "2023-04-22T08:01:00.000Z",
    });
    expect(prompt).toContain("2023-04-22");
    expect(prompt).toContain("Saturday");
  });

  it("omits the reference-time line entirely when no reference time is known", () => {
    const prompt = buildReflectSystemPrompt("| table |");
    expect(prompt).not.toContain("Today is");
  });
});

describe("asOf versus temporalAnchor", () => {
  const FUTURE_DATED = "2023-09-01T00:00:00.000Z";
  const ASK_TIME = "2023-06-01T00:00:00.000Z";

  async function seeded() {
    const memory = await createTestMemory({ rerank: "none" });
    await memory.retain(
      facts(
        { subject: "user", predicate: "booked_trip", object: "flight to Lisbon", validStart: FUTURE_DATED },
        { subject: "user", predicate: "moved_to", object: "Austin", validStart: "2023-01-01T00:00:00.000Z" },
      ),
      { now: "2023-05-01T00:00:00.000Z" },
    );
    return memory;
  }

  it("temporalAnchor is a validity filter: it evicts records that postdate the anchor", async () => {
    const memory = await seeded();
    const anchored = await memory.recall("user", { temporalAnchor: ASK_TIME });
    expect(anchored.tuples.map((t) => t.predicate)).not.toContain("booked_trip");
    memory.close();
  });

  it("asOf is a reference time only: it changes the prompt, never the candidate set", async () => {
    const memory = await seeded();
    const plain = await memory.recall("user");
    const dated = await memory.recall("user", { asOf: ASK_TIME });
    expect(dated.tuples.map((t) => t.id).sort()).toEqual(plain.tuples.map((t) => t.id).sort());
    expect(dated.tuples.map((t) => t.predicate)).toContain("booked_trip");
    memory.close();
  });

  it("reflect grounds on asOf, falling back to temporalAnchor as the epistemic present", async () => {
    const seen: string[] = [];
    const memory = await createTestMemory({
      rerank: "none",
      generate: async ({ system }) => {
        seen.push(system);
        return "ok";
      },
    });
    await memory.retain(facts({ validStart: "2023-01-01T00:00:00.000Z" }), {
      now: "2023-01-01T00:00:00.000Z",
    });

    await memory.reflect("what happened?", { asOf: ASK_TIME });
    expect(seen[0]).toContain("2023-06-01");

    await memory.reflect("what happened?", { temporalAnchor: ASK_TIME });
    expect(seen[1]).toContain("2023-06-01");

    memory.close();
  });
});
