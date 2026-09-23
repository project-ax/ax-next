import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(REPO_ROOT, '.claude/skills/auto-ship/references/github-project.md');
const HELPER = join(REPO_ROOT, 'scripts/auto-ship-poller-roots.mjs');
const FIXTURES = mkdtempSync(join(tmpdir(), 'autoship-poller-verification-'));

function verifier(md) {
  const start = md.indexOf('\n## 5. ');
  const end = md.indexOf('\n## 6. ', start + 1);
  if (start < 0 || end < 0) throw new Error('poller section missing');
  const section = md.slice(start, end);
  const blocks = [...section.matchAll(/^```bash\n(# ax-poller: verify\n[\s\S]*?)\n```/gm)];
  if (blocks.length > 1) throw new Error('multiple poller verifiers');
  if (blocks.length === 1) return blocks[0][1];
  const legacy = /Verify with\s*(?:>\s*)?`(pgrep -fl auto-ship-board-poll\.sh)`/.exec(section);
  if (legacy) return legacy[1];
  throw new Error('no executable poller verifier');
}

function hasBin(name) {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SHELLS = ['bash', ...(hasBin('zsh') ? ['zsh'] : [])];
const SCRIPT = verifier(readFileSync(DOC, 'utf8'));
const COMMAND = 'bash /repo/.claude/auto-ship-board-poll.sh';
const INIT = { pid: 1, ppid: 0, command: '/sbin/init' };
const ATTACHED = { pid: 42, ppid: 1, command: 'node tool-supervisor' };
const row = (pid, ppid, command = COMMAND) => ({ pid, ppid, command });

function runVerifier(shell, fixture, options = {}) {
  const root = realpathSync(mkdtempSync(join(FIXTURES, 'repo with spaces-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'scripts'));
  if (existsSync(HELPER)) {
    writeFileSync(join(root, 'scripts/auto-ship-poller-roots.mjs'), readFileSync(HELPER));
  }
  const rows = typeof fixture === 'function' ? fixture(root) : fixture;
  writeFileSync(join(bin, 'ps'), `#!/usr/bin/env node
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-A', '-ww', '-o', 'pid=,ppid=,args='])) process.exit(64);
if (process.env.AX_PS_FAILURE === '1') { process.stderr.write('ps unavailable\\n'); process.exit(23); }
if (process.env.AX_RAW_SNAPSHOT !== undefined) process.stdout.write(process.env.AX_RAW_SNAPSHOT);
else process.stdout.write(JSON.parse(process.env.AX_PROCESS_ROWS).map((r) => r.pid + ' ' + r.ppid + ' ' + r.command).join('\\n') + '\\n');
`, { mode: 0o755 });
  writeFileSync(join(bin, 'pgrep'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(['-fl', 'auto-ship-board-poll.sh'])) process.exit(64);
const rows = JSON.parse(process.env.AX_PROCESS_ROWS).filter((r) => new RegExp(args[1]).test(r.command));
if (rows.length) process.stdout.write(rows.map((r) => r.pid + ' ' + r.command).join('\\n') + '\\n');
process.exitCode = rows.length ? 0 : 1;
`, { mode: 0o755 });
  const result = spawnSync(shell, ['-c', SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      AX_PROCESS_ROWS: JSON.stringify(rows),
      AX_PS_FAILURE: options.psFailure ? '1' : '0',
      ...(options.rawSnapshot !== undefined ? { AX_RAW_SNAPSHOT: options.rawSnapshot } : {}),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

function roots(result) {
  expect(result.err).toBe('');
  expect(result.out === '' ? [0, 1] : [0]).toContain(result.code);
  return result.out === '' ? [] : result.out.split('\n').map((line) => {
    expect(line).toMatch(/^\d+(?:\s.*)?$/);
    return Number(line.split(/\s/)[0]);
  }).sort((a, b) => a - b);
}

function unknown(result) {
  expect(result.code).toBe(2);
  expect(result.out).toBe('');
  expect(result.err).toBe('Cannot verify poller roots; process count is unknown.');
}

afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));

describe('documented poller verification', () => {
  it('harness: extracts a runnable verifier instead of testing prose', () => {
    expect(SCRIPT.trim()).not.toBe('');
  });

  it('harness: states its shell coverage', () => {
    expect(SHELLS).toContain('bash');
    expect(SHELLS).toEqual(hasBin('zsh') ? ['bash', 'zsh'] : ['bash']);
  });

  for (const shell of SHELLS) {
    it(`${shell}: compatibility: reports no roots when no poller is present`, () => {
      expect(roots(runVerifier(shell, [INIT, ATTACHED]))).toEqual([]);
    });

    it(`${shell}: compatibility: counts an attached poller whose parent is not PID 1`, () => {
      expect(roots(runVerifier(shell, [INIT, ATTACHED, row(100, 42)]))).toEqual([100]);
    });

    it(`${shell}: ignores matching command-substitution descendants`, () => {
      expect(roots(runVerifier(shell, [INIT, ATTACHED, row(100, 42), row(110, 100), row(120, 110)]))).toEqual([100]);
    });

    it(`${shell}: compatibility: preserves two independent launch roots`, () => {
      expect(roots(runVerifier(shell, [INIT, ATTACHED, row(100, 1), row(200, 42)]))).toEqual([100, 200]);
    });

    it(`${shell}: counts two roots under one non-poller wrapper, not their children`, () => {
      const wrapper = row(90, 1, 'bash -c bash /repo/.claude/auto-ship-board-poll.sh');
      expect(roots(runVerifier(shell, [INIT, wrapper, row(100, 90), row(101, 100), row(200, 90), row(201, 200)]))).toEqual([100, 200]);
    });

    it(`${shell}: ignores name mentions and similarly named scripts`, () => {
      expect(roots(runVerifier(shell, [
        INIT,
        row(50, 1, 'node report.js auto-ship-board-poll.sh'),
        row(60, 1, 'bash /repo/auto-ship-board-poll.sh.backup'),
        row(100, 1),
      ]))).toEqual([100]);
    });

    it(`${shell}: compatibility: accepts this canonical checkout path containing spaces`, () => {
      expect(roots(runVerifier(shell, (root) => [INIT, row(100, 1, `bash ${root}/.claude/auto-ship-board-poll.sh`)]))).toEqual([100]);
    });

    it(`${shell}: a failed process probe is unknown, not zero`, () => {
      unknown(runVerifier(shell, [INIT, row(100, 1)], { psFailure: true }));
    });

    it(`${shell}: an empty process snapshot is unknown, not zero`, () => {
      unknown(runVerifier(shell, [INIT, row(100, 1)], { rawSnapshot: '' }));
    });

    it(`${shell}: malformed process data is unknown, not zero`, () => {
      unknown(runVerifier(shell, [INIT, row(100, 1)], { rawSnapshot: 'not a process row\n' }));
    });

    it(`${shell}: cyclic ancestry is unknown, not zero`, () => {
      unknown(runVerifier(shell, [INIT, row(100, 101), row(101, 100)]));
    });

    it(`${shell}: duplicate process identities are unknown, not zero`, () => {
      unknown(runVerifier(shell, [INIT, row(100, 1), row(100, 42)]));
    });

    it(`${shell}: unsupported flagged launches are unknown, not zero`, () => {
      unknown(runVerifier(shell, [INIT, row(100, 1, 'bash -x /repo/.claude/auto-ship-board-poll.sh')]));
    });

    it(`${shell}: an ambiguous other checkout path is unknown, not zero`, () => {
      unknown(runVerifier(shell, [INIT, row(100, 1, 'bash /other checkout with spaces/.claude/auto-ship-board-poll.sh')]));
    });

    for (const [label, rows] of [
      ['alone', [INIT, row(100, 1, 'bash -x auto-ship-board-poll.sh')]],
      ['beside a recognized root', [INIT, row(100, 1), row(200, 1, 'bash -x auto-ship-board-poll.sh')]],
    ]) {
      it(`${shell}: flagged bare filename ${label} is unknown, not zero`, () => {
        unknown(runVerifier(shell, rows));
      });
    }

    it(`${shell}: a PID-zero row with nonzero parent is unknown, not a root`, () => {
      unknown(runVerifier(shell, [row(0, 100, 'kernel_task'), row(100, 0)]));
    });

    it(`${shell}: compatibility: accepts a kernel PID-zero row with parent zero`, () => {
      expect(roots(runVerifier(shell, [row(0, 0, 'kernel_task'), row(100, 0)]))).toEqual([100]);
    });
  }
});
