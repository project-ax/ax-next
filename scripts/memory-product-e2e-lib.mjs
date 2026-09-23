import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const CONFIG = Object.freeze({
  sample: 100,
  accuracyGate: 0.76,
  recallP95GateMs: 1600,
  maxToolTurns: 6,
  answerMaxTokens: 512,
  extractionModel: 'z-ai/glm-5.3-flash:nitro',
  answerModels: { sonnet: 'claude-sonnet-4-6', glm: 'z-ai/glm-5.3-flash:nitro' },
  judgeModel: 'x-ai/grok-4.3',
  openRouterMaxPrice: { prompt: 10, completion: 20, request: 0 },
  sonnetInputPerMillion: 3,
  sonnetOutputPerMillion: 15,
  vertexPerThousandCharacters: 0.000025,
  coherePerSearchUnit: 0.0025,
});

export const ANSWER_PREAMBLE = `You are a helpful personal assistant answering a question from your long-term memory of past conversations with this user.

Your injected memory below contains a profile, recent observations, and a digest. You ALSO have a tool over your long-term memory:
- \`memory_recall\` — searches stored memory and returns a table of dated statements, not document summaries.

Before asserting any durable fact that isn't already in the injected memory: search first to confirm the value. If, after searching, your memory still does not contain the answer, say "I don't know." — do NOT guess or fabricate.

For counting or enumeration questions ("how many X did I…", "list all the Y"), the facts you need are usually scattered across multiple sessions, and each search returns only a CAPPED set of statements. Do NOT answer a count after one or two searches. Instead: read the matched facts across every result; run additional searches with instance-specific terms (e.g. for "citrus fruit" also try "lime", "lemon", "orange"); and only then count, tallying distinct instances and excluding near-duplicate lines that describe the same event. Under-counting from stopping early is the most common mistake here.

Be concise.`;

export class BudgetExceeded extends Error {
  constructor() { super('Benchmark budget exhausted; no further paid request was started'); }
}

export class ProviderError extends Error {
  constructor(provider, status) { super(`${provider} HTTP ${status}`); this.provider = provider; this.status = status; }
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export class Ledger {
  constructor(path, capUsd) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('Invalid spending cap');
    this.path = path;
    this.capUsd = capUsd;
    this.events = readJsonl(path);
    this.reservations = new Map();
    this.settlements = new Map();
    for (const event of this.events) this.apply(event);
    this.exhausted = false;
  }
  apply(event) {
    if (!event || typeof event.id !== 'string' || !Number.isFinite(event.type === 'reserve' ? event.upperUsd : event.usd) || (event.type === 'reserve' ? event.upperUsd : event.usd) < 0) throw new Error('Malformed ledger amount or identifier');
    if (event.type === 'reserve') {
      if (this.reservations.has(event.id)) throw new Error('Duplicate ledger reservation');
      this.reservations.set(event.id, event);
    } else if (event.type === 'settle') {
      if (!this.reservations.has(event.id) || this.settlements.has(event.id)) throw new Error('Invalid ledger settlement');
      this.settlements.set(event.id, event);
    } else throw new Error('Invalid ledger event');
  }
  append(event) {
    this.apply(event);
    appendFileSync(this.path, JSON.stringify(event) + '\n');
    this.events.push(event);
  }
  chargedUsd() {
    let total = 0;
    for (const [id, reservation] of this.reservations) total += this.settlements.get(id)?.usd ?? reservation.upperUsd;
    return total;
  }
  reserve(upperUsd, tags) {
    if (!Number.isFinite(upperUsd) || upperUsd < 0) throw new Error('Invalid request reservation');
    if (this.chargedUsd() + upperUsd > this.capUsd) { this.exhausted = true; throw new BudgetExceeded(); }
    const id = randomUUID();
    this.append({ ...tags, type: 'reserve', id, upperUsd });
    return id;
  }
  settle(id, usd, basis, details = {}) {
    if (!Number.isFinite(usd) || usd < 0) throw new Error('Invalid billed/estimated cost');
    this.append({ ...details, type: 'settle', id, usd, basis });
    if (this.chargedUsd() > this.capUsd) this.exhausted = true;
  }
  rows(runId) {
    return [...this.reservations.values()].filter(r => r.runId === runId).map(r => ({
      ...r, ...this.settlements.get(r.id),
      usd: this.settlements.get(r.id)?.usd ?? r.upperUsd,
      basis: this.settlements.get(r.id)?.basis ?? 'unsettled-upper-bound',
    }));
  }
}

