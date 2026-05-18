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
});
