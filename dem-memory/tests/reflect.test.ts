import { describe, expect, it } from "vitest";
import { compileEvidenceTable, buildReflectSystemPrompt } from "../src/engine/reflect.js";
import { INFINITY_SENTINEL, type GenerateFn, type MemoryTuple } from "../src/types.js";
import { createTestMemory, fixtureExtractor, fixtureSession } from "./helpers.js";

const NOW = "2025-01-15T10:01:00.000Z";

function syntheticTuple(index: number): MemoryTuple {
  return {
    id: `id-${String(index).padStart(4, "0")}`,
    bankId: "test",
    network: index % 3 === 0 ? "opinion" : "world",
    subject: `entity_${index}`,
    predicate: "has_property",
    object: `a reasonably verbose statement of fact number ${index} with several words in it`,
    confidence: 0.9,
    validStart: "2025-01-01T00:00:00.000Z",
    validEnd: INFINITY_SENTINEL,
    transactionTime: "2025-01-01T00:00:00.000Z",
  };
}

describe("reflect", () => {
  it("aborts with [DATA_ABSENT] without calling the model when no evidence is recalled", async () => {
    let generateCalls = 0;
    const memory = await createTestMemory({
      generate: (async () => {
        generateCalls += 1;
        return "should not happen";
      }) as GenerateFn,
    });

    const result = await memory.reflect("what is sam's favorite color?");

    expect(result.answer).toBe("[DATA_ABSENT]");
    expect(result.abstained).toBe(true);
    expect(result.evidence).toHaveLength(0);
    expect(generateCalls).toBe(0);

    memory.close();
  });

  it("passes the evidence table and abstention directive to the model in a single pass", async () => {
    const seen: Array<{ system: string; prompt: string }> = [];
    const memory = await createTestMemory({
      extract: fixtureExtractor("session-1"),
      generate: async ({ system, prompt }) => {
        seen.push({ system, prompt });
        return "Sam prefers Python FastAPI.";
      },
    });
    await memory.retain(fixtureSession("session-1").turns, { now: NOW });

    const result = await memory.reflect("what backend does sam prefer?");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe("what backend does sam prefer?");
    expect(seen[0]?.system).toContain("[DATA_ABSENT]");
    expect(seen[0]?.system).toContain("Skepticism (S=3/5)");
    expect(seen[0]?.system).toContain("prefers backend: Python FastAPI");
    expect(result.answer).toBe("Sam prefers Python FastAPI.");
    expect(result.abstained).toBe(false);
    expect(result.evidence.length).toBeGreaterThan(0);

    memory.close();
  });

  it("caps the evidence table at the configured token budget", async () => {
    const tuples = Array.from({ length: 500 }, (_, index) => syntheticTuple(index));
    const compiled = compileEvidenceTable(tuples, { maxTokens: 2000 });

    expect(compiled.rows.length).toBeLessThan(500);
    expect(compiled.tokens).toBeLessThanOrEqual(2000);
    expect(compiled.table.startsWith("| Network | When | Confidence | Statement |")).toBe(true);
    // Rows are truncated from the tail, preserving the highest-ranked evidence.
    expect(compiled.rows[0]?.id).toBe("id-0000");
  });

  it("keeps the full table when the budget is not binding", async () => {
    const tuples = Array.from({ length: 5 }, (_, index) => syntheticTuple(index));
    const compiled = compileEvidenceTable(tuples, { maxTokens: 2000 });
    expect(compiled.rows).toHaveLength(5);
    expect(compiled.table.split("\n")).toHaveLength(7);
  });

  it("tags the four epistemic networks in the evidence table", () => {
    const table = compileEvidenceTable(
      [
        syntheticTuple(0),
        { ...syntheticTuple(1), network: "opinion" },
        { ...syntheticTuple(2), network: "observation" },
        { ...syntheticTuple(3), network: "experience" },
      ],
      { maxTokens: 2000 },
    ).table;
    expect(table).toContain("[FACT]");
    expect(table).toContain("[OPIN]");
    expect(table).toContain("[OBS]");
  });

  it("dates an open record plainly and flags a closed one as superseded", () => {
    const table = compileEvidenceTable([syntheticTuple(0)], { maxTokens: 2000 }).table;
    expect(table).toContain("2025-01-01 (Wed)");
    expect(table).not.toContain("infinity");
    const closed = compileEvidenceTable(
      [{ ...syntheticTuple(0), validEnd: "2025-02-01T00:00:00.000Z" }],
      { maxTokens: 2000 },
    ).table;
    expect(closed).toContain("2025-01-01 (Wed) → superseded 2025-02-01");
  });

  it("builds a system prompt carrying disposition ratings", () => {
    const prompt = buildReflectSystemPrompt("| Network |", {
      skepticism: 5,
      literalism: 1,
      empathy: 4,
    });
    expect(prompt).toContain("S=5/5");
    expect(prompt).toContain("L=1/5");
    expect(prompt).toContain("E=4/5");
    expect(prompt).toContain("[DATA_ABSENT]");
  });

  it("honors maxContextTokens passed through reflect options", async () => {
    const memory = await createTestMemory({
      extract: fixtureExtractor("session-1"),
      generate: async () => "grounded",
    });
    await memory.retain(fixtureSession("session-1").turns, { now: NOW });

    const tiny = await memory.reflect("sam backend", { maxContextTokens: 50 });
    expect(tiny.tokens).toBeLessThanOrEqual(50);
    expect(tiny.evidence.length).toBeLessThan(2);

    const roomy = await memory.reflect("sam backend", { maxContextTokens: 2000 });
    expect(roomy.tokens).toBeLessThanOrEqual(2000);
    expect(roomy.evidence.length).toBeGreaterThanOrEqual(tiny.evidence.length);

    memory.close();
  });
});
