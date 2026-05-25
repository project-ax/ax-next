# auto-ship — the "TO DO" board (source of truth)

The GitHub **"TO DO"** Projects v2 board (org `project-ax`, project **#1**) **is** the
state for auto-ship — not a mirror. Cards, lanes, and the `Depends on` field are read on
every loop pass and written by the orchestrator (the **sole** board writer). The board
is owned by the org and **linked** to the repo so it shows under the repo's Projects
tab (v2 boards are never repo-owned; linking is the only way to surface them there).

The state↔lane map:

| auto-ship state | lane (`Status`) |
|---|---|
| gated / not-yet-actionable | **Backlog** |
| actionable, awaiting dispatch (incl. ready `(walk)` cards) | **To Do** |
| blocked on a human (triage-underspec OR agent-blocked) | **Needs Input** |
| dispatched, agent building, pre-PR | **In Progress** |
| PR open, queued for merge | **In Review** |
| merged / done | **Done** |
| quarantined by the failure breaker | **Parked** |

Readiness is **derived** from each To Do card's `Depends on` field — it is not a lane.

## 0. Preconditions (the `project` token scope is required)

The board is load-bearing, so the scope is **not** optional here:

```bash
gh auth status 2>&1 | grep -q "project" || {
  echo "auto-ship: gh lacks the 'project' scope — the board is unreachable. Run: gh auth refresh -s project"
  exit 1
}
OWNER=project-ax
```

`--dry-run` performs **no** board writes (read-only field/item-list calls only).

## 1. Resolve the board + ensure it's linked (once per run)

```bash
PNUM=$(gh project list --owner "$OWNER" --format json \
       | jq -r '.projects[] | select(.title=="TO DO") | .number' | head -1)
[ -z "$PNUM" ] && { echo "auto-ship: no 'TO DO' board under $OWNER — create it first."; exit 1; }
PROJ_ID=$(gh project view "$PNUM" --owner "$OWNER" --format json | jq -r .id)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh project link "$PNUM" --owner "$OWNER" --repo "$REPO" 2>/dev/null || true   # idempotent
```

## 2. Resolve the `Status` + `Depends on` field ids (+ ensure the lane set)

```bash
FIELDS=$(gh project field-list "$PNUM" --owner "$OWNER" --format json)
STATUS_FIELD_ID=$(printf '%s' "$FIELDS" | jq -r '.fields[] | select(.name=="Status") | .id')
DEPS_FIELD_ID=$(printf '%s' "$FIELDS"   | jq -r '.fields[] | select(.name=="Depends on") | .id')
# build a lane-name → option-id map:
printf '%s' "$FIELDS" | jq -r '.fields[] | select(.name=="Status") | .options[] | "\(.name)\t\(.id)"'
```

Expected seven lanes — **Backlog, To Do, Needs Input, In Progress, In Review, Done,
Parked**. If a lane is **missing** from an existing board (e.g. **Needs Input** on a
board created before that lane existed), add it with the **additive** path in §2a —
**never** the full-replace, which clears every card's Status. If the `Depends on`
field is missing, create it (text):

```bash
[ -z "$DEPS_FIELD_ID" ] && gh project field-create "$PNUM" --owner "$OWNER" \
  --name "Depends on" --data-type TEXT
```

### 2a. (Re)define the 7-lane set — empty board only

`singleSelectOptions` **REPLACES the entire option set**, which would unset every
card's status. Run this **only** on a board with no cards (initial setup); otherwise
the seven lanes already exist and you just map names → ids in §2.

```bash
gh api graphql -f query='mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[
  {name:"Backlog",color:GRAY,description:"Gated / not-yet-actionable; orchestrator never pulls"},
  {name:"To Do",color:YELLOW,description:"Actionable inbox; orchestrator drains dep-free cards"},
  {name:"Needs Input",color:PINK,description:"Blocked on a human — fill in the card and drag back to To Do"},
  {name:"In Progress",color:BLUE,description:"A yolo-ship agent is building it"},
  {name:"In Review",color:PURPLE,description:"PR open, queued for the serial merge"},
  {name:"Done",color:GREEN,description:"Merged"},
  {name:"Parked",color:ORANGE,description:"Quarantined by the failure breaker"}
]}){projectV2Field{... on ProjectV2SingleSelectField{id options{name id}}}}}' -f f="$STATUS_FIELD_ID"
```

(`color` enum: `GRAY BLUE GREEN YELLOW ORANGE RED PINK PURPLE`. For org-owned
projects, GraphQL that walks from the owner uses `organization(login:)` not
`user(login:)`; walking from the project node id — `node(id:$PROJ_ID){... on
ProjectV2{...}}` — avoids that branch.)

**Adding ONE lane to a POPULATED board (additive — preserves every card's Status).**
The full-replace above is **empty-board-only**. To add a lane to a board that already
has cards, re-send **every existing option with its `id`** (updated in place) plus the
new id-less option (created). `name` / `color` / `description` are all required, and
`field-list` omits colors, so read the options via GraphQL first. (Equivalently: add
the option in the Projects web UI — same in-place effect, zero scripting risk.)

```bash
# read existing options WITH color+description (field-list returns neither)
OPTS=$(gh api graphql -f query='query($f:ID!){node(id:$f){... on ProjectV2SingleSelectField{options{id name color description}}}}' \
  -f f="$STATUS_FIELD_ID" | jq '.data.node.options')
# build the request body: keep all existing ids/colors, insert "Needs Input" after "To Do"
BODY=$(jq -nc --arg f "$STATUS_FIELD_ID" --argjson opts "$OPTS" '
  ($opts | map({id,name,color,description})) as $e
  | ($e | map(.name) | index("To Do")) as $i
  | {query:"mutation($f:ID!,$o:[ProjectV2SingleSelectFieldOptionInput!]!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:$o}){projectV2Field{... on ProjectV2SingleSelectField{options{id name}}}}}",
     variables:{f:$f, o:($e[0:$i+1]
       + [{name:"Needs Input",color:"PINK",description:"Blocked on a human — fill in the card and drag back to To Do"}]
       + $e[$i+1:])}}')
printf '%s' "$BODY" | gh api graphql --input -   # existing ids re-sent ⇒ item values preserved
```

Each existing option carries its `id`, so GitHub updates it in place; only the id-less
`Needs Input` is created — no card loses its Status. (The option input type accepts an
optional `id`; a full-replace **without** ids regenerates them and clears assignments —
that's the §2a hazard.)

## 2b. The batched board helper (written at run start)

Write this next to the poller (§5) and progress helper (§6) at run start (gitignored).
It centralizes the two GraphQL-frugal primitives: `board_snapshot` (one cached read per
pass, §3) and `board_batch` (many field writes in one aliased mutation, §4).

```bash
cat > .claude/auto-ship-board.sh <<'SH'
#!/usr/bin/env bash
# Batched GitHub Projects v2 helpers — keep GraphQL call volume low (5000 pts/hr).
BOARD_CACHE=.claude/auto-ship-board.json
# board_snapshot — fetch the WHOLE board once, cache to disk, echo the path. Non-zero on
# a rate-limited/empty read so callers don't act on garbage. Reuse the cache all pass.
board_snapshot() {
  local j
  j=$(gh project item-list 1 --owner project-ax --format json --limit 200 2>/dev/null) || return 1
  printf '%s' "$j" | jq -e '.items | type=="array" and length>0' >/dev/null 2>&1 || return 1
  printf '%s' "$j" > "$BOARD_CACHE"; echo "$BOARD_CACHE"
}
# board_batch <projectId> <op>...  — ONE aliased mutation for many writes.
#   op: "<itemId>|<fieldId>|single|<optionId>"  or  "<itemId>|<fieldId>|text|<value>"
board_batch() {
  local proj="$1"; shift
  [ "$#" -eq 0 ] && { echo "board_batch: no ops"; return 2; }
  local decl="mutation(\$p:ID!" sel="" i=0; local -a args=(-f "p=$proj")
  local op item field kind val
  for op in "$@"; do
    i=$((i+1)); item=${op%%|*}; op=${op#*|}; field=${op%%|*}; op=${op#*|}; kind=${op%%|*}; val=${op#*|}
    decl+=",\$it$i:ID!,\$fd$i:ID!,\$v$i:String!"
    args+=(-f "it$i=$item" -f "fd$i=$field" -f "v$i=$val")
    if [ "$kind" = "single" ]; then
      sel+=" a$i:updateProjectV2ItemFieldValue(input:{projectId:\$p,itemId:\$it$i,fieldId:\$fd$i,value:{singleSelectOptionId:\$v$i}}){projectV2Item{id}}"
    else
      sel+=" a$i:updateProjectV2ItemFieldValue(input:{projectId:\$p,itemId:\$it$i,fieldId:\$fd$i,value:{text:\$v$i}}){projectV2Item{id}}"
    fi
  done
  gh api graphql -f query="${decl}){${sel} }" "${args[@]}" >/dev/null 2>&1 \
    && echo "board_batch: $i write(s) in 1 request" || { echo "board_batch: FAILED"; return 1; }
}
SH
chmod +x .claude/auto-ship-board.sh
```

## 3. Read the board (each loop pass) — ONE read, reuse it

`gh project item-list` is a **heavy GraphQL query** (it returns every item with its
field values *and* `.content.body`). The GraphQL budget is **5000 points/hour**, so
calling it 3–5× per pass — once for the ready set, again per item id, again per body,
again for the snapshot hash — **exhausts the budget** (this happened; the whole loop
stalled for ~6 min). **Read the whole board exactly once per pass** and derive
everything from that single JSON:

```bash
ITEMS=$(gh project item-list "$PNUM" --owner "$OWNER" --format json --limit 200)   # the ONLY board read this pass
# ready set + deps:
printf '%s' "$ITEMS" | jq -r '.items[] | select(.status=="To Do") | "\(.title)\tdeps=\(."depends on" // "")"'
# an item's node id AND its body come from the SAME JSON — never re-query for them:
printf '%s' "$ITEMS" | jq -r --arg p "[$TASK_ID] " '.items[] | select(.title|startswith($p)) | "\(.id)\t\(.content.body // "")"'
```

Bind `$ITEMS` once; jq it for the ready set, dispatch ids+bodies, the §5 snapshot hash,
and the §7 reconcile — **do not call `gh project item-list` again within the pass.**
(The run-start helper `.claude/auto-ship-board.sh` provides `board_snapshot`, which
caches the read to `.claude/auto-ship-board.json` for exactly this reuse.)

**Re-emit captured JSON with `printf '%s'`, never `echo`.** `echo "$ITEMS"` interprets
backslash escapes (zsh, and bash under `xpg_echo`), so a card body containing literal
`\n` / `\t` is mangled into raw control bytes and `jq` dies with *"control characters …
must be escaped"*. `printf '%s' "$ITEMS" | jq …` (used throughout this doc) prints the
JSON verbatim. (The `board_snapshot` / poller pipes feed `gh … | jq` directly, so
they're already safe.)

`.status` is the lane name (e.g. `"To Do"`). `."depends on"` is the dependency field
(empty = un-analyzed; `none` = analyzed-no-deps; else space/comma-separated Task IDs).

## 4. Write the board (orchestrator only)

```bash
# find-or-create a card by [TASK-ID] prefix:
ITEM_ID=$(printf '%s' "$ITEMS" | jq -r --arg p "[$TASK_ID] " \
  '.items[] | select(.title // "" | startswith($p)) | .id' | head -1)
[ -z "$ITEM_ID" ] && ITEM_ID=$(gh project item-create "$PNUM" --owner "$OWNER" \
  --title "[$TASK_ID] $TASK_TITLE" --body "$TASK_BODY" --format json | jq -r .id)

# move a card to a lane (OPT_ID from the §2 map):
gh project item-edit --id "$ITEM_ID" --project-id "$PROJ_ID" \
  --field-id "$STATUS_FIELD_ID" --single-select-option-id "$OPT_ID"

# set / rewrite its deps:
gh project item-edit --id "$ITEM_ID" --project-id "$PROJ_ID" \
  --field-id "$DEPS_FIELD_ID" --text "$DEPS"      # e.g. "ARCH-4 ARCH-5"  or  "none"
```

**Batch multi-writes into ONE GraphQL request.** Each `gh project item-edit` is its own
GraphQL mutation, so moving 3 cards = 3 calls and "create card → set Status → set deps"
= 3 calls. When more than one field write happens together, use **`board_batch`** (from
`.claude/auto-ship-board.sh`, written at run start) — it sends all the writes as a
single aliased mutation. A single `item-edit` is fine for a lone write; reach for
`board_batch` whenever ≥2 writes coincide (slot-fill moves, follow-up create+route,
terminal move):

```bash
source .claude/auto-ship-board.sh
# fill 3 slots → In Progress in ONE request (vs 3 item-edit calls):
board_batch "$PROJ_ID" "$ID1|$STATUS_FIELD_ID|single|$INPROG" \
                       "$ID2|$STATUS_FIELD_ID|single|$INPROG" \
                       "$ID3|$STATUS_FIELD_ID|single|$INPROG"
# a new follow-up card's Status + Depends on in ONE request (create still separate):
ID=$(gh project item-create "$PNUM" --owner "$OWNER" --title "$T" --body "$B" --format json | jq -r .id)
board_batch "$PROJ_ID" "$ID|$STATUS_FIELD_ID|single|$TODO" "$ID|$DEPS_FIELD_ID|text|none"
```

The card **body** is written through a different door — the delimited progress block
(§6), never `--body` whole-replace. The orchestrator does **not** append a PR link to
the body any more: the building agent logs `PR #<n> opened` into its own progress
block, so there is only ever one body writer at a time (§6).

Transitions (orchestrator, AFTER the journal write): dependency cleared / card lands
in To Do → leave in **To Do**; dispatch → **In Progress**; `pr-green` / PR open →
**In Review** (the agent already logged `PR #<n> opened` in the block); merged →
**Done** (`append_progress … "merged #<n> ✅"`); quarantined → **Parked** (+ `🛑`
title prefix + `append_progress … "🛑 parked — <signature>"`); triage-underspec or an
agent `blocked` handoff → **Needs Input** (the fill-in-the-blank block lands in the
body via `set_needs_input`, §8 — **not** a failure attempt). **Needs Input → To Do is
a human drag**, never an orchestrator write; it re-enters via the triage gate (§8).
Walk cards stay in **Backlog** unless a human moves them to To Do.

## 5. The poller (token-free To Do watcher)

Write this at run start and launch it with the Bash tool, `run_in_background: true`.
It burns **no model tokens** while idle and `exit 0`s — re-invoking auto-ship — the
moment the To Do lane changes (a card added/removed/renamed, a dep edited, a
Backlog→To Do promote). Re-launch it after every loop pass.

```bash
cat > .claude/auto-ship-board-poll.sh <<'SH'
#!/usr/bin/env bash
# Exits 0 when the To Do lane changes vs the cached snapshot (re-invokes auto-ship).
SNAP=.claude/auto-ship-todo-snapshot.txt
while true; do
  CUR=$(gh project item-list 1 --owner project-ax --format json \
    | jq -S '[.items[] | select(.status=="To Do") | {id, title, deps:(."depends on" // "")}]')
  H=$(printf '%s' "$CUR" | { shasum 2>/dev/null || sha1sum; } | cut -d" " -f1)
  if [ "$H" != "$(cat "$SNAP" 2>/dev/null)" ]; then
    printf '%s' "$H" > "$SNAP"; echo "TO-DO CHANGED"; exit 0
  fi
  sleep 60
done
SH
chmod +x .claude/auto-ship-board-poll.sh
```

**Snapshot-refresh discipline (avoids self-triggering):** the orchestrator's own pass
mutates To Do (moves a card out, writes deps), which would re-trip the poller. So at
the **end** of each pass — after all board writes, before re-launching the poller —
recompute the hash and overwrite `.claude/auto-ship-todo-snapshot.txt` with it, so the
poller's next compare sees no change and sleeps. The first launch has an empty
snapshot, so it fires immediately → that's the run-start review.

The poller hashes **only the To Do lane**. All progress-block writes (§6) land on
**In Progress** cards, so they never trip the poller — no self-trigger from the live
heartbeat.

## 6. The progress block (live per-card heartbeat)

Each card body carries a delimited, append-only progress log that the *building
agent* writes as it moves through yolo-ship's phases. It is the board-visible
heartbeat + exception feed for a watching human — and, after a crash, the recovery
audit trail (§7). The markers fence off a region; **everything outside them — the
human-authored description, hand notes — is always preserved**:

```
<original task description — never touched>

<!-- AUTOSHIP-PROGRESS:START -->
### Progress
- 14:05 brainstorm done — approach: …
- 14:42 PR #210 opened
- 14:55 ⚠ CI red — preset.test
<!-- AUTOSHIP-PROGRESS:END -->
```

Lines are `- HH:MM <text>`; **exceptions get a leading `⚠`** so a human can scan a
card for trouble. The per-phase line catalogue lives in yolo-ship's **Progress
reporting** section.

**One writer at a time — structural, not locked.** The body has exactly one writer
at any instant:

- the **agent** owns it while the card is **In Progress** (append-only, its own card only);
- the **orchestrator** writes it only at **terminal** transitions (→ Done, → Parked),
  by which point the agent has returned its handoff and exited;
- the orchestrator no longer appends the PR link itself — the agent logs
  `PR #<n> opened` in the block (one fewer body writer).

The agent **never** touches `Status` or `Depends on` (routing stays
orchestrator-owned) and **never** writes another card.

**Token discipline — the read-modify-write stays in shell.** The body grows with
each line, so it must **never** be read into the model's context. `append_progress`
fetches the body, splices the block, and writes it back **entirely in shell**,
surfacing only `progress: …` / `skip` to the model. Write it next to the poller at
run start (`.claude/auto-ship-progress.sh`, gitignored); the orchestrator sources it
for its terminal writes, and the dispatch prompt passes its **absolute path** to each
agent.

```bash
cat > .claude/auto-ship-progress.sh <<'SH'
#!/usr/bin/env bash
# append_progress <project-item-node-id> "<line>"
# Best-effort, shell-side RMW of the delimited block in a draft-issue card body.
# The body NEVER enters the model's context — only "progress:"/"skip" is echoed.
# A failed write is non-fatal: progress is observability, never a ship blocker.
append_progress() {
  local item="$1" line="$2" now; now=$(date +%H:%M)
  local START='<!-- AUTOSHIP-PROGRESS:START -->'
  local END='<!-- AUTOSHIP-PROGRESS:END -->'
  local entry="- $now $line"
  local q='query($i:ID!){node(id:$i){... on ProjectV2Item{content{... on DraftIssue{id body}}}}}'
  local json cid body
  json=$(gh api graphql -f query="$q" -f i="$item" 2>/dev/null) || { echo "progress: skip (read)"; return 0; }
  cid=$(printf '%s' "$json" | jq -r '.data.node.content.id // empty')
  body=$(printf '%s' "$json" | jq -r '.data.node.content.body // ""')
  [ -z "$cid" ] && { echo "progress: skip (not a draft-issue card)"; return 0; }
  local nb
  if printf '%s' "$body" | grep -qF "$START"; then
    nb=$(printf '%s' "$body" | awk -v e="$entry" -v end="$END" '$0==end{print e} {print}')
  else
    nb=$(printf '%s\n\n%s\n### Progress\n%s\n%s' "$body" "$START" "$entry" "$END")
  fi
  gh api graphql -f query='mutation($d:ID!,$b:String!){updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){draftIssue{id}}}' \
    -f d="$cid" -f b="$nb" >/dev/null 2>&1 \
    && echo "progress: $entry" || echo "progress: skip (write)"
}
SH
chmod +x .claude/auto-ship-progress.sh
```

Shell state does **not** persist across Bash calls, so `source` + call go in the
**same** invocation each time:

```bash
source .claude/auto-ship-progress.sh && append_progress "$ITEM_ID" "merged #$PR ✅"
```

(Cards are **draft issues** — auto-ship creates them with `gh project item-create
--title --body` — so the read/write target the `DraftIssue` content node. A card that
is a linked real issue/PR is skipped, harmlessly.)

## 7. Crash recovery — reconcile orphaned in-flight cards (run-start wake only)

If the CLI running auto-ship dies, the dispatched agents and the poller die with it,
stranding cards in **In Progress** / **In Review** with no agent — and, because the
concurrency cap counts them as in-flight, they would silently consume slots forever.
A *fresh* `/auto-ship` therefore cannot own any live agents — so on the
**run-start / resume wake only** (never a board-change or agent-done wake) it
reconciles every In Progress + In Review card against ground truth, with **no risk of
reaping a live agent**. (Cards in **Needs Input** are *not* in-flight — no agent owns
them — so reconcile never touches them; they wait on the human.)

**Single-instance guard** (don't reconcile a still-live sibling's cards — refresh it
every pass as a heartbeat):

```bash
LOCK=.claude/auto-ship-owner.lock
if [ -f "$LOCK" ] && [ "$(( $(date +%s) - $(cat "$LOCK") ))" -lt 900 ]; then
  echo "auto-ship: recent owner lock ($(cat "$LOCK")) — another run may be live; refusing to reconcile. rm $LOCK to override."; exit 1
fi
date +%s > "$LOCK"
```

**Reconcile.** The policy leans on yolo-ship opening the PR only in **Phase 6** — so a
PR's existence ⇒ Phases 0–5 finished, the work is not lost:

```bash
# in-flight cards: TASK-ID (from title) + item node id
printf '%s' "$ITEMS" | jq -r '.items[] | select(.status=="In Progress" or .status=="In Review")
  | "\(.title)\t\(.id)"'
# per card, by [TASK-ID]: is there an open PR titled "[TASK-ID] …"?
gh pr list --state open --search "[$TASK_ID] in:title" \
  --json number,mergeable,statusCheckRollup,headRefName
```

| Orphan | Action |
|---|---|
| PR exists (In Review, or In Progress) | move/keep → **In Review**; the serialized merge queue takes it (green+mergeable → merge; not-mergeable/red → rebase + re-green). `append_progress … "⚠ orchestrator restarted — PR #<n> found, routing to merge"`. |
| In Progress, **no** PR | agent died pre-Phase-6 → move → **To Do** for a fresh re-dispatch; clean up the abandoned worktree/branch (below); `append_progress … "⚠ orchestrator restarted — no PR, reset to To Do"`. **Not** an attempt against the cap (a crash ≠ a task failure), but journal it (`recovered`) so the global breaker still bounds crash-loops. |

**Abandoned-branch cleanup** (no-PR reset only — never when a PR exists, that work
ships):

```bash
for b in $(git branch --list "auto-ship/$TASK_ID-*" --format '%(refname:short)'); do
  wt=$(git worktree list --porcelain | awk -v b="$b" '/^worktree /{w=$2} /^branch /{if($2=="refs/heads/"b) print w}')
  [ -n "$wt" ] && git worktree remove --force "$wt" 2>/dev/null
  git branch -D "$b" 2>/dev/null
  git push origin --delete "$b" 2>/dev/null || true   # harmless if never pushed
done
git worktree prune
```

Reconciliation keys off the **`Status` lane + PR ground truth**, not the progress
block — so a crash mid-body-write is tolerated. The journal
(`.claude/auto-ship-log.md`) survives on disk, so **attempt counts rebuild across the
crash**: a card that already burned an attempt does not get a free reset.

## 8. Triage gate — auto-assign IDs + catch underspecified cards

Runs as the **first step of the review phase** on every To Do-change wake, *before*
dependency review. Three jobs: give untagged cards a stable ID, tag walks, and route
underspecified cards to **Needs Input**.

### 8.1 Candidate detection (shell-side — no body read)

A To Do card is a **triage candidate** this pass iff it has **no current `triaged
<TASK-ID> clean` row** in the journal (`.claude/auto-ship-log.md`). That one rule
covers all three sources without the orchestrator ever reading a body:

- brand-new human cards (also need an ID — §8.2),
- follow-up cards auto-ship created from agent handoffs (have IDs, never triaged),
- cards re-promoted from **Needs Input → To Do** (latest row is `needs-input` /
  `blocked`, not `clean` → re-evaluated).

Zero candidates ⇒ dispatch **no** triage agent (steady-state passes cost nothing).
Triage runs **synchronously** at the top of the pass and **does not consume a code
slot** (like a walk).

```bash
# candidates = To Do cards whose TASK-ID has no later `triaged … clean` in the journal
printf '%s' "$ITEMS" | jq -r '.items[] | select(.status=="To Do") | "\(.title)\t\(.id)"'
# (cross-reference each TASK-ID against .claude/auto-ship-log.md — titles only, never bodies)
```

### 8.2 ID assignment + walk tag (orchestrator, shell-side)

**Untagged** = the title does not match `^\[(ARCH|CLI|SYNC|FAULTA|TASK)-[0-9]+\] `.
For each untagged candidate, assign the next **`TASK-n`** (n = max existing
`[TASK-<num>]` across the whole board + 1; sequential for several in one pass,
computed from the already-bound `$ITEMS` so there's no race) and rewrite the title:

```bash
NEXT=$(printf '%s' "$ITEMS" | jq -r '.items[].title | capture("\\[TASK-(?<n>[0-9]+)\\]").n // empty' \
        | sort -n | tail -1); NEXT=$(( ${NEXT:-0} + 1 ))
gh project item-edit --id "$ITEM_ID" --title "[TASK-$NEXT] $ORIGINAL_TITLE"
```

The `(walk)` tag is appended **after** the triage agent's verdict (it needs the body).
Per convention a walk card carries **both** the ID **and** `(walk)` — never one instead
of the other. A human who pre-tagged `(walk)` keeps it.

### 8.3 The needs-input block + `set_needs_input` helper

Underspecified cards get a delimited block spliced into the body — same one-writer
discipline as the progress block (§6), human description preserved outside the markers:

```
<!-- AUTOSHIP-NEEDS-INPUT:START -->
### ⚠ Needs input before this can ship

Answer each question on its own line below (replace the `_…_` placeholder), then drag
this card back to **To Do**.

**Q1.** <question>
- _your answer_

**Q2.** <question>
- _your answer_
<!-- AUTOSHIP-NEEDS-INPUT:END -->
```

One question per **rendered block**, each with its own answer slot — never collapse
multiple questions into a single line. A human filling this in shouldn't have to
untangle a paragraph; the helper below does the splitting for you (see the quoting note).

The **triage agent** writes this block directly for the underspec path (it's already
reading the body, and no other writer owns a To Do / Needs-Input card). When re-triage
finds the answers sufficient, the agent **folds the Q&A into the durable description**
(a `## Clarifications` section outside the markers) and removes the block — the
dispatched builder then sees the answers as spec, and nothing the user typed is lost.

The **orchestrator** writes the block only for the `blocked` outcome (SKILL.md ›
Failure handling), where the questions arrive in the agent's handoff. It uses
`set_needs_input` — a shell-side body-RMW sibling of `append_progress`, written next to
it at run start, so the body never enters the orchestrator's context:

```bash
cat >> .claude/auto-ship-progress.sh <<'SH'
# set_needs_input <project-item-node-id> "<questions — one per line>"
# Shell-side RMW: replace/splice the NEEDS-INPUT block in a draft-issue body.
# Questions may be separated by real newlines (use $'q1\nq2' ANSI-C quoting) OR by a
# literal backslash-n — both are normalized so each question becomes its own
# answer-ready block. A "q1\nq2" double-quoted string used to collapse into one item.
set_needs_input() {
  local item="$1" questions="$2"
  local START='<!-- AUTOSHIP-NEEDS-INPUT:START -->'
  local END='<!-- AUTOSHIP-NEEDS-INPUT:END -->'
  local q='query($i:ID!){node(id:$i){... on ProjectV2Item{content{... on DraftIssue{id body}}}}}'
  local json cid body items block stripped nb
  json=$(gh api graphql -f query="$q" -f i="$item" 2>/dev/null) || { echo "needs-input: skip (read)"; return 0; }
  cid=$(printf '%s' "$json" | jq -r '.data.node.content.id // empty')
  body=$(printf '%s' "$json" | jq -r '.data.node.content.body // ""')
  [ -z "$cid" ] && { echo "needs-input: skip (not a draft-issue card)"; return 0; }
  # normalize literal "\n" -> real newline (defensive), drop blanks, number each
  # question and give it its own answer slot so the human edits a clean list.
  items=$(printf '%s' "$questions" | awk '{ gsub(/\\n/, "\n"); print }' \
            | awk 'NF { printf "**Q%d.** %s\n- _your answer_\n\n", ++n, $0 }')
  block=$(printf '%s\n### ⚠ Needs input before this can ship\n\nAnswer each question on its own line below (replace the `_…_` placeholder), then drag this card back to **To Do**.\n\n%s%s' \
            "$START" "$items" "$END")
  # drop any prior block (markers inclusive), then append the fresh one
  stripped=$(printf '%s' "$body" | awk -v s="$START" -v e="$END" 'BEGIN{k=0} $0==s{k=1} k==0{print} $0==e{k=0}')
  nb=$(printf '%s\n\n%s' "$stripped" "$block")
  gh api graphql -f query='mutation($d:ID!,$b:String!){updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){draftIssue{id}}}' \
    -f d="$cid" -f b="$nb" >/dev/null 2>&1 && echo "needs-input: set" || echo "needs-input: skip (write)"
}
SH
```

### 8.4 The triage agent

Dispatch ONE lightweight `general-purpose` agent (**no worktree** — it touches only the
board via `gh`, never code), passing only the candidate **item-ids + assigned
TASK-IDs**. It fetches each body itself, so bodies never enter the orchestrator's
context. It judges walk-ness and specified-vs-underspecified, writes/strips the
needs-input block, and returns a compact per-card verdict. Prompt + handoff schema:
`references/templates.md` › **Triage dispatch prompt**. The orchestrator then applies
the verdict shell-side: append `(walk)` where flagged; move underspecified → **Needs
Input** and journal `triaged <id> needs-input`; leave specified in **To Do** and
journal `triaged <id> clean`.
