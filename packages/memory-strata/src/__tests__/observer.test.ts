import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { runObserver, EXTRACTION_PROMPT_SYSTEM } from '../observer.js';
import { INBOX_DIR } from '../paths.js';
import type { AgentMessage, LlmCallInput, LlmCallOutput } from '@ax/core';

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'memory-strata-observer-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

const TRANSCRIPT: AgentMessage[] = [
  { role: 'user', content: 'I prefer React over Vue.' },
  { role: 'assistant', content: 'Got it — noted.' },
  { role: 'user', content: 'The project ships next Friday.' },
  { role: 'assistant', content: 'Understood.' },
];

function llmReturning(text: string): (input: LlmCallInput) => Promise<LlmCallOutput> {
  return async () => ({
    text,
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 50 },
  });
}

function listInbox(root: string): Promise<string[]> {
  return readdir(join(root, INBOX_DIR)).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

async function readInboxFiles(
  root: string,
): Promise<Array<{ name: string; fm: Record<string, unknown>; body: string }>> {
  const names = await listInbox(root);
  const out: Array<{ name: string; fm: Record<string, unknown>; body: string }> = [];
  for (const name of names) {
    const raw = await readFile(join(root, INBOX_DIR, name), 'utf8');
    const m = raw.match(FRONTMATTER_RE);
    if (m === null) throw new Error(`bad frontmatter in ${name}`);
    out.push({
      name,
      fm: yamlLoad(m[1] ?? '') as Record<string, unknown>,
      body: m[2] ?? '',
    });
  }
  return out;
}

describe('runObserver', () => {
  it('writes one inbox file per surviving observation', async () => {
    const llm = llmReturning(
      JSON.stringify([
        { fact: 'User prefers React over Vue.', subject: 'user', factType: 'preference', confidence: 0.92 },
        { fact: 'Project ships next Friday.', subject: 'project', factType: 'decision', confidence: 0.85 },
      ]),
    );

    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llm,
      workspaceRoot,
      now: new Date('2026-05-10T12:00:00Z'),
      timeoutMs: 30_000,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') return;
    expect(result.written).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);

    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(2);

    for (const f of files) {
      expect(f.fm['type']).toBe('inbox/observation');
      expect(typeof f.fm['id']).toBe('string');
      expect(typeof f.fm['created']).toBe('string');
      expect(f.fm['confidence']).toBeGreaterThan(0);
      expect(f.fm['pinned']).toBe(false);
      expect(f.fm['source_messages']).toBe(TRANSCRIPT.length);
      expect(typeof f.fm['summary']).toBe('string');
    }

    const facts = files.map((f) => f.body).join('\n');
    expect(facts).toContain('React');
    expect(facts).toContain('Friday');
  });

  it('stamps conversation_id onto every written observation (TASK-187 recurrence threading)', async () => {
    const llm = llmReturning(
      JSON.stringify([
        { fact: 'User prefers React over Vue.', subject: 'user', factType: 'preference', confidence: 0.92 },
        { fact: 'Project ships next Friday.', subject: 'project', factType: 'decision', confidence: 0.85 },
      ]),
    );

    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llm,
      workspaceRoot,
      now: new Date('2026-05-10T12:00:00Z'),
      timeoutMs: 30_000,
      model: 'claude-haiku-4-5-20251001',
      conversationId: 'conv-abc',
    });

    expect(result.kind).toBe('written');
    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(2);
    // The durable per-conversation key lands on every observation so the
    // consolidator can later count distinct conversations for the gate.
    for (const f of files) {
      expect(f.fm['conversation_id']).toBe('conv-abc');
    }
  });

  it('writes NO conversation_id field when the turn had no conversation (ephemeral context)', async () => {
    const llm = llmReturning(
      JSON.stringify([
        { fact: 'User prefers React over Vue.', subject: 'user', factType: 'preference', confidence: 0.92 },
      ]),
    );

    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llm,
      workspaceRoot,
      now: new Date('2026-05-10T12:00:00Z'),
      timeoutMs: 30_000,
      model: 'claude-haiku-4-5-20251001',
      // conversationId omitted — canary/ephemeral contexts have none.
    });

    expect(result.kind).toBe('written');
    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(1);
    // A missing conversation must NOT serialize a `conversation_id` key — that
    // honest absence is what keeps an unkeyed observation out of any recurrence
    // count.
    expect('conversation_id' in files[0]!.fm).toBe(false);
  });

  it('drops observations that the sensitive-content gate rejects', async () => {
    const llm = llmReturning(
      JSON.stringify([
        { fact: 'User prefers React over Vue.', subject: 'user', factType: 'preference', confidence: 0.9 },
        {
          fact: 'API key is sk-ant-api03-LEAKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.',
          subject: 'credentials',
          factType: 'general',
          confidence: 0.95,
        },
      ]),
    );

    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llm,
      workspaceRoot,
      now: new Date('2026-05-10T12:00:00Z'),
      timeoutMs: 30_000,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') return;
    expect(result.written).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.kinds).toContain('anthropic-api-key');

    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]?.body).toContain('React');
    const allBodies = files.map((f) => f.body).join('');
    expect(allBodies).not.toContain('sk-ant');
  });

  it('drops the run cleanly on a 30s timeout — no inbox writes', async () => {
    vi.useFakeTimers();
    try {
      const llm: (input: LlmCallInput) => Promise<LlmCallOutput> = () =>
        new Promise<LlmCallOutput>((_, reject) => {
          setTimeout(() => reject(new Error('llm too slow')), 60_000);
        });

      const promise = runObserver({
        messages: TRANSCRIPT,
        llmCall: llm,
        workspaceRoot,
        now: new Date('2026-05-10T12:00:00Z'),
        timeoutMs: 30_000,
        model: 'claude-haiku-4-5-20251001',
      });

      await vi.advanceTimersByTimeAsync(30_001);

      const result = await promise;
      expect(result.kind).toBe('timeout');

      const files = await listInbox(workspaceRoot);
      expect(files).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the run cleanly when the LLM returns malformed JSON', async () => {
    const llm = llmReturning('not json at all');

    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llm,
      workspaceRoot,
      now: new Date('2026-05-10T12:00:00Z'),
      timeoutMs: 30_000,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.kind).toBe('parse-error');
    expect(await listInbox(workspaceRoot)).toEqual([]);
  });

  it('skips work entirely when the transcript has no user messages', async () => {
    const llm = vi.fn();

    const result = await runObserver({
      messages: [{ role: 'assistant', content: 'hi' }],
      llmCall: llm,
      workspaceRoot,
      now: new Date('2026-05-10T12:00:00Z'),
      timeoutMs: 30_000,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.kind).toBe('skipped');
    expect(llm).not.toHaveBeenCalled();
  });
});

