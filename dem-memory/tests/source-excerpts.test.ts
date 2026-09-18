import { describe, expect, it } from "vitest";
import { compileEvidenceTable } from "../src/engine/reflect.js";
import { DEFAULT_MAX_CONTEXT_TOKENS, INFINITY_SENTINEL, estimateTokens, type MemoryTuple } from "../src/types.js";

const NOW = "2023-05-30T00:00:00.000Z";

function tuple(i: number, sourceChunk?: string): MemoryTuple {
  return {
    id: `id-${i}`,
    bankId: "test",
    network: "experience",
    subject: "assistant",
    predicate: "suggested_projects",
    object: `recycled decor project set ${i}`,
    ...(sourceChunk ? { sourceChunk } : {}),
    validStart: NOW,
    validEnd: INFINITY_SENTINEL,
    transactionTime: NOW,
    provenance: "extracted",
  };
}

const CHUNK = "seal the vase with Mod Podge or another sealant to make it water-resistant";

describe("source excerpts in the evidence table", () => {
  it("are omitted entirely when not requested — the table is unchanged", () => {
    const compiled = compileEvidenceTable([tuple(0, CHUNK)], { asOf: NOW });
    expect(compiled.table).not.toContain("Mod Podge");
    expect(compiled.table).not.toMatch(/Source excerpt/i);
  });

  it("carry the detail the extracted fact lost", () => {
    const compiled = compileEvidenceTable([tuple(0, CHUNK)], { asOf: NOW, sourceExcerpts: 3 });
    expect(compiled.table).toContain("Mod Podge");
  });

  it("attach only to the top N rows, not to every row", () => {
    const rows = Array.from({ length: 20 }, (_, i) => tuple(i, `${CHUNK} ${i}`));
    const compiled = compileEvidenceTable(rows, { asOf: NOW, sourceExcerpts: 3 });
    const excerpts = compiled.table.match(/Mod Podge/g) ?? [];
    expect(excerpts).toHaveLength(3);
  });

  it("skip rows that have no attributed source", () => {
    const compiled = compileEvidenceTable([tuple(0), tuple(1, CHUNK)], { asOf: NOW, sourceExcerpts: 3 });
    expect(compiled.table.match(/Mod Podge/g) ?? []).toHaveLength(1);
  });

  it("charge their tokens against the SAME budget, so the table never overruns", () => {
    const long = "x".repeat(1200);
    const rows = Array.from({ length: 60 }, (_, i) => tuple(i, long));
    const compiled = compileEvidenceTable(rows, {
      asOf: NOW,
      sourceExcerpts: 5,
      maxTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    });
    expect(compiled.tokens).toBeLessThanOrEqual(DEFAULT_MAX_CONTEXT_TOKENS);
    expect(estimateTokens(compiled.table)).toBeLessThanOrEqual(DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it("buy their excerpts with rows — fewer rows fit once excerpts are attached", () => {
    const rows = Array.from({ length: 60 }, (_, i) => tuple(i, "s".repeat(300)));
    const without = compileEvidenceTable(rows, { asOf: NOW, maxTokens: 900 });
    const with5 = compileEvidenceTable(rows, { asOf: NOW, maxTokens: 900, sourceExcerpts: 5 });
    expect(with5.rows.length).toBeLessThan(without.rows.length);
    expect(with5.tokens).toBeLessThanOrEqual(900);
  });
});
