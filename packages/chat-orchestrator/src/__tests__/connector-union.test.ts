import { describe, it, expect } from 'vitest';
import {
  HookBus,
  makeAgentContext,
  createLogger,
  type ServiceHandler,
} from '@ax/core';
import {
  resolveEffectiveConnectors,
  resolveSkillReferencedConnectors,
  foldConnectorCaps,
  connectorCredentialEnvName,
  connectorSandboxDirId,
  type ResolvedConnectorForOrch,
} from '../connector-union.js';

// ---------------------------------------------------------------------------
// Pure-unit coverage for the TASK-97 connector union (no sandbox spawn). The
// orchestrator end-to-end wiring is exercised in orchestrator.test.ts.
// ---------------------------------------------------------------------------

function ctx() {
  return makeAgentContext({
    sessionId: 's',
    agentId: 'a',
    userId: 'u',
    logger: createLogger({ reqId: 'r', writer: () => undefined }),
  });
}

/** A bus with the supplied service handlers registered (per I2 the connector
 *  hooks are mirrored structurally; we register stubs under the real names). */
function busWith(services: Record<string, ServiceHandler>): HookBus {
  const bus = new HookBus();
  for (const [name, handler] of Object.entries(services)) {
    bus.registerService(name, 'test', handler);
  }
  return bus;
}

const CAPS = (over: Partial<ResolvedConnectorForOrch['capabilities']> = {}) => ({
  allowedHosts: ['api.example.com'],
  credentials: [{ slot: 'EXAMPLE_KEY', kind: 'api-key' as const }],
  mcpServers: [],
  packages: { npm: [], pypi: [] },
  ...over,
});

describe('connectorSandboxDirId', () => {
  const SANDBOX_RE = /^[a-z][a-z0-9-]{0,63}$/;

  it('produces a sandbox-safe, stable, prefixed dir id', () => {
    const id = connectorSandboxDirId('gdrive');
    expect(id).toMatch(SANDBOX_RE);
    expect(id.startsWith('cx-gdrive-')).toBe(true);
    // Deterministic.
    expect(connectorSandboxDirId('gdrive')).toBe(id);
  });

  it('sanitizes underscores + uppercase the store allows but the sandbox does not', () => {
    const id = connectorSandboxDirId('My_Drive');
    expect(id).toMatch(SANDBOX_RE);
    // No underscore / uppercase leaks through.
    expect(id).not.toMatch(/[_A-Z]/);
  });

  it('stays ≤ 64 chars and collision-free even for a long id', () => {
    const long = 'a' + '-very-long-connector-id'.repeat(8); // > 64 chars
    const id = connectorSandboxDirId(long);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(SANDBOX_RE);
    // Two ids sharing the truncated body still differ (hash suffix).
    const a = connectorSandboxDirId(long + 'AAAA');
    const b = connectorSandboxDirId(long + 'BBBB');
    expect(a).not.toBe(b);
  });
});

describe('resolveEffectiveConnectors', () => {
  it('unions defaults + the owner\'s own connectors, deduped by id (default wins)', async () => {
    const bus = busWith({
      'connectors:list-defaults': async () => ({
        connectors: [{ id: 'shared', capabilities: CAPS(), usageNote: 'default note' }],
      }),
      'connectors:list': async () => ({
        connectors: [{ id: 'shared' }, { id: 'mine' }],
      }),
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        return { id, capabilities: CAPS(), usageNote: `${id} note` };
      },
    });
    const out = await resolveEffectiveConnectors(bus, ctx());
    expect(out.map((c) => c.id).sort()).toEqual(['mine', 'shared']);
    // 'shared' came from defaults (its note), NOT re-resolved from the owner list.
    expect(out.find((c) => c.id === 'shared')!.usageNote).toBe('default note');
  });

  it('is NON-FATAL: a throwing list-defaults yields the owner connectors only', async () => {
    const bus = busWith({
      'connectors:list-defaults': async () => {
        throw new Error('boom');
      },
      'connectors:list': async () => ({ connectors: [{ id: 'mine' }] }),
      'connectors:resolve': async () => ({ id: 'mine', capabilities: CAPS() }),
    });
    const out = await resolveEffectiveConnectors(bus, ctx());
    expect(out.map((c) => c.id)).toEqual(['mine']);
  });

  it('is NON-FATAL: a per-connector resolve failure skips just that connector', async () => {
    const bus = busWith({
      'connectors:list': async () => ({ connectors: [{ id: 'ok' }, { id: 'bad' }] }),
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        if (id === 'bad') throw new Error('cannot resolve');
        return { id, capabilities: CAPS() };
      },
    });
    const out = await resolveEffectiveConnectors(bus, ctx());
    expect(out.map((c) => c.id)).toEqual(['ok']);
  });

  it('returns [] when no connector hooks are registered (stripped preset)', async () => {
    const out = await resolveEffectiveConnectors(busWith({}), ctx());
    expect(out).toEqual([]);
  });
});

