import { makeAgentContext } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import { readDocBody } from '../doc-body.js';
import { parseDocId } from '../doc-id.js';

const PLUGIN_NAME = '@ax/memory-strata';

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
    { input?: unknown },
    { body: string } | { error: string }
  >(
    'tool:execute:memory_read_section',
    PLUGIN_NAME,
    async (ctx, call) => {
      // The `tool.execute-host` IPC handler forwards the full ToolCall
      // `{ id, name, input }` to this hook (see ipc-core tool-execute-host.ts).
      // The model-supplied arguments live under `call.input`, not on `call`.
      const input = (call?.input ?? {}) as { docId?: unknown; header?: unknown };
      const docId = typeof input?.docId === 'string' ? input.docId : '';
      const header = typeof input?.header === 'string' ? input.header.trim() : '';

      // Traversal guard runs FIRST, before any I/O (tier or host), so a
      // malformed/escaping docId can never reach the workspace read.
      const parsed = parseDocId(docId);
      if (parsed === null) return { error: 'invalid-docId' };

      // TASK-186: when memory lives in the per-agent `/agent` git tier (k8s),
      // read the doc from THERE (owner-routed by ctx — the git tier confines
      // the read to this agent's repo) instead of the shared host CWD. CLI
      // path is unchanged.
      const body = await readDocBody(bus, ctx, parsed.category, parsed.slug);
      if (body === null) return { error: 'doc-not-found' };

      if (header.length === 0) return { body };

      const section = extractSection(body, header);
      if (section === null) return { error: 'header-not-found' };
      return { body: section };
    },
  );
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
