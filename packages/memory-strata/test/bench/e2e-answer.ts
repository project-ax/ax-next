// E2E answer client (TASK-189). Runs ONE question turn against the real
// shipped runtime's answer path: the system prompt carries memory-strata's
// `system-prompt:augment` block (User Profile + Recent), and the agent is given
// the real `memory_search` tool so it can retrieve from the consolidated index
// per turn — exactly the two memory surfaces the shipped CLI exposes.
//
// Distinct from `agent.ts` (the bench A–E generic agent, which is handed a
// pre-retrieved doc list and never calls a tool): this client drives a bounded
// Anthropic tool-use loop, dispatching each `memory_search` call back through a
// caller-supplied executor (wired to the plugin's `tool:execute:memory_search`).

import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry.js';

/** A single memory_search result row, mirrored from the indexer's output. */
export interface MemorySearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  score: number;
}

/** Executes one memory_search call (wired to the plugin's tool hook). */
export type MemorySearchFn = (args: {
  query: string;
  topK?: number;
  categoryFilter?: string;
}) => Promise<MemorySearchResult[]>;

export interface E2EAnswer {
  text: string;
  usage: { in: number; out: number };
  /** Number of memory_search tool calls the agent made this turn. */
  toolCalls: number;
}

export interface E2EAnswerClient {
  answer(args: {
    /** memory-strata's injected block (User Profile + Recent), possibly ''. */
    injectedMemory: string;
    /** The question to answer. */
    question: string;
    /** Executor for the agent's memory_search calls. */
    search: MemorySearchFn;
  }): Promise<E2EAnswer>;
}

const SYSTEM_PREAMBLE = `You are a helpful personal assistant answering a question from your long-term memory of past conversations with this user.

Your injected memory below contains your User Profile and a Recent summary. You ALSO have a \`memory_search\` tool that searches your full long-term memory for relevant past conversations — use it BEFORE asserting any durable fact (a preference, decision, date, or known entity) that isn't already in the injected memory.

If, after searching, your memory does not contain the answer, say "I don't know." — do NOT guess or fabricate. Be concise.`;

const MEMORY_SEARCH_TOOL: Anthropic.Tool = {
  name: 'memory_search',
  description:
    'Search long-term memory. Returns document summaries (~50 tokens each). ' +
    'Use this BEFORE asserting facts about durable preferences, decisions, or known entities.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language search.' },
      topK: { type: 'number', description: 'Default 5; max 20.' },
      categoryFilter: {
        type: 'string',
        description: 'Optional. One of: entity | preference | decision | episode | general',
      },
    },
    required: ['query'],
  },
};

/** Default ceiling on memory_search round-trips per question (cost + loop bound). */
const DEFAULT_MAX_TOOL_TURNS = 4;
const MAX_ANSWER_TOKENS = 512;

/**
 * Build the answer client over the real Anthropic API.
 *
 * `model` defaults to `claude-sonnet-4-6` — the same answer LLM the bench A–E
 * path uses (`makeAnthropicAgentClient`), so the e2e number is comparable. The
 * report NAMES this model + the judge so the absolute accuracy is apples-to-
 * apples against a published LongMemEval-S baseline.
 */
export function makeAnthropicAnswerClient(
  apiKey: string,
  opts: { model?: string; maxToolTurns?: number } = {},
): E2EAnswerClient {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const maxToolTurns = opts.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  const a = new Anthropic({ apiKey });
  // Adapt the SDK client to the narrow {messages:{create}} shape runAnswerLoop
  // needs. A direct pass of `a` doesn't typecheck — the SDK's create() has a
  // broader (contravariant) param type and a richer Message return than our
  // local AnswerRequest/AnswerResponse. The adapter narrows both at the boundary.
  const client: AnswerClient = {
    messages: {
      async create(req: AnswerRequest): Promise<AnswerResponse> {
        const resp = await a.messages.create({
          model: req.model,
          max_tokens: req.max_tokens,
          system: req.system,
          messages: req.messages as Anthropic.MessageParam[],
          ...(req.tools ? { tools: req.tools } : {}),
        });
        return {
          content: resp.content as AnswerBlock[],
          usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens },
        };
      },
    },
  };
  return {
    async answer({ injectedMemory, question, search }) {
      const system = injectedMemory.trim().length > 0
        ? `${SYSTEM_PREAMBLE}\n\n# Injected memory\n${injectedMemory}`
        : SYSTEM_PREAMBLE;
      return runAnswerLoop({ client, model, maxToolTurns, system, question, search });
    },
  };
}

