import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import {
  createTestProxyPlugin,
  stubRunnerPath,
  type StubRunnerScript,
} from '@ax/test-harness';
import type { HookBus, Plugin } from '@ax/core';
import { main } from '../main.js';

// ---------------------------------------------------------------------------
// PR 4 T8 — invariant 3 (no half-wired plugins). @ax/llm-openrouter is loaded
// by main() behind a non-empty OPENROUTER_API_KEY, exactly as
// @ax/llm-anthropic is loaded behind ANTHROPIC_API_KEY. Unit-testing the
// plugin proves the plugin; only booting the CLI's real plugin set proves the
// GATE — that the env check spells the right variable, that the plugin is
// actually pushed, and that its hooks land on the same bus every other host
// plugin sees.
//
// Observation mechanism: an extraPlugin captures the bus in its init and we
// read `hasService` after main() returns. The bus outlives the run, so this
// needs no ordering trickery (extraPlugins are appended last, but bootstrap
// topo-sorts, so asserting DURING init would be reading a half-built bus).
// ---------------------------------------------------------------------------

const SCRIPT: StubRunnerScript = {
  entries: [
    { kind: 'assistant-text', content: 'ok' },
    { kind: 'finish', reason: 'end_turn' },
  ],
};

function busCaptor(): { plugin: Plugin; bus: () => HookBus } {
  let captured: HookBus | undefined;
  return {
    plugin: {
      manifest: {
        name: '@ax/test-llm-provider-observer',
        version: '0.0.0',
        registers: [],
        calls: [],
        subscribes: [],
      },
      async init(ctx: { bus: HookBus }) {
        captured = ctx.bus;
      },
    },
    bus: () => {
      if (captured === undefined) throw new Error('observer init never ran');
      return captured;
    },
  };
}

describe('@ax/cli host-side LLM provider wiring', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-llm-provider-')),
    );
    for (const key of ['AX_CREDENTIALS_KEY', 'OPENROUTER_API_KEY']) {
      saved[key] = process.env[key];
    }
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function boot(): Promise<HookBus> {
    const captor = busCaptor();
    const rc = await main({
      message: 'go',
      configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
      workspaceRoot: tmp,
      sqlitePath: path.join(tmp, 'llm-provider.sqlite'),
      stdout: () => {},
      stderr: () => {},
      runnerBinaryOverride: stubRunnerPath,
      skipCredentialProxy: true,
      extraPlugins: [createTestProxyPlugin({ script: SCRIPT }), captor.plugin],
    });
    expect(rc).toBe(0);
    return captor.bus();
  }

  it(
    'registers llm:call:openrouter + models:list-supported:openrouter when OPENROUTER_API_KEY is set',
    { timeout: 20_000 },
    async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-fake-for-init';
      const bus = await boot();
      expect(bus.hasService('llm:call:openrouter')).toBe(true);
      expect(bus.hasService('models:list-supported:openrouter')).toBe(true);
    },
  );

  it(
    'leaves the OpenRouter hooks unregistered when OPENROUTER_API_KEY is absent',
    { timeout: 20_000 },
    async () => {
      delete process.env.OPENROUTER_API_KEY;
      const bus = await boot();
      // The CLI loads the plugin in STATIC mode, which refuses to init without
      // a key — so an ungated push here would break every keyless CLI boot.
      // This pins the gate in the other direction.
      expect(bus.hasService('llm:call:openrouter')).toBe(false);
    },
  );
});
