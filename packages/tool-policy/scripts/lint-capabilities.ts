#!/usr/bin/env tsx
/**
 * CI gate over the whole rule table.
 *
 * `rules.test.ts` covers the same ground. This script exists so the failure
 * names the offending rule and the offending clause in the CI log, instead of
 * being buried in a vitest diff of a 16-element array — the person who broke it
 * is usually editing prose, not code, and a legible message is the difference
 * between a one-line fix and a spelunk.
 *
 * Exits 1 on the first table that has any bad clause. Prints every failure, not
 * just the first, so one CI run fixes all of them.
 */
import { lintCapability } from '../src/capability-lint.js';
import { BUILTIN_RULES } from '../src/rules.js';

let failures = 0;

for (const rule of BUILTIN_RULES) {
  for (const err of lintCapability(rule.capability)) {
    failures += 1;
    process.stderr.write(`${rule.id}: capability ${err}\n`);
    process.stderr.write(`  clause: ${JSON.stringify(rule.capability)}\n`);
  }
}

if (failures > 0) {
  process.stderr.write(
    `\n${failures} capability clause problem(s) in packages/tool-policy/src/rules.ts.\n` +
      'The clause is half a sentence — the verdict supplies the frame. See\n' +
      'packages/tool-policy/src/capability-lint.ts for the rules it must satisfy.\n',
  );
  process.exit(1);
}

process.stdout.write(`tool-policy: ${BUILTIN_RULES.length} capability clauses OK\n`);
