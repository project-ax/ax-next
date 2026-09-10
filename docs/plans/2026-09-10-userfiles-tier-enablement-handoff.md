# TASK-346 — turn the durable user-files tier on in production, and walk it

**Date:** 2026-09-10
**Status:** Plan. Not started. Card is issue #506, board lane **Backlog** (deliberately — see "The decision that isn't yours to skip").
**Baseline:** `main` @ `c2b73eca`. Everything this depends on is merged.
**Card:** https://github.com/project-ax/ax-next/issues/506

---

## Why this exists

PR #504 built a file browser for the agent's **durable user-files tier** and closed F4
(`sandbox:read-user-files` had been registered by both sandbox providers and consumed by
nothing). It merged with an explicit, honest gap: **it has never been walked in a browser,
and its host-mounted read has never run against a real NFS export.**

It could not be. `sandbox.filestore.hostReadPath` — the knob that turns on the host mount —
does nothing unless `sandbox.filestore.server` is also set, and that has **never been on** in
this deployment. So walking #504 requires enabling the durable tier for the first time, which
is its own production behaviour change and wants its own walk.

That is this card: one deploy, one walk, both things.

---

## What already landed (do not redo)

| Commit | What |
|---|---|
| `3e38e1f9` | #504 — `@ax/user-files-read`, the k8s host-mounted realization, the chart's `hostReadPath` mount + host NFS egress, the `/user-files` routes, and the two-tier Files tab |
| `9fe3ca81` | #505 — cleared the moderate+ audit advisories that were failing CI on every PR |
| `28d27146` | `artifact_publish` validates against the session's real roots; the durable tier is publishable |
| `65de3bb7` | the durable mount default renamed `/workspace` → `/files` |

The chart, the routes, the reader and the UI are all in place and tested. **Nothing in this
card is new code.** If you find yourself writing a feature, stop and re-read — this is a
values change plus a walk.

---

## The infrastructure already exists too

A Filestore instance is provisioned and `READY` in the deployment this card targets. **Its
address is not in this repo, and must not be** — see "Where the values go" below. Read the
real values from the live project:

```bash
gcloud filestore instances describe <INSTANCE> --location <ZONE> --project <PROJECT_ID> \
  --format="yaml(name,state,tier,networks,fileShares)"
```

What you need from that output, and what it maps to:

| From `describe` | Chart key |
|---|---|
| `networks[0].ipAddresses[0]` | `sandbox.filestore.server` |
| `fileShares[0].name` (e.g. `vol1`) | `sandbox.filestore.exportPath` — as `/vol1` |
| `state` must be `READY` | — |

**Check the instance and the cluster share a VPC.** Compare `networks[0].network` from the
command above against the cluster's:

```bash
gcloud container clusters describe <CLUSTER> --zone <ZONE> --project <PROJECT_ID> \
  --format="value(network,privateClusterConfig.enablePrivateNodes,clusterIpv4Cidr)"
```

Same network with `DIRECT_PEERING` means the route should already exist. Do not take that as
proof — W1/W2 test reachability rather than assuming it, because same-VPC is not the same as
the NetworkPolicy being right.

What is missing is only the chart wiring: `gke-values.yaml` has no `sandbox.filestore` block,
so the host Deployment carries no `AX_FILESTORE_*` env and its volumes are just
`ax-config proxy-socket workspace`.

---

## The decision that isn't yours to skip

**Read this before touching values. It is why the card sits in Backlog and not To Do, and
why it is not `yolo-ship`-able.**

`packages/agent-runner-core/src/run-runner.ts:1033` is:

```ts
const homeDir = env.userFilesRoot ?? env.workspaceRoot;
```

With no mount resolver loaded, `AX_USERFILES_ROOT` is unset, so **every agent on GKE today
has cwd and HOME at `/agent`** — the governed, git-backed tier. Enabling the durable tier
moves them. Consequences, in the order a user will notice them:

1. **Every agent's cwd and HOME becomes `/files`**, which starts empty, on NFS.
2. **An agent that wrote `report.md` into its cwd yesterday finds cwd empty tomorrow.** The
   file is *not lost* — it was committed to the governed tier and is still listed by the
   Files tab under **Agent workspace**. But the agent's own view of "my files" resets, and
   an agent that reasons "I saved that yesterday, let me open it" will be wrong.
3. **`artifact_publish`'s allowlist changes shape** — the whole durable tier becomes
   publishable (`28d27146`), where before only `/ephemeral/artifacts/**` was.
