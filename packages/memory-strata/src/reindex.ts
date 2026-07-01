// Re-indexer: subscribes to `memory:doc:written` and calls
// `memory:index:upsert` to keep the search index in sync with on-disk
// docs.
//
// WHY re-read from disk instead of trusting the event payload: the event
// carries only the doc metadata the Consolidator already had at write-time.
// Reading the canonical file after the fact (I18) means the indexer always
// sees exactly what is on disk — any upstream transformation or in-flight
// append that raced the event cannot cause index drift.
//
// WHY catch-not-throw at the subscriber boundary: per the Phase 1/2A
// convention, subscribers NEVER throw out of the callback. HookBus would
// catch the throw anyway, but catching here keeps log keys stable and pins
// the plugin name in every log entry.

import { posix } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type {
  AgentContext,
  HookBus,
  WorkspaceReadInput,
  WorkspaceReadOutput,
} from '@ax/core';
import { AGENT_TIER_MEMORY_ROOT, agentTierAvailable } from './agent-tier-sync.js';
import { readDoc } from './doc-store.js';
import { docFile, type DocCategory } from './paths.js';
import type { DocFrontmatter } from './types.js';

const PLUGIN_NAME = '@ax/memory-strata';

interface MemoryDocWrittenPayload {
  docId: string;
  category: string;
  slug: string;
  kind: 'created' | 'updated';
  summary: string;
}

/** The slice of a doc the reindexer needs to build an index upsert. Both
 *  frontmatter fields are optional — `factType` defaults to 'general' and
 *  `summary` to '' at the upsert site, matching a hand-edited / fence-less doc. */
interface ReindexDoc {
  frontmatter: Partial<Pick<DocFrontmatter, 'factType' | 'summary'>>;
  body: string;
}

/**
 * Register a subscriber on `memory:doc:written` that re-reads the doc from
 * disk and calls `memory:index:upsert`. Safe to call without an indexer
 * registered — the try/catch around `bus.call` swallows the `no-service`
 * HookBusError and logs a warn so operators know the index is not running.
 */
export function registerReindexer(bus: HookBus): void {
  bus.subscribe<MemoryDocWrittenPayload>(
    'memory:doc:written',
    PLUGIN_NAME,
    async (ctx, payload) => {
      try {
        await handleReindex(bus, ctx, payload);
      } catch (err) {
        ctx.logger.warn('memory_strata_reindex_failed', {
          docId: payload.docId,
          kind: payload.kind,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
      return undefined;
    },
  );
}

async function handleReindex(
  bus: HookBus,
  ctx: AgentContext,
  payload: MemoryDocWrittenPayload,
): Promise<void> {
  const { docId, category, slug, kind } = payload;

  // TASK-186: when memory lives in the per-agent `/agent` git tier (k8s), read
  // the canonical doc from THERE (owner-routed by ctx). On the host path the
  // consolidator wrote to a scratch that's already disposed, and
  // `ctx.workspace.rootPath` is the shared host CWD that holds no per-agent
  // doc — so a host read would miss it and the index would never populate
  // (the pre-TASK-186 gap: the consolidator therefore OMITTED bus/ctx on the
  // tier path; now it passes them and we read the tier here). CLI path reads
  // the agent's own workspace root, unchanged.
  const doc = await readReindexDoc(bus, ctx, category as DocCategory, slug);

  if (doc === null) {
    // Doc was deleted between the write event and our reindex attempt.
    // Nothing to index — log at debug and return cleanly.
    ctx.logger.debug('memory_strata_reindex_doc_missing', { docId, kind });
    return;
  }

  const headers = extractHeaders(doc.body);

  await bus.call('memory:index:upsert', ctx, {
    docId,
    category,
    slug,
    // If factType is somehow absent (hand-edited file), default to 'general'
    // so the indexer always receives a valid string.
    factType: doc.frontmatter.factType ?? 'general',
    summary: doc.frontmatter.summary ?? '',
    body: doc.body,
    headers: headers.join('\n'),
  });
}

/** Read the doc the reindexer needs, routed through the `/agent` tier when one
 *  is loaded (TASK-186). Returns null when the doc is gone. */
async function readReindexDoc(
  bus: HookBus,
  ctx: AgentContext,
  category: DocCategory,
  slug: string,
): Promise<ReindexDoc | null> {
  if (!agentTierAvailable(bus)) {
    const doc = await readDoc({ workspaceRoot: ctx.workspace.rootPath, category, slug });
    return doc === null
      ? null
      : { frontmatter: doc.frontmatter, body: doc.body };
  }

  const fsRel = docFile(category, slug);
  const tierPath = posix.join(AGENT_TIER_MEMORY_ROOT, fsRel.split('/').slice(2).join('/'));
  const out = await bus.call<WorkspaceReadInput, WorkspaceReadOutput>('workspace:read', ctx, {
    path: tierPath,
  });
  if (!out.found) return null;
  return parseReindexDoc(new TextDecoder('utf-8').decode(out.bytes));
}

/**
 * Parse a doc's frontmatter (factType + summary) and body from raw markdown,
 * matching doc-store's `parseDoc` fence (`---\n...\n---\n<body>`). A doc that
 * lacks the fence yields an empty frontmatter + the raw text as the body — the
 * reindexer degrades to indexing the body rather than throwing.
 */
function parseReindexDoc(raw: string): ReindexDoc {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (m === null) return { frontmatter: {}, body: raw };
  const fm = (yamlLoad(m[1]!) ?? {}) as Pick<DocFrontmatter, 'factType' | 'summary'>;
  return { frontmatter: fm, body: m[2]! };
}

/**
 * Extract heading text from ATX-style Markdown headings (`# h1` ... `###### h6`).
 * Returns the heading text without the `#` prefix or surrounding whitespace.
 * Order is preserved; nesting depth is intentionally discarded -- the indexer
 * receives a flat newline-joined string for full-text indexing.
 */
function extractHeaders(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m !== null) out.push(m[1]!);
  }
  return out;
}
