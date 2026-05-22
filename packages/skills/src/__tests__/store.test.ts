import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createSkillsStore } from '../store.js';

let container: StartedPostgreSqlContainer;
let connectionString: string;
const opened: Kysely<SkillsDatabase>[] = [];

// Sample manifest with allowedHosts + credentials so capabilities can be
// asserted round-trip.
const SAMPLE_MANIFEST = `name: github
description: Access the GitHub REST API with a personal access token.
version: 1
capabilities:
  allowedHosts:
    - api.github.com
  credentials:
    - slot: GITHUB_TOKEN
      kind: api-key
      description: GitHub PAT.
`;

const SAMPLE_BODY = '# GitHub\n\nGitHub skill body.\n';

function makeKysely(): Kysely<SkillsDatabase> {
  const k = new Kysely<SkillsDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: 2 }),
    }),
  });
  opened.push(k);
  return k;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  connectionString = container.getConnectionUri();
}, 120_000);

afterEach(async () => {
  while (opened.length > 0) {
    const k = opened.pop()!;
    try {
      await k.schema.dropTable('skills_v1_skills').ifExists().execute();
    } catch {
      /* drained pool */
    }
    await k.destroy().catch(() => {});
  }
});

afterAll(async () => {
  if (container) await container.stop();
});

describe('SkillsStore', () => {
  it('upsert of a new skill returns { created: true }', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    const result = await store.upsert({
      id: 'github',
      description: 'Access the GitHub REST API.',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
    });
    expect(result).toEqual({ created: true });
  });

  it('upsert of existing skill returns { created: false } and updates the row', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'github',
      description: 'Original description.',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
    });

    const updatedBody = '# Updated GitHub\n';
    const result = await store.upsert({
      id: 'github',
      description: 'Updated description.',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: updatedBody,
      version: 2,
    });
    expect(result).toEqual({ created: false });

    // All mutable fields updated.
    const detail = await store.get('github');
    expect(detail).not.toBeNull();
    expect(detail!.description).toBe('Updated description.');
    expect(detail!.bodyMd).toBe(updatedBody);
    expect(detail!.manifestYaml).toBe(SAMPLE_MANIFEST);
    expect(detail!.version).toBe(2);
  });

  it('list() returns all skills ordered by skill_id with capabilities parsed', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'github',
      description: 'GitHub.',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
    });

    const aManifest = 'name: airtable\ndescription: Airtable skill.\n';
    await store.upsert({
      id: 'airtable',
      description: 'Airtable.',
      manifestYaml: aManifest,
      bodyMd: '# Airtable\n',
      version: 0,
    });

    const skills = await store.list();
    expect(skills.map((s) => s.id)).toEqual(['airtable', 'github']);
    // capabilities re-parsed from manifest_yaml
    const github = skills.find((s) => s.id === 'github');
    expect(github?.capabilities.allowedHosts).toEqual(['api.github.com']);
    expect(github?.capabilities.credentials).toHaveLength(1);
    expect(github?.capabilities.credentials[0]?.slot).toBe('GITHUB_TOKEN');
  });

  it('get(id) returns full detail for existing skill, null for missing', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    expect(await store.get('github')).toBeNull();

    await store.upsert({
      id: 'github',
      description: 'GitHub.',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
    });

    const detail = await store.get('github');
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('github');
    expect(detail!.bodyMd).toBe(SAMPLE_BODY);
    expect(detail!.manifestYaml).toBe(SAMPLE_MANIFEST);
    expect(typeof detail!.updatedAt).toBe('string');
    // updatedAt is a valid ISO timestamp — `new Date(garbage)` returns
    // Invalid Date (does not throw), so check round-trip parse equality
    // to actually pin the format.
    const parsedUpdatedAt = new Date(detail!.updatedAt);
    expect(Number.isNaN(parsedUpdatedAt.getTime())).toBe(false);
    expect(parsedUpdatedAt.toISOString()).toBe(detail!.updatedAt);
  });

  it('delete(id) removes the row; subsequent get returns null', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'github',
      description: 'GitHub.',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
    });

    await store.delete('github');
    expect(await store.get('github')).toBeNull();
  });

  it('upsert with defaultAttached: true persists the flag and reads back via get()', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    // Instruction-only manifest (no credential slots) — required for defaults.
    const INSTRUCTION_ONLY_MANIFEST = `name: heartbeat
description: Daily check-in skill.
version: 1
`;
    await store.upsert({
      id: 'heartbeat',
      description: 'Daily check-in skill.',
      manifestYaml: INSTRUCTION_ONLY_MANIFEST,
      bodyMd: '# Heartbeat\n',
      version: 1,
      defaultAttached: true,
    });

    const detail = await store.get('heartbeat');
    expect(detail).not.toBeNull();
    expect(detail!.defaultAttached).toBe(true);

    // list() also reports it.
    const list = await store.list();
    expect(list.find((s) => s.id === 'heartbeat')?.defaultAttached).toBe(true);
  });

  it('getDefaults() returns ResolvedSkill[] for default-attached rows ordered by id', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    // Two defaults + one explicit-only skill.
    await store.upsert({
      id: 'heartbeat',
      description: 'd',
      manifestYaml: 'name: heartbeat\ndescription: d\n',
      bodyMd: '# heartbeat\n',
      version: 0,
      defaultAttached: true,
    });
    await store.upsert({
      id: 'acceptance-canary',
      description: 'd',
      manifestYaml: 'name: acceptance-canary\ndescription: d\n',
      bodyMd: '# canary\n',
      version: 0,
      defaultAttached: true,
    });
    await store.upsert({
      id: 'github',
      description: 'd',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
      defaultAttached: false,
    });

    const defaults = await store.getDefaults();
    expect(defaults.map((s) => s.id)).toEqual(['acceptance-canary', 'heartbeat']);
    // Returns the ResolvedSkill shape — same as resolve().
    expect(defaults[0]).toMatchObject({
      id: 'acceptance-canary',
      bodyMd: '# canary\n',
      capabilities: { allowedHosts: [], credentials: [] },
    });
    expect(defaults[0]).toHaveProperty('manifestYaml');
  });

  it('persists and reads back sourceUrl', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'su-skill',
      description: 'd',
      manifestYaml: 'name: su-skill\ndescription: d\n',
      bodyMd: 'b',
      version: 1,
      sourceUrl: 'https://example.com/skill.md',
    });
    const summary = (await store.list()).find((s) => s.id === 'su-skill');
    expect(summary?.sourceUrl).toBe('https://example.com/skill.md');

    const detail = await store.get('su-skill');
    expect(detail!.sourceUrl).toBe('https://example.com/skill.md');
  });

  it('clears sourceUrl when re-upserted without one', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'su-skill', description: 'd', manifestYaml: 'name: su-skill\ndescription: d\n',
      bodyMd: 'b', version: 1, sourceUrl: 'https://example.com/skill.md',
    });
    await store.upsert({
      id: 'su-skill', description: 'd', manifestYaml: 'name: su-skill\ndescription: d\n',
      bodyMd: 'b', version: 2,   // no sourceUrl
    });
    const detail = await store.get('su-skill');
    expect(detail!.sourceUrl).toBeUndefined();
  });

  it('roundtrips capabilities.mcpServers through upsert + list + get', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    const yaml = `name: ghub
description: GitHub MCP bundle.
capabilities:
  mcpServers:
    - name: github
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
`;
    await store.upsert({
      id: 'ghub',
      description: 'GitHub MCP bundle.',
      manifestYaml: yaml,
      bodyMd: '# ghub\n',
      version: 0,
    });

    const list = await store.list();
    const ghub = list.find((s) => s.id === 'ghub');
    expect(ghub?.capabilities.mcpServers).toHaveLength(1);
    expect(ghub?.capabilities.mcpServers[0]?.name).toBe('github');

    const detail = await store.get('ghub');
    expect(detail).not.toBeNull();
    expect(detail!.capabilities.mcpServers[0]?.transport).toBe('stdio');
    expect(detail!.capabilities.mcpServers[0]?.command).toBe('npx');
  });

  it('resolve preserves input order and drops unknown ids silently', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'github',
      description: 'GitHub.',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
    });

    const slackManifest = `name: slack
description: Post to Slack.
version: 0
capabilities:
  allowedHosts:
    - slack.com
  credentials:
    - slot: SLACK_TOKEN
      kind: api-key
`;
    await store.upsert({
      id: 'slack',
      description: 'Slack.',
      manifestYaml: slackManifest,
      bodyMd: '# Slack\n',
      version: 0,
    });

    // Input order: missing, slack, also-missing, github → only slack+github returned in that order.
    const resolved = await store.resolve(['missing', 'slack', 'also-missing', 'github']);
    expect(resolved.map((r) => r.id)).toEqual(['slack', 'github']);

    const github = resolved.find((r) => r.id === 'github');
    expect(github?.capabilities.allowedHosts).toEqual(['api.github.com']);
    expect(github?.capabilities.credentials[0]?.slot).toBe('GITHUB_TOKEN');
  });

  it('skills:resolve carries capabilities.packages through from the stored manifest (D)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    const linearManifest = `name: linear
description: Linear CLI skill.
version: 1
capabilities:
  allowedHosts:
    - api.linear.app
  packages:
    npm:
      - "@linear/cli"
`;
    await store.upsert({
      id: 'linear',
      description: 'Linear CLI skill.',
      manifestYaml: linearManifest,
      bodyMd: '# Linear\n',
      version: 1,
    });

    const resolved = await store.resolve(['linear']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.capabilities.packages.npm).toEqual(['@linear/cli']);
    expect(resolved[0]?.capabilities.packages.pypi).toEqual([]);
  });
});
