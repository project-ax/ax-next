#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// `pnpm --filter @ax/agent-aisdk-runner bench`
//
// Opt-in, never in CI: it needs a real key and spends real money. What runs in
// CI is `__tests__/` beside this file — the corpus, the judge parser, and the
// scoring, all of which are deterministic. The model is the part CI cannot
// have, and the part §7 says carries the risk ("the risk is quality, not
// code"), which is exactly why it lives behind a command someone runs on
// purpose.
//
//   ANTHROPIC_API_KEY=… pnpm --filter @ax/agent-aisdk-runner bench
//   … bench -- --exchanges 60 --out /tmp/compaction-eval.md
//
// A REAL KEY, NOT THE PROXY PLACEHOLDER. In production the runner never holds
// a credential — `ax-cred:<hex>` is substituted mid-flight by the host's
// credential proxy (invariant 5). That machinery is not what this measures, so
// the bench talks to the provider directly with a key the operator supplies,
// the same way the memory-strata bench does. Nothing here runs in the sandbox
// or ships in the image.
// ---------------------------------------------------------------------------

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, type ModelMessage } from 'ai';
import { buildConversation } from './corpus.js';
import { runConversation, type ConversationResult } from './driver.js';
import { requireKeys } from './env.js';
import type { CompletionClient } from './judge.js';
import { DEFAULT_GATES, checkGates, renderReport, score } from './report.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-sonnet-4-6' },
    'judge-model': { type: 'string', default: 'claude-opus-4-6' },
    exchanges: { type: 'string', default: '40' },
    'tool-output-chars': { type: 'string', default: '1200' },
    facts: { type: 'string', default: '6' },
    out: { type: 'string' },
    'skip-verbatim': { type: 'boolean', default: false },
  },
});

const { ANTHROPIC_API_KEY } = requireKeys({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
});

const anthropic = createAnthropic({ apiKey: ANTHROPIC_API_KEY });
const model = anthropic(values.model!);
const judgeModel = anthropic(values['judge-model']!);

const complete =
  (m: ReturnType<typeof anthropic>, maxRetries = 3): CompletionClient =>
  async ({ instructions, prompt }) => {
    const { text } = await generateText({ model: m, instructions, prompt, maxRetries });
    return text;
  };

const ask = async (messages: ModelMessage[]): Promise<string> => {
  const { text } = await generateText({
    model,
    instructions:
      'You are a coding assistant continuing a conversation. Answer the final ' +
      'question using only what this conversation contains. Be brief.',
    messages,
    maxRetries: 3,
  });
  return text;
};

const conversation = buildConversation({
  exchanges: Number(values.exchanges),
  toolOutputChars: Number(values['tool-output-chars']),
  facts: Number(values.facts),
});

process.stdout.write(
  `bench: ${conversation.name} — ${conversation.messages.length} messages, ` +
    `${conversation.needles.length} needles ` +
    `(${conversation.needles.filter((n) => n.unanswerable).length} unanswerable)\n`,
);

const results: ConversationResult[] = [
  await runConversation({
    conversation,
    agent: complete(model),
    judge: complete(judgeModel),
    ask,
    arms: values['skip-verbatim'] === true ? ['compacted'] : ['compacted', 'verbatim'],
  }),
];

const s = score(results);
const report = renderReport({
  results,
  score: s,
  model: values.model!,
  judgeModel: values['judge-model']!,
  // Stamped at render time rather than threaded through the run: nothing in
  // the scoring depends on it.
  runDate: new Date().toISOString().slice(0, 10),
});

if (values.out !== undefined) {
  writeFileSync(values.out, report, 'utf8');
  process.stdout.write(`bench: wrote ${values.out}\n`);
}
process.stdout.write(`\n${report}`);

// Nonzero on a failed gate, so this can be run as a check rather than read as
// a document.
process.exitCode = checkGates(s, DEFAULT_GATES).passed ? 0 : 1;
