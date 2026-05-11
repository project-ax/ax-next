import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookBus, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import { load as yamlLoad } from 'js-yaml';
import { registerMemoryNote, MEMORY_NOTE_DESCRIPTOR } from '../tools/memory-note.js';
import { INBOX_DIR } from '../paths.js';

// --- Helpers ---

function makeCtx(workspaceRoot: string) {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
    workspace: { rootPath: workspaceRoot },
  });
}

/**
 * Build a bus wired with a stub `tool:register` that records the last
 * registered descriptor.
 */
function makeWiredBus() {
  const bus = new HookBus();

  let registeredDescriptor: ToolDescriptor | undefined;

  bus.registerService<ToolDescriptor, { ok: true }>(
    'tool:register',
    'test-tool-dispatcher',
    async (_ctx, input) => {
      registeredDescriptor = input;
      return { ok: true };
    },
  );

  return { bus, getRegisteredDescriptor: () => registeredDescriptor };
}

/** Parse frontmatter from the first inbox file found. */
async function readFirstInboxFrontmatter(
  workspaceRoot: string,
): Promise<Record<string, unknown>> {
  const dir = join(workspaceRoot, INBOX_DIR);
  const names = await readdir(dir);
  const mdFiles = names.filter((n) => n.endsWith('.md'));
  if (mdFiles.length === 0) throw new Error('No inbox files found');
  const raw = await readFile(join(dir, mdFiles[0]!), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (m === null) throw new Error('No YAML frontmatter found');
  return yamlLoad(m[1]!) as Record<string, unknown>;
}

// --- Tests ---

describe('tools/memory-note', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ax-mem-note-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // 1. Descriptor registration

  describe('descriptor registration', () => {
    it('registers MEMORY_NOTE_DESCRIPTOR via tool:register', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemoryNote(bus);

      const desc = getRegisteredDescriptor();
      expect(desc).toBeDefined();
      expect(desc?.name).toBe('memory_note');
      expect(desc?.executesIn).toBe('host');
      expect(desc?.inputSchema).toMatchObject({
        type: 'object',
        required: ['subject', 'content'],
      });
    });

    it('registered descriptor matches MEMORY_NOTE_DESCRIPTOR exactly', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemoryNote(bus);

      expect(getRegisteredDescriptor()).toEqual(MEMORY_NOTE_DESCRIPTOR);
    });
  });

  // 2. Happy path - Fixture A (I20 accept side)

  describe('tool:execute:memory_note', () => {
    it('happy path: writes inbox file and returns { ok: true, path }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'react',
        content: 'User has used React for 5 years',
        factType: 'preference',
        confidence: 0.9,
      });

      expect(out).toEqual({ ok: true, path: expect.stringContaining('inbox/') });

      // Verify the file actually landed on disk with correct frontmatter.
      const fm = await readFirstInboxFrontmatter(workspaceRoot);
      expect(fm['subject']).toBe('react');
      expect(fm['summary']).toBe('User has used React for 5 years');
      expect(fm['factType']).toBe('preference');
      expect(fm['confidence']).toBe(0.9);
      expect(fm['type']).toBe('inbox/observation');
    });

    // 3. Sensitive rejection - Fixture B (I20 reject side - load-bearing)

    it('sensitive rejection: rejects anthropic API key and writes nothing', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'creds',
        content: 'My API key is sk-ant-XXXXXXXXXXXXXXXXXXXXX',
      });

      expect(out).toEqual({
        rejected: true,
        reason: 'sensitive',
        kinds: expect.arrayContaining(['anthropic-api-key']),
      });

      // Verify NO inbox file was created.
      const inboxFiles = await readdir(join(workspaceRoot, INBOX_DIR)).catch(() => []);
      expect(inboxFiles).toHaveLength(0);
    });

    // 4. Invalid factType coerced to 'general'

    it('invalid factType is coerced to "general"', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'misc',
        content: 'Some generic fact',
        factType: 'invalid-type',
      });

      expect(out).toMatchObject({ ok: true });

      const fm = await readFirstInboxFrontmatter(workspaceRoot);
      expect(fm['factType']).toBe('general');
    });

    // 5. Out-of-range confidence clamped to [0, 1]

    it('confidence > 1 is clamped to 1', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'misc',
        content: 'Another fact',
        confidence: 1.5,
      });

      expect(out).toMatchObject({ ok: true });

      const fm = await readFirstInboxFrontmatter(workspaceRoot);
      expect(fm['confidence']).toBe(1);
    });

    it('non-finite confidence falls back to default 0.8', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'misc',
        content: 'Yet another fact',
        confidence: NaN,
      });

      expect(out).toMatchObject({ ok: true });

      const fm = await readFirstInboxFrontmatter(workspaceRoot);
      expect(fm['confidence']).toBe(0.8);
    });

    // 6. Invalid input - missing or empty fields

    it('empty subject returns { error: "invalid-input" }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: '',
        content: 'x',
      });

      expect(out).toEqual({ error: 'invalid-input' });
    });

    it('missing subject returns { error: "invalid-input" }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        content: 'x',
      });

      expect(out).toEqual({ error: 'invalid-input' });
    });

    it('missing content returns { error: "invalid-input" }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'x',
      });

      expect(out).toEqual({ error: 'invalid-input' });
    });

    it('empty content returns { error: "invalid-input" }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'x',
        content: '',
      });

      expect(out).toEqual({ error: 'invalid-input' });
    });

    // 7. Default values applied when optional fields are omitted

    it('omitting factType defaults to "general"', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'node',
        content: 'User prefers Node.js for backend',
      });

      expect(out).toMatchObject({ ok: true });

      const fm = await readFirstInboxFrontmatter(workspaceRoot);
      expect(fm['factType']).toBe('general');
    });

    it('omitting confidence defaults to 0.8', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_note', ctx, {
        subject: 'node',
        content: 'User prefers Node.js for backend',
      });

      expect(out).toMatchObject({ ok: true });

      const fm = await readFirstInboxFrontmatter(workspaceRoot);
      expect(fm['confidence']).toBe(0.8);
    });

    // 8. source_messages is 0 for agent-authored notes

    it('source_messages frontmatter field is 0 (agent-authored, no transcript)', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryNote(bus);

      const ctx = makeCtx(workspaceRoot);
      await bus.call('tool:execute:memory_note', ctx, {
        subject: 'test',
        content: 'A well-known fact',
      });

      const fm = await readFirstInboxFrontmatter(workspaceRoot);
      expect(fm['source_messages']).toBe(0);
    });
  });
});
