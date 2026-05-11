// Regenerates `permanent/memory/system/recent.md` — a CACHED VIEW of the
// agent's current context. It is NOT canonical state; it is derived entirely
// from `inbox/` observations and `docs/` pages already on disk.
//
// WHY a cached view: reading every inbox + doc file on every chat:start would
// be expensive at scale. `recent.md` is cheap to rebuild (one pass over the
// file index) and cheap to read (one file load). Deleting it loses nothing —
// the next consolidation pass regenerates it identically.
//
// I13 invariant: `recent.md` is regenerable end-to-end from `inbox/` + `docs/`
// state. Given the same `now` value, repeated calls to `regenerateRecent` must
// produce byte-for-byte identical output. This module enforces I13 by:
//   1. Sorting every list before serialising (so fs readdir order doesn't leak in).
//   2. Using `now` exclusively for frontmatter timestamps — no `Date.now()` calls.
//   3. Never reading `recent.md` itself as input (avoids a read-your-own-write
//      divergence if the file was partially written by a prior crash).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildMarkdownFile } from './frontmatter.js';
import { listInbox } from './inbox-store.js';
import { listDocs } from './doc-store.js';
import { recentFile } from './paths.js';
import type { MemoryFrontmatter } from './types.js';

const RECENT_DOC_LIMIT = 5;
const ACTIVE_PROJECTS_WINDOW_DAYS = 7;

export async function regenerateRecent(input: {
  workspaceRoot: string;
  now: Date;
}): Promise<{ path: string }> {
  const inbox = await listInbox(input.workspaceRoot);
  const docs = await listDocs({ workspaceRoot: input.workspaceRoot });

  // Open Threads: inbox items whose factType is `episode` or `decision`
  // (proxy for "in-progress work" per design § "system/recent.md").
  const openThreads = inbox
    .filter(
      (i) =>
        i.frontmatter.factType === 'episode' ||
        i.frontmatter.factType === 'decision',
    )
    .map((i) => `- [${i.frontmatter.id}] ${i.frontmatter.summary}`)
    .sort();

  // Active Projects: distinct entity-doc subjects updated in the last 7 days.
  const cutoff = new Date(
    input.now.getTime() - ACTIVE_PROJECTS_WINDOW_DAYS * 86_400_000,
  );
  const projects = docs
    .filter((d) => d.frontmatter.type === 'docs/entity')
    .filter((d) => new Date(d.frontmatter.updated) >= cutoff)
    .map((d) => `- ${d.frontmatter.subject} — ${d.frontmatter.summary}`)
    .sort();

  // Recent Changes: 5 most-recently-updated docs.
  const recent = [...docs]
    .sort((a, b) => b.frontmatter.updated.localeCompare(a.frontmatter.updated))
    .slice(0, RECENT_DOC_LIMIT)
    .map((d) => `- ${d.frontmatter.id} (${d.frontmatter.updated})`);

  const fm: MemoryFrontmatter = {
    id: 'recent',
    type: 'system/recent',
    created: input.now.toISOString(),
    confidence: 1.0,
    pinned: true,
    summary:
      'Cached view of open threads, active projects, recent changes — regenerated each consolidation pass.',
    event_time: input.now.toISOString(),
    recorded_at: input.now.toISOString(),
  };
  const body = [
    '# Recent',
    '',
    '## Open Threads',
    ...(openThreads.length > 0 ? openThreads : ['_None._']),
    '',
    '## Active Projects',
    ...(projects.length > 0 ? projects : ['_None._']),
    '',
    '## Recent Changes',
    ...(recent.length > 0 ? recent : ['_None._']),
    '',
  ].join('\n');

  const rel = recentFile();
  const abs = join(input.workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
  return { path: rel };
}
