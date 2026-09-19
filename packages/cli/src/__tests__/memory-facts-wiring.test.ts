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
// TASK-421/TASK-422 — invariant 3 (no half-wired plugins). @ax/memory-facts-sqlite is
// loaded unconditionally by main() (it's postgres-free and has no external
// dependency to gate on, unlike the ANTHROPIC_API_KEY-gated memory-strata
// bundle). This proves it is actually reachable from a real CLI boot, not
// just from its own package's contract test — the gap the TASK-421 review
// flagged. See .claude/memory/decisions.md's TASK-421 entries: there is still
// no product-layer consumer (@ax/memory doesn't exist yet), so this pins only
// that the engine's hooks land on the real bus, not that anything calls them.
//
// TASK-422 added a FIFTH hook, `memory:facts:reindex`, so it is pinned here
// too. A hook that exists only in its own package's contract test is the
// half-wired shape this file was written to catch — every hook the manifest
// declares has to be listed below, or the next one added will quietly not be.
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
        name: '@ax/test-memory-facts-observer',
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

describe('@ax/cli host-side memory-facts wiring', () => {
  let tmp: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ax-memory-facts-')),
    );
    for (const key of ['AX_CREDENTIALS_KEY']) {
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

  it(
    'registers memory:facts:record|recall|supersede|clear|reindex on a real CLI boot',
    { timeout: 20_000 },
    async () => {
      const captor = busCaptor();
      const rc = await main({
        message: 'go',
        configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
        workspaceRoot: tmp,
        sqlitePath: path.join(tmp, 'memory-facts.sqlite'),
        stdout: () => {},
        stderr: () => {},
        runnerBinaryOverride: stubRunnerPath,
        skipCredentialProxy: true,
        extraPlugins: [createTestProxyPlugin({ script: SCRIPT }), captor.plugin],
      });
      expect(rc).toBe(0);

      const bus = captor.bus();
      expect(bus.hasService('memory:facts:record')).toBe(true);
      expect(bus.hasService('memory:facts:recall')).toBe(true);
      expect(bus.hasService('memory:facts:supersede')).toBe(true);
      expect(bus.hasService('memory:facts:clear')).toBe(true);
      expect(bus.hasService('memory:facts:reindex')).toBe(true);
    },
  );
});
