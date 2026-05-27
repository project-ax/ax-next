# Agent-authored skills + `ax-skill-creator` built-in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on agent skill-authoring by default and ship an ax-adapted `ax-skill-creator` skill (built-in, gated on open mode) that teaches the `.ax/skills/<id>/` → `install_authored_skill` flow — including a new `packages` grant dimension so authored skills can use npm/python.

**Architecture:** Five seams. (1) `skills-parser` serializes `capabilities.packages`. (2) `@ax/agents` promote threads `packages` through (stops hardcoding empty). (3) `@ax/skill-broker` tool accepts `packages` + surfaces it on the approval card. (4) `channel-web` carries `packages` across the card re-declarations + renders it. (5) `chat-orchestrator` gains a `builtinSkills` config the preset injects (gated on `allowUserInstalledSkills`), and the chart default flips ON. The `ax-skill-creator` SKILL.md is a repo asset embedded in the preset.

**Tech Stack:** TypeScript, pnpm workspaces, tsconfig project refs, vitest, Helm. Security backstop unchanged: capabilities are granted only via the human approval card, never self-asserted in frontmatter.

**Spec:** `docs/plans/2026-05-27-agent-authored-skills-skill-creator-design.md` (Parts A–E, invariants I1–I8).

---

## File Structure

**Part E (packages grant path):**
- `packages/skills-parser/src/build.ts` — serialize `packages`.
- `packages/agents/src/types.ts` — `packages` on `AgentsInstallAuthoredSkillInput` + `AgentsInstallAuthoredSkillOutput`.
- `packages/agents/src/plugin.ts` — promote uses requested `packages`.
- `packages/skill-broker/src/tools/install-authored-skill.ts` — tool `packages` arg + card field + forward.
- `packages/channel-web/src/server/types.ts`, `src/server/routes-connections.ts`, `src/lib/permission-card-store.ts`, `src/lib/transport.ts`, `src/components/PermissionCard.tsx` — carry + render.

**Parts B/C (built-in injection):**
- `packages/chat-orchestrator/src/orchestrator.ts` — export `ResolvedSkillForOrch`, add `builtinSkills` to `ChatOrchestratorConfig`, union at lowest precedence.
- `presets/k8s/src/builtin-skills/ax-skill-creator/SKILL.md` — the asset (Part A).
- `presets/k8s/src/builtin-skills/index.ts` — load + parse the asset into a `ResolvedSkillForOrch`.
- `presets/k8s/src/index.ts` — inject into `orchestratorCfg` gated on `allowUserInstalledSkills`; package build copies the `.md` into `dist`.

**Part D (default flip):**
- `deploy/charts/ax-next/values.yaml` — `skills.allowUserInstalled: true`.
- `deploy/charts/ax-next/__tests__/env-shape.test.ts` + any preset/broker default-off assertions.

**Sequencing note (I6 — no half-wired merge):** Tasks 1–8 land in one PR. The `builtinSkills` config field (Task 6) is consumed by the preset (Task 7) in the same PR. Build stays green at each commit because every change is additive until the wiring task.

---

## Task 1: skills-parser serializes `capabilities.packages`

**Files:**
- Modify: `packages/skills-parser/src/build.ts:12-36`
- Test: `packages/skills-parser/src/__tests__/build.test.ts`

Today `buildSkillManifestYaml` computes `hasCaps` from hosts/credentials/mcpServers only and never writes `packages` — so a promoted skill can't carry npm/pypi. Fix both.

- [ ] **Step 1: Write the failing test**

```ts
// build.test.ts
import { buildSkillManifestYaml } from '../build.js';
import { parseSkillManifest, splitSkillMd } from '../index.js';

it('serializes capabilities.packages when non-empty (round-trips)', () => {
  const yaml = buildSkillManifestYaml({
    id: 'demo', description: 'd', version: 1,
    capabilities: { allowedHosts: [], credentials: [], mcpServers: [],
      packages: { npm: ['cowsay'], pypi: [] } },
  });
  const parsed = parseSkillManifest(yaml);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.capabilities.packages.npm).toEqual(['cowsay']);
});

it('omits capabilities entirely when all kinds (incl packages) are empty', () => {
  const yaml = buildSkillManifestYaml({
    id: 'demo', description: 'd', version: 1,
    capabilities: { allowedHosts: [], credentials: [], mcpServers: [],
      packages: { npm: [], pypi: [] } },
  });
  expect(yaml).not.toContain('capabilities');
});
```