describe('assistant-content extraction (factType: answer)', () => {
  it('preserves factType "answer" instead of coercing it to general', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          {
            fact: 'The assistant recommended Roscioli for a romantic Italian dinner in Rome.',
            subject: 'rome-restaurants',
            factType: 'answer',
            confidence: 0.9,
          },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]?.fm['factType']).toBe('answer');
    expect(files[0]?.fm['summary']).toContain('Roscioli');
  });

  it('still coerces a genuinely unknown factType to general', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          { fact: 'A fact.', subject: 's', factType: 'wat', confidence: 0.9 },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    const files = await readInboxFiles(workspaceRoot);
    expect(files[0]?.fm['factType']).toBe('general');
  });
});

describe('truncated-extraction salvage', () => {
  // A cut-off array currently loses EVERY fact in the session, including user
  // facts — assistant content just makes hitting the cap likelier.
  const TRUNCATED = `[
    {"fact":"User prefers React over Vue.","subject":"frontend","factType":"preference","confidence":0.9},
    {"fact":"The project ships next Friday.","subject":"project","factType":"episode","confidence":0.85},
    {"fact":"The assistant listed 10 work-from-home jobs for seniors: 1. Virtual assis`;

  it('keeps the complete objects when the array is cut mid-object', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(TRUNCATED),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.written).toHaveLength(2);
    expect(result.salvagedFromTruncation).toBe(true);
    const files = await readInboxFiles(workspaceRoot);
    expect(files.map((f) => f.fm['summary'])).toEqual([
      'User prefers React over Vue.',
      'The project ships next Friday.',
    ]);
  });

  it('does not flag a well-formed response as salvaged', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          { fact: 'User prefers React.', subject: 'frontend', factType: 'preference', confidence: 0.9 },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.salvagedFromTruncation).toBeUndefined();
  });

  it('recovers a complete object even after a stray leading "}" (review fix — no depth floor)', async () => {
    // A stray unmatched '}' right after the array's '[' used to drive `depth` to
    // -1 permanently (no floor), so the '{' that follows was never recognized as
    // an object start (`depth === 0` never true again) and the complete object
    // after it was silently dropped. Flooring the decrement at 0 recovers it.
    const STRAY_BRACE = '[}{"fact":"User likes tea.","subject":"tea","factType":"preference","confidence":0.9}]';
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(STRAY_BRACE),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.written).toHaveLength(1);
    const files = await readInboxFiles(workspaceRoot);
    expect(files.map((f) => f.fm['summary'])).toEqual(['User likes tea.']);
  });

  it('still reports parse-error when nothing can be salvaged', async () => {
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning('I am afraid I cannot help with that.'),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('parse-error');
  });
});

