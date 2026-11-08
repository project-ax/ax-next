// Makes a pool, has one page prepared, and does NOT close it. Run as a child by prepare-pool.test.ts to see
// that the process ends by itself, and takes the worker with it: an idle worker must not be what keeps a process
// (a command, a test run, a server that is shutting down) from exiting, and a worker must not outlive the
// process that made it. It prints the worker's process id, which the stand-in worker answers with. Run it with a
// TypeScript loader:
//   node --import tsx idle-pool.ts
import { createHtmlPreparer } from '../../index.js';
import { GUARD_MARKER } from '../../prepare-html.js';

// idleMs far longer than the test waits: a timer that ends an idle worker must not be what holds the process open.
const preparer = createHtmlPreparer({ workerUrl: new URL('./pool-worker.mjs', import.meta.url), idleMs: 3_600_000 });
const page = await preparer.prepare('echo:hello');
// (the stand-in puts the guard in front of what it says, which the pool wants to see)
const pid = page.ok ? Number(new TextDecoder().decode(page.bytes).slice(GUARD_MARKER.length).split(':')[0]) : null;
console.log(JSON.stringify({ ok: page.ok, pid }));
