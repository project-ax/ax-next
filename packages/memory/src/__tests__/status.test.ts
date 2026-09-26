import { HookBus, PluginError, makeAgentContext, type AgentContext } from '@ax/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createMemoryPlugin } from '../plugin.js';
import type { MemoryStatusOutput } from '../types.js';
import {
  ALICE,
  BOB,
  makeMemoryHarness,
  type MemoryHarness,
  type MemoryHarnessOptions,
} from './harness.js';

/**
 * `memory:status` — the per-user "extraction paused" signal.
 *
 * Driven end to end through `bus.fire('chat:end')`, like `observer.test.ts`:
 * the pause is set and cleared by the observer's wiring, so a test that poked
 * the set directly would cover nothing that can break.
 */

let harness: MemoryHarness | undefined;
afterEach(async () => {
  await harness?.teardown();
  harness = undefined;
});

const DIALOGUE = [
  { role: 'user', content: 'I moved to Boston last week.' },
  { role: 'assistant', content: 'Congratulations!' },
];

function reply(text: string): {
  text: string;
  stopReason: 'end_turn';
  usage: { inputTokens: number; outputTokens: number };
} {
  return { text, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
}

const EMPTY_EXTRACTION = reply(JSON.stringify({ facts: [] }));

function noCredential(): never {
  throw new PluginError({
    code: 'no-openrouter-credential',
    plugin: '@ax/llm-openrouter',
    message: 'no credential resolved for openrouter',
  });
}

type Mode = 'no-credential' | 'ok' | 'plain-error' | 'other-plugin-error';

/**
 * A harness whose stub provider's behaviour is switchable between turns, so
 * one plugin instance can walk ok → paused → ok.
 */
async function switchable(initial: Mode): Promise<{ h: MemoryHarness; set: (m: Mode) => void }> {
  let mode: Mode = initial;
  const llm: MemoryHarnessOptions['llm'] = () => {
    switch (mode) {
      case 'no-credential':
        return noCredential();
      case 'plain-error':
        throw new Error('upstream 504');
      case 'other-plugin-error':
        throw new PluginError({
          code: 'provider-timeout',
          plugin: '@ax/llm-openrouter',
          message: 'gateway timeout',
        });
      case 'ok':
        return EMPTY_EXTRACTION;
    }
  };
  // A TEAM agent with both as members, so Bob's chat:end really reaches the
  // provider — on a personal agent his run is refused before the model call
  // and every Bob assertion below would pass vacuously.
  harness = await makeMemoryHarness({}, { llm, agent: { visibility: 'team' } });
  return { h: harness, set: (m) => (mode = m) };
}

async function chatEnd(
  h: MemoryHarness,
  userId: string,
  outcome: unknown = { kind: 'complete', messages: DIALOGUE },
): Promise<void> {
  await h.bus.fire('chat:end', h.ctx({ userId, conversationId: 'conv-1' }), { outcome });
  await h.settleObserver();
}

function status(h: MemoryHarness, ctx: AgentContext, input: unknown = {}): Promise<MemoryStatusOutput> {
  return h.bus.call<unknown, MemoryStatusOutput>('memory:status', ctx, input);
}

const PAUSED = { extraction: 'paused', reason: 'missing-credential' };
const OK = { extraction: 'ok' };

describe('memory:status', () => {
  it('answers ok on a fresh plugin', async () => {
    const { h } = await switchable('ok');
    expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(OK);
  });

  it('reports paused for the user whose extraction hit a missing credential — and only them', async () => {
    const { h } = await switchable('no-credential');
    await chatEnd(h, ALICE);

    expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(PAUSED);
    expect(await status(h, h.ctx({ userId: BOB }))).toEqual(OK);
  });

  it('clears the pause once an extraction call succeeds for that user', async () => {
    const { h, set } = await switchable('no-credential');
    await chatEnd(h, ALICE);
    expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(PAUSED);

    set('ok');
    await chatEnd(h, ALICE);
    expect(h.llmCalls).toHaveLength(2);
    expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(OK);
  });

  it('a success for ANOTHER user does not clear this user`s pause', async () => {
    const { h, set } = await switchable('no-credential');
    await chatEnd(h, ALICE);
    set('ok');
    await chatEnd(h, BOB);
    expect(h.llmCalls).toHaveLength(2);
    expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(PAUSED);
  });

  it.each(['plain-error', 'other-plugin-error'] as const)(
    'a non-credential failure (%s) neither clears a pause nor sets one',
    async (failure) => {
      const { h, set } = await switchable('no-credential');
      await chatEnd(h, ALICE);
      expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(PAUSED);

      set(failure);
      await chatEnd(h, ALICE);
      // The provider WAS reached — the failure is real, not a skip.
      expect(h.llmCalls).toHaveLength(2);
      expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(PAUSED);

      // And from ok, the same failure does not set one.
      await chatEnd(h, BOB);
      expect(h.llmCalls).toHaveLength(3);
      expect(await status(h, h.ctx({ userId: BOB }))).toEqual(OK);
    },
  );

  it.each([
    ['a terminated outcome', { kind: 'terminated', reason: 'sandbox died' }],
    ['an empty transcript', { kind: 'complete', messages: [] }],
    ['a transcript with nothing extractable', { kind: 'complete', messages: [{ role: 'user', content: '   ' }] }],
  ])('an observer run that skips before the model call (%s) does not clear the pause', async (_label, outcome) => {
    const { h, set } = await switchable('no-credential');
    await chatEnd(h, ALICE);
    set('ok');

    await chatEnd(h, ALICE, outcome);
    // No model call happened, so nothing proved the credential is back.
    expect(h.llmCalls).toHaveLength(1);
    expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(PAUSED);
  });

  it('answers only for the caller — a userId in the payload is ignored', async () => {
    const { h } = await switchable('no-credential');
    await chatEnd(h, ALICE);

    // Asking about Alice from Bob's context answers for Bob.
    expect(await status(h, h.ctx({ userId: BOB }), { userId: ALICE })).toEqual(OK);
    // Asking about Bob from Alice's context answers for Alice.
    expect(await status(h, h.ctx({ userId: ALICE }), { userId: BOB })).toEqual(PAUSED);
  });

  it('answers ok for a context with no userId', async () => {
    const { h } = await switchable('no-credential');
    await chatEnd(h, ALICE);
    const anon = { ...h.ctx({ userId: ALICE }), userId: '' } as AgentContext;
    expect(await status(h, anon)).toEqual(OK);
  });

  it('keeps pause state per plugin instance, not module-global', async () => {
    const { h } = await switchable('no-credential');
    await chatEnd(h, ALICE);
    expect(await status(h, h.ctx({ userId: ALICE }))).toEqual(PAUSED);

    const bus = new HookBus();
    bus.registerService('tool:register', 'stub-catalog', async () => ({}));
    await createMemoryPlugin().init({ bus, config: {} });
    const ctx = makeAgentContext({
      sessionId: 's',
      agentId: 'agent-1',
      userId: ALICE,
      workspace: { rootPath: '/tmp' },
    });
    expect(await bus.call('memory:status', ctx, {})).toEqual(OK);
  });
});