4. **The `agents:deleted` cleanup goes live.** Deleting an agent now spawns a short-lived pod
   that mounts the export read-WRITE and `rm -rf`s that agent's subtree
   (`packages/sandbox-k8s/src/user-files-ops.ts`). It has never run against a real export.
5. **With `hostReadPath` set, the host pod gains read access to every agent's subtree**, so
   cross-tenant isolation on that path stops being structural (no path at all) and becomes
   code — the route's `agents:resolve` ACL plus realpath confinement in `@ax/user-files-read`.

None of 1–4 is caused by #504; they are the durable-tier feature itself. **A human must
accept the cwd move before this ships.** If you are an agent and nobody has said so in the
card, stop and ask.

---

## Scope

1. Add a PLACEHOLDER `sandbox.filestore` block to `gke-values.yaml` (committed) and the real
   values to `gke-values.local.yaml` (gitignored). See "Where the values go" — getting this
   backwards puts one deployment's infrastructure into a public MIT repo.
2. Deploy.
3. Walk it, including the read-only property, empirically.
4. Record what you found in `.claude/memory/` and close #506.

That is the whole card. If step 3 turns up a bug, fix it in a normal PR with a test (Bug Fix
Policy) rather than growing this one.

---

## Where the values go

**The real Filestore address goes in `gke-values.local.yaml`, NOT in `gke-values.yaml`.**

This repo is public and MIT-licensed, and `gke-values.yaml` is a **template overlay** for
anyone installing the chart, not a record of one deployment. Its own conventions say so:

```yaml
image:
  repository: us-central1-docker.pkg.dev/PROJECT_ID/ax-next/agent   # >>> EDIT (region + PROJECT_ID)
  existingSecret: ax-next-db                                        # >>> EDIT if you named the Secret differently
```

It placeholders the GCP project id deliberately. The only concrete addresses in the whole file
are `35.191.0.0/16` and `130.211.0.0/22` — GCP's **published, universal** load-balancer
health-check ranges, identical for every user of the cloud, i.e. not deployment-specific at
all. Everything that *is* deployment-specific — the real `image.repository`, `ingress.host`,
`http.allowedOrigins`, `onboarding.publicBaseUrl` — already lives in
`gke-values.local.yaml`, which is gitignored (`.gitignore:25 *.local.yaml`).

A Filestore IP is in that second class. It is not a credential, but it is one deployment's
internal address, it is useless to anyone else installing the chart, and committing it would
break a convention the file goes out of its way to keep.

### `gke-values.yaml` — a documented placeholder, committed

Add the block so the option is discoverable, in the file's own `>>> EDIT` style, with no real
values:

```yaml
sandbox:
  filestore:
    server: ""                  # >>> EDIT in gke-values.local.yaml (Filestore instance IP). "" = tier disabled
    exportPath: "/vol1"         # the share name from `gcloud filestore instances describe`
    mountPath: "/files"         # the agent's cwd + HOME inside the sandbox
    hostReadPath: ""            # >>> EDIT to enable the Files browser's host mount (PR #504)
```

`gke-values.yaml` already has a `sandbox:` block (`:89`, carrying `runtimeClassName: gvisor`)
— add `filestore:` under it rather than starting a second top-level key.

### `gke-values.local.yaml` — the real values, never committed

```yaml
sandbox:
  filestore:
    server: "<FILESTORE_IP>"    # from `gcloud filestore instances describe`
    hostReadPath: "/user-files" # omit to enable the tier WITHOUT the host mount
```

`make gke-deploy` passes both files with `-f`, local second, so these win.

### Verify what rendered, before deploying

Three template paths key off these values; check all three:

- `templates/host/deployment.yaml` — the `AX_FILESTORE_*` env, and (only when `hostReadPath`
  is also set) the `user-files-read` volume + `readOnly: true` mount.
- `templates/networkpolicies/agent-runtime-network.yaml` — **host** egress to the Filestore
  /32 on 2049 + 111. Gated on `server` AND `hostReadPath`.
- `templates/networkpolicies/sandbox-restrict.yaml` — **runner** egress, same shape. Gated on
  `server` alone, so this one renders even without the host mount.

```bash
helm template ax-next deploy/charts/ax-next \
  -f deploy/charts/ax-next/gke-values.yaml \
  -f deploy/charts/ax-next/gke-values.local.yaml \
  | grep -B2 -A5 'user-files-read\|AX_FILESTORE'
```

---

## Deploy

```bash
make gke-deploy
```

