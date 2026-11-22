// Guard (TASK-1199): channel-slack's SLACK_NOTE_LEAD quotes the runner's
// SYSTEM_PREFIX by hand, and tells the model a message starting with it is the
// system's. If the prefix changes and the lead doesn't, the lead calls the real
// line data. channel-slack can't import agent-runner-core (no cross-plugin
// imports), and CI's PR test job runs only changed packages plus their
// dependents, so a PR editing SYSTEM_PREFIX would never run a channel-slack
// test. `pnpm test:scripts` runs on every PR, so the check lives here and reads
// both files as text.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

describe('the Slack lead names the runner system-line prefix', () => {
  it('quotes the exact SYSTEM_PREFIX literal from decision-turn.ts', () => {
    const m = read('packages/agent-runner-core/src/decision-turn.ts').match(
      /export const SYSTEM_PREFIX = '([^']+)';/,
    );
    expect(m, 'SYSTEM_PREFIX literal not found in decision-turn.ts').not.toBeNull();
    expect(read('packages/channel-slack/src/turn-note.ts')).toContain(`"${m[1]}"`);
  });
});
