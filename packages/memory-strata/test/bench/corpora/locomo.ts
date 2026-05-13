import type { MarkdownDoc, BenchQuestion, BenchCorpus } from '../types.js';
import { makeDoc } from './shared.js';
import { BenchCache } from '../cache.js';

export interface LoCoMoTurn {
  speaker: string;
  dia_id?: string;
  text: string;
}

export interface LoCoMoQuestion {
  question: string;
  answer: string | number;
  evidence?: string[];
  category?: number;
}

export interface LoCoMoSample {
  sample_id: string;
  conversation: Record<string, LoCoMoTurn[] | string | undefined>;
  qa: LoCoMoQuestion[];
}

const SESSION_KEY = /^session_(\d+)$/;
const EVIDENCE_DIA = /^D(\d+):/;

export function transformLoCoMoSample(s: LoCoMoSample): {
  docs: Map<string, MarkdownDoc>;
  questions: BenchQuestion[];
} {
  const docs = new Map<string, MarkdownDoc>();
  const sessionPathByDiaPrefix = new Map<string, string>();
  for (const [key, val] of Object.entries(s.conversation)) {
    const m = key.match(SESSION_KEY);
    if (!m || !Array.isArray(val)) continue;
    const sessionNum = m[1];
    const slug = `${s.sample_id}-s${sessionNum}`;
    const turns = val as LoCoMoTurn[];
    const body = turns.map((t) => `**${t.speaker}:** ${t.text}`).join('\n\n');
    const summary = (turns[0]?.text ?? '').slice(0, 200);
    const doc = makeDoc({ category: 'episodes', slug, summary, body });
    docs.set(doc.path, doc);
    sessionPathByDiaPrefix.set(`D${sessionNum}`, doc.path);
  }
  const questions: BenchQuestion[] = s.qa.map((q, i) => {
    const goldPaths = new Set<string>();
    for (const ev of q.evidence ?? []) {
      const m = ev.match(EVIDENCE_DIA);
      if (!m) continue;
      const path = sessionPathByDiaPrefix.get(`D${m[1]}`);
      if (path) goldPaths.add(path);
    }
    return {
      id: `${s.sample_id}-q${i}`,
      text: q.question,
      goldAnswer: String(q.answer),
      goldDocIds: [...goldPaths],
      metadata: q.category !== undefined ? { category: q.category } : undefined,
    };
  });
  return { docs, questions };
}

const DATASET_NAME = 'locomo';
const DOWNLOAD_URL =
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';
const CACHE_FILE = 'locomo10.json';

export async function loadLoCoMo(cache: BenchCache): Promise<BenchCorpus> {
  const hit = await cache.readIfHit(DATASET_NAME, CACHE_FILE);
  let raw: Buffer;
  if (hit) {
    raw = hit;
  } else {
    const res = await fetch(DOWNLOAD_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch LoCoMo from ${DOWNLOAD_URL}: ${res.status}. ` +
          `Cache miss with no network. Manually download into ~/.cache/ax-memory-bench/${DATASET_NAME}/${CACHE_FILE}.`,
      );
    }
    raw = Buffer.from(await res.arrayBuffer());
    await cache.write(DATASET_NAME, CACHE_FILE, raw);
  }
  const samples = JSON.parse(raw.toString()) as LoCoMoSample[];
  const corpus: BenchCorpus = { name: 'locomo', memoryTree: new Map(), questions: [] };
  for (const sample of samples) {
    const { docs, questions } = transformLoCoMoSample(sample);
    for (const [path, doc] of docs) corpus.memoryTree.set(path, doc);
    corpus.questions.push(...questions);
  }
  return corpus;
}
