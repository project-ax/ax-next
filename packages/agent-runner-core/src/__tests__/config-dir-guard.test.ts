import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertConfigDirFresh, assertConfigDirOutsideAgentHome } from '../config-dir-guard.js';
import type { RunnerEnv } from '../env.js';

// ---------------------------------------------------------------------------
// TASK-994 (design §11): the SDK loads `$CLAUDE_CONFIG_DIR` as its own trusted
// configuration — settings.json hooks, CLAUDE.md, skills, MCP servers in
// .claude.json. If that directory overlaps the agent's home (`/files`, which
// TASK-995 made required), anything the agent writes there would load as
// trusted config, in this session or the next one.
//
// Every case uses real directories. `t` is deliberately NOT realpath'd: on
// macOS os.tmpdir() sits under /var, a symlink to /private/var, so every case
// there also checks that the guard compares real paths on both sides.
// ---------------------------------------------------------------------------

type GuardEnv = Pick<RunnerEnv, 'claudeConfigDir' | 'transcriptsRoot' | 'userFilesRoot'>;

const OVERLAP = /^refusing to start: CLAUDE_CONFIG_DIR resolves to .+, which overlaps the agent's home /;
const TRANSCRIPTS_OVERLAP = /^refusing to start: AX_TRANSCRIPTS_ROOT resolves to .+, which overlaps the agent's home /;

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

/** The production shape: the agent's home at `<t>/files`. */
function envWith(claudeConfigDir: string, roots: Pick<GuardEnv, 'userFilesRoot'> = { userFilesRoot: home }): GuardEnv {
  return { claudeConfigDir, ...roots };
}