/** The narrow client shape runAnswerLoop drives (also satisfied by test stubs). */
export interface AnswerClient {
  messages: { create: (req: AnswerRequest) => Promise<AnswerResponse> };
}

/**
 * Drive the bounded tool-use loop against an injected Anthropic client. Factored
 * out (and exported) so a unit test can pass a stub `client` with the same
 * `messages.create` shape — no network, deterministic tool round-trip.
 */
export async function runAnswerLoop(deps: {
  client: AnswerClient;
  model: string;
  maxToolTurns: number;
  system: string;
  question: string;
  search: MemorySearchFn;
}): Promise<E2EAnswer> {
  const { client, model, maxToolTurns, system, question, search } = deps;
  const messages: AnswerMessage[] = [{ role: 'user', content: question }];
  let totalIn = 0;
  let totalOut = 0;
  let toolCalls = 0;

  // One extra iteration beyond maxToolTurns so the model gets a final
  // no-tools turn to actually answer after its last search.
  for (let turn = 0; turn <= maxToolTurns; turn++) {
    const allowTools = turn < maxToolTurns;
    const resp = await withRetry(
      () =>
        client.messages.create({
          model,
          max_tokens: MAX_ANSWER_TOKENS,
          system,
          messages,
          ...(allowTools ? { tools: [MEMORY_SEARCH_TOOL] } : {}),
        }),
      { attempts: 4, baseDelayMs: 1000, label: 'anthropic-e2e-answer' },
    );
    totalIn += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;

    const toolUses = resp.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0 || !allowTools) {
      const text = textOf(resp.content);
      return { text, usage: { in: totalIn, out: totalOut }, toolCalls };
    }

    // Echo the assistant turn, then answer every tool_use in one user turn.
    messages.push({ role: 'assistant', content: resp.content });
    const results: ToolResultBlock[] = [];
    for (const use of toolUses) {
      toolCalls += 1;
      const input = (use.input ?? {}) as {
        query?: unknown;
        topK?: unknown;
        categoryFilter?: unknown;
      };
      const query = typeof input.query === 'string' ? input.query : '';
      const rows = await search({
        query,
        ...(typeof input.topK === 'number' ? { topK: input.topK } : {}),
        ...(typeof input.categoryFilter === 'string'
          ? { categoryFilter: input.categoryFilter }
          : {}),
      });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: formatSearchResults(rows),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  // Loop exhausted without a text-only turn (shouldn't happen — the last
  // iteration has tools disabled). Return whatever we have.
  return { text: '', usage: { in: totalIn, out: totalOut }, toolCalls };
}

function formatSearchResults(rows: MemorySearchResult[]): string {
  if (rows.length === 0) return 'No matching memory documents found.';
  return rows
    .map((r, i) => `[${i + 1}] (${r.docId}) ${r.summary}`)
    .join('\n');
}

function textOf(content: AnswerBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// Minimal structural types for the subset of the Anthropic Messages API this
// loop touches — kept local so the unit test can supply a stub `client` without
// importing the SDK's full request/response types.
interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
type AnswerBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown };
interface AnswerMessage {
  role: 'user' | 'assistant';
  content: string | AnswerBlock[] | ToolResultBlock[];
}
interface AnswerRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: AnswerMessage[];
  tools?: Anthropic.Tool[];
}
interface AnswerResponse {
  content: AnswerBlock[];
  usage: { input_tokens: number; output_tokens: number };
}