- [ ] **Step 2: Run — expect FAIL** (`packages.npm` is `[]` after round-trip; `capabilities` may even be absent).

Run: `pnpm test --filter @ax/skills-parser -- build`

- [ ] **Step 3: Implement** — extend `hasCaps` and serialize packages:

```ts
const pkgs = c.packages ?? { npm: [], pypi: [] };
const hasPackages = (pkgs.npm ?? []).length > 0 || (pkgs.pypi ?? []).length > 0;
const hasCaps =
  c.allowedHosts.length > 0 ||
  c.credentials.length > 0 ||
  (c.mcpServers ?? []).length > 0 ||
  hasPackages;
if (hasCaps) {
  doc.capabilities = {
    ...(c.allowedHosts.length > 0 ? { allowedHosts: c.allowedHosts } : {}),
    ...(c.credentials.length > 0 ? { credentials: c.credentials } : {}),
    ...((c.mcpServers ?? []).length > 0 ? { mcpServers: c.mcpServers } : {}),
    ...(hasPackages
      ? { packages: {
            ...((pkgs.npm ?? []).length > 0 ? { npm: pkgs.npm } : {}),
            ...((pkgs.pypi ?? []).length > 0 ? { pypi: pkgs.pypi } : {}),
          } }
      : {}),
  };
}
```

- [ ] **Step 4: Run — expect PASS.** Also run the existing build.test to confirm no regression.
- [ ] **Step 5: Commit** — `feat(skills-parser): serialize capabilities.packages in buildSkillManifestYaml`

---

## Task 2: `@ax/agents` promote threads `packages`

**Files:**
- Modify: `packages/agents/src/types.ts:309-328` (input/output + schema)
- Modify: `packages/agents/src/plugin.ts:394-405` + `:472` (build manifest + return)
- Test: `packages/agents/src/__tests__/install-authored-skill.test.ts`

- [ ] **Step 1: Failing test** — assert the requested packages reach the upserted manifest and `mcpServers` stays empty (I8). Mock `skills:upsert` to capture `manifestYaml`:

```ts
it('threads requested packages into the promoted manifest; mcpServers stays empty', async () => {
  // ...register a fake skills:upsert that records manifestYaml...
  await bus.call('agents:install-authored-skill', ctx(agentId), {
    agentId, skillId: 'demo', hosts: [], slots: [], packages: { npm: ['cowsay'], pypi: [] },
  });
  expect(capturedManifestYaml).toContain('packages');
  expect(capturedManifestYaml).toContain('cowsay');
  expect(capturedManifestYaml).not.toContain('mcpServers');
});

it('omits packages when none requested (back-compat)', async () => {
  await bus.call('agents:install-authored-skill', ctx(agentId), {
    agentId, skillId: 'demo', hosts: [], slots: [],
  });
  expect(capturedManifestYaml).not.toContain('packages');
});
```

- [ ] **Step 2: Run — expect FAIL** (type error on `packages`, and manifest lacks it).

Run: `pnpm test --filter @ax/agents -- install-authored-skill`

- [ ] **Step 3: Implement.** In `types.ts` add to the input + output (+ schema):

```ts
export interface AgentsInstallAuthoredSkillInput {
  agentId: string; skillId: string; hosts: string[]; slots: string[];
  /** Package ecosystems the skill needs (user-approved on the card). Optional; default none. */
  packages?: { npm?: string[]; pypi?: string[] };
}
export interface AgentsInstallAuthoredSkillOutput {
  description: string;
  hosts: string[];
  slots: { slot: string; kind: 'api-key' }[];
  packages: { npm: string[]; pypi: string[] };
}
export const AgentsInstallAuthoredSkillOutputSchema = z.object({
  description: z.string(),
  hosts: z.array(z.string()),
  slots: z.array(z.object({ slot: z.string(), kind: z.literal('api-key') })),
  packages: z.object({ npm: z.array(z.string()), pypi: z.array(z.string()) }),
}) as unknown as ZodType<AgentsInstallAuthoredSkillOutput>;
```

