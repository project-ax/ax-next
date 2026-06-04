# TASK-154 — connector services declaration surface (admin UI + compose→descriptor)

**Branch:** `auto-ship/TASK-154-connector-services-ui` · **Base:** `main`
**Epic:** dev-services-in-sandbox. Deps TASK-150 (descriptor + `Capabilities.services` grammar
+ `services:validate`) + TASK-153 (orchestrator fold) MERGED.

## Problem

Let a connector DECLARE dev services (a "service bundle" connector): an admin UI section
to add `name`/digest-pinned `image`/`ports`/`env`/`writablePaths`, persisted on the
connector's capability proposal; plus a curated `docker-compose.yml`→descriptor translation
helper that DROPS host mounts / `privileged` / `cap_add` / `network_mode:host` / socket
mounts (I10) and flags un-pinned images (I8). Never auto-imports compose verbatim, never
shells out to `docker compose`.

## Key findings (from exploration)

- `services` ALREADY round-trips through the connector store — `CapabilitiesSchema` in
  `packages/connectors/src/types.ts` carries `services` (TASK-150); admin routes upsert
  capabilities verbatim; store parses-on-write/read. So persistence is VERIFY + a
  round-trip test, NOT new store code.
- channel-web's `ConnectorCapabilities` type lacks `services`, and `capabilitiesFromForm`
  in `connector-form.ts` builds only allowedHosts/credentials/mcpServers/packages — it
  would silently WIPE a `services` block on edit. Must add the field + preserve/edit it.
- Compose helper home = `@ax/skills-parser` (new `compose-translate.ts`): already deps
  `js-yaml` (the repo's mandated YAML parser) + owns `ServiceDescriptorSchema`; on the
  eslint runtime-import allowlist so connectors AND channel-web may import it. No new dep.

## Tasks (TDD — test first each)

### Task 1 — `@ax/skills-parser`: `compose-translate.ts` (the curated helper) [load-bearing]
- New `packages/skills-parser/src/compose-translate.ts`. Pure function
  `translateComposeToServices(yaml: string): ComposeTranslateResult`.
- Parse with `js-yaml` `load()` (try/catch `YAMLException`; reject non-object root;
  WeakSet against cyclic anchors — mirror manifest.ts). Never spawn anything.
- For each `services.<name>`: ALLOW-LIST map only `{image, environment, ports, healthcheck}`
  → `ServiceDescriptor`. Coerce: `environment` (array `KEY=val` or map) → `env` record;
  `ports` (`"5432:5432"` / `5432` / `{target}`) → container port numbers; compose
  `healthcheck.test` → exec/tcp where derivable, else omit.
- DROP (I10) and REPORT: `volumes` (host bind mounts incl. `/var/run/docker.sock` socket
  mounts), `privileged`, `cap_add`, `network_mode: host`, plus the sibling escape hatches
  `devices`, `pid`, `ipc`, `userns_mode`, `security_opt`. Each drop → a `Drop {service,
  field, value?}` entry.
- FLAG (I8) un-pinned images (no `@sha256:<64hex>`) → carried as `invalid` with a "pin this
  image" reason; valid pinned descriptors → `services[]`.
- Export from `index.ts`. Tests (`compose-translate.test.ts`): host-mount+privileged →
  stripped + reported drops; un-pinned image → flagged; clean pinned compose → descriptor;
  socket mount + cap_add + network_mode:host dropped; malformed YAML → error result;
  non-object root → error; env array + map both coerced; `5432:5432` → port 5432.

### Task 2 — `@ax/connectors`: round-trip a `services` proposal + detail surfacing [load-bearing]
- VERIFY services rides the capability proposal: add an admin-routes test that upserts a
  connector whose `capabilities.services` carries a descriptor and asserts GET returns it
  (name/image/ports/env/writablePaths). Card's "admin route round-trips a services
  capability proposal through the store" test.
- Detail response already carries full capabilities incl. services. Service `env` is
  author-declared config (NOT a credential slot — secrets are `capabilities.credentials`),
  so surfacing name/image/ports/env is correct; pin the distinction in a comment.

### Task 3 — channel-web: `ConnectorCapabilities.services` + form preserve/edit [load-bearing]
- `lib/connectors.ts`: add `services?: ServiceDescriptor[]` to `ConnectorCapabilities`
  (type-only import `ServiceDescriptor` from `@ax/skills-parser`); `emptyCapabilities`
  unchanged (services optional/absent).
- `lib/connector-form.ts`: add `services: ServiceDescriptor[]` to `ConnectorFormState`;
  `formFromConnector` reads `caps.services ?? []`; `capabilitiesFromForm` carries
  `...(services.length ? { services } : {})` so edit never wipes them. Add helpers to
  add/remove/patch a service row + a `applyComposeToForm` that calls the Task-1 helper.
- Tests (`connector-form.test.ts`): round-trip a connector with services
  (formFromConnector→capabilitiesFromForm not wiped); editing an MCP connector that has
  services preserves them; apply-compose populates service rows + surfaces drops/flags.

### Task 4 — channel-web: Services section in `ConnectorEditDialog` [load-bearing]
- New "Services" section (compose `Card`/`Alert`/`Button`/`Input`/`Label`/`Textarea`, the
  established `Label`+`flex flex-col gap-2` convention; NO Field/FieldGroup — not installed).
  Frame as a "service bundle".
- A paste box (`Textarea`) + "Translate compose" button → fills service rows; an `Alert`
  lists dropped fields ("we removed these because they can't cross into the sandbox", in
  the project voice) + un-pinned-image flags. Manual add/edit of name/image/ports/env/
  writablePaths via Inputs. Digest-pin validation surfaced inline (Alert) before save.
- Component test (`ConnectorEditDialog.test.tsx`): Services section renders; pasting a
  compose with a host mount shows the drop notice; an un-pinned image shows the pin flag.

## YAGNI pass
All four tasks load-bearing (helper core / round-trip acceptance / un-wipe-services bug +
paste wiring / the UI section). None cut.

## Invariants
I8 digest-pin (flag un-pinned). I10 curated translation, drop unsafe fields, never
auto-import. Invariant #6 shadcn primitives + semantic tokens. I2 no runtime cross-plugin
import except allow-listed `@ax/skills-parser`. I4 one source of truth (helper + descriptor
schema live once in skills-parser).

## Security
Untrusted pasted YAML at a trust boundary → security-checklist note in PR. Allow-list
mapping, js-yaml safe `load()`, no process spawn, WeakSet cyclic guard, descriptor
re-validated by `ServiceDescriptorSchema` (+ downstream `services:validate` + the wire).

## Acceptance
`pnpm test --filter @ax/connectors --filter @ax/channel-web --filter @ax/skills-parser`
green; full `pnpm build` + `pnpm lint` clean.
