import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { runObserver } from '../observer.js';
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
