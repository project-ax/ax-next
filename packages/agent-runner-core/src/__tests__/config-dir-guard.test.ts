import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertConfigDirOutsideAgentHome } from '../config-dir-guard.js';
import type { RunnerEnv } from '../env.js';

// ---------------------------------------------------------------------------
// TASK-994 (design §11): the SDK loads `$CLAUDE_CONFIG_DIR` as its own trusted
// configuration — settings.json hooks, CLAUDE.md, skills, MCP servers in
// .claude.json. If that directory overlaps the agent's home (the durable
// `/files`, or scratch when no durable mount is wired), anything the agent
// writes there would load as trusted config, in this session or the next one.
//
// Every case uses real directories. `t` is deliberately NOT realpath'd: on
// macOS os.tmpdir() sits under /var, a symlink to /private/var, so every case
// there also checks that the guard compares real paths on both sides.
// ---------------------------------------------------------------------------

type GuardEnv = Pick<RunnerEnv, 'claudeConfigDir' | 'userFilesRoot' | 'ephemeralRoot' | 'workspaceRoot'>;

const OVERLAP = /^refusing to start: CLAUDE_CONFIG_DIR resolves to .+, which overlaps the agent's home /;

let t: string;
let home: string;

beforeEach(async () => {
  t = await fs.mkdtemp(path.join(os.tmpdir(), 'ax-cfg-guard-'));
  home = path.join(t, 'files');
  await fs.mkdir(home);
});

afterEach(async () => {
  await fs.rm(t, { recursive: true, force: true });
});

/** The production shape: a durable home at `<t>/files`, agent state at `<t>/agent`. */
function envWith(claudeConfigDir: string, roots: Partial<GuardEnv> = { userFilesRoot: home }): GuardEnv {
  return { workspaceRoot: path.join(t, 'agent'), claudeConfigDir, ...roots };
}

async function mkdirp(...segments: string[]): Promise<string> {
  const dir = path.join(...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('assertConfigDirOutsideAgentHome', () => {
  describe('accepts a runner-private config dir', () => {
    it('a sibling of the home (the production shape)', async () => {
      const cfg = await mkdirp(t, 'runner', '.ax', 'session');
      await expect(assertConfigDirOutsideAgentHome(envWith(cfg))).resolves.toBeUndefined();
    });

    it('with a trailing slash', async () => {
      const cfg = await mkdirp(t, 'runner', '.ax', 'session');
      await expect(assertConfigDirOutsideAgentHome(envWith(`${cfg}/`))).resolves.toBeUndefined();
    });

    it('a sibling that shares the home name as a prefix (`files-cfg` next to `files`)', async () => {
      const cfg = await mkdirp(t, 'files-cfg');
      await expect(assertConfigDirOutsideAgentHome(envWith(cfg))).resolves.toBeUndefined();
    });

    it('when the home does not exist yet (a missing root cannot contain an existing dir)', async () => {
      const cfg = await mkdirp(t, 'runner');
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: path.join(t, 'not-yet') })),
      ).resolves.toBeUndefined();
    });
  });

  describe('refuses a config dir that overlaps the agent home', () => {
    it('inside the home', async () => {
      const cfg = await mkdirp(home, '.claude');
      await expect(assertConfigDirOutsideAgentHome(envWith(cfg))).rejects.toThrow(OVERLAP);
    });

    it('equal to the home', async () => {
      await expect(assertConfigDirOutsideAgentHome(envWith(home))).rejects.toThrow(OVERLAP);
    });

    it('containing the home', async () => {
      const cfg = await mkdirp(t, 'a');
      const nestedHome = await mkdirp(cfg, 'files');
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: nestedHome })),
      ).rejects.toThrow(OVERLAP);
    });

    it('a symlink into the home', async () => {
      const target = await mkdirp(home, '.claude');
      const link = path.join(t, 'cfg-link');
      await fs.symlink(target, link);
      await expect(assertConfigDirOutsideAgentHome(envWith(link))).rejects.toThrow(OVERLAP);
    });

    it('under a parent that is a symlink into the home', async () => {
      await mkdirp(home, '.ax', 'session');
      await fs.symlink(home, path.join(t, 'runner'));
      const cfg = path.join(t, 'runner', '.ax', 'session');
      await expect(assertConfigDirOutsideAgentHome(envWith(cfg))).rejects.toThrow(OVERLAP);
    });

    it('when the home itself is a symlink', async () => {
      const real = await mkdirp(t, 'real');
      const homeLink = path.join(t, 'home-link');
      await fs.symlink(real, homeLink);
      const cfg = await mkdirp(real, '.claude');
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: homeLink })),
      ).rejects.toThrow(OVERLAP);
    });

    it('when a home that does not exist yet would land inside it, through a symlinked path', async () => {
      // `<t>/alias -> <t>/runner`, so the not-yet-created home `<t>/alias/skills`
      // is really `<t>/runner/skills`: the SDK's own skills directory. A
      // lexical check on the missing path cannot see that.
      const cfg = await mkdirp(t, 'runner');
      await fs.symlink(cfg, path.join(t, 'alias'));
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: path.join(t, 'alias', 'skills') })),
      ).rejects.toThrow(OVERLAP);
    });

    it('when there is no durable home and session scratch is the home', async () => {
      // runnerHomeDir falls back to the scratch tier, which becomes cwd/HOME.
      const scratch = await mkdirp(t, 'scratch');
      const cfg = await mkdirp(scratch, '.ax');
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { ephemeralRoot: scratch })),
      ).rejects.toThrow(OVERLAP);
    });
  });

  it('refuses a config dir that does not exist', async () => {
    await expect(assertConfigDirOutsideAgentHome(envWith(path.join(t, 'nope')))).rejects.toThrow(
      /^refusing to start: CLAUDE_CONFIG_DIR \(.+\) does not exist/,
    );
  });
});
