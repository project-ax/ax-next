# JIT — `allow_user_installed_skills` Deployment Flag (preset + chart) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plumb the `allow_user_installed_skills` deployment flag — the open-mode gate (design decision #5, §10) — end-to-end from the Helm chart through the k8s preset into `@ax/skill-broker`, **off by default**, so a future task can flip on agent-authored skills per deployment.

**Architecture:** A single boolean travels the same path every other k8s deployment flag travels (the `credentials.admin.enabled` precedent): chart `values.yaml` (`skills.allowUserInstalled: false`) → `host/deployment.yaml` stamps `AX_ALLOW_USER_INSTALLED_SKILLS=true` **only when enabled** → `loadK8sConfigFromEnv` reads it into `K8sPresetConfig.allowUserInstalledSkills` → `createK8sPlugins` hands it to `createSkillBrokerPlugin({ allowUserInstalledSkills })`. The broker stores the resolved flag and exposes it as a read-only property (the open-mode gate). It has **no behavioral effect in this task** — the authoring tool that reads it ships in TASK-39.

**Tech Stack:** TypeScript (pnpm workspace, strict + `exactOptionalPropertyTypes`), Helm (chart render tested via `helm template` + `js-yaml`), vitest.

**Scope guardrails:**

- **Boundary review — N/A (no hook).** This task adds/changes **no** service hook, subscriber hook, or IPC action. It plumbs a boolean through *injected plugin config* (chart → env → preset factory arg). The flag never crosses the hook bus or the wire, so there is no payload to leak and no subscriber to mis-key. The env var (`AX_ALLOW_USER_INSTALLED_SKILLS`) and config field (`allowUserInstalledSkills`) carry no backend vocabulary (invariant I1 satisfied trivially).
- **Security-checklist — NOT a pre-PR gate for this task.** The card does not flag it, and TASK-38 touches no sandbox boundary, IPC transport, plugin-loading path, or untrusted-content surface — it sets one boolean. The security-relevant property here is the **conservative default (off)**, which §10 calls out explicitly; this plan pins it with a test at all three layers (broker default, loader-absence, chart default render). The actual untrusted-content risk — an agent (possibly prompt-injected) authoring a malicious skill — lands in **TASK-39**, which consumes this flag; **TASK-39 MUST run the full `security-checklist`.** See the Security note at the end.
- **Half-wired window — OPEN, declared.** After this task the broker *stores and exposes* `allowUserInstalledSkills`, but **nothing reads it to change behavior** (no authoring tool exists yet). This is the same sanctioned pattern as `@ax/attachments` Phase 1 and the broker's own half-wired `request_capability` ack (TASK-34). The window **CLOSES in TASK-39** (JIT: open-mode agent-authored skills, flow C), which registers the gated authoring tool that reads this flag. State this in the PR's "Half-wired window OPEN" section.

**As-built reconciliation (verified against `main` @ TASK-34 merge `47f76d89`):**

