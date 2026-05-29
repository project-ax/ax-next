# Skill Authoring Redesign — Phase 1: behavior-preserving `.ax/skills` → `.ax/draft-skills` rename

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the agent's skill-authoring directory from `.ax/skills/` to `.ax/draft-skills/` everywhere, with zero behavior change, so the directory name no longer implies these are live skills (the live copy is the read-only `$CLAUDE_CONFIG_DIR/skills/` projection).

**Architecture:** This is the foundation slice of the larger lazy/bundle-native redesign (design doc: `docs/plans/2026-05-29-skill-authoring-lazy-redesign-design.md`). It changes only the *name* of the workspace authoring directory. The `.claude/skills → ../.ax/draft-skills` discovery symlink is **kept** (just repointed) — its removal happens later when projection-only discovery lands (Phase 3). Three path-matchers key off this path and must move in lockstep or validation/permissions silently stop matching: the validator's `SKILL_PATH` regex, the agents scan/grant globs, and the runner's symlink target.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, tsconfig project refs. Repo on macOS (`sed -i ''` / prefer `perl -pi -e`).

---

## Phase roadmap (each subsequent phase = its own plan + PR)

This plan is **Phase 1** only. The redesign is a non-breaking sequence; later phases get their own plan docs as their open questions resolve:

| Phase | Slice | Depends on | Open questions to resolve first |
|-------|-------|-----------|---------------------------------|
| **1 (this)** | Rename `.ax/skills` → `.ax/draft-skills`, behavior-preserving | — | none |
| 2 | Non-destructive commit scan + quarantine (validator off the veto path → accept-but-annotate; host-side quarantine status; reason surfaced) | 1 | concrete scan heuristic set |
| 3 | Bundle-native projection + re-spawn trigger; delete `install_authored_skill` transaction + DB promotion; stop retiring the draft; route discovery through host projection only (remove `.claude/skills` symlink) | 1, 2 | migration of existing DB-backed skills; strangler order |
| 4 | Lazy capability approval (hybrid upfront-from-proposal + reactive top-up) | 3 | capability-proposal sidecar format; credential env-vs-proxy re-spawn boundary |
| 5 | Catalog as a bundle registry | 3, 4 | — |
| 6 | `ax-skill-creator` rewrite + kind-walk (author-and-run a Linear skill, both explicit-hosts and agent-decides prompts) | all | — |

Why rename first: it is the only fully non-breaking, no-open-questions slice, and it establishes the vocabulary every later phase uses. Removing the `project`-source symlink or deleting the transaction before the host projection reads draft bundles would break discovery mid-transition — so those wait for Phase 3.

---

## Pre-flight

- [ ] **Step 0: Confirm green baseline**

Run: `pnpm build && pnpm test`
Expected: PASS. (If the baseline is red, stop — this rename must not be the thing that turns it red.)

---

### Task 1: Validator path matcher (`@ax/validator-skill`)

The validator only runs its frontmatter check on `workspace:pre-apply` changes whose path matches `SKILL_PATH`. If the regex isn't moved with the rename, authored SKILL.md files silently stop being validated.

**Files:**
- Modify: `packages/validator-skill/src/plugin.ts:51`
- Test: `packages/validator-skill/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Flip the test fixtures to the new path (red)**

In `packages/validator-skill/src/__tests__/plugin.test.ts`, replace every `.ax/skills/` literal with `.ax/draft-skills/` (e.g. `.ax/skills/foo/SKILL.md` → `.ax/draft-skills/foo/SKILL.md`, `.ax/skills/good/SKILL.md`, `.ax/skills/bad/SKILL.md`, and the negative-case comment `.ax/skills/SKILL.md` → `.ax/draft-skills/SKILL.md`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @ax/validator-skill`
Expected: FAIL — the "valid SKILL.md is validated/accepted" cases now use `.ax/draft-skills/...`, which the old `SKILL_PATH` regex doesn't match, so the validator skips them.

- [ ] **Step 3: Update the regex**

In `packages/validator-skill/src/plugin.ts:51`, change:

```ts
const SKILL_PATH = /^\.ax\/skills\/[^/]+\/SKILL\.md$/;
```

to:

```ts
const SKILL_PATH = /^\.ax\/draft-skills\/[^/]+\/SKILL\.md$/;
```

