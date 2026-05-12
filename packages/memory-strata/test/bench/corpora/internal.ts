import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { glob as fsGlob } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchCorpus, MarkdownDoc, BenchQuestion } from '../types.js';
import type { AgentClient } from '../agent.js';

export interface InternalCorpusFile {
  docs: MarkdownDoc[];
  questions: BenchQuestion[];
}

export function loadInternalCorpusFromJson(json: string): BenchCorpus {
  const parsed = JSON.parse(json) as InternalCorpusFile;
  const memoryTree = new Map<string, MarkdownDoc>(parsed.docs.map((d) => [d.path, d]));
  return { name: 'internal', memoryTree, questions: parsed.questions };
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const THIS_DIR = dirname(fileURLToPath(import.meta.url!));
export const INTERNAL_CORPUS_PATH = join(THIS_DIR, '..', 'internal-corpus.json');

export function loadInternalCorpus(): BenchCorpus {
  if (!existsSync(INTERNAL_CORPUS_PATH)) {
    throw new Error(
      `Internal corpus not found at ${INTERNAL_CORPUS_PATH}. ` +
        `Run "pnpm --filter @ax/memory-strata bench --regen-internal" to generate it.`,
    );
  }
  return loadInternalCorpusFromJson(readFileSync(INTERNAL_CORPUS_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// Internal corpus regenerator (requires ANTHROPIC_API_KEY at runtime)
// ---------------------------------------------------------------------------

interface SourceFile {
  path: string;
  content: string;
}

const SOURCE_GLOBS = [
  'docs/plans/*-design.md',
  'docs/plans/*-impl.md',
  '.claude/memory/*.md',
  'README.md',
  'CLAUDE.md',
];

const MAX_DOCS_FOR_REGEN = 60;

export async function regenerateInternalCorpus(opts: {
  agentClient: AgentClient;
  repoRoot: string;
  outputPath?: string;
}): Promise<{ docCount: number; questionCount: number; outputPath: string }> {
  const out = opts.outputPath ?? INTERNAL_CORPUS_PATH;
  const sources = await collectSources(opts.repoRoot);
  const docs: MarkdownDoc[] = [];
  for (const src of sources.slice(0, MAX_DOCS_FOR_REGEN)) {
    const slug = src.path.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-|-$/g, '');
    const headers = src.content.split('\n').filter((l) => /^#{1,6}\s+/.test(l)).join('\n');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const summary = headers.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 200) ?? '';
    docs.push({
      path: `knowledge/${slug}`,
      category: 'knowledge',
      slug,
      summary,
      factType: 'knowledge',
      headers,
      body: src.content,
    });
  }
  const questions: BenchQuestion[] = [];
  for (let i = 0; i < docs.length; i += 3) {
    const triplet = docs.slice(i, i + 3);
    const qa = await synthesizeQuestion(opts.agentClient, triplet);
    if (qa) questions.push(qa);
  }
  const payload: InternalCorpusFile = { docs, questions };
  writeFileSync(out, JSON.stringify(payload, null, 2));
  return { docCount: docs.length, questionCount: questions.length, outputPath: out };
}

async function collectSources(repoRoot: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  for (const pattern of SOURCE_GLOBS) {
    for await (const entry of fsGlob(pattern, { cwd: repoRoot })) {
      const full = `${repoRoot}/${entry}`;
      try {
        found.push({ path: entry, content: readFileSync(full, 'utf8') });
      } catch {
        // ignore unreadable
      }
    }
  }
  return found;
}

async function synthesizeQuestion(
  client: AgentClient,
  docs: MarkdownDoc[],
): Promise<BenchQuestion | null> {
  const docBlock = docs
    .map((d, i) => `[${i + 1}] (${d.path})\n${d.body.slice(0, 1500)}`)
    .join('\n\n---\n\n');
  const system = `Given some documents, propose exactly ONE question that is answerable from these documents and ONE concise gold answer.

Format:
QUESTION: <one specific question>
ANSWER: <one short answer that the documents support>

If the documents are insufficient to ground a precise question/answer pair, output exactly: SKIP.`;
  const user = docBlock;
  const resp = await client.complete({ system, user });
  if (/^\s*SKIP\b/i.test(resp.text)) return null;
  const qm = resp.text.match(/QUESTION:\s*(.+)/i);
  const am = resp.text.match(/ANSWER:\s*(.+)/i);
  if (!qm || !am) return null;
  return {
    id: `internal-${docs.map((d) => d.slug).join('+')}`,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    text: qm[1]!.trim(),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    goldAnswer: am[1]!.trim(),
    goldDocIds: docs.map((d) => d.path),
  };
}
