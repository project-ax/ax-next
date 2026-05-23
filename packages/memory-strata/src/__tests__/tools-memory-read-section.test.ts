import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookBus, makeAgentContext } from '@ax/core';
import type { ToolDescriptor } from '@ax/core';
import {
  registerMemoryReadSection,
  MEMORY_READ_SECTION_DESCRIPTOR,
} from '../tools/memory-read-section.js';
import { writeNewDoc } from '../doc-store.js';
import { buildMarkdownFile } from '../frontmatter.js';
import type { DocFrontmatter } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCtx(workspaceRoot: string) {
  return makeAgentContext({
    sessionId: 'test-session',
    agentId: 'test-agent',
    userId: 'test-user',
    workspace: { rootPath: workspaceRoot },
  });
}

/**
 * Wrap a bare tool input in the host-execution `ToolCall` envelope
 * `{ id, name, input }` — the exact shape the `tool.execute-host` IPC handler
 * forwards to the `tool:execute:<name>` service hook (see ipc-core
 * `tool-execute-host.ts`). Calling the hook with bare input would mask the
 * `call.input` extraction bug this suite is meant to catch.
 */
function asToolCall(input: Record<string, unknown>) {
  return { id: 'call-1', name: 'memory_read_section', input };
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

/**
 * Write a doc with multiple ## sections directly using buildMarkdownFile
 * so we can test section parsing with multiple headings.
 */
async function writeMultiSectionDoc(
  workspaceRoot: string,
  category: 'preference',
  slug: string,
): Promise<void> {
  const fm: DocFrontmatter = {
    id: `${category}/${slug}`,
    type: `docs/${category}`,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    confidence: 0.9,
    pinned: false,
    summary: 'User prefers React',
    subject: 'react',
    factType: 'preference',
    source_observations: ['obs-1'],
  };
  const body =
    '# Doc\n\n' +
    '## Facts\n' +
    '- Prefers React over Vue\n' +
    '- Uses hooks extensively\n\n' +
    '## Open Questions\n' +
    '- Does user prefer Next.js or Remix?\n';

  const dir = join(workspaceRoot, 'permanent', 'memory', 'docs', category);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  // buildMarkdownFile expects MemoryFrontmatter; cast via unknown since DocFrontmatter
  // is a compatible superset for the YAML fields the function uses.
  await writeFile(
    filePath,
    buildMarkdownFile(fm as unknown as Parameters<typeof buildMarkdownFile>[0], body),
    'utf8',
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('tools/memory-read-section', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ax-mem-read-section-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // ── 1. Descriptor registration ────────────────────────────────────────────

  describe('descriptor registration', () => {
    it('registers MEMORY_READ_SECTION_DESCRIPTOR via tool:register', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemoryReadSection(bus);

      const desc = getRegisteredDescriptor();
      expect(desc).toBeDefined();
      expect(desc?.name).toBe('memory_read_section');
      expect(desc?.executesIn).toBe('host');
      expect(desc?.inputSchema).toMatchObject({
        type: 'object',
        required: ['docId'],
      });
    });

    it('registered descriptor matches MEMORY_READ_SECTION_DESCRIPTOR exactly', async () => {
      const { bus, getRegisteredDescriptor } = makeWiredBus();
      await registerMemoryReadSection(bus);

      expect(getRegisteredDescriptor()).toEqual(MEMORY_READ_SECTION_DESCRIPTOR);
    });
  });

  // ── 2. Happy path with header ─────────────────────────────────────────────

  describe('tool:execute:memory_read_section', () => {
    it('happy path with header: returns just the Facts section body', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryReadSection(bus);
      await writeMultiSectionDoc(workspaceRoot, 'preference', 'react');

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_read_section', ctx, asToolCall({
        docId: 'preference/react',
        header: 'Facts',
      }));

      expect(out).toEqual({
        body: '- Prefers React over Vue\n- Uses hooks extensively',
      });
    });

    // ── 3. Header omitted returns whole body ──────────────────────────────

    it('header omitted returns the whole body', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryReadSection(bus);
      await writeMultiSectionDoc(workspaceRoot, 'preference', 'react');

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_read_section', ctx, asToolCall({
        docId: 'preference/react',
      }));

      expect((out as { body: string }).body).toContain('## Facts');
      expect((out as { body: string }).body).toContain('## Open Questions');
    });

    // ── 4. Doc not found ──────────────────────────────────────────────────

    it('doc not found returns { error: "doc-not-found" }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryReadSection(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_read_section', ctx, asToolCall({
        docId: 'preference/nonexistent',
      }));

      expect(out).toEqual({ error: 'doc-not-found' });
    });

    // ── 5. Header not found ───────────────────────────────────────────────

    it('header not found in existing doc returns { error: "header-not-found" }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryReadSection(bus);
      await writeNewDoc({
        workspaceRoot,
        category: 'preference',
        slug: 'react',
        summary: 'User prefers React',
        subject: 'react',
        factType: 'preference',
        confidence: 0.9,
        sourceObservationIds: ['obs-1'],
        now: new Date(),
        facts: ['Prefers React'],
      });

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_read_section', ctx, asToolCall({
        docId: 'preference/react',
        header: 'NonExistentSection',
      }));

      expect(out).toEqual({ error: 'header-not-found' });
    });

    // ── 6. Invalid docId path-traversal rejected ──────────────────────────

    describe('invalid docId validation', () => {
      it.each([
        { docId: '../etc/passwd', label: 'path traversal with ..' },
        { docId: '/etc/passwd', label: 'absolute path' },
        { docId: 'preference/../etc', label: 'embedded ..' },
        { docId: 'preference/has space', label: 'slug with space' },
        { docId: 'preference/A1', label: 'slug with capital letter' },
        { docId: 'preference/', label: 'trailing slash (empty slug)' },
        { docId: '', label: 'empty string' },
        { docId: 'preference', label: 'no slash' },
        { docId: 'preference/a/b', label: 'two slashes' },
      ])('$label → { error: "invalid-docId" }', async ({ docId }) => {
        const { bus } = makeWiredBus();
        await registerMemoryReadSection(bus);

        const ctx = makeCtx(workspaceRoot);
        const out = await bus.call('tool:execute:memory_read_section', ctx, asToolCall({ docId }));

        expect(out).toEqual({ error: 'invalid-docId' });
      });
    });

    // ── 7. Invalid category ───────────────────────────────────────────────

    it('invalid category returns { error: "invalid-docId" }', async () => {
      const { bus } = makeWiredBus();
      await registerMemoryReadSection(bus);

      const ctx = makeCtx(workspaceRoot);
      const out = await bus.call('tool:execute:memory_read_section', ctx, asToolCall({
        docId: 'unknown-category/foo',
      }));

      expect(out).toEqual({ error: 'invalid-docId' });
    });
  });
});
