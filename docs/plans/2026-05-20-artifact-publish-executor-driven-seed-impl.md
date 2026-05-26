# Artifact-publish executor-driven seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread the real `createArtifactPublishExecutor` output through the existing "Phase 3 canary: artifact_publish round-trip" test, replacing the hand-rolled `artifactResult` and closing the executor↔chip/ACL drift gap.

**Architecture:** One-file edit to `presets/k8s/src/__tests__/acceptance.test.ts`. A sibling tmp dir (`runnerCheckoutRoot`) simulates the runner's `/permanent` checkout — the artifact bytes get written there for the executor to read, in addition to the existing `workspace:apply` seed into the bare git repo (which the ACL reads through). The executor's output becomes the `tool_result.content` JSON string; lock-down assertions pin the shape the chip + ACL consume.

**Tech Stack:** TypeScript / vitest / Node `fs/promises`. `@ax/agent-claude-sdk-runner` (workspace dep already declared in `presets/k8s/package.json` and `tsconfig.json` references — verified).

**Spec:** `docs/plans/2026-05-20-artifact-publish-executor-driven-seed-design.md`

---

### Task 1: Thread executor output into the artifact-publish canary

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts` (test at line 2036+ — "Phase 3 canary: artifact_publish round-trip via assistant tool_result + GET /api/files")

**What changes (visual diff at the call sites):**

- Top of file: add one import.
- Inside the canary, after the existing `workspaceRoot` mkdtemp: add a sibling `runnerCheckoutRoot` mkdtemp + `fs.writeFile(...)` of the artifact bytes.
- Replace the hand-rolled `const sha256 = ... const artifactResult = {...}` block (lines 2271-2280) with: instantiate the real executor, call it, run lock-down assertions, use its output.
- `finally`: add `rm -rf runnerCheckoutRoot`.

The downstream jsonl-seed + GET /api/files + conversations:get assertions stay unchanged — they now exercise the executor's actual output instead of fabricated bytes.

- [ ] **Step 1: Add the executor import**

In `presets/k8s/src/__tests__/acceptance.test.ts`, after the existing line 32 (`import { createToolArtifactPublishPlugin } from '@ax/tool-artifact-publish';`), add:

```ts
import { createArtifactPublishExecutor } from '@ax/agent-claude-sdk-runner';
```

- [ ] **Step 2: Add the `runnerCheckoutRoot` setup**

Inside the "Phase 3 canary: artifact_publish round-trip ..." `it(...)` body, right after the existing `workspaceRoot` mkdtemp (currently at lines 2041-2043):

```ts
const workspaceRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'ax-phase-3-artifact-canary-')),
);
const runnerCheckoutRoot = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'ax-phase-3-artifact-runner-')),
);
```

- [ ] **Step 3: Write the artifact bytes onto `runnerCheckoutRoot`**

Currently the canary defines `ARTIFACT_BYTES` then does a `workspace:apply` of those bytes (line 2241+). The executor needs to `fs.readFile` from disk, so we ALSO write the bytes to `runnerCheckoutRoot/<ARTIFACT_PATH>` BEFORE the executor call.

Insert this block AFTER the existing `workspace:apply` that seeds the artifact file (currently ending at line 2251 — the call whose `reason` is `'phase-3 artifact canary: seed artifact file'`):

```ts
// Mirror the artifact bytes onto the runner-view checkout so the
// executor (which reads via fs.lstat + fs.readFile, not workspace:read)
// can lstat + read them. In production this happens automatically:
// materializeWorkspace clones the storage tier into /permanent, and the
// executor reads from there. The canary skips materialize, so we stage
// the bytes by hand.
await fs.mkdir(path.dirname(path.join(runnerCheckoutRoot, ARTIFACT_PATH)), {
  recursive: true,
  mode: 0o755,
});
await fs.writeFile(
  path.join(runnerCheckoutRoot, ARTIFACT_PATH),
  ARTIFACT_BYTES,
);
```

- [ ] **Step 4: Replace the hand-rolled `artifactResult` with the real executor's output**

Currently lines 2271-2280 read:

```ts
const sha256 = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');
const artifactResult = {
  artifactId: 'art-canary-1',
  downloadUrl: 'ax://artifact/art-canary-1',
  path: ARTIFACT_PATH,
  displayName: 'summary.md',
  mediaType: 'text/markdown',
  sizeBytes: ARTIFACT_BYTES.byteLength,
  sha256,
};
```

Replace those 10 lines with:

```ts
// Run the real artifact-publish executor against the runner-view
// checkout. Its return shape becomes the tool_result.content JSON
// string seeded into the jsonl below — this is what closes the
// executor↔ACL/chip drift gap.
const executor = createArtifactPublishExecutor({
  workspaceRoot: runnerCheckoutRoot,
});
const artifactResult = await executor({
  id: 'toolu_1',
  name: 'artifact_publish',
  input: {
    path: `/permanent/${ARTIFACT_PATH}`,
    displayName: 'summary.md',
  },
});

