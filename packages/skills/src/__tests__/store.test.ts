import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { runSkillsMigration, type SkillsDatabase } from '../migrations.js';
import { createSkillsStore } from '../store.js';
import { createUserSkillsStore } from '../user-store.js';
import { createBundleStore } from '../bundle-store.js';

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
      await k.schema.dropTable('skills_v1_skill_files').ifExists().execute();
    } catch {
      /* drained pool */
    }
    try {
      await k.schema.dropTable('skills_v1_user_skills').ifExists().execute();
    } catch {
      /* drained pool */
    }
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

  it('upsert stores extra files; get/resolve return them; re-upsert replaces', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'demo',
      description: 'd',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });

    const got = await store.get('demo');
    expect(got?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);

    const [resolved] = await store.resolve(['demo']);
    expect(resolved?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);

    // Re-upsert with a different file set fully replaces the old set.
    await store.upsert({
      id: 'demo',
      description: 'd',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 2,
      files: [{ path: 'data/x.json', contents: '{}' }],
    });
    const got2 = await store.get('demo');
    expect(got2?.files).toEqual([{ path: 'data/x.json', contents: '{}' }]);
  });

  it('re-upsert with files OMITTED preserves the existing extra files (no silent clear)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);

    await store.upsert({
      id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });

    // A metadata-only edit (the existing admin/settings/refresh route shape)
    // sends no `files` — it MUST NOT wipe the stored bundle (the §6D data-loss
    // bug codex flagged). `undefined` = leave files unchanged.
    await store.upsert({
      id: 'demo', description: 'edited', manifestYaml: SAMPLE_MANIFEST, bodyMd: '# edited\n', version: 2,
    });
    const got = await store.get('demo');
    expect(got?.description).toBe('edited');
    expect(got?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  });

  it('re-upsert with an EXPLICIT empty files array clears the extra files', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);
    await store.upsert({
      id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });
    await store.upsert({
      id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 2,
      files: [],
    });
    const got = await store.get('demo');
    expect(got?.files).toEqual([]);
  });

  it('a skill with no extra files reports files: []', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);
    await store.upsert({
      id: 'demo',
      description: 'd',
      manifestYaml: SAMPLE_MANIFEST,
      bodyMd: SAMPLE_BODY,
      version: 1,
    });
    const got = await store.get('demo');
    expect(got?.files).toEqual([]);
    const [resolved] = await store.resolve(['demo']);
    expect(resolved?.files).toEqual([]);
  });

  it('upsert writes a bundle_tree_sha; single-file skill leaves it NULL', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db); // default ephemeral bundle store

    await store.upsert({
      id: 'multi', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });
    await store.upsert({
      id: 'single', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
    });

    const multiRow = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'multi').executeTakeFirstOrThrow();
    const singleRow = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'single').executeTakeFirstOrThrow();
    expect(multiRow.bundle_tree_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(singleRow.bundle_tree_sha).toBeNull();

    // Round-trip still works (behavior contract unchanged).
    expect((await store.get('multi'))?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    expect((await store.get('single'))?.files).toEqual([]);

    // Re-upsert with a NEW file set replaces the tree (new SHA), and an explicit
    // [] clears it back to NULL.
    await store.upsert({ id: 'multi', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 2, files: [{ path: 'data/x.json', contents: '{}' }] });
    expect((await store.get('multi'))?.files).toEqual([{ path: 'data/x.json', contents: '{}' }]);
    await store.upsert({ id: 'multi', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 3, files: [] });
    const cleared = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'multi').executeTakeFirstOrThrow();
    expect(cleared.bundle_tree_sha).toBeNull();
    expect((await store.get('multi'))?.files).toEqual([]);
  });

  it('upsert with files:undefined leaves an existing bundle untouched (no §6D data loss)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);
    await store.upsert({ id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1, files: [{ path: 'a.txt', contents: '1' }] });
    // Metadata-only edit (no `files` key) must NOT wipe the bundle.
    await store.upsert({ id: 'demo', description: 'changed', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 2 });
    expect((await store.get('demo'))?.files).toEqual([{ path: 'a.txt', contents: '1' }]);
  });

  it('resolve over multiple ids returns each skill its own files (no N+1 leak)', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const store = createSkillsStore(db);
    await store.upsert({
      id: 'alpha',
      description: 'd',
      manifestYaml: 'name: alpha\ndescription: d\n',
      bodyMd: '# a\n',
      version: 1,
      files: [{ path: 'a.txt', contents: 'A' }],
    });
    await store.upsert({
      id: 'beta',
      description: 'd',
      manifestYaml: 'name: beta\ndescription: d\n',
      bodyMd: '# b\n',
      version: 1,
      files: [{ path: 'b.txt', contents: 'B' }],
    });
    const resolved = await store.resolve(['alpha', 'beta']);
    expect(resolved.map((r) => r.id)).toEqual(['alpha', 'beta']);
    expect(resolved[0]?.files).toEqual([{ path: 'a.txt', contents: 'A' }]);
    expect(resolved[1]?.files).toEqual([{ path: 'b.txt', contents: 'B' }]);
  });

  it('user store round-trips a bundle via bundle_tree_sha', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const userStore = createUserSkillsStore(db);
    await userStore.upsert({
      ownerUserId: 'alice', id: 'demo', description: 'd',
      manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1,
      files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
    });
    expect((await userStore.get('alice', 'demo'))?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    const [resolved] = await userStore.resolve('alice', ['demo']);
    expect(resolved?.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
  });

  it('global + user stores sharing one bundle repo dedup identical bytes', async () => {
    const db = makeKysely();
    await runSkillsMigration(db);
    const bundleStore = createBundleStore(mkdtempSync(joinPath(tmpdir(), 'ax-shared-bundles-')));
    const store = createSkillsStore(db, bundleStore);
    const userStore = createUserSkillsStore(db, bundleStore);
    await store.upsert({ id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1, files: [{ path: 'a.txt', contents: 'same' }] });
    await userStore.upsert({ ownerUserId: 'alice', id: 'demo', description: 'd', manifestYaml: SAMPLE_MANIFEST, bodyMd: SAMPLE_BODY, version: 1, files: [{ path: 'a.txt', contents: 'same' }] });
    const g = await db.selectFrom('skills_v1_skills').select('bundle_tree_sha').where('skill_id', '=', 'demo').executeTakeFirstOrThrow();
    const u = await db.selectFrom('skills_v1_user_skills').select('bundle_tree_sha').where('owner_user_id', '=', 'alice').where('skill_id', '=', 'demo').executeTakeFirstOrThrow();
    expect(g.bundle_tree_sha).toBe(u.bundle_tree_sha); // content-addressed: same bytes, same SHA
  });

  // -------------------------------------------------------------------------
  // TASK-57: store-level atomic partial-update for the default-attached toggle.
  // The flag-only setter must NOT read-then-write the whole manifest/body/bundle
  // (the documented PATCH /admin/skills/:id race). It flips one column inside a
  // single transaction with a row lock.
  // -------------------------------------------------------------------------
  describe('setDefaultAttached (atomic partial-update)', () => {
    const INSTRUCTION_ONLY = `name: heartbeat
description: Daily check-in skill.
version: 1
`;

    it('flips false -> true and reads back via get(), leaving manifest/body untouched', async () => {
      const db = makeKysely();
      await runSkillsMigration(db);
      const store = createSkillsStore(db);

      await store.upsert({
        id: 'heartbeat',
        description: 'Daily check-in skill.',
        manifestYaml: INSTRUCTION_ONLY,
        bodyMd: '# Heartbeat\n',
        version: 1,
      });

      const r = await store.setDefaultAttached('heartbeat', true);
      expect(r).toEqual({ found: true, defaultAttached: true });

      const detail = await store.get('heartbeat');
      expect(detail!.defaultAttached).toBe(true);
      // manifest + body are exactly what upsert wrote — not re-derived.
      expect(detail!.manifestYaml).toBe(INSTRUCTION_ONLY);
      expect(detail!.bodyMd).toBe('# Heartbeat\n');
    });

    it('flips true -> false', async () => {
      const db = makeKysely();
      await runSkillsMigration(db);
      const store = createSkillsStore(db);
      await store.upsert({
        id: 'heartbeat',
        description: 'd',
        manifestYaml: INSTRUCTION_ONLY,
        bodyMd: '# h\n',
        version: 1,
        defaultAttached: true,
      });

      const r = await store.setDefaultAttached('heartbeat', false);
      expect(r).toEqual({ found: true, defaultAttached: false });
      expect((await store.get('heartbeat'))!.defaultAttached).toBe(false);
    });

    it('returns { found: false } for an unknown id and creates no row', async () => {
      const db = makeKysely();
      await runSkillsMigration(db);
      const store = createSkillsStore(db);

      const r = await store.setDefaultAttached('nope', true);
      expect(r).toEqual({ found: false, defaultAttached: true });
      expect(await store.get('nope')).toBeNull();
    });

    it('rejects flip to true on a credentialed manifest (I-S2) and does NOT mutate the row', async () => {
      const db = makeKysely();
      await runSkillsMigration(db);
      const store = createSkillsStore(db);
      await store.upsert({
        id: 'github',
        description: 'd',
        manifestYaml: SAMPLE_MANIFEST, // declares GITHUB_TOKEN
        bodyMd: SAMPLE_BODY,
        version: 1,
      });

      await expect(store.setDefaultAttached('github', true)).rejects.toThrow(
        /default-attached-requires-no-credentials/,
      );
      // Untouched.
      expect((await store.get('github'))!.defaultAttached).toBe(false);
    });

    it('writes ONLY the flag + updated_at — manifest/body/bundle bytes are identical before & after (race-safe)', async () => {
      const db = makeKysely();
      await runSkillsMigration(db);
      const store = createSkillsStore(db);

      await store.upsert({
        id: 'demo',
        description: 'd',
        manifestYaml: INSTRUCTION_ONLY,
        bodyMd: '# demo\n',
        version: 7,
        files: [{ path: 'scripts/run.py', contents: 'print(1)' }],
      });

      const before = await db
        .selectFrom('skills_v1_skills')
        .select(['manifest_yaml', 'body_md', 'version', 'bundle_tree_sha', 'description'])
        .where('skill_id', '=', 'demo')
        .executeTakeFirstOrThrow();

      await store.setDefaultAttached('demo', true);

      const after = await db
        .selectFrom('skills_v1_skills')
        .select(['manifest_yaml', 'body_md', 'version', 'bundle_tree_sha', 'description', 'default_attached'])
        .where('skill_id', '=', 'demo')
        .executeTakeFirstOrThrow();

      // Everything except the flag is byte-identical — the old get+upsert path
      // would have re-written all of these from a (possibly stale) read.
      expect(after.manifest_yaml).toBe(before.manifest_yaml);
      expect(after.body_md).toBe(before.body_md);
      expect(after.version).toBe(before.version);
      expect(after.bundle_tree_sha).toBe(before.bundle_tree_sha);
      expect(after.description).toBe(before.description);
      expect(after.default_attached).toBe(true);
      // Bundle still round-trips.
      expect((await store.get('demo'))!.files).toEqual([{ path: 'scripts/run.py', contents: 'print(1)' }]);
    });
  });
});