async function mkdirp(...segments: string[]): Promise<string> {
  const dir = path.join(...segments);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('assertConfigDirOutsideAgentHome', () => {
  // The k8s sandbox after TASK-995: home `/files`, runner HOME `/home/runner`
  // (tmpfs) holding CLAUDE_CONFIG_DIR, and the scratch root `/tmp` holding the
  // transcripts root. The scratch root is not the agent's home, so a
  // transcripts root inside it is not an overlap.
  describe('the sandbox layout', () => {
    it('home /files, CLAUDE_CONFIG_DIR under /home/runner, transcripts under /tmp: starts', async () => {
      const pod = {
        userFilesRoot: home,
        ephemeralRoot: await mkdirp(t, 'tmp'),
        transcriptsRoot: path.join(t, 'tmp', 'transcripts'),
        claudeConfigDir: await mkdirp(t, 'home-runner', '.ax', 'session'),
      };
      await expect(assertConfigDirOutsideAgentHome(pod)).resolves.toBeUndefined();
    });

    it('CLAUDE_CONFIG_DIR at /files/.claude: refused', async () => {
      const pod = {
        userFilesRoot: home,
        ephemeralRoot: await mkdirp(t, 'tmp'),
        transcriptsRoot: path.join(t, 'tmp', 'transcripts'),
        claudeConfigDir: await mkdirp(home, '.claude'),
      };
      await expect(assertConfigDirOutsideAgentHome(pod)).rejects.toThrow(OVERLAP);
    });
  });

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
  });

  // The CLI reads `$CLAUDE_CONFIG_DIR/projects` back on resume, and with
  // AX_TRANSCRIPTS_ROOT set that directory is a link into the transcripts root.
  // A transcripts root in the agent's home would be an agent-writable place the
  // CLI loads from.
  describe('AX_TRANSCRIPTS_ROOT', () => {
    let cfg: string;
    beforeEach(async () => {
      cfg = await mkdirp(t, 'runner', '.ax', 'session');
    });

    it('accepts a transcripts root that is unset', async () => {
      await expect(assertConfigDirOutsideAgentHome(envWith(cfg))).resolves.toBeUndefined();
    });

    it('accepts a sibling of the home (the production shape, not created yet)', async () => {
      await expect(
        assertConfigDirOutsideAgentHome({ ...envWith(cfg), transcriptsRoot: path.join(t, 'tmp', 'transcripts') }),
      ).resolves.toBeUndefined();
    });

    it('refuses one inside the home', async () => {
      await expect(
        assertConfigDirOutsideAgentHome({ ...envWith(cfg), transcriptsRoot: path.join(home, 'transcripts') }),
      ).rejects.toThrow(TRANSCRIPTS_OVERLAP);
    });

    it('refuses one containing the home', async () => {
      await expect(
        assertConfigDirOutsideAgentHome({ ...envWith(cfg), transcriptsRoot: t }),
      ).rejects.toThrow(TRANSCRIPTS_OVERLAP);
    });

    it('refuses one that reaches the home through a symlink', async () => {
      const link = path.join(t, 'tmp-link');
      await fs.symlink(home, link);
      await expect(
        assertConfigDirOutsideAgentHome({ ...envWith(cfg), transcriptsRoot: path.join(link, 'transcripts') }),
      ).rejects.toThrow(TRANSCRIPTS_OVERLAP);
    });
  });

  // `path.resolve` collapses `link/..` by spelling, but the kernel follows
  // `link` first and then steps up from where it lands. So a `..` segment can
  // put a path somewhere a lexical reading would never guess. Every guarded
  // path is refused outright when it carries one; no sandbox builds one.
  describe("refuses a guarded path with a '..' segment", () => {
    let cfg: string;
    beforeEach(async () => {
      cfg = await mkdirp(t, 'runner', '.ax', 'session');
    });

    it('a transcripts root whose `..` steps out of a symlink into the home', async () => {
      // `<t>/tmp/link -> <t>/files/sub`, so `<t>/tmp/link/../transcripts` is
      // really `<t>/files/transcripts`, though it reads as `<t>/tmp/transcripts`.
      await mkdirp(t, 'tmp');
      await fs.symlink(await mkdirp(home, 'sub'), path.join(t, 'tmp', 'link'));
      await expect(
        assertConfigDirOutsideAgentHome({ ...envWith(cfg), transcriptsRoot: `${t}/tmp/link/../transcripts` }),
      ).rejects.toThrow(/^refusing to start: AX_TRANSCRIPTS_ROOT \(.+\) contains a '\.\.' segment/);
    });

    it('a home whose `..` steps out of a symlink to above the config dir', async () => {
      // `<t>/tmp/link3 -> <cfg>`, so `<t>/tmp/link3/..` is really `<t>/runner/.ax`,
      // which contains the config dir, though it reads as `<t>/tmp`.
      await mkdirp(t, 'tmp');
      await fs.symlink(cfg, path.join(t, 'tmp', 'link3'));
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: `${t}/tmp/link3/..` })),
      ).rejects.toThrow(/^refusing to start: the agent's home \(.+\) contains a '\.\.' segment/);
    });

    it('a config dir, even one that resolves somewhere harmless', async () => {
      await mkdirp(t, 'runner', 'x');
      await expect(
        assertConfigDirOutsideAgentHome(envWith(`${t}/runner/x/../.ax/session`)),
      ).rejects.toThrow(/^refusing to start: CLAUDE_CONFIG_DIR \(.+\) contains a '\.\.' segment/);
    });

    it('accepts a name that merely starts with dots (`..cache`)', async () => {
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: path.join(t, '..cache') })),
      ).resolves.toBeUndefined();
    });
  });

  it('refuses a config dir that does not exist, naming the errno', async () => {
    await expect(assertConfigDirOutsideAgentHome(envWith(path.join(t, 'nope')))).rejects.toThrow(
      /^refusing to start: CLAUDE_CONFIG_DIR \(.+\) does not exist or cannot be resolved \(ENOENT\)/,
    );
  });

  // Only a missing path (ENOENT) may fall back to its parent. Any other
  // resolution error means the guard cannot know where the path really lands,
  // so it refuses rather than comparing a guess.
  describe('refuses a home or transcripts root it cannot resolve', () => {
    let cfg: string;
    beforeEach(async () => {
      cfg = await mkdirp(t, 'runner', '.ax', 'session');
    });

    it('a home that is a symlink loop (ELOOP)', async () => {
      const loop = path.join(t, 'loop');
      await fs.symlink(loop, loop);
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: loop })),
      ).rejects.toThrow(/^refusing to start: the agent's home \(.+\) cannot be resolved: .+ gave ELOOP/);
    });

    it('a home under a regular file (ENOTDIR)', async () => {
      const file = path.join(t, 'plain-file');
      await fs.writeFile(file, '');
      await expect(
        assertConfigDirOutsideAgentHome(envWith(cfg, { userFilesRoot: path.join(file, 'home') })),
      ).rejects.toThrow(/^refusing to start: the agent's home \(.+\) cannot be resolved: .+ gave ENOTDIR/);
    });

    it('a transcripts root under a regular file (ENOTDIR)', async () => {
      const file = path.join(t, 'plain-file');
      await fs.writeFile(file, '');
      await expect(
        assertConfigDirOutsideAgentHome({ ...envWith(cfg), transcriptsRoot: path.join(file, 'transcripts') }),
      ).rejects.toThrow(/^refusing to start: AX_TRANSCRIPTS_ROOT \(.+\) cannot be resolved: .+ gave ENOTDIR/);
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-1217: the config dir must also be FRESH. The agent's shell runs as the
// same user as the CLI, so it can write there too, and a new CLI started on a
// dir an earlier session wrote runs that session's settings.json hooks and env
// (measured on CLI 2.1.119). Every sandbox gives each session a new dir that
// holds nothing but skills/, so anything else is refused. The guard only
// reads: a refused dir keeps every entry it had.
// ---------------------------------------------------------------------------
describe('assertConfigDirFresh (TASK-1217)', () => {
  const NOT_FRESH = /^refusing to start: CLAUDE_CONFIG_DIR \(.+\) is not fresh: it already holds /;

  let cfg: string;

  beforeEach(async () => {
    // Its own temp dir, real-pathed so a refusal names it exactly as given.
    cfg = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ax-cfg-fresh-')));
  });

  afterEach(async () => {
    await fs.rm(cfg, { recursive: true, force: true });
  });

  /** A skill folder in the projection, the way both sandboxes lay it down. */
  async function writeSkill(id: string): Promise<void> {
    await fs.mkdir(path.join(cfg, 'skills', id), { recursive: true });
    await fs.writeFile(
      path.join(cfg, 'skills', id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: Write the weekly report.\n---\nWrite it.\n`,
    );
  }

  /** The refusal's message. Fails the test if the guard accepted the dir. */
  async function refusal(): Promise<string> {
    const err: unknown = await assertConfigDirFresh({ claudeConfigDir: cfg }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err, 'expected the guard to refuse the dir').toBeInstanceOf(Error);
    return (err as Error).message;
  }

  it('accepts an empty dir (the k8s shape: the materializer fills skills/ later)', async () => {
    await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).resolves.toBeUndefined();
  });

  it('accepts a dir holding only skills/ with a skill inside (the subprocess shape)', async () => {
    await writeSkill('weekly-report');
    await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).resolves.toBeUndefined();
  });

  it('accepts a skills/ the sandbox locked read-only (0555)', async () => {
    await writeSkill('weekly-report');
    const locked = [path.join(cfg, 'skills', 'weekly-report'), path.join(cfg, 'skills')];
    try {
      for (const dir of locked) await fs.chmod(dir, 0o555);
      await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).resolves.toBeUndefined();
    } finally {
      for (const dir of locked) await fs.chmod(dir, 0o755);
    }
  });

  // What an earlier session leaves (M10: `.claude.json`, `projects/`, ...) and
  // what an agent's shell could plant. Each sits next to a real skills/, which
  // is never counted. The listing in brackets is checked exactly, because the
  // message's fixed text names settings.json, CLAUDE.md and .claude.json too.
  it.each<[string, string, () => Promise<unknown>]>([
    ['settings.json', 'settings.json', () => fs.writeFile(path.join(cfg, 'settings.json'), '{"hooks":{}}')],
    ['CLAUDE.md', 'CLAUDE.md', () => fs.writeFile(path.join(cfg, 'CLAUDE.md'), 'Planted.\n')],
    ['.claude.json', '.claude.json', () => fs.writeFile(path.join(cfg, '.claude.json'), '{"mcpServers":{}}')],
    ['a projects/ directory', 'projects', () => fs.mkdir(path.join(cfg, 'projects'))],
    [
      'a projects symlink to another directory',
      'projects',
      async () => fs.symlink(await mkdirp(t, 'elsewhere'), path.join(cfg, 'projects')),
    ],
  ])('refuses a dir that already holds %s', async (_label, name, plant) => {
    await writeSkill('weekly-report');
    await plant();
    const message = await refusal();
    expect(message).toMatch(/^refusing to start: CLAUDE_CONFIG_DIR/);
    expect(message).toMatch(NOT_FRESH);
    expect(message).toContain(`CLAUDE_CONFIG_DIR (${cfg})`);
    expect(message).toContain(`1 unexpected entry (${name})`);
  });

  // lstat, not the Dirent: a symlink is not a plain directory, and a symlink
  // into the agent's home would make every skill the agent writes there one
  // the CLI loads.
  it.each<[string, () => Promise<unknown>]>([
    ['a symlink into the agent home', async () => fs.symlink(await mkdirp(home, 'skills'), path.join(cfg, 'skills'))],
    ['a regular file', () => fs.writeFile(path.join(cfg, 'skills'), 'not a directory')],
  ])('refuses a skills entry that is %s', async (_label, plant) => {
    await plant();
    const message = await refusal();
    expect(message).toMatch(NOT_FRESH);
    expect(message).toMatch(/skills \(not a plain directory\)/);
    expect(message).toContain('1 unexpected entry (skills (not a plain directory))');
  });

  it('names at most 8 entries, sorted, and counts the rest', async () => {
    // Written out of order, so the order in the message is the guard's own.
    for (const i of [9, 3, 0, 7, 1, 8, 2, 6, 4, 5]) {
      await fs.writeFile(path.join(cfg, `leftover-${i}`), '');
    }
    expect(await refusal()).toContain(
      '10 unexpected entries (leftover-0, leftover-1, leftover-2, leftover-3, ' +
        'leftover-4, leftover-5, leftover-6, leftover-7, and 2 more)',
    );
  });

  // Entry names come from whoever wrote the dir. A newline in one would put a
  // line of the writer's choosing into the runner's log, so a name outside
  // the showable set is counted and never printed.
  it('counts an entry whose name has a newline, and never prints it', async () => {
    await fs.writeFile(path.join(cfg, 'evil\nrunner: ok'), '');
    const message = await refusal();
    expect(message).toMatch(NOT_FRESH);
    expect(message).toContain('1 unexpected entry (name not shown)');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('runner: ok');
  });

  it('counts an unshowable name with the rest when other names are shown', async () => {
    await fs.writeFile(path.join(cfg, 'settings.json'), '{}');
    await fs.writeFile(path.join(cfg, 'notes from the agent.md'), '');
    const message = await refusal();
    expect(message).toContain('2 unexpected entries (settings.json, and 1 more)');
    expect(message).not.toContain('notes from the agent');
  });

  it('only reads: a refused dir keeps every entry, and a linked directory keeps its files', async () => {
    const elsewhere = await mkdirp(t, 'elsewhere');
    await fs.writeFile(path.join(elsewhere, 'transcript.jsonl'), '{}\n');
    await writeSkill('weekly-report');
    await fs.writeFile(path.join(cfg, 'settings.json'), '{"hooks":{}}');
    await fs.writeFile(path.join(cfg, 'CLAUDE.md'), 'Planted.\n');
    await fs.writeFile(path.join(cfg, '.claude.json'), '{}');
    await fs.symlink(elsewhere, path.join(cfg, 'projects'));
    const before = (await fs.readdir(cfg)).sort();

    await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).rejects.toThrow(NOT_FRESH);

    expect((await fs.readdir(cfg)).sort()).toEqual(before);
    expect(await fs.readFile(path.join(cfg, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    expect((await fs.lstat(path.join(cfg, 'projects'))).isSymbolicLink()).toBe(true);
    expect(await fs.readdir(elsewhere)).toEqual(['transcript.jsonl']);
    expect(await fs.readdir(path.join(cfg, 'skills'))).toEqual(['weekly-report']);
  });

  it('refuses a dir it cannot list, naming the errno', async () => {
    await expect(assertConfigDirFresh({ claudeConfigDir: path.join(cfg, 'nope') })).rejects.toThrow(
      /^refusing to start: CLAUDE_CONFIG_DIR \(.+\) cannot be listed \(ENOENT\), so it cannot be checked for leftovers\.$/,
    );
  });

  // Listable but not searchable (r--): readdir works, lstat of an entry does
  // not. A skills/ the guard cannot inspect is not one it can accept. Root
  // ignores the mode bits, so the case cannot be set up as root.
  it.skipIf(process.getuid?.() === 0)('refuses when it cannot inspect the skills entry (fails closed)', async () => {
    await writeSkill('weekly-report');
    await fs.chmod(cfg, 0o444);
    try {
      await expect(assertConfigDirFresh({ claudeConfigDir: cfg })).rejects.toThrow(
        /^refusing to start: CLAUDE_CONFIG_DIR \(.+\) cannot be listed \(EACCES\)/,
      );
    } finally {
      await fs.chmod(cfg, 0o755);
    }
  });
});
