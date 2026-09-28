/**
 * Pure helpers for the fact-links answer arm (`memory-fact-links-e2e.mjs`): annotate a
 * `memory_recall` evidence table with Jev fact links, and the paired statistics the report
 * needs. No network, no clock, no filesystem.
 */
import { escapeStatementText } from '../packages/memory/dist/index.js';

/** The legend a treated tool result carries above its table. Part of the treatment. */
export const LINK_LEGEND =
  'Notes in ⟨…⟩ link statements to each other. "later updated" means a newer statement changed that value, ' +
  'so the older one is no longer current — but it is still what was true at its date. "replaces earlier" marks the newer one. ' +
  '"same event as" means two statements describe one event, item or action: count it once.';

const words = (value) => value.replace(/_/g, ' ').trim();

/**
 * The statement cell `renderEvidenceTable` writes for a caller-subject fact:
 * `user <relation in words>: <value>`, each part through the product's own escaper, so a
 * link matches a row exactly or not at all.
 */
export function statementKey(relation, value) {
  return `user ${escapeStatementText(words(relation))}: ${escapeStatementText(value)}`;
}

function note(kind, other) {
  const label = kind === 'later' ? 'later updated' : kind === 'earlier' ? 'replaces earlier' : 'same event as';
  return `⟨${label} (${other.when.slice(0, 10)}): ${escapeStatementText(words(other.relation))}: ${escapeStatementText(other.value, 200)}⟩`;
}

/**
 * Append a note to every evidence row that is one end of a link, naming the other end —
 * including when the other end was NOT recalled, which is how a link can surface a value
 * retrieval missed. Rows outside every link are untouched, and so is everything above the
 * table except the legend, which is added only when at least one note is.
 *
 * @param {string} text   a `memory_recall` result
 * @param {Array<{link: 'updates'|'same_event', a: {relation,value,when}, b: {relation,value,when}}>} links
 * @returns {{ text: string, notes: number }}
 */
export function annotateEvidence(text, links) {
  const byRow = new Map();
  const add = (fact, n) => {
    const key = statementKey(fact.relation, fact.value);
    if (!byRow.has(key)) byRow.set(key, []);
    const list = byRow.get(key);
    if (!list.includes(n)) list.push(n);
  };
  for (const { link, a, b } of links) {
    if (link === 'updates') { add(a, note('later', b)); add(b, note('earlier', a)); }
    else { add(a, note('same', b)); add(b, note('same', a)); }
  }
  let notes = 0;
  const lines = text.split('\n').map((line) => {
    if (!line.startsWith('| [') || !line.endsWith(' |')) return line;
    const cut = line.lastIndexOf(' | ', line.length - 3);
    if (cut < 0) return line;
    const statement = line.slice(cut + 3, line.length - 2);
    const extra = byRow.get(statement);
    if (!extra) return line;
    notes += extra.length;
    return `${line.slice(0, line.length - 2)} ${extra.join(' ')} |`;
  });
  if (notes === 0) return { text, notes };
  const at = lines.indexOf('Evidence table:');
  if (at >= 0) lines.splice(at, 0, LINK_LEGEND, '');
  return { text: lines.join('\n'), notes };
}

export const isCorrect = (verdict) => verdict === 'correct' || verdict === 'abstained-correctly';

/** Exact two-sided McNemar p over the discordant pairs (b wins one way, c the other). */
export function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let term = 0.5 ** n; // C(n,0) / 2^n
  for (let i = 0; i <= k; i += 1) {
    tail += term;
    term *= (n - i) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

/**
 * Pair `off` and `on` rows of one model by question: both right, both wrong, and the two
 * discordant directions.
 */
export function pairOutcomes(rows, model) {
  const off = new Map(rows.filter((r) => r.model === model && r.condition === 'off').map((r) => [r.questionId, r]));
  const out = { pairs: 0, bothRight: 0, bothWrong: 0, gained: [], lost: [] };
  for (const on of rows.filter((r) => r.model === model && r.condition === 'on')) {
    const base = off.get(on.questionId);
    if (!base) continue;
    out.pairs += 1;
    const x = isCorrect(base.verdict);
    const y = isCorrect(on.verdict);
    if (x && y) out.bothRight += 1;
    else if (!x && !y) out.bothWrong += 1;
    else if (y) out.gained.push(on.questionId);
    else out.lost.push(on.questionId);
  }
  return out;
}

/**
 * The same loop, FORKED at the first link note (the variance-reduction design).
 *
 * The model answers exactly as in `off` until the first `memory_recall` whose result WOULD
 * carry a note. There the conversation splits: one branch continues with the plain tool
 * text, the other with the annotated text, both from the identical prefix. A run that never
 * reaches a note is provably unaffected by the treatment, so it is answered once and counts
 * as "no change" — which removes every pure-noise pair the unforked design had to pay for.
 *
 * `toolResult(use)` answers one tool call as `{ plain, annotated, notes }`; `request(body,
 * upperUsd)` performs one chat-completions call. Both are injected, so this is testable
 * with a fake model.
 */
export async function answerForked({ request, config, maxToolTurns, maxPrice, system, question, descriptor, toolResult }) {
  const tool = { type: 'function', function: { name: descriptor.name, description: descriptor.description, parameters: descriptor.inputSchema } };
  const step = async (messages, startTurn, mode) => {
    for (let turn = startTurn; turn <= maxToolTurns; turn += 1) {
      const toolsAllowed = turn < maxToolTurns;
      const body = {
        model: config.id, max_tokens: config.maxTokens, reasoning: { effort: config.effort },
        provider: { ...(config.provider ?? {}), max_price: maxPrice },
        messages: [{ role: 'system', content: system }, ...messages],
        ...(toolsAllowed ? { tools: [tool] } : {}),
      };
      const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      const upper = config.price
        ? (bytes * config.price.input + config.maxTokens * config.price.output) / 1e6
        : (bytes * 10 + config.maxTokens * 20) / 1e6;
      const response = await request(body, upper);
      const message = response.choices?.[0]?.message;
      if (!message || typeof message !== 'object') throw new Error('Invalid OpenRouter message');
      const uses = message.tool_calls ?? [];
      const text = typeof message.content === 'string' ? message.content : '';
      if (!toolsAllowed || !uses.length) return { answer: text };
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: uses });
      for (let i = 0; i < uses.length; i += 1) {
        const use = uses[i];
        const result = await toolResult(use);
        if (mode === 'probe' && result.notes > 0) {
          const rest = uses.slice(i + 1);
          const branch = async (arm) => {
            const copy = structuredClone(messages);
            copy.push({ role: 'tool', tool_call_id: use.id, content: arm === 'on' ? result.annotated : result.plain });
            for (const other of rest) {
              const r = await toolResult(other);
              copy.push({ role: 'tool', tool_call_id: other.id, content: arm === 'on' ? r.annotated : r.plain });
            }
            return step(copy, turn + 1, arm);
          };
          const off = await branch('off');
          const on = await branch('on');
          return { forked: true, forkTurn: turn, off, on };
        }
        messages.push({ role: 'tool', tool_call_id: use.id, content: mode === 'on' ? result.annotated : result.plain });
      }
    }
    return { answer: '' };
  };
  const probe = await step([{ role: 'user', content: question }], 0, 'probe');
  return probe.forked ? probe : { forked: false, answer: probe.answer };
}

