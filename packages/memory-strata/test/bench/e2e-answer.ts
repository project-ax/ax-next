// E2E answer client (TASK-189). Runs ONE question turn against the real
// shipped runtime's answer path: the system prompt carries memory-strata's
// `system-prompt:augment` block (User Profile + Recent), and the agent is given
// the real retrieval tools so it can pull from the consolidated index per turn.
//
// The shipped runtime registers a TWO-STEP retrieval surface: `memory_search`
// returns ~50-token doc SUMMARIES (topic + id), and `memory_read_section` drills
// into a doc by id to read the fact BODY. The first live run surfaced that
// wiring only `memory_search` makes the agent abstain on answerable questions —
// a summary alone rarely contains the specific value — so we expose BOTH tools,
// each dispatched back through the plugin's `tool:execute:*` hooks.
//
// Distinct from `agent.ts` (the bench A–E generic agent, which is handed a
// pre-retrieved doc list and never calls a tool): this client drives a bounded
// Anthropic tool-use loop against the real plugin executors.

import Anthropic from '@anthropic-ai/sdk';
import { withRetry } from './retry.js';

/** A single memory_search result row, mirrored from the indexer's output. */
export interface MemorySearchResult {
  docId: string;
  category: string;
  slug: string;
  summary: string;
  snippet: string;
  matchedFacts: string[];
  score: number;
}

/** Executes one memory_search call (wired to the plugin's tool hook). */
export type MemorySearchFn = (args: {
  query: string;
  topK?: number;
  categoryFilter?: string;
}) => Promise<MemorySearchResult[]>;

/**
 * Executes one memory_read_section call (wired to the plugin's
 * `tool:execute:memory_read_section` hook). Mirrors the hook's return shape:
 * the doc/section `body`, or an `error` code (`invalid-docId` / `doc-not-found`
 * / `header-not-found`).
 */
export type ReadSectionFn = (args: {
  docId: string;
  header?: string;
}) => Promise<{ body: string } | { error: string }>;

export interface E2EAnswer {
  text: string;
  usage: { in: number; out: number };
  /** Total memory tool calls (memory_search + memory_read_section) this turn. */
  toolCalls: number;
}

export interface E2EAnswerClient {
  answer(args: {
    /** memory-strata's injected block (User Profile + Recent), possibly ''. */
    injectedMemory: string;
    /** The question to answer. */
    question: string;
    /**
     * The LongMemEval sample's corpus question date (bench temporal fidelity,
     * Task 5), e.g. "2023-06-01". Absent falls back to no date anchor at all —
     * the prior wall-clock-only behavior — rather than injecting today's real
     * date, which would be just as fictional as omitting it.
     */
    questionDate?: string;
    /** Executor for the agent's memory_search calls. */
    search: MemorySearchFn;
    /** Executor for the agent's memory_read_section calls (drill into a fact). */
    readSection: ReadSectionFn;
  }): Promise<E2EAnswer>;
}

const SYSTEM_PREAMBLE = `You are a helpful personal assistant answering a question from your long-term memory of past conversations with this user.

Your injected memory below contains your User Profile and a Recent summary. You ALSO have two tools over your full long-term memory:
- \`memory_search\` — finds relevant docs and returns a short SUMMARY plus an id for each. The summary names the topic but usually does NOT contain the specific value you need.
- \`memory_read_section\` — reads the full BODY of a doc by its id. Use it AFTER memory_search to drill into the doc that looks relevant and read the actual fact (a preference, decision, date, name, or known entity).

Before asserting any durable fact that isn't already in the injected memory: search first, then read the most relevant doc to confirm the value. If, after searching AND reading, your memory still does not contain the answer, say "I don't know." — do NOT guess or fabricate.

For counting or enumeration questions ("how many X did I…", "list all the Y"), the facts you need are usually scattered across multiple docs and sessions, and each search returns only a CAPPED preview of matching lines. Do NOT answer a count after one or two searches. Instead: read the matched facts across every hit; whenever you see a "⋯ more matching lines" marker, call memory_read_section on that doc to read the full list; run additional searches with instance-specific terms (e.g. for "citrus fruit" also try "lime", "lemon", "orange"); and only then count, tallying distinct instances and excluding near-duplicate lines that describe the same event. Under-counting from stopping early is the most common mistake here.

Be concise.`;

