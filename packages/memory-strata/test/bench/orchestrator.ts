import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { withRetry } from './retry.js';
import type { BenchCorpus, RetrievedDoc } from './types.js';

export interface OrchestratorClient {
  complete(args: { system: string; user: string }): Promise<{
    text: string;
    usage: { in: number; out: number };
  }>;
}

export type OrchestratorOp =
  | { kind: 'load'; doc: string; section?: string }
  | { kind: 'fts'; query: string };

export interface OrchestratorPlan {
  ops: OrchestratorOp[];
  followupNeeded: boolean;
}

export interface OrchestratorRunResult extends OrchestratorPlan {
  usage: { in: number; out: number };
  rawXml: string;
}

const SYSTEM = `You are a retrieval planner. You read a memory map (a hierarchical
listing of every document in the agent's memory with one-line summaries) and a
user query, and decide which documents the agent should load before answering.

You output ONLY XML, using these tags:

  <load doc="<docPath>"/>                — load a whole document into context
  <load doc="<docPath>" section="..."/>  — load just one section of a document
  <fts query="..."/>                     — when you genuinely cannot decide from the
                                            map alone, run a BM25 keyword search
                                            (max 1-2 of these per query)
  <followup needed="true"/>              — emit when you suspect one hop won't be
                                            enough (e.g., cross-doc aggregation,
                                            "what was X before we changed it")

Rules:
- Emit between 1 and 5 ops total. Prefer the smallest precise set.
- Doc paths must exactly match entries in the map (e.g. "episodes/s-001").
- Do not output prose, code fences, or explanations. Only the XML ops.`;

export async function runOrchestrator(
  client: OrchestratorClient,
  map: string,
  query: string,
): Promise<OrchestratorRunResult> {
  const user = `## Memory Map\n${map}\n\n## Query\n${query}\n\n## Output\n`;
  const resp = await client.complete({ system: SYSTEM, user });
  const plan = parseOrchestratorXml(resp.text);
  return { ...plan, usage: resp.usage, rawXml: resp.text };
}

const FENCE_RE = /^```[a-z]*\n?|\n?```$/g;
const LOAD_RE = /<load\s+([^>]*?)\/?>/gi;
const FTS_RE = /<fts\s+([^>]*?)\/?>/gi;
const FOLLOWUP_RE = /<followup\s+[^>]*needed=["']?true["']?[^>]*\/?>/i;
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseOrchestratorXml(text: string): OrchestratorPlan {
  const stripped = text.replace(FENCE_RE, '').trim();
  const ops: OrchestratorOp[] = [];

  for (const m of stripped.matchAll(LOAD_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (attrs.doc) {
      const op: OrchestratorOp = { kind: 'load', doc: attrs.doc };
      if (attrs.section) op.section = attrs.section;
      ops.push(op);
    }
  }
  for (const m of stripped.matchAll(FTS_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (attrs.query) ops.push({ kind: 'fts', query: attrs.query.trim() });
  }
  return { ops, followupNeeded: FOLLOWUP_RE.test(stripped) };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const name = m[1]!;
    const raw = m[2] ?? m[3] ?? '';
    out[name] = decodeEntities(raw);
  }
  return out;
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

/**
 * Decode the five predefined XML entities in a SINGLE left-to-right pass. A
 * chained `.replace()` sequence (unescape `&amp;`→`&` first, then `&lt;`→`<`,
 * …) double-unescapes — e.g. the escaped literal `&amp;lt;` would become `&lt;`
 * and then `<`. One global regex + a lookup map replaces each entity exactly
 * once over the ORIGINAL string, so a `&` produced by decoding `&amp;` is never
 * re-scanned. Mirrors src/orchestrator.ts (TASK-191 CodeQL js/double-escaping
 * fix) so the two decoders don't drift.
 */
function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

export interface RunOpsContext {
  corpus: BenchCorpus;
  ftsSearch: (query: string, topK: number) => Promise<RetrievedDoc[]>;
  topK: number;
}

export async function runOps(
  plan: OrchestratorPlan,
  ctx: RunOpsContext,
): Promise<RetrievedDoc[]> {
  const seen = new Set<string>();
  const out: RetrievedDoc[] = [];
  for (const op of plan.ops) {
    if (op.kind === 'load') {
      const doc = ctx.corpus.memoryTree.get(op.doc);
      if (!doc || seen.has(doc.path)) continue;
      seen.add(doc.path);
      out.push({ path: doc.path, score: 1, summary: doc.summary });
      if (out.length >= ctx.topK) return out;
    } else if (op.kind === 'fts') {
      const hits = await ctx.ftsSearch(op.query, ctx.topK);
      for (const h of hits) {
        if (seen.has(h.path)) continue;
        seen.add(h.path);
        out.push(h);
        if (out.length >= ctx.topK) return out;
      }
    }
  }
  return out;
}

export function makeAnthropicOrchestratorClient(
  apiKey: string,
  model = 'claude-haiku-4-5-20251001',
): OrchestratorClient {
  const a = new Anthropic({ apiKey });
  return {
    async complete({ system, user }) {
      return withRetry(
        async () => {
          const resp = await a.messages.create({
            model,
            max_tokens: 512,
            system,
            messages: [{ role: 'user', content: user }],
          });
          const text = resp.content
            .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('');
          return { text, usage: { in: resp.usage.input_tokens, out: resp.usage.output_tokens } };
        },
        { attempts: 4, baseDelayMs: 1000, label: 'anthropic-orchestrator' },
      );
    },
  };
}

export function makeOpenRouterOrchestratorClient(
  apiKey: string,
  model = 'x-ai/grok-4.1-fast',
  forceProvider?: string,
): OrchestratorClient {
  const o = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1', timeout: 60_000 });
  return {
    async complete({ system, user }) {
      return withRetry(
        async () => {
          // OpenRouter-specific routing override; the openai SDK types don't
          // include `provider`, but the underlying HTTP API passes it through.
          // See https://openrouter.ai/docs/features/provider-routing.
          // We cast the routing extension through `unknown` so the create()
          // overload still resolves to the non-streaming variant.
          const providerExt = forceProvider
            ? ({ provider: { order: [forceProvider], allow_fallbacks: false } } as unknown as Record<string, never>)
            : ({} as Record<string, never>);
          const resp = await o.chat.completions.create({
            model,
            max_tokens: 512,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            ...providerExt,
          });
          const text = resp.choices?.[0]?.message?.content ?? '';
          const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
          return { text, usage: { in: usage.prompt_tokens, out: usage.completion_tokens } };
        },
        { attempts: 4, baseDelayMs: 1000, label: 'openrouter-orchestrator' },
      );
    },
  };
}

export function makeXaiOrchestratorClient(
  apiKey: string,
  model = 'grok-4-fast-non-reasoning',
): OrchestratorClient {
  const o = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1', timeout: 60_000 });
  return {
    async complete({ system, user }) {
      return withRetry(
        async () => {
          const resp = await o.chat.completions.create({
            model,
            max_tokens: 512,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          });
          const text = resp.choices?.[0]?.message?.content ?? '';
          const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
          return { text, usage: { in: usage.prompt_tokens, out: usage.completion_tokens } };
        },
        { attempts: 4, baseDelayMs: 1000, label: 'xai-orchestrator' },
      );
    },
  };
}
