// Prepares one page through `createHtmlPreparer` of the COMPILED package, in this process, and prints what became of it
// as a line of JSON. Run as a child by prepare-pool-shapes.test.ts: a page that makes V8 end the process (not the
// worker: "Reached heap limit", SIGABRT) is an exit code the test can read, and cannot take the test runner with it.
//   node pool-shape.mjs <shape> [maxOldGenerationSizeMb]
// FRAME_GUARD_DIST names another build of the package (the one before a fix, to see the crash it fixed).
import { shapes } from './amplified-pages.mjs';

const dist = process.env.FRAME_GUARD_DIST ?? new URL('../../../dist', import.meta.url).pathname;
const { createHtmlPreparer } = await import(`${dist}/index.js`);

const [name, heap] = process.argv.slice(2);
const make = shapes[name ?? ''];
if (make === undefined) throw new Error(`no such shape: ${name}`);

const faults = [];
const preparer = createHtmlPreparer({
  ...(heap === undefined ? {} : { maxOldGenerationSizeMb: Number(heap) }),
  onFault: (fault) => faults.push(fault?.code ?? fault?.message ?? 'fault'),
});
const started = performance.now();
const page = await preparer.prepare(make());
console.log(
  JSON.stringify({
    shape: name,
    ok: page.ok,
    reason: page.ok ? null : page.reason,
    bytes: page.ok ? page.bytes.byteLength : 0,
    ms: Math.round(performance.now() - started),
    faults,
  }),
);
await preparer.close();
