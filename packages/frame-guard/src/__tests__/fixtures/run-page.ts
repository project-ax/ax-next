// Runs the transform on one hostile page in THIS process and prints what happened
// as a line of JSON. The tests run it as a child with a small heap, so a page that
// makes the transform run out of memory ends the child (a crash is an exit code the
// test reads) instead of the test runner. Run it with a TypeScript loader:
//   node --max-old-space-size=256 --import tsx run-page.ts escape-amplification
import { prepareArtifactHtml } from '../../index.js';
import { escapeAmplification } from '../hostile-pages.js';

const MiB = 1024 * 1024;
const pages: Record<string, () => string> = {
  'escape-amplification': () => escapeAmplification(4 * MiB, 3),
};

const make = pages[process.argv[2] ?? ''];
if (make === undefined) throw new Error(`no such page: ${process.argv[2]}`);
const page = make();
const started = performance.now();
const result = prepareArtifactHtml(page);
process.stdout.write(`${JSON.stringify({ ok: result.ok, reason: result.ok ? null : result.reason, ms: Math.round(performance.now() - started) })}\n`);