// Lock-down assertions: the shape ArtifactChip + checkPathScope's
// artifact-block branch consume. If any of these drift, the canary
// catches it instead of a silent prod regression.
expect(artifactResult.artifactId).toMatch(/^[0-9a-f]{16}$/);
expect(artifactResult.downloadUrl).toBe(
  `ax://artifact/${artifactResult.artifactId}`,
);
expect(artifactResult.path).toBe(ARTIFACT_PATH);
expect(artifactResult.displayName).toBe('summary.md');
expect(artifactResult.mediaType).toBe('text/markdown');
expect(artifactResult.sizeBytes).toBe(ARTIFACT_BYTES.byteLength);
expect(artifactResult.sha256).toMatch(/^[0-9a-f]{64}$/);
```

The local `sha256` const (formerly line 2271) is removed — `artifactResult.sha256` now comes from the executor.

`createHash` was imported only for that one consumer; check whether any other test in the file still uses it. If yes, leave the import. If no, remove it.

- [ ] **Step 5: Verify `createHash` import state**

Run:

```bash
grep -n "createHash" /Users/vpulim/dev/ai/ax-next/presets/k8s/src/__tests__/acceptance.test.ts
```

Expected: any remaining matches indicate other consumers — leave the import. If the only remaining match is the `import { createHash } from 'node:crypto';` line itself (no usages), remove the import line. Either branch is correct; don't leave an unused import.

- [ ] **Step 6: Add `runnerCheckoutRoot` cleanup to the `finally`**

Currently the `finally` block (around line 2385-2393) reads:

```ts
} finally {
  if (handle !== null) await handle.shutdown();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  if (originalAllowNoOrigins === undefined) {
    delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  } else {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = originalAllowNoOrigins;
  }
}
```

Add a `fs.rm` for the sibling dir. The exact updated block:

```ts
} finally {
  if (handle !== null) await handle.shutdown();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(runnerCheckoutRoot, { recursive: true, force: true });
  if (originalAllowNoOrigins === undefined) {
    delete process.env.AX_HTTP_ALLOW_NO_ORIGINS;
  } else {
    process.env.AX_HTTP_ALLOW_NO_ORIGINS = originalAllowNoOrigins;
  }
}
```

`runnerCheckoutRoot` is declared inside the `try` body, so reference it via the closure. (It's `const`, declared before the try if the conditional scoping is an issue — confirm visibility when wiring. The simplest fix is to declare it at the same scope as `workspaceRoot`, which is what step 2 already does.)

- [ ] **Step 7: Run the modified canary in isolation — expect PASS**

The canary needs the postgres testcontainer (it shares `ensurePostgresStarted`). Vitest will spin one up.

Run:

```bash
cd /Users/vpulim/dev/ai/ax-next/presets/k8s
pnpm vitest run --testNamePattern "Phase 3 canary: artifact_publish round-trip" src/__tests__/acceptance.test.ts
```

Expected: 1 passed. If the executor returns `path` that doesn't match `ARTIFACT_PATH` (`workspace/summary.md`), the lock-down assertion catches it. If `fs.readFile` ENOENT from the executor, step 3's `runnerCheckoutRoot` write is wrong — re-check the path math.

- [ ] **Step 8: Run the full preset-k8s test suite — expect no regressions**

```bash
cd /Users/vpulim/dev/ai/ax-next/presets/k8s
pnpm test
```

Expected: all tests pass. The other canaries (Phase D, Phase F, attachments, Task 21) should be unaffected — this change only touches one `it(...)` body.

- [ ] **Step 9: Run lint**

Per memory `feedback_run_lint_before_pr.md` — pre-PR check is build+test+lint:

```bash
cd /Users/vpulim/dev/ai/ax-next
pnpm lint --filter @ax/preset-k8s
```

Expected: clean. If there's an unused-import warning for `createHash`, step 5 wasn't fully applied — go back and remove it.

- [ ] **Step 10: Run build**

Per memory `feedback_run_tsc_alongside_vitest.md` — vitest tolerates undeclared workspace deps; tsc rejects them:

```bash
cd /Users/vpulim/dev/ai/ax-next
pnpm build --filter @ax/preset-k8s
```

Expected: clean. (The new import resolves through the existing `@ax/agent-claude-sdk-runner` tsconfig reference.)

- [ ] **Step 11: Verify TODO.md entry can be struck through**

Open `/Users/vpulim/dev/ai/ax-next/TODO.md`, find the "Attachments / artifacts" section (line 43-46), and confirm the first bullet (line 45) — "Artifact-publish round-trip e2e via real runner" — matches the work shipped. Plan to strike it through in the commit per the file's convention:

```markdown
- [x] ~~**Artifact-publish round-trip e2e via real runner.**~~ Shipped in PR #XXX — `presets/k8s/src/__tests__/acceptance.test.ts`'s "Phase 3 canary" now threads the real `createArtifactPublishExecutor` output into the seeded `tool_result.content`, with lock-down assertions on the executor↔chip/ACL contract (`artifactId` 16-hex, `downloadUrl = ax://artifact/<id>`, `path`, `mediaType`, `sizeBytes`, `sha256` 64-hex). A separate runner-stub for the SDK MCP wire (option B / Phase 6 PR-B) remains deferred.
```

(The PR number won't be known until after pushing; placeholder is fine — fill in during PR creation.)

- [ ] **Step 12: Commit the test change + TODO strikethrough**

Stage:

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts TODO.md
```

Commit message:

```
test(preset-k8s): drive Phase 3 artifact canary off real executor output

The artifact_publish round-trip canary used to fabricate a tool_result
artifactResult (artifactId: 'art-canary-1'), so executor↔chip/ACL drift
would slip past. Thread the real createArtifactPublishExecutor through
a runnerCheckoutRoot sibling tmp dir and lock down the shape the chip
+ checkPathScope's artifact-block branch consume.

Closes the "Artifact-publish round-trip e2e via real runner" TODO under
Attachments / artifacts. A full SDK-subprocess canary remains deferred
to Phase 6 PR-B.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

(Single commit. The change is one cohesive edit.)

---

## Out of scope (don't touch in this plan)

- Task 2 from the same TODO section (`$CLAUDE_CONFIG_DIR/sessions/` mirroring) — explicitly skipped this session per user direction; trigger hasn't fired.
- `ArtifactPublishOutput` or `checkPathScope` shape itself — frozen.
- SDK subprocess / agent:invoke shim — deferred to Phase 6 PR-B.
- Any other canary in the file — Phase D, Phase F, Phase 3 attachments, Task 21. They're stable.
- Memory updates / PR creation — outside the implementation plan. Handle in the wrap-up.