In `plugin.ts`, replace the hardcoded packages and the return:

```ts
const reqPackages = {
  npm: input.packages?.npm ?? [],
  pypi: input.packages?.pypi ?? [],
};
const manifestYaml = buildSkillManifestYaml({
  id: bundle.id, description: bundle.description, version: bundle.version,
  capabilities: { allowedHosts: input.hosts, credentials: slots, mcpServers: [], packages: reqPackages },
});
// ...
return { description: bundle.description, hosts: input.hosts, slots, packages: reqPackages };
```

- [ ] **Step 4: Run — expect PASS.** Then `pnpm build --filter @ax/agents` (tsc must accept the new field).
- [ ] **Step 5: Commit** — `feat(agents): thread requested packages through authored-skill promote`

---

## Task 3: `@ax/skill-broker` tool accepts + forwards `packages`

**Files:**
- Modify: `packages/skill-broker/src/tools/install-authored-skill.ts`
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts` (open-mode section)

- [ ] **Step 1: Failing test** — call the tool executor with `packages` and assert (a) the `agents:install-authored-skill` call receives them, (b) the fired `chat:permission-request` card carries them, (c) invalid package names are filtered.

```ts
it('forwards validated packages to the promote + the approval card', async () => {
  // spy agents:install-authored-skill (returns description/hosts/slots/packages)
  // spy chat:permission-request
  await bus.call('tool:execute:install_authored_skill', ctx, {
    input: { skillId: 'demo', hosts: [], slots: [], packages: { npm: ['cowsay', 'BAD NAME'], pypi: [] } },
  });
  expect(promoteInput.packages.npm).toEqual(['cowsay']); // BAD NAME filtered
  expect(firedCard.packages.npm).toEqual(['cowsay']);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `pnpm test --filter @ax/skill-broker -- plugin`

- [ ] **Step 3: Implement.** Add a package-name validator (mirror the manifest grammar — conservative `^[a-z0-9](?:[a-z0-9._@/-]{0,213})$`, lowercased), extend the input schema + parse, the `agents:install-authored-skill` call type, the `PermissionRequestEvent`, and the fired card. Update the tool `description` to say "declare package ecosystems here (npm/pypi), never in frontmatter."

```ts
const PKG_RE = /^[a-z0-9][a-z0-9._@/-]{0,213}$/;
const pkgIn = (input.packages ?? {}) as { npm?: unknown; pypi?: unknown };
const npm = Array.isArray(pkgIn.npm) ? pkgIn.npm.filter((p): p is string => typeof p === 'string' && PKG_RE.test(p)) : [];
const pypi = Array.isArray(pkgIn.pypi) ? pkgIn.pypi.filter((p): p is string => typeof p === 'string' && PKG_RE.test(p)) : [];
const packages = { npm, pypi };
// inputSchema.properties.packages = { type:'object', properties:{ npm:{type:'array',items:{type:'string'}}, pypi:{...} } }
// bus.call<{...; packages: {npm:string[];pypi:string[]}}, {...; packages:{npm:string[];pypi:string[]}}>('agents:install-authored-skill', toolCtx, { agentId, skillId, hosts, slots, packages })
```

Extend `PermissionRequestEvent`:
```ts
interface PermissionRequestEvent {
  kind: 'skill'; skillId: string; description: string;
  hosts: string[]; slots: { slot: string; kind: 'api-key' }[];
  packages: { npm: string[]; pypi: string[] };
  authored: true;
}
// card: { ...existing, packages: out.packages }  // use promote's echoed packages
```

- [ ] **Step 4: Run — expect PASS.** `pnpm build --filter @ax/skill-broker`.
- [ ] **Step 5: Commit** — `feat(skill-broker): accept + surface package ecosystems on authored-skill install`

---

## Task 4: `channel-web` carries + renders `packages` on the card

**Files:**
- Modify: `packages/channel-web/src/server/types.ts:116-137` (skill variant +`packages?`)
- Modify: `packages/channel-web/src/server/routes-connections.ts` (forward packages on the skill emit)
- Modify: `packages/channel-web/src/lib/permission-card-store.ts:23-40`
- Modify: `packages/channel-web/src/lib/transport.ts:105-141` (SseFrame skill variant)
- Modify: `packages/channel-web/src/components/PermissionCard.tsx:174+` (render line)
- Test: `packages/channel-web/src/components/__tests__/PermissionCard.test.tsx` + card-store/transport tests

- [ ] **Step 1: Failing test** — PermissionCard renders a registry line when `packages.npm`/`pypi` non-empty, and nothing when empty:

```tsx
it('shows a package-registry line for an npm authored skill', () => {
  render(<PermissionCard request={{ kind:'skill', skillId:'demo', description:'',
    hosts:[], slots:[], packages:{ npm:['cowsay'], pypi:[] }, authored:true }} ... />);
  expect(screen.getByText(/registry\.npmjs\.org/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL** (type error: `packages` not on the union; no rendered line).

Run: `pnpm test --filter @ax/channel-web -- PermissionCard`

- [ ] **Step 3: Implement.** Add `packages?: { npm: string[]; pypi: string[] }` to the `kind:'skill'` variant in all four re-declarations (server/types, permission-card-store, transport SseFrame, and the routes-connections forwarder copies it verbatim). In `PermissionCard.tsx`, after the slots block, render an informational, non-interactive line:

```tsx
{request.packages != null &&
 (request.packages.npm.length > 0 || request.packages.pypi.length > 0) && (
  <p className="text-sm text-muted-foreground" data-testid="permission-packages">
    {request.packages.npm.length > 0 && <>Installs npm packages → reaches <code>registry.npmjs.org</code>. </>}
    {request.packages.pypi.length > 0 && <>Installs Python packages → reaches <code>pypi.org</code>, <code>files.pythonhosted.org</code>.</>}
  </p>
)}
```

(Use existing shadcn/token styling — no raw colors. Run the `shadcn` skill if a new primitive is needed; here only text + `<code>` are used.)

- [ ] **Step 4: Run — expect PASS.** Then `pnpm build --filter @ax/channel-web`.
- [ ] **Step 5: Commit** — `feat(channel-web): render package-registry line on authored-skill card`

---

## Task 5: orchestrator `builtinSkills` config + union injection

**Files:**
- Modify: `packages/chat-orchestrator/src/orchestrator.ts` (export `ResolvedSkillForOrch`; `ChatOrchestratorConfig` +`builtinSkills`; union)
- Test: `packages/chat-orchestrator/src/__tests__/*` (the open-session/materialize suite)

- [ ] **Step 1: Failing test** — a configured builtin materializes into the sandbox skill set; loses to an explicit/default skill of the same id; empty-caps builtin adds no egress host.

```ts
it('materializes a builtin skill (lowest precedence, no egress effect)', async () => {
  // construct orchestrator with builtinSkills:[{ id:'ax-skill-creator', manifestYaml:'name: ax-skill-creator\ndescription: d\nversion: 1\n', bodyMd:'body', files:[], capabilities:{allowedHosts:[],credentials:[],mcpServers:[],packages:{npm:[],pypi:[]}} }]
  // drive an open-session; assert installedSkillsForSandbox contains id 'ax-skill-creator'
  // assert egress allowlist has no extra host from it
});
it('a default/explicit skill with the same id wins over the builtin', async () => { /* ... */ });
```

- [ ] **Step 2: Run — expect FAIL.** Run: `pnpm test --filter @ax/chat-orchestrator`

- [ ] **Step 3: Implement.**
  - `export interface ResolvedSkillForOrch { ... }` (add `export`).
  - In `ChatOrchestratorConfig` add:
    ```ts
    /** System/built-in skills materialized into every session at LOWEST precedence
     *  (an explicit or default-attached skill of the same id wins). Empty by default. */
    builtinSkills?: ResolvedSkillForOrch[];
    ```
  - After the existing `unionedSkills` assembly, fold builtins in, deduped against everything already unioned:
    ```ts
    const presentIds = new Set(unionedSkills.map((s) => s.id));
    const builtinsForUnion = (config.builtinSkills ?? []).filter((s) => !presentIds.has(s.id));
    const allSkills = [...unionedSkills, ...builtinsForUnion];
    ```
    Replace downstream uses of `unionedSkills` (the package-registry scan + `installedSkillsForSandbox.map`) with `allSkills`. **Confirm** the registry scan still reads `s.capabilities.packages` so a builtin with empty packages adds nothing.

- [ ] **Step 4: Run — expect PASS.** `pnpm build --filter @ax/chat-orchestrator`.
- [ ] **Step 5: Commit** — `feat(chat-orchestrator): builtinSkills config injected into the materialization union`

---

## Task 6: author the `ax-skill-creator` SKILL.md asset

**Files:**
- Create: `presets/k8s/src/builtin-skills/ax-skill-creator/SKILL.md`
- Test: covered by Task 7's loader test (parses + empty caps).

Write the trimmed, ax-adapted skill per spec Part A. Frontmatter EXACT:

```yaml
---
name: ax-skill-creator
description: >-
  Use when the user wants to create, author, build, or modify a skill,
  capability, or integration for this assistant — e.g. "make a skill for
  Linear", "add a Jira integration", "turn this workflow into a reusable
  skill", or "update the X skill". Walks authoring a SKILL.md bundle under
  .ax/skills/ and installing it with install_authored_skill so the user can
  approve the hosts, credentials, and package registries it needs. Use this
  whenever a new capability or integration is requested, even if the user does
  not say the word "skill".
