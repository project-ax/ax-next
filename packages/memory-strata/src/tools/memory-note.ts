import { makeAgentContext } from '@ax/core';
import type { HookBus, ToolDescriptor } from '@ax/core';
import { writeInboxObservation } from '../inbox-store.js';
import { filterSensitive } from '../sensitive-gate.js';
import type { Observation } from '../types.js';

const PLUGIN_NAME = '@ax/memory-strata';

const VALID_FACT_TYPES = new Set<Observation['factType']>([
  'entity',
  'preference',
  'decision',
  'episode',
  'general',
]);

export const MEMORY_NOTE_DESCRIPTOR: ToolDescriptor = {
  name: 'memory_note',
  description:
    'Save a one-sentence fact you want to remember long-term. Goes into the inbox; ' +
    'the consolidator merges it into the docs/ tree on the next pass. The gate strips ' +
    'observations containing credentials.',
  executesIn: 'host',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description: 'Subject the fact is about (used to cluster). Required.',
      },
      content: {
        type: 'string',
        description: 'The fact itself. One sentence. Required.',
      },
      factType: {
        type: 'string',
        description: 'One of: entity | preference | decision | episode | general. Default: general.',
      },
      confidence: {
        type: 'number',
        description: 'Subjective confidence in this fact, 0..1. Default 0.8.',
      },
    },
    required: ['subject', 'content'],
  },
};

export async function registerMemoryNote(bus: HookBus): Promise<void> {
  const initCtx = makeAgentContext({
    sessionId: 'init',
    agentId: PLUGIN_NAME,
    userId: 'system',
  });
  await bus.call('tool:register', initCtx, MEMORY_NOTE_DESCRIPTOR);

  bus.registerService<
    { input?: unknown },
    | { ok: true; path: string }
    | { rejected: true; reason: 'sensitive'; kinds: string[] }
    | { error: string }
  >(
    'tool:execute:memory_note',
    PLUGIN_NAME,
    async (ctx, call) => {
      // The `tool.execute-host` IPC handler forwards the full ToolCall
      // `{ id, name, input }` to this hook (see ipc-core tool-execute-host.ts).
      // The model-supplied arguments live under `call.input`, not on `call`.
      const input = (call?.input ?? {}) as {
        subject?: unknown;
        content?: unknown;
        factType?: unknown;
        confidence?: unknown;
      };
      // Validate subject + content are non-empty strings.
      const subject = typeof input?.subject === 'string' ? input.subject.trim() : '';
      const content = typeof input?.content === 'string' ? input.content.trim() : '';

      if (subject === '' || content === '') {
        return { error: 'invalid-input' };
      }

      // Coerce factType to enum (default 'general').
      const factTypeRaw = typeof input?.factType === 'string' ? input.factType : 'general';
      const factType = (
        VALID_FACT_TYPES.has(factTypeRaw as Observation['factType'])
          ? factTypeRaw
          : 'general'
      ) as Observation['factType'];

      // Coerce confidence to number in [0,1] (default 0.8).
      // Mirrors the Observer's parseObservations coercion pattern: clamp finite
      // numbers to [0,1], fall back to default for non-finite / non-number inputs.
      const confRaw = input?.confidence;
      const confidence =
        typeof confRaw === 'number' && Number.isFinite(confRaw)
          ? Math.max(0, Math.min(1, confRaw))
          : 0.8;

      // Gate BOTH subject and content through the sensitive-content filter
      // (I20). Subject is also persisted as part of the Observation
      // frontmatter, so a credential placed there would still hit disk +
      // get indexed. CLAUDE.md invariant 5: untrusted content at every hop.
      const subjectGate = filterSensitive(subject);
      const contentGate = filterSensitive(content);
      if (!subjectGate.kept || !contentGate.kept) {
        // Deduplicate kinds across both gates in first-seen order. Each
        // pattern can fire multiple times per input; the merged list lets
        // the caller see every distinct kind that triggered without
        // disclosing the matched substring.
        const seen = new Set<string>();
        const kinds: string[] = [];
        for (const r of [...subjectGate.rejections, ...contentGate.rejections]) {
          if (!seen.has(r.kind)) {
            seen.add(r.kind);
            kinds.push(r.kind);
          }
        }
        return { rejected: true, reason: 'sensitive', kinds };
      }

      const obs: Observation = { fact: content, subject, factType, confidence };
      const now = new Date();
      // Agent-authored notes are a single observation, not part of a
      // multi-message Observer batch. Pass index=0, sourceMessages=0 —
      // honest: no transcript messages to count. Carry the conversation id
      // (TASK-187) so a note recurring across conversations counts toward the
      // skill-crystallization recurrence gate; undefined when the note was
      // written outside a conversation.
      const path = await writeInboxObservation(
        ctx.workspace.rootPath,
        obs,
        now,
        0,
        0,
        ctx.conversationId,
      );
      return { ok: true, path };
    },
  );
}