export function percentile95(values) {
  if (values.length === 0) return null;
  if (values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid latency sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

export function aggregate(rows, expectedIds) {
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length) throw new Error('Duplicate pinned question IDs');
  const seen = new Set();
  for (const row of rows) {
    if (!expected.has(row.questionId) || seen.has(row.questionId)) throw new Error('Foreign or duplicate result row');
    if (!['correct', 'incorrect', 'abstained-correctly', 'abstained-incorrectly', 'uncertain', 'error'].includes(row.verdict) || !Array.isArray(row.recalls) || row.recalls.some(c => typeof c.ok !== 'boolean')) throw new Error('Malformed result row');
    seen.add(row.questionId);
  }
  const correct = rows.filter(r => ['correct', 'abstained-correctly'].includes(r.verdict)).length;
  const calls = rows.flatMap(r => r.recalls);
  const complete = rows.length === expectedIds.length;
  const accuracy = rows.length === 0 ? null : correct / rows.length;
  const p95Ms = percentile95(calls.map(c => c.ms));
  return {
    n: rows.length, expected: expectedIds.length, complete, correct, accuracy,
    searched: rows.filter(r => r.recalls.length > 0).length,
    toolCallRate: rows.length ? rows.filter(r => r.recalls.length > 0).length / rows.length : null,
    callsPerQuestion: rows.length ? calls.length / rows.length : null,
    recallCalls: calls.length, recallErrors: calls.filter(c => !c.ok).length, p95Ms,
    accuracyPassed: complete && accuracy !== null && accuracy >= CONFIG.accuracyGate,
    latencyPassed: complete && p95Ms !== null && p95Ms < CONFIG.recallP95GateMs,
    uncertain: rows.filter(r => r.verdict === 'uncertain').length,
    errors: rows.filter(r => r.verdict === 'error').length,
    unanswerable: rows.filter(r => r.unanswerable).length,
    correctRefusals: rows.filter(r => r.unanswerable && r.verdict === 'abstained-correctly').length,
    hallucinations: rows.filter(r => r.unanswerable && ['correct', 'incorrect'].includes(r.verdict)).length,
    falseRefusals: rows.filter(r => !r.unanswerable && r.verdict === 'abstained-incorrectly').length,
    degradedCalls: calls.filter(c => Array.isArray(c.degraded) && c.degraded.length > 0).length,
  };
}

export function buildSystem(memory, questionDate) {
  return `${ANSWER_PREAMBLE}${memory.trim() ? `\n\n# Injected memory\n${memory}` : ''}\n\nToday's date: ${questionDate}`;
}

function number(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Missing or invalid provider ${name}`);
  return value;
}

function tokenUpper(body) { return Buffer.byteLength(JSON.stringify(body), 'utf8') + 2048; }

export function makeClients({ env, ledger, tags, fetchImpl = fetch }) {
  let fatalError;
  async function requestOnce(url, body, headers, provider, upperUsd, costOf) {
    if (ledger.exhausted) throw new BudgetExceeded();
    const id = ledger.reserve(upperUsd, { ...tags(), provider });
    let settled = false;
    try {
      const response = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120_000), redirect: 'error',
      });
      if (!response.ok) {
        const error = new ProviderError(provider, response.status);
        if (response.status === 401 || response.status === 403) fatalError = error;
        throw error;
      }
      const json = await response.json();
      const priced = costOf(json);
      ledger.settle(id, priced.usd, priced.basis, priced.details);
      settled = true;
      return json;
    } finally {
      if (!settled && !ledger.settlements.has(id)) ledger.settle(id, upperUsd, 'uncertain-upper-bound');
    }
  }
  async function request(...args) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await requestOnce(...args); }
      catch (error) {
        if (!(error instanceof ProviderError) || ![429, 500, 502, 503, 504].includes(error.status) || attempt === 3) throw error;
        await new Promise(resolveRetry => setTimeout(resolveRetry, 1000 * 2 ** attempt));
      }
    }
    throw new Error('Provider retries exhausted');
  }
  async function openrouter(body) {
    const bounded = { ...body, provider: { max_price: CONFIG.openRouterMaxPrice } };
    const upper = tokenUpper(bounded) * 10 / 1e6 + body.max_tokens * 20 / 1e6;
    return request('https://openrouter.ai/api/v1/chat/completions', bounded,
      { authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, 'openrouter', upper,
      json => {
        const input = number(json.usage?.prompt_tokens, 'input tokens');
        const output = number(json.usage?.completion_tokens, 'output tokens');
        const actual = json.usage?.cost;
        return typeof actual === 'number' && Number.isFinite(actual) && actual >= 0
          ? { usd: actual, basis: 'provider-reported', details: { input, output, model: body.model } }
          : { usd: upper, basis: 'missing-cost-upper-bound', details: { input, output, model: body.model } };
      });
  }
  async function anthropic(body) {
    const upper = tokenUpper(body) * 6 / 1e6 + body.max_tokens * 15 / 1e6;
    return request('https://api.anthropic.com/v1/messages', body,
      { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, 'anthropic', upper,
      json => {
        const input = number(json.usage?.input_tokens, 'input tokens');
        const output = number(json.usage?.output_tokens, 'output tokens');
        const created = number(json.usage?.cache_creation_input_tokens ?? 0, 'cache creation tokens');
        const read = number(json.usage?.cache_read_input_tokens ?? 0, 'cache read tokens');
        return { usd: (input * 3 + output * 15 + created * 6 + read * 0.3) / 1e6,
          basis: 'published-rate-estimate', details: { input, output, created, read, model: body.model } };
      });
  }
  async function answer({ arm, system, question, descriptor, recall }) {
    const model = CONFIG.answerModels[arm];
    if (!model) throw new Error('Unknown answer arm');
    const messages = [{ role: 'user', content: question }];
    for (let turn = 0; turn <= CONFIG.maxToolTurns; turn++) {
      const toolsAllowed = turn < CONFIG.maxToolTurns;
      if (arm === 'sonnet') {
        const response = await anthropic({ model, max_tokens: CONFIG.answerMaxTokens, system, messages,
          ...(toolsAllowed ? { tools: [{ name: descriptor.name, description: descriptor.description, input_schema: descriptor.inputSchema }] } : {}) });
        if (!Array.isArray(response.content)) throw new Error('Invalid Anthropic content');
        const uses = response.content.filter(block => block.type === 'tool_use');
        if (!toolsAllowed || !uses.length) return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        messages.push({ role: 'assistant', content: response.content });
        const results = [];
        for (const use of uses) {
          const result = use.name === descriptor.name ? await recall(use.input) : { ok: false, text: 'Unknown tool' };
          results.push({ type: 'tool_result', tool_use_id: use.id, content: result.text, ...(!result.ok ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
      } else {
        const response = await openrouter({ model, max_tokens: CONFIG.answerMaxTokens,
          reasoning: { effort: 'minimal' }, messages: [{ role: 'system', content: system }, ...messages],
          ...(toolsAllowed ? { tools: [{ type: 'function', function: { name: descriptor.name, description: descriptor.description, parameters: descriptor.inputSchema } }] } : {}) });
        const message = response.choices?.[0]?.message;
        if (!message || typeof message !== 'object') throw new Error('Invalid OpenRouter message');
        const uses = message.tool_calls ?? [];
        if (!toolsAllowed || !uses.length) return typeof message.content === 'string' ? message.content : '';
        messages.push(message);
        for (const use of uses) {
          let result = { text: 'Unknown tool' };
          if (use.function?.name === descriptor.name) {
            let input;
            try { input = JSON.parse(use.function.arguments); }
            catch {
              messages.push({ role: 'tool', tool_call_id: use.id, content: 'Invalid tool arguments' });
              continue;
            }
            result = await recall(input);
          }
          messages.push({ role: 'tool', tool_call_id: use.id, content: result.text });
        }
      }
    }
    return '';
  }
  return { openrouter, anthropic, answer, get fatalError() { return fatalError; } };
}
