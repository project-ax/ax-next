import { makeAgentContext } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import { readDoc } from '../doc-store.js';
import type { DocCategory } from '../paths.js';

const PLUGIN_NAME = '@ax/memory-strata';

const VALID_CATEGORIES = new Set<DocCategory>([
  'entity',
  'preference',
  'decision',
  'episode',
  'general',
]);
const SLUG_RE = /^[a-z0-9-]+$/;

export const MEMORY_READ_SECTION_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_read_section',
  description:
    'Read a specific section of a memory doc by id. Use AFTER memory_search to drill into a fact. ' +
    'If header is omitted, returns the whole body.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      docId: {
        type: 'string',
        description: 'Document id in <category>/<slug> form (e.g. "preference/react").',
      },
      header: {
        type: 'string',
        description: 'Optional ## section header (e.g. "Facts"). Omitted returns the whole body.',
      },
    },
    required: ['docId'],
  },
};

export async function registerMemoryReadSection(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({
    sessionId: 'init',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });
  await bus.call('tool:register', initCtx, MEMORY_READ_SECTION_DESCRIPTOR);

  bus.registerService<
    { docId?: unknown; header?: unknown },
    { body: string } | { error: string }
  >(
    'tool:execute:memory_read_section',
    PLUGIN_NAME,
    async (ctx, input) => {
      const docId = typeof input?.docId === 'string' ? input.docId : '';
      const header = typeof input?.header === 'string' ? input.header.trim() : '';

      const parsed = parseDocId(docId);
      if (parsed === null) return { error: 'invalid-docId' };

      const doc = await readDoc({
        workspaceRoot: ctx.workspace.rootPath,
        category: parsed.category,
        slug: parsed.slug,
      });
      if (doc === null) return { error: 'doc-not-found' };

      if (header.length === 0) return { body: doc.body };

      const section = extractSection(doc.body, header);
      if (section === null) return { error: 'header-not-found' };
      return { body: section };
    },
  );
}

function parseDocId(docId: string): { category: DocCategory; slug: string } | null {
  // Reject empty, no slash, multiple slashes, leading/trailing slash, '..'
  if (docId.length === 0) return null;
  if (docId.includes('..')) return null;
  const idx = docId.indexOf('/');
  if (idx <= 0 || idx === docId.length - 1) return null;
  if (docId.indexOf('/', idx + 1) !== -1) return null; // second slash → reject
  const category = docId.slice(0, idx);
  const slug = docId.slice(idx + 1);
  if (!VALID_CATEGORIES.has(category as DocCategory)) return null;
  if (!SLUG_RE.test(slug)) return null;
  return { category: category as DocCategory, slug };
}

function extractSection(body: string, header: string): string | null {
  const lines = body.split('\n');
  const target = header.trim();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m !== null && m[1]!.trim() === target) break;
    i++;
  }
  if (i >= lines.length) return null; // header not found
  const start = i + 1;
  let end = start;
  while (end < lines.length) {
    if (/^##\s+/.test(lines[end]!)) break;
    end++;
  }
  const chunk = lines.slice(start, end).join('\n');
  // Trim leading/trailing blank lines
  return chunk.replace(/^\n+|\n+$/g, '');
}
