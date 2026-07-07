// Write-time rollup docs (TASK-200) — the DETERMINISTIC (Stage A) half of the
// `reflect` design (docs/plans/2026-07-06-memory-strata-reflect-rollup-design.md).
//
// At consolidation time, for each recurring instance-class already present in
// memory (≥K member docs that lexically share a rare class-token), we
// materialize a `docs/rollup/<class>.md` doc stating the COUNT and listing every
// member instance (dated, linked). The doc surfaces through the EXISTING
// retrieval path (BM25/orchestrator + matchedFacts), so on "how many X" the
// answer model reads a precomputed count instead of re-deriving it from
// scattered docs — the one-hop cross-document-aggregation failure c137 documents.
//
// Stage A is deterministic (NO LLM): it catches classes whose members share the
// class word on the surface (model kits, doctors, weddings). Stage B (bounded
// LLM naming over the residue) is a SEPARATE follow-on card (TASK-201) and is
// deliberately NOT built here.
//
// A rollup is a best-effort ACCELERATOR, never the sole path: a missing or stale
// rollup must degrade to read-time enumeration, never produce a wrong answer.
// That is why GC (below) fires `memory:doc:deleted` so a de-qualified rollup's
// index row is removed — a stale rollup answering `## Count: 3` after the file is
// gone is a wrong-answer-by-construction bug.

import { mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentContext, HookBus } from '@ax/core';
import { atomicWriteUtf8, listDocs, readDoc, stripFactDate } from './doc-store.js';
import { buildMarkdownFile } from './frontmatter.js';
import { docFile, type DocCategory } from './paths.js';
import { slugify } from './slugify.js';
import type { DocFile, DocFrontmatter } from './types.js';

/** Minimal structured-logger interface (structurally matches the consolidator's
 *  `ConsolidationLogger`; declared locally to avoid a consolidator↔rollup import
 *  cycle). */
export interface RollupLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
}

const PLUGIN_ORIGIN = 'reflect';
const ROLLUP_CONFIDENCE = 0.8;
/** Slug guard — GC unlinks ONLY `docs/rollup/<slug>.md` with slug ∈ this set
 *  (never a raw readdir+unlink). Same shape as doc-id.ts's SLUG_RE. */
const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Tunable rollup config. All defaults are SPECIFIED in the TASK-200 card, not
 * runtime decisions — the consolidator calls `runRollupPass` with these; tests
 * override K / salience / cap to drive edge cases.
 */
export interface RollupConfig {
  /** A class needs ≥K distinct member docs to materialize. Default 3. */
  k: number;
  /** A class-token appearing in > this fraction of its category's docs is a
   *  generic (user/day/visited) and is dropped. Default 0.4. */
  salienceMaxFraction: number;
  /** Per-pass hard cap on rollups written. Default 50; overflow is LOGGED
   *  (`rollup_cap_exceeded`), never silently truncated. */
  cap: number;
  /** Categories that can host a class. `preference`/`decision` are single-state
   *  (not enumerable) and `rollup` docs are never members of a class. */
  enumerableCategories: ReadonlySet<DocCategory>;
}

export const DEFAULT_ROLLUP_CONFIG: RollupConfig = {
  k: 3,
  salienceMaxFraction: 0.4,
  cap: 50,
  enumerableCategories: new Set<DocCategory>(['episode', 'entity', 'general']),
};

/** A qualifying instance-class: ≥K member docs sharing a rare class-token. */
export interface DetectedClass {
  /** Pluralized, slugified class name — the on-disk `docs/rollup/<slug>.md`. */
  slug: string;
  /** The singularized grouping token (e.g. `wedding`). */
  token: string;
  /** Enumerable category the members live in. */
  category: DocCategory;
  /** Member docs (≥K), deduped. */
  members: DocFile[];
}

// Deliberately modest stopword list: per-category salience (≤0.4) already drops
// FREQUENT generics; this only removes function words that would otherwise clear
// the length≥3 bar. 'user'/'day' are kept out here AND caught by salience.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'was', 'were', 'are', 'has', 'had', 'have', 'did',
  'does', 'this', 'that', 'these', 'those', 'they', 'them', 'their', 'his', 'her',
  'its', 'our', 'your', 'you', 'she', 'him', 'who', 'how', 'many', 'much', 'what',
  'which', 'when', 'about', 'from', 'into', 'over', 'then', 'than', 'also', 'just',
  'some', 'any', 'all', 'one', 'two', 'new', 'got', 'get', 'went', 'user', 'users',
  'day', 'days', 'time', 'week', 'month', 'year', 'thing', 'things',
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Naive singularization for GROUPING — `weddings`→`wedding`, `doctors`→`doctor`,
 *  `parties`→`party`. Deliberately shallow; the class SLUG is re-pluralized for
 *  display (see `pluralize`). */
