import type { MarkdownDoc, BenchQuestion, BenchCorpus } from '../types.js';
import { makeDoc } from './shared.js';
import { BenchCache } from '../cache.js';

export interface LongMemEvalSample {
  question_id: string;
  question: string;
  answer: string;
  haystack_sessions: Array<{
    session_id: string;
    turns: Array<{ role: 'user' | 'assistant'; content: string }>;
  }>;
  relevant_session_ids?: string[];
}

export function transformLongMemEvalSample(s: LongMemEvalSample): {
  docs: Map<string, MarkdownDoc>;
  question: BenchQuestion;
} {
  const docs = new Map<string, MarkdownDoc>();
  for (const session of s.haystack_sessions) {
    const body = session.turns
      .map((t) => `## ${t.role}\n${t.content}`)
      .join('\n\n');
    const summary = firstSentence(session.turns.map((t) => t.content).join(' '));
    const doc = makeDoc({
      category: 'episodes',
      slug: session.session_id,
      summary,
      body,
    });
    docs.set(doc.path, doc);
  }
  return {
    docs,
    question: {
      id: s.question_id,
      text: s.question,
      goldAnswer: s.answer,
      goldDocIds: (s.relevant_session_ids ?? []).map((id) => `episodes/${id}`),
    },
  };
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.!?]{10,200}[.!?]/);
  return (m ? m[0] : s).slice(0, 200);
}

const DATASET_NAME = 'longmemeval-s';
const HF_DOWNLOAD_URL =
  'https://huggingface.co/datasets/xiaowu0162/LongMemEval/resolve/main/longmemeval_s.json';

export async function loadLongMemEvalS(cache: BenchCache): Promise<BenchCorpus> {
  const hit = await cache.readIfHit(DATASET_NAME, 'longmemeval_s.json');
  let raw: Buffer;
  if (hit) {
    raw = hit;
  } else {
    const res = await fetch(HF_DOWNLOAD_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch LongMemEval-S from ${HF_DOWNLOAD_URL}: ${res.status}. ` +
          `Cache miss with no network. Manually download into ~/.cache/ax-memory-bench/${DATASET_NAME}/longmemeval_s.json.`,
      );
    }
    raw = Buffer.from(await res.arrayBuffer());
    await cache.write(DATASET_NAME, 'longmemeval_s.json', raw);
  }
  const samples = JSON.parse(raw.toString()) as LongMemEvalSample[];
  const corpus: BenchCorpus = { name: 'longmemeval-s', memoryTree: new Map(), questions: [] };
  for (const sample of samples) {
    const { docs, question } = transformLongMemEvalSample(sample);
    for (const [path, doc] of docs) corpus.memoryTree.set(path, doc);
    corpus.questions.push(question);
  }
  return corpus;
}