It refuses a `kind-*` kubectl context, tags the image with `git rev-parse --short HEAD`,
builds `linux/amd64` with buildx, `helm upgrade --install`s with both values files, and waits
on `rollout status ... --timeout=300s`. Commit first — it warns on a dirty tree and tags with
the last commit regardless, which is how you deploy an image that does not contain your change.

**If the rollout hangs, suspect the NetworkPolicy before anything else.** A pod that cannot
reach NFS sits in `ContainerCreating` with a mount timeout, and that failure looks nothing
like a CNI problem when you are staring at it. `kubectl -n ax-next describe pod` will show the
mount error; `agent-runtime-network.yaml` is where the host's egress rule lives.

---

## Walk

Use the `k8s-acceptance-loop` skill; it drives Playwright against the cluster. The UI surface
is the **Files** tab of `/workspace` (`AX_AGENT_WORKSPACE_PREVIEW=1` is already set on the
live deployment — verified 2026-09-10).

**W1 — the deployment came up.**
`kubectl -n ax-next get deploy ax-next-host` Ready, and the env + volume are actually there:

```bash
kubectl -n ax-next get deploy ax-next-host -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}' | grep FILESTORE
kubectl -n ax-next get deploy ax-next-host -o jsonpath='{.spec.template.spec.volumes[*].name}{"\n"}'
```

**W2 — read-only, empirically. Do not trust the manifest.**

```bash
kubectl -n ax-next exec deploy/ax-next-host -- sh -c 'touch /user-files/PROVE_READONLY 2>&1; echo "exit=$?"'
```

Expect a "Read-only file system" error and a non-zero exit. **A success here is a
stop-the-line finding** — it means the UI's read path can write to every agent's files — so
roll back before doing anything else. This is the single assertion this card exists for that
no test in the repo can make.

**W3 — an agent can write to the tier at all.** Start a chat, ask the agent to write a file,
and confirm it lands. This is the cwd move working: `pwd` inside the sandbox should be
`/files`, not `/agent`.

**W4 — the browser lists AND renders.** Open the Files tab. The durable section
("Files") lists what W3 wrote; clicking a folder navigates; clicking a file **renders its
contents**. A file browser that lists correctly and renders nothing is a passing test suite
and a broken feature, which is precisely why this walk is owed.

**W5 — the governed tier is still there beside it.** The "Agent workspace" section still
lists the agent's committed files. This is the reassurance for consequence #2: an existing
agent's older work must still be visible, not silently gone.

**W6 — the honest empty states still read correctly.** For an agent that has written nothing
to the tier, the durable section should say it cannot tell whether the agent wrote nothing or
the server is not keeping files — *not* assert the agent wrote nothing. (With the tier now
enabled, a per-agent subtree that does not exist yet still resolves to `absent`, so this
branch stays reachable.)