function singularize(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Naive pluralization for the class slug/label — inverse-ish of singularize.
 *  `wedding`→`weddings`, `party`→`parties`, `dish`→`dishes`. */
function pluralize(w: string): string {
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`;
  return `${w}s`;
}

/** `<category>/<slug>` type discriminator → bare category. */
function categoryOf(doc: DocFile): DocCategory {
  return doc.frontmatter.type.replace(/^docs\//, '') as DocCategory;
}

/** Distinct, singularized, non-stopword class-token candidates for one doc,
 *  drawn from {subject, summary, fact-line bodies}. A doc contributes each token
 *  ONCE (so salience counts distinct docs, not repetitions). */
function docTokens(doc: DocFile): Set<string> {
  const raw = [
    doc.frontmatter.subject ?? '',
    doc.frontmatter.summary ?? '',
    ...extractFactBullets(doc.body),
  ].join(' ');
  const out = new Set<string>();
  for (const t of tokenize(raw)) {
    if (t.length < 3 || STOPWORDS.has(t)) continue;
    const s = singularize(t);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    out.add(s);
  }
  return out;
}

/** `- ` bullet bodies under the `## Facts` heading (mirrors doc-store/map). */
function extractFactBullets(body: string): string[] {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## Facts');
  if (idx === -1) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.startsWith('## ')) break;
    if (l.startsWith('- ')) out.push(l.slice(2).trim());
  }
  return out;
}

/**
 * Stage A — deterministic class detection (NO LLM). Groups enumerable-category
 * docs by a shared rare class-token, per category. Returns qualifying classes
 * (≥K distinct members, token appears in ≤ salienceMaxFraction of the category's
 * docs), sorted by slug and capped. A doc may belong to MULTIPLE classes.
 */
export function detectClasses(
  docs: DocFile[],
  config: RollupConfig = DEFAULT_ROLLUP_CONFIG,
  log?: RollupLogger,
): { classes: DetectedClass[]; capExceeded: boolean } {
  // Group candidate member docs by enumerable category (rollups never members).
  const byCategory = new Map<DocCategory, DocFile[]>();
  for (const doc of docs) {
    const cat = categoryOf(doc);
    if (cat === 'rollup' || !config.enumerableCategories.has(cat)) continue;
    (byCategory.get(cat) ?? byCategory.set(cat, []).get(cat)!).push(doc);
  }

  // slug → class (dedup across categories on the rare slug collision; keep the
  // larger member set so the rollup is maximally complete).
  const bySlug = new Map<string, DetectedClass>();
  for (const [category, catDocs] of byCategory) {
    const n = catDocs.length;
    // token → member docs (dedup by docId within a token).
    const tokenMembers = new Map<string, Map<string, DocFile>>();
    for (const doc of catDocs) {
      for (const token of docTokens(doc)) {
        const m = tokenMembers.get(token) ?? new Map<string, DocFile>();
        m.set(doc.frontmatter.id, doc);
        tokenMembers.set(token, m);
      }
    }
    for (const [token, membersMap] of tokenMembers) {
      const df = membersMap.size;
      if (df < config.k) continue; // below K → not a class
      if (df / n > config.salienceMaxFraction) continue; // too generic
      const slug = slugify(pluralize(token));
      const members = [...membersMap.values()];
      const existing = bySlug.get(slug);
      if (existing === undefined || members.length > existing.members.length) {
        bySlug.set(slug, { slug, token, category, members });
      }
    }
  }

  const all = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  const capExceeded = all.length > config.cap;
  if (capExceeded) {
    log?.warn('memory_strata_rollup_cap_exceeded', {
      detected: all.length,
      cap: config.cap,
    });
  }
  return { classes: capExceeded ? all.slice(0, config.cap) : all, capExceeded };
}

const FACT_DATE_RE = /^\((\d{4}-\d{2}-\d{2})\)/;

