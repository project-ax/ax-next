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
  ConnectorServiceCollisionError,
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

// TASK-153 — a well-formed dev SERVICE descriptor (digest-pinned image, the
// canonical @ax/sandbox-protocol shape). `writablePaths` defaults to [] on parse
// but a literal must set it (the orchestrator forwards the PARSED descriptor).
const SVC = (over: Record<string, unknown> = {}) => ({
  name: 'postgres',
  image: 'postgres@sha256:' + 'a'.repeat(64),
  ports: [5432],
  env: { POSTGRES_PASSWORD: 'devsecret' },
  writablePaths: [],
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

  // TASK-107 — the per-agent attachment store is the THIRD source.
  it('resolves per-agent ATTACHMENTS as a third source (TASK-107)', async () => {
    const bus = busWith({
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        return { id, capabilities: CAPS(), usageNote: `${id} note` };
      },
    });
    const out = await resolveEffectiveConnectors(bus, ctx(), ['salesforce', 'gh']);
    expect(out.map((c) => c.id).sort()).toEqual(['gh', 'salesforce']);
    expect(out.find((c) => c.id === 'gh')!.capabilities.allowedHosts).toEqual([
      'api.example.com',
    ]);
  });

  it('dedups an attachment id against a default (default copy wins)', async () => {
    const resolvedIds: string[] = [];
    const bus = busWith({
      'connectors:list-defaults': async () => ({
        connectors: [{ id: 'shared', capabilities: CAPS(), usageNote: 'default note' }],
      }),
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        resolvedIds.push(id);
        return { id, capabilities: CAPS(), usageNote: `${id} note` };
      },
    });
    // 'shared' is both a default AND an attachment; 'extra' is attachment-only.
    const out = await resolveEffectiveConnectors(bus, ctx(), ['shared', 'extra']);
    expect(out.map((c) => c.id).sort()).toEqual(['extra', 'shared']);
    // 'shared' kept its default copy (note), and was NOT re-resolved as an attachment.
    expect(out.find((c) => c.id === 'shared')!.usageNote).toBe('default note');
    expect(resolvedIds).toEqual(['extra']);
  });

  it('is NON-FATAL: a dangling/unapproved attachment id is skipped, never widens reach', async () => {
    const bus = busWith({
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        if (id === 'pending') throw new Error('not-found'); // unapproved/dangling
        return { id, capabilities: CAPS() };
      },
    });
    const out = await resolveEffectiveConnectors(bus, ctx(), ['ok', 'pending']);
    expect(out.map((c) => c.id)).toEqual(['ok']);
  });

  it('empty attachments + no other source = [] (mcpConfigIds reverted, no stopgap)', async () => {
    const out = await resolveEffectiveConnectors(busWith({}), ctx(), []);
    expect(out).toEqual([]);
  });

  it('attachments + owner-own + defaults all union, deduped by id', async () => {
    const bus = busWith({
      'connectors:list-defaults': async () => ({
        connectors: [{ id: 'd', capabilities: CAPS() }],
      }),
      'connectors:list': async () => ({ connectors: [{ id: 'own' }] }),
      'connectors:resolve': async (_c, input) => {
        const id = (input as { connectorId: string }).connectorId;
        return { id, capabilities: CAPS() };
      },
    });
    const out = await resolveEffectiveConnectors(bus, ctx(), ['att']);
    expect(out.map((c) => c.id).sort()).toEqual(['att', 'd', 'own']);
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

  // TASK-124 — a ≥2-slot connector expands each slot to a DISTINCT per-slot ref
  // (`account:<service>:<slot>`) instead of collapsing two slots that share the
  // connectorId service tag onto one row (the collision the fold previously had).
  it('a multi-slot connector folds DISTINCT per-slot refs (the collision fix)', () => {
    const creds: Record<string, { ref: string; kind: string }> = {};
    foldConnectorCaps(
      [
        {
          id: 'oauthsvc',
          capabilities: {
            allowedHosts: [],
            credentials: [
              { slot: 'CLIENT_ID', kind: 'api-key' },
              { slot: 'CLIENT_SECRET', kind: 'api-key' },
            ],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        },
      ],
      new Set(),
      creds,
      new Map(),
    );
    const idRef = creds[connectorCredentialEnvName('oauthsvc', 'CLIENT_ID')]!.ref;
    const secretRef = creds[connectorCredentialEnvName('oauthsvc', 'CLIENT_SECRET')]!.ref;
    expect(idRef).toBe('account:oauthsvc:CLIENT_ID');
    expect(secretRef).toBe('account:oauthsvc:CLIENT_SECRET');
    // The two refs MUST differ — pre-TASK-124 both collapsed to account:oauthsvc.
    expect(idRef).not.toBe(secretRef);
  });

  // TASK-124 — a single-slot connector keeps the COLLAPSED ref (back-compat).
  it('a single-slot connector keeps the collapsed account:<service> ref', () => {
    const creds: Record<string, { ref: string; kind: string }> = {};
    foldConnectorCaps(
      [
        {
          id: 'gh',
          capabilities: {
            allowedHosts: [],
            credentials: [{ slot: 'GITHUB_TOKEN', kind: 'api-key' }],
            mcpServers: [],
            packages: { npm: [], pypi: [] },
          },
        },
      ],
      new Set(),
      creds,
      new Map(),
    );
    expect(creds[connectorCredentialEnvName('gh', 'GITHUB_TOKEN')]!.ref).toBe('account:gh');
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

  // TASK (mcp-oauth) — an OAuth connector slot folds to the `mcp-oauth`
  // credential kind in baseCreds. That kind drives the proxy's traffic
  // CLASSIFICATION (`'mcp'` for `mcp-*` kinds); the stored envelope kind (also
  // `mcp-oauth`, written by the OAuth callback) drives the resolve/refresh.
  // Per-turn ROTATION is NOT driven by the fold — it's armed by the orchestrator
  // gate (`sessionNeedsCredentialRotation` over the merged `unionedCreds`), which
  // sees this folded `mcp-oauth` entry as a non-`api-key` kind. The api-key path
  // stays byte-identical.
  it('maps an oauth connector slot to the mcp-oauth credential kind', () => {
    const baseAllowSet = new Set<string>();
    const baseCreds: Record<string, { ref: string; kind: string }> = {};
    const slotOwners = new Map<string, string>();
    foldConnectorCaps(
      [
        {
          id: 'example',
          usageNote: '',
          capabilities: {
            allowedHosts: ['mcp.example.com'],
            packages: { npm: [], pypi: [] },
            services: [],
            mcpServers: [
              {
                name: 'example',
                transport: 'http',
                url: 'https://mcp.example.com',
                allowedHosts: ['mcp.example.com'],
                credentials: [],
              },
            ],
            credentials: [{ slot: 'MCP_TOKEN', kind: 'oauth', server: 'example' }],
          },
        },
      ],
      baseAllowSet,
      baseCreds,
      slotOwners,
    );
    const entry = Object.values(baseCreds).find((e) => e.kind === 'mcp-oauth');
    expect(entry).toBeDefined();
    expect(entry!.ref).toBe('account:example'); // single-slot connector ⇒ collapsed ref
    expect(entry!.kind).toBe('mcp-oauth');
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

  // --- TASK-153 dev services fold -------------------------------------------

  it('folds a connector dev service onto the result services list', () => {
    const r = foldConnectorCaps(
      [{ id: 'db', capabilities: CAPS({ services: [SVC()] }) }],
      new Set(),
      {},
      new Map(),
    );
    expect(r.services).toHaveLength(1);
    expect(r.services[0]!.name).toBe('postgres');
    expect(r.services[0]!.image).toBe('postgres@sha256:' + 'a'.repeat(64));
  });

  it('returns an empty services list when no connector declares one', () => {
    const r = foldConnectorCaps(
      [{ id: 'plain', capabilities: CAPS() }],
      new Set(),
      {},
      new Map(),
    );
    expect(r.services).toEqual([]);
  });

  it('unions services across connectors (distinct names coexist)', () => {
    const r = foldConnectorCaps(
      [
        { id: 'db', capabilities: CAPS({ services: [SVC({ name: 'postgres' })] }) },
        { id: 'cache', capabilities: CAPS({ services: [SVC({ name: 'redis' })] }) },
      ],
      new Set(),
      {},
      new Map(),
    );
    expect(r.services.map((s) => s.name).sort()).toEqual(['postgres', 'redis']);
  });

  it('dedups a service name a SINGLE connector lists twice (idempotent, no throw)', () => {
    const r = foldConnectorCaps(
      [
        {
          id: 'db',
          capabilities: CAPS({ services: [SVC({ name: 'postgres' }), SVC({ name: 'postgres' })] }),
        },
      ],
      new Set(),
      {},
      new Map(),
    );
    expect(r.services).toHaveLength(1);
    expect(r.services[0]!.name).toBe('postgres');
  });

  it('throws ConnectorServiceCollisionError when TWO connectors declare the same service name', () => {
    expect(() =>
      foldConnectorCaps(
        [
          { id: 'a', capabilities: CAPS({ services: [SVC({ name: 'postgres' })] }) },
          {
            id: 'b',
            capabilities: CAPS({
              services: [SVC({ name: 'postgres', image: 'postgres@sha256:' + 'b'.repeat(64) })],
            }),
          },
        ],
        new Set(),
        {},
        new Map(),
      ),
    ).toThrow(ConnectorServiceCollisionError);
  });

  it('the collision error names BOTH connectors and the colliding service', () => {
    let caught: unknown;
    try {
      foldConnectorCaps(
        [
          { id: 'alpha', capabilities: CAPS({ services: [SVC({ name: 'postgres' })] }) },
          { id: 'beta', capabilities: CAPS({ services: [SVC({ name: 'postgres' })] }) },
        ],
        new Set(),
        {},
        new Map(),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorServiceCollisionError);
    const err = caught as ConnectorServiceCollisionError;
    expect(err.serviceName).toBe('postgres');
    expect(err.firstConnectorId).toBe('alpha');
    expect(err.secondConnectorId).toBe('beta');
    expect(err.message).toContain('postgres');
    expect(err.message).toContain('alpha');
    expect(err.message).toContain('beta');
  });
});
