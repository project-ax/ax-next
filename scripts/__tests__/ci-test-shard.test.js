// The full suite on main runs as four parallel shards (scripts/ci-test-shard.sh).
// Sharding's one way to fail quietly is a package that lands in NO shard — its
// tests stop running on main and nothing says so — or in two, which wastes a
// runner. This pins the partition against the live workspace, and pins that
// ci.yml runs every shard the script defines and no other.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'ci-test-shard.sh');
const SHARDS = ['routines', 'web', 'agents', 'rest'];

function list(shard) {
  return execFileSync('bash', [SCRIPT, '--list', shard], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function workspacePackages() {
  const out = execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const rootName = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).name;
  return JSON.parse(out).map((p) => p.name).filter((n) => n && n !== rootName);
}

describe('ci-test-shard.sh partitions the workspace', () => {
  const byShard = Object.fromEntries(SHARDS.map((s) => [s, list(s)]));
  const all = workspacePackages();

  it('puts every workspace package in exactly one shard', () => {
    const seen = new Map();
    for (const [shard, pkgs] of Object.entries(byShard)) {
      for (const p of pkgs) seen.set(p, [...(seen.get(p) ?? []), shard]);
    }
    const missing = all.filter((p) => !seen.has(p));
    const doubled = [...seen].filter(([, shards]) => shards.length > 1);
    expect(missing).toEqual([]);
    expect(doubled).toEqual([]);
    expect([...seen.keys()].sort()).toEqual([...all].sort());
  });

  it('every named shard resolves all the packages it names (a rename would otherwise empty it)', () => {
    // pnpm treats a filter that matches nothing as "no packages", not an error.
    expect(byShard.routines).toEqual(expect.arrayContaining(['@ax/routines', '@ax/conversations']));
    expect(byShard.web).toEqual(expect.arrayContaining(['@ax/channel-web', '@ax/attachments', '@ax/frame-guard']));
    expect(byShard.agents).toEqual(expect.arrayContaining(['@ax/agents', '@ax/skills', '@ax/connectors']));
    expect(byShard.routines).toHaveLength(2);
    expect(byShard.web).toHaveLength(3);
    expect(byShard.agents).toHaveLength(3);
  });

  it('refuses a shard it does not define', () => {
    expect(() => execFileSync('bash', [SCRIPT, 'nope'], { cwd: REPO_ROOT, stdio: 'pipe' })).toThrow();
  });
});

describe('ci.yml runs exactly the shards the script defines', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('the push matrix lists each shard once', () => {
    const m = workflow.match(/'\[("[a-z]+"(?:,\s*"[a-z]+")*)\]'/g) ?? [];
    const push = m.map((s) => JSON.parse(s.slice(1, -1))).find((arr) => arr.includes('rest'));
    expect(push).toEqual(SHARDS);
  });

  it('the full-suite step runs the shard script, not the unsharded `pnpm test`', () => {
    expect(workflow).toMatch(/run:\s*scripts\/ci-test-shard\.sh\s+"\$\{\{\s*matrix\.shard\s*\}\}"/);
    expect(workflow).not.toMatch(/name: Test \(full suite\)[\s\S]{0,200}?run:\s*pnpm test\s*$/m);
  });
});
