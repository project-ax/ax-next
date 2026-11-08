// A stand-in for prepare-worker.js, for the tests of the pool (prepare-pool.ts): the page it is sent says
// what it does ("verb:argument"), so one worker covers answering, refusing, being slow, running out of memory,
// crashing and answering wrongly, without the real transform. Plain JavaScript, so Node runs it as it is. It is a
// process, started the way the pool starts the real one, and says "ready" the way the real one does.
import { fstatSync, statSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

const burn = (ms) => {
  for (const end = performance.now() + ms; performance.now() < end; ) {
    /* hold the process */
  }
};

function answer(id, text) {
  process.send({ id, ok: true, bytes: new TextEncoder().encode(text) });
}

// The host let go of the channel: nothing more to do.
process.on('disconnect', () => process.exit(0));

process.on('message', ({ id, html }) => {
  const at = html.indexOf(':');
  const verb = at < 0 ? html : html.slice(0, at);
  const arg = at < 0 ? '' : html.slice(at + 1);
  switch (verb) {
    case 'echo': // answers with the process it ran in, so a test can tell one worker from another
      answer(id, `${process.pid}:${arg}`);
      return;
    case 'window': { // holds the process for a while, and says when it started and ended
      const started = performance.timeOrigin + performance.now();
      burn(Number(arg));
      answer(id, `${started}:${performance.timeOrigin + performance.now()}`);
      return;
    }
    case 'refuse':
      process.send({ id, ok: false, reason: arg });
      return;
    case 'spin': // never answers, and never lets go
      for (;;) {
        /* hold the process */
      }
    case 'sleep': // never answers, but is not busy
      return;
    case 'oom': {
      const keep = [];
      for (;;) keep.push(new Array(100_000).fill(keep.length));
    }
    case 'throw':
      throw new Error('the worker broke');
    case 'exit':
      process.exit(Number(arg || 3));
      return;
    case 'abort': // ended by SIGABRT with no heap limit involved
      process.abort();
      return;
    case 'signal': // ended by a signal the way a crash or the kernel's out-of-memory killer does it
      process.kill(process.pid, arg);
      for (;;) {
        /* wait for it */
      }
    case 'nonsense':
      process.send({ hello: 'there' });
      process.send({ id, hello: 'there' });
      return;
    case 'stdio': { // whether each of the three standard streams is /dev/null
      const nothing = statSync('/dev/null');
      answer(id, JSON.stringify([0, 1, 2].map((fd) => fstatSync(fd).isCharacterDevice() && fstatSync(fd).rdev === nothing.rdev)));
      return;
    }
    case 'env':
      answer(
        id,
        `${JSON.stringify(Object.keys(process.env).filter((k) => !k.startsWith('__CF')))} ${JSON.stringify(process.execArgv)} ${JSON.stringify(process.argv.slice(2))}`,
      );
      return;
    default:
      throw new Error(`no such verb: ${verb}`);
  }
});

process.send({ ready: true, heapLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024) });
