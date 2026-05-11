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

import type { AgentContext, HookBus } from '@ax/core';
import { readDoc } from './doc-store.js';
import type { DocCategory } from './paths.js';

const PLUGIN_NAME = '@ax/memory-strata';

interface MemoryDocWrittenPayload {
  docId: string;
  category: string;
  slug: string;
  kind: 'created' | 'updated';
  summary: string;
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

  const doc = await readDoc({
    workspaceRoot: ctx.workspace.rootPath,
    category: category as DocCategory,
    slug,
  });

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
    summary: doc.frontmatter.summary,
    body: doc.body,
    headers: headers.join('\n'),
  });
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