Also update the two doc comments at `:22` and `:46-48` (`.ax/skills/<skill>/...` → `.ax/draft-skills/<skill>/...`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test --filter @ax/validator-skill`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/validator-skill/src/plugin.ts packages/validator-skill/src/__tests__/plugin.test.ts
git commit -m "refactor(validator-skill): match .ax/draft-skills/ authoring path"
```

---

### Task 2: Runner workspace symlink target (`@ax/agent-claude-sdk-runner`)

The runner scaffolds the workspace's authoring dir and the `.claude/skills → ../.ax/skills` discovery symlink. The symlink TARGET and the scaffolded dir must both move; the symlink NAME (`.claude/skills`) stays.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/git-workspace.ts` (symlink target `'../.ax/skills'` at `:211`, `:214`, `:218`; the dir-ensure path; the `:185-187` doc comment)
- Test: `packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts`

- [ ] **Step 1: Flip the test expectations to the new target (red)**

In `packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts`, replace every `.ax/skills` with `.ax/draft-skills` — both the three symlink-target assertions (`'../.ax/skills'` → `'../.ax/draft-skills'`) and the fixture path `.ax/skills/foo/SKILL.md` → `.ax/draft-skills/foo/SKILL.md`. Update the test title `"...creates .ax/skills and a relative .claude/skills symlink..."` to say `.ax/draft-skills`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @ax/agent-claude-sdk-runner -- git-workspace`
Expected: FAIL — the symlink target assertion sees `../.ax/skills` but expects `../.ax/draft-skills`.

- [ ] **Step 3: Update the scaffold**

In `packages/agent-claude-sdk-runner/src/git-workspace.ts`, within the skills-symlink scaffold function, replace every occurrence of `.ax/skills` with `.ax/draft-skills` (the `mkdir`/dir-ensure target, the three `'../.ax/skills'` string literals at `:211`/`:214`/`:218`, and the `:185-187` comment). Confirm none remain:

```bash
grep -n "ax/skills" packages/agent-claude-sdk-runner/src/git-workspace.ts
```
Expected: only `.ax/draft-skills` matches (zero bare `.ax/skills`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test --filter @ax/agent-claude-sdk-runner -- git-workspace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/git-workspace.ts packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts
git commit -m "refactor(runner): repoint .claude/skills symlink at .ax/draft-skills"
```

---

### Task 3: Agents read-dir + scan/grant globs (`@ax/agents`)

`@ax/agents` reads the authored bundle from a path it builds from the skill id, scans the workspace for authored SKILL.md files, and grants the agent an `allowedTools` glob over its own draft dir. All three key off the path.

**Files:**
- Modify: `packages/agents/src/authored-skills.ts` (`const dir` at `:175`; scan glob at `:54`; comments at `:9`, `:60`, `:116`, `:139`, `:196`)
- Modify: `packages/agents/src/plugin.ts` (allowedTools glob at `:460`; comments at `:133`, `:330`, `:354`, `:379`, `:441`)
- Modify: `packages/agents/src/types.ts` (comments)
- Test: `packages/agents/src/__tests__/authored-skills.test.ts`, `promote-authored-skills.test.ts`, `install-authored-skill.test.ts`, `plugin.test.ts`

- [ ] **Step 1: Flip the test fixtures + the grant-glob assertion to the new path (red)**

In the four agents test files, replace every `.ax/skills/` literal with `.ax/draft-skills/`. This includes fixture write paths (`.ax/skills/foo/SKILL.md`, `.ax/skills/notes/scripts/run.py`, etc.), the "draft is gone from the workspace" assertions (`.ax/skills/notes/'` → `.ax/draft-skills/notes/'`), and any assertion on the granted glob (`.ax/skills/${id}/**` → `.ax/draft-skills/${id}/**`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test --filter @ax/agents`
Expected: FAIL — fixtures are now written under `.ax/draft-skills/` but the code reads `.ax/skills/`, so the scan finds nothing / the grant-glob assertion mismatches.

- [ ] **Step 3: Update the three globs/paths in source**

In `packages/agents/src/authored-skills.ts:175`:

```ts
  const dir = `.ax/skills/${skillId}`;
```
→
```ts
  const dir = `.ax/draft-skills/${skillId}`;
```

In `packages/agents/src/authored-skills.ts:54`:

```ts
    { pathGlob: '.ax/skills/*/SKILL.md' },
```
→
```ts
    { pathGlob: '.ax/draft-skills/*/SKILL.md' },
```

In `packages/agents/src/plugin.ts:460`:

```ts
              { pathGlob: `.ax/skills/${bundle.id}/**` },
```
→
```ts
              { pathGlob: `.ax/draft-skills/${bundle.id}/**` },
```

Then update the remaining `.ax/skills` comment references in `authored-skills.ts`, `plugin.ts`, and `types.ts`. Confirm none remain in source:

```bash
grep -rn "\.ax/skills" packages/agents/src --include="*.ts" | grep -v "/__tests__/"
```
Expected: zero matches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test --filter @ax/agents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src
git commit -m "refactor(agents): read/scan/grant .ax/draft-skills authoring path"
```

---

### Task 4: Mechanical sweep of the remaining references + the built-in guide

Everything left is comments, test fixtures in other packages, the built-in `ax-skill-creator` guide asset, and the workspace-policy doc comments. None are behavior-bearing (`workspace-policy` already allows the whole `.ax/**` subtree, so the renamed dir stays writable with no policy change). One automated, idempotent pass — `.ax/skills` is **not** a substring of `.ax/draft-skills`, so re-running won't double-rename.

**Files (remaining `.ax/skills` carriers in `packages/*/src` + `presets/k8s/src`):**
- `packages/agent-claude-sdk-runner/src/`: `main.ts`, `commit-notify-resync.ts`, `host-mcp-server.ts`, `tool-names.ts`, and tests `host-mcp-server.test.ts`, `flush-workspace-host.e2e.test.ts`, `main.test.ts`
- `packages/core/src/`: `workspace-policy.ts`, `types.ts`, `__tests__/workspace-apply-facade.test.ts`
- `packages/ipc-core/src/`: `handlers/__tests__/workspace-materialize.test.ts`, `bundler/__tests__/filter.test.ts`
- `packages/sandbox-k8s/src/`: `pod-spec.ts`, `__tests__/pod-spec.test.ts`
- `packages/sandbox-subprocess/src/`: `open-session.ts`, `__tests__/open-session.test.ts`, `__tests__/skill-discovery.acceptance.test.ts`
- `packages/skill-broker/src/tools/install-authored-skill.ts`
- `packages/skills/src/__tests__/e2e/skill-install.canary.test.ts`
- `presets/k8s/src/__tests__/acceptance.test.ts`
- `presets/k8s/src/builtin-skills/ax-skill-creator/SKILL.md` (the agent-facing guide — all six `.ax/skills/...` references)

- [ ] **Step 1: Run the sweep**

```bash
grep -rl "\.ax/skills" packages/*/src presets/k8s/src \
  --include="*.ts" --include="*.tsx" --include="*.md" \
  | grep -vE "/dist/" \
  | xargs perl -pi -e 's{\.ax/skills}{.ax/draft-skills}g'
```

- [ ] **Step 2: Verify nothing behavior-bearing was missed and no stragglers remain**

```bash
grep -rn "\.ax/skills" packages/*/src presets/k8s/src --include="*.ts" --include="*.tsx" --include="*.md" | grep -vE "/dist/"
```
Expected: zero matches (every reference is now `.ax/draft-skills`).

- [ ] **Step 3: Rebuild so the preset copies the updated guide into `dist/builtin-skills`**

Run: `pnpm build --filter @ax/preset-k8s`
Expected: PASS. (`dist/` is generated, not committed — the build's `cpSync` step re-copies `src/builtin-skills/**.md`.)

- [ ] **Step 4: Commit**

```bash
git add packages presets
git commit -m "refactor: rename .ax/skills authoring path to .ax/draft-skills (comments, fixtures, ax-skill-creator guide)"
```

---

### Task 5: Whole-repo verification

The rename touches multiple packages across the tsconfig ref graph; verify the build, the full suite, and lint as a unit (per the project's pre-PR check: build + test + lint, not just test).

**Files:** none (verification only).

- [ ] **Step 1: Confirm no bare `.ax/skills` remains anywhere in shipped source**

```bash
grep -rn "\.ax/skills" packages presets --include="*.ts" --include="*.tsx" --include="*.md" | grep -vE "/dist/|/node_modules/"
```
Expected: zero matches. (Historical `docs/` and `.claude/memory/` records are intentionally left untouched.)

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: PASS (tsc clean across all packages).

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS. Pay attention to the cross-cutting suites that materialize/validate skill paths: `@ax/agents`, `@ax/validator-skill`, `@ax/agent-claude-sdk-runner`, `@ax/ipc-core`, `@ax/sandbox-subprocess`, `@ax/preset-k8s`, `@ax/skills`.

- [ ] **Step 4: Lint (scoped to changed files to avoid stale-worktree noise)**

Run: `pnpm lint` (or scope to the changed packages if `.worktrees/` copies pollute the output — known repo gotcha).
Expected: PASS.

- [ ] **Step 5: Final commit if anything was adjusted during verification**

```bash
git add -A
git commit -m "chore: finalize .ax/draft-skills rename (build/test/lint green)"
```

---

## Self-Review (run by the plan author)

**1. Spec coverage.** The design doc's rename decision appears in two places: the discovery section ("Rename the authoring dir `.ax/skills/` → `.ax/draft-skills/`, and remove the `.claude/skills` → `.ax/skills` symlink") and the `agent-claude-sdk-runner` "what changes" bullet. This Phase-1 plan does the **rename** and **repoints** the symlink; it deliberately **defers the symlink removal to Phase 3** (removing it now would break `project`-source discovery before the host projection reads draft bundles). Flagged in the roadmap so the deferral is explicit, not a gap.

**2. Placeholder scan.** No TBD/TODO/"handle appropriately". Every code change shows the exact old→new string or an exact sweep command; every verification shows the exact command + expected result.

**3. Type/string consistency.** The replacement string is `.ax/draft-skills` everywhere — regex (`/^\.ax\/draft-skills\/[^/]+\/SKILL\.md$/`), template literals (`` `.ax/draft-skills/${skillId}` ``, `` `.ax/draft-skills/${bundle.id}/**` ``), globs (`.ax/draft-skills/*/SKILL.md`), and symlink target (`../.ax/draft-skills`). The symlink NAME `.claude/skills` is unchanged on purpose. `.ax/skills` is not a substring of `.ax/draft-skills`, so the Task-4 sweep is idempotent and cannot corrupt the Task-1–3 edits.

**Behavioral guarantee:** discovery, validation, install, materialization, and permissions all resolve to the same set of files as before — only the directory name changed. No new test asserts new *behavior* because there is none; the existing tests, re-pointed, prove the path moved end-to-end.
