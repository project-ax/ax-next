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
STATUS_FIELD_ID=$(echo "$FIELDS" | jq -r '.fields[] | select(.name=="Status") | .id')
DEPS_FIELD_ID=$(echo "$FIELDS"   | jq -r '.fields[] | select(.name=="Depends on") | .id')
# build a lane-name → option-id map:
echo "$FIELDS" | jq -r '.fields[] | select(.name=="Status") | .options[] | "\(.name)\t\(.id)"'
```

Expected six lanes — **Backlog, To Do, In Progress, In Review, Done, Parked**. If the
`Depends on` field is missing, create it (text):

```bash
[ -z "$DEPS_FIELD_ID" ] && gh project field-create "$PNUM" --owner "$OWNER" \
  --name "Depends on" --data-type TEXT
```

### 2a. (Re)define the 6-lane set — empty board only

`singleSelectOptions` **REPLACES the entire option set**, which would unset every
card's status. Run this **only** on a board with no cards (initial setup); otherwise
the six lanes already exist and you just map names → ids in §2.

```bash
gh api graphql -f query='mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[
  {name:"Backlog",color:GRAY,description:"Gated / not-yet-actionable; orchestrator never pulls"},
  {name:"To Do",color:YELLOW,description:"Actionable inbox; orchestrator drains dep-free cards"},
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

## 3. Read the board (each loop pass)

```bash
ITEMS=$(gh project item-list "$PNUM" --owner "$OWNER" --format json)
# To Do cards + their deps  (the gh JSON key for "Depends on" is lowercased: "depends on")
echo "$ITEMS" | jq -r '.items[] | select(.status=="To Do")
  | "\(.title)\tdeps=\(."depends on" // "")"'
```

`.status` is the lane name (e.g. `"To Do"`). `."depends on"` is the dependency field
(empty = un-analyzed; `none` = analyzed-no-deps; else space/comma-separated Task IDs).

## 4. Write the board (orchestrator only)

```bash
# find-or-create a card by [TASK-ID] prefix:
ITEM_ID=$(echo "$ITEMS" | jq -r --arg p "[$TASK_ID] " \
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

The card **body** is written through a different door — the delimited progress block
(§6), never `--body` whole-replace. The orchestrator does **not** append a PR link to
the body any more: the building agent logs `PR #<n> opened` into its own progress
block, so there is only ever one body writer at a time (§6).

Transitions (orchestrator, AFTER the journal write): dependency cleared / card lands
in To Do → leave in **To Do**; dispatch → **In Progress**; `pr-green` / PR open →
**In Review** (the agent already logged `PR #<n> opened` in the block); merged →
**Done** (`append_progress … "merged #<n> ✅"`); quarantined → **Parked** (+ `🛑`
title prefix + `append_progress … "🛑 parked — <signature>"`). Walk cards stay in
**Backlog** unless a human moves them to To Do.

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
reaping a live agent**.

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
echo "$ITEMS" | jq -r '.items[] | select(.status=="In Progress" or .status=="In Review")
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
