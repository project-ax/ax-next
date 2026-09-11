# ux-first-run — copy & vocabulary spec

**Companion to:** `docs/plans/2026-09-06-ux-first-run-audit.md` (the findings) and
`docs/plans/2026-09-11-ux-humanization-track-handoff.md` (the plan).
**Applies to:** TASK-334 … TASK-345.

The audit names *what* is wrong surface by surface. This spec pins the decisions
that span surfaces, so twelve cards do not each invent their own answer. If a
card's wording and this spec disagree, the card wins for its own surface — but
raise it here first, because a disagreement usually means the whole track drifts.

---

## 1. Vocabulary

### The one word we are removing

**"Session" never means a conversation in user-facing text.** That is the
vocabulary drift the audit found (C3), and it is the only rename this track
makes across the whole package.

| Meaning | User-facing word | Notes |
|---|---|---|
| A back-and-forth with an agent, as an action | **chat** | "New chat", "starts a fresh chat" |
| The same thing, as a formal noun in prose or a list | **conversation** | "No conversations yet.", "conversation titles" |
| The thing that ends when you are signed out | **session** | Legitimate. "Your session ended…" (B1) stays. |

So `session` survives in exactly one user-facing sense: the sign-in session.
**TASK-336's sweep must not touch it.** Grep hits to leave alone: anything about
signing in, signing out, expiry, or `HTTP_SESSION_ENDED`.

Everything else keeps its identifier. `SessionList`, `SessionHeader`,
`NewSessionButton`, `session-store.ts`, `sessionId` payload fields, routes and
storage keys are **code**, not copy. Invariant 1 and TASK-336's hard boundary:
display strings only.

### The other two words

- **key**, not "credential", and never "slot". "Add key" / "Replace key" /
  "Update key" / "Needs a key". `slot` is an identifier; it may appear only as
  secondary mono text beside a humanized label. (E1, E3, A1, E2)
- **agent** stays — it is the product's noun. But it is explained once, at first
  run, where the user meets it: "An agent is your personal assistant in ax." (B5)
  Everywhere after that, plain use is fine.

`skill`, `connector`, and `tool` likewise stay as product nouns.

---

## 2. The shared slot-label helper

**Module:** `packages/channel-web/src/lib/slot-label.ts`
**Introduced by:** TASK-334. **Reused unchanged by:** TASK-344.

TASK-344 is forbidden from duplicating this logic, so it lands in `lib/` from the
first commit — not inline in `PermissionCard.tsx`. It sits beside the package's
existing humanizers (`lib/tool-name.ts`, `lib/tool-phrase.ts`), which are the
house precedent for exactly this move.

```ts
humanizeSlotId(slotId: string): string
humanizeProviderId(providerId: string): string
```

Rules, in order:

1. Split on `_`, `-`, and camelCase boundaries.
2. Map each token through a known-token table — acronyms uppercase (`api` → `API`,
   `url` → `URL`, `id` → `ID`, `pat` → `PAT`), brands cased as they brand
   themselves (`anthropic` → `Anthropic`, `openai` → `OpenAI`, `openrouter` →
   `OpenRouter`, `github` → `GitHub`, `xai` → `xAI`, …).
3. Everything else lowercases, except the first token, which sentence-cases.
4. Join with spaces.

| in | out |
|---|---|
| `api_key` | API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `client_secret` | Client secret |
| `foo_bar` | Foo bar |

Unknown ids must degrade to readable title-ish text, never to an empty string and
never to a throw. The helper is pure, has no React dependency, and is unit-tested
on its own.

**We do not invent data we do not have.** Where a humanized label is genuinely
unknowable from the id, show the id as secondary mono text rather than guessing.
A "Where do I get this?" link renders only when a URL is actually present in the
data — never a hardcoded guess. (Audit open question 1 stays open: manifest-carried
labels and URLs are a producer-side question. We consume them if present, and that
is all.)

---

## 3. Error copy — the house shapes

Every error says **what happened**, **why** where we honestly know, and **one next
action**. Three shapes cover this track:

**Load failed, retry is possible.** One plain line plus a "Try again" button.
Follow `AuthProvidersTab`'s existing pattern — it is the one already right.

> We couldn't load your conversations. — [Try again]

**Server-side failure, no useful detail for the user.**

> Something went wrong on our end. Give it another try in a moment.

**Something is misconfigured and only an admin can fix it.** Say so without
sending a non-admin to a door they cannot open.

> This agent can't run right now — the AI service it uses isn't set up on this
> server. An admin can fix this in Settings.

Rules that hold for all three:

- **No raw HTTP status, error code, or parser output in the UI.** It goes to
  `console` detail, where a developer can still find it. (B7, D7, D8)
- **The retry button is always "Try again."** Never "Retry".
- **Blame the connection before the operator**, because it is usually the
  connection. (B2)
- **An empty state is a claim.** It may only render when we actually know the list
  is empty. A failed fetch is not an empty list — that is C1, and it is a defect,
  not a copy nit.
- **No jokes on a failure, a security prompt, or an approval.** CLAUDE.md's voice
  allows warmth everywhere and humour in most places; not here.

---

## 4. Primitives

Invariant 6. Composed from the installed set — `alert`, `badge`, `button`,
`card`, `checkbox`, `collapsible`, `command`, `dialog`, `dropdown-menu`, `input`,
`label`, `popover`, `progress`, `select`, `separator`, `sheet`, `switch`, `table`,
`tabs`, `textarea`, `toggle-group`, `toggle`, `tooltip` — with semantic tokens
(`bg-background`, `text-muted-foreground`, `border-border`, `text-destructive`).
No raw colours, no hand-rolled widgets.

| Need | Primitive | Card |
|---|---|---|
| Warning / destructive notice | `Alert` + lucide `TriangleAlert` | 334, 339, 341 |
| Menu with keyboard nav | `DropdownMenu` | 338 |
| On/off that can lock people out | `Switch` + confirmation | 342 |
| Non-dismissible first-run dialog | `Dialog` + new `hideClose` | 340 |
| Icon-only control needing a name | `Tooltip` (visible label preferred) | 338 |

`alert-dialog` is **not** installed. TASK-342's confirmation composes `Dialog`
with an `Alert` inside rather than adding a primitive for one call site — if that
reads badly in review, add `alert-dialog` via
`pnpm dlx shadcn@latest add alert-dialog -c packages/channel-web`.

---

## 5. Scope fence

Restating it because it is the thing most likely to erode over twelve cards:

- Display strings and installed primitives. **No** behaviour, grant semantics,
  payload, IPC, identifier, route, or storage-key changes.
- The four audit open questions stay open. Each affected card carries an
  assumption that does not foreclose the answer (Q1→334, Q2→340, Q3→335, Q4→337).
  **If building a card tempts you to actually decide one, that is an escalation,
  not a judgement call.**
- The two honesty fixes are bugs, not polish: TASK-335's failed step reading
  "Ran a command", TASK-337's "No conversations yet." on a failed fetch. Bug Fix
  Policy applies — each gets a test that would have caught it.
