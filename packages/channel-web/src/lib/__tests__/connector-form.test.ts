import { describe, it, expect } from 'vitest';
import {
  emptyConnectorForm,
  emptySlotRow,
  formFromConnector,
  capabilitiesFromForm,
  summaryToForm,
  connectorIdFromName,
  splitList,
  applyComposeToForm,
  STARTER_SERVICE_EXAMPLES,
  type ConnectorFormState,
} from '../connector-form';
import { emptyCapabilities, type Connector } from '../connectors';
import { ServiceDescriptorSchema } from '@ax/skills-parser';

const PINNED = 'docker.io/library/postgres@sha256:' + 'a'.repeat(64);

const baseConnector = (over: Partial<Connector> = {}): Connector => ({
  id: 'gdrive',
  name: 'Google Drive',
  description: 'Drive files.',
  usageNote: 'Read and write Drive.',
  keyMode: 'personal',
  visibility: 'private',
  defaultAttached: false,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  capabilities: emptyCapabilities(),
  ...over,
});

describe('connector-form helpers', () => {
  it('emptyConnectorForm is a private, personal, non-default MCP/stdio form', () => {
    const f = emptyConnectorForm();
    expect(f.keyMode).toBe('personal');
    expect(f.visibility).toBe('private');
    expect(f.defaultAttached).toBe(false);
    expect(f.mechanism).toBe('mcp');
    expect(f.transport).toBe('stdio');
    expect(f.credentialSlots).toEqual([]);
    expect(f.packageRegistry).toBe('npm');
    expect(f.packageName).toBe('');
    expect(f.baseCapabilities).toEqual(emptyCapabilities());
  });

  it('emptySlotRow is a blank structured row (slot + description only)', () => {
    expect(emptySlotRow()).toEqual({ slot: '', description: '' });
  });

  it('splitList trims, drops empties', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c']);
    expect(splitList('')).toEqual([]);
  });

  it('connectorIdFromName slugifies', () => {
    expect(connectorIdFromName('Google Drive!')).toBe('google-drive-');
    expect(connectorIdFromName('My_Notion.v2')).toBe('my_notion.v2');
  });

  // --- mechanism inference on load ----------------------------------------

  it('formFromConnector infers MCP from a leading mcp server + reads its fields', () => {
    const c = baseConnector({
      keyMode: 'workspace',
      visibility: 'shared',
      defaultAttached: true,
      capabilities: {
        ...emptyCapabilities(),
        allowedHosts: ['drive.googleapis.com'],
        credentials: [{ slot: 'token', kind: 'api-key' }],
        mcpServers: [
          {
            name: 'gdrive',
            transport: 'stdio',
            command: 'mcp-gdrive',
            args: ['--flag', 'x'],
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    });
    const f = formFromConnector(c);
    expect(f.mechanism).toBe('mcp');
    expect(f.keyMode).toBe('workspace');
    expect(f.visibility).toBe('shared');
    expect(f.defaultAttached).toBe(true);
    expect(f.transport).toBe('stdio');
    expect(f.command).toBe('mcp-gdrive');
    expect(f.args).toBe('--flag x');
    expect(f.allowedHosts).toBe('drive.googleapis.com');
    expect(f.credentialSlots).toEqual([
      { slot: 'token', description: '' },
    ]);
  });

  it('formFromConnector infers http MCP and reads the url', () => {
    const c = baseConnector({
      capabilities: {
        ...emptyCapabilities(),
        mcpServers: [
          {
            name: 'remote',
            transport: 'http',
            url: 'https://mcp.example.com',
            allowedHosts: [],
            credentials: [],
          },
        ],
      },
    });
    const f = formFromConnector(c);
    expect(f.mechanism).toBe('mcp');
    expect(f.transport).toBe('http');
    expect(f.url).toBe('https://mcp.example.com');
  });

  it('formFromConnector infers CLI from a package + reads registry/name', () => {
    const c = baseConnector({
      capabilities: {
        ...emptyCapabilities(),
        packages: { npm: [], pypi: ['some-cli'] },
        allowedHosts: ['api.example.com'],
      },
    });
    const f = formFromConnector(c);
    expect(f.mechanism).toBe('cli');
    expect(f.packageRegistry).toBe('pypi');
    expect(f.packageName).toBe('some-cli');
    expect(f.allowedHosts).toBe('api.example.com');
  });

  it('formFromConnector infers Direct API when neither packages nor mcp server present', () => {
    const c = baseConnector({
      capabilities: {
        ...emptyCapabilities(),
        allowedHosts: ['api.stripe.com'],
        credentials: [{ slot: 'key', kind: 'api-key', description: 'Secret key' }],
      },
    });
    const f = formFromConnector(c);
    expect(f.mechanism).toBe('direct-api');
    expect(f.allowedHosts).toBe('api.stripe.com');
    expect(f.credentialSlots).toEqual([
      { slot: 'key', description: 'Secret key' },
    ]);
  });

  it('formFromConnector reads description onto structured rows', () => {
    const c = baseConnector({
      capabilities: {
        ...emptyCapabilities(),
        credentials: [
          { slot: 'CLIENT_ID', kind: 'api-key', description: 'Client ID' },
          { slot: 'CLIENT_SECRET', kind: 'api-key' },
        ],
      },
    });
    const f = formFromConnector(c);
    expect(f.credentialSlots).toEqual([
      { slot: 'CLIENT_ID', description: 'Client ID' },
      { slot: 'CLIENT_SECRET', description: '' },
    ]);
  });

  // --- capabilitiesFromForm per mechanism ---------------------------------

  it('mcp/stdio builds the leading mcp server, no packages', () => {
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'GDrive',
      mechanism: 'mcp',
      transport: 'stdio',
      command: 'mcp-gdrive',
      args: 'a b',
      allowedHosts: 'drive.googleapis.com, www.googleapis.com',
      credentialSlots: [{ slot: 'token', description: '' }],
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.allowedHosts).toEqual([
      'drive.googleapis.com',
      'www.googleapis.com',
    ]);
    expect(caps.credentials).toEqual([{ slot: 'token', kind: 'api-key' }]);
    expect(caps.mcpServers).toHaveLength(1);
    expect(caps.mcpServers[0]!.transport).toBe('stdio');
    expect(caps.mcpServers[0]!.command).toBe('mcp-gdrive');
    expect(caps.mcpServers[0]!.args).toEqual(['a', 'b']);
    expect(caps.packages).toEqual({ npm: [], pypi: [] });
  });

  it('mcp/http builds the leading mcp server with a url', () => {
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'Remote',
      mechanism: 'mcp',
      transport: 'http',
      url: 'https://mcp.example.com',
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.mcpServers).toHaveLength(1);
    expect(caps.mcpServers[0]!.transport).toBe('http');
    expect(caps.mcpServers[0]!.url).toBe('https://mcp.example.com');
    expect(caps.mcpServers[0]!.command).toBeUndefined();
  });

  it('direct-api builds top-level hosts + credentials, no mcp server, no packages', () => {
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'Stripe',
      mechanism: 'direct-api',
      allowedHosts: 'api.stripe.com',
      credentialSlots: [{ slot: 'key', description: 'Secret key' }],
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.mcpServers).toEqual([]);
    expect(caps.packages).toEqual({ npm: [], pypi: [] });
    expect(caps.allowedHosts).toEqual(['api.stripe.com']);
    expect(caps.credentials).toEqual([
      { slot: 'key', kind: 'api-key', description: 'Secret key' },
    ]);
  });

  it('cli builds the npm package + hosts + credentials, no mcp server', () => {
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'My CLI',
      mechanism: 'cli',
      packageRegistry: 'npm',
      packageName: '@org/cli',
      allowedHosts: 'registry.example.com',
      credentialSlots: [{ slot: 'TOKEN', description: '' }],
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.packages).toEqual({ npm: ['@org/cli'], pypi: [] });
    expect(caps.mcpServers).toEqual([]);
    expect(caps.allowedHosts).toEqual(['registry.example.com']);
    expect(caps.credentials).toEqual([{ slot: 'TOKEN', kind: 'api-key' }]);
  });

  it('cli builds a pypi package', () => {
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'Py CLI',
      mechanism: 'cli',
      packageRegistry: 'pypi',
      packageName: 'awscli',
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.packages).toEqual({ npm: [], pypi: ['awscli'] });
  });

  it('structured rows map to slots (description when set), dropping empty-slot rows', () => {
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'OAuth',
      mechanism: 'direct-api',
      credentialSlots: [
        { slot: 'CLIENT_ID', description: 'Client ID' },
        { slot: '', description: 'orphan' },
        { slot: 'CLIENT_SECRET', description: '' },
      ],
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.credentials).toEqual([
      { slot: 'CLIENT_ID', kind: 'api-key', description: 'Client ID' },
      { slot: 'CLIENT_SECRET', kind: 'api-key' },
    ]);
  });

  it('switching mechanism away from MCP clears the leading mcp server on submit', () => {
    // A connector that was MCP, edited to direct-api: the leading server must
    // not survive into the direct-api capabilities fill.
    const base = {
      ...emptyCapabilities(),
      mcpServers: [
        {
          name: 'old',
          transport: 'stdio' as const,
          command: 'old-cmd',
          args: [],
          allowedHosts: [],
          credentials: [],
        },
      ],
    };
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'Now Direct',
      mechanism: 'direct-api',
      allowedHosts: 'api.example.com',
      baseCapabilities: base,
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.mcpServers).toEqual([]);
  });

  it('switching to CLI clears the leading mcp server but keeps beyond-first servers', () => {
    const base = {
      ...emptyCapabilities(),
      mcpServers: [
        {
          name: 'leading',
          transport: 'stdio' as const,
          command: 'lead',
          args: [],
          allowedHosts: [],
          credentials: [],
        },
        {
          name: 'second',
          transport: 'http' as const,
          url: 'https://second.example',
          allowedHosts: [],
          credentials: [],
        },
      ],
    };
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'CLI now',
      mechanism: 'cli',
      packageRegistry: 'npm',
      packageName: 'tool',
      baseCapabilities: base,
    };
    const caps = capabilitiesFromForm(f);
    // Leading replaced/cleared; beyond-first preserved.
    expect(caps.mcpServers).toHaveLength(1);
    expect(caps.mcpServers[0]!.name).toBe('second');
    expect(caps.packages).toEqual({ npm: ['tool'], pypi: [] });
  });

  it('mcp edit PRESERVES inner env/hosts/creds + beyond-first server + beyond-first package', () => {
    const base = {
      ...emptyCapabilities(),
      packages: { npm: ['@org/cli', '@org/extra'], pypi: [] },
      mcpServers: [
        {
          name: 'gdrive',
          transport: 'stdio' as const,
          command: 'old',
          args: [],
          env: { FOO: 'bar' },
          allowedHosts: ['inner.example'],
          credentials: [{ slot: 'inner', kind: 'api-key' as const }],
        },
        {
          name: 'second',
          transport: 'http' as const,
          url: 'https://second.example',
          allowedHosts: [],
          credentials: [],
        },
      ],
    };
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'GDrive',
      mechanism: 'mcp',
      transport: 'stdio',
      command: 'new-cmd',
      baseCapabilities: base,
    };
    const caps = capabilitiesFromForm(f);
    // leading server's command overlaid, but env + inner fields preserved
    expect(caps.mcpServers[0]!.command).toBe('new-cmd');
    expect(caps.mcpServers[0]!.env).toEqual({ FOO: 'bar' });
    expect(caps.mcpServers[0]!.allowedHosts).toEqual(['inner.example']);
    // beyond-first server untouched
    expect(caps.mcpServers[1]!.name).toBe('second');
    // packages: the LEADING package is dropped (it belongs to the cli mechanism,
    // not mcp), beyond-first un-surfaced packages preserved.
    expect(caps.packages).toEqual({ npm: ['@org/extra'], pypi: [] });
  });

  it('switching away from CLI to direct-api drops the leading package (no egress+exec leak)', () => {
    const base = {
      ...emptyCapabilities(),
      packages: { npm: ['leftover-cli'], pypi: [] },
    };
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'Now Direct',
      mechanism: 'direct-api',
      allowedHosts: 'api.example.com',
      baseCapabilities: base,
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.packages).toEqual({ npm: [], pypi: [] });
  });

  it('cli edit preserves a beyond-first package, overlays the leading one', () => {
    const base = {
      ...emptyCapabilities(),
      packages: { npm: ['old-lead', 'keep-me'], pypi: [] },
    };
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'CLI',
      mechanism: 'cli',
      packageRegistry: 'npm',
      packageName: 'new-lead',
      baseCapabilities: base,
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.packages.npm).toEqual(['new-lead', 'keep-me']);
  });

  // --- services (TASK-154 — dev service bundle) ---------------------------

  it('emptyConnectorForm has no declared services', () => {
    expect(emptyConnectorForm().services).toEqual([]);
  });

  it('formFromConnector reads declared services off capabilities', () => {
    const c = baseConnector({
      capabilities: {
        ...emptyCapabilities(),
        services: [
          { name: 'db', image: PINNED, ports: [5432], env: { K: 'v' }, writablePaths: [] },
        ],
      },
    });
    const f = formFromConnector(c);
    expect(f.services).toEqual([
      { name: 'db', image: PINNED, ports: [5432], env: { K: 'v' }, writablePaths: [] },
    ]);
  });

  it('capabilitiesFromForm carries declared services onto the proposal', () => {
    const f: ConnectorFormState = {
      ...emptyConnectorForm(),
      name: 'PG bundle',
      mechanism: 'direct-api',
      services: [
        { name: 'db', image: PINNED, ports: [5432], env: {}, writablePaths: [] },
      ],
    };
    const caps = capabilitiesFromForm(f);
    expect(caps.services).toEqual([
      { name: 'db', image: PINNED, ports: [5432], env: {}, writablePaths: [] },
    ]);
  });

  it('capabilitiesFromForm OMITS services when none declared (back-compat)', () => {
    const caps = capabilitiesFromForm({ ...emptyConnectorForm(), name: 'x' });
    expect(caps.services).toBeUndefined();
  });

  it('editing an MCP connector that declares services does NOT wipe them (the merge bug)', () => {
    // Before TASK-154 capabilitiesFromForm dropped `services` — any edit of a
    // service-bundle connector silently erased its services. Round-trip must
    // preserve them.
    const c = baseConnector({
      capabilities: {
        ...emptyCapabilities(),
        mcpServers: [
          { name: 'gdrive', transport: 'stdio', command: 'mcp-gdrive', args: [], allowedHosts: [], credentials: [] },
        ],
        services: [
          { name: 'db', image: PINNED, ports: [5432], env: {}, writablePaths: [] },
        ],
      },
    });
    const f = formFromConnector(c);
    // Edit something unrelated (the command), submit.
    const caps = capabilitiesFromForm({ ...f, command: 'mcp-gdrive-v2' });
    expect(caps.mcpServers[0]!.command).toBe('mcp-gdrive-v2');
    expect(caps.services).toEqual([
      { name: 'db', image: PINNED, ports: [5432], env: {}, writablePaths: [] },
    ]);
  });

  it('applyComposeToForm populates service rows from a clean pinned compose', () => {
    const yaml = `
services:
  db:
    image: ${PINNED}
    ports: ["5432:5432"]
    environment:
      POSTGRES_PASSWORD: secret
`;
    const f = { ...emptyConnectorForm(), name: 'PG' };
    const result = applyComposeToForm(f, yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.services).toEqual([
      { name: 'db', image: PINNED, ports: [5432], env: { POSTGRES_PASSWORD: 'secret' }, writablePaths: [] },
    ]);
    expect(result.drops).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  it('applyComposeToForm surfaces dropped unsafe fields and un-pinned-image flags', () => {
    const yaml = `
services:
  db:
    image: ${PINNED}
    privileged: true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
  cache:
    image: redis:7
`;
    const f = { ...emptyConnectorForm(), name: 'PG' };
    const result = applyComposeToForm(f, yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // db crossed (pinned), with privileged + the socket volume dropped + reported.
    expect(result.form.services.map((s) => s.name)).toEqual(['db']);
    const fields = result.drops.map((d) => d.field);
    expect(fields).toContain('privileged');
    expect(fields).toContain('volumes');
    // redis:7 is un-pinned → flagged invalid for the author to pin.
    expect(result.invalid.map((i) => i.name)).toEqual(['cache']);
  });

  it('applyComposeToForm returns ok:false on unusable paste (not YAML / no services)', () => {
    const f = { ...emptyConnectorForm(), name: 'PG' };
    expect(applyComposeToForm(f, '- not a mapping').ok).toBe(false);
    expect(applyComposeToForm(f, 'version: "3"').ok).toBe(false);
  });

  it('applyComposeToForm REPLACES existing services (not append) so re-paste is idempotent', () => {
    const f = {
      ...emptyConnectorForm(),
      name: 'PG',
      services: [{ name: 'old', image: PINNED, ports: [1], env: {}, writablePaths: [] }],
    };
    const yaml = `services:\n  db:\n    image: ${PINNED}\n`;
    const result = applyComposeToForm(f, yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.services.map((s) => s.name)).toEqual(['db']);
  });

  it('summaryToForm carries the metadata subset incl. defaultAttached', () => {
    const partial = summaryToForm({
      id: 'org-github',
      name: 'Org GitHub',
      description: 'd',
      usageNote: 'u',
      keyMode: 'workspace',
      visibility: 'private',
      defaultAttached: true,
      createdAt: 'x',
      updatedAt: 'y',
    });
    expect(partial.connectorId).toBe('org-github');
    expect(partial.defaultAttached).toBe(true);
    expect(partial.keyMode).toBe('workspace');
  });
});

describe('STARTER_SERVICE_EXAMPLES (TASK-159)', () => {
  it('ships a small set — examples, not a catalog', () => {
    // A guard rail against this constant quietly growing into a registry. If a
    // future example is genuinely proven, bump the bound deliberately.
    expect(STARTER_SERVICE_EXAMPLES.length).toBeGreaterThanOrEqual(2);
    expect(STARTER_SERVICE_EXAMPLES.length).toBeLessThanOrEqual(4);
  });

  it('every example parses as a valid, digest-pinned ServiceDescriptor', () => {
    for (const ex of STARTER_SERVICE_EXAMPLES) {
      expect(ex.label.length).toBeGreaterThan(0);
      expect(ex.description.length).toBeGreaterThan(0);
      // The canonical schema enforces digest-pinning + absolute writablePaths +
      // caps; if an example drifts off-shape it fails here, not in production.
      const parsed = ServiceDescriptorSchema.parse(ex.service);
      expect(parsed.image).toMatch(/@sha256:[0-9a-f]{64}$/);
      for (const p of parsed.writablePaths) expect(p.startsWith('/')).toBe(true);
    }
  });

  it('carries the proven Mongo + Kafka-native pins and writable paths exactly', () => {
    const byLabel = (label: string) =>
      STARTER_SERVICE_EXAMPLES.find((e) => e.label === label)?.service;

    const mongo = byLabel('MongoDB');
    expect(mongo?.image).toBe(
      'docker.io/library/mongo@sha256:4b5bf3c2bb7516164f6dcb44acce4fdcb428abfe5771a1128304a0f34ab9ff7c',
    );
    expect(mongo?.writablePaths).toEqual(['/data/db', '/tmp']);

    const kafka = byLabel('Kafka (native)');
    expect(kafka?.image).toBe(
      'docker.io/apache/kafka-native@sha256:c20b97f0a3990771f52bf7855ccb9ae82ac683a357a101482ba349dfb2ae0cdb',
    );
    expect(kafka?.writablePaths).toEqual([
      '/var/lib/kafka/data',
      '/tmp',
      '/opt/kafka/config',
      '/opt/kafka/logs',
      '/mnt/shared/config',
    ]);
  });
});