1. The card's dep note says *"TASK-34 (broker reads the flag)"* — but the merged `createSkillBrokerPlugin()` takes **no config** and reads no flag. That parenthetical describes the **end** state; **TASK-38 is what makes the broker able to read it.** The dependency itself is correct (the broker must exist first).
2. Design §11.7 / the card say the flag is *"read by orchestrator/broker."* As-built, **neither** reads it. This plan wires the **broker only** as the single reader — the broker is the JIT surfacing spine (§11 component #1) and open mode adds an agent *authoring* capability, which is a surfacing/tool concern the broker owns. The chat-orchestrator is sandbox/turn plumbing; adding a capability-policy flag there is a worse fit and would split one deployment setting across two readers (invariant I4). If a later task needs the orchestrator to know the mode, it reads the *same injected config value* — config injection is not shared mutable state, so there is no second source of truth. **Resolved: broker, not orchestrator.**
3. The chart comment on `configmap-ax-config.yaml` says config is *"Loaded by the CLI via AX_CONFIG_PATH"* — but for the **k8s preset** the config path is **env-var driven** (`loadK8sConfigFromEnv` reads `process.env`); nothing in the non-test source reads `AX_CONFIG_PATH` (it's vestigial here). This plan follows the live precedent: a boolean flag → an `AX_*` env var → `loadK8sConfigFromEnv`, exactly like `credentials.admin.enabled` → `AX_CREDENTIALS_ADMIN_ENABLED` → `cfg.credentialsAdmin` (`presets/k8s/src/index.ts:1177`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/skill-broker/src/plugin.ts` | broker plugin factory | **add** `SkillBrokerConfig` + `SkillBrokerPlugin`; accept config; resolve + expose `allowUserInstalledSkills` (default `false`) |
| `packages/skill-broker/src/index.ts` | package public surface | **export** the two new types |
| `packages/skill-broker/src/__tests__/plugin.test.ts` | broker unit tests | **add** default-off / accepts-true / tool-set-unchanged cases |
| `presets/k8s/src/index.ts` | k8s assembly + env loader | **add** `K8sPresetConfig.allowUserInstalledSkills`; `loadK8sConfigFromEnv` reads `AX_ALLOW_USER_INSTALLED_SKILLS`; `createK8sPlugins` passes it to the broker |
| `presets/k8s/src/__tests__/preset.test.ts` | preset wiring tests | **add** loader env→config cases + broker-receives-flag case |
| `deploy/charts/ax-next/values.yaml` | chart defaults | **add** `skills.allowUserInstalled: false` block |
| `deploy/charts/ax-next/templates/host/deployment.yaml` | host pod env | **add** conditional `AX_ALLOW_USER_INSTALLED_SKILLS` stamp |
| `deploy/charts/ax-next/__tests__/env-shape.test.ts` | chart-vs-loader contract | **add** default-absent / set-true-present cases |

**Naming (locked for type consistency across tasks):**
- Env var: **`AX_ALLOW_USER_INSTALLED_SKILLS`** (screaming-snake, `AX_` prefix — matches `AX_CREDENTIALS_ADMIN_ENABLED`).
- Preset config field: **`allowUserInstalledSkills?: boolean`** (on both `K8sPresetConfig` and `SkillBrokerConfig`).
- Helm value: **`skills.allowUserInstalled`** (boolean, default `false`).
- Broker exposed property: **`readonly allowUserInstalledSkills: boolean`** (on `SkillBrokerPlugin`).

---

### Task 1: `@ax/skill-broker` accepts config and exposes the open-mode gate (default off)

**Files:**
- Modify: `packages/skill-broker/src/plugin.ts`
- Modify: `packages/skill-broker/src/index.ts`
- Test: `packages/skill-broker/src/__tests__/plugin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/skill-broker/src/__tests__/plugin.test.ts` (reuses the file's existing `busWithStubs()` helper + `ctx`):

```typescript
import { createSkillBrokerPlugin, type SkillBrokerPlugin } from '../plugin.js';

describe('createSkillBrokerPlugin — open-mode gate (allow_user_installed_skills)', () => {
  it('defaults the open-mode gate OFF when no config is passed', () => {
    const p = createSkillBrokerPlugin() as SkillBrokerPlugin;
    expect(p.allowUserInstalledSkills).toBe(false);
  });

  it('defaults OFF when config omits the flag', () => {
    const p = createSkillBrokerPlugin({}) as SkillBrokerPlugin;
    expect(p.allowUserInstalledSkills).toBe(false);
  });

  it('reflects allowUserInstalledSkills:true when enabled', () => {
    const p = createSkillBrokerPlugin({ allowUserInstalledSkills: true }) as SkillBrokerPlugin;
    expect(p.allowUserInstalledSkills).toBe(true);
  });

  // Half-wired window (TASK-38): the flag is stored + exposed, but the broker
  // registers the SAME tool set in both modes — the authoring tool that the
  // flag gates ships in TASK-39. This pins "behaviorally inert" so a future
  // edit that wires authoring has to update this test deliberately.
  it('registers the same tools whether open mode is on or off', async () => {
    const off = busWithStubs();
    await (createSkillBrokerPlugin({ allowUserInstalledSkills: false }) as SkillBrokerPlugin).init({
      bus: off.bus,
      config: {} as never,
    });
    const on = busWithStubs();
    await (createSkillBrokerPlugin({ allowUserInstalledSkills: true }) as SkillBrokerPlugin).init({
      bus: on.bus,
      config: {} as never,
    });
    expect(off.registered.sort()).toEqual(['request_capability', 'search_catalog']);
    expect(on.registered.sort()).toEqual(off.registered.sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/skill-broker test`
Expected: FAIL — `createSkillBrokerPlugin` takes no arguments (TS2554) / `SkillBrokerPlugin` is not exported / `.allowUserInstalledSkills` does not exist.

- [ ] **Step 3: Add the config + exposed gate to the factory**

In `packages/skill-broker/src/plugin.ts`, add the config + return types and thread the flag. Keep the existing `manifest` and `init` body **unchanged** — the flag is stored and exposed only:

```typescript
import type { Plugin } from '@ax/core';
import { registerSearchCatalog } from './tools/search-catalog.js';
import { registerRequestCapability } from './tools/request-capability.js';

const PLUGIN_NAME = '@ax/skill-broker';
const PLUGIN_VERSION = '0.0.0';

/**
 * @ax/skill-broker construction config.
 */
export interface SkillBrokerConfig {
  /**
   * Open mode (JIT design decision #5, §10). When `true`, the deployment
   * permits the agent to author + install user-scoped skills on the fly
   * (gated by the same host/credential approval card). OFF by default —
   * agent-authoring is opt-in per deployment.
   *
   * Plumbed from the `allow_user_installed_skills` deployment flag
   * (TASK-38). HALF-WIRED in TASK-38: the broker stores + exposes this but
   * nothing reads it to change behavior yet. TASK-39 (open-mode agent-
   * authored skills, flow C) closes the window by registering the gated
   * authoring tool that reads it.
   */
  allowUserInstalledSkills?: boolean;
}

/**
 * The broker plugin, widened with the resolved open-mode gate so the preset
 * wiring test (and TASK-39's authoring path) can read the effective value
 * without calling `init()`. Read-only — config is fixed at construction.
 */
export interface SkillBrokerPlugin extends Plugin {
  readonly allowUserInstalledSkills: boolean;
}

/**
 * @ax/skill-broker — the model-brokered surfacing spine (JIT, design §6A,
 * §11 component #1). Registers always-on host tools the agent calls to match
 * intent against the capability catalog. Built on the generic host-tool
 * surface (tool:register + tool:execute:${name}), like @ax/web-tools — NOT an
 * MCP server.
 */
export function createSkillBrokerPlugin(
  config: SkillBrokerConfig = {},
): SkillBrokerPlugin {
  const allowUserInstalledSkills = config.allowUserInstalledSkills ?? false;
  return {
    allowUserInstalledSkills,
    manifest: {
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      registers: ['tool:execute:search_catalog', 'tool:execute:request_capability'],
      // Hard deps → init-ordering edges: the dispatcher (tool:register) and the
      // catalog owner (skills:search-catalog / skills:get) must init first.
      calls: ['tool:register', 'skills:search-catalog', 'skills:get'],
      subscribes: [],
    },
    async init({ bus }) {
      await registerSearchCatalog(bus);
      await registerRequestCapability(bus);
    },
  };
}
```

- [ ] **Step 4: Export the new types**

In `packages/skill-broker/src/index.ts`, add the type export alongside the existing factory export:

```typescript
export { createSkillBrokerPlugin } from './plugin.js';
export type { SkillBrokerConfig, SkillBrokerPlugin } from './plugin.js';
export { SEARCH_CATALOG_DESCRIPTOR } from './tools/search-catalog.js';
export { REQUEST_CAPABILITY_DESCRIPTOR } from './tools/request-capability.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/skill-broker test`
Expected: PASS (whole package green — the existing TASK-34 manifest/tool tests still pass because `manifest` + `init` are unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/skill-broker/src/plugin.ts packages/skill-broker/src/index.ts packages/skill-broker/src/__tests__/plugin.test.ts
git commit -m "feat(skill-broker): accept allowUserInstalledSkills config + expose open-mode gate (TASK-38)"
```

---

### Task 2: `K8sPresetConfig.allowUserInstalledSkills` + `loadK8sConfigFromEnv` reads the env var

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Test: `presets/k8s/src/__tests__/preset.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `presets/k8s/src/__tests__/preset.test.ts` (mirrors the existing `loadK8sConfigFromEnv` cases at lines 254–287 — same minimal env shape):

```typescript
describe('@ax/preset-k8s — allow_user_installed_skills flag (TASK-38)', () => {
  const HEX_KEY = '0'.repeat(64);
  const baseEnv = (): NodeJS.ProcessEnv => ({
    DATABASE_URL: 'postgres://u:p@db:5432/ax_next',
    AX_K8S_HOST_IPC_URL: 'http://ax-next-host.ax-next.svc:80',
    AX_WORKSPACE_BACKEND: 'git-protocol',
    AX_WORKSPACE_GIT_SERVER_URL: 'http://git-server:7780',
    AX_WORKSPACE_GIT_SERVER_TOKEN: 't',
    AX_HTTP_HOST: '0.0.0.0',
    AX_HTTP_PORT: '9090',
    AX_HTTP_COOKIE_KEY: HEX_KEY,
    AX_HTTP_ALLOWED_ORIGINS: '',
  });

  it('reads AX_ALLOW_USER_INSTALLED_SKILLS=true into config.allowUserInstalledSkills', () => {
    const cfg = loadK8sConfigFromEnv({ ...baseEnv(), AX_ALLOW_USER_INSTALLED_SKILLS: 'true' });
    expect(cfg.allowUserInstalledSkills).toBe(true);
  });

  it('leaves allowUserInstalledSkills unset when the env var is absent', () => {
    const cfg = loadK8sConfigFromEnv(baseEnv());
    expect(cfg.allowUserInstalledSkills).toBeUndefined();
  });

  it.each(['false', '0', '', 'TRUE-ish', 'yes'])(
    'leaves allowUserInstalledSkills unset for non-"true" value %j',
    (val) => {
      const cfg = loadK8sConfigFromEnv({ ...baseEnv(), AX_ALLOW_USER_INSTALLED_SKILLS: val });
      expect(cfg.allowUserInstalledSkills).toBeUndefined();
    },
  );

  it('accepts case-insensitive "TRUE"', () => {
    const cfg = loadK8sConfigFromEnv({ ...baseEnv(), AX_ALLOW_USER_INSTALLED_SKILLS: 'TRUE' });
    expect(cfg.allowUserInstalledSkills).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: FAIL — `allowUserInstalledSkills` is not a property of `K8sPresetConfig` (TS) and the loader never sets it.

- [ ] **Step 3: Add the field to `K8sPresetConfig`**

In `presets/k8s/src/index.ts`, add to the `K8sPresetConfig` interface (place it near `credentialsAdmin`, around line 348):

```typescript
  /**
   * JIT open-mode gate (design decision #5, §10). When `true`, the deployment
   * permits the agent to author + install user-scoped skills on the fly.
   * OFF by default — agent-authoring is opt-in per deployment.
   *
   * Set by `loadK8sConfigFromEnv` from `AX_ALLOW_USER_INSTALLED_SKILLS`
   * (the chart's `skills.allowUserInstalled=true`). Passed to
   * @ax/skill-broker. HALF-WIRED in TASK-38 — nothing reads it to change
   * behavior until TASK-39 (open-mode agent-authored skills).
   */
  allowUserInstalledSkills?: boolean;
```

- [ ] **Step 4: Read the env var in `loadK8sConfigFromEnv`**

In `presets/k8s/src/index.ts`, inside `loadK8sConfigFromEnv`, after the `AX_CREDENTIALS_ADMIN_ENABLED` block (around line 1179), mirror that exact pattern:

```typescript
  // ---- open-mode gate (allow_user_installed_skills) ----------------------
  // Translates the chart's `skills.allowUserInstalled=true` (which lands as
  // AX_ALLOW_USER_INSTALLED_SKILLS on the host pod) into the config flag.
  // Only the literal string 'true' (case-insensitive) flips it on — anything
  // else (unset, '', '0', 'false') leaves it undefined so createK8sPlugins
  // defaults the broker's gate to false. Mirrors AX_CREDENTIALS_ADMIN_ENABLED.
  if ((env.AX_ALLOW_USER_INSTALLED_SKILLS ?? '').toLowerCase() === 'true') {
    config.allowUserInstalledSkills = true;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add presets/k8s/src/index.ts presets/k8s/src/__tests__/preset.test.ts
git commit -m "feat(preset-k8s): read AX_ALLOW_USER_INSTALLED_SKILLS into K8sPresetConfig (TASK-38)"
```

---

### Task 3: `createK8sPlugins` passes the flag to the broker

**Files:**
- Modify: `presets/k8s/src/index.ts`
- Test: `presets/k8s/src/__tests__/preset.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `presets/k8s/src/__tests__/preset.test.ts`. Import the broker type at the top of the file alongside the existing imports:

```typescript
import type { SkillBrokerPlugin } from '@ax/skill-broker';
```

Then add (this is static manifest/wiring analysis — it never calls `init()`, consistent with the file's other `createK8sPlugins` cases):

```typescript
describe('@ax/preset-k8s — broker receives the open-mode gate (TASK-38)', () => {
  it('defaults the broker gate OFF when config omits the flag', () => {
    const plugins = createK8sPlugins(stubConfig);
    const broker = plugins.find((p) => p.manifest.name === '@ax/skill-broker') as
      | SkillBrokerPlugin
      | undefined;
    expect(broker).toBeDefined();
    expect(broker!.allowUserInstalledSkills).toBe(false);
  });

  it('passes allowUserInstalledSkills:true through to the broker', () => {
    const plugins = createK8sPlugins({ ...stubConfig, allowUserInstalledSkills: true });
    const broker = plugins.find((p) => p.manifest.name === '@ax/skill-broker') as
      | SkillBrokerPlugin
      | undefined;
    expect(broker).toBeDefined();
    expect(broker!.allowUserInstalledSkills).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/preset-k8s test -- src/__tests__/preset.test.ts`
Expected: FAIL — `broker.allowUserInstalledSkills` is `false` even when `stubConfig.allowUserInstalledSkills` is `true`, because `createK8sPlugins` calls `createSkillBrokerPlugin()` with no args.

- [ ] **Step 3: Pass the flag at the broker construction site**

In `presets/k8s/src/index.ts`, change the broker push (currently `plugins.push(createSkillBrokerPlugin());` around line 698) to forward the resolved flag:

```typescript
  plugins.push(
    createSkillBrokerPlugin({
      allowUserInstalledSkills: config.allowUserInstalledSkills ?? false,
    }),
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @ax/preset-k8s test`
Expected: PASS (whole package green — the existing TASK-34 broker wiring test at line 202 still passes; `manifest` is unchanged).

- [ ] **Step 5: Commit**

```bash
git add presets/k8s/src/index.ts presets/k8s/src/__tests__/preset.test.ts
git commit -m "feat(preset-k8s): pass allowUserInstalledSkills to @ax/skill-broker (TASK-38)"
```

---

### Task 4: Chart — `skills.allowUserInstalled` value + conditional env stamp

**Files:**
- Modify: `deploy/charts/ax-next/values.yaml`
- Modify: `deploy/charts/ax-next/templates/host/deployment.yaml`
- Test: `deploy/charts/ax-next/__tests__/env-shape.test.ts`

> **Note:** the chart tests require the `helm` CLI. They are gated by `describeIfHelm` and skip locally when helm is absent; CI's helm-render lane (`AX_REQUIRE_HELM=1`) runs them for real. Implement the value + template first, then add the test inside the existing `describeIfHelm('host deployment env vs preset loader', …)` block (it already exposes `renderHostDeployment` + `envKeysOf`).

- [ ] **Step 1: Write the failing test**

Add to `deploy/charts/ax-next/__tests__/env-shape.test.ts`, inside the `describeIfHelm('host deployment env vs preset loader', …)` block (mirrors the `channelWeb.enabled` pair at lines 434–444):

```typescript
  // Open-mode gate (allow_user_installed_skills) — OFF by default. The chart
  // stamps AX_ALLOW_USER_INSTALLED_SKILLS only when skills.allowUserInstalled
  // is true; the preset's loadK8sConfigFromEnv reads it (so when present it's
  // never an orphan). Default deploys must NOT carry it.
  it('default render does NOT stamp AX_ALLOW_USER_INSTALLED_SKILLS', () => {
    const env = envKeysOf(renderHostDeployment());
    expect(env.has('AX_ALLOW_USER_INSTALLED_SKILLS')).toBe(false);
  });

  it('skills.allowUserInstalled=true stamps AX_ALLOW_USER_INSTALLED_SKILLS=true', () => {
    const dep = renderHostDeployment(['--set', 'skills.allowUserInstalled=true']);
    const env = envKeysOf(dep);
    expect(env.has('AX_ALLOW_USER_INSTALLED_SKILLS')).toBe(true);
    const spec = dep.spec as {
      template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } };
    };
    const v = spec.template?.spec?.containers?.[0]?.env?.find(
      (e) => e.name === 'AX_ALLOW_USER_INSTALLED_SKILLS',
    )?.value;
    expect(v).toBe('true');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @ax/chart-tests test -- __tests__/env-shape.test.ts`
Expected: FAIL on the second case — `AX_ALLOW_USER_INSTALLED_SKILLS` is never rendered. (Skips with a console warning if helm is not installed — run with helm in PATH.)

- [ ] **Step 3: Add the chart value**

In `deploy/charts/ax-next/values.yaml`, add a new top-level block (place it just before the `# ─── ax-next runtime config ───` `config:` block, after `ingress:`):

```yaml
# ─── Skills / capability acquisition ─────────────────────────────
# JIT open mode (design decision #5 / §10). When true, the agent may
# author + install user-scoped skills on the fly — still gated by the
# same in-chat host/credential approval card (the security backstop).
# OFF by default: agent-authoring is opt-in per deployment. The host
# pod reads this via AX_ALLOW_USER_INSTALLED_SKILLS; @ax/skill-broker
# holds the gate. (Curated mode — the broker proposing vetted catalog
# skills — is always on and unaffected by this flag.)
skills:
  allowUserInstalled: false
```

- [ ] **Step 4: Stamp the env var conditionally**

In `deploy/charts/ax-next/templates/host/deployment.yaml`, add the stamp inside the container `env:` list, right after the `AX_CREDENTIALS_ADMIN_ENABLED` block (around line 250), mirroring its conditional shape:

```yaml
            # JIT open-mode gate. Stamped only when the operator opts in via
            # skills.allowUserInstalled=true; the preset's loadK8sConfigFromEnv
            # reads it and hands it to @ax/skill-broker. Absent by default
            # (curated mode), which the broker treats as gate-off.
            {{- if .Values.skills.allowUserInstalled }}
            - name: AX_ALLOW_USER_INSTALLED_SKILLS
              value: "true"
            {{- end }}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @ax/chart-tests test -- __tests__/env-shape.test.ts`
Expected: PASS (both new cases). The existing "host deployment env vars are all read by the preset loader or a known external reader" orphan test stays green: the kind-dev render leaves the flag off, and when present the loader reads `env.AX_ALLOW_USER_INSTALLED_SKILLS` (the source scan in `collectLoaderEnvReads` picks it up).

- [ ] **Step 6: Commit**

```bash
git add deploy/charts/ax-next/values.yaml deploy/charts/ax-next/templates/host/deployment.yaml deploy/charts/ax-next/__tests__/env-shape.test.ts
git commit -m "feat(chart): allow_user_installed_skills deployment flag (off by default) (TASK-38)"
```

---

### Task 5: Full verification + PR

**Files:** none (verification only).

- [ ] **Step 1: Full build + test + lint (pre-PR gate)**

Run:
```bash
pnpm build
pnpm test
pnpm lint
```
Expected: all green. `pnpm build` (tsc) catches any undeclared workspace dep — the preset test imports `type { SkillBrokerPlugin } from '@ax/skill-broker'`, and the preset already depends on `@ax/skill-broker` (added in TASK-34), so no `package.json`/`tsconfig` reference change is needed; if `tsc` reports TS2307 for the type import, add `@ax/skill-broker` to `presets/k8s` references (it should already be present from TASK-34's CI fix `47f76d89`). The chart's helm-gated tests skip locally without helm; the CI helm-render lane runs them.

- [ ] **Step 2: Confirm the half-wired window is honest**

Grep that nothing yet reads the broker's gate to branch behavior (only the tests + the future TASK-39 will):
```bash
grep -rn "allowUserInstalledSkills" packages presets deploy --include="*.ts" | grep -v __tests__ | grep -v dist
```
Expected: the field appears only in `skill-broker/src/plugin.ts` (declare + store + expose), `skill-broker/src/index.ts` (export), and `presets/k8s/src/index.ts` (loader read + broker construction). No consumer branches on it. This confirms "stored + exposed, behaviorally inert."

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create --fill
```

PR description MUST include:

- **Boundary review:** N/A — no service hook, subscriber hook, or IPC action added/changed. This task plumbs one boolean (`allow_user_installed_skills`) through injected plugin config (chart → `AX_ALLOW_USER_INSTALLED_SKILLS` → `K8sPresetConfig.allowUserInstalledSkills` → `createSkillBrokerPlugin` factory arg). The flag never crosses the hook bus or the wire; the env-var/config names carry no backend vocabulary.
- **Half-wired window OPEN:** `@ax/skill-broker` now stores + exposes `allowUserInstalledSkills`, but nothing reads it to change behavior — there is no authoring tool yet. Window **CLOSES in TASK-39** (JIT: open-mode agent-authored skills, flow C), which registers the gated authoring tool that reads this flag. Pinned by the "registers the same tools whether open mode is on or off" test (Task 1).
- **Security note (§10):** The flag is the open-mode security gate (decisions #5/#6). Flipping it on grants the agent the *future* authoring capability; the in-chat host/credential card remains the backstop (TASK-39). TASK-38 pins the conservative default (off) at all three layers (broker default, loader absence, chart default render). No sandbox/IPC/plugin-loading/untrusted-content code path is touched, so the full `security-checklist` skill is **not** a gate here — but it **is required for TASK-39**, which builds the authoring path that consumes this flag.
- **As-built reconciliation:** the card's "TASK-34 (broker reads the flag)" described the end state; TASK-34's merged broker took no config. TASK-38 adds the config. The design's "orchestrator/broker" reader set is narrowed to the **broker only** (single source of truth; orchestrator is the wrong home for a capability-policy flag).

---

## Self-Review

**Spec coverage** (against the card + design §11.7, Part II P5/P7, decision #5, §10):
- "`allow_user_installed_skills` — plain deployment setting, off by default" → chart value `skills.allowUserInstalled: false` (Task 4) + conservative-default tests at all three layers. ✓
- "preset + chart wiring" → `loadK8sConfigFromEnv` env read (Task 2) + `createK8sPlugins` handoff (Task 3) + chart value/env stamp (Task 4). ✓
- "read by orchestrator/broker to gate open mode" → wired to the **broker** (resolved fork: single reader; rationale in As-built reconciliation #2). ✓
- "Depends on TASK-34 (broker reads the flag)" → TASK-38 adds the config the broker reads; dep correct (broker must exist). ✓
- §10 "mode default is conservative" → default-off pinned by tests (broker default, loader absence, chart default render). ✓

**Placeholder scan:** every code step shows real code; every test step shows real assertions matching the existing files' idioms (`busWithStubs()`, `baseEnv()`, `renderHostDeployment`/`envKeysOf`); every run step gives the exact `pnpm -F` command + expected result. No TBD/TODO. ✓

**Type consistency:** the symbols are stable across tasks — `SkillBrokerConfig` / `SkillBrokerPlugin` (Task 1) → exported (Task 1 Step 4) → imported by the preset test (Task 3). The field is `allowUserInstalledSkills?: boolean` on both `SkillBrokerConfig` and `K8sPresetConfig`; the broker exposes `readonly allowUserInstalledSkills: boolean`; the env var is `AX_ALLOW_USER_INSTALLED_SKILLS` and the helm value is `skills.allowUserInstalled` everywhere. The `?? false` default lives at exactly two spots (broker factory, preset construction site) and is intentionally redundant (defense in depth: broker is safe even if constructed directly). ✓

**Known residual:** the broker exposes the gate as a read-only property purely so the preset wiring test (static manifest analysis, no `init()`) and TASK-39's authoring path can read the effective value without instantiating a bus. This is a deliberate, documented seam, not a behavioral coupling — it changes nothing the model or the runtime sees in TASK-38. The orchestrator is intentionally **not** wired; if a later task needs the mode there, it reads the same injected config value (no second source of truth).
