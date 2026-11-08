// Prepares one page through `createHtmlPreparer` of the COMPILED package, in this process, and prints what became of it
// as a line of JSON. Run as a child by prepare-pool-shapes.test.ts: a page that makes V8 end the process (not the
// worker: "Reached heap limit", SIGABRT) is an exit code the test can read, and cannot take the test runner with it.
//   node pool-shape.mjs <shape> [maxOldGenerationSizeMb]
// FRAME_GUARD_DIST names another build of the package (the one before a fix, to see the crash it fixed).
// CONTAINER_MIB is the memory limit of the container to pretend the host is in, in MiB; without it there is none (whatever
// the machine this runs on has, so that the figures do not change with it).
// POOL_DEADLINE_MS is the pool's deadline for the page, in milliseconds; without it the pool's own (6 s).
import { shapes } from './amplified-pages.mjs';

const dist = process.env.FRAME_GUARD_DIST ?? new URL('../../../dist', import.meta.url).pathname;
const { createHtmlPreparer } = await import(`${dist}/index.js`);

const [name, heap] = process.argv.slice(2);
const make = shapes[name ?? ''];
if (make === undefined) throw new Error(`no such shape: ${name}`);

const faults = [];
const container = process.env.CONTAINER_MIB === undefined ? undefined : Number(process.env.CONTAINER_MIB) * 1024 * 1024;
const deadline = process.env.POOL_DEADLINE_MS === undefined ? undefined : Number(process.env.POOL_DEADLINE_MS);
const preparer = createHtmlPreparer({
  ...(heap === undefined ? {} : { maxOldGenerationSizeMb: Number(heap) }),
  ...(deadline === undefined ? {} : { deadlineMs: deadline }),
  containerMemoryBytes: () => container,
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
