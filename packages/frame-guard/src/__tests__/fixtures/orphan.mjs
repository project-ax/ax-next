// Starts the real worker the way the pool does, says which process it is, and then ends ITSELF the hard way (SIGKILL: no
// handler runs, nothing is closed, the way a host that is killed ends). Run as a child by prepare-pool-shapes.test.ts to see
// that a worker does not outlive the host that made it. It needs the package built.
import { fork } from 'node:child_process';
import { writeSync } from 'node:fs';

const entry = new URL('../../../dist/prepare-worker.js', import.meta.url).pathname;
const child = fork(entry, ['--ax-frame-guard-worker'], {
  execArgv: ['--max-old-space-size=128', '--max-semi-space-size=16'],
  env: {},
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  serialization: 'advanced',
});
child.once('message', () => {
  writeSync(1, `${JSON.stringify({ pid: child.pid })}\n`);
  process.kill(process.pid, 'SIGKILL');
});
