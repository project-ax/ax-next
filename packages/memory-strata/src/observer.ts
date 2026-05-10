import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMessage, LlmCallInput, LlmCallOutput } from '@ax/core';
import { buildMarkdownFile } from './frontmatter.js';
import { inboxFile } from './paths.js';
import { filterSensitive, type RejectionKind } from './sensitive-gate.js';
import type { MemoryFrontmatter, Observation } from './types.js';

// Observer (design § "1. Observer"). Pure async function on
// (transcript, llmCall, fsWriter, now). The plugin wires this up
// behind a chat:end subscriber; the Observer itself doesn't know
// about the bus, which makes it test-driveable without a HookBus.

export type LlmCallFn = (input: LlmCallInput) => Promise<LlmCallOutput>;

export interface RunObserverInput {
  messages: AgentMessage[];
  llmCall: LlmCallFn;
  /** Absolute path to the agent's workspace root. */
  workspaceRoot: string;
  /** Current time. Injected for deterministic tests. */
  now: Date;
  /**
   * Hard deadline for the LLM call. Per I6, exceeding this drops the run
   * cleanly with no inbox writes — we'd rather lose an observation than
   * block the next turn behind a slow extraction.
   */
  timeoutMs: number;
  /** Model id passed verbatim to `llm:call:*`'s `model` field. */
  model: string;
  /**
   * Optional logger sink for `late` audit lines. Defaults to a no-op.
   * The plugin wires this to `ctx.logger.warn`.
   */
  onLate?: (info: { reason: string; timeoutMs: number }) => void;
}

export interface ObservationWritten {
  /** Inbox path written, relative to workspaceRoot. */
  path: string;
  observation: Observation;
}

export interface RejectedObservation {
  observation: Observation;
  kinds: RejectionKind[];
}

export type RunObserverResult =
  | { kind: 'skipped'; reason: 'no-user-content' }
  | { kind: 'timeout' }
  | { kind: 'parse-error'; rawLength: number }
  | {
      kind: 'written';
      written: ObservationWritten[];
      rejected: RejectedObservation[];
    };

const EXTRACTION_PROMPT_SYSTEM = `\
You extract durable, atomic facts from chat transcripts for a memory system. \
A "durable" fact is one likely to still matter to this user a week from now: \
preferences, decisions, deadlines, identities, project state. Skip small talk, \
greetings, and ephemeral acknowledgments. Each fact must be a single sentence. \
Assign a subject (the entity the fact is about, or "general"), a factType \
(entity, preference, decision, episode, or general), and a confidence \
between 0 and 1.

Respond with ONLY a JSON array, no prose, no markdown fences:
[{ "fact": string, "subject": string, "factType": string, "confidence": number }]

If nothing durable is in the transcript, respond with [].`;

const MAX_EXTRACTION_TOKENS = 1024;
const OBSERVER_TEMPERATURE = 0.2;

export async function runObserver(input: RunObserverInput): Promise<RunObserverResult> {
  const userContent = input.messages.some((m) => m.role === 'user' && m.content.trim().length > 0);
  if (!userContent) {
    return { kind: 'skipped', reason: 'no-user-content' };
  }

  const userPrompt = formatTranscript(input.messages);

  // Bound the LLM call. The hook surface doesn't carry an AbortSignal
  // (LlmCallInput is { model, maxTokens, system, messages, temperature }
  // — no signal field), so we race a setTimeout. The slow LLM call
  // continues in the background and its eventual result is discarded.
  // Phase 2 should add `signal` to LlmCallInput so we can actually cancel
  // the round-trip; Phase 1 just bounds the wait.
  let raced: LlmCallOutput;
  try {
    raced = await raceTimeout(
      input.llmCall({
        model: input.model,
        maxTokens: MAX_EXTRACTION_TOKENS,
        system: EXTRACTION_PROMPT_SYSTEM,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: OBSERVER_TEMPERATURE,
      }),
      input.timeoutMs,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      input.onLate?.({ reason: 'observer-llm-timeout', timeoutMs: input.timeoutMs });
      return { kind: 'timeout' };
    }
    throw err;
  }

  const candidates = parseObservations(raced.text);
  if (candidates === null) {
    return { kind: 'parse-error', rawLength: raced.text.length };
  }

  const written: ObservationWritten[] = [];
  const rejected: RejectedObservation[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const obs = candidates[i]!;
    const gate = filterSensitive(obs.fact);
    if (!gate.kept) {
      rejected.push({ observation: obs, kinds: gate.rejections.map((r) => r.kind) });
      continue;
    }
    const path = await writeInboxObservation(input.workspaceRoot, obs, input.now, i, input.messages.length);
    written.push({ path, observation: obs });
  }

  return { kind: 'written', written, rejected };
}

function formatTranscript(messages: AgentMessage[]): string {
  const lines = messages.map((m) => `${m.role}: ${m.content}`);
  return `Transcript:\n\n${lines.join('\n\n')}`;
}

function parseObservations(text: string): Observation[] | null {
  // The LLM should return raw JSON. Be defensive: occasionally a model
  // wraps with prose despite the instruction. Try a strict JSON.parse
  // first; if that fails, hunt for a top-level array.
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const out: Observation[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const fact = typeof r['fact'] === 'string' ? (r['fact'] as string).trim() : '';
    if (fact === '') continue;
    const subject = typeof r['subject'] === 'string' ? (r['subject'] as string) : 'general';
    const factTypeRaw = typeof r['factType'] === 'string' ? (r['factType'] as string) : 'general';
    const factType = (
      ['entity', 'preference', 'decision', 'episode', 'general'].includes(factTypeRaw)
        ? factTypeRaw
        : 'general'
    ) as Observation['factType'];
    const confRaw = r['confidence'];
    const confidence =
      typeof confRaw === 'number' && Number.isFinite(confRaw)
        ? Math.max(0, Math.min(1, confRaw))
        : 0.5;
    out.push({ fact, subject, factType, confidence });
  }
  return out;
}

async function writeInboxObservation(
  workspaceRoot: string,
  obs: Observation,
  now: Date,
  index: number,
  sourceMessages: number,
): Promise<string> {
  // index disambiguates multiple observations sharing the same now.toISO().
  // randomUUID is cryptographically unique per call but the filename
  // index keeps lexicographic ordering stable inside a single Observer run.
  const id = randomUUID();
  const rel = inboxFile(now, `${String(index).padStart(2, '0')}-${id.slice(0, 8)}`);
  const abs = join(workspaceRoot, rel);
  await mkdir(dirname(abs), { recursive: true });

  const nowIso = now.toISOString();
  const fm: MemoryFrontmatter = {
    id,
    type: 'inbox/observation',
    created: nowIso,
    confidence: obs.confidence,
    pinned: false,
    summary: obs.fact,
    subject: obs.subject,
    factType: obs.factType,
    source_messages: sourceMessages,
    event_time: nowIso,
    recorded_at: nowIso,
  };

  const body = `# Observation\n\n${obs.fact}\n`;
  await writeFile(abs, buildMarkdownFile(fm, body), 'utf8');
  return rel;
}

class TimeoutError extends Error {
  constructor() {
    super('observer-llm-timeout');
    this.name = 'TimeoutError';
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
