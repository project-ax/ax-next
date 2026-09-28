#!/usr/bin/env node
/**
 * TASK-652 — opt-in LIVE eval of the extractor on negations.
 *
 * The CI suite never calls a model: `src/__tests__/negation.test.ts` pins the
 * guard against recorded extractor outputs. This script is the other half —
 * it sends each phrasing through the REAL pinned extraction prompt and shows
 * what the model produced and what the guard (`negation.ts`) did with it, so
 * the fixtures can be refreshed when the model or its behaviour changes.
 *
 * Costs a few cents of OpenRouter calls, so it only runs when you ask:
 *
 *     pnpm --filter @ax/memory build
 *     OPENROUTER_API_KEY=... node packages/memory/scripts/negation-eval.mjs [model]
 *
 * `model` defaults to the one the prompt's fingerprint is measured with.
 *
 * Per case it prints every extracted fact as KEPT or DROPPED, then flags:
 * - LEAK: a negation case where a kept fact's predicate maps to a profile
 *   slot and its value holds the negated word — the misreading got through.
 * - OVER-DROP: a control case where a dropped fact held the value word.
 * Exit code is 1 when anything is flagged.
 */
import { buildExtractionPrompt, EXTRACTION_MODEL_ID, EXTRACTION_SYSTEM_PROMPT } from '../dist/extraction-prompt.js';
import { parseFacts } from '../dist/extract.js';
import { isNegatedFact, negationIndex } from '../dist/negation.js';
import { deriveSlot } from '../dist/slots.js';

const CASES = [
  // [what the person said, the value word, whether it is negated]
  ['I never lived in Denver.', 'denver', true],
  ['Not Denver anymore.', 'denver', true],
  ["I don't live in Denver.", 'denver', true],
  ['I no longer live in Denver, Colorado.', 'denver', true],
  ["I've never worked at Acme Corp.", 'acme', true],
  ["My name isn't Robert.", 'robert', true],
  ['I used to live in Denver.', 'denver', true],
  ["I'm not from Denver.", 'denver', true],
  ['I live in Denver.', 'denver', false],
  ['Actually I do live in Denver, Colorado.', 'denver', false],
  ['No, I live in Denver.', 'denver', false],
  ["I don't live in Boston, I live in Denver.", 'denver', false],
  ["I can't wait to move to Denver.", 'denver', false],
  ["I don't mind living in Denver.", 'denver', false],
];

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('Set OPENROUTER_API_KEY to run the live eval. (We only spend your money when asked.)');
  process.exit(2);
}
const model = process.argv[2] ?? EXTRACTION_MODEL_ID;

async function extract(dialogue) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: buildExtractionPrompt(dialogue, new Date().toISOString()) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
  const body = await res.json();
  const parsed = parseFacts(body.choices?.[0]?.message?.content ?? '');
  if (!parsed.ok) throw new Error(`schema failure: ${parsed.detail}`);
  return parsed.facts;
}

let flagged = 0;
for (const [said, word, negated] of CASES) {
  const dialogue = `user: ${said}\nassistant: Got it.`;
  let facts;
  try {
    facts = await extract(dialogue);
  } catch (err) {
    console.log(`\n# ${said}\n  ERROR ${err.message}`);
    flagged += 1;
    continue;
  }
  const index = negationIndex(dialogue);
  console.log(`\n# ${said}`);
  for (const fact of facts) {
    const drop = isNegatedFact(fact, index);
    const holdsWord = fact.object.toLowerCase().includes(word);
    let flag = '';
    if (negated && !drop && holdsWord && deriveSlot(fact.predicate) !== null) flag = '  <-- LEAK';
    if (!negated && drop && holdsWord) flag = '  <-- OVER-DROP';
    if (flag !== '') flagged += 1;
    console.log(`  ${drop ? 'DROPPED' : 'KEPT   '} ${fact.subject} | ${fact.predicate} | ${fact.object}${flag}`);
  }
  if (facts.length === 0) console.log('  (no facts)');
}
console.log(`\n${flagged === 0 ? 'clean' : `${flagged} flagged`} — model ${model}`);
process.exit(flagged === 0 ? 0 : 1);
