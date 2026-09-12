# ux-first-run — acceptance-walk handoff

**For:** the session that finishes walking the `ux-first-run` track in a browser.
**Status:** all 12 cards merged (PRs #520–#532) plus walk follow-ups (#533).
Board `TASK-334 … TASK-345` all **Done**. `main` @ `71f436f8` or later.
**Remaining:** a browser walk of six surfaces. No code is known-broken.

---

## What is already true

The track shipped. Do not re-do it. `docs/plans/2026-09-06-ux-first-run-audit.md`
is the design; `docs/plans/2026-09-11-ux-humanization-track-handoff.md` is the
plan it came from; `docs/plans/2026-09-11-ux-first-run-copy-spec.md` is the
vocabulary/error-shape contract every card followed — **read that one before
writing any new copy**, it is the reason twelve PRs agree with each other.

A first walk covered six cards and is written up in the PR bodies. Verified in a
real browser, with numbers where numbers were the point:

- **338** Radix swap: Escape closes, `aria-expanded` flips,
  `aria-haspopup="menu"`, and **focus returns to the trigger** (no unit test
  covers that). The theme control is a real `radiogroup` of `radio`s — which is
  why `ToggleGroup` was declined, it roots at `role="group"`.
- **337 C1** verified in its *real* failure (the mock does not serve
  `/api/chat/conversations`), retry genuinely re-fetches, error row fits the
  240px rail.
- **340** walked end-to-end on the cluster: Step 1→2→3 with the right `n`, B9's
  link copy, B8's mechanism-agnostic admin line, the 401 token branch.
- **339** B2 in its real failure path, B3's focus ring painting.
- **336** "New chat", AgentMenu footnote.
- **Dark mode measured**: error text 4.63:1, Try again 4.63:1, empty state
  6.14:1 — above the WCAG AA floor of 4.5. Not muddy.

#533 fixed three things the walk found: the wizard rendering the literal string
`invalid-email` at a first-run user; instructional copy at 2.04:1 contrast; and
Vite's dev proxy missing the onboarding endpoints.

---

## What is left to walk

Six surfaces, all reachable once setup completes. None is known-broken — this is
acceptance, not debugging.

| Card | Surface | What to look at |
|---|---|---|
| **341** | Admin → **Helper model** | Renamed from "Default AI model" in nav, shell header and page. Retry row alignment on the load error. A long team name in an agent card caption. |
| **342** | Admin → Sign-in methods | `Switch` primitive's size against the row (the hand-rolled one was 24×44). The **last-provider lockout dialog** — does the warning read as serious at the moment it actually matters? |
| **343** | Admin → Teams, Skills, bundle review | Attachment row hierarchy with a long description. Whether "Approve" still reads as primary beside "Reject". |
| **344** | Settings → Connectors / credentials | The two-line slot heading (label + mono id) at narrow dialog widths. Whether the sheet description reads redundant next to the title for a `provider` destination, where both resolve to the same service name. |
| **345** | Settings → Routines → Schedule | The live cron preview's placement under a two-column field row. The **invalid state's `text-warning` tone in dark mode** — measure it, do not eyeball it. |
| **334** | The permission card | Hardest to reach: needs an agent to request a capability mid-turn. The trust copy, and the `TriangleAlert` Alert in dark. |

Also unwalked and worth 10 minutes: **335 A3** — a *failed* tool step's
`text-destructive` header and a *held* step's `text-warning` header in the
collapsed chain-of-thought. Needs a turn that actually fails or holds.

---

## How to run it

```bash
# 1. Keys. .env.walk lives in the MAIN CHECKOUT and is gitignored, so a
#    worktree does NOT have it. This cost the first session a wrong conclusion.
set -a; . /Users/vpulim/dev/ai/ax-next/.env.walk; set +a

# 2. Cluster (~8 min the first time; the image build is the long pole)
kind create cluster --name ax-next-dev
kubectl config use-context kind-ax-next-dev
docker build -t ax-next/agent:dev -f container/agent/Dockerfile .
kind load docker-image ax-next/agent:dev --name ax-next-dev
make kind-prune
kubectl create namespace ax-next-runners
helm upgrade --install ax-next deploy/charts/ax-next \
  --namespace ax-next --create-namespace \
  -f deploy/charts/ax-next/kind-dev-values.yaml \
  --set image.repository=ax-next/agent --set image.tag=dev \
  --set credentials.key="$(openssl rand -base64 32)" \
  --set anthropic.apiKey="$ANTHROPIC_API_KEY" \
  --set http.cookieKey="$(openssl rand -hex 32)" \
  --set auth.devBootstrap.token="$(openssl rand -hex 16)"

# 3. Wait — NOTE THE LABEL. The k8s-acceptance-loop skill documents
#    `app.kubernetes.io/component=ax-next-host`, which matches NOTHING.
kubectl -n ax-next wait --for=condition=Ready pod \
  -l app.kubernetes.io/name=ax-next-host --timeout=300s

# 4. Port-forward + the SPA pointed at it
kubectl -n ax-next port-forward svc/ax-next-host 9090:9090 &
cd packages/channel-web && AX_BACKEND_URL=http://localhost:9090 pnpm dev
# → http://localhost:5173
```

Then complete the wizard: the bootstrap token is printed in the host log —
`kubectl -n ax-next logs deploy/ax-next-host | grep -A1 'First-run bootstrap'`.
Step 3 needs the real `ANTHROPIC_API_KEY`; a placeholder is rejected with "That
API key was rejected", which is where the first session stopped.

### Measure contrast, do not eyeball it

The single most useful thing the first walk did. In `browser_evaluate`, compute
the WCAG ratio of an element's colour against the first non-transparent
background up its parent chain, and compare against **4.5:1** for normal text.
That is how the 2.04:1 footnote was found, and how its fix was confirmed at
6.14:1. A screenshot will not tell you.

---

## Traps that cost the first session real time

- **`.env.walk` is in the main checkout, not the worktree.** Gitignored, so
  `git worktree add` does not carry it. The first session concluded "no key
  exists" and cut the walk short on that basis.
- **The offline mock has drifted from the app.** `packages/channel-web/mock/`
  serves `/api/chat/sessions` and `/api/agents`; the app calls
  `/api/chat/conversations` and `/api/chat/agents`. So with `AX_BACKEND_URL`
  unset you cannot render the conversation list, agents, or any settings
  surface — and assistant-ui's runtime sits in an error state, which is why
  composer submits (including the `/status` dev trigger) silently do nothing.
  **Use the cluster, not the mock, for anything past the login screen.**
- **`/setup` is both an API prefix and an SPA route.** #533 added
  `/setup/claim|admin|model` to the Vite proxy individually. Do not "simplify"
  that to a `/setup` prefix — it sends the wizard page itself to the backend and
  the app renders blank.
- **Radix opens on `pointerdown`.** `fireEvent.click` / `element.click()` leaves
  a menu shut, silently. In Playwright use a real click, or dispatch a
  `PointerEvent`. And Radix arms its outside-dismiss listener on a
  `setTimeout(0)`, so a dismissal check needs a tick flushed first.
- **The `/error` dev trigger has drifted**: it injects its own DOM with buttons
  hardcoded "Retry", while the real `AgentStatus` says "Try again" since audit
  A9. DEV-only, ships to nobody, but do not use it to verify A9.

---

## The workspace flag — read this before walking anything

`features.agentWorkspace` in the chart is **`false` by default**, and that is a
deliberate capability boundary, not a cosmetic toggle: with it off the preset
never registers `/api/workspace/*`, so the surface does not exist on the wire.
The client fails closed to match (`DEFAULT_FEATURES` all-off; any fetch error,
non-2xx or malformed body → all-off).

**So a stock deployment lands on the old chat UI at `/`, and that is what the
first walk exercised.** When the flag is on, the workspace takes over `/` *and*
answers at `/workspace`; chat keeps `/chat`. There is deliberately no way to
have one without the other — `lib/features.ts` says that would be a second flag.

Vinay has asked whether the workspace should be the default. **That is an open
product decision — do not flip it unilaterally.** If he says yes, it is one line
(`features.agentWorkspace: true`) plus a walk of the workspace surfaces, which
this track never touched because the audit called them exemplary.

---

## Ground rules

- Every bug fixed in the loop gets a regression test in the same change
  (CLAUDE.md Bug Fix Policy). The browser passing is necessary, not sufficient.
- Full gate before any PR:
  `pnpm build` — then
  `pnpm -r --no-bail run test && pnpm test:eslint-rules && pnpm test:scripts` —
  then `pnpm lint`. `pnpm build` caught two things vitest could not on this
  track; never substitute the suite for it.
- Copy follows `CLAUDE.md`'s Voice & Tone and the copy spec. Invoke the
  `ux-design` and `shadcn` skills before writing UI.
- Audit open questions 1–4 stay open. Each affected card carries an assumption
  that does not foreclose them. If a fix tempts you to decide one, escalate.
- Tear down when done: `kind delete cluster --name ax-next-dev`, restore the
  kubectl context (the first session's was
  `gke_canopy-ai-498321_us-central1-a_ax-next-std`), stop the dev server.

---

## Kickoff prompt

After `/clear`:

```
Finish the acceptance walk of the ux-first-run track. Read
docs/plans/2026-09-12-ux-first-run-walk-handoff.md first — it has the setup
commands, the six surfaces left, and the traps that cost the last session time.

All 12 cards are merged (#520-#532) plus follow-ups (#533); nothing is
known-broken. This is acceptance, not debugging: drive the surfaces in a real
browser via Playwright against the ax-next-dev kind cluster and confirm each
renders as intended in light AND dark.

Keys: `set -a; . /Users/vpulim/dev/ai/ax-next/.env.walk; set +a` — it lives in
the MAIN checkout, not a worktree.

Measure contrast rather than eyeballing it; 4.5:1 is the floor for normal text.
That is how the last walk found a 2.04:1 footnote.

Anything you find gets a fix WITH a regression test, the full three-suite gate
plus pnpm build and pnpm lint, and its own PR.

Do not flip features.agentWorkspace — whether the workspace becomes the default
surface is an open product decision for Vinay.
```
