import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVIDENCE_ROW_CAP,
  DEFAULT_EVIDENCE_ROWS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  estimateTokens,
  type GenerateFn,
  type IngestionPayload,
} from "../src/types.js";
import { createTestMemory } from "./helpers.js";

const NOW = "2023-05-30T10:00:00.000Z";

/**
 * Across three scored n=100 runs (300 questions), the 2000-token evidence budget bound
 * ZERO times: every question returned exactly 15 rows using 26%-44% of the budget, because
 * `reflect` asked recall for a hardcoded 15. `compileEvidenceTable`'s rank-ordered
 * token-budget trim — the thing that is supposed to decide how much evidence fits — had
 * therefore never executed in a scored run.
 *
 * It matters most exactly where the system was weakest: a terse extractor (gpt-4.1-nano)
 * produced 67-character facts, so 15 rows carried ~528 tokens of a 2000-token allowance,
 * and 26 of its 56 answerable failures had the gold sitting in the bank below the cut.
 */
function facts(count: number, objectText: string): IngestionPayload {
  return {
    facts: Array.from({ length: count }, (_, i) => ({
      network: "world" as const,
      subject: `entity_${i}`,
      predicate: "has_property",
      object: `${objectText} ${i}`,
      validStart: NOW,
      confidence: 1,
      invalidatesPrevious: false,
    })),
  };
}

const answerer: GenerateFn = async () => "an answer";

describe("evidence budget", () => {
  it("defaults to the cheap row count — filling the budget was measured score-neutral at 1.93x cost", async () => {
    const memory = await createTestMemory({ generate: answerer });
    await memory.retain(facts(70, "terse"), { now: NOW });

    const result = await memory.reflect("entity", { asOf: NOW });

    expect(result.evidence).toHaveLength(DEFAULT_EVIDENCE_ROWS);
    memory.close();
  });

  it("fills the token budget when a caller opts in with a larger limit", async () => {
    const memory = await createTestMemory({ generate: answerer });
    await memory.retain(facts(70, "terse"), { now: NOW });

    const result = await memory.reflect("entity", { asOf: NOW, limit: DEFAULT_EVIDENCE_ROW_CAP });

    expect(result.evidence.length).toBeGreaterThan(DEFAULT_EVIDENCE_ROWS);
    expect(result.tokens).toBeGreaterThan(DEFAULT_MAX_CONTEXT_TOKENS / 2);
    expect(result.tokens).toBeLessThanOrEqual(DEFAULT_MAX_CONTEXT_TOKENS);
    memory.close();
  });

  it("still respects the token budget when the facts are verbose", async () => {
    const verbose = "a deliberately long assistant payload ".repeat(12);
    const memory = await createTestMemory({ generate: answerer });
    await memory.retain(facts(70, verbose), { now: NOW });

    const result = await memory.reflect("entity", { asOf: NOW, limit: DEFAULT_EVIDENCE_ROW_CAP });

    expect(result.tokens).toBeLessThanOrEqual(DEFAULT_MAX_CONTEXT_TOKENS);
    // Verbose rows must yield FEWER of them than terse rows — the budget, not the row
    // count, is what binds.
    expect(result.evidence.length).toBeLessThan(DEFAULT_EVIDENCE_ROW_CAP);
    memory.close();
  });

  it("never returns more rows than the cap, however terse the facts", async () => {
    const memory = await createTestMemory({ generate: answerer });
    await memory.retain(facts(DEFAULT_EVIDENCE_ROW_CAP + 40, "x"), { now: NOW });

    const result = await memory.reflect("entity", { asOf: NOW, limit: DEFAULT_EVIDENCE_ROW_CAP });

    expect(result.evidence.length).toBeLessThanOrEqual(DEFAULT_EVIDENCE_ROW_CAP);
    memory.close();
  });

  it("honors an explicit limit, so a caller that wants a short table still gets one", async () => {
    const memory = await createTestMemory({ generate: answerer });
    await memory.retain(facts(70, "terse"), { now: NOW });

    const result = await memory.reflect("entity", { asOf: NOW, limit: 5 });

    expect(result.evidence).toHaveLength(5);
    memory.close();
  });

  it("honors an explicit maxContextTokens below the default", async () => {
    const memory = await createTestMemory({ generate: answerer });
    await memory.retain(facts(70, "terse"), { now: NOW });

    const result = await memory.reflect("entity", {
      asOf: NOW,
      limit: DEFAULT_EVIDENCE_ROW_CAP,
      maxContextTokens: 300,
    });

    expect(result.tokens).toBeLessThanOrEqual(300);
    expect(estimateTokens(result.evidenceTable)).toBeLessThanOrEqual(300);
    memory.close();
  });
});
