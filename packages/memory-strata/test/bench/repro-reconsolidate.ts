#!/usr/bin/env tsx
// Discriminator (2026-07-08): re-run ONE consolidation pass over a kept repro
// workspace whose inbox has stranded high-confidence facts. If they now promote,
// they were always promotable and the final bench pass simply never processed
// them (race / one-pass-lag = H1). If they stay, the promote path genuinely
// declines them (H2). now is pinned to the final-session date so DECAY_DAYS=14
// doesn't delete the facts before clustering. Usage: tsx repro-reconsolidate.ts <workspaceRoot>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runConsolidation } from '../../src/consolidator.js';

const ws = process.argv[2];
if (!ws) { console.error('usage: repro-reconsolidate.ts <workspaceRoot>'); process.exit(2); }

function countInbox(): number {
  try { return readdirSync(join(ws, 'permanent/memory/inbox')).filter((f) => f.endsWith('.md')).length; }
  catch { return 0; }
}
function grepDocs(re: RegExp): string[] {
  const root = join(ws, 'permanent/memory/docs');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.md') && re.test(readFileSync(p, 'utf8'))) out.push(p.replace(ws, '.'));
    }
  };
  try { walk(root); } catch { /* no docs dir */ }
  return out;
}

const NEEDLE = /serenity|sarah|vinyasa|down dog/i;
console.log(`workspace: ${ws}`);
console.log(`BEFORE: inbox=${countInbox()} | docs matching ${NEEDLE}: ${grepDocs(NEEDLE).length}`);

const events: string[] = [];
const logger = {
  info: (e: string, f: Record<string, unknown>) => { if (!e.includes('rollup')) events.push(`info ${e} ${JSON.stringify(f)}`); },
  warn: (e: string, f: Record<string, unknown>) => events.push(`WARN ${e} ${JSON.stringify(f)}`),
};

// Pin now to the final session date (2023-05-30) so decay (14d) doesn't fire.
const now = new Date('2023-05-30T23:00:00.000Z');
const res = await runConsolidation({ workspaceRoot: ws, now, logger });

console.log(`\nrunConsolidation result:`, JSON.stringify(res, null, 0));
console.log(`\nAFTER: inbox=${countInbox()} | docs matching ${NEEDLE}: ${grepDocs(NEEDLE).join(', ') || '(none)'}`);
console.log(`\n--- events ---`);
events.forEach((e) => console.log('  ' + e));
