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

## 1. Find-or-create the "TO DO" board (once per run)

```bash
PROJ_JSON=$(gh project list --owner "$OWNER" --format json)
PNUM=$(echo "$PROJ_JSON" | jq -r '.projects[] | select(.title=="TO DO") | .number' | head -1)
if [ -z "$PNUM" ] || [ "$PNUM" = "null" ]; then
  PNUM=$(gh project create --owner "$OWNER" --title "TO DO" --format json | jq -r .number)
fi
PROJ_ID=$(gh project view "$PNUM" --owner "$OWNER" --format json | jq -r .id)
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

### Optional one-time 7-column setup (advisory)

The default board ships only `Todo / In Progress / Done`. For the richer view, add
`Trigger-gated, Blocked, Ready, In Review, Parked` once via the UI (Project →
Settings → Status → add options), or via GraphQL `updateProjectV2Field`
(`singleSelectOptions` REPLACES the full set — include the existing options too).
dag-ship works without this via the fallback mapping. For org-owned projects use
`organization(login:)` not `user(login:)` in any GraphQL query.

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
