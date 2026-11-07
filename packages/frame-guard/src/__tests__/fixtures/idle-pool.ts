// Makes a pool, has one page prepared, and does NOT close it. Run as a child by prepare-pool.test.ts to see
// that the process ends by itself: an idle worker must not be what keeps a process (a command, a test run, a
// server that is shutting down) from exiting. Run it with a TypeScript loader:
//   node --import tsx idle-pool.ts
import { createHtmlPreparer } from '../../index.js';

const preparer = createHtmlPreparer({ workerUrl: new URL('./pool-worker.mjs', import.meta.url) });
const page = await preparer.prepare('echo:hello');
console.log(JSON.stringify({ ok: page.ok }));
