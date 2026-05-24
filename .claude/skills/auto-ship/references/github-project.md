# auto-ship — the "TO DO" board (source of truth)

The GitHub **"TO DO"** Projects v2 board (org `project-ax`, project **#1**) **is** the
state for auto-ship — not a mirror. Cards, lanes, and the `Depends on` field are read on
every loop pass and written by the orchestrator (the **sole** board writer). The board
is owned by the org and **linked** to the repo so it shows under the repo's Projects
tab (v2 boards are never repo-owned; linking is the only way to surface them there).

The state↔lane map:

| auto-ship state | lane (`Status`) |
|---|---|
| gated / not-yet-actionable / `(walk)` | **Backlog** |
| actionable, awaiting dispatch | **To Do** |
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

# on PR open, append the PR link to the card body:
gh project item-edit --id "$ITEM_ID" --body "$TASK_BODY — PR: $PR_URL"
```

Transitions (orchestrator, AFTER the journal write): dependency cleared / card lands
in To Do → leave in **To Do**; dispatch → **In Progress**; `pr-green` / PR open →
**In Review** (+ append PR link); merged → **Done**; quarantined → **Parked** (+ `🛑`
title prefix). Walk cards stay in **Backlog** unless a human moves them to To Do.

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
