import type { MarkdownDoc, BenchQuestion, BenchCorpus } from '../types.js';
import { makeDoc } from './shared.js';
import { BenchCache } from '../cache.js';

export interface LoCoMoSample {
  sample_id: string;
  conversation: Array<{ speaker: string; text: string }>;
  qa: Array<{ question: string; answer: string }>;
}

export function transformLoCoMoSample(s: LoCoMoSample): {
  docs: Map<string, MarkdownDoc>;
  questions: BenchQuestion[];
} {
  const slug = s.sample_id;
  const body = s.conversation.map((t) => `**${t.speaker}:** ${t.text}`).join('\n\n');
  const summary = (s.conversation[0]?.text ?? '').slice(0, 200);
  const doc = makeDoc({ category: 'episodes', slug, summary, body });
  const docs = new Map([[doc.path, doc]]);
  const questions: BenchQuestion[] = s.qa.map((q, i) => ({
    id: `${s.sample_id}-q${i}`,
    text: q.question,
    goldAnswer: q.answer,
    goldDocIds: [doc.path],
  }));
  return { docs, questions };
}

const DATASET_NAME = 'locomo';
const HF_DOWNLOAD_URL =
  'https://huggingface.co/datasets/snap-research/LoCoMo/resolve/main/data.json';

export async function loadLoCoMo(cache: BenchCache): Promise<BenchCorpus> {
  const hit = await cache.readIfHit(DATASET_NAME, 'data.json');
  let raw: Buffer;
  if (hit) {
    raw = hit;
  } else {
    const res = await fetch(HF_DOWNLOAD_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch LoCoMo from ${HF_DOWNLOAD_URL}: ${res.status}. ` +
          `Cache miss with no network. Manually download into ~/.cache/ax-memory-bench/${DATASET_NAME}/data.json.`,
      );
    }
    raw = Buffer.from(await res.arrayBuffer());
    await cache.write(DATASET_NAME, 'data.json', raw);
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
