# Skill install — Phase 0 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Claude Agent SDK to discover SKILL.md files from both the workspace (`.ax/skills/`) and a host-controlled installed-skills directory under `$HOME/.ax/session/skills/`, without breaking the existing SDK isolation invariant. After Phase 0 ships, workspace-authored skills are reachable via the SDK's `Skill` tool, and `$HOME/.ax/session/skills/` exists (empty) as the future install target — Phase 1 fills it.

**Architecture:**
- Runner flips `settingSources: []` → `['user', 'project']` and adds `'Skill'` to `allowedTools`.
- Sandbox plugins (`@ax/sandbox-subprocess`, `@ax/sandbox-k8s`) allocate a per-session HOME directory, set `CLAUDE_CONFIG_DIR=$HOME/.ax/session` in the runner env, create an empty `$HOME/.ax/session/skills/` (chmod 0555 after creation), and symlink `<workspace>/.claude/skills` → `<workspace>/.ax/skills`.
- `@ax/validator-skill` gains a veto on agent-authored writes to `.claude/settings.json` and `CLAUDE.md` at the workspace root — these are the new SDK-config surfaces the agent must not control.

**Tech stack:** TypeScript, vitest, `@anthropic-ai/claude-agent-sdk@0.2.119`, existing test-harness machinery, kind cluster for k8s-side acceptance.

