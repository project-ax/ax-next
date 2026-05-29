# Skill Authoring Phase 3 — Bundle-Native Projection + Re-spawn — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the read-only host `user` projection (`$CLAUDE_CONFIG_DIR/skills/`, `0555`) the single skill-discovery chokepoint, fed from cleared workspace `.ax/draft-skills/` bundles (quarantined ones omitted), then delete the `install_authored_skill` transaction, stop retiring the draft, and re-spawn on active-set change.

**Architecture:** Two stacked PRs. **PR-A** swaps discovery from the runner-local `project` symlink to a host projection of workspace drafts (atomic — no dual-discovery), with quarantined drafts omitted. **PR-B** deletes the transaction + promotion + draft-retire and adds an in-memory session-dirty → next-turn-re-spawn trigger driven by a `workspace:applied` subscriber.

**Tech Stack:** TypeScript, pnpm monorepo (tsconfig refs + changesets), Vitest, the in-process `HookBus` (services + subscribers), `@ax/skills-parser` (`splitSkillMd` / `parseSkillManifest`), `@anthropic-ai/claude-agent-sdk` (the runner's `settingSources`).

**Design doc:** `docs/plans/2026-05-29-skill-authoring-phase-3-bundle-projection-design.md`
**Parent design:** `docs/plans/2026-05-29-skill-authoring-lazy-redesign-design.md`

---

## Conventions for every task

- Build one package: `pnpm build --filter @ax/<pkg>`. Test one package: `pnpm test --filter @ax/<pkg>`. Pre-PR gate is **build + test + lint** (`pnpm build && pnpm test && pnpm lint`).
- `pnpm lint` exits 1 on stale `.worktrees/` copies that are not your branch — scope eslint to changed files to judge your own work (e.g. `pnpm exec eslint <files>`).
- Invariant #2 (no cross-plugin imports): the orchestrator and `@ax/agents` describe each other's hook payloads with **local structural types**, never an import.
- Commit after each task with a descriptive message ending in the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

# PR-A — Discovery-path swap (window OPEN)

Branch: `feat/skill-authoring-phase-3-projection` (already created off `main`; the design doc is committed here).

## Task A1: `@ax/agents` — `listAuthoredBundles` (read all drafts as projection bundles)

`listAuthoredSkills` returns *summaries* (no `manifestYaml`, no helper `files`); the projection needs the raw `manifestYaml` + `bodyMd` + helper files per draft, skipping malformed ones (non-blocking). Add a sibling reader.

**Files:**
- Modify: `packages/agents/src/authored-skills.ts`
- Test: `packages/agents/src/__tests__/authored-skills.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/agents/src/__tests__/authored-skills.test.ts` (reuse the file's existing mock-workspace harness — copy the setup pattern already used by the `listAuthoredSkills` tests in this file):

```ts
import { listAuthoredBundles } from '../authored-skills.js';

describe('listAuthoredBundles', () => {
  it('returns each parseable draft as a projection bundle with raw manifestYaml + helper files, skipping malformed', async () => {
    const { bus } = makeWorkspaceBackedBus(); // same helper the listAuthoredSkills tests use
    // valid directory-form draft with a helper file
    await writeDraft(bus, 'good', {
      'SKILL.md': '---\nname: good\ndescription: a good skill\n---\nDo the thing.\n',
      'scripts/run.sh': 'echo hi\n',
    });
    // malformed (no frontmatter fence) — must be SKIPPED, never throw
    await writeDraft(bus, 'broken', { 'SKILL.md': 'no frontmatter here\n' });

    const bundles = await listAuthoredBundles(bus, 'user-1', 'agent-1');

    expect(bundles.map((b) => b.id)).toEqual(['good']); // sorted, malformed skipped
    const good = bundles[0]!;
    expect(good.manifestYaml).toContain('name: good');
    expect(good.bodyMd).toContain('Do the thing.');
    expect(good.files).toEqual([{ path: 'scripts/run.sh', contents: 'echo hi\n' }]);
  });

  it('returns [] when no workspace backend is loaded (soft-dep)', async () => {
    const bus = new HookBus(); // no workspace:list / workspace:read
    expect(await listAuthoredBundles(bus, 'u', 'a')).toEqual([]);
  });
});
```

> If `makeWorkspaceBackedBus` / `writeDraft` helpers don't already exist in this test file, mirror the exact mock-workspace wiring the existing `listAuthoredSkills` describe-block uses (it registers `workspace:list` + `workspace:read` over an in-memory map). Do **not** invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/agents -- authored-skills`
Expected: FAIL — `listAuthoredBundles is not a function`.

- [ ] **Step 3: Implement `listAuthoredBundles`**

Add to `packages/agents/src/authored-skills.ts` (after `listAuthoredSkills`). Reuse the existing `AUTHORED_SKILL_ID_RE` and `splitSkillMd` / `parseSkillManifest` already imported in this file:

```ts
/** A self-authored draft in projection shape: raw frontmatter + body + helper files. */
export interface AuthoredProjectionBundle {
  id: string;
  manifestYaml: string;
  bodyMd: string;
  files: AuthoredBundleFile[];
}

/**
 * Read EVERY parseable self-authored draft under `.ax/draft-skills/` as a
 * projection bundle (raw `manifestYaml` + `bodyMd` + helper files). Unlike
 * `readAuthoredBundle` (one id, throws on malformed) this is the host
 * discovery-projection source: a malformed SKILL.md is SKIPPED (logged-by-
 * omission, never thrown) so one bad draft can't break discovery for the rest.
 * Capabilities are NOT parsed here — Phase 3 projects drafts with empty caps;
 * Phase 4 adds approval. Same ctx-routing as listAuthoredSkills (root a fresh
 * ctx in the agent owner's identity). Soft-dep: no workspace backend → [].
 */
export async function listAuthoredBundles(
  bus: HookBus,
  ownerUserId: string,
  agentId: string,
): Promise<AuthoredProjectionBundle[]> {
  if (!bus.hasService('workspace:list') || !bus.hasService('workspace:read')) {
    return [];
  }
  const ctx = makeAgentContext({
    userId: ownerUserId,
    agentId,
    sessionId: 'authored-bundles-projection',
  });

  // Enumerate draft ids from both accepted shapes (directory wins on dup id),
  // mirroring listAuthoredSkills.
  const [dirRes, flatRes] = await Promise.all([
    bus.call<{ pathGlob: string }, { paths: string[] }>('workspace:list', ctx, {
      pathGlob: '.ax/draft-skills/*/SKILL.md',
    }),
    bus.call<{ pathGlob: string }, { paths: string[] }>('workspace:list', ctx, {
      pathGlob: '.ax/draft-skills/*.md',
    }),
  ]);
  const ids = new Set<string>();
  for (const p of dirRes.paths) {
    const m = /^\.ax\/draft-skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (m) ids.add(m[1]!);
  }
  for (const p of flatRes.paths) {
    const m = /^\.ax\/draft-skills\/([^/]+)\.md$/.exec(p);
    if (m && AUTHORED_SKILL_ID_RE.test(m[1]!)) ids.add(m[1]!);
  }

  const out: AuthoredProjectionBundle[] = [];
  for (const id of [...ids].sort()) {
    // readAuthoredBundle throws on malformed; for the projection we want to
    // SKIP instead. Read the dir form first, fall back to flat, and split
    // without throwing.
    const dir = `.ax/draft-skills/${id}`;
    const { paths } = await bus.call<{ pathGlob: string }, { paths: string[] }>(
      'workspace:list', ctx, { pathGlob: `${dir}/**` },
    );
    let manifestYaml: string | null = null;
    let bodyMd = '';
    const files: AuthoredBundleFile[] = [];
    let sawDir = false;
    for (const p of [...paths].sort()) {
      const read = await bus.call<
        { path: string },
        { found: true; bytes: Uint8Array } | { found: false }
      >('workspace:read', ctx, { path: p });
      if (!read.found) continue;
      const rel = p.slice(dir.length + 1);
      if (rel.length === 0) continue;
      sawDir = true;
      const text = new TextDecoder().decode(read.bytes);
      if (rel === 'SKILL.md') {
        const split = splitSkillMd(text);
        if (split === null || !parseSkillManifest(split.manifestYaml).ok) continue; // skip malformed
        manifestYaml = split.manifestYaml;
        bodyMd = split.bodyMd;
      } else {
        files.push({ path: rel, contents: text });
      }
    }
    if (manifestYaml === null && !sawDir) {
      // flat form fallback: .ax/draft-skills/<id>.md
      const flat = await bus.call<
        { path: string },
        { found: true; bytes: Uint8Array } | { found: false }
      >('workspace:read', ctx, { path: `${dir}.md` });
      if (flat.found) {
        const split = splitSkillMd(new TextDecoder().decode(flat.bytes));
        if (split !== null && parseSkillManifest(split.manifestYaml).ok) {
          manifestYaml = split.manifestYaml;
          bodyMd = split.bodyMd;
        }
      }
    }
    if (manifestYaml === null) continue; // no valid SKILL.md → not discoverable
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    out.push({ id, manifestYaml, bodyMd, files });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter @ax/agents -- authored-skills`
Expected: PASS (both new cases + all existing `listAuthoredSkills` tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/authored-skills.ts packages/agents/src/__tests__/authored-skills.test.ts
git commit -m "feat(agents): listAuthoredBundles — projection source for self-authored drafts"
```

## Task A2: `@ax/agents` — register `agents:resolve-authored-skills` (quarantine-filter + empty caps)

The host-side service the orchestrator unions in. Returns drafts in the resolved-skill projection shape with **empty** capabilities, omitting quarantined ones via `skills:quarantine-get` (soft-dep).

**Files:**
- Modify: `packages/agents/src/plugin.ts` (manifest `registers` + a `bus.registerService` block)
- Modify: `packages/agents/src/types.ts` (the new I/O types)
- Test: `packages/agents/src/__tests__/plugin.test.ts` (or the file where `agents:*` services are tested — match the existing pattern)

- [ ] **Step 1: Add the I/O types**

In `packages/agents/src/types.ts`:

```ts
/** Resolved-skill projection shape (structurally mirrors the orchestrator's
 * ResolvedSkillForOrch — NOT an @ax/skills import, per invariant #2). */
export interface AuthoredResolvedSkill {
  id: string;
  capabilities: {
    allowedHosts: string[];
    credentials: Array<{ slot: string; kind: string }>;
    mcpServers: never[]; // empty in Phase 3
    packages: { npm: string[]; pypi: string[] };
  };
  bodyMd: string;
  manifestYaml: string;
  files: Array<{ path: string; contents: string }>;
}
export interface AgentsResolveAuthoredSkillsInput {
  ownerUserId: string;
  agentId: string;
}
export interface AgentsResolveAuthoredSkillsOutput {
  skills: AuthoredResolvedSkill[];
}
```

- [ ] **Step 2: Write the failing test**

Add (matching the existing `agents:*` service test harness in this package):

```ts
it('agents:resolve-authored-skills returns non-quarantined drafts with empty caps', async () => {
  const { bus } = makeWorkspaceBackedBus();
  // a quarantine store that flags exactly 'evil'
  bus.registerService('skills:quarantine-get', '@ax/test', async (_c, i: any) => ({
    quarantined: i.skillId === 'evil',
    ...(i.skillId === 'evil' ? { reason: 'injection' } : {}),
  }));
  registerAgentsPlugin(bus, /* deps */); // however this package wires its plugin in tests
  await writeDraft(bus, 'good', { 'SKILL.md': '---\nname: good\ndescription: ok\n---\nBody\n' });
  await writeDraft(bus, 'evil', { 'SKILL.md': '---\nname: evil\ndescription: bad\n---\nBody\n' });

  const out = await bus.call('agents:resolve-authored-skills', ctx, {
    ownerUserId: 'user-1', agentId: 'agent-1',
  });

  expect(out.skills.map((s: any) => s.id)).toEqual(['good']); // 'evil' omitted
  expect(out.skills[0].capabilities).toEqual({
    allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] },
  });
  expect(out.skills[0].manifestYaml).toContain('name: good');
});

