// Guard: the docs agents copy shell from must not use a zsh-special variable name.
//
// Why this exists (TASK-1032). CLAUDE.md's memory recipe was
//
//     path=$(scripts/memory-write-target.sh --shard decisions TASK-415)
//     mkdir -p "$(dirname "$path")"
//
// The Bash tool runs zsh on this machine, and in zsh the lowercase `path` is an
// array TIED to `PATH`. Assigning a string to it replaces the whole command search
// path, so the very next command dies with "command not found: dirname", and so does
// everything after it in that call. The recipe had been copied into the claude-memory
// and yolo-ship skills and two plans. scripts/memory-append-check.sh's R2 fix-it
// message still prints it. That script is pinned by a blob-sha mutation row in
// .claude/memory/decisions/2026-09-19-TASK-415.md, which only a human
// `Memory-Rewrite` pass may update, so it is fixed separately.
// Agents wrote the trap down in memory four times (TASK-696, TASK-816, TASK-951,
// TASK-1028) before anyone fixed the source. bash does not tie `path`, so the snippet
// looked fine to anyone reading it with bash in mind.
//
// What the scan flags, on each line:
//   - an assignment to a zsh-special name: at line start or after `;` `&` `|` `(`,
//     optionally behind export/local/typeset/declare/readonly and their flags, and
//     including `name[i]=` and `name+=`;
//   - `for <name> in`, in the same command positions;
//   - a reference `$path` / `${path}` (or another tied name). A doc can't write
//     `"$(dirname "$path")"` without implying the variable is called `path`. That
//     prose half of the bug is exactly how it lived on in the yolo-ship skill.
// `status` is included for assignments and loops: zsh makes it read-only, so
// `status=$(…)` fails too. Reading `$status` is fine, so references to it aren't flagged.
//
// What it does NOT flag: `read … path` (prose like "read the path" would trip it) and
// prose that quotes the broken form mid-sentence inside backticks.
//
// Scope: CLAUDE.md (and AGENTS.md, asserted to be a symlink to it), every markdown
// file under .claude/skills/ and .claude/agents/, and the deploy/ and docs/runbooks/
// markdown that people run shell from. Out of scope: historical plans and memory rows.
// Plans contain JSX `path=` props, and memory rows quote the broken form to describe
// the bug (and may not be edited anyway).
//
// Lives in scripts/__tests__/, which CI's `pnpm test:scripts` runs unconditionally,
// in the job that apt-installs zsh.

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// zsh's lowercase special arrays tied to a colon-separated scalar (`path`/PATH,
// `fpath`/FPATH, …), plus `psvar`. Assigning a string to any of them clobbers shell
// state instead of making a plain variable.
const ZSH_TIED = ['path', 'fpath', 'cdpath', 'manpath', 'module_path', 'mailpath', 'psvar'];
// Read-only in zsh: assigning fails, reading is fine.
const ZSH_READONLY = ['status'];

const SET_NAMES = [...ZSH_TIED, ...ZSH_READONLY].join('|');
const CMD_START = String.raw`(?:^|[;&|(])\s*`;
const DECL = String.raw`(?:(?:export|local|typeset|declare|readonly)(?:\s+-[A-Za-z]+)*\s+)?`;

const PATTERNS = [
  {
    kind: 'assign',
    re: new RegExp(CMD_START + DECL + String.raw`(${SET_NAMES})(?:\[[^\]]*\])?\+?=`),
  },
  { kind: 'loop', re: new RegExp(CMD_START + String.raw`for\s+(${SET_NAMES})\s+in\b`) },
  {
    kind: 'ref',
    re: new RegExp(
      String.raw`\$(?:(${ZSH_TIED.join('|')})(?![A-Za-z0-9_])|\{(${ZSH_TIED.join('|')})\})`,
    ),
  },
];

/** Lines that use a zsh-special name as a variable, with 1-based line numbers. */
function findZshNameHazards(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { kind, re } of PATTERNS) {
      const m = lines[i].match(re);
      if (m) hits.push({ line: i + 1, kind, name: m[1] ?? m[2], text: lines[i].trim() });
    }
  }
  return hits;
}

function scannedDocs() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '.claude/skills', '.claude/agents', 'deploy', 'docs/runbooks'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  return ['CLAUDE.md', ...out.split('\0').filter((f) => f.endsWith('.md'))];
}

