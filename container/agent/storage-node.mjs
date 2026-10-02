import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve through the production assembly, independent of pnpm's store layout.
const host = createRequire('/opt/ax-next/host/package.json');
const memory = createRequire(host.resolve('@ax/preset-memory'));
const preset = createRequire(memory.resolve('@ax/preset-k8s'));
await import(new URL('./storage-node/main.js', pathToFileURL(preset.resolve('@ax/sandbox-k8s'))).href);
