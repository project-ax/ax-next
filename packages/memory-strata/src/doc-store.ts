// Read/write canonical `docs/<category>/<slug>.md` files atomically.
//
// WHY atomic writes: a crash (OOM kill, power loss, SIGKILL) mid-write would
// leave a partial file that the YAML front-matter parser below chokes on.
// We write to a sibling `.tmp-<pid>-<ms>` file first, then POSIX-rename it
// into place. Rename on the same filesystem is atomic — the final path either
// has the old content or the new content, never a partial write.
//
// WHY null-on-ENOENT from `readDoc`: callers often want to check "does this
// doc already exist?" without try/catch noise at the call site. Returning
// `null` signals "not yet created"; throwing signals "I/O error". That lets
// `appendFact` distinguish the two cases cleanly.

import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { buildMarkdownFile } from './frontmatter.js';
import { categoryDir, docFile, type DocCategory } from './paths.js';
import type { DocFile, DocFrontmatter } from './types.js';

export interface WriteNewDocInput {
  workspaceRoot: string;
  category: DocCategory;
  slug: string;
  summary: string;
  subject: string;
  factType: string;
  confidence: number;
  sourceObservationIds: string[];
  now: Date;
  facts: string[];
}

export interface AppendFactInput {
  workspaceRoot: string;
  category: DocCategory;
  slug: string;
  newFact: string;
  observationId: string;
  confidence: number;
  now: Date;
}

export async function writeNewDoc(input: WriteNewDocInput): Promise<{ path: string }> {
  const rel = docFile(input.category, input.slug);
  const abs = join(input.workspaceRoot, rel);
  const fm: DocFrontmatter = {
    id: `${input.category}/${input.slug}`,
    type: `docs/${input.category}` as DocFrontmatter['type'],
    created: input.now.toISOString(),
    updated: input.now.toISOString(),
    confidence: input.confidence,
    pinned: false,
    summary: input.summary,
    subject: input.subject,
    factType: input.factType,
    source_observations: input.sourceObservationIds,
  };
  const body = buildBody(input.facts);
  await fs.mkdir(dirname(abs), { recursive: true });
  await atomicWriteUtf8(abs, buildMarkdownFile(fm, body));
  return { path: rel };
}

export async function appendFact(input: AppendFactInput): Promise<DocFile> {
  const existing = await readDoc({
    workspaceRoot: input.workspaceRoot,
    category: input.category,
    slug: input.slug,
  });
  if (existing === null) {
    throw new Error(`docNotFound: ${input.category}/${input.slug}`);
  }
  const fm: DocFrontmatter = {
    ...existing.frontmatter,
    updated: input.now.toISOString(),
    confidence: Math.max(existing.frontmatter.confidence, input.confidence),
    source_observations: [
      ...existing.frontmatter.source_observations,
      input.observationId,
    ],
  };
  const body = appendFactToBody(existing.body, input.newFact);
  const rel = docFile(input.category, input.slug);
  const abs = join(input.workspaceRoot, rel);
  await atomicWriteUtf8(abs, buildMarkdownFile(fm, body));
  return { path: rel, frontmatter: fm, body };
}

export async function readDoc(input: {
  workspaceRoot: string;
  category: DocCategory;
  slug: string;
}): Promise<DocFile | null> {
  const rel = docFile(input.category, input.slug);
  const abs = join(input.workspaceRoot, rel);
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch (err) {
    // ENOENT means "doc doesn't exist yet" — not an error from the caller's
    // perspective. Any other error (EPERM, EIO, ...) is unexpected and should
    // surface to the caller.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseDoc(rel, raw);
}

export async function listDocs(input: { workspaceRoot: string }): Promise<DocFile[]> {
  const out: DocFile[] = [];
  for (const cat of CATEGORIES) {
    const dirAbs = join(input.workspaceRoot, categoryDir(cat));
    let names: string[];
    try {
      names = await fs.readdir(dirAbs);
    } catch (err) {
      // A missing category directory is fine — it means no docs in that
      // category have been promoted yet. Skip silently.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const slug = name.slice(0, -'.md'.length);
      const doc = await readDoc({ workspaceRoot: input.workspaceRoot, category: cat, slug });
      if (doc !== null) out.push(doc);
    }
  }
  return out;
}

const CATEGORIES: DocCategory[] = ['entity', 'preference', 'decision', 'episode', 'general'];

function buildBody(facts: string[]): string {
  return ['# Doc', '', '## Facts', ...facts.map((f) => `- ${f}`), ''].join('\n');
}

function appendFactToBody(body: string, fact: string): string {
  // Append `- <fact>` under the `## Facts` section. If somehow no Facts
  // section exists (hand-edited file), we add one rather than silently
  // discarding the new fact.
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === '## Facts');
  if (idx === -1) {
    return [...lines, '', '## Facts', `- ${fact}`, ''].join('\n');
  }
  // Find the end of the Facts section: the next `##` heading, or EOF.
  let insertAt = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) { insertAt = i; break; }
  }
  // Back up over trailing blank lines so we insert before the blank gap,
  // not after it -- keeps the body clean (facts grouped tightly).
  while (insertAt > 0 && lines[insertAt - 1]?.trim() === '') insertAt--;
  const next = [...lines];
  next.splice(insertAt, 0, `- ${fact}`);
  return next.join('\n');
}

function parseDoc(relPath: string, raw: string): DocFile {
  // Hand-parse the canonical frontmatter (`---\n...\n---\n<body>`). gray-matter
  // would do this but we already have js-yaml in scope and gray-matter is an
  // unnecessary dependency at this stage.
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (m === null) throw new Error(`malformedDoc: ${relPath}`);
  const fm = yamlLoad(m[1]!) as DocFrontmatter;
  // Guard the one field appendFact spreads. Full Zod validation is
  // a Phase 2B concern when the DocFrontmatter shape stabilizes.
  if (!Array.isArray(fm.source_observations)) {
    throw new Error(`malformedDoc (missing source_observations): ${relPath}`);
  }
  return { path: relPath, frontmatter: fm, body: m[2]! };
}

async function atomicWriteUtf8(absPath: string, contents: string): Promise<void> {
  // Write to a sibling temp file then rename. POSIX rename is atomic on
  // the same filesystem; this prevents a crash mid-write from leaving
  // a partially-written doc that our parser would later choke on.
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, contents, 'utf8');
  try {
    await fs.rename(tmp, absPath);
  } catch (err) {
    // Rename failed — best-effort cleanup of the orphaned tmp file so
    // repeated failures don't accumulate cruft in the docs directory.
    // SIGKILL between writeFile and here still leaves a tmp file; that's
    // unavoidable without a fsync + journal. ENOENT here means rename
    // somehow consumed the tmp despite throwing, which is benign.
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
