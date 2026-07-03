import { posix } from 'node:path';
import type {
  AgentContext,
  HookBus,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { AGENT_TIER_MEMORY_ROOT, agentTierAvailable } from './agent-tier-sync.js';
import { readDoc } from './doc-store.js';
import { docFile, type DocCategory } from './paths.js';

/**
 * Read a doc's body, routed through the `/agent` git tier when one is loaded
 * (TASK-186 — mirrors `readTierSystemBody` in inject.ts). Returns null when the
 * doc doesn't exist. The returned body is byte-identical to what `readDoc`
 * yields on the host path: everything after the canonical `---\n...\n---\n`
 * frontmatter fence.
 */
export async function readDocBody(
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
export function extractDocBody(raw: string): string {
  const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(raw);
  return m === null ? raw : m[1]!;
}