---
```

Body (target < 500 lines), sections in order:
1. **The ax authoring loop** — interview → write bundle in `.ax/skills/<id>/` → call `install_authored_skill` → user approves one card → installed + usable next turn. Lead with the human-approval backstop.
2. **Capture intent / interview** (trimmed from Anthropic skill-creator) — what it does, when it triggers, output, and *which hosts / credentials / package ecosystems it needs*.
3. **Write the SKILL.md** (trimmed) — anatomy, progressive disclosure, writing patterns + style, the "pushy description" guidance.
4. **AX-specific rules** — MUST include verbatim intent:
   - Write to `.ax/skills/<id>/SKILL.md`; helper files under that dir. id `^[a-z0-9][a-z0-9._-]{0,127}$`; helper names lowercase `[a-z0-9._-]`, nested ok; never `.mcp.json`/`.claude`/`.git`; ≤256-char paths, ≤64-char segments.
   - **Frontmatter is `name` + `description` only — never a `capabilities:` block.** It is stripped on write. Declare everything the skill needs to reach outside as **arguments to `install_authored_skill`** (hosts, credential slots, package ecosystems). One rule, no exceptions — that is how the human approves what the skill can do.
   - Credentials: reference the slot as an env var in the body (e.g. `$LINEAR_API_KEY`); slot names SCREAMING_SNAKE `^[A-Z][A-Z0-9_]{0,63}$`. Hosts are reachable only via the egress proxy, and only the hosts passed at install.
   - Packages: if the skill runs `npx`/`uvx`/`pip`, pass `packages:{ npm?:[...], pypi?:[...] }` at install so the public registries are allowlisted — without it, fetches hit the egress wall.
   - **MCP servers are not self-authorable.** A skill bundling an MCP server must be authored by an admin via the catalog; say so rather than attempting it.
5. **Install it** — `install_authored_skill({ skillId, hosts, slots, packages })`. The user sees one approval card listing exactly those hosts/keys (and a package-registry line); enter keys. Do **not** narrate the step, restate keys, or re-ask the original request — after approval the conversation continues automatically.
6. **Test & iterate** — run a realistic prompt that exercises the skill; to change it, edit the bundle and call `install_authored_skill` again. No eval harness.
7. **Worked examples** — (a) Linear: body uses `$LINEAR_API_KEY` against `api.linear.app` GraphQL for "issues in the current cycle"; install `hosts:['api.linear.app'], slots:['LINEAR_API_KEY']`. (b) A `uvx`/`npx` tool skill installed with `packages:{ pypi:['<tool>'] }` (or `npm`).
8. **Principle of lack of surprise** — no malware/exfil skills; intent must match the description.

Cut: eval-viewer, `aggregate_benchmark`/`run_loop`, description-optimization, `.skill` packaging/`present_files`, Cowork/Claude.ai sections, subagent eval orchestration.

- [ ] **Step 1: Write the SKILL.md** per the outline above.
- [ ] **Step 2: Sanity-check it parses** — `node -e "..."` or rely on Task 7's test. The frontmatter must have **no** `capabilities:` key.
- [ ] **Step 3: Commit** — `feat(preset-k8s): add ax-skill-creator built-in skill asset`

---

## Task 7: load + inject the built-in (gated on open mode) + ship the asset in dist

**Files:**
- Create: `presets/k8s/src/builtin-skills/index.ts`
- Modify: `presets/k8s/src/index.ts:663-675` (orchestratorCfg)
- Modify: `presets/k8s/package.json` (build copies the asset into `dist`)
- Test: `presets/k8s/src/__tests__/builtin-skills.test.ts` + the preset wiring test

- [ ] **Step 1: Failing test** — the loader returns a `ResolvedSkillForOrch` with id `ax-skill-creator`, empty capabilities, no files; and the preset includes it in `builtinSkills` iff open mode is on.

```ts
import { loadBuiltinSkills } from '../builtin-skills/index.js';
it('loads ax-skill-creator with empty capabilities', () => {
  const [s] = loadBuiltinSkills();
  expect(s.id).toBe('ax-skill-creator');
  expect(s.capabilities.allowedHosts).toEqual([]);
  expect(s.capabilities.credentials).toEqual([]);
  expect(s.capabilities.packages).toEqual({ npm: [], pypi: [] });
  expect(s.files).toEqual([]);
});
```

Preset wiring (extend the existing preset test):
```ts
it('injects builtinSkills only in open mode', () => {
  const on = createK8sPlugins({ ...base, allowUserInstalledSkills: true });
  const off = createK8sPlugins({ ...base, allowUserInstalledSkills: false });
  // inspect the orchestrator plugin's config (or a seam exposing it):
  expect(orchestratorBuiltinIds(on)).toContain('ax-skill-creator');
  expect(orchestratorBuiltinIds(off)).toEqual([]);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `pnpm test --filter @ax/preset-k8s -- builtin`

- [ ] **Step 3: Implement the loader.** Read the asset relative to the compiled module, split + parse, build the orch shape:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitSkillMd, parseSkillManifest } from '@ax/skills-parser';
import type { ResolvedSkillForOrch } from '@ax/chat-orchestrator';

export function loadBuiltinSkills(): ResolvedSkillForOrch[] {
  const md = readFileSync(
    fileURLToPath(new URL('./ax-skill-creator/SKILL.md', import.meta.url)), 'utf8',
  );
  const split = splitSkillMd(md);
  if (split === null) throw new Error('ax-skill-creator SKILL.md: missing frontmatter');
  const parsed = parseSkillManifest(split.manifestYaml);
  if (!parsed.ok) throw new Error(`ax-skill-creator SKILL.md: ${parsed.message}`);
  return [{
    id: parsed.value.id,
    manifestYaml: split.manifestYaml,
    bodyMd: split.bodyMd,
    files: [],
    capabilities: { allowedHosts: [], credentials: [], mcpServers: [], packages: { npm: [], pypi: [] } },
  }];
}
```

- [ ] **Step 4: Ship the asset in dist.** Add a copy to the package build so the `.md` sits next to compiled JS (tsc does not copy non-TS files):

```jsonc
// presets/k8s/package.json
"scripts": {
  "build": "tsc -b && node ../../scripts/copy-assets.mjs src/builtin-skills dist/builtin-skills"
}
```
(Or add `copyfiles`/`cpy` if a shared helper exists. Confirm the repo's convention; reuse it rather than inventing.) Verify after build: `ls presets/k8s/dist/builtin-skills/ax-skill-creator/SKILL.md`.

- [ ] **Step 5: Inject into the orchestrator config (gated):**

```ts
import { loadBuiltinSkills } from './builtin-skills/index.js';
// in orchestratorCfg:
...(config.allowUserInstalledSkills ? { builtinSkills: loadBuiltinSkills() } : {}),
```

- [ ] **Step 6: Run — expect PASS.** Then `pnpm build --filter @ax/preset-k8s` and confirm the asset copied to dist.
- [ ] **Step 7: Commit** — `feat(preset-k8s): inject ax-skill-creator builtin when open mode is on`

---

## Task 8: flip the chart default + update default-off assertions

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml:398` (`allowUserInstalled: true`)
- Modify: `deploy/charts/ax-next/__tests__/env-shape.test.ts`
- Modify: any preset/broker test asserting the OFF-by-default posture (grep `allowUserInstalled`/`AX_ALLOW_USER_INSTALLED_SKILLS`).

- [ ] **Step 1: Failing test** — update `env-shape` to expect `AX_ALLOW_USER_INSTALLED_SKILLS=true` is stamped under the new default; run it to see the current (old-default) assertion fail.

Run: `pnpm test --filter ax-next-chart -- env-shape` (or the chart test's package name)

- [ ] **Step 2: Implement** — set `skills.allowUserInstalled: true` in `values.yaml` and update the comment ("default ON — agents may author skills; the approval card is the backstop"). Adjust the chart + any preset default-off unit assertions to the new default. Leave the `createSkillBrokerPlugin` `?? false` and the preset gate intact (a deployment can still set `allowUserInstalled: false`).
- [ ] **Step 3: Run — expect PASS.**
- [ ] **Step 4: Commit** — `feat(deploy): default open mode (agent skill-authoring) ON`

---

## Task 9: security-checklist + full verification

- [ ] **Step 1:** Invoke the `security-checklist` skill (this PR changes capability surface, plugin config, and untrusted-content handling). Produce the structured PR security note: sandbox-escape (no new self-grant — caps via card only; `mcpServers` unreachable), prompt-injection (bounded by the mandatory card; `authored` banner), supply-chain (no new deps; public registries only). Answer every item.
- [ ] **Step 2: Full gate** — `pnpm build && pnpm test && pnpm lint` (scope lint to changed files per the stale-worktree caveat). All green.
- [ ] **Step 3: kind walk (manual acceptance)** — per spec Testing:
  1. Author the Linear skill from chat → approve card + enter key → "list all Linear issues in the current cycle" → live result.
  2. Author a package-using skill (npm or pypi ecosystem) → approve → confirm its `npx`/`uvx`/`pip` step reaches the registry (not the egress wall).
- [ ] **Step 4:** Open the PR with the boundary-review answers (no new hook), the security note, and the I1–I8 audit. Update `.claude/memory/` on the branch.

---

## Self-review notes (spec coverage)

- Part A → Task 6. Part B → Task 5. Part C → Task 7. Part D → Task 8. Part E → Tasks 1–4 (+ the `buildSkillManifestYaml` gap, Task 1, which the spec implied but didn't name).
- I1 (no frontmatter grants) — unchanged behavior, asserted by existing strip tests; reaffirmed in the SKILL.md content (Task 6).
- I2 (gated materialize) — Task 7 preset test. I3 (lowest precedence) — Task 5 test. I4 (empty-caps builtin, no egress) — Task 5 test. I5 (no hook) — `builtinSkills` is config; boundary review in Task 9 PR. I6 (no half-wired) — single PR; field consumed same PR. I7 (packages via card) — Tasks 1–4 tests. I8 (mcpServers empty) — Task 2 test.
