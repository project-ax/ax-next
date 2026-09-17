import { readFileSync } from "node:fs";
import { createDemMemory, type DemMemory, type DemMemoryOptions } from "../src/index.js";
import { hashEmbedder } from "../src/models/embeddings.js";
import type { DialogueTurn, ExtractFn, IngestionPayload } from "../src/types.js";

export interface DialogueFixture {
  sessions: Array<{
    id: string;
    topic: string;
    turns: DialogueTurn[];
  }>;
  expectedFacts: Record<string, IngestionPayload["facts"]>;
}

export const FIXTURE: DialogueFixture = JSON.parse(
  readFileSync(new URL("./fixtures/test-dialogue.json", import.meta.url), "utf8"),
) as DialogueFixture;

export function fixtureSession(id: string): DialogueFixture["sessions"][number] {
  const session = FIXTURE.sessions.find((candidate) => candidate.id === id);
  if (!session) throw new Error(`fixture session ${id} not found`);
  return session;
}

export function fixtureExtractor(sessionId: string): ExtractFn {
  const facts = FIXTURE.expectedFacts[sessionId];
  if (!facts) throw new Error(`no expected facts for fixture session ${sessionId}`);
  return async () => ({ facts: structuredClone(facts) });
}

export function fixtureFacts(sessionId: string): IngestionPayload["facts"] {
  const facts = FIXTURE.expectedFacts[sessionId];
  if (!facts) throw new Error(`no expected facts for fixture session ${sessionId}`);
  return structuredClone(facts);
}

export function queuedExtractor(payloads: IngestionPayload[]): ExtractFn {
  let call = 0;
  return async () => {
    const payload = payloads[call];
    call += 1;
    if (!payload) throw new Error(`queued extractor exhausted after ${call - 1} calls`);
    return structuredClone(payload);
  };
}

export interface TestMemoryOptions {
  bankId?: string;
  extract?: ExtractFn;
  rerank?: DemMemoryOptions["rerank"];
  generate?: DemMemoryOptions["generate"];
}

export async function createTestMemory(options: TestMemoryOptions = {}): Promise<DemMemory> {
  return createDemMemory({
    path: ":memory:",
    bankId: options.bankId ?? "test",
    embed: hashEmbedder(),
    extract:
      options.extract ??
      (async () => {
        throw new Error("extraction must not run in tests without a canned extractor");
      }),
    rerank: options.rerank ?? "none",
    generate:
      options.generate ??
      (async () => {
        throw new Error("generation must not run in tests without an injected generator");
      }),
  });
}
