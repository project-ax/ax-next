# dag-ship — GitHub Project board mirror (best-effort)

A second progress mirror on top of `.claude/dag-ship-status.md`. **Never
load-bearing:** every command is best-effort — on any non-zero exit, log once,
set `BOARD_OFF`, and stop touching the board for the rest of the run. Skip all of
this in `--dry-run` (no external mutation in a dry run).

## 0. Preconditions & graceful-off

```bash
# Needs the 'project' token scope. If absent, mirror is OFF.
if ! gh auth status 2>&1 | grep -q "project"; then
  echo "dag-ship: gh lacks 'project' scope — board mirror OFF (file dashboard only). Enable: gh auth refresh -s project"
  # BOARD_OFF=1 — skip every step below for the rest of the run
fi
OWNER=$(gh repo view --json owner -q .owner.login)
```

## 1. Find-or-create the "TO DO" board + link it to the repo (once per run)

```bash
PROJ_JSON=$(gh project list --owner "$OWNER" --format json)
PNUM=$(echo "$PROJ_JSON" | jq -r '.projects[] | select(.title=="TO DO") | .number' | head -1)
FRESH=0
if [ -z "$PNUM" ] || [ "$PNUM" = "null" ]; then
  PNUM=$(gh project create --owner "$OWNER" --title "TO DO" --format json | jq -r .number)
  FRESH=1   # newly created → safe to (re)define columns in §2a
fi
PROJ_ID=$(gh project view "$PNUM" --owner "$OWNER" --format json | jq -r .id)
# Link to the repo so the board shows under the repo's Projects tab (v2 boards are
# owned by the org/user, never the repo — linking is the only way to surface it there).
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh project link "$PNUM" --owner "$OWNER" --repo "$REPO" 2>/dev/null || true   # idempotent
```

## 2. Resolve the Status field + option ids, with fallback

```bash
FIELDS=$(gh project field-list "$PNUM" --owner "$OWNER" --format json)
STATUS_FIELD_ID=$(echo "$FIELDS" | jq -r '.fields[] | select(.name=="Status") | .id')
echo "$FIELDS" | jq -r '.fields[] | select(.name=="Status") | .options[] | "\(.name)\t\(.id)"'
```

Build a `column-name → option-id` map from that output, then map dag-ship state →
column, preferring the rich column and falling back to the default board:

| dag-ship state | preferred column | fallback (default board) |
|---|---|---|
| trigger-gated | Trigger-gated | Todo |
| blocked (unmet deps) | Blocked | Todo |
| ready | Ready | Todo |
| dispatched / pre-PR | In Progress | In Progress |
| PR open (in-flight) | In Review | In Progress |
| merged / done | Done | Done |
| quarantined | Parked | Todo |

Use the preferred option id if its name is in the map; else the fallback's; else
skip the move (log once).

### 2a. Define the 7-column Status set — fresh board only (verified working)

A freshly-created board ships only `Todo / In Progress / Done`. On a board you just
created (`FRESH=1`), set the full column set with the mutation below — this is
proven to work. **`singleSelectOptions` REPLACES the entire option set**, so run it
ONLY on a fresh board (no items yet); on an existing board with cards, skip this
and use the fallback mapping in §2 instead (clobbering options would unset every
card's status).

```bash
if [ "$FRESH" = "1" ]; then
  gh api graphql -f query='mutation($f:ID!){updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:[
   {name:"Trigger-gated",color:GRAY,description:""},
   {name:"Blocked",color:RED,description:""},
   {name:"Ready",color:YELLOW,description:""},
   {name:"In Progress",color:BLUE,description:""},
   {name:"In Review",color:PURPLE,description:""},
   {name:"Done",color:GREEN,description:""},
   {name:"Parked",color:ORANGE,description:""}
  ]}){projectV2Field{... on ProjectV2SingleSelectField{id}}}}' -f f="$STATUS_FIELD_ID" >/dev/null
  # re-read option ids after redefining:
  FIELDS=$(gh project field-list "$PNUM" --owner "$OWNER" --format json)
fi
```

(`color` is the GitHub option-color enum: `GRAY BLUE GREEN YELLOW ORANGE RED PINK
PURPLE`. For org-owned projects, GraphQL queries that walk from the owner use
`organization(login:)` not `user(login:)`; walking from the project node id —
`node(id:$PROJ_ID){... on ProjectV2{...}}` — avoids that branch entirely.)

## 3. Find-or-create a draft card per task

```bash
ITEMS=$(gh project item-list "$PNUM" --owner "$OWNER" --format json)
ITEM_ID=$(echo "$ITEMS" | jq -r --arg p "[$TASK_ID] " '.items[] | select(.content.title // "" | startswith($p)) | .id' | head -1)
if [ -z "$ITEM_ID" ] || [ "$ITEM_ID" = "null" ]; then
  ITEM_ID=$(gh project item-create "$PNUM" --owner "$OWNER" --title "[$TASK_ID] $TASK_TITLE" --format json | jq -r .id)
fi
```

## 4. Move a card / link a PR

```bash
gh project item-edit --id "$ITEM_ID" --project-id "$PROJ_ID" \
  --field-id "$STATUS_FIELD_ID" --single-select-option-id "$OPT_ID"
# on PR open, append the PR link to the draft body:
gh project item-edit --id "$ITEM_ID" --body "[$TASK_ID] $TASK_TITLE — PR: $PR_URL"
```

## When to mirror (each best-effort, AFTER the file-dashboard update)

- initial scan → trigger-gated → **Trigger-gated**, unmet-deps → **Blocked**
- dependency cleared → **Ready**
- wave dispatch → **In Progress**
- handoff `pr-green` / PR opened → **In Review** (+ append PR link)
- merged → **Done**
- quarantined (failure handling) → **Parked**

Batch per-wave updates; never let a board call block dispatch or merge.
