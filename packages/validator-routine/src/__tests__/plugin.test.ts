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

  it('accepts webhook routine with valid path (Phase C K1 reject-flip)', async () => {
    const bus = await bootBus();
    const body = [
      '---',
      'name: r', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
      '---',
      '# Prompt body', 'hello',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/r.md', kind: 'put', content: ENC.encode(body) },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('vetoes two webhook routines in the same batch declaring the same trigger.path', async () => {
    const bus = await bootBus();
    const webhook = (name: string) => [
      '---', `name: ${name}`, 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
      '---', 'body',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/a.md', kind: 'put', content: ENC.encode(webhook('a')) },
      { path: '.ax/routines/b.md', kind: 'put', content: ENC.encode(webhook('b')) },
    ]));
    expect(r.rejected).toBe(true);
    if (!r.rejected) return;
    expect(r.reason).toMatch(/duplicate webhook trigger\.path/);
    expect(r.reason).toMatch(/\/r\/x/);
    // Both colliding routine files should appear in the reason so operators
    // know exactly which two files clash.
    expect(r.reason).toMatch(/\.ax\/routines\/a\.md/);
    expect(r.reason).toMatch(/\.ax\/routines\/b\.md/);
  });

  it('accepts two webhook routines in the same batch with different trigger.paths', async () => {
    const bus = await bootBus();
    const webhook = (name: string, path: string) => [
      '---', `name: ${name}`, 'description: d',
      'trigger:', '  kind: webhook', `  path: "${path}"`,
      '---', 'body',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/a.md', kind: 'put', content: ENC.encode(webhook('a', '/r/x')) },
      { path: '.ax/routines/b.md', kind: 'put', content: ENC.encode(webhook('b', '/r/y')) },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('does not flag a webhook + interval as a collision (different trigger kinds, no URL conflict)', async () => {
    const bus = await bootBus();
    const webhook = [
      '---', 'name: w', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/x"',
      '---', 'body',
    ].join('\n') + '\n';
    const interval = [
      '---', 'name: i', 'description: d',
      'trigger:', '  kind: interval', '  every: "60s"',
      '---', 'body',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctx(), preApply([
      { path: '.ax/routines/w.md', kind: 'put', content: ENC.encode(webhook) },
      { path: '.ax/routines/i.md', kind: 'put', content: ENC.encode(interval) },
    ]));
    expect(r.rejected).toBe(false);
  });

  // ---------------------------------------------------------------------
  // secretRef drift veto: webhook routines that hand-wrote hmac.secretRef
  // must use the canonical destination-derived ref shape:
  //   routine:<agentId>:<path>:hmac
  // Mismatch means the routines plugin will mint / fetch the credential
  // under a key that nothing else writes to, so the webhook silently 401s.
  // ---------------------------------------------------------------------

  function webhookHmacBody(secretRef: string): Uint8Array {
    return ENC.encode(
      [
        '---',
        'name: gh',
        'description: d',
        'trigger:',
        '  kind: webhook',
        '  path: "/r/gh"',
        '  hmac:',
        `    secretRef: ${secretRef}`,
        '    header: X-Sig',
        '    algorithm: sha256',
        '---',
        '# body',
      ].join('\n') + '\n',
    );
  }

  function ctxForAgent(agentId: string) {
    return makeAgentContext({ sessionId: 's', agentId, userId: 'u' });
  }

  it('accepts webhook routine with canonical hmac.secretRef', async () => {
    const bus = await bootBus();
    const path = '.ax/routines/gh.md';
    const r = await bus.fire('workspace:pre-apply', ctxForAgent('agt-1'), preApply([
      { path, kind: 'put', content: webhookHmacBody(`routine:agt-1:${path}:hmac`) },
    ]));
    expect(r.rejected).toBe(false);
  });

  it('vetoes webhook routine whose hmac.secretRef does not match the canonical shape', async () => {
    const bus = await bootBus();
    const path = '.ax/routines/gh.md';
    const r = await bus.fire('workspace:pre-apply', ctxForAgent('agt-1'), preApply([
      { path, kind: 'put', content: webhookHmacBody('my-hand-picked-name') },
    ]));
    expect(r.rejected).toBe(true);
    if (!r.rejected) return;
    expect(r.reason).toMatch(/\.ax\/routines\/gh\.md/);
    expect(r.reason).toMatch(/hmac\.secretRef/);
    expect(r.reason).toMatch(/routine:agt-1:\.ax\/routines\/gh\.md:hmac/);
  });

  it('vetoes webhook routine whose hmac.secretRef references a different agentId', async () => {
    const bus = await bootBus();
    const path = '.ax/routines/gh.md';
    // Right shape but wrong agentId — still a drift the operator should fix.
    const r = await bus.fire('workspace:pre-apply', ctxForAgent('agt-1'), preApply([
      { path, kind: 'put', content: webhookHmacBody(`routine:agt-OTHER:${path}:hmac`) },
    ]));
    expect(r.rejected).toBe(true);
  });

  it('passes through webhook routines without hmac configured', async () => {
    const bus = await bootBus();
    const body = [
      '---', 'name: r', 'description: d',
      'trigger:', '  kind: webhook', '  path: "/r/y"',
      '---', '# body',
    ].join('\n') + '\n';
    const r = await bus.fire('workspace:pre-apply', ctxForAgent('agt-1'), preApply([
      { path: '.ax/routines/r.md', kind: 'put', content: ENC.encode(body) },
    ]));
    expect(r.rejected).toBe(false);
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