/** The member's most representative dated instance line for a class: the first
 *  dated fact matching the class token, else the first matching fact (dated with
 *  the doc's `updated` day), else the doc summary. Always carries a date + link. */
function memberInstance(member: DocFile, token: string): { date: string; text: string } {
  const facts = extractFactBullets(member.body);
  const matches = (line: string): boolean =>
    tokenize(stripFactDate(line)).some((w) => singularize(w) === token);
  const fallbackDate = member.frontmatter.updated.slice(0, 10);

  let firstMatch: string | undefined;
  for (const f of facts) {
    if (!matches(f)) continue;
    if (firstMatch === undefined) firstMatch = f;
    const dm = FACT_DATE_RE.exec(f);
    if (dm !== null) return { date: dm[1]!, text: stripFactDate(f).trim() };
  }
  if (firstMatch !== undefined) {
    return { date: fallbackDate, text: stripFactDate(firstMatch).trim() };
  }
  return { date: fallbackDate, text: member.frontmatter.summary };
}

/** Deterministic materialized rollup content (frontmatter + body inputs). */
export interface RollupContent {
  slug: string;
  count: number;
  /** Member docIds, sorted (stable frontmatter + hash input). */
  memberIds: string[];
  /** `- (date) text — [[docId]]` lines, sorted by (date, docId). */
  instanceLines: string[];
  summary: string;
  hash: string;
}

/** Build the deterministic rollup content for a detected class. Pure (no I/O). */
export function buildRollup(cls: DetectedClass): RollupContent {
  const rows = cls.members.map((m) => {
    const inst = memberInstance(m, cls.token);
    return { docId: m.frontmatter.id, date: inst.date, text: inst.text };
  });
  rows.sort((a, b) => (a.date === b.date ? a.docId.localeCompare(b.docId) : a.date.localeCompare(b.date)));
  const instanceLines = rows.map((r) => `- (${r.date}) ${r.text} — [[${r.docId}]]`);
  const memberIds = [...cls.members.map((m) => m.frontmatter.id)].sort();
  const count = memberIds.length;
  const label = cls.slug.charAt(0).toUpperCase() + cls.slug.slice(1);
  const summary = `${label} — ${count} (rollup)`;
  const hash = hashRollup(memberIds, count, instanceLines);
  return { slug: cls.slug, count, memberIds, instanceLines, summary, hash };
}

function hashRollup(memberIds: string[], count: number, instanceLines: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ members: memberIds, count, instanceLines }))
    .digest('hex')
    .slice(0, 16);
}

function renderRollupBody(content: RollupContent): string {
  return [
    `# Rollup: ${content.slug}`,
    '',
    '## Count',
    `${content.count} distinct ${content.slug}.`,
    '',
    '## Instances',
    ...content.instanceLines,
    '',
  ].join('\n');
}

/**
 * Idempotently materialize a rollup doc. Skips the write when a stable hash of
 * `(members, count, instance-line text)` matches the on-disk rollup — so an
 * unchanged class costs nothing and `rollup_generated` only moves on real
 * content change. On a write it fires `memory:doc:written` ITSELF (kind
 * created/updated) — a bare file write would leave the rollup on disk + in the
 * map but INVISIBLE to `memory_search` (reindex only acts on `doc:written`).
 */
export async function writeRollupDoc(input: {
  workspaceRoot: string;
  content: RollupContent;
  now: Date;
  bus?: HookBus | undefined;
  ctx?: AgentContext | undefined;
}): Promise<{ path: string; wrote: boolean; kind: 'created' | 'updated' }> {
  const { workspaceRoot, content, now } = input;
  const rel = docFile('rollup', content.slug);
  const existing = await readDoc({ workspaceRoot, category: 'rollup', slug: content.slug });
  const kind: 'created' | 'updated' = existing === null ? 'created' : 'updated';

  if (existing !== null && existing.frontmatter.rollup_hash === content.hash) {
    return { path: rel, wrote: false, kind };
  }

  const created = existing?.frontmatter.created ?? now.toISOString();
  const fm: DocFrontmatter = {
    id: `rollup/${content.slug}`,
    type: 'docs/rollup',
    created,
    updated: now.toISOString(),
    confidence: ROLLUP_CONFIDENCE,
    pinned: false,
    summary: content.summary,
    subject: content.slug,
    factType: 'rollup',
    origin: PLUGIN_ORIGIN,
    source_observations: [], // synthesized — parseDoc's guard requires an array
    rollup_count: content.count,
    rollup_members: content.memberIds,
    rollup_generated: now.toISOString(),
    rollup_hash: content.hash,
  };
  const abs = join(workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true }); // docs/rollup/ may not exist yet
  await atomicWriteUtf8(abs, buildMarkdownFile(fm, renderRollupBody(content)));

  if (input.bus !== undefined && input.ctx !== undefined) {
    await input.bus.fire('memory:doc:written', input.ctx, {
      docId: `rollup/${content.slug}`,
      category: 'rollup',
      slug: content.slug,
      kind,
      summary: content.summary,
    });
  }
  return { path: rel, wrote: true, kind };
}

