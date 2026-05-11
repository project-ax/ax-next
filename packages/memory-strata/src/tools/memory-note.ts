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
    { subject?: unknown; content?: unknown; factType?: unknown; confidence?: unknown },
    | { ok: true; path: string }
    | { rejected: true; reason: 'sensitive'; kinds: string[] }
    | { error: string }
  >(
    'tool:execute:memory_note',
    PLUGIN_NAME,
    async (ctx, input) => {
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

      // Gate content through the sensitive-content filter (I20).
      // A note containing what looks like a credential MUST be rejected
      // BEFORE any disk write. Subject is metadata and is not gated —
      // the design doc specifies gating only on content.
      const gate = filterSensitive(content);
      if (!gate.kept) {
        // Deduplicate kinds in pattern-declaration order (rejections are already
        // in that order, but a single pattern can fire multiple times for different
        // matches — deduplicate while preserving first-seen order).
        const seen = new Set<string>();
        const kinds: string[] = [];
        for (const r of gate.rejections) {
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
      // honest: no transcript messages to count.
      const path = await writeInboxObservation(ctx.workspace.rootPath, obs, now, 0, 0);
      return { ok: true, path };
    },
  );
}