describe('resolveSkillReferencedConnectors (TASK-111)', () => {
  it('resolves a skill-referenced connector id not already in the effective set', async () => {
    const bus = busWith({
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        return { id, capabilities: CAPS(), usageNote: `${id} note` };
      },
    });
    const out = await resolveSkillReferencedConnectors(
      bus,
      ctx(),
      ['linear'],
      new Set(),
    );
    expect(out.map((c) => c.id)).toEqual(['linear']);
    expect(out[0]!.usageNote).toBe('linear note');
    expect(out[0]!.capabilities.allowedHosts).toEqual(['api.example.com']);
  });

  it('dedups: an id already in the effective set is NOT re-resolved', async () => {
    const resolved: string[] = [];
    const bus = busWith({
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        resolved.push(id);
        return { id, capabilities: CAPS() };
      },
    });
    const out = await resolveSkillReferencedConnectors(
      bus,
      ctx(),
      ['shared', 'mine'],
      new Set(['shared']), // already in the agent effective set
    );
    // Only 'mine' is resolved; 'shared' is skipped (already folded).
    expect(out.map((c) => c.id)).toEqual(['mine']);
    expect(resolved).toEqual(['mine']);
  });

  it('dedups duplicate ids within the skill reference list (resolve once)', async () => {
    const resolved: string[] = [];
    const bus = busWith({
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        resolved.push(id);
        return { id, capabilities: CAPS() };
      },
    });
    const out = await resolveSkillReferencedConnectors(
      bus,
      ctx(),
      ['linear', 'linear', 'gh'],
      new Set(),
    );
    expect(out.map((c) => c.id).sort()).toEqual(['gh', 'linear']);
    // 'linear' resolved exactly once despite the duplicate reference.
    expect(resolved.sort()).toEqual(['gh', 'linear']);
  });

  it('is NON-FATAL: a per-id resolve failure skips just that connector', async () => {
    const bus = busWith({
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        if (id === 'bad') throw new Error('not found');
        return { id, capabilities: CAPS() };
      },
    });
    const out = await resolveSkillReferencedConnectors(
      bus,
      ctx(),
      ['ok', 'bad'],
      new Set(),
    );
    expect(out.map((c) => c.id)).toEqual(['ok']);
  });

  it('returns [] when connectors:resolve is unregistered (stripped preset)', async () => {
    const out = await resolveSkillReferencedConnectors(
      busWith({}),
      ctx(),
      ['linear'],
      new Set(),
    );
    expect(out).toEqual([]);
  });

  it('returns [] for an empty id list (no resolve calls)', async () => {
    let called = false;
    const bus = busWith({
      'connectors:resolve': async () => {
        called = true;
        return { id: 'x', capabilities: CAPS() };
      },
    });
    const out = await resolveSkillReferencedConnectors(bus, ctx(), [], new Set());
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('foldConnectorCaps', () => {
  it('folds hosts into the allowlist + namespaces credential slots', () => {
    const allow = new Set<string>(['api.anthropic.com']);
    const creds: Record<string, { ref: string; kind: string }> = {};
    const owners = new Map<string, string>();
    const connectors: ResolvedConnectorForOrch[] = [
      {
        id: 'gh',
        capabilities: {
          allowedHosts: ['api.github.com'],
          credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
          mcpServers: [],
          packages: { npm: [], pypi: [] },
        },
      },
    ];
    const r = foldConnectorCaps(connectors, allow, creds, owners);
    expect(allow.has('api.github.com')).toBe(true);
    // The env-NAME is namespaced under the CONNECTOR namespace; the untagged
    // slot's REF is the `account:<connectorId>` vault key TASK-96's connect flow
    // writes (one source of truth — matches serviceTagForSlot's id fallback).
    expect(creds[connectorCredentialEnvName('gh', 'GITHUB_TOKEN')]).toEqual({
      ref: 'account:gh',
      kind: 'api-key',
    });
    expect(r.connectorSlotEnvNames).toEqual([
      { envName: 'connector:gh:GITHUB_TOKEN', bareSlot: 'GITHUB_TOKEN' },
    ]);
  });

  it('an account-tagged slot derives the shared account:<svc> ref', () => {
    const creds: Record<string, { ref: string; kind: string }> = {};
    foldConnectorCaps(
      [
        {
          id: 'drive',
          capabilities: {
            allowedHosts: [],
            credentials: [{ slot: 'GDRIVE', kind: 'api-key', account: 'google' }],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        },
      ],
      new Set(),
      creds,
      new Map(),
    );
    expect(creds[connectorCredentialEnvName('drive', 'GDRIVE')]!.ref).toBe('account:google');
  });

  it('dedups against a skill slot of the same bare name (coexist, never collide)', () => {
    // Simulate the skill loop having already claimed `skill:gh:LINEAR_API_KEY`.
    const creds: Record<string, { ref: string; kind: string }> = {
      'skill:gh:LINEAR_API_KEY': { ref: 'skill-ref', kind: 'api-key' },
    };
    const owners = new Map<string, string>([['skill:gh:LINEAR_API_KEY', 'gh']]);
    foldConnectorCaps(
      [
        {
          id: 'linear',
          capabilities: {
            allowedHosts: [],
            credentials: [{ slot: 'LINEAR_API_KEY', kind: 'api-key' }],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        },
      ],
      new Set(),
      creds,
      owners,
    );
    // Both coexist under distinct namespaced keys — no collision, no overwrite.
    // The connector's REF is its `account:<connectorId>` vault key.
    expect(creds['skill:gh:LINEAR_API_KEY']!.ref).toBe('skill-ref');
    expect(creds['connector:linear:LINEAR_API_KEY']!.ref).toBe('account:linear');
  });

  it('detects npm/pypi package needs', () => {
    const r = foldConnectorCaps(
      [
        {
          id: 'sf',
          capabilities: {
            allowedHosts: [],
            credentials: [],
            mcpServers: [],
            packages: { npm: ['@salesforce/cli'], pypi: [] },
          },
        },
      ],
      new Set(),
      {},
      new Map(),
    );
    expect(r.needsNpmRegistry).toBe(true);
    expect(r.needsPypiRegistry).toBe(false);
  });

  it('emits an installed entry with a synthetic SKILL.md (usageNote body) + mcpServers', () => {
    const r = foldConnectorCaps(
      [
        {
          id: 'gdrive',
          usageNote: 'Use this to read Drive docs.',
          capabilities: {
            allowedHosts: ['drive.googleapis.com'],
            credentials: [],
            mcpServers: [
              {
                name: 'gdrive',
                transport: 'http',
                url: 'https://mcp.example.com/gdrive',
                allowedHosts: ['mcp.example.com'],
                credentials: [],
              },
            ],
            packages: { npm: [], pypi: [] },
          },
        },
      ],
      new Set(),
      {},
      new Map(),
    );
    expect(r.installedEntries).toHaveLength(1);
    const e = r.installedEntries[0]!;
    expect(e.id).toBe(connectorSandboxDirId('gdrive'));
    expect(e.connectorId).toBe('gdrive');
    const skillMd = e.files.find((f) => f.path === 'SKILL.md')!;
    expect(skillMd.contents).toMatch(/^---\n/);
    expect(skillMd.contents).toContain('Use this to read Drive docs.');
    expect(e.mcpServers).toHaveLength(1);
  });

  it('emits an entry with a fallback body when usageNote is empty (still materializes mcpServers)', () => {
    const r = foldConnectorCaps(
      [
        {
          id: 'bare',
          capabilities: {
            allowedHosts: [],
            credentials: [],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        },
      ],
      new Set(),
      {},
      new Map(),
    );
    const skillMd = r.installedEntries[0]!.files.find((f) => f.path === 'SKILL.md')!;
    expect(skillMd.contents).toContain('bare');
    expect(skillMd.contents.length).toBeGreaterThan(10);
  });
});