it('agents:resolve-authored-skills returns all drafts when quarantine store is absent (soft-dep)', async () => {
  const { bus } = makeWorkspaceBackedBus();
  registerAgentsPlugin(bus, /* deps */);
  await writeDraft(bus, 'good', { 'SKILL.md': '---\nname: good\ndescription: ok\n---\nBody\n' });
  const out = await bus.call('agents:resolve-authored-skills', ctx, { ownerUserId: 'user-1', agentId: 'agent-1' });
  expect(out.skills.map((s: any) => s.id)).toEqual(['good']);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test --filter @ax/agents -- plugin`
Expected: FAIL — `no service registered for agents:resolve-authored-skills`.

- [ ] **Step 4: Register the service + add to the manifest**

In `packages/agents/src/plugin.ts`, add `'agents:resolve-authored-skills'` to the manifest `registers` array, and register:

```ts
bus.registerService<AgentsResolveAuthoredSkillsInput, AgentsResolveAuthoredSkillsOutput>(
  'agents:resolve-authored-skills',
  PLUGIN_NAME,
  async (_ctx, input) => {
    const bundles = await listAuthoredBundles(bus, input.ownerUserId, input.agentId);
    const skills: AuthoredResolvedSkill[] = [];
    for (const b of bundles) {
      // Quarantine gate — the real Phase-3 discovery enforcement. Soft-dep:
      // a preset without the skills store projects everything (no regression).
      if (bus.hasService('skills:quarantine-get')) {
        const q = await bus.call<
          { ownerUserId: string; agentId: string; skillId: string },
          { quarantined: boolean; reason?: string }
        >('skills:quarantine-get', _ctx, {
          ownerUserId: input.ownerUserId, agentId: input.agentId, skillId: b.id,
        });
        if (q.quarantined) continue; // omit — the model never sees its name/description
      }
      skills.push({
        id: b.id,
        capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
        bodyMd: b.bodyMd,
        manifestYaml: b.manifestYaml,
        files: b.files,
      });
    }
    return { skills };
  },
  { returns: AgentsResolveAuthoredSkillsOutputSchema },
);
```

> Add a Zod `AgentsResolveAuthoredSkillsOutputSchema` next to the other `*OutputSchema`s in this package (match the existing pattern — `z.object({ skills: z.array(...) })`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test --filter @ax/agents -- plugin`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agents/src/plugin.ts packages/agents/src/types.ts packages/agents/src/__tests__/
git commit -m "feat(agents): agents:resolve-authored-skills — quarantine-filtered draft projection (empty caps)"
```

## Task A3: orchestrator — union authored drafts FIRST (highest precedence)

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (the skill-union block, currently `:1379–1405`)
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator*.test.ts` (the file covering the skill union / installedSkills)

- [ ] **Step 1: Write the failing test**

In the orchestrator test that asserts `installedSkillsForSandbox` / the sandbox skill set (find the existing test that mocks `skills:resolve` + `skills:list-defaults` and inspects `sandbox:open-session` input), add:

```ts
it('unions self-authored drafts into the sandbox skill set, drafts win on id collision', async () => {
  // existing harness: registers skills:resolve, skills:list-defaults, sandbox:open-session spy
  bus.registerService('agents:resolve-authored-skills', '@ax/test', async () => ({
    skills: [{
      id: 'linear',
      capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
      bodyMd: 'Authored body', manifestYaml: 'name: linear\ndescription: authored\n', files: [],
    }],
  }));
  // a DEFAULT skill with the SAME id — the authored draft must win
  listDefaultsMock.mockResolvedValue({ skills: [{ id: 'linear', capabilities: emptyCaps, bodyMd: 'Default body', manifestYaml: 'name: linear\ndescription: default\n', files: [] }] });

  await runOneTurn(/* ... */);

  const sent = sandboxOpenSpy.mock.calls[0][1].installedSkills; // adapt to the spy shape
  const linear = sent.find((s) => s.id === 'linear');
  expect(linear.files[0].contents).toContain('Authored body'); // draft won, not default
  expect(sent.filter((s) => s.id === 'linear')).toHaveLength(1); // de-duped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/chat-orchestrator`
Expected: FAIL — the authored draft isn't in the sandbox skill set (default body present instead).

- [ ] **Step 3: Add the structural type + the fetch + the union**

Near the other structural hook types (around `ResolvedSkillForOrch`, `:226`) add:

```ts
interface AgentsResolveAuthoredSkillsOutput {
  skills: ResolvedSkillForOrch[];
}
```

In `orchestrator.ts`, immediately BEFORE the `defaultSkillsForUnion` block (currently `:1379`), add the fetch (fail-open — drafts are instruction-only and carry no creds, so an empty result only ever yields FEWER skills, never wider reach — same posture as `skills:list-defaults`):

```ts
// Phase 3 — self-authored workspace drafts are the highest-precedence
// discovery source (the agent's own current authoring wins over a stale
// catalog/default of the same id). Instruction-only here (empty caps; lazy
// approval is Phase 4), so a throw FAILS OPEN — fewer skills, never wider reach.
let authoredDraftSkills: ResolvedSkillForOrch[] = [];
if (bus.hasService('agents:resolve-authored-skills')) {
  try {
    const r = await bus.call<
      { ownerUserId: string; agentId: string },
      AgentsResolveAuthoredSkillsOutput
    >('agents:resolve-authored-skills', ctx, { ownerUserId: ctx.userId, agentId: agent.id });
    authoredDraftSkills = r.skills;
  } catch (err) {
    ctx.logger.warn('resolve_authored_skills_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    authoredDraftSkills = [];
  }
}
```

Then REPLACE the union construction (currently `:1396–1405`) with authored-first, de-dup first-wins:

```ts
const authoredIds = new Set(authoredDraftSkills.map((s) => s.id));
const withAuthored = [
  ...authoredDraftSkills,
  ...resolvedSkills.filter((s) => !authoredIds.has(s.id)),
];
const explicitIds = new Set(withAuthored.map((s) => s.id));
const withDefaults = [
  ...withAuthored,
  ...defaultSkillsForUnion.filter((s) => !explicitIds.has(s.id)),
];
const presentIds = new Set(withDefaults.map((s) => s.id));
const unionedSkills = [
  ...withDefaults,
  ...(config.builtinSkills ?? []).filter((s) => !presentIds.has(s.id)),
];
```

> The credential/host union loop (`:1331–1369`) keys off `attachments`, NOT `unionedSkills`, and authored drafts have empty caps — so they contribute only to `installedSkillsForSandbox` (the file tree), never to creds/hosts. No change there.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test --filter @ax/chat-orchestrator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/__tests__/
git commit -m "feat(orchestrator): union self-authored drafts into the projection (highest precedence)"
```

## Task A4: runner — `settingSources: ['user']` + remove the skills symlink scaffold

Closes the `project`-source backdoor: the `0555` host `user` projection becomes the sole discovery path. A direct `.claude/skills/evil/SKILL.md` write is never discovered.

**Files:**
- Modify: `packages/agent-claude-sdk-runner/src/main.ts` (`:924` settingSources; remove the `scaffoldWorkspaceSkillSurface` call ~`:237`)
- Modify: `packages/agent-claude-sdk-runner/src/git-workspace.ts` (delete `scaffoldWorkspaceSkillSurface`, ~`:204–220`)
- Test: `packages/agent-claude-sdk-runner/src/__tests__/git-workspace.test.ts` (remove the 3 symlink tests, ~`:234–277`); the test asserting SDK query options (find the one asserting `settingSources`)

- [ ] **Step 1: Update the settingSources assertion (failing)**

Find the runner test asserting the SDK `query` options include `settingSources: ['user', 'project']` (grep the runner `__tests__` for `settingSources`). Change the expectation to `['user']`. Run it — it FAILS (impl still emits `['user','project']`).

Run: `pnpm test --filter @ax/agent-claude-sdk-runner -- <that-test-file>`
Expected: FAIL — `expected ['user'] received ['user','project']`.

- [ ] **Step 2: Drop `'project'` in main.ts**

`packages/agent-claude-sdk-runner/src/main.ts:924`: change `settingSources: ['user', 'project'],` → `settingSources: ['user'],` and update the adjacent comment block (`:908–924`) to state the `user` projection is the sole discovery path and the `project` source was dropped in Phase 3 to close the agent-writable-`.claude/skills/` backdoor.

- [ ] **Step 3: Remove the symlink scaffold call + function**

In `main.ts`, delete the `await scaffoldWorkspaceSkillSurface(env.workspaceRoot);` line (~`:237`) and the now-unused import. **Keep** `scaffoldSdkProjectsSymlink` (jsonl projects — unrelated). In `git-workspace.ts`, delete `scaffoldWorkspaceSkillSurface` (~`:204–220`).

- [ ] **Step 4: Remove the symlink tests; add a "not discovered" guard**

In `git-workspace.test.ts`, delete the three `scaffoldWorkspaceSkillSurface` tests (~`:234–277`). Keep the bundling test that reads `.ax/draft-skills` (~`:648`) — it does not depend on the symlink. Add a small assertion (in the same file, or the materialize test) that after workspace setup, **no** `.claude/skills` symlink exists:

```ts
it('does not scaffold a .claude/skills symlink (project source dropped in Phase 3)', async () => {
  const root = await makeTempWorkspace(); // existing helper
  // run whatever materialize/setup the other tests run
  await expect(fs.lstat(path.join(root, '.claude', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --filter @ax/agent-claude-sdk-runner`
Expected: PASS (settingSources `['user']`, symlink gone, no symlink-scaffold tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-claude-sdk-runner/src/main.ts packages/agent-claude-sdk-runner/src/git-workspace.ts packages/agent-claude-sdk-runner/src/__tests__/
git commit -m "feat(runner): drop 'project' settingSource + skills symlink — host projection is the sole discovery path"
```

## Task A5: canary — quarantined draft omitted + clean draft projected (real executors)

Extend the Phase-2 injection canary so a quarantined draft is genuinely **unreachable** through the projection (not merely unsymlinked), and a clean draft **is** projected.

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

- [ ] **Step 1: Verify wiring (no new plugin needed)**

Confirm `@ax/agents` is loaded in BOTH presets (it already registers `agents:resolve` etc.): `presets/k8s/src/index.ts` and `packages/cli/src/main.ts`. The new `agents:resolve-authored-skills` service rides along in `@ax/agents`'s `registers` — no preset edit required. Note this in the PR body.

- [ ] **Step 2: Write the canary assertion (failing first if run before A1–A4 land — here it should pass)**

In `acceptance.test.ts`, in/after the Phase-2 injection scenario (it already authors a draft and asserts quarantine via the real validator scan), capture the `installedSkills` passed to the real `sandbox:open-session` (or the materialized `AX_INSTALLED_SKILLS_JSON`) and assert:

```ts
// the injection draft was quarantined by the real commit scan (Phase-2 path)
// → Phase-3 projection MUST omit it: the model never sees its name/description.
const installed = capturedInstalledSkills(); // pull from the sandbox-open spy / env
expect(installed.find((s) => s.id === INJECTION_SKILL_ID)).toBeUndefined();

// a CLEAN draft authored in the same scenario IS projected.
expect(installed.find((s) => s.id === CLEAN_SKILL_ID)).toBeDefined();
```

> Use the canary's existing real-executor harness — do NOT introduce a fire-spy. If the scenario doesn't already author a clean draft, add one alongside the injection draft.

- [ ] **Step 3: Run the canary**

Run: `pnpm test --filter @ax/preset-k8s -- acceptance` (adapt to the preset package name in `presets/k8s/package.json`).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(canary): quarantined draft omitted from projection; clean draft projected (real executors)"
```

## Task A6: PR-A — build, lint, security note, open PR

- [ ] **Step 1: Full gate**

Run: `pnpm build && pnpm test && pnpm exec eslint $(git diff --name-only main... | grep -E '\.(ts|tsx)$')`
Expected: build PASS, tests PASS, lint clean on changed files.

- [ ] **Step 2: security-checklist pass**

Invoke the `security-checklist` skill. Headline for the PR security note: "discovery grants instructions only; the `0555` host `user` projection is the single discovery path (PR-A drops the `project` source); quarantined drafts are omitted from the projection." Walk the three threat models (the design doc's Security Analysis is the source). Record the structured note for the PR body.

- [ ] **Step 3: Open PR-A against `main`**

PR body MUST include: the boundary review for `agents:resolve-authored-skills` (alternate impl; no leaking field names; request/response not broadcast; in-process only) + the new `workspace:applied` subscriber is **PR-B**, not here; the security note; and an explicit **"half-wired window OPEN until PR-B"** note (the `install_authored_skill` transaction still exists; discovery moved atomically from runner-local symlink to host projection — no dual-discovery). Use `gh pr create`.

---

# PR-B — Delete the transaction + stop retiring + re-spawn (window CLOSED)

Branch: `feat/skill-authoring-phase-3-delete-transaction` stacked on PR-A's branch. (Create it from PR-A's head; the PR targets `main` after PR-A merges, or stacks per the team's convention.)

## Task B1: delete the `install_authored_skill` tool (`@ax/skill-broker`)

**Files:**
- Delete: `packages/skill-broker/src/tools/install-authored-skill.ts`
- Modify: the skill-broker registration/index that wires the tool (grep `INSTALL_AUTHORED_SKILL_DESCRIPTOR` and `registerInstallAuthoredSkill`) + any tool-descriptor advertisement list
- Delete: `packages/skill-broker/src/tools/__tests__/install-authored-skill.test.ts` (if present)

- [ ] **Step 1: Find every reference**

Run: `grep -rn "install_authored_skill\|InstallAuthoredSkill\|registerInstallAuthoredSkill\|INSTALL_AUTHORED_SKILL" packages --include="*.ts" | grep -v __tests__`
List the call sites: the tool file, its registration in the broker's index/plugin, and any descriptor list the runner/orchestrator uses to advertise host tools to the SDK.

- [ ] **Step 2: Remove the tool + registration**

Delete `install-authored-skill.ts`, remove its `register…(bus)` call and import from the broker index/plugin, and remove its descriptor from any advertised-tools list. **Keep** `search-catalog.ts` and `request-capability.ts` and their registrations untouched.

- [ ] **Step 3: Run the broker tests**

Run: `pnpm test --filter @ax/skill-broker`
Expected: PASS (search_catalog + request_capability still registered; no dangling reference to the deleted tool).

- [ ] **Step 4: Commit**

```bash
git add -A packages/skill-broker
git commit -m "feat(skill-broker)!: delete install_authored_skill tool (superseded by bundle-native projection)"
```

## Task B2: delete `agents:install-authored-skill` + promotion + retire (`@ax/agents`)

**Files:**
- Modify: `packages/agents/src/plugin.ts` (remove the `agents:install-authored-skill` service block incl. the Phase-2 quarantine promote-refusal consumer and the STEP-5 `workspace:apply` draft-retire; remove from manifest `registers`)
- Modify: `packages/agents/src/authored-skills.ts` (delete `readAuthoredBundle`, `parseAuthoredManifestOrThrow`, `describeNearbyAuthoredSkills`, and the `AuthoredBundle`/`AuthoredBundleFile`-only-for-promote exports **iff** no other caller remains — verify by grep; KEEP `listAuthoredSkills` (admin) + `listAuthoredBundles` (projection))
- Modify/delete: the corresponding tests

- [ ] **Step 1: Confirm the only caller of the promotion is the deleted tool**

Run: `grep -rn "agents:install-authored-skill\|readAuthoredBundle\|parseAuthoredManifestOrThrow\|describeNearbyAuthoredSkills" packages --include="*.ts" | grep -v __tests__`
Expected after B1: only `packages/agents/src/plugin.ts` (the service) + `authored-skills.ts` (the defs). If `admin-routes.ts` uses `readAuthoredBundle`, STOP and keep it (re-scope this task to delete only the service + retire). Otherwise proceed.

- [ ] **Step 2: Remove the service + retire block**

In `plugin.ts`, delete the entire `bus.registerService('agents:install-authored-skill', …)` block (the one with STEP 1 read / STEP 2 quarantine-refusal / STEP 3 manifest build / STEP 4 upsert / STEP 5 retire — `~:369–527`), and remove `'agents:install-authored-skill'` from the manifest `registers`. In `authored-skills.ts`, delete the now-unused `readAuthoredBundle` / `parseAuthoredManifestOrThrow` / `describeNearbyAuthoredSkills` (only if Step 1 proved them unused). Delete their tests.

- [ ] **Step 3: Run the agents tests**

Run: `pnpm build --filter @ax/agents && pnpm test --filter @ax/agents`
Expected: PASS. `listAuthoredSkills` + `listAuthoredBundles` + `agents:resolve-authored-skills` remain green.

- [ ] **Step 4: Commit**

```bash
git add -A packages/agents
git commit -m "feat(agents)!: delete install-authored-skill promotion + draft-retire (bundle is source of truth)"
```

## Task B3: orchestrator — session-dirty → next-turn re-spawn

A `workspace:applied` subscriber records the committing session as dirty when the turn changed `.ax/draft-skills/`; the routing decision declines to reuse a dirty warm session and re-spawns fresh. In-memory + single-replica — matches the existing `workspace:applied` posture (`@ax/routines` relies on the same single-replica assumption).

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (factory closure state + the routing check `:954–966` + a new `onWorkspaceApplied` handler returned from the factory)
- Modify: `packages/chat-orchestrator/src/plugin.ts` (add `'workspace:applied'` to `subscribes` + `bus.subscribe` wiring)
- Test: `packages/chat-orchestrator/src/__tests__/orchestrator*.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('re-spawns (does not reuse the warm session) after a turn that committed a .ax/draft-skills change', async () => {
  // harness with conversations:get + session:is-alive + sandbox:open-session spy, keepAlive on
  // turn 1: warm session S1 is alive and bound as activeSessionId
  await runOneTurn(/* conversationId: C, ... */);
  const openCallsAfterT1 = sandboxOpenSpy.mock.calls.length;

  // simulate the turn's commit touching a draft
  await orchestratorHandlers.onWorkspaceApplied(ctx, {
    before: null, after: asWorkspaceVersion('v2'),
    author: { userId: ctx.userId, agentId: agent.id, sessionId: 'S1' },
    changes: [{ path: '.ax/draft-skills/linear/SKILL.md', kind: 'put' }],
  });

  // turn 2 on the SAME conversation must NOT route into S1 — it re-spawns
  await runOneTurn(/* conversationId: C, ... */);
  expect(sandboxOpenSpy.mock.calls.length).toBe(openCallsAfterT1 + 1); // fresh spawn happened
});

it('reuses the warm session when the turn changed only the transcript (no draft change)', async () => {
  await runOneTurn(/* conversationId: C */);
  const openCallsAfterT1 = sandboxOpenSpy.mock.calls.length;
  await orchestratorHandlers.onWorkspaceApplied(ctx, {
    before: null, after: asWorkspaceVersion('v2'),
    author: { userId: ctx.userId, agentId: agent.id, sessionId: 'S1' },
    changes: [{ path: '.claude/projects/abc.jsonl', kind: 'put' }], // transcript only
  });
  await runOneTurn(/* conversationId: C */);
  expect(sandboxOpenSpy.mock.calls.length).toBe(openCallsAfterT1); // warm reuse, no new spawn
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test --filter @ax/chat-orchestrator`
Expected: FAIL — `onWorkspaceApplied` is undefined / warm reuse still happens after a draft change.

- [ ] **Step 3: Add the dirty-set + subscriber handler**

In the orchestrator factory body (near the other closure state like `warmSessions`), add:

```ts
// Phase 3 — sessions whose agent's draft-skills changed this turn must
// re-spawn next turn (the runner reads skills only at spawn). In-memory,
// single-replica (same posture as @ax/routines' workspace:applied use).
const respawnSessions = new Set<string>();
const DRAFT_SKILLS_RE = /^\.ax\/draft-skills\//;
```

Add a handler (return it from the factory alongside `onHttpEgress`):

```ts
// Structural mirror of @ax/core WorkspaceDelta (no import beyond the type if
// already available; otherwise inline the shape — invariant #2 posture).
async function onWorkspaceApplied(
  _ctx: AgentContext,
  delta: { author?: { sessionId?: string }; changes: Array<{ path: string }> },
): Promise<void> {
  const sid = delta.author?.sessionId;
  if (sid !== undefined && sid.length > 0 && delta.changes.some((c) => DRAFT_SKILLS_RE.test(c.path))) {
    respawnSessions.add(sid);
  }
}
```

- [ ] **Step 4: Consult the dirty-set in routing**

In the routing decision (currently `:954–966`), gate warm-reuse on the dirty-set and retire the now-stale session (safe here — we're between turns, not mid-commit):

```ts
if (aliveResult.alive) {
  if (respawnSessions.has(candidate)) {
    respawnSessions.delete(candidate);
    // Drafts changed since this session spawned — retire it and fall through
    // to a fresh spawn that re-derives the projection. Between turns, so no
    // in-flight turn to wedge (unlike a mid-commit terminate).
    try {
      await bus.call('session:terminate', ctx, { sessionId: candidate });
    } catch (err) {
      ctx.logger.warn('respawn_terminate_failed', {
        sessionId: candidate, err: err instanceof Error ? err.message : String(err),
      });
    }
    // routedSessionId stays null → fresh spawn below.
  } else {
    routedSessionId = candidate;
  }
}
```

Add `onWorkspaceApplied` to the factory's returned object (`:2081`).

- [ ] **Step 5: Wire the subscriber in plugin.ts**

In `packages/chat-orchestrator/src/plugin.ts`: add `'workspace:applied'` to the `subscribes` array (`:103`), and add the `bus.subscribe` wiring next to the others (`:128+`):

```ts
bus.subscribe<{ author?: { sessionId?: string }; changes: Array<{ path: string }> }>(
  'workspace:applied', PLUGIN_NAME,
  async (ctx, delta) => { await handlers.onWorkspaceApplied(ctx, delta); return undefined; },
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test --filter @ax/chat-orchestrator`
Expected: PASS (both new cases).

- [ ] **Step 7: Commit**

```bash
git add packages/chat-orchestrator/src/orchestrator.ts packages/chat-orchestrator/src/plugin.ts packages/chat-orchestrator/src/__tests__/
git commit -m "feat(orchestrator): session-dirty -> next-turn re-spawn on .ax/draft-skills change"
```

## Task B4: canary — authored/edited draft re-projects on re-spawn

**Files:**
- Modify: `presets/k8s/src/__tests__/acceptance.test.ts`

- [ ] **Step 1: Add the re-projection assertion**

Extend the canary: after a clean draft is authored and committed (firing the real `workspace:applied`), drive a second turn on the same conversation and assert the second `sandbox:open-session` carries the newly-authored skill in `installedSkills` (re-projected on re-spawn). Real executors only.

```ts
// turn 1 authors .ax/draft-skills/<id>/SKILL.md (clean) → commit fires workspace:applied
// turn 2 on the same conversation must re-spawn and project the new skill
const installedT2 = capturedInstalledSkills(secondSpawn);
expect(installedT2.find((s) => s.id === NEW_SKILL_ID)).toBeDefined();
```

- [ ] **Step 2: Run the canary**

Run: `pnpm test --filter @ax/preset-k8s -- acceptance`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add presets/k8s/src/__tests__/acceptance.test.ts
git commit -m "test(canary): authored draft re-projects on next-turn re-spawn (real executors)"
```

## Task B5: PR-B — build, lint, security note, changeset, open PR

- [ ] **Step 1: Full gate**

Run: `pnpm build && pnpm test && pnpm exec eslint $(git diff --name-only main... | grep -E '\.(ts|tsx)$')`
Expected: build PASS, tests PASS, lint clean on changed files.

- [ ] **Step 2: Add a changeset** (breaking — a tool was removed)

Run: `pnpm changeset` — minor/patch per the repo's convention; describe "remove install_authored_skill; self-authored skills are bundle-native and discovered via the host projection."

- [ ] **Step 3: security-checklist pass**

Invoke `security-checklist`. Add to the note: the `workspace:applied` subscriber keys off the `.ax/draft-skills/` path convention + `author.sessionId` (stable domain identifiers, no backend vocabulary); in-memory dirty-set is single-replica (matches the existing `workspace:applied` assumption); a mid-session edit to an active skill can't take effect until re-spawn, where the quarantine flag re-gates it.

- [ ] **Step 4: Open PR-B against `main`**

PR body MUST include: boundary review for the new `workspace:applied` subscriber; the security note; an explicit **"window CLOSED"** note — the projection-omission gate fully supersedes the Phase-2 promote-refusal consumer; and the **accepted inter-phase capability gap** (Phase 3 projects drafts with empty caps; capability author-and-run is Phase 4; pure-instruction skills work fully now).

---

## Self-Review (run against the design doc)

**Spec coverage:**
- Goal "projection reads bundles, omits quarantined" → A1 (read) + A2 (quarantine filter) + A3 (union) + A5 (canary). ✓
- "Close the project-source backdoor" → A4 (drop `project` + remove symlink). ✓
- "Stop retiring the draft" → B2. ✓
- "Delete the transaction + promotion" → B1 (tool) + B2 (service/promotion/retire). ✓
- "Session-dirty → re-spawn" → B3. ✓
- D6 empty caps + inter-phase gap → A2 (empty caps) + B5 PR note. ✓
- Composition/precedence (self-authored first, de-dup first-wins) → A3. ✓
- Half-wired window discipline (atomic swap; window OPEN→CLOSED notes) → A6 + B5. ✓
- security-checklist + boundary review → A6 + B5. ✓
- Canary real executors (quarantine omitted; re-project on re-spawn) → A5 + B4. ✓

**Gaps / deferred (intentional):** lazy cap approval (Phase 4), catalog-as-bundle-registry (Phase 5), ax-skill-creator rewrite + Linear kind-walk (Phase 6), migration/backfill (D1 clean-slate — none).

**Placeholder scan:** the test harness helper names (`makeWorkspaceBackedBus`, `writeDraft`, `runOneTurn`, `sandboxOpenSpy`, `capturedInstalledSkills`) are placeholders the implementing agent MUST bind to the package's existing test utilities — each step says to mirror the existing pattern in that file rather than invent one. The `~:NNN` line refs are approximate (the repo evolves); locate by symbol.

**Type consistency:** `agents:resolve-authored-skills` output (`{skills: AuthoredResolvedSkill[]}`) ↔ the orchestrator's structural `AgentsResolveAuthoredSkillsOutput` (`{skills: ResolvedSkillForOrch[]}`) — both have `{id, capabilities:{allowedHosts,credentials,mcpServers,packages}, bodyMd, manifestYaml, files}`. `WorkspaceDelta` subscriber shape (`{author?:{sessionId?}, changes:[{path}]}`) matches `@ax/core`'s `WorkspaceDelta`. ✓
