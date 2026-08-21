// ---------------------------------------------------------------------------
// The bench driver: run rung 3 over a conversation, then ask it questions.
//
// The one thing this file exists to get right is that it runs THE SHIPPING
// CODE. `summarizeConversation` here is the same function main.ts calls, with
// the same instructions and the same splice — a bench that reimplements the
// transform measures the reimplementation.
//
// The arms:
//
//   `compacted` — summarize, then ask. This is what a user gets on a long
//   conversation, and the number that matters.
//   `verbatim`  — ask the same questions against the UNTOUCHED conversation.
//   The control, and it is not decoration: a needle the model cannot answer
//   from the full transcript was never a compaction failure, and without this
//   arm every question the filler happens to bury reads as one. The gate is
//   the DELTA between the two, not the compacted number alone.
// ---------------------------------------------------------------------------

import type { ModelMessage } from 'ai';
import {
  planSummarization,
  summarizeConversation,
} from '../../src/compaction/summarize.js';
import { estimateMessageTokens } from '../../src/compaction/estimate.js';
import { questionMessage, type BenchConversation, type Needle } from './corpus.js';
import { judgeAnswer, type CompletionClient, type Verdict } from './judge.js';

export type Arm = 'compacted' | 'verbatim';

export interface NeedleResult {
  conversation: string;
  arm: Arm;
  needleId: string;
  question: string;
  answer: string;
  verdict: Verdict;
  reason: string;
}

export interface ConversationResult {
  conversation: string;
  /** Estimated tokens before and after rung 3, and the messages either side. */
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  summary: string;
  results: NeedleResult[];
  /** Set when rung 3 declined or failed; the conversation is then skipped. */
  skipped?: string;
}

export interface RunOptions {
  conversation: BenchConversation;
  /** The model under test: summarizes, and answers the questions. */
  agent: CompletionClient;
  /** A DIFFERENT model, ideally. Grades the answers. */
  judge: CompletionClient;
  /** Answers questions with a message list as context. */
  ask: (messages: ModelMessage[]) => Promise<string>;
  arms?: readonly Arm[];
  log?: (line: string) => void;
}

export async function runConversation(
  opts: RunOptions,
): Promise<ConversationResult> {
  const { conversation, agent, judge, ask } = opts;
  const log = opts.log ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const arms = opts.arms ?? (['compacted', 'verbatim'] as const);

  const plan = planSummarization(conversation.messages);
  if (plan === null) {
    return emptyResult(conversation, 'rung 3 declined to plan this conversation');
  }

  // FAIRNESS CHECK, not a formality. If a planted fact landed in the head or
  // the tail it survives verbatim and would be scored as successful recall
  // through a summary it never went through. Fail loudly rather than publish an
  // inflated number.
  const preserved = JSON.stringify([...plan.head, ...plan.tail]);
  const middle = JSON.stringify(plan.middle);
  for (const needle of conversation.needles) {
    if (needle.unanswerable) continue;
    if (needle.marker === undefined) {
      throw new Error(
        `corpus bug: answerable needle ${needle.id} has no marker, so there is ` +
          `no way to prove it was actually summarized rather than preserved.`,
      );
    }
    if (preserved.includes(needle.marker)) {
      throw new Error(
        `corpus bug: needle ${needle.id} ("${needle.marker}") sits in the ` +
          `PRESERVED region, so the compacted arm would recall it without the ` +
          `summary doing any work. Move it deeper into the conversation.`,
      );
    }
    if (!middle.includes(needle.marker)) {
      throw new Error(
        `corpus bug: needle ${needle.id} ("${needle.marker}") is not in the ` +
          `summarized region at all — the question has no answer to lose.`,
      );
    }
  }

  log(`  summarizing ${plan.middle.length} of ${conversation.messages.length} messages…`);
  const summarized = await summarizeConversation({
    messages: conversation.messages,
    summarizeText: agent,
  });
  if (!summarized.ok) {
    return emptyResult(conversation, `rung 3 failed: ${summarized.reason}`);
  }

  const results: NeedleResult[] = [];
  for (const arm of arms) {
    const context = arm === 'compacted' ? summarized.messages : conversation.messages;
    for (const needle of conversation.needles) {
      results.push(
        await scoreNeedle({ arm, context, needle, ask, judge, conversation }),
      );
    }
  }

  return {
    conversation: conversation.name,
    tokensBefore: estimateMessageTokens(conversation.messages),
    tokensAfter: estimateMessageTokens(summarized.messages),
    messagesBefore: conversation.messages.length,
    messagesAfter: summarized.messages.length,
    summary: summaryTextOf(summarized.messages),
    results,
  };
}

async function scoreNeedle(input: {
  arm: Arm;
  context: readonly ModelMessage[];
  needle: Needle;
  ask: (messages: ModelMessage[]) => Promise<string>;
  judge: CompletionClient;
  conversation: BenchConversation;
}): Promise<NeedleResult> {
  const { arm, context, needle, ask, judge, conversation } = input;
  const answer = await ask([...context, questionMessage(needle.question)]);
  const judged = await judgeAnswer({
    client: judge,
    question: needle.question,
    gold: needle.gold,
    answer,
    unanswerable: needle.unanswerable,
  });
  return {
    conversation: conversation.name,
    arm,
    needleId: needle.id,
    question: needle.question,
    answer,
    verdict: judged.verdict,
    reason: judged.reason,
  };
}

/** The spliced summary message's text, for the report. */
function summaryTextOf(messages: readonly ModelMessage[]): string {
  const spliced = messages[1];
  if (spliced === undefined || typeof spliced.content === 'string') return '';
  const text = spliced.content.find((p) => p.type === 'text');
  return text !== undefined && 'text' in text ? text.text : '';
}

function emptyResult(
  conversation: BenchConversation,
  skipped: string,
): ConversationResult {
  return {
    conversation: conversation.name,
    tokensBefore: estimateMessageTokens(conversation.messages),
    tokensAfter: estimateMessageTokens(conversation.messages),
    messagesBefore: conversation.messages.length,
    messagesAfter: conversation.messages.length,
    summary: '',
    results: [],
    skipped,
  };
}