describe('sensitive gate covers assistant-authored facts (I7)', () => {
  it('rejects an answer fact carrying a credential before it reaches the inbox', async () => {
    // Invariant 5: assistant output is untrusted model output. The write-time
    // gate is factType-agnostic and MUST stay that way — assistant content is
    // exactly the path where an echoed secret could otherwise be persisted.
    const result = await runObserver({
      messages: TRANSCRIPT,
      llmCall: llmReturning(
        JSON.stringify([
          {
            fact: 'The assistant said the API key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.',
            subject: 'setup',
            factType: 'answer',
            confidence: 0.95,
          },
          {
            fact: 'The assistant recommended Roscioli for dinner in Rome.',
            subject: 'rome',
            factType: 'answer',
            confidence: 0.9,
          },
        ]),
      ),
      workspaceRoot,
      now: new Date('2026-07-29T12:00:00.000Z'),
      timeoutMs: 1000,
      model: 'test-model',
    });

    expect(result.kind).toBe('written');
    if (result.kind !== 'written') throw new Error('unreachable');
    expect(result.rejected).toHaveLength(1);
    expect(result.written).toHaveLength(1);
    const files = await readInboxFiles(workspaceRoot);
    expect(files).toHaveLength(1);
    expect(files[0]?.fm['summary']).toContain('Roscioli');
  });
});

describe('EXTRACTION_PROMPT_SYSTEM — assistant-content contract', () => {
  it('instructs capture of assistant-provided content with attribution', () => {
    // Guard against a future prompt edit silently reverting the lever. The
    // BEHAVIORAL proof is test/bench/repro-extract.ts (real Haiku, a few cents).
    expect(EXTRACTION_PROMPT_SYSTEM).toMatch(/assistant/i);
    expect(EXTRACTION_PROMPT_SYSTEM).toContain('answer');
    expect(EXTRACTION_PROMPT_SYSTEM).toContain('The assistant');
  });

  it('bars speculation and preserves list order', () => {
    expect(EXTRACTION_PROMPT_SYSTEM).toMatch(/speculat|hedge|guess/i);
    expect(EXTRACTION_PROMPT_SYSTEM).toMatch(/order|numbered/i);
  });
});
