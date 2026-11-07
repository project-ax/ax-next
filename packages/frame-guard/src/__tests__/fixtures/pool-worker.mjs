// A stand-in for prepare-worker.js, for the tests of the pool (prepare-pool.ts): the page it is sent says
// what it does ("verb:argument"), so one worker covers answering, refusing, being slow, running out of memory,
// crashing and answering wrongly, without the real transform. Plain JavaScript, so Node runs it as it is.
import { parentPort, threadId } from 'node:worker_threads';

const burn = (ms) => {
  for (const end = performance.now() + ms; performance.now() < end; ) {
    /* hold the thread */
  }
};

function answer(id, text) {
  const bytes = new TextEncoder().encode(text);
  parentPort.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
}

parentPort.on('message', ({ id, html }) => {
  const at = html.indexOf(':');
  const verb = at < 0 ? html : html.slice(0, at);
  const arg = at < 0 ? '' : html.slice(at + 1);
  switch (verb) {
    case 'echo': // answers with the thread it ran on, so a test can tell one worker from another
      answer(id, `${threadId}:${arg}`);
      return;
    case 'window': { // holds the thread for a while, and says when it started and ended
      const started = performance.timeOrigin + performance.now();
      burn(Number(arg));
      answer(id, `${started}:${performance.timeOrigin + performance.now()}`);
      return;
    }
    case 'refuse':
      parentPort.postMessage({ id, ok: false, reason: arg });
      return;
    case 'spin': // never answers, and never lets go of the thread
      for (;;) {
        /* hold the thread */
      }
    case 'oom': {
      const keep = [];
      for (;;) keep.push(new Array(100_000).fill(keep.length));
    }
    case 'throw':
      throw new Error('the worker broke');
    case 'exit':
      process.exit(3);
      return;
    case 'nonsense':
      parentPort.postMessage({ hello: 'there' });
      parentPort.postMessage({ id, hello: 'there' });
      return;
    case 'env':
      answer(id, `${JSON.stringify(Object.keys(process.env))} ${JSON.stringify(process.execArgv)}`);
      return;
    default:
      throw new Error(`no such verb: ${verb}`);
  }
});
