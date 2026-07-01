import { makeAgentContext } from '@ax/core';
import { posix } from 'node:path';
import type {
  AgentContext,
  HookBus,
  ToolDescriptor,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { AGENT_TIER_MEMORY_ROOT, agentTierAvailable } from '../agent-tier-sync.js';
import { parseDocId } from '../doc-id.js';
import { readDoc } from '../doc-store.js';
import { docFile, type DocCategory } from '../paths.js';

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

/**
 * Read a doc's body, routed through the `/agent` git tier when one is loaded
 * (TASK-186 — mirrors `readTierSystemBody` in inject.ts). Returns null when the
 * doc doesn't exist. The returned body is byte-identical to what `readDoc`
 * yields on the host path: everything after the canonical `---\n...\n---\n`
 * frontmatter fence.
 */
async function readDocBody(
  bus: HookBus,
  ctx: AgentContext,
  category: DocCategory,
  slug: string,
): Promise<string | null> {
  if (!agentTierAvailable(bus)) {
    const doc = await readDoc({ workspaceRoot: ctx.workspace.rootPath, category, slug });
    return doc === null ? null : doc.body;
  }

  // FS rel path is `permanent/memory/docs/<category>/<slug>.md` (MEMORY_ROOT =
  // `permanent/memory`, two segments). The tier drops that whole host-layout
  // prefix and re-roots the tail under `memory/`.
  const fsRel = docFile(category, slug);
  const tierPath = posix.join(AGENT_TIER_MEMORY_ROOT, fsRel.split('/').slice(2).join('/'));
  const out = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', ctx, {
    path: tierPath,
  });
  if (!out.found) return null;
  const raw = new TextDecoder('utf-8').decode(out.bytes);
  return extractDocBody(raw);
}

/**
 * Extract the body that follows the canonical frontmatter fence, matching
 * doc-store's `parseDoc` exactly (`---\n...\n---\n<body>`). A doc that somehow
 * lacks the fence yields the raw text as-is rather than throwing — the tool
 * degrades to returning content instead of failing the read.
 */
function extractDocBody(raw: string): string {
  const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(raw);
  return m === null ? raw : m[1]!;
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