/**
 * Delete a de-qualified rollup and (when a bus is present) fire
 * `memory:doc:deleted { docId }` so the index row is removed (TASK-199 →
 * reindex.ts → memory:index:delete). Slug-guarded: unlinks ONLY
 * `docs/rollup/<slug>.md` with slug ∈ SLUG_RE. ENOENT is benign (already gone).
 */
export async function deleteRollupDoc(input: {
  workspaceRoot: string;
  slug: string;
  bus?: HookBus | undefined;
  ctx?: AgentContext | undefined;
}): Promise<void> {
  if (!SLUG_RE.test(input.slug)) return; // never unlink an unguarded path
  const rel = docFile('rollup', input.slug);
  try {
    await unlink(join(input.workspaceRoot, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (input.bus !== undefined && input.ctx !== undefined) {
    await input.bus.fire('memory:doc:deleted', input.ctx, {
      docId: `rollup/${input.slug}`,
    });
  }
}

export interface RollupPassResult {
  written: number;
  skipped: number;
  /** docIds of rollups GC'd this pass (`rollup/<slug>`). Surfaced so the tier
   *  path — which runs the pass without a bus — can re-fire `memory:doc:deleted`
   *  after flush (mirrors how doc:written is re-fired via reindexTierDocs). */
  deletedDocIds: string[];
}

/**
 * One rollup pass: detect classes over the current doc tree, idempotently write
 * qualifying rollups, and GC rollups whose class no longer qualifies. Fires
 * `memory:doc:written`/`memory:doc:deleted` inline when a bus is present (CLI
 * path); always returns the deleted docIds for the bus-less tier path.
 */
export async function runRollupPass(input: {
  workspaceRoot: string;
  now: Date;
  log: RollupLogger;
  bus?: HookBus | undefined;
  ctx?: AgentContext | undefined;
  config?: RollupConfig | undefined;
}): Promise<RollupPassResult> {
  const config = input.config ?? DEFAULT_ROLLUP_CONFIG;
  const docs = await listDocs({ workspaceRoot: input.workspaceRoot });
  const { classes } = detectClasses(docs, config, input.log);
  const qualifyingSlugs = new Set(classes.map((c) => c.slug));

  let written = 0;
  let skipped = 0;
  for (const cls of classes) {
    const content = buildRollup(cls);
    const res = await writeRollupDoc({
      workspaceRoot: input.workspaceRoot,
      content,
      now: input.now,
      bus: input.bus,
      ctx: input.ctx,
    });
    if (res.wrote) {
      written += 1;
      input.log.info('memory_strata_rollup_written', {
        class: cls.slug,
        members: content.count,
        kind: res.kind,
      });
    } else {
      skipped += 1;
      input.log.info('memory_strata_rollup_skipped_unchanged', {
        class: cls.slug,
        members: content.count,
      });
    }
  }

  // GC: any existing rollup whose class no longer qualifies (dropped below K
  // after dedup/merge, or now generic) is unlinked AND its index row removed.
  const deletedDocIds: string[] = [];
  const existingRollupSlugs = docs
    .filter((d) => categoryOf(d) === 'rollup')
    .map((d) => d.frontmatter.id.replace(/^rollup\//, ''));
  for (const slug of existingRollupSlugs) {
    if (qualifyingSlugs.has(slug)) continue;
    await deleteRollupDoc({
      workspaceRoot: input.workspaceRoot,
      slug,
      bus: input.bus,
      ctx: input.ctx,
    });
    deletedDocIds.push(`rollup/${slug}`);
    input.log.info('memory_strata_rollup_gc_deleted', { class: slug });
  }

  return { written, skipped, deletedDocIds };
}