function zshExists() {
  try {
    execFileSync('zsh', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('instruction docs: no zsh-special variable names', () => {
  const docs = scannedDocs();

  it('finds docs to scan (the scan must not be vacuous)', () => {
    expect(docs).toContain('CLAUDE.md');
    expect(docs).toContain('.claude/skills/claude-memory/SKILL.md');
    expect(docs).toContain('.claude/skills/yolo-ship/SKILL.md');
    expect(docs).toContain('.claude/agents/ax-planner.md');
    expect(docs).toContain('deploy/GKE.md');
  });

  it('AGENTS.md is a symlink to CLAUDE.md, so scanning CLAUDE.md covers it', () => {
    const agents = join(REPO_ROOT, 'AGENTS.md');
    expect(lstatSync(agents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agents)).toBe('CLAUDE.md');
  });

  it('never assigns, loops over, or references a zsh-tied or read-only name', () => {
    const offenders = [];
    for (const rel of docs) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const hit of findZshNameHazards(text)) {
        offenders.push(`${rel}:${hit.line} (${hit.kind} ${hit.name}): ${hit.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the memory recipe in CLAUDE.md and the claude-memory skill uses `target`', () => {
    for (const rel of ['CLAUDE.md', '.claude/skills/claude-memory/SKILL.md']) {
      const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      expect(text, rel).toMatch(
        /^\s*target=\$\(scripts\/memory-write-target\.sh --shard decisions TASK-415\)\n\s*mkdir -p "\$\(dirname "\$target"\)"/m,
      );
    }
  });
});

describe('findZshNameHazards', () => {
  const kinds = (text) => findZshNameHazards(text).map((h) => `${h.kind}:${h.name}`);

  it('flags the original recipe: the assignment and the reference', () => {
    expect(kinds('path=$(scripts/memory-write-target.sh --shard x Y)')).toEqual(['assign:path']);
    expect(kinds('  mkdir -p "$(dirname "$path")"')).toEqual(['ref:path']);
  });

  it('flags the prose form that lived on in the yolo-ship skill', () => {
    expect(kinds('creates nothing, so `mkdir -p "$(dirname "$path")"` first.')).toEqual([
      'ref:path',
    ]);
    expect(kinds('echo "${path}"')).toEqual(['ref:path']);
  });

  it('flags mid-line, declared, indexed and appending assignments', () => {
    expect(kinds('cmd && path=$(x)')).toEqual(['assign:path']);
    expect(kinds('a; fpath=/x')).toEqual(['assign:fpath']);
    expect(kinds('export fpath=/x')).toEqual(['assign:fpath']);
    expect(kinds('typeset -g path=/a')).toEqual(['assign:path']);
    expect(kinds('local -a cdpath=/x')).toEqual(['assign:cdpath']);
    expect(kinds('readonly manpath=/x')).toEqual(['assign:manpath']);
    expect(kinds('path[1]=/x')).toEqual(['assign:path']);
    expect(kinds('path+=/x')).toEqual(['assign:path']);
  });

  it('flags `for <name> in` and `status=`', () => {
    expect(kinds('for path in a b; do :; done')).toEqual(['loop:path']);
    expect(kinds('status=$(curl -s x)')).toEqual(['assign:status']);
  });

  it('does not flag safe names, uppercase PATH, reading $status, or quoted prose', () => {
    expect(kinds('target=$(scripts/memory-write-target.sh)')).toEqual([]);
    expect(kinds('filepath=/x; path_to=/y; $filepath $path_to')).toEqual([]);
    expect(kinds('PATH="/opt/bin:$PATH" cmd')).toEqual([]);
    expect(kinds('echo "$status"')).toEqual([]);
    expect(kinds('Never run `path=$(…)` under zsh.')).toEqual([]);
    expect(kinds('look for path in the config')).toEqual([]);
  });

  it('reports the line number', () => {
    expect(findZshNameHazards('a\nb\npath=x')[0]).toMatchObject({ line: 3, name: 'path' });
  });
});

describe('the zsh mechanism (why these names are banned)', () => {
  const run = (script) => {
    try {
      return {
        rc: 0,
        out: execFileSync('zsh', ['-f', '-c', script], { encoding: 'utf8', stdio: 'pipe' }),
      };
    } catch (err) {
      return { rc: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };

  // The skips below are silent, so make sure CI really has zsh (ci.yml installs it).
  it.runIf(process.env.CI)('zsh is installed on CI', () => {
    expect(zshExists()).toBe(true);
  });

  it.skipIf(!zshExists())('assigning `path` wipes the command search path', () => {
    const r = run('path=$(echo /tmp/x/y.md); dirname "$path"');
    expect(r.rc).toBe(127);
    expect(r.out).toMatch(/command not found: dirname/);
  });

  it.skipIf(!zshExists())('so does a `for path in` loop', () => {
    const r = run('for path in /tmp/x/y.md; do :; done; dirname /tmp/x/y.md');
    expect(r.rc).toBe(127);
    expect(r.out).toMatch(/command not found: dirname/);
  });

  it.skipIf(!zshExists())('assigning `status` fails: it is read-only', () => {
    const r = run('status=$(echo x); echo unreachable');
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/read-only variable: status/);
  });

  it.skipIf(!zshExists())('the `target` form the docs now use works', () => {
    const r = run('target=$(echo /tmp/x/y.md); dirname "$target"');
    expect(r).toEqual({ rc: 0, out: '/tmp/x\n' });
  });
});
