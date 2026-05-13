import type { MarkdownDoc, BenchQuestion, BenchCorpus } from '../types.js';
import { makeDoc } from './shared.js';
import { BenchCache } from '../cache.js';

export interface LongMemEvalTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LongMemEvalSample {
  question_id: string;
  question_type?: string;
  question: string;
  question_date?: string;
  answer: string;
  answer_session_ids?: string[];
  haystack_dates?: string[];
  haystack_session_ids: string[];
  haystack_sessions: LongMemEvalTurn[][];
}

export function transformLongMemEvalSample(s: LongMemEvalSample): {
  docs: Map<string, MarkdownDoc>;
  question: BenchQuestion;
} {
  const docs = new Map<string, MarkdownDoc>();
  const ids = s.haystack_session_ids;
  const sessions = s.haystack_sessions;
  for (let i = 0; i < sessions.length; i++) {
    const sessionId = ids[i] ?? `session-${i}`;
    const turns = sessions[i] ?? [];
    const body = turns
      .map((t) => `## ${t.role}\n${t.content}`)
      .join('\n\n');
    const summary = firstSentence(turns.map((t) => t.content).join(' '));
    const doc = makeDoc({
      category: 'episodes',
      slug: sessionId,
      summary,
      body,
    });
    docs.set(doc.path, doc);
  }
  // LongMemEval-S marks unanswerable questions with an `_abs` suffix on question_id;
  // their gold answer is shaped like "You did not mention this information…".
  const unanswerable = s.question_id.endsWith('_abs');
  const haystackPaths = (s.haystack_session_ids ?? []).map((id) => `episodes/${id}`);
  const metaParts: Record<string, unknown> = {};
  if (s.question_type) metaParts.question_type = s.question_type;
  if (unanswerable) metaParts.unanswerable = true;
  if (haystackPaths.length > 0) metaParts.haystackPaths = haystackPaths;
  return {
    docs,
    question: {
      id: s.question_id,
      text: s.question,
      goldAnswer: s.answer,
      goldDocIds: (s.answer_session_ids ?? []).map((id) => `episodes/${id}`),
      metadata: Object.keys(metaParts).length > 0 ? metaParts : undefined,
    },
  };
}

function firstSentence(s: string): string {
  const m = s.match(/^[^.!?]{10,200}[.!?]/);
  return (m ? m[0] : s).slice(0, 200);
}

const DATASET_NAME = 'longmemeval-s';
const HF_DOWNLOAD_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json';
const CACHE_FILE = 'longmemeval_s_cleaned.json';

export async function loadLongMemEvalS(cache: BenchCache): Promise<BenchCorpus> {
  const hit = await cache.readIfHit(DATASET_NAME, CACHE_FILE);
  let raw: Buffer;
  if (hit) {
    raw = hit;
  } else {
    const res = await fetch(HF_DOWNLOAD_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch LongMemEval-S from ${HF_DOWNLOAD_URL}: ${res.status}. ` +
          `Cache miss with no network. Manually download into ~/.cache/ax-memory-bench/${DATASET_NAME}/${CACHE_FILE}.`,
      );
    }
    raw = Buffer.from(await res.arrayBuffer());
    await cache.write(DATASET_NAME, CACHE_FILE, raw);
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