**Related:**
- `docs/plans/2026-05-17-skill-install-workflow-design.md` (parent design)
- `packages/agent-claude-sdk-runner/src/main.ts:393-396` (current isolation choice — what we're partially unwinding)
- `packages/sandbox-subprocess/src/open-session.ts:260-333` (sessionEnv assembly — where the new vars land)
- `packages/sandbox-k8s/src/pod-spec.ts:148, 181-232` (env construction + HOME)
- Prior memory: `project_phase_a_spike_done.md` (HOME-redirect spike — context for the HOME work here)

---

## Phase 0 invariants (numbered, will be folded into the PR description)

These are the failure modes Phase 0 must not introduce. Each is a test target in the tasks below.

- **I-P0-1.** SDK isolation invariant survives. With `settingSources: ['user', 'project']`, the runner reads ONLY `<CLAUDE_CONFIG_DIR>/skills/` and `<cwd>/.claude/skills/` — not arbitrary `~/.claude/` content, not the host's project CLAUDE.md, not anything the agent could weaponize via writes to non-skill paths.
- **I-P0-2.** Agent cannot escalate SDK behavior by writing settings/instruction files. `workspace:pre-apply` vetoes writes to `<workspace>/.claude/settings.json`, `<workspace>/.claude/settings.local.json`, and `<workspace>/CLAUDE.md` from any actor that isn't `'host'`.
- **I-P0-3.** Per-session HOME is allocated by the sandbox, not inherited from the host process. In subprocess, HOME is a per-session tempdir; in k8s, HOME is `/home/runner` backed by a tmpfs/emptyDir mount. Cleanup is part of the existing session-end path.
- **I-P0-4.** The `.claude/skills` symlink is narrowly scoped — it points at `.ax/skills`, NOT at `.ax/` or `<workspace>` itself. The agent can't traverse out of skills by following the symlink.
- **I-P0-5.** Half-wired window is closed in the same PR. Runner + both sandbox plugins + CLI preset + k8s preset all land together. Canary acceptance test passes.

---

## File map (decomposition lock-in)

**Modify:**
- `packages/agent-claude-sdk-runner/src/main.ts` — `settingSources` + `allowedTools` change.
- `packages/sandbox-subprocess/src/open-session.ts` — HOME tempdir, CLAUDE_CONFIG_DIR env, skills dir scaffold, workspace symlink.
- `packages/sandbox-subprocess/src/close-session.ts` (or wherever cleanup lives) — HOME tempdir cleanup.
- `packages/sandbox-k8s/src/pod-spec.ts` — emptyDir volume for HOME, init-container that scaffolds `$HOME/.ax/session/skills/` + workspace symlink, env vars.
- `packages/validator-skill/src/plugin.ts` — veto rule for `.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE.md` writes from non-host actors.
- `packages/validator-skill/src/__tests__/plugin.test.ts` — new veto tests.
- `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` (if it exists; otherwise create) — `settingSources` assertion.
- `packages/sandbox-subprocess/src/__tests__/open-session.test.ts` — env + symlink + HOME tempdir assertions.
- `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts` — emptyDir + init-container assertions.
- `presets/cli/src/index.ts` and `presets/k8s/src/index.ts` — no plugin-list changes for Phase 0 (no new plugins land); confirmation-only audit.
- `packages/test-harness/src/canary/` (or wherever the canary lives) — extend the acceptance scenario to assert the `Skill` tool sees a workspace-authored SKILL.md.

**Create:**
- `docs/notes/2026-05-17-sdk-setting-sources-audit.md` — Task 1's verification artifact.

---

## Task 1: Verification spike — what does the SDK actually load from user/project sources?

This is **research, not code**. The output is a written audit at `docs/notes/2026-05-17-sdk-setting-sources-audit.md` that enumerates every file the SDK touches when `settingSources` includes `'user'` and `'project'`. The veto list in Task 2 is derived directly from this audit — if we miss a file the SDK reads, the isolation invariant has a hole.

**Files:**
- Create: `docs/notes/2026-05-17-sdk-setting-sources-audit.md`

- [ ] **Step 1: Locate setting-source loaders in the installed SDK.**

Run:
```bash
grep -n "settingSources\|setting_sources\|projectSettings\|userSettings\|loadSettings\|CLAUDE\\.md\|settings\\.json" \
  node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.119_zod@3.25.76/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs \
  | head -60
```

Expected: hits referencing `.claude/settings.json`, possibly `.claude/settings.local.json`, possibly `CLAUDE.md`. Note exact paths and the source key (`'user'` vs `'project'`) that loads each.

- [ ] **Step 2: Write the audit doc.**

Create `docs/notes/2026-05-17-sdk-setting-sources-audit.md` with the following sections, filled in from Step 1 findings:

```markdown
# SDK setting-source file audit (2026-05-17)

**SDK version:** `@anthropic-ai/claude-agent-sdk@0.2.119`
**Question:** With `settingSources: ['user', 'project']`, which files does the SDK read?

## Files loaded from `'user'` source (CLAUDE_CONFIG_DIR or ~/.claude)

| Path | Purpose | Required for skills? | Phase 0 stance |
|---|---|---|---|
| `<CLAUDE_CONFIG_DIR>/skills/*/SKILL.md` | Skill discovery | YES | Allow — empty in Phase 0 |
| `<CLAUDE_CONFIG_DIR>/settings.json` | … | NO | … |
| (…) | … | … | … |

## Files loaded from `'project'` source (cwd)

| Path | Purpose | Required for skills? | Phase 0 stance |
|---|---|---|---|
| `<cwd>/.claude/skills/*/SKILL.md` | Skill discovery | YES | Allow via symlink |
| `<cwd>/.claude/settings.json` | … | NO | Veto in validator |
| `<cwd>/.claude/settings.local.json` | … | NO | Veto in validator |
| `<cwd>/CLAUDE.md` | … | NO | Veto in validator |
| (…) | … | … | … |

## Veto list for Task 2

Paths the `workspace:pre-apply` validator must reject when authored by anything other than `actor: 'host'`:
- `.claude/settings.json`
- `.claude/settings.local.json`
- `CLAUDE.md`
- (any others from the audit)
```

- [ ] **Step 3: Commit.**

```bash
git add docs/notes/2026-05-17-sdk-setting-sources-audit.md
git commit -m "docs: audit SDK setting-source file loads for Phase 0"
```

---

## Task 2: Validator — veto agent writes to non-skill SDK-config paths

The veto list comes from Task 1's audit. The implementation extends `@ax/validator-skill`'s existing `workspace:pre-apply` subscriber to reject writes targeting those paths from non-host actors.

**Files:**
- Modify: `packages/validator-skill/src/plugin.ts`
- Test: `packages/validator-skill/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Add the failing tests.**

Append to `packages/validator-skill/src/__tests__/plugin.test.ts`:

```typescript
  it('vetoes agent-authored write to .claude/settings.json', async () => {
    const decision = await runValidator({
      actor: 'agent',
      changes: [
        {
          kind: 'add',
          path: '.claude/settings.json',
          content: new TextEncoder().encode('{}'),
        },
      ],
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('.claude/settings.json');
    expect(decision.reason).toMatch(/not writable by agent|host-only/i);
  });

  it('vetoes agent-authored write to .claude/settings.local.json', async () => {
    const decision = await runValidator({
      actor: 'agent',
      changes: [
        { kind: 'add', path: '.claude/settings.local.json',
          content: new TextEncoder().encode('{}') },
      ],
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('.claude/settings.local.json');
  });

  it('vetoes agent-authored write to CLAUDE.md', async () => {
    const decision = await runValidator({
      actor: 'agent',
      changes: [
        { kind: 'add', path: 'CLAUDE.md',
          content: new TextEncoder().encode('# pwned') },
      ],
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('CLAUDE.md');
  });

  it('allows host-authored write to .claude/settings.json', async () => {
    const decision = await runValidator({
      actor: 'host',
      changes: [
        { kind: 'add', path: '.claude/settings.json',
          content: new TextEncoder().encode('{}') },
      ],
    });
    expect(decision.allow).toBe(true);
  });

  it('allows agent writes that do not touch protected SDK-config paths', async () => {
    const decision = await runValidator({
      actor: 'agent',
      changes: [
        { kind: 'add', path: 'src/index.ts',
          content: new TextEncoder().encode('export {};') },
      ],
    });
    expect(decision.allow).toBe(true);
  });
```

(Note: the exact `runValidator` helper signature lives in the existing test file — match it. If `actor` isn't yet a parameter, extend the helper to default to `'agent'` and accept `'host'` as an override.)

- [ ] **Step 2: Run tests — expect failures.**

```bash
pnpm test --filter @ax/validator-skill -- plugin.test.ts
```

Expected: 5 new tests fail (the validator doesn't know these paths yet).

- [ ] **Step 3: Implement the veto.**

In `packages/validator-skill/src/plugin.ts`, add a constant and a check in the `workspace:pre-apply` subscriber (find the existing SKILL.md-frontmatter logic; the new check sits alongside it):

```typescript
// Paths the SDK reads when settingSources includes 'project'.
// Agent writes to these would let the model rewrite its own SDK
// configuration — the canonical capability-escalation path we're
// closing in Phase 0. Veto from any non-host actor.
//
// Audit source: docs/notes/2026-05-17-sdk-setting-sources-audit.md
const SDK_CONFIG_PATHS_PROJECT = new Set<string>([
  '.claude/settings.json',
  '.claude/settings.local.json',
  'CLAUDE.md',
]);

function isSdkConfigPath(path: string): boolean {
  return SDK_CONFIG_PATHS_PROJECT.has(path);
}

// Inside the pre-apply handler, before the existing SKILL.md branch:
for (const change of input.changes) {
  if (change.kind === 'delete') continue; // deletes by agent are fine
  if (isSdkConfigPath(change.path) && input.actor !== 'host') {
    return {
      allow: false,
      reason:
        `${change.path} is host-only: agent writes would escalate SDK ` +
        `configuration. See docs/notes/2026-05-17-sdk-setting-sources-audit.md.`,
    };
  }
}
```

- [ ] **Step 4: Run tests — expect pass.**

```bash
pnpm test --filter @ax/validator-skill -- plugin.test.ts
```

Expected: all tests in the file pass, including the 5 new ones.

- [ ] **Step 5: Run lint + typecheck on the whole repo.**

```bash
pnpm build && pnpm lint
```

Expected: no errors. (`pnpm build` will pick up the validator-skill type change.)

- [ ] **Step 6: Commit.**

```bash
git add packages/validator-skill/src/plugin.ts packages/validator-skill/src/__tests__/plugin.test.ts
git commit -m "feat(validator-skill): veto agent writes to SDK-config paths (I-P0-2)"
```

---

## Task 3: Runner — enable Skill discovery

Flip `settingSources: []` to `['user', 'project']` and add `'Skill'` to `allowedTools`. The change is one-character-deep; the test surface is what proves the isolation properties.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts:393-407`
- Test: `packages/agent-claude-sdk-runner/src/__tests__/main.test.ts` (create if absent)

- [ ] **Step 1: Locate the existing test for `query()` options assembly.**

```bash
grep -rn "settingSources\|allowedTools\|disallowedTools" packages/agent-claude-sdk-runner/src/__tests__/ | head -5
```

If a test file exists for these options, append to it. If not, the canary acceptance test in Task 6 covers them; skip the unit test in this task and rely on the canary.

- [ ] **Step 2: If a unit-test file exists, add the failing test.**

```typescript
// packages/agent-claude-sdk-runner/src/__tests__/main.test.ts (or wherever)

it('enables user + project setting sources so SDK loads skills', () => {
  const opts = buildQueryOptions(/* whatever fixtures the file already uses */);
  expect(opts.settingSources).toEqual(['user', 'project']);
});

it('includes Skill in allowedTools', () => {
  const opts = buildQueryOptions(/* … */);
  expect(opts.allowedTools).toContain('Skill');
});
```

(If `buildQueryOptions` isn't a separately-exported helper today, this is the moment to extract it. The reason is testability — the giant `query({ options: { … } })` call in `main.ts` is hard to assert on otherwise. Move the options-object construction into a pure function returning the options shape.)

- [ ] **Step 3: Run tests — expect failures.**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner
```

Expected: the 2 new assertions fail (settingSources is `[]`, Skill is not in allowedTools).

- [ ] **Step 4: Apply the change to main.ts.**

In `packages/agent-claude-sdk-runner/src/main.ts`, change line 396 from:

```typescript
        settingSources: [],
```

…to:

```typescript
        // settingSources: 'user' is required for the SDK to discover skills
        // under $CLAUDE_CONFIG_DIR/skills/ (host-controlled installed skills);
        // 'project' is required for skills under <workspace>/.claude/skills/
        // (which is a symlink to .ax/skills/, the agent-authored convention).
        //
        // Agent cannot escalate SDK behavior via these sources because:
        //  - the SDK's other user/project files (.claude/settings.json,
        //    CLAUDE.md) are vetoed at the workspace:pre-apply boundary
        //    (see @ax/validator-skill);
        //  - the workspace symlink points narrowly at `.ax/skills`, not at
        //    the parent `.claude/` directory;
        //  - $HOME is a per-session tempdir/emptyDir, isolated from the
        //    host user's ~/.claude.
        //
        // I-P0-1 in 2026-05-17-skill-install-phase-0-impl.md.
        settingSources: ['user', 'project'],
```

…and update the `allowedTools` argument (find it in the same options object; should be a few lines up — currently passes `allowedTools` derived from `agentConfig.allowedTools`). Add `'Skill'` unconditionally:

```typescript
        allowedTools: ['Skill', ...agentConfig.allowedTools],
        disallowedTools: [...DISABLED_BUILTINS],
```

- [ ] **Step 5: Run tests — expect pass.**

```bash
pnpm test --filter @ax/agent-claude-sdk-runner
```

Expected: pass.

- [ ] **Step 6: Run typecheck + lint.**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 7: Commit.**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts \
        packages/agent-claude-sdk-runner/src/__tests__/main.test.ts
git commit -m "feat(runner): enable Skill discovery via user+project setting sources (I-P0-1)"
```

---

## Task 4: Sandbox-subprocess — per-session HOME + CLAUDE_CONFIG_DIR + symlink

The subprocess sandbox already has a per-session tempdir (for the IPC socket + MITM CA PEM). Extend that tempdir to host a `home/` subtree and point HOME + CLAUDE_CONFIG_DIR at it. Pre-create `$HOME/.ax/session/skills/` (empty). Create the workspace symlink.

**Files:**
- Modify: `packages/sandbox-subprocess/src/open-session.ts:260-333` (sessionEnv assembly) + cleanup path.
- Test: `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`

- [ ] **Step 1: Add the failing test.**

Append to `packages/sandbox-subprocess/src/__tests__/open-session.test.ts`:

```typescript
  it('allocates a per-session HOME tempdir and sets CLAUDE_CONFIG_DIR under it', async () => {
    const result = await openSession({
      workspaceRoot: tmpWorkspace,
      // … existing fixtures …
    });
    // The child process recipe is captured in the test seam — assert on env.
    expect(result.recipe.env.HOME).toBeDefined();
    expect(result.recipe.env.HOME).not.toBe(process.env.HOME);
    expect(result.recipe.env.CLAUDE_CONFIG_DIR)
      .toBe(path.join(result.recipe.env.HOME!, '.ax', 'session'));
    // The skills directory must exist on disk before the runner starts.
    const skillsDir = path.join(result.recipe.env.CLAUDE_CONFIG_DIR!, 'skills');
    await expect(fs.stat(skillsDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    // Closing the session must clean it up.
    await closeSession(result.sessionId);
    await expect(fs.stat(skillsDir)).rejects.toThrow();
  });

  it('symlinks <workspace>/.claude/skills to ../.ax/skills', async () => {
    const result = await openSession({
      workspaceRoot: tmpWorkspace,
      // … existing fixtures …
    });
    const linkPath = path.join(tmpWorkspace, '.claude', 'skills');
    const linkTarget = await fs.readlink(linkPath);
    expect(linkTarget).toBe('../.ax/skills');
    // Symlink resolves to a real directory after the sandbox pre-creates it.
    const resolved = path.resolve(path.dirname(linkPath), linkTarget);
    expect(resolved).toBe(path.join(tmpWorkspace, '.ax', 'skills'));
  });

  it('does not symlink the parent .claude/ directory — only .claude/skills/', async () => {
    const result = await openSession({ workspaceRoot: tmpWorkspace /* … */ });
    const claudeDirStat = await fs.lstat(path.join(tmpWorkspace, '.claude'));
    // .claude itself is a regular directory, NOT a symlink.
    expect(claudeDirStat.isSymbolicLink()).toBe(false);
    expect(claudeDirStat.isDirectory()).toBe(true);
    // Only the skills subdirectory is the symlink.
    const skillsStat = await fs.lstat(path.join(tmpWorkspace, '.claude', 'skills'));
    expect(skillsStat.isSymbolicLink()).toBe(true);
  });
```

- [ ] **Step 2: Run tests — expect failures.**

```bash
pnpm test --filter @ax/sandbox-subprocess -- open-session.test.ts
```

Expected: 3 new tests fail.

- [ ] **Step 3: Implement HOME + CLAUDE_CONFIG_DIR + skills dir.**

In `packages/sandbox-subprocess/src/open-session.ts`, after the existing `socketDir` allocation and BEFORE the `sessionEnv` declaration (~line 260), add:

```typescript
  // I-P0-3: per-session HOME, isolated from the host user's home.
  // Reuses the same per-session tempdir root as the IPC socket; cleanup
  // piggybacks on the existing socketDir cleanup path.
  const homeDir = path.join(socketDir, 'home');
  const claudeConfigDir = path.join(homeDir, '.ax', 'session');
  const installedSkillsDir = path.join(claudeConfigDir, 'skills');
  await fs.mkdir(installedSkillsDir, { recursive: true, mode: 0o755 });
  // Phase 1 will materialize installed-skill bodies here. For Phase 0 the
  // directory is empty but must exist so the SDK's discovery walk doesn't
  // ENOENT. chmod 0555 only AFTER Phase 1 writes — in Phase 0 the dir
  // stays 0755 (writable) since nothing writes here yet; locking it down
  // here would be theater.

  // I-P0-4: narrow symlink. Workspace `.claude/` must exist as a real
  // directory; only the `skills` child is symlinked into `.ax/skills/`.
  const workspaceClaudeDir = path.join(input.workspaceRoot, '.claude');
  await fs.mkdir(workspaceClaudeDir, { recursive: true, mode: 0o755 });
  const workspaceAxSkillsDir = path.join(input.workspaceRoot, '.ax', 'skills');
  await fs.mkdir(workspaceAxSkillsDir, { recursive: true, mode: 0o755 });
  const symlinkPath = path.join(workspaceClaudeDir, 'skills');
  // Idempotency: if the symlink already exists (re-entry on a workspace
  // that survived a prior session), unlink first. Don't follow it — if
  // it's something other than the expected symlink we want to know.
  await fs.rm(symlinkPath, { force: true });
  await fs.symlink('../.ax/skills', symlinkPath);
```

Then in the `sessionEnv` block (~line 260), add:

```typescript
  const sessionEnv: Record<string, string> = {
    AX_RUNNER_ENDPOINT: runnerEndpoint,
    AX_SESSION_ID: created.sessionId,
    AX_AUTH_TOKEN: created.token,
    AX_WORKSPACE_ROOT: input.workspaceRoot,
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
```

(The HOME override here is important: see the comment at line 324-332 about session-scoped keys winning over the parent allowlist. HOME is in the allowlist; sessionEnv takes precedence by merge order.)

- [ ] **Step 4: Run tests — expect pass.**

```bash
pnpm test --filter @ax/sandbox-subprocess -- open-session.test.ts
```

Expected: 3 new tests pass; existing tests remain green.

- [ ] **Step 5: Run typecheck + lint.**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 6: Commit.**

```bash
git add packages/sandbox-subprocess/src/open-session.ts \
        packages/sandbox-subprocess/src/__tests__/open-session.test.ts
git commit -m "feat(sandbox-subprocess): per-session HOME + CLAUDE_CONFIG_DIR + skills symlink (I-P0-3/4)"
```

---

## Task 5: Sandbox-k8s — emptyDir HOME + init-container scaffolding

K8s is trickier: HOME is currently `/nonexistent`, and pod-level filesystem prep needs an init container (the main container's filesystem must be ready when it starts). The init container creates the skills directory under the HOME emptyDir mount and the symlink under the workspace mount.

**Files:**
- Modify: `packages/sandbox-k8s/src/pod-spec.ts:148, 181-232`
- Test: `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`

- [ ] **Step 1: Add the failing tests.**

Append to `packages/sandbox-k8s/src/__tests__/pod-spec.test.ts`:

```typescript
  it('mounts an emptyDir at /home/runner with HOME pointing at it', () => {
    const pod = buildPodSpec(/* existing test fixture inputs */);
    const homeVolume = pod.spec!.volumes!.find((v) => v.name === 'home');
    expect(homeVolume).toBeDefined();
    expect(homeVolume!.emptyDir).toEqual({ medium: 'Memory' });
    const homeMount = pod.spec!.containers![0].volumeMounts!.find(
      (m) => m.mountPath === '/home/runner',
    );
    expect(homeMount).toBeDefined();
    expect(homeMount!.name).toBe('home');
    const homeEnv = pod.spec!.containers![0].env!.find((e) => e.name === 'HOME');
    expect(homeEnv!.value).toBe('/home/runner');
  });

  it('sets CLAUDE_CONFIG_DIR to $HOME/.ax/session', () => {
    const pod = buildPodSpec(/* … */);
    const ccd = pod.spec!.containers![0].env!.find((e) => e.name === 'CLAUDE_CONFIG_DIR');
    expect(ccd!.value).toBe('/home/runner/.ax/session');
  });

  it('includes an init container that pre-creates the skills dir and workspace symlink', () => {
    const pod = buildPodSpec(/* … */);
    const init = pod.spec!.initContainers ?? [];
    expect(init.length).toBeGreaterThanOrEqual(1);
    const skillsInit = init.find((c) => c.name === 'sdk-scaffold');
    expect(skillsInit).toBeDefined();
    // Init container mounts both HOME and workspace so it can prep both.
    const mounts = skillsInit!.volumeMounts!.map((m) => m.name);
    expect(mounts).toContain('home');
    expect(mounts).toContain('workspace');
    // Its command creates the skills dir and the symlink.
    const cmdJoined = (skillsInit!.command ?? []).concat(skillsInit!.args ?? []).join(' ');
    expect(cmdJoined).toContain('/home/runner/.ax/session/skills');
    expect(cmdJoined).toContain('ln -s ../.ax/skills');
  });
```

- [ ] **Step 2: Run tests — expect failures.**

```bash
pnpm test --filter @ax/sandbox-k8s -- pod-spec.test.ts
```

Expected: 3 new tests fail.

- [ ] **Step 3: Implement HOME emptyDir + env + init container.**

In `packages/sandbox-k8s/src/pod-spec.ts`:

1. Change line 148 (`{ name: 'HOME', value: '/nonexistent' }`) to:

   ```typescript
   { name: 'HOME', value: '/home/runner' },
   { name: 'CLAUDE_CONFIG_DIR', value: '/home/runner/.ax/session' },
   ```

2. Add an emptyDir volume to the pod spec (find the existing `volumes` array; add):

   ```typescript
   {
     name: 'home',
     emptyDir: { medium: 'Memory' },
   },
   ```

3. Add a volume mount on the main container (find `volumeMounts`; add):

   ```typescript
   { name: 'home', mountPath: '/home/runner' },
   ```

4. Add (or extend) an `initContainers` array on the pod spec:

   ```typescript
   initContainers: [
     {
       name: 'sdk-scaffold',
       image: pc.runnerImage, // same image as the main container; busybox would also work
       command: ['/bin/sh', '-c'],
       args: [
         [
           'set -eu',
           'mkdir -p /home/runner/.ax/session/skills',
           // chmod 0555 deferred to Phase 1 — see subprocess comment for rationale.
           'mkdir -p /workspace/.claude',
           'mkdir -p /workspace/.ax/skills',
           // Idempotency: rm -f the symlink target (and only the target) before creating.
           'rm -f /workspace/.claude/skills',
           'ln -s ../.ax/skills /workspace/.claude/skills',
         ].join(' && '),
       ],
       volumeMounts: [
         { name: 'home', mountPath: '/home/runner' },
         { name: 'workspace', mountPath: '/workspace' },
       ],
       securityContext: {
         runAsUser: 1000, // match the main container's user
         runAsNonRoot: true,
         readOnlyRootFilesystem: true,
         capabilities: { drop: ['ALL'] },
       },
     },
     // … any existing init containers …
   ],
   ```

   (Confirm `runAsUser: 1000` matches the existing pod's user; if the pod uses a different uid, match it. The init container must write to the same uid as the main container so the main container can read what the init container created.)

- [ ] **Step 4: Run tests — expect pass.**

```bash
pnpm test --filter @ax/sandbox-k8s -- pod-spec.test.ts
```

Expected: 3 new tests pass; existing tests remain green.

- [ ] **Step 5: Run typecheck + lint.**

```bash
pnpm build && pnpm lint
```

- [ ] **Step 6: Commit.**

```bash
git add packages/sandbox-k8s/src/pod-spec.ts \
        packages/sandbox-k8s/src/__tests__/pod-spec.test.ts
git commit -m "feat(sandbox-k8s): emptyDir HOME + init-container skills scaffold (I-P0-3/4)"
```

---

## Task 6: Canary acceptance test — workspace SKILL.md is discoverable end-to-end

The unit tests cover env and symlink shape; the canary proves the SDK actually loads a workspace-authored SKILL.md via the symlink. This is the only test that exercises the SDK's `Skill` tool path.

**Files:**
- Modify: `packages/test-harness/src/canary/<existing>.test.ts` (find the canary; extend it) or create `packages/test-harness/src/canary/skill-discovery.test.ts` if a dedicated test makes more sense.

- [ ] **Step 1: Locate the existing canary scenario.**

```bash
grep -rn "canary\|MANUAL-ACCEPTANCE\|acceptance" packages/test-harness/src/ | head -10
ls packages/test-harness/src/canary/ 2>/dev/null
```

Identify the canary scenario file and read it (~30 lines around the SDK invocation). Pick the integration point: ideally, immediately after the runner starts, before the first user turn.

- [ ] **Step 2: Add the failing test.**

If extending the existing canary, add a new step BEFORE the first turn:

```typescript
it('agent sees a workspace-authored skill via the SDK Skill tool', async () => {
  // Write a workspace skill at the canonical .ax/skills/ path.
  // The sandbox symlinks .claude/skills -> .ax/skills before the
  // runner starts, so the SDK's project-source discovery sees it.
  const skillDir = path.join(workspaceRoot, '.ax', 'skills', 'canary-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: canary-skill',
      'description: Phase-0 canary: assert the agent can discover this skill.',
      '---',
      '',
      '# Canary Skill',
      '',
      'When asked about your skills, mention "canary-skill" by name.',
      '',
    ].join('\n'),
  );

  // Run a turn that prompts the agent to enumerate its skills.
  const result = await runOneTurn({
    workspaceRoot,
    userMessage: 'List the names of every skill you have available.',
  });

  // Assert the SDK's Skill tool was invoked and surfaced canary-skill.
  expect(result.transcript).toMatch(/canary-skill/);
  // Also verify via tool-call inspection that the Skill tool fired at
  // least once during the turn.
  const skillToolCalls = result.toolCalls.filter((c) => c.name === 'Skill');
  expect(skillToolCalls.length).toBeGreaterThanOrEqual(1);
});
```

(If the canary is structured differently — runs against a real kind cluster, uses Playwright, etc. — adapt the assertion shape. The substantive check is "the model can name the skill" + "the Skill tool was invoked.")

- [ ] **Step 3: Run the canary — expect failure.**

```bash
pnpm test --filter @ax/test-harness -- canary
```

Expected: the new assertion fails because the SDK doesn't yet discover the skill. (If Tasks 3-5 are already merged, it will pass — adjust ordering.)

- [ ] **Step 4: Verify all Phase 0 changes are present.**

Run the full test suite:

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: green.

- [ ] **Step 5: Run the k8s side of the canary against a kind cluster.**

If the project has a `make` target or script for this (see `k8s-acceptance-loop` skill for the workflow), invoke it. Otherwise, the manual walk in `deploy/MANUAL-ACCEPTANCE.md` should be extended with one new bullet: "agent enumerates its skills; canary-skill appears."

```bash
# Adjust to your project's k8s loop
make dev-fast && make canary-k8s
```

Expected: same green outcome in cluster as in unit tests.

- [ ] **Step 6: Commit.**

```bash
git add packages/test-harness/src/canary/ deploy/MANUAL-ACCEPTANCE.md
git commit -m "test(canary): assert SDK discovers workspace-authored skills (I-P0-5)"
```

---

## Task 7: PR description with invariants audit

The half-wired-window pattern requires the PR description to explicitly call out window status. For Phase 0, no plugin is added — the window is open differently: the `settingSources` flip + sandbox env changes are coordinated and must ship together. The PR description names the invariants and links each to its test.

- [ ] **Step 1: Stage all commits as a single PR-ready branch.**

```bash
git log --oneline origin/main..HEAD
```

Expected: ~6 commits (docs audit, validator, runner, sandbox-subprocess, sandbox-k8s, canary).

- [ ] **Step 2: Open the PR.**

```bash
gh pr create --title "feat(skills): Phase 0 — enable SDK Skill discovery via user+project setting sources" --body "$(cat <<'EOF'
## Summary

Wires `@anthropic-ai/claude-agent-sdk@0.2.119` to discover SKILL.md files from both `.ax/skills/` (workspace) and `$HOME/.ax/session/skills/` (host-controlled, future install target). Prerequisite for the installed-skills workflow drafted at `docs/plans/2026-05-17-skill-install-workflow-design.md`.

Without this change, workspace-authored SKILL.md files validated by `@ax/validator-skill` were invisible to the SDK — `settingSources` was `[]`, intentionally.

## Phase 0 invariants

- **I-P0-1.** SDK isolation invariant survives — the runner only reads narrow skill paths, not arbitrary user/project SDK config. Covered by `validator-skill` veto (Task 2) + narrow symlink (Tasks 4/5).
- **I-P0-2.** Agent cannot escalate SDK behavior via writes to `.claude/settings.json`, `.claude/settings.local.json`, or `CLAUDE.md`. Veto tests in `@ax/validator-skill`.
- **I-P0-3.** Per-session HOME, isolated from the host. Subprocess: tempdir under existing per-session dir. K8s: emptyDir volume mounted at `/home/runner`.
- **I-P0-4.** Symlink scope narrow — `<workspace>/.claude/skills` → `<workspace>/.ax/skills`, not the parent `.claude/` directory.
- **I-P0-5.** No half-wired window — runner + both sandbox plugins + canary test land together. Canary asserts a workspace SKILL.md is discoverable end-to-end via the SDK's `Skill` tool.

## Boundary review

- **Alternate impl this hook could have:** N/A — this PR adds no new hooks. It tweaks an existing intra-plugin code path (runner options, sandbox env) and extends an existing subscriber (`workspace:pre-apply` in `@ax/validator-skill`).
- **Payload field names that might leak:** none new.
- **Subscriber risk:** none new.

## Test plan

- [x] Unit: validator veto tests (5 new)
- [x] Unit: runner `settingSources` + `allowedTools` assertions
- [x] Unit: sandbox-subprocess HOME + CLAUDE_CONFIG_DIR + symlink
- [x] Unit: sandbox-k8s emptyDir + init container
- [x] Canary: workspace SKILL.md discoverable end-to-end
- [x] `pnpm build && pnpm test && pnpm lint` clean
- [ ] Manual: extend `deploy/MANUAL-ACCEPTANCE.md` with skill-discovery bullet, walk on kind cluster

## Follow-ups (out of this PR)

- Phase 1: `@ax/skills` package, manifest schema with `capabilities` block, admin HTTP CRUD, validator extension for installed-source `capabilities` honoring. See `2026-05-17-skill-install-workflow-design.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Note the PR URL.**

The PR URL `gh pr create` printed is the outcome to surface back to the user.

---

## Self-review

**1. Spec coverage:** Every section of the design doc that's relevant to Phase 0 is covered by a task:
- "Phase 0 prerequisite: wire the SDK to discover skills at all" → Tasks 3, 4, 5.
- Workspace-skill capability strip-and-warn → already exists in `@ax/validator-skill` (not changed in Phase 0; Phase 1 will extend).
- The two SDK-contract corrections (CLAUDE_CONFIG_DIR redirect + symlink) → Tasks 4, 5.
- The "secure agent writes to .claude/settings.json" gap I caught while grounding the plan → Task 2 (new from the design doc; should also be folded back into the design doc as an explicit invariant I-P0-2).

**2. Placeholder scan:** No TBDs, no "implement appropriately", no "similar to Task N". Each step has concrete code or a concrete command.

**3. Type consistency:** `sessionEnv` (subprocess) and the pod-spec `env` array (k8s) are the two surfaces that set `HOME` and `CLAUDE_CONFIG_DIR`. Both use the same path: `<homeDir>/.ax/session`. Symlink target is `../.ax/skills` (relative) in both. Names consistent: `homeDir`, `claudeConfigDir`, `installedSkillsDir`.

**4. Risks worth restating before execution:**
- The runner's `settingSources: []` choice predates this design and may have been load-bearing in ways I haven't traced. If Task 3 breaks an existing test or behavior in subtle ways (e.g., the SDK picks up settings from a parent CLAUDE.md on developer laptops), Task 1's audit MUST catch it. If audit reveals more SDK-config paths than just the three in Task 2's initial veto list, EXTEND the veto list before merging.
- The k8s init container needs the same image as the main container OR a stable utility image (busybox). Using the same image is simpler but slower to spin up; busybox is faster but adds an image dependency. Pick whichever pattern the repo already uses for init containers (if any); default to same-image for Phase 0 if no precedent exists.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-17-skill-install-phase-0-impl.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for keeping this main context clean while Phase 0 lands.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch with checkpoints for review.

Which approach?
