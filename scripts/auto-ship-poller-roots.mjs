import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const knownScript = fileURLToPath(new URL('../.claude/auto-ship-board-poll.sh', import.meta.url));

function isPoller(command) {
  const shell = /^(?:\S*\/)?bash[ \t]+(.+)$/.exec(command);
  if (!shell) return false;
  const script = shell[1];
  if (/^-[a-zA-Z]*c[a-zA-Z]*(?:[ \t]|$)/.test(script)) return false;
  if (
    script === knownScript ||
    /^(?:\S+\/)?auto-ship-board-poll\.sh$/.test(script)
  ) return true;
  if (/(?:^|\/|[ \t])auto-ship-board-poll\.sh(?:[ \t]|$)/.test(script)) {
    throw new Error('ambiguous poller command');
  }
  return false;
}

function pollerRoots(snapshot) {
  const rows = snapshot.split('\n').filter((line) => line.trim() !== '');
  if (rows.length === 0) throw new Error('empty process snapshot');
  const parents = new Map();
  const matching = new Set();
  for (const line of rows) {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!row) throw new Error('invalid process snapshot');
    const pid = Number(row[1]);
    const parent = Number(row[2]);
    if (
      !Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || parents.has(pid) ||
      (pid === 0 && parent !== 0)
    ) {
      throw new Error('invalid process identity');
    }
    parents.set(pid, parent);
    if (isPoller(row[3])) {
      if (pid === 0) throw new Error('invalid poller identity');
      matching.add(pid);
    }
  }

  const roots = new Map([[0, null]]);
  for (const pid of parents.keys()) {
    const chain = [];
    const seen = new Set();
    let current = pid;
    while (parents.has(current) && !roots.has(current)) {
      if (seen.has(current)) throw new Error('cyclic process ancestry');
      seen.add(current);
      chain.push(current);
      current = parents.get(current);
    }
    let root = roots.get(current) ?? null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const member = chain[i];
      if (root === null && matching.has(member)) root = member;
      roots.set(member, root);
    }
  }
  return [...new Set([...matching].map((pid) => roots.get(pid)))].sort((a, b) => a - b);
}

try {
  const snapshot = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const roots = pollerRoots(snapshot);
  if (roots.length > 0) process.stdout.write(`${roots.join('\n')}\n`);
} catch {
  process.stderr.write('Cannot verify poller roots; process count is unknown.\n');
  process.exitCode = 2;
}
