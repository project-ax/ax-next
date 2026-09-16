// Tests for the import guards in `eslint.config.mjs` itself, not for a custom
// rule.
//
// TASK-372 moved the Fault A error-label table out of `lib/transport.ts`
// because TASK-360 deletes that file with the rest of chat, and added a
// `no-restricted-imports` block so the agent workspace cannot reach back into
// the chat tree. That guard had the same problem as the import it was written
// to catch: nothing checked it. Reorder the flat-config blocks, drop the
// repeated `@ax/*` group, or delete the `ignores` line, and the workspace tree
// silently stops being linted while CI stays green — which is precisely the
// "nobody noticed" failure TASK-372 exists to prevent.
//
// So these cases lint synthetic sources through the REAL `eslint.config.mjs`,
// at the real paths that decide which blocks apply. They are assertions about
// the config's behaviour, so they survive it being refactored.
//
// The `@ax/*` cases are here for a second reason. A flat-config block REPLACES
// a rule's options for its matched files rather than merging them, so the
// invariant-2 group has to reach every scoped block somehow. Whether that is
// done by repeating it or by sharing one constant, the failure mode if it goes
// missing is silent: the workspace tree simply stops being checked. These pin
// it from the outside, so either shape is safe to refactor into.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Paths that select a config block. The files need not exist on disk. */
const WORKSPACE_LIB = 'packages/channel-web/src/lib/workspace-api.ts';
const WORKSPACE_COMPONENT = 'packages/channel-web/src/components/workspace/AgentView.tsx';
const WORKSPACE_TEST = 'packages/channel-web/src/components/workspace/__tests__/AgentView.test.tsx';
const CHAT_LIB = 'packages/channel-web/src/lib/turn-error.ts';
const PLAIN_PLUGIN_FILE = 'packages/channel-web/src/lib/agent-store.ts';

let eslint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.mjs'),
  });
});

/** The `no-restricted-imports` messages ESLint reports for `code` at `file`. */
async function restrictedImportMessages(code, file) {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repoRoot, file),
    warnIgnored: false,
  });
  return (result?.messages ?? []).filter(
    (m) => m.ruleId === '@typescript-eslint/no-restricted-imports',
  );
}

describe('the agent workspace cannot import the chat tree', () => {
  // The exact import TASK-372 removed. `lib/transport.ts` is deleted by
  // TASK-360, so this is a dependency on a file that is going away.
  it('rejects a chat-tree import from a workspace lib module', async () => {
    const messages = await restrictedImportMessages(
      "import { ERROR_LABELS } from './transport';\nexport const x = ERROR_LABELS;\n",
      WORKSPACE_LIB,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/must not import from the chat tree/);
  });

  // The spelling a workspace COMPONENT would actually reach for: the tree uses
  // the `@/` alias throughout, so a guard that only listed relative paths would
  // miss the likeliest way in.
  it('rejects a chat-tree import written with the @/ alias', async () => {
    const messages = await restrictedImportMessages(
      "import { CONNECTION_LOST } from '@/lib/transport';\nexport const x = CONNECTION_LOST;\n",
      WORKSPACE_COMPONENT,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/must not import from the chat tree/);
  });

  // A type-only import is NOT exempt here, unlike the invariant-2 group below.
  // Type imports erase at build time, but `transport.ts` still stops existing,
  // so the file still fails to compile once TASK-360 lands.
  it('rejects even a type-only import of the chat tree', async () => {
    const messages = await restrictedImportMessages(
      "import type { AxChatTransport } from './transport';\nexport type X = AxChatTransport;\n",
      WORKSPACE_LIB,
    );
    expect(messages).toHaveLength(1);
  });

  // `./turn-error` is on the forbidden list and `./turn-error-labels` starts
  // with it. If the patterns ever become prefix matches, the workspace loses
  // the very module TASK-372 created for it.
  it('allows the label table the workspace was pointed at', async () => {
    const messages = await restrictedImportMessages(
      "import { ERROR_LABELS } from './turn-error-labels';\nexport const x = ERROR_LABELS;\n",
      WORKSPACE_LIB,
    );
    expect(messages).toEqual([]);
  });

  // The guard fences the workspace IN, not chat OUT. Chat's own onError adapter
  // imports `./transport` legitimately and is deleted alongside it.
  it('leaves chat free to import its own transport', async () => {
    const messages = await restrictedImportMessages(
      "import { CONNECTION_LOST } from './transport';\nexport const x = CONNECTION_LOST;\n",
      CHAT_LIB,
    );
    expect(messages).toEqual([]);
  });
});

describe('the workspace block does not disturb invariant 2', () => {
  // If the scoped block ever loses the cross-plugin group — by a dropped copy,
  // a bad refactor, or a reordering — this is what goes quiet. The workspace
  // would keep linting and simply stop being checked for invariant 2.
  it('still forbids a cross-plugin runtime import from the workspace tree', async () => {
    const messages = await restrictedImportMessages(
      "import { installSkill } from '@ax/skills';\nexport const x = installSkill;\n",
      WORKSPACE_COMPONENT,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/Cross-plugin runtime imports are forbidden/);
  });

  // The same, from a file no scoped block matches — so a regression in the base
  // block is distinguishable from one in the workspace block.
  it('still forbids a cross-plugin runtime import from an unscoped plugin file', async () => {
    const messages = await restrictedImportMessages(
      "import { installSkill } from '@ax/skills';\nexport const x = installSkill;\n",
      PLAIN_PLUGIN_FILE,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/Cross-plugin runtime imports are forbidden/);
  });

  // Boundary types are how plugins agree on a contract without runtime
  // coupling, so the invariant-2 group allows them. This is the asymmetry with
  // the chat-tree group above, and it is deliberate in both directions.
  it('still allows a type-only cross-plugin import from the workspace tree', async () => {
    const messages = await restrictedImportMessages(
      "import type { Skill } from '@ax/skills';\nexport type X = Skill;\n",
      WORKSPACE_COMPONENT,
    );
    expect(messages).toEqual([]);
  });

  // The base config turns this rule OFF under `__tests__/`. The workspace
  // block's `components/workspace/**` glob would match those files too, so it
  // carries an `ignores` line; without it the rule comes back on for the
  // workspace's tests alone, which no other package has to live with.
  it('stays off under the workspace tree tests, as it is everywhere else', async () => {
    const messages = await restrictedImportMessages(
      "import { installSkill } from '@ax/skills';\nexport const x = installSkill;\n",
      WORKSPACE_TEST,
    );
    expect(messages).toEqual([]);
  });
});
