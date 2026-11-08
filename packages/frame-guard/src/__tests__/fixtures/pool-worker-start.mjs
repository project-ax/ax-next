// Workers that start wrongly, for the tests of the pool: what a worker says when it starts is the pool's one check
// on it. Which way this one starts wrong is the title it is given (`execArgv: ['--title=silent']`, a flag Node takes
// and a worker can read back), because a worker is started with no environment and no arguments of the test's own.
// Plain JavaScript, so Node runs it as it is.
import { getHeapStatistics } from 'node:v8';

process.on('disconnect', () => process.exit(0));
process.on('message', ({ id }) => process.send({ id, ok: true, bytes: new TextEncoder().encode('answered') }));

const limit = getHeapStatistics().heap_size_limit / (1024 * 1024);

switch (process.title) {
  case 'silent': // never says it is ready
    break;
  case 'talks': // says something that is not "ready" first
    process.send({ hello: 'there' });
    break;
  case 'answers': // answers before it is ready
    process.send({ id: 1, ok: true, bytes: new TextEncoder().encode('too early') });
    break;
  case 'bad-limit': // says it is ready, with a heap limit that is not a number
    process.send({ ready: true, heapLimitMb: 'plenty' });
    break;
  case 'limit-high': // says it is ready, with more heap than it was asked for
    process.send({ ready: true, heapLimitMb: limit + 100 });
    break;
  case 'limit-low': // ...and with less
    process.send({ ready: true, heapLimitMb: Math.max(1, limit - 100) });
    break;
  case 'right': // says what the pool asked for: the limit is the real one, which is whatever the pool's flags gave it
    process.send({ ready: true, heapLimitMb: limit });
    break;
  default:
    throw new Error(`no such way to start: ${process.title}`);
}