**W7 — artifact publish from the durable tier.** Have the agent write a file and publish it
(`artifact_publish`), then download it from the chat. Exercises the widened allowlist
(consequence #3) and the cwd move in one path.

**W8 — agent delete reclaims the subtree.** Create a throwaway agent, have it write a file,
delete the agent, and confirm its `<export>/<agentId>` subtree is gone while a sibling
agent's is untouched. This is consequence #4 and it has never run against a real export.
Watch for the one-shot pod: `kubectl -n <runner-ns> get pods -l app.kubernetes.io/component=ax-next-userfiles`.

**W9 — cross-tenant, over the wire.** With two users and two agents, confirm user B gets 404
on `GET /api/workspace/agents/<A's agent>/user-files` and the *same* 404 for a malformed path
under it. The acceptance canary covers this in-process; this confirms it survives the real
auth stack.

---

## If you want to de-risk it

The two changes are separable, and separating them is legitimate:

- **Tier only** (`server`/`exportPath`/`mountPath`, no `hostReadPath`) — walks the cwd move,
  W3, W5, W7, W8, and the browser via the **pod-per-call** read path. You will feel exactly
  how slow that is (a pod create + 500 ms poll + log read + delete per click), which is the
  argument for the host mount made concrete.
- **Then add `hostReadPath`** — a second one-line deploy, and W2 + W4 become meaningful.

Costs one extra deploy and buys a smaller blast radius per step. If the cwd move worries you
more than the mount does, do it this way.

---

## Rollback

Remove the `sandbox.filestore` block and redeploy. Agents' cwd reverts to `/agent`. Files
written to the export **stay** on it (keyed `subPath=<agentId>`), so re-enabling later picks
them back up — nothing is destroyed by turning it off. The host mount and both NetworkPolicy
rules disappear with the values.

The one thing rollback does not undo: files an agent wrote to `/files` while it was on are
not in git, so they will not appear in the governed tier afterwards. They are still on the
export, just not reachable until the tier is re-enabled.

---

## File map

Verified on `main` @ `c2b73eca`; line numbers drift.

**Values / templates**
- `deploy/charts/ax-next/gke-values.yaml:89` — the existing `sandbox:` block to extend, with
  a PLACEHOLDER only. Note the file's `>>> EDIT` convention and that it placeholders the GCP
  project id: this is a public MIT repo and that overlay is a template, not our config.
- `deploy/charts/ax-next/gke-values.local.yaml` — gitignored, holds the real values.
- `deploy/charts/ax-next/values.yaml:276` — the `sandbox.filestore` block and the long
  comment on what `hostReadPath` costs. Read it; it is the argument in full.
- `deploy/charts/ax-next/templates/host/deployment.yaml` — `AX_FILESTORE_*` env, the
  `user-files-read` volume, the `readOnly: true` mount.
- `deploy/charts/ax-next/templates/networkpolicies/agent-runtime-network.yaml` — host NFS egress.
- `deploy/charts/ax-next/templates/networkpolicies/sandbox-restrict.yaml` — runner NFS egress.
- `deploy/charts/ax-next/__tests__/render.test.ts` — asserts all three halves line up, and
  asserts each ABSENT by default. If you change a key name, this is what tells you.

**The behaviour that moves**
- `packages/agent-runner-core/src/run-runner.ts:1033` — `homeDir = userFilesRoot ?? workspaceRoot`.
- `packages/workspace-filestore/src/plugin.ts` — the resolver that loads when `server` is set.
- `packages/sandbox-k8s/src/user-files-ops.ts` — host-read (both realizations) + the
  `agents:deleted` cleanup pod.
- `packages/user-files-read/src/confined-read.ts` — the confinement W2 and W9 are testing.

**The surface**
- `packages/channel-web/src/server/routes-workspace.ts` — `agentUserFiles` / `agentUserFile`.
- `packages/channel-web/src/components/workspace/AgentFiles.tsx` — read the header before
  judging an empty state; the four-way distinction is design rule H7 and is deliberate.

**Deploy**
- `Makefile:213` `gke-deploy`; `:61-66` the values files, release name and tag derivation.
- `deploy/MANUAL-ACCEPTANCE.md` — the kind goldenpath, for the shape of a walk.

---

## Gotchas

- **`pnpm --filter` goes BEFORE the script name.** `pnpm test --filter @ax/x` silently runs
  the whole repo suite.
- **The full gate is three suites.** `pnpm -r --no-bail run test && pnpm test:eslint-rules &&
  pnpm test:scripts`. The recursive part alone skips two.
- **`make gke-deploy` tags with the last commit**, not your working tree. Commit first.
- **The Bash tool here runs zsh**; brace `${i}` before a `:`.
- **`gcloud` creds expire** with a reauth prompt that cannot run non-interactively. If
  `kubectl` fails with "Reauthentication failed", run `gcloud auth login` — not
  `application-default login`, which is a different credential and will not fix `kubectl`.

---

## Definition of done

- `sandbox.filestore` in `gke-values.yaml`, committed.
- W1–W9 walked, with W2 and W4 explicitly recorded — those two are the reason the card exists.
- Findings written to `.claude/memory/` (`context.md` for what production now looks like;
  `mistakes.md` if the walk caught something) and committed.
- #506 closed with the walk result. If W2 failed, it is closed by a rollback and a bug card,
  not by a fix bolted onto this one.

---

## Out of scope

- **Migrating existing agent files from `/agent` to `/files`.** Nothing does this, and doing
  it silently would be worse than the reset — the files stay visible under "Agent workspace".
  If it turns out to matter, that is its own card with its own design.
- **Browsing memory and artifacts** in the same UI. Memory is served by `workspace:read` and
  artifacts live in the blob store, so "browse everything" is three backends behind one UI.
  Worth doing, after this.
- **Renaming the code vocabulary** (`AX_WORKSPACE_ROOT` → `AX_AGENT_ROOT`, `workspace:*` →
  `agent-state:*`). Considered and rejected on the F1–F4 branch; see
  `.claude/memory/decisions.md`, "Path-tier vocabulary". Do not fix it as a side quest.
