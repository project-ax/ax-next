import { describe, expect, it } from "vitest";
import { EXTRACTION_SYSTEM_PROMPT } from "../src/engine/retain.js";
import { compileEvidenceTable, evidenceTableRow } from "../src/engine/reflect.js";
import { INFINITY_SENTINEL, memoryStatement, type MemoryTuple } from "../src/types.js";
import { createTestMemory } from "./helpers.js";

const NOW = "2023-05-27T10:00:00.000Z";

function tuple(overrides: Partial<MemoryTuple> = {}): MemoryTuple {
  return {
    id: "t1",
    bankId: "test",
    network: "world",
    subject: "jessica_poole",
    predicate: "instagram_account",
    object: "@jessica_poole_jewellery",
    confidence: 0.9,
    validStart: NOW,
    validEnd: INFINITY_SENTINEL,
    transactionTime: NOW,
    ...overrides,
  };
}

/**
 * `subject` and `predicate` are snake_case identifiers by extraction contract, so spacing
 * them out reads better. `object` is free text — LongMemEval question b759caee asked for an
 * Instagram handle, the table rendered `@jessica_poole_jewellery` as `@jessica poole
 * jewellery`, and the answerer dutifully reported a handle that does not exist.
 */
describe("memoryStatement", () => {
  it("keeps the object verbatim — an underscore inside a handle is content, not snake_case", () => {
    expect(memoryStatement("jessica_poole", "instagram_account", "@jessica_poole_jewellery")).toBe(
      "jessica poole instagram account: @jessica_poole_jewellery",
    );
  });

  it("still spaces out the canonicalized subject and predicate", () => {
    expect(memoryStatement("postgres_database", "runs_on", "port 5432")).toBe(
      "postgres database runs on: port 5432",
    );
  });

  it("preserves other verbatim payloads a user may ask to be read back exactly", () => {
    expect(memoryStatement("assistant", "provided_path", "src/engine/retain.ts")).toContain(
      "src/engine/retain.ts",
    );
    expect(memoryStatement("assistant", "stated_env_var", "AX_EPHEMERAL_ROOT=/ephemeral")).toContain(
      "AX_EPHEMERAL_ROOT=/ephemeral",
    );
  });
});

describe("verbatim objects survive the whole read path", () => {
  it("reaches the evidence table unmangled", () => {
    expect(evidenceTableRow(tuple())).toContain("@jessica_poole_jewellery");
    expect(compileEvidenceTable([tuple()]).table).toContain("@jessica_poole_jewellery");
  });

  it("reaches the reranker unmangled", async () => {
    const seen: string[] = [];
    const memory = await createTestMemory({
      rerank: async (_query, documents) => {
        seen.push(...documents);
        return documents.map(() => 1);
      },
    });
    await memory.retain(
      {
        facts: [
          {
            network: "world",
            subject: "jessica_poole",
            predicate: "instagram_account",
            object: "@jessica_poole_jewellery",
            validStart: NOW,
            confidence: 0.9,
            invalidatesPrevious: false,
          },
        ],
      },
      { now: NOW },
    );
    await memory.recall("instagram handle");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("jessica poole instagram account: @jessica_poole_jewellery");

    memory.close();
  });
});

/**
 * The behavioral check — does GLM actually comply? — is the bench. This only pins the
 * contract, so a later prompt edit that quietly drops assistant content fails here rather
 * than six hours into an n=100 run. Five of the six single-session-assistant failures at
 * n=100 were the assistant's own turn surviving extraction as a topic label
 * ("assistant generated song: sad song with lyrics and note sequences") with the detail the
 * question asked for — the chord progression, the sealant, the percentage — compressed out.
 */
describe("extraction prompt: assistant-content contract", () => {
  it("asks for facts from both speakers, not just the user", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/USER facts/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/ASSISTANT facts/);
  });

  it("demands the specifics rather than the topic", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/Keep the specifics/);
  });

  it("keeps a list, table, or sequence whole and in order as ONE fact", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/whole and in order/);
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/ONE fact/);
  });

  it("requires verbatim copying of handles, identifiers, and sequences", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/[Vv]erbatim/);
  });

  it("no longer tells the extractor to compress objects into a phrase", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).not.toMatch(/Keep objects concise/);
  });

  it("names the assistant subject so assistant facts are addressable", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/`assistant`/);
  });
});
