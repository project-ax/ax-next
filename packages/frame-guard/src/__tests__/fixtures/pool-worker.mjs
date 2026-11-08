// A stand-in for prepare-worker.js, for the tests of the pool (prepare-pool.ts): the page it is sent says
// what it does ("verb:argument"), so one worker covers answering, refusing, being slow, running out of memory,
// crashing and answering wrongly, without the real transform. Plain JavaScript, so Node runs it as it is. It is a
// process, started the way the pool starts the real one, and says "ready" the way the real one does.
import { fstatSync, statSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { GUARD_MARKER, withGuard } from './guard-marker.mjs';

const burn = (ms) => {
  for (const end = performance.now() + ms; performance.now() < end; ) {
    /* hold the process */
  }
};

// A worker that holds the process must not be able to hold it for good: when the host that made it is killed (a test
// run that is stopped, a mutation that stops the pool ending it) a loop that only ends when it is killed is a process
// at 100% of a core, with no parent, until somebody notices. It ends itself after a few seconds, longer than any test waits.
const SPIN_MS = 8000;
function spin() {
  burn(SPIN_MS);
  process.exit(1);
}

// An answer, with the guard in front of what it says, as every page the real worker makes has it.
function answer(id, text) {
  process.send({ id, ok: true, bytes: withGuard(text) });
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
    case 'unguarded': // says ok, with a page that has no guard in it (what the argument says, as it is)
      process.send({ id, ok: true, bytes: new TextEncoder().encode(arg) });
      return;
    case 'smuggled': // says ok, with a page that has no guard in it, in a message that has the guard on both sides of the page
      process.send({ id, before: GUARD_MARKER, ok: true, bytes: new TextEncoder().encode(arg), after: GUARD_MARKER });
      return;
    case 'bytes': { // says ok, with a page of exactly this many bytes, the guard at the front of it
      const page = new Uint8Array(Number(arg));
      const front = new TextEncoder().encode(GUARD_MARKER);
      page.set(front.subarray(0, page.length));
      page.fill(0x61, Math.min(front.length, page.length));
      process.send({ id, ok: true, bytes: page });
      return;
    }
    case 'spin': // never answers, and does not let go (for SPIN_MS)
      spin();
      return;
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
      spin(); // (a signal that does not end it is waited for for SPIN_MS)
      return;
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
