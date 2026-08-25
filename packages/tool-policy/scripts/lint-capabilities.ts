#!/usr/bin/env tsx
/**
 * CI gate over the whole rule table.
 *
 * `rules.test.ts` covers the same ground. This script exists so the failure
 * names the offending rule and the offending clause in the CI log, instead of
 * being buried in a vitest diff of the whole rule table — the person who broke it
 * is usually editing prose, not code, and a legible message is the difference
 * between a one-line fix and a spelunk.
 *
 * Exits 1 on the first table that has any bad clause. Prints every failure, not
 * just the first, so one CI run fixes all of them.
 */
import { lintCapability, lintRuleEffect } from '../src/capability-lint.js';
import { BUILTIN_RULES } from '../src/rules.js';

let failures = 0;

for (const rule of BUILTIN_RULES) {
  for (const err of lintCapability(rule.capability)) {
    failures += 1;
    process.stderr.write(`${rule.id}: capability ${err}\n`);
    process.stderr.write(`  clause: ${JSON.stringify(rule.capability)}\n`);
  }
  // TASK-263: an `outward` rule may not be `allow`. Here rather than only in
  // vitest for the same reason as the clause lint — the person who trips this
  // is editing the rule table, and a named rule id beats a table-wide diff.
  for (const err of lintRuleEffect(rule)) {
    failures += 1;
    process.stderr.write(`${rule.id}: ${err}\n`);
  }
}

if (failures > 0) {
  process.stderr.write(
    `\n${failures} rule problem(s) in packages/tool-policy/src/rules.ts.\n` +
      'A capability clause is half a sentence — the verdict supplies the frame.\n' +
      'An effect problem means a rule claims an outward action it also allows.\n' +
      'See packages/tool-policy/src/capability-lint.ts for both sets of rules.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `tool-policy: ${BUILTIN_RULES.length} rules OK (capability clauses + outward-effect verdicts)\n`,
);
