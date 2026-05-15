import { describe, expect, it } from 'vitest';
import { HookBus, makeAgentContext, type FileChange } from '@ax/core';
import { createValidatorRoutinePlugin } from '../plugin.js';

const ENC = new TextEncoder();

async function bootBus(): Promise<HookBus> {
  const bus = new HookBus();
  const plugin = createValidatorRoutinePlugin();
  await plugin.init?.({ bus } as never);
  return bus;
}

function preApply(changes: FileChange[]) {
  return { changes, parent: null, reason: 'test' };
}

function ctx() {
  return makeAgentContext({ sessionId: 's', agentId: 'a', userId: 'u' });
}

describe('@ax/validator-routine — workspace:pre-apply', () => {
  it('passes through changes outside .ax/routines/', async () => {
    const bus = await bootBus();
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: 'README.md', kind: 'put', content: ENC.encode('# hi') },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('passes through deletes', async () => {
    const bus = await bootBus();
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/old.md', kind: 'delete' },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('passes through a valid interval routine', async () => {
    const bus = await bootBus();
    const body = [
      '---',
      'name: heartbeat',
      'description: d',
      'trigger:',
      '  kind: interval',
      '  every: "30m"',
      '---',
      '# prompt',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/heartbeat.md', kind: 'put', content: ENC.encode(body) },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('vetoes a malformed routine', async () => {
    const bus = await bootBus();
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/bad.md', kind: 'put', content: ENC.encode('no frontmatter') },
    ]));
    expect(r.rejected).toBe(true);
    if (!r.rejected) return;
    expect(r.reason).toMatch(/\.ax\/routines\/bad\.md/);
  });

  it('vetoes webhook routine (Phase B I3)', async () => {
    const bus = await bootBus();
    const body = [
      '---',
      'name: r', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
      '---',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/r.md', kind: 'put', content: ENC.encode(body) },
    ]));
    expect(r.rejected).toBe(true);
    if (!r.rejected) return;
    expect(r.reason).toMatch(/webhook/);
  });

  it('passes through nested paths under .ax/routines/ (validator regex is anchored)', async () => {
    const bus = await bootBus();
    const body = [
      '---', 'name: r', 'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
      '---', '# p',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/sub/x.md', kind: 'put', content: ENC.encode(body) },
    ]));
    // Nested paths just don't match the validator regex.
    expect(r.rejected).toBe(false);
  });
});
