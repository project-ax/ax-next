import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import {
  createTestProxyPlugin,
  stubRunnerPath,
  type StubRunnerScript,
} from '@ax/test-harness';
import { makeAgentContext, type AgentContext, type HookBus, type Plugin } from '@ax/core';
import { main } from '../main.js';

// Dev services on demand: the CLI runs @ax/sandbox-subprocess, which refuses
// `job` and `publishedPorts`, so a service set can't run here. The orchestrator
// is loaded with on-demand services OFF: neither service tool is in the
// catalog agents are offered, and restart_with_services refuses if called.

const SCRIPT: StubRunnerScript = {
  entries: [
    { kind: 'assistant-text', content: 'ok' },
    { kind: 'finish', reason: 'end_turn' },
  ],
};

describe('@ax/cli on-demand services are off (subprocess sandbox)', () => {
  let tmp: string;
  let savedKey: string | undefined;
  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-ondemand-')));
    savedKey = process.env.AX_CREDENTIALS_KEY;
    process.env.AX_CREDENTIALS_KEY = '42'.repeat(32);
  });
  afterEach(async () => {
    if (savedKey === undefined) delete process.env.AX_CREDENTIALS_KEY;
    else process.env.AX_CREDENTIALS_KEY = savedKey;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('no service tool is offered, and restart_with_services refuses, on a real CLI boot', { timeout: 20_000 }, async () => {
    let bus: HookBus | undefined;
    const captor: Plugin = {
      manifest: { name: '@ax/test-ondemand-observer', version: '0.0.0', registers: [], calls: [], subscribes: [] },
      async init(ctx: { bus: HookBus }) { bus = ctx.bus; },
    };
    const rc = await main({
      message: 'go',
      configOverride: { sandbox: 'subprocess', storage: 'sqlite' },
      workspaceRoot: tmp,
      sqlitePath: path.join(tmp, 'ondemand.sqlite'),
      stdout: () => {},
      stderr: () => {},
      runnerBinaryOverride: stubRunnerPath,
      skipCredentialProxy: true,
      extraPlugins: [createTestProxyPlugin({ script: SCRIPT }), captor],
    });
    expect(rc).toBe(0);
    const ctx: AgentContext = makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
    // The catalog the runner's tool list is built from: none offered.
    const listed = await bus!.call<Record<string, never>, { tools: Array<{ name: string }> }>('tool:list', ctx, {});
    const names = listed.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0); // the catalog is real (memory, skills...)
    expect(names).not.toContain('restart_with_services');
    expect(names).not.toContain('stop_services');
    const r = await bus!.call<unknown, { ok: boolean; message: string }>(
      'tool:execute:restart_with_services', ctx, { id: 'c1', name: 'restart_with_services', input: { set: 'e2e' } },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('turned off');
  });
});