const MEMORY_SEARCH_TOOL: Anthropic.Tool = {
  name: 'memory_search',
  description:
    'Search long-term memory. Returns document summaries (~50 tokens each) + ids, ' +
    'plus a CAPPED preview of query-matching fact lines per hit. ' +
    'Use this BEFORE asserting facts about durable preferences, decisions, or known entities, ' +
    'then memory_read_section to read the body of the most relevant result. ' +
    'A "⋯ more matching lines" entry means that doc has more instances than shown — ' +
    'read it in full with memory_read_section. ' +
    'For counting questions, do NOT conclude a count from the first search: read the fact ' +
    'lists across ALL hits, drill into any truncated doc, AND run follow-up searches ' +
    'with instance-specific terms before answering. Count only distinct instances.',
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

const MEMORY_READ_SECTION_TOOL: Anthropic.Tool = {
  name: 'memory_read_section',
  description:
    'Read the full body (or one ## section) of a memory doc by id. Use AFTER memory_search to ' +
    'drill into a fact — the search summary alone often omits the specific value.',
  input_schema: {
    type: 'object',
    properties: {
      docId: {
        type: 'string',
        description: 'Document id in <category>/<slug> form, taken from a memory_search result (e.g. "preference/coffee").',
      },
      header: {
        type: 'string',
        description: 'Optional ## section header. Omitted returns the whole body.',
      },
    },
    required: ['docId'],
  },
};

/** Default ceiling on memory_search round-trips per question (cost + loop bound). */
const DEFAULT_MAX_TOOL_TURNS = 6;
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
    async answer({ injectedMemory, question, questionDate, search, readSection }) {
      const system = buildAnswerSystem(injectedMemory, questionDate);
      return runAnswerLoop({ client, model, maxToolTurns, system, question, search, readSection });
    },
  };
}

/**
 * Assemble the answer turn's system prompt: the shared preamble, the injected
 * memory block (only when non-empty), and — for bench temporal fidelity (Task
 * 5) — a `Today's date:` anchor when the corpus question carried a date.
 *
 * Exported + pure so the format is unit-testable directly: the driver test's
 * hand-rolled answerClient stub can't cover it (it reconstructs the string
 * itself), so a dropped `.trim()`, a single-newline separator, or a misspelled
 * label would otherwise slip through green.
 */
export function buildAnswerSystem(injectedMemory: string, questionDate?: string): string {
  let system = injectedMemory.trim().length > 0
    ? `${SYSTEM_PREAMBLE}\n\n# Injected memory\n${injectedMemory}`
    : SYSTEM_PREAMBLE;
  if (questionDate !== undefined && questionDate.trim().length > 0) {
    system += `\n\nToday's date: ${questionDate.trim()}`;
  }
  return system;
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
  readSection: ReadSectionFn;
}): Promise<E2EAnswer> {
  const { client, model, maxToolTurns, system, question, search, readSection } = deps;
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
          ...(allowTools ? { tools: [MEMORY_SEARCH_TOOL, MEMORY_READ_SECTION_TOOL] } : {}),
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

    // Echo the assistant turn, then answer every tool_use in one user turn,
    // routing each to its executor by tool name (search → summaries,
    // read_section → fact body).
    messages.push({ role: 'assistant', content: resp.content });
    const results: ToolResultBlock[] = [];
    for (const use of toolUses) {
      toolCalls += 1;
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: await dispatchTool(use, search, readSection),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  // Loop exhausted without a text-only turn (shouldn't happen — the last
  // iteration has tools disabled). Return whatever we have.
  return { text: '', usage: { in: totalIn, out: totalOut }, toolCalls };
}

/**
 * Route one tool_use to the matching executor and format its result for the
 * model. Unknown tool names return an error string rather than throwing — a
 * stray tool name shouldn't abort the whole answer turn.
 */
async function dispatchTool(
  use: ToolUseBlock,
  search: MemorySearchFn,
  readSection: ReadSectionFn,
): Promise<string> {
  const input = (use.input ?? {}) as {
    query?: unknown;
    topK?: unknown;
    categoryFilter?: unknown;
    docId?: unknown;
    header?: unknown;
  };
  if (use.name === 'memory_read_section') {
    const docId = typeof input.docId === 'string' ? input.docId : '';
    const res = await readSection({
      docId,
      ...(typeof input.header === 'string' ? { header: input.header } : {}),
    });
    return formatReadSection(res);
  }
  if (use.name === 'memory_search') {
    const query = typeof input.query === 'string' ? input.query : '';
    const rows = await search({
      query,
      ...(typeof input.topK === 'number' ? { topK: input.topK } : {}),
      ...(typeof input.categoryFilter === 'string' ? { categoryFilter: input.categoryFilter } : {}),
    });
    return formatSearchResults(rows);
  }
  return `Error: unknown tool "${use.name}".`;
}

function formatSearchResults(rows: MemorySearchResult[]): string {
  if (rows.length === 0) return 'No matching memory documents found.';
  return rows
    .map((r, i) => {
      let entry = `[${i + 1}] (${r.docId}) ${r.summary}`;
      // Orchestrator-mode map-<load> rows carry snippet: '' — rendering
      // `match: ""` would read as "this doc matched nothing", so omit the line.
      if (r.snippet.trim() !== '') entry += `\n    match: "${r.snippet}"`;
      if (r.matchedFacts.length > 0) {
        entry += `\n    facts:\n${r.matchedFacts.map((f) => `      - ${f}`).join('\n')}`;
      }
      return entry;
    })
    .join('\n');
}

function formatReadSection(res: { body: string } | { error: string }): string {
  if ('error' in res) return `Error: ${res.error}.`;
  return res.body.trim().length > 0 ? res.body : '(empty document)';
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
