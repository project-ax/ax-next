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
# BOARD_LIMIT must stay comfortably ABOVE the board's item count. The board passed 300
# items in Aug 2026; the helper shipped `--limit 200` and silently handed back a
# HALF BOARD. Keep headroom and re-raise this when the board grows.
BOARD_LIMIT=700
# board_snapshot — fetch the WHOLE board once, cache to disk, echo the path.
# The guard asserts NON-TRUNCATION, not non-emptiness. A `length>0` check passes
# happily on a truncated array, and the orchestrator then derives its ready set, dep
# review and reconciliation from a partial board — cards it cannot see look absent.
# A snapshot that exactly HITS the limit is indistinguishable from a truncated one,
# so `>= LIMIT` is fatal, not a warning. (`a9343fd9` fixed this same blindness in the
# poller; it regressed straight back into this helper.)
board_snapshot() {
  local j n
  # No 2>/dev/null: a rate-limit or auth error must reach the operator, not vanish.
  j=$(gh project item-list 1 --owner project-ax --format json --limit "$BOARD_LIMIT") || return 1
  n=$(printf '%s' "$j" | jq -r '.items | if type=="array" then length else -1 end') || return 1
  # An empty/non-integer $n makes BOTH tests below error out (return 2) rather than
  # fire, and the function would then fall through to cache garbage and return 0 —
  # a silent-success path. Close it before the arithmetic.
  case "$n" in ''|*[!0-9-]*) echo "FATAL: board_snapshot got a non-numeric item count ('$n')" >&2; return 1;; esac
  [ "$n" -le 0 ] && { echo "FATAL: board_snapshot read no items (rate-limited or bad JSON)" >&2; return 1; }
  [ "$n" -ge "$BOARD_LIMIT" ] && { echo "FATAL: board_snapshot hit --limit ($n of $BOARD_LIMIT) — board truncated; raise BOARD_LIMIT" >&2; return 1; }
  printf '%s' "$j" > "$BOARD_CACHE"; echo "$BOARD_CACHE"
}
# board_batch <projectId> <op>...  — ONE aliased mutation for many writes.
#   op: "<itemId>|<fieldId>|single|<optionId>"  or  "<itemId>|<fieldId>|text|<value>"
#
# BRACE EVERY $i THAT PRECEDES A ':'. The Bash tool runs **zsh** on this machine, and
# zsh applies history-style modifiers to a bare `$var:x`. The load-bearing sites are
# the two alias prefixes `a${i}:update…` — unbraced, zsh reads `:u` as the *upcase*
# modifier and EATS THE `u`, yielding `a1pdateProjectV2ItemFieldValue`, which GitHub
# rejects as `undefinedField`. `\$it${i}:ID!` and `\$v${i}:String!` are NOT affected
# (`:I` and `:S` are not modifiers) but are braced anyway so the rule is "always brace"
# with no per-letter judgement call to get wrong. Verified byte-identical under bash.
# `bash -c` is NOT needed — bracing alone is sufficient (§2c proves it every run start).
board_batch() {
  local proj="$1"; shift
  [ "$#" -eq 0 ] && { echo "board_batch: no ops"; return 2; }
  local decl="mutation(\$p:ID!" sel="" i=0; local -a args=(-f "p=$proj")
  local op item field kind val
  for op in "$@"; do
    i=$((i+1)); item=${op%%|*}; op=${op#*|}; field=${op%%|*}; op=${op#*|}; kind=${op%%|*}; val=${op#*|}
    decl+=",\$it${i}:ID!,\$fd${i}:ID!,\$v${i}:String!"
    args+=(-f "it${i}=$item" -f "fd${i}=$field" -f "v${i}=$val")
    if [ "$kind" = "single" ]; then
      sel+=" a${i}:updateProjectV2ItemFieldValue(input:{projectId:\$p,itemId:\$it${i},fieldId:\$fd${i},value:{singleSelectOptionId:\$v${i}}}){projectV2Item{id}}"
    else
      sel+=" a${i}:updateProjectV2ItemFieldValue(input:{projectId:\$p,itemId:\$it${i},fieldId:\$fd${i},value:{text:\$v${i}}}){projectV2Item{id}}"
    fi
  done
  # NEVER swallow this stderr. The zsh bug above survived run after run because
  # `2>&1`-to-nowhere reduced `undefinedField 'a1pdateProjectV2ItemFieldValue'` —
  # which names the bug on sight — to the single word FAILED.
  local err
  if err=$(gh api graphql -f query="${decl}){${sel} }" "${args[@]}" 2>&1 >/dev/null); then
    echo "board_batch: $i write(s) in 1 request"
  else
    echo "board_batch: FAILED — $err" >&2
    return 1
  fi
}
# board_batch_query_preview <n> — the exact query string board_batch WOULD send for n
# ops, with no network call. Exists solely so the run-start shell-parity self-test
# (§2c) can diff it between bash and zsh; the two must be byte-identical.
#
# ⚠ THIS IS A HAND-MAINTAINED TWIN of board_batch's decl/sel construction above. If you
# edit those two `+=` lines, edit these too or the parity test silently stops testing
# the real function. The static scan in
# scripts/__tests__/autoship-skill-shell-hazards.test.js covers BOTH copies for the
# brace hazard, which is the failure that actually matters — but it cannot tell you
# the twins have drifted in some other way.
board_batch_query_preview() {
  local n="$1" decl="mutation(\$p:ID!" sel="" i=0
  while [ "$i" -lt "$n" ]; do
    i=$((i+1))
    decl+=",\$it${i}:ID!,\$fd${i}:ID!,\$v${i}:String!"
    sel+=" a${i}:updateProjectV2ItemFieldValue(input:{projectId:\$p,itemId:\$it${i},fieldId:\$fd${i},value:{singleSelectOptionId:\$v${i}}}){projectV2Item{id}}"
  done
  printf '%s){%s }\n' "$decl" "$sel"
}
SH
chmod +x .claude/auto-ship-board.sh
```

### 2c. Run-start self-tests — THREE fatal checks before the first dispatch

Every defect this section documents was regenerated from these very code blocks at
some later run start and then failed *quietly*. Run all three immediately after
writing the helpers, in one Bash call, and **do not dispatch anything until they
pass**. None of them costs a GraphQL point (`gh api rate_limit` is exempt from the quota it reports).

```bash
FATAL=0

# (1) SHELL PARITY — the Bash tool runs zsh; the helpers are written in bash syntax.
# An unbraced `$i:` silently mutates the GraphQL alias under zsh (§2b). Diff the
# query the helper WOULD send, under both shells; they must be byte-identical.
if command -v zsh >/dev/null 2>&1; then
  pb=$(bash -c '. .claude/auto-ship-board.sh && board_batch_query_preview 3')
  pz=$(zsh  -c '. .claude/auto-ship-board.sh && board_batch_query_preview 3')
  if [ "$pb" != "$pz" ]; then
    echo "FATAL: board_batch is NOT shell-parity safe — bash and zsh disagree:"; echo "  bash: $pb"; echo "  zsh : $pz"; FATAL=1
  fi
  case "$pz" in *" a1:updateProjectV2ItemFieldValue"*) ;;
    *) echo "FATAL: zsh mangled the alias (expected ' a1:updateProjectV2ItemFieldValue'): $pz"; FATAL=1;; esac
fi

# (2) HELPER COMPLETENESS — a stale on-disk .claude/auto-ship-progress.sh can predate
# a function. This has already caused one real regression (§8.3): the triage agent's
# set_needs_input call silently no-op'd and it hand-rolled a mangled Q&A block. The
# guard existed; nothing ran it. It is now fatal, and it runs here.
. .claude/auto-ship-progress.sh
for f in append_progress set_needs_input append_learnings; do
  type "$f" >/dev/null 2>&1 || { echo "FATAL: STALE HELPER — $f missing from .claude/auto-ship-progress.sh; re-write the cat blocks (§6/§8.3 — the first \`cat >\` truncates, so a full rewrite is safe)"; FATAL=1; }
done

# (3) GRAPHQL BUDGET PRE-FLIGHT — the budget is 5000 pts/hr, shared with the poller,
# every heartbeat and the merge queue. A dispatch round you cannot afford strands its
# builders mid-flight (this happened: 95/5000 remaining right after three dispatches).
REM=$(gh api rate_limit --jq '.resources.graphql.remaining')
[ "${REM:-0}" -lt 500 ] && { echo "FATAL: GraphQL budget $REM/5000 — too low to start a run; wait for the hourly reset"; FATAL=1; }

[ "$FATAL" -eq 0 ] && echo "run-start self-tests: OK" || echo "run-start self-tests: FAILED — do not dispatch"
```

**Budget arithmetic, so the pre-flight is not a mystery number.** `gh project
item-list` is ~102 points. Under the mandatory 3-way parallelism a round in which each
builder queries the board for its own card body costs ~306 points *before any work
happens* — which is why the dispatch template hands each builder its card body inline
or as a local file path and **never** as a board query (`references/templates.md` ›
Code-lane dispatch prompt). The orchestrator has already read every body in `$ITEMS`;
re-fetching it per builder buys nothing.

A tracked regression guard for (1) and the `--limit` in §2b/§3 lives at
`scripts/__tests__/autoship-skill-shell-hazards.test.js` — CI runs it on every PR, so
these two defects cannot silently return to the doc the way they did before.

## 3. Read the board (each loop pass) — ONE read, reuse it

`gh project item-list` is a **heavy GraphQL query** (it returns every item with its
field values *and* `.content.body`). The GraphQL budget is **5000 points/hour**, so
calling it 3–5× per pass — once for the ready set, again per item id, again per body,
again for the snapshot hash — **exhausts the budget** (this happened; the whole loop
stalled for ~6 min). **Read the whole board exactly once per pass** and derive
everything from that single JSON:

```bash
BOARD_LIMIT=700   # keep in lockstep with board_snapshot's BOARD_LIMIT (§2b) — one number, two call sites
ITEMS=$(gh project item-list "$PNUM" --owner "$OWNER" --format json --limit "$BOARD_LIMIT")   # the ONLY board read this pass
# Both failure modes are silent and both poison the ready set, so assert BOTH — a
# truncated read and an empty one are different bugs with the same symptom (a card
# that is simply never dispatched). This mirrors board_snapshot; prefer calling it.
n=$(printf '%s' "$ITEMS" | jq '.items|length')
[ "${n:-0}" -le 0 ]             && echo "FATAL: board read came back empty (rate-limited?)"
[ "${n:-0}" -ge "$BOARD_LIMIT" ] && echo "FATAL: board truncated at --limit $BOARD_LIMIT — raise it"
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
# `$TASK_ID` here is one you ALREADY hold, so this path allocates nothing -- but another
# session may have taken the number between your snapshot and this write, so confirm
# before anything starts referencing the card (§8.2a).
#
# TAKE THE ANSWER BACK. If this card turns out not to be the keeper, `settle` renames
# YOUR card and the surviving id is no longer the `$TASK_ID` you came in with -- and
# every later use of it (dispatch prompt, journal row, `Depends on`) would then name a
# number this card does not carry. settle prints the surviving id on stdout for exactly
# this reason, and its prose goes to stderr so the capture stays clean.
#
# AND THE ROUTING IS INSIDE THE `then`, for the same reason it is in the follow-up block
# below. settle exits non-zero precisely when the id is STILL a duplicate, so routing a
# card anyway would wire a duplicate-numbered card into `Depends on` and into readiness
# -- the corruption this whole section exists to prevent, performed immediately after
# printing a line telling you not to. An earlier version of this block did exactly that.
# Capture into SETTLED, not straight into TASK_ID: on failure the substitution empties
# whatever it assigns to, and the FATAL needs the original id to name the card.
if SETTLED=$(scripts/board-task-id.sh settle --item "$ITEM_ID"); then
  TASK_ID="$SETTLED"

  # move a card to a lane (OPT_ID from the §2 map):
  gh project item-edit --id "$ITEM_ID" --project-id "$PROJ_ID" \
    --field-id "$STATUS_FIELD_ID" --single-select-option-id "$OPT_ID"

  # set / rewrite its deps:
  gh project item-edit --id "$ITEM_ID" --project-id "$PROJ_ID" \
    --field-id "$DEPS_FIELD_ID" --text "$DEPS"    # e.g. "ARCH-4 ARCH-5"  or  "none"
else
  echo "FATAL: [$TASK_ID] on $ITEM_ID is NOT confirmed unique — NOT routed (no lane move, no deps, do not dispatch)" >&2
fi
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
# `claim` allocates the [TASK-n], creates the card and confirms the number survived, all
# in ONE process -- see §8.2a. `$T` is the BARE title; claim adds the prefix. It prints
# "<TASK-ID> <PVTI_id>" on success.
# Captured, NOT `read … <<<"$(…)"`: a herestring makes `$?` READ's status, so a refusal
# would arrive as two empty variables. And the routing lives INSIDE the `if`, not after a
# bare `|| echo` -- that form captures the status correctly and then falls through
# anyway, so `board_batch` still runs with an empty `$ID`. Reporting a failure and then
# proceeding as though it had not happened is the same bug wearing a FATAL line.
if CLAIM=$(scripts/board-task-id.sh claim --title "$T" --body "$B"); then
  TASK_ID=${CLAIM%% *}; ID=${CLAIM##* }
  board_batch "$PROJ_ID" "$ID|$STATUS_FIELD_ID|single|$TODO" "$ID|$DEPS_FIELD_ID|text|none"
else
  echo "FATAL: no Task ID allocated — follow-up card NOT created, nothing routed" >&2
fi
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

**Forward learning (on merge).** After moving a card → Done, propagate its handoff
`learnings:` to every still-queued **To Do** card sharing its `epic:<slug>`. Find those
item-ids **shell-side** from `$ITEMS` (never surface a body to the model), then
`append_learnings` each bullet:

```bash
# same-epic queued cards — To Do cards whose body carries `epic: <slug>`; item-ids ONLY:
EPIC=<slug>
IDS=$(printf '%s' "$ITEMS" | jq -r --arg e "epic: $EPIC" \
  '.items[] | select(.status=="To Do") | select((.content.body // "") | contains($e)) | .id')
source .claude/auto-ship-progress.sh
# `for id in $IDS` here is BROKEN and looks fine. The Bash tool runs zsh, and zsh does
# NOT word-split an unquoted parameter expansion, so that form iterates ONCE with every
# id concatenated -- append_learnings then gets a garbage node id. It used to answer
# that with `learnings: skip (read)`, its *transient* path, so a broken loop read as a
# rate-limit blip; it now answers `learnings: MALFORMED-ID …` and returns nonzero
# (§6, **Malformed vs transient**). Do not rely on that as the loop's only guard --
# `read -r` behaves identically under both shells, so just write the correct form.
# (`for b in $(cmd)` is fine: command substitution DOES split under zsh.)
printf '%s\n' "$IDS" | while IFS= read -r id; do
  [ -n "$id" ] || continue   # an empty $IDS still yields one empty line
  append_learnings "$id" "from $TASK_ID: <bullet>"   # one call per learnings bullet
done
```

**Count the output.** `append_learnings` prints one line per call — so one line per
`(bullet, id)` pair, and the loop above runs **once per bullet**. As written, with one
`<bullet>` placeholder, expect exactly as many lines as there are ids. If you see
fewer, the loop is broken, not rate-limited. A concatenated or otherwise malformed id
now says so out loud (`learnings: MALFORMED-ID …`, §6) instead of borrowing the quiet
`skip (read)` line — but keep counting anyway: a *genuine* rate limit still prints
`learnings: skip (…)`, and that still means a bullet did not land.

Best-effort; a failed learnings write never blocks the merge. (The just-merged card is now
**Done**, so it is naturally excluded from the To Do filter — no self-write.)

**Design-intake card creation.** In design-intake mode the **decomposition agent** runs
`scripts/board-task-id.sh claim` for each slice (**not** a bare `item-create` — it must
allocate through the same door as everyone else, §8.2a) with the `epic:<slug>` +
`design:` markers in the body
(`references/templates.md` › Decomposition dispatch prompt); the orchestrator then
`board_batch`es each new card's `Status → To Do` + `Depends on` from the returned
manifest — the agent never sets routing.

## 5. The poller (model-token-free To Do watcher — but NOT GraphQL-free)

Write this at run start and launch it with the Bash tool, `run_in_background: true`.
It burns **no model tokens** while idle and `exit 0`s — re-invoking auto-ship — the
moment the To Do lane changes (a card added/removed/renamed, a dep edited, a
Backlog→To Do promote). Re-launch it after every loop pass.

> **⚠ KILL THE PREDECESSOR BEFORE EVERY RELAUNCH, AND ONCE AT RUN END.**
>
> A manual or agent-completion wake can leave the previous watcher running when a
> new pass starts. A board-change wake is different: the watcher exits by itself.
> Reap any predecessor before launching a replacement, and clean up at run end.
>
> The 2026-08-24 log reported two post-run process matches. It did not retain
> parentage evidence, so that report cannot now prove two independent launch roots
> or that every pass leaked one. TASK-456 reproduced the miscount with a bounded
> local probe: one launched Bash process plus two nested command-substitution
> shells gave three argv matches. That probe made no network call and exited
> naturally. Genuine leftover roots can still spend API budget; raw match count
> is not evidence of their number.
>
> ```bash
> pkill -f auto-ship-board-poll.sh 2>/dev/null || true   # before EVERY relaunch
> # … launch the poller (run_in_background: true) …
> ```
>
> Run the same `pkill` once when the run ends, including a failure breaker, spend
> limit or human stop. Verify launch roots with the read-only command below, not
> the number of raw `pgrep` matches.

### Verify poller launch roots

```bash
# ax-poller: verify
node scripts/auto-ship-poller-roots.mjs
```

The command prints one PID per matching launch root. A valid empty result means
zero; one root is expected while draining and zero after cleanup. Two roots are
not one poller with subshells. Inspect the existing run handles before deciding
what to stop; the verifier never kills or restarts anything.

It reads one process snapshot and follows parent chains, so attached pollers do
not need parent PID 1. A 2026-09-22 live observation found a tool-owned poller with
a non-init parent. Matching inherited-argv descendants count under their root;
`bash -c` wrappers, non-shell filename mentions and similarly named scripts do
not count as standalone pollers. This is a point-in-time check of the documented
standalone Bash launch, not a race-free supervisor or an inference about every
historical run.

Node (already required by this repo) and the macOS/Linux `ps` fields are required.
A failed, empty, malformed or cyclic snapshot, or an ambiguous flagged poller
invocation, exits 2 with an unknown-count diagnostic. Never treat that error as
zero. Plain script paths and this checkout's canonical absolute path with spaces are
supported; other ambiguous space/argument forms, including unrecognized path aliases,
fail closed. Do not source the poller into another shell or launch it from another
poller.

> **GraphQL budget — read this.** "Token-free" means **model** tokens. Each poll still
> spends **GraphQL** points against the 5000/hr budget (§3). Do **not** poll with
> `gh project item-list` — it fetches every item's every field value + body and cost
> **~102 pts per call** here, so a 60s cadence is ~6120 pts/hr and an idle poller alone
> drains the entire budget in ~49 min (this happened 2026-05-25: two consecutive hourly
> windows exhausted). Poll with the **targeted `fieldValueByName` query below (~1 pt)**
> instead, and pre-check the budget so the poller can never be what drains it.

```bash
cat > .claude/auto-ship-board-poll.sh <<'SH'
#!/usr/bin/env bash
# Exits 0 when the To Do lane changes vs the cached snapshot (re-invokes auto-ship).
# GraphQL-frugal: the targeted fieldValueByName query costs ~1 pt per 100-item page
# (vs ~102 for `gh project item-list`, which fetches every field value + body). The
# board exceeds 100 items, so we PAGINATE every page: a single first:100 silently
# truncates the newest cards — including a brand-new To Do follow-up — and the poller
# goes BLIND (it never detects the change, stalling the loop). It also refuses to poll
# when the budget is low, so a poller can never be what drains GraphQL.
SNAP=.claude/auto-ship-todo-snapshot.txt
Q='query($after:String){ organization(login:"project-ax"){ projectV2(number:1){ items(first:100, after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{
    id
    content{ ... on DraftIssue{title} ... on Issue{title} ... on PullRequest{title} }
    status: fieldValueByName(name:"Status")    { ... on ProjectV2ItemFieldSingleSelectValue{name} }
    deps:   fieldValueByName(name:"Depends on") { ... on ProjectV2ItemFieldTextValue{text} } }}}}}'
# todo_json — paginate ALL items, emit the To Do lane as canonical JSON sorted by id.
# sort_by(.id) is load-bearing: items() returns nodes in non-deterministic order, and
# jq -S sorts object KEYS but not ARRAY order, so without it the hash flips on identical
# content and the poller spurious-fires. Non-zero on a failed/rate-limited read.
todo_json() {
  local after="null" all="[]" page nodes hasnext cursor
  while :; do
    if [ "$after" = "null" ]; then page=$(gh api graphql -f query="$Q" -F after=null 2>/dev/null) || return 1
    else page=$(gh api graphql -f query="$Q" -f after="$after" 2>/dev/null) || return 1; fi
    printf '%s' "$page" | jq -e '.data.organization.projectV2.items' >/dev/null 2>&1 || return 1
    nodes=$(printf '%s' "$page" | jq -c '.data.organization.projectV2.items.nodes')
    all=$(jq -cn --argjson a "$all" --argjson b "$nodes" '$a + $b')
    hasnext=$(printf '%s' "$page" | jq -r '.data.organization.projectV2.items.pageInfo.hasNextPage')
    cursor=$(printf '%s' "$page" | jq -r '.data.organization.projectV2.items.pageInfo.endCursor')
    [ "$hasnext" = "true" ] || break
    after="$cursor"
  done
  printf '%s' "$all" | jq -S '[.[] | select(.status.name=="To Do")
    | {id, title:.content.title, deps:(.deps.text // "")}] | sort_by(.id)'
}
while true; do
  REM=$(gh api rate_limit --jq '.resources.graphql.remaining' 2>/dev/null || echo 5000)
  if [ "${REM:-5000}" -lt 500 ]; then sleep 120; continue; fi   # free pre-check; never be the drainer
  CUR=$(todo_json) || { sleep 60; continue; }                   # failed read: don't act on garbage
  H=$(printf '%s' "$CUR" | { shasum 2>/dev/null || sha1sum; } | cut -d" " -f1)
  if [ "$H" != "$(cat "$SNAP" 2>/dev/null)" ]; then
    printf '%s' "$H" > "$SNAP"; echo "TO-DO CHANGED"; exit 0
  fi
  sleep 60
done
SH
chmod +x .claude/auto-ship-board-poll.sh
```

Pagination is load-bearing: the board exceeds 100 items (Done cards accumulate and
never leave — 117+ as of 2026-05-31), so a lone `first:100` would drop the newest cards
(a just-created To Do follow-up lands *last*), and the poller would never see them — a
**blind poller that stalls the loop**, not just a spurious fire. `todo_json` loops
`after`/`endCursor` over every page (~1 pt each, a handful of pages) so no To Do card is
ever invisible. `fieldValueByName` pulls only the two fields the hash needs (Status,
Depends on) instead of the whole `fieldValues` connection — that's the ~102→~1-pt-per-page
collapse. The orchestrator's per-pass read (§3) still legitimately needs bodies, but it
runs **once per pass**, not every 60s — the poller is the one that must stay cheap.

**Snapshot-refresh discipline (avoids self-triggering):** the orchestrator's own pass
mutates To Do (moves a card out, writes deps), which would re-trip the poller. So at
the **end** of each pass — after all board writes, before re-launching the poller —
recompute the hash and overwrite `.claude/auto-ship-todo-snapshot.txt` with it, so the
poller's next compare sees no change and sleeps. The first launch has an empty
snapshot, so it fires immediately → that's the run-start review. **The manual refresh
MUST mirror the poller's method exactly** — reuse the paginated, `sort_by(.id)`-sorted
`todo_json` and `printf '%s' "$CUR" | shasum` (capture into a var first). An ad-hoc
`first:100` snippet re-introduces the blind-truncation bug, and `jq … | shasum` (piping
jq straight to shasum) adds a trailing newline the poller's `printf '%s'` omits — a hash
mismatch that fires the poller *every* cycle.

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
for its terminal writes, and **dispatched agents call the `auto-ship-hb.sh` wrapper
below by absolute path** (never `source` a relative one — see the worktree hazard).

**The worktree hazard — why builders need the wrapper, not the raw helper.** The
helper is gitignored (`.gitignore:47`), so `git worktree add` does **not** carry it
into a dispatched builder's worktree: `ls .claude/` there comes back empty. A builder
that copies the orchestrator-side `source .claude/auto-ship-progress.sh` line — the
relative form, which is what every runnable example in this file used to show —
gets **exit 127** and no heartbeat. Two builders in one run independently worked
around it by copying the helper *into* their worktree with a `$(dirname "$0")` shim
and a hardcoded item id. Two people inventing the same workaround is a documentation
failure, not a coincidence, so the wrapper is now the documented path for agents:

```bash
cat > .claude/auto-ship-progress.sh <<'SH'
#!/usr/bin/env bash
# append_progress <project-item-node-id> "<line>"
# Best-effort, shell-side RMW of the delimited block in a draft-issue card body.
# The body NEVER enters the model's context — only "progress:"/"skip" is echoed.
# A failed write is non-fatal: progress is observability, never a ship blocker.
append_progress() {
  local item="$1" line="$2" now
  # A malformed id is a CALLER BUG, not a blip. Project item node ids are
  # `PVTI_`-prefixed and hold no whitespace, so the shape is checkable for zero
  # API calls -- and checking it here is what keeps the quiet `skip (...)` paths
  # below meaning ONLY "transient". See the **Malformed vs transient** note in §6.
  local ok=
  case "$item" in
    '' | *[[:space:]]*) ;;
    PVTI_*) ok=1 ;;
  esac
  [ -n "$ok" ] || { echo "progress: MALFORMED-ID ${item:-<empty>}"; return 2; }
  now=$(date +%H:%M)
  local START='<!-- AUTOSHIP-PROGRESS:START -->'
  local END='<!-- AUTOSHIP-PROGRESS:END -->'
  # A line may be MULTI-LINE -- real newlines (use $'a\nb') or a literal backslash-n,
  # both accepted, same convention set_needs_input has always documented (§8.3). The
  # old `awk -v` splice expanded the literal form as a side effect of awk's escape
  # handling and DESTROYED the card on the real one, so the substitution keeps callers
  # of the literal form working. Two honest caveats: it is PARTIAL back-compat (awk -v
  # also expanded \t, \\ and octal; those now pass through literally), and like awk it
  # mangles a genuine backslash-n in caller text -- `C:\next` becomes `C:` + newline +
  # `ext`. Every other backslash survives. Measured byte-identical under bash and zsh.
  local nl='
'
  local entry="- $now ${line//\\n/$nl}"
  local q='query($i:ID!){node(id:$i){... on ProjectV2Item{content{... on DraftIssue{id body}}}}}'
  local json cid body
  json=$(gh api graphql -f query="$q" -f i="$item" 2>/dev/null) || { echo "progress: skip (read)"; return 0; }
  cid=$(printf '%s' "$json" | jq -r '.data.node.content.id // empty')
  body=$(printf '%s' "$json" | jq -r '.data.node.content.body // ""')
  [ -z "$cid" ] && { echo "progress: skip (not a draft-issue card)"; return 0; }
  # SPLICE IN SHELL -- NEVER THROUGH `awk -v e="$entry"`. A literal newline in an awk
  # `-v` assignment is implementation-defined: the one-true-awk macOS ships (the
  # platform this runs on) ABORTS with `newline in string`, emits NOTHING and exits 2,
  # while gawk/mawk on the CI runners accept it. The old code never checked that rc, so
  # on a Mac it wrote the empty result back as the ENTIRE body while printing its normal
  # success line. It reduced a live card to 1 byte (TASK-470), and it fired only on the
  # SECOND-or-later multi-line append to a card -- the first takes the `printf` arm
  # below, because there is no block to splice into yet, which is why ten sibling cards
  # audited the same day looked fine. (`-v` also expands escapes, so a literal
  # backslash-n inside an entry was silently rewritten too.) Parameter expansion carries
  # newlines and backslashes verbatim, spawns no process, and cannot fail; measured
  # byte-identical under bash and zsh.
  # An entry carrying a marker of its own would plant a second END inside the block and
  # move every later splice. Refuse it -- loudly, writing nothing. (A progress line ABOUT
  # these markers is not hypothetical: auto-ship ships changes to this very file.)
  case "$entry" in
    *"$START"* | *"$END"*)
      echo "progress: REFUSED (entry contains a block marker; body untouched)"; return 3 ;;
  esac
  local nb
  case "$body" in
    *"$START"*)
      # ANCHOR THE END TO THE START, not to the body. A plain `${body%%"$END"*}` takes
      # the FIRST END anywhere -- so a human note that merely quotes the end marker
      # ABOVE the block would capture the splice and the entry would land in the human
      # prose. (`awk '$0==end'` matched whole lines, so it never did that; this is the
      # one case where the shell splice needed to be taught what awk knew.) Split the
      # body at START first, then take the first END *after* it.
      local pre="${body%%"$START"*}" rest="${body#*"$START"}"
      case "$rest" in
        *"$END"*) nb="${pre}${START}${rest%%"$END"*}${entry}"$'\n'"${END}${rest#*"$END"}" ;;
        *) echo "progress: REFUSED (block START without END; body untouched)"; return 3 ;;
      esac ;;
    *) nb=$(printf '%s\n\n%s\n### Progress\n%s\n%s' "$body" "$START" "$entry" "$END") ;;
  esac
  # NEVER WRITE A BODY WE DID NOT SUCCESSFULLY CONSTRUCT. An append can only GROW the
  # body and must leave both markers standing. Anything else is the data loss this gate
  # exists to stop, so refuse LOUDLY (return 3, its own class -- see the wrapper) and
  # write nothing. The old failure direction was the worst possible pairing: destroy the
  # body, print success. This one cannot destroy anything and cannot claim success.
  case "$nb" in
    *"$START"*"$END"*) ;;
    *) echo "progress: REFUSED (spliced body lost its markers; body untouched)"; return 3 ;;
  esac
  [ "${#nb}" -gt "${#body}" ] || {
    echo "progress: REFUSED (splice did not grow the body; body untouched)"; return 3; }
  # The ECHO is flattened to one line even though the ENTRY is not. Multi-line entries
  # are the whole point of the fix above, but the wrapper classifies transient failures
  # by matching `^<label>: skip (` line-wise against this output -- so a second line of
  # caller text reading `foo: skip (x)` would relabel a landed write as a rate-limit
  # blip. The card body keeps the real newlines; only the confirmation is flattened.
  gh api graphql -f query='mutation($d:ID!,$b:String!){updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){draftIssue{id}}}' \
    -f d="$cid" -f b="$nb" >/dev/null 2>&1 \
    && echo "progress: $(printf '%s' "$entry" | tr '\n' ' ')" || echo "progress: skip (write)"
}
SH
chmod +x .claude/auto-ship-progress.sh
```

**Malformed vs transient — why all three helpers gate the id shape first.** A
message that can only mean *transient* must not also be reachable from a **caller
bug**, or the operator reads a broken caller as background noise. That is not
hypothetical: during the 2026-08-23/24 run the forward-learning loop passed four
concatenated node ids as one argument (the zsh word-split bug TASK-310 fixes), the
read failed, and the helper printed `learnings: skip (read)` — its *rate-limit,
best-effort, ignore me* line. It was caught only because the output was 3 lines
where 12 were expected.

So each helper now checks the argument's **shape** before spending an API call:
empty, containing whitespace, or not `PVTI_`-prefixed → a loud
`<label>: MALFORMED-ID <value>` and a **nonzero** return. Notes on why it is built
this way:

- **The shape check, not the API error, is the signal.** `NOT_FOUND` also fires for
  a deleted card or one the token cannot see, so it means "not my card", not
  "malformed". The prefix/whitespace test is a positive signal and costs nothing.
- **`case`/glob, not `[[ =~ ]]`** — measured identical under bash 3.2 and zsh 5.9,
  and the whitespace arm has to come **first**: `"PVTI_a PVTI_b"` does start with
  `PVTI_`, so a prefix test alone would wave the real bug through.
- **A nonzero return is safe at every call site.** The helper is last in every
  `source … && helper …` chain, and a nonzero loop body does not stop a
  `while IFS= read -r` loop (measured 3/3 iterations under both shells).
- **`return 2` is the contract, and it is what the wrapper keys on.** Every
  best-effort path returns 0; only the malformed-id gate returns 2 (and only the
  never-write-an-unverified-body gate returns 3). `auto-ship-hb.sh` therefore
  classifies the caller class on `rc`, not by grepping for `MALFORMED-ID` — a text
  match would also fire on a *successful* write whose progress line happens to
  contain that string, labelling a landed heartbeat a non-retryable caller bug.
  That is this very bug one layer up, so do not "simplify" it back to a grep.
- **Genuine failures stay best-effort.** A rate limit or blip on a well-shaped id is
  still the quiet `skip (read)` / `skip (write)` with `return 0`, and still never
  blocks a ship. Only a caller bug is loud.
- **A refusal to write is its own class — loud, `return 3`, and non-destructive
  (TASK-470).** Multi-line entries are supported (that is the fix), but if a helper
  ever builds a body it cannot verify — markers gone, or an append that did not grow
  the body — it prints `<label>: REFUSED (… body untouched)` and makes **no** write.
  The direction of failure is the point: the old code destroyed the body and printed
  success. **The claim is bounded, deliberately**: the gate proves a helper cannot
  silently write an *empty or shorter* body — it is a length-and-markers check, not an
  integrity proof. Two things narrow the gap upstream of it: the END marker is anchored
  to the **START** (so a human note that merely quotes the end marker above the block
  cannot capture the splice — `awk '$0==end'` matched whole lines and never could), and
  an entry carrying a marker of its own is refused before anything is built.

  **They narrow it; they do not close it, and here is the case that is left.** If an END
  marker is already sitting *inside* the block — written before this fix, or typed by a
  human — the splice still lands at that marker instead of the real one, and the helper
  still returns 0 and prints its success line. Falsified by construction against the
  **fixed** helper, so this is a measured residual, not a worry:

  ```
  ### Progress
  - 10:00 discussed the - 22:14 landed
  <!-- AUTOSHIP-PROGRESS:END --> marker
  <!-- AUTOSHIP-PROGRESS:END -->
  ```

  The damage is contained — the entry stays inside the block and the human-authored
  text outside the markers is untouched — but the block's own ordering is wrong and
  nothing detects it. **This is inherent**, not an oversight: a substring-delimited
  block whose content can contain the delimiter is ambiguous, and there is no
  splice-side resolution. Taking the *last* END breaks the "END quoted below the block"
  case instead; taking the first-after-START is what leaves this one. If you want it
  gone, the fix is a refusal when the region after the first START holds more than one
  END — which needs its own bash+zsh test and must not fire on a START quoted *above*
  the block, which splices correctly today.

  **Scope the refusal contract to what this is.** A refused write is loud on stderr and
  **silent on the card**: nothing machine-reads `return 3` / `exit 7`, so it reaches a
  human only through the dispatched agent's `progress:` handoff field. That trade is
  acceptable here *only* because this block is best-effort observability. If this
  helper shape is ever reused for durable or user-facing content, refusing without
  leaving a visible record would be the wrong trade — write a marked record instead.
- **`skip (not a draft-issue card)` is a different thing and stays put.** It needs
  `gh` to exit **0** with an empty content id — a *resolvable* node of the wrong
  type, i.e. a card that is a linked real issue/PR. A malformed id cannot reach it
  (measured: an unresolvable id always errors rc=1). Do not fold the two together.

Guard: `scripts/__tests__/autoship-skill-shell-hazards.test.js` runs all three
helpers under bash **and** zsh against a `gh` stub, asserting the malformed path
never reaches the API and the transient path still returns 0.

**Forward-learning sibling — `append_learnings`** (SKILL.md › Forward learning). Same
shell-side RMW discipline, a distinct `AUTOSHIP-LEARNINGS` block. Append it to the helper
file at run start. **Call it ONLY for To Do cards** — an In-Progress card's body belongs
to its building agent (one writer at a time):

```bash
cat >> .claude/auto-ship-progress.sh <<'SH'
# append_learnings <project-item-node-id> "<from-line>"
# Append a predecessor-learning bullet to the delimited LEARNINGS block of a QUEUED
# To Do card. Shell-side RMW (body never enters the model's context); best-effort.
append_learnings() {
  local item="$1" line="$2"
  # A malformed id is a CALLER BUG, not a blip. Project item node ids are
  # `PVTI_`-prefixed and hold no whitespace, so the shape is checkable for zero
  # API calls -- and checking it here is what keeps the quiet `skip (...)` paths
  # below meaning ONLY "transient". See the **Malformed vs transient** note in §6.
  local ok=
  case "$item" in
    '' | *[[:space:]]*) ;;
    PVTI_*) ok=1 ;;
  esac
  [ -n "$ok" ] || { echo "learnings: MALFORMED-ID ${item:-<empty>}"; return 2; }
  local START='<!-- AUTOSHIP-LEARNINGS:START -->'
  local END='<!-- AUTOSHIP-LEARNINGS:END -->'
  # Multi-line accepted, real newlines or a literal backslash-n -- see append_progress.
  local nl='
'
  local entry="- ${line//\\n/$nl}"
  local q='query($i:ID!){node(id:$i){... on ProjectV2Item{content{... on DraftIssue{id body}}}}}'
  local json cid body nb
  json=$(gh api graphql -f query="$q" -f i="$item" 2>/dev/null) || { echo "learnings: skip (read)"; return 0; }
  cid=$(printf '%s' "$json" | jq -r '.data.node.content.id // empty')
  body=$(printf '%s' "$json" | jq -r '.data.node.content.body // ""')
  [ -z "$cid" ] && { echo "learnings: skip (not a draft-issue card)"; return 0; }
  # Shell splice, never `awk -v e="$entry"` -- see the long note in append_progress
  # (§6). This is the helper that actually destroyed a card: a multi-line entry made
  # awk abort, emit nothing, and the empty result was written back as the whole body.
  case "$entry" in
    *"$START"* | *"$END"*)
      echo "learnings: REFUSED (entry contains a block marker; body untouched)"; return 3 ;;
  esac
  case "$body" in
    *"$START"*)
      # END anchored to START -- see append_progress. A human note quoting the end
      # marker above the block must not capture the splice.
      local pre="${body%%"$START"*}" rest="${body#*"$START"}"
      case "$rest" in
        *"$END"*) nb="${pre}${START}${rest%%"$END"*}${entry}"$'\n'"${END}${rest#*"$END"}" ;;
        *) echo "learnings: REFUSED (block START without END; body untouched)"; return 3 ;;
      esac ;;
    *) nb=$(printf '%s\n\n%s\n### Predecessor learnings\n%s\n%s' "$body" "$START" "$entry" "$END") ;;
  esac
  # Never write a body we did not successfully construct: an append only ever grows the
  # body, and both markers must survive. Loud refusal, nothing written, return 3.
  case "$nb" in
    *"$START"*"$END"*) ;;
    *) echo "learnings: REFUSED (spliced body lost its markers; body untouched)"; return 3 ;;
  esac
  [ "${#nb}" -gt "${#body}" ] || {
    echo "learnings: REFUSED (splice did not grow the body; body untouched)"; return 3; }
  gh api graphql -f query='mutation($d:ID!,$b:String!){updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){draftIssue{id}}}' \
    -f d="$cid" -f b="$nb" >/dev/null 2>&1 \
    && echo "learnings: $(printf '%s' "$entry" | tr '\n' ' ')" || echo "learnings: skip (write)"
}
SH
```

**The heartbeat wrapper — `.claude/auto-ship-hb.sh`.** Write it at run start next to
the helper and hand every dispatched agent its **absolute path**. Agents **CALL** it;
they never `source` anything. Three properties matter: a `#!/usr/bin/env bash`
shebang (so the Bash tool's zsh cannot mis-parse a bash-syntax helper), an absolute
helper path derived from the wrapper's own location (so it works from any worktree),
and a **loud** exit — because a heartbeat that fails quietly stays dead for a whole
run, which is exactly what happened.

```bash
cat > .claude/auto-ship-hb.sh <<'SH'
#!/usr/bin/env bash
# Worktree-safe progress heartbeat. CALL it (do not `source` it):
#   /abs/path/.claude/auto-ship-hb.sh <PVTI-item-id> "<line>"
#
# LOUD BY DESIGN, and the FOUR failure classes are NOT the same thing:
#   * helper missing / unsourceable  -> a SETUP bug. Exit 3/4/5 (2 = bad usage). The
#     heartbeat can never work this run; the operator must fix it.
#     Report progress: FAILED-setup.
#   * malformed item id              -> a CALLER bug. Exit 6. What you passed is not
#     a project item node id (`PVTI_`-prefixed, no whitespace), so no retry helps.
#     Report progress: FAILED-caller.
#   * REFUSED body construction      -> a helper-side BUG guard. Exit 7. The helper
#     built a body that failed its own safety check and wrote NOTHING; the card is
#     intact and retrying will not help. Report progress: FAILED-refused.
#   * GraphQL read/write failed      -> TRANSIENT (rate limit, blip). Exit 1. Still
#     best-effort: it must never block the ship.
#     Report progress: FAILED-transient.
# None of them aborts the ship. All are visible. Silence is the only unacceptable
# outcome -- and a caller bug wearing the transient label is a kind of silence too.
set -uo pipefail
HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auto-ship-progress.sh"
if [ ! -r "$HELPER" ]; then
  echo "HEARTBEAT-FAILED(setup): helper not readable at $HELPER" >&2; exit 3
fi
# shellcheck source=/dev/null
. "$HELPER" || { echo "HEARTBEAT-FAILED(setup): could not source $HELPER" >&2; exit 4; }
type append_progress >/dev/null 2>&1 || {
  echo "HEARTBEAT-FAILED(setup): append_progress undefined — stale helper (§2c check 2)" >&2; exit 5; }
if [ "$#" -lt 2 ]; then
  echo "HEARTBEAT-FAILED(setup): usage: $0 <item-id> \"<line>\"" >&2; exit 2
fi
out="$(append_progress "$1" "$2" 2>&1)"; rc=$?
echo "$out"
# Classify the CALLER class on the RETURN CODE, and check it FIRST. Two reasons.
# (1) It returns nonzero too, so the transient branch below would otherwise swallow
# it -- which is the exact confusion this distinction exists to remove.
# (2) On rc, not on the text: grepping $out for "MALFORMED-ID" would also
# match a SUCCESSFUL write whose progress line merely CONTAINS that string, and
# report a landed heartbeat as a non-retryable caller bug. auto-ship ships changes
# to this very file, so such a line is not hypothetical. rc is collision-free:
# append_progress returns 0 on every best-effort path and 2 only from its
# malformed-id gate.
if [ $rc -eq 2 ]; then
  echo "HEARTBEAT-FAILED(caller): $out" >&2; exit 6
fi
# rc 3 = the helper REFUSED to write a body it could not verify (TASK-470). It is not
# transient -- nothing was written, nothing was lost, and a retry changes nothing -- and
# it is not a caller bug either. Falling through to the transient catch-all would dress
# a data-loss near-miss as a rate-limit blip, which is the same mislabelling this
# wrapper's caller class exists to prevent. Its own class, checked before the catch-all.
if [ $rc -eq 3 ]; then
  echo "HEARTBEAT-FAILED(refused): $out" >&2; exit 7
fi
# The quiet best-effort failures DO return 0, so they can only be found in the text.
# Anchor it to the leading `<label>: ` so a success line whose caller-supplied text
# happens to contain "skip (" is not mislabelled transient either.
if [ $rc -ne 0 ] || printf '%s' "$out" | grep -q '^[a-z-]*: skip ('; then
  echo "HEARTBEAT-FAILED(transient): $out" >&2; exit 1
fi
SH
chmod +x .claude/auto-ship-hb.sh
```

Verify it once from a real worktree at run start — that is the environment it exists
for, and a green check in the orchestrator's own checkout proves nothing about it.

**Handoff field.** Because nothing machine-reads the progress block (below), a dead
heartbeat is invisible unless the agent says so. Every dispatched agent therefore
returns a **required** `progress: live | FAILED-<setup|caller|refused|transient>` field
alongside `reviewer:`.
`FAILED-*` never blocks the merge, but the orchestrator journals it — so a dead
heartbeat surfaces within one card instead of at the end of a whole run.

**Orchestrator-side, `source` is still correct and still relative.** The orchestrator
runs in the primary checkout where the helper exists, and shell state does **not**
persist across Bash calls, so `source` + call go in the **same** invocation:

```bash
source .claude/auto-ship-progress.sh && append_progress "$ITEM_ID" "merged #$PR ✅"   # ORCHESTRATOR ONLY
# From a dispatched agent's worktree, the equivalent is a CALL to the absolute wrapper:
#   /abs/path/to/repo/.claude/auto-ship-hb.sh "$ITEM_ID" "PR #$PR opened"
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
| In Progress, **no** PR | agent died pre-Phase-6 → move → **To Do**; run the **sweep gate** (below) to decide whether the re-dispatch is a **RESUME** or a restart; `append_progress … "⚠ orchestrator restarted — no PR, reset to To Do"`. **Not** an attempt against the cap (a crash ≠ a task failure), but journal it (`recovered`) so the global breaker still bounds crash-loops. |

### 7a. Abandoned-branch cleanup — gate it, never assume

(No-PR reset only — never when a PR is open, that work ships through the queue.)

**"No PR" is not evidence the branch is empty.** yolo-ship opens its PR in Phase 6, and
the watchdog that reaps a stalled builder fires on **silence, not on failure** — so it
has no relationship to how far the builder actually got. A quota stall (HTTP 429
`session limit`) presents as exactly that: no crash, no error, no log line, an agent
that simply stops. On 2026-09-20 the same protocol ran four times and produced **three
different shapes of live work**, all of which the old unconditional sweep would have
destroyed:

| Measured case | `git status --porcelain` | Commits ahead | Outcome after preserving |
|---|---|---|---|
| TASK-455 | **5 paths** | 0 | resumed → merged as **#650** |
| TASK-482 | *empty* | 2 | resumed → merged as **#653** |
| TASK-479 | *empty* | 3 | resumed → merged as **#654** |
| TASK-498 | *empty* | **15**, over 22 files, reviewer already run | resumed → merged as **#656** |

Read the middle column twice. Checking `--porcelain` alone — the obvious fix, and the
one originally filed — saves TASK-455 and shreds the other three. **A clean tree does
not mean no work.** The question is the general one:

> **Is there anything on this branch that does not exist anywhere else?**

…which is true if *either* the worktree is dirty *or* the branch carries commits the
base ref cannot reach. `scripts/auto-ship-sweep-gate.sh <branch>` answers it — pure git,
no network, **exit 0 = sweep is safe, 10 = preserve, 2 = error**. Only exit 0
authorizes destruction, so an internal error fails closed and `if gate; then destroy;
fi` is safe to write. It prints one parseable line
(`verdict= reason= branch= base= worktree= dirty= ahead= pushed=`) — echo it into the
audit trail either way.

The gate is deliberately blind to PRs, so **establish PR ground truth first**: this repo
**squash-merges**, so a merged branch's commits are never reachable from `main`
(`git merge-base --is-ancestor` is not a valid merged-test here — it called 49 of 51
worktrees unmerged) and `ahead` stays >0 forever. Without the merged-PR lookup below,
the gate answers `preserve` for every branch that already shipped and **nothing is ever
swept again** — the opposite failure, and a real one: lingering worktrees redden
`pnpm lint`, and this repo has watched a cleanup block silently accomplish nothing
across a whole run.

**PRESERVE ⇒ the re-dispatch is a RESUME, not a restart.** Say so on the card:
`append_progress … "⚠ stalled with unpushed work — RESUME from auto-ship/<TASK-ID>-…,
do NOT restart"`. A restart pays for the whole build a second time and usually
re-derives the same diff.

The preserve path **commits the WIP and pushes the branch to origin**, then releases the
checkout. Both halves are load-bearing:

- **Push.** A local WIP commit still leaves exactly one copy, in a worktree, on a volume
  that has sat at 99%. Pushing removes the single-copy risk.
- **Release the worktree (but keep the branch).** A fresh `isolation: "worktree"`
  builder **physically cannot check out a branch another worktree already holds**, so a
  branch left checked out is un-resumable by the normal dispatch path. Removing the
  worktree *after* the work is committed and on origin loses nothing and makes the
  resume possible. This is the one place the sweep still runs on a preserved card — and
  it only runs once the push has succeeded and the tree reads clean.

Agent worktrees are **harness-locked** (`git worktree list --porcelain` shows
`locked claude agent … (pid NNNNN)`), and a single `--force` will not remove a locked
worktree: `git worktree remove --force` exits **128** with *"cannot remove a locked
working tree… use 'remove -f -f'"*. `git branch -D` then exits 1 because the worktree
is still there, and `git worktree prune` will not touch a still-present one. The old
form suppressed all three errors with `2>/dev/null` and checked no exit code, so it
accomplished only the remote delete and reported success. Two `-f`, no blanket
suppression, and a `continue` so a second error's real cause is not masked by the
first:

```bash
# Ground truth first (see above): a SQUASH-merged branch keeps commits main cannot
# reach forever, so without this lookup the gate preserves everything already shipped.
# A FAILED lookup is indistinguishable from "no merged PRs" in the output, and it fails
# in the preserving direction — safe, but silent, and "this block silently accomplished
# nothing" is the named prior incident. Say so out loud. (Not piped into `tr` directly:
# the pipeline's status would be tr's, which always succeeds.)
if ! MERGED_RAW=$(gh pr list --state merged --search "[$TASK_ID] in:title" --json headRefName --jq '.[].headRefName'); then
  echo "⚠ MERGED LOOKUP FAILED (gh) — nothing will be swept as shipped this pass; already-merged branches stay. Re-run when gh works." >&2
  MERGED_RAW=""
fi
MERGED=$(printf '%s' "$MERGED_RAW" | tr '\n' ' ')

for b in $(git branch --list "auto-ship/$TASK_ID-*" --format '%(refname:short)'); do
  # THE GATE. Exit 0 = nothing unique here. Anything else (10 preserve, 2 error) means
  # do not destroy. Never replace this with a bare `git status --porcelain` check: a
  # clean tree is exactly the shape three of 2026-09-20's four saves had. Run it on
  # EVERY branch (it only reads) so `gate` can never carry a previous branch's path.
  gate=$(scripts/auto-ship-sweep-gate.sh "$b"); rc=$?
  case " $MERGED " in *" $b "*) shipped=yes ;; *) shipped=no ;; esac
  wt=$(printf '%s\n' "$gate" | sed -n 's/.* worktree=\(.*\) dirty=.*/\1/p')
  [ "$wt" = "-" ] && wt=""

  if [ "$rc" != 0 ] && [ "$shipped" = no ]; then
    echo "⛔ PRESERVING $b — $gate" >&2
    if [ -n "$wt" ] && [ -d "$wt" ]; then
      # Both halves fail SAFE — the release guard below re-reads the tree and keeps
      # the worktree while anything is uncommitted, so a failure here retains the WIP
      # rather than losing it. They must still be AUDIBLE: this was the last silent
      # step in a block whose every other failure now names itself.
      git -C "$wt" add -A || echo "⚠ WIP STAGE FAILED for $b — keeping its worktree" >&2
      git -C "$wt" diff --cached --quiet || git -C "$wt" commit -q -m "WIP [$TASK_ID] stalled builder, preserved by auto-ship reconcile" || echo "⚠ WIP COMMIT FAILED for $b — keeping its worktree, work is uncommitted" >&2
    fi
    if ! git push -u origin "$b"; then
      echo "⚠ PRESERVE INCOMPLETE: $b is local-only — keeping its worktree, do NOT sweep" >&2
      continue
    fi
    # Release the checkout ONLY now: committed, and on origin. A fresh worktree builder
    # cannot check out a branch another worktree holds, so this is what makes the
    # RESUME dispatch possible. The branch itself is kept, local and remote.
    if [ -n "$wt" ] && [ -d "$wt" ] && st=$(git -C "$wt" status --porcelain) && [ -z "$st" ]; then
      git worktree remove -f -f "$wt" || echo "⚠ CLEANUP FAILED: worktree $wt still present (the branch is safe on origin)" >&2
    fi
    continue
  fi
  echo "🧹 sweeping $b (shipped=$shipped) — $gate"

  if [ -n "$wt" ]; then
    # -f -f: the second -f is what defeats the harness lock. One -f exits 128.
    git worktree remove -f -f "$wt" || { echo "⚠ CLEANUP FAILED: worktree $wt still present" >&2; continue; }
  fi
  git branch -D "$b" || { echo "⚠ CLEANUP FAILED: local branch $b survives" >&2; continue; }
  # Suppressed on purpose: deleting a ref that was never pushed is the common case and
  # is not a failure. Be honest that this also eats auth/network errors — if remote
  # branches are visibly piling up, re-run this line WITHOUT the redirect to see why.
  git push origin --delete "$b" 2>/dev/null || true
done
git worktree prune
```

A `⚠ CLEANUP FAILED` line is **non-fatal** — a lingering worktree does not endanger the
merge queue (it does redden `pnpm lint`, so sweep at session end). It must still be
*visible*: this block silently accomplishing nothing is how stale worktrees accumulated
across a whole run. And do **not** gate cleanup on a `kill -0` liveness check of the
lock pid: that pid is the **Claude Code session** pid, shared by every agent worktree
and alive until the session ends, so it would always say "in use" and never authorize
anything.

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
`[TASK-<num>]` across the whole board + 1; sequential for several in one pass, computed
from the already-bound `$ITEMS`) and rewrite the title:

> An earlier version of this line said `$ITEMS` meant "there's no race". That is true
> **within** one pass and false **across sessions**, which is the whole of TASK-426 —
> `$ITEMS` is minutes old and other sessions write this board. The claim here stays
> optimistic on purpose (it is free, and it is usually right); **§8.2a's settle step
> below is what makes a collision unable to survive**, and it is not optional.

```bash
NEXT=$(printf '%s' "$ITEMS" | jq -r '.items[].title | capture("\\[TASK-(?<n>[0-9]+)\\]").n // empty' \
        | sort -n | tail -1); NEXT=$(( ${NEXT:-0} + 1 ))
# `--title` edits the card's DRAFT-ISSUE CONTENT, so `--id` wants the `DI_` content id --
# NOT the `PVTI_` project-item id that $ITEM_ID holds and that everything else in this
# doc passes. Resolve it first (same hop `append_progress` / `set_needs_input` make).
# NOTHING HERE IS PIPED INTO ANYTHING, at either call. `$?` after a pipeline belongs to
# the pipeline TAIL, so `gh … | jq` would silently convert a transient API failure into
# "this card has no draft issue" -- a different diagnosis with a different remedy (retry
# vs. give up on the card). Same reason `append_progress` keeps its read rc (§6).
json=$(gh api graphql -f query='query($i:ID!){node(id:$i){... on ProjectV2Item{content{... on DraftIssue{id}}}}}' \
         -f i="$ITEM_ID") || json=
# Empty covers BOTH "gh exited non-zero" and the theoretical "exited 0, said nothing".
# One test, so no path can end in silence -- a quiet no-op here looks exactly like a
# card nobody ever triaged.
[ -n "$json" ] || echo "FATAL: draft-issue lookup FAILED for $ITEM_ID (no answer — transient? it retries next pass) — [TASK-$NEXT] NOT assigned"
DI=; [ -n "$json" ] && DI=$(printf '%s' "$json" | jq -r '.data.node.content.id // empty')
ok=; case "$DI" in DI_*) ok=1 ;; esac
[ -n "$json" ] && [ -z "$ok" ] && echo "FATAL: no draft-issue content on $ITEM_ID (got '${DI:-<empty>}' — a linked issue/PR?) — [TASK-$NEXT] NOT assigned"
[ -n "$ok" ] && { gh project item-edit --id "$DI" --title "[TASK-$NEXT] $ORIGINAL_TITLE" \
  || echo "FATAL: item-edit refused $DI — [TASK-$NEXT] NOT assigned"; }
```

**Why the extra hop (measured 2026-09-18, throwaway draft-issue card, both ids).**
`gh` routes `--title`/`--body` to the `updateProjectV2DraftIssue` mutation, and that
mutation addresses the **content** node:

- `gh project item-edit --id <PVTI_…> --title …` → refused, in gh's own words:
  `ID must be the ID of the draft issue content which is prefixed with DI_`. The title
  did **not** change.
- `gh project item-edit --id <DI_…> --title …` → succeeded.

That probe **first measured the bug backwards**: its `rc` read **0 on the refusal**,
because the command was piped into `head` and `$?` was `head`'s. Hence the no-pipe rule
above — and hence the guard below asserting on the resulting **title**, never on a status
that a pipeline could have laundered.

**The `PVTI_`/`DI_` split is per-flag, not per-command.** §4's `--field-id` writes
(`Status`, `Depends on`) take the **`PVTI_` item id** and are correct as written — the
*item* is what carries field values. Only the content-editing flags need `DI_`. Don't
"fix" §4 to match this.

The two `FATAL` paths *for the lookup* (there is a third for the edit itself) are
mutually exclusive and jointly total: a failed-or-empty lookup
reports *lookup FAILED* (retry next pass), a successful lookup that yields no `DI_`
reports *no draft-issue content* (stop trying). The one state neither names precisely is
`gh` exiting **0** with malformed JSON — `jq` errors to stderr, `$DI` stays empty, and it
lands in the second message. Loud, safe, never stamps; just imprecise. That rests on
`gh api graphql` exiting non-zero for HTTP failures and GraphQL `errors` envelopes, which
it does today.

A card whose content is a linked real issue/PR has no draft issue, so `$DI` comes back
empty and the guard above refuses rather than stamping the wrong node. Triage only ever
sees auto-ship's own draft-issue cards, but the untagged-card path is exactly the one
that went **~4 months** without an exerciser — the broken line landed in `af774cc3`
(2026-05-25) and was corrected on 2026-09-19 — so it fails loudly instead of quietly.

An **executing** guard pins this: `scripts/__tests__/autoship-triage-title-draft-id.test.js`
extracts the block above and runs it under bash *and* zsh against a `gh` stub that
reproduces the measured refusal, then asserts on the **resulting title**. A text scan
would pass against a doc that merely says "DI_" — the mistake TASK-392 already paid for.

The `(walk)` tag is appended **after** the triage agent's verdict (it needs the body).
Per convention a walk card carries **both** the ID **and** `(walk)` — never one instead
of the other. A human who pre-tagged `(walk)` keeps it.

### 8.2a Confirming the number survived — `scripts/board-task-id.sh`

Run this immediately after the stamp above, for every card you just numbered — and
**branch on it**, because a card whose number is not confirmed must not be journalled as
tagged or dispatched. `settle` exits non-zero exactly when the id is still a duplicate:

```bash
if TASK_ID=$(scripts/board-task-id.sh settle --item "$ITEM_ID"); then
  echo "id-assigned [$TASK_ID]"   # journal it under the id that SURVIVED, not the one you stamped
else
  echo "FATAL: $ITEM_ID is NOT confirmed unique — leave it untriaged and retry next pass" >&2
fi
```

**Why.** Allocating a Task ID is a read-modify-write, and several sessions write this
board. Measured 2026-09-19: two sessions each created a TASK-420 *and* a TASK-421 within
minutes; a third landed on a TASK-454 another session had just taken. Nothing noticed
until a later `jq` returned two ids for one number. Task IDs are the board's only stable
handle — `Depends on` is a list of them, the journal keys on them, dispatch prompts name
them, `.claude/memory` rows cite them — so a duplicate corrupts four things at once and
silently. A dependency on "TASK-420" cannot say which card it means, and readiness is
*derived* from exactly that field.

**What `settle` does, and what it does not.** Projects v2 has no atomic counter and no
uniqueness constraint on a card title, so a collision cannot be *prevented* through this
API and nothing here pretends otherwise. What `settle` removes is a collision that
**survives**: it re-reads the board, and if another card now carries the same number,
the colliding card with the **lowest item node id keeps it** and every other one
renumbers **itself**. Both racers read the same board and compute the same winner, so
exactly one moves — a deterministic rule, not a randomized backoff that could have two
racers pick the same next number again.

A process only ever renames **its own** card. That is what makes two settles safe at the
same time, and it is why this runs at **creation**, not at triage: a card seconds old has
no references, while by triage the dispatch prompt and the `Depends on` field are already
written. If the duplicate is still there when the attempts run out, `settle` exits
non-zero and names both cards rather than reporting success.

**The other subcommands.**

```bash
# board-task-id: reference listing
# This block DOCUMENTS the CLI; it is not a call site, so the branch-on-failure guard
# in `scripts/__tests__/board-task-id-race.test.js` skips it. That guard defaults to
# CHECKED and this marker is the only way out, on purpose: the exemption it replaced
# inferred "reference listing" from the block's shape, and a lone bare call satisfied
# it — which is to say the guard exempted precisely the regression it exists to catch.
# If you add a real, executed call here, delete this marker.
scripts/board-task-id.sh check    # any duplicated id anywhere on the board? (exit 1 if so)
scripts/board-task-id.sh next     # the next free number
scripts/board-task-id.sh claim --title "<bare title>" --body "<body>"   # create + settle
```

`claim` is the one to use when creating a card that needs a **new** id (§4 follow-ups,
the decomposition agent). It reads the max and creates the card in **one process** —
computing the max in one tool call and creating the card in a later one is exactly how
2026-09-19's third collision happened.

The read is the cheap one: a paginated `items(first:100)` fetching ids and titles only,
~1 point a page, not the ~102 `gh project item-list` costs. It asks for the `DraftIssue`
id in the same query, so a rename needs no second lookup hop.

**Guard direction.** `check` fails **closed** — an unreadable board, an unparseable
reply, and a reply that parses to zero cards are all exit 2, never exit 0. The board has
never been empty, so "no cards" is the signature of a read that failed quietly, and "no
cards, therefore no duplicates" is the fail-open shape the whole card is about. `settle`
fails **loud**: no path exits 0 on a duplicate it saw.

**Rejected, with reasons** (so nobody re-proposes them):

- *Allocate from something already atomic* — GitHub issue numbers are atomic, but cards
  are draft issues on purpose; minting a real issue per card makes the repo, not the
  board, the id authority (a second source of truth, CLAUDE.md invariant 4) and shares a
  counter with PRs, so `[TASK-617]` and `#617` become confusable.
- *A git ref as the lock* (`refs/task-ids/TASK-n`, push fails if it exists) — genuinely
  atomic, and genuinely a second source of truth for the same concept. Same invariant.
- *Namespace by producer* — breaks the flat id space `Depends on`, the journal and the
  memory rows all assume, and does nothing when two auto-ship orchestrators run at once.

`scripts/__tests__/board-task-id-race.test.js` holds this: it builds a board that really
holds two `[TASK-420]` cards and runs the guard against it, and it runs two `claim`
processes rendezvoused on a barrier so both provably compute the same max.

### 8.3 The needs-input block + `set_needs_input` helper

Underspecified cards get a delimited block spliced into the body — same one-writer
discipline as the progress block (§6), human description preserved outside the markers:

```
<!-- AUTOSHIP-NEEDS-INPUT:START -->
### ⚠ Needs input before this can ship

Type your answer on the **A** line under each question (leave the `Qn` / `An` labels in
place), then drag this card back to **To Do**.

**Q1.** <question>

**A1.**

**Q2.** <question>

**A2.**
<!-- AUTOSHIP-NEEDS-INPUT:END -->
```

Each question renders as a `**Qn.**` line followed by its **own blank** `**An.**` answer
line — Q and A never share a line, and the answer starts empty for the human to fill.
Never collapse multiple questions onto one line; the helper below does the splitting for
you (see the quoting note).

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
  # A malformed id is a CALLER BUG, not a blip. Project item node ids are
  # `PVTI_`-prefixed and hold no whitespace, so the shape is checkable for zero
  # API calls -- and checking it here is what keeps the quiet `skip (...)` paths
  # below meaning ONLY "transient". See the **Malformed vs transient** note in §6.
  local ok=
  case "$item" in
    '' | *[[:space:]]*) ;;
    PVTI_*) ok=1 ;;
  esac
  [ -n "$ok" ] || { echo "needs-input: MALFORMED-ID ${item:-<empty>}"; return 2; }
  local START='<!-- AUTOSHIP-NEEDS-INPUT:START -->'
  local END='<!-- AUTOSHIP-NEEDS-INPUT:END -->'
  local q='query($i:ID!){node(id:$i){... on ProjectV2Item{content{... on DraftIssue{id body}}}}}'
  local json cid body items block stripped nb
  json=$(gh api graphql -f query="$q" -f i="$item" 2>/dev/null) || { echo "needs-input: skip (read)"; return 0; }
  cid=$(printf '%s' "$json" | jq -r '.data.node.content.id // empty')
  body=$(printf '%s' "$json" | jq -r '.data.node.content.body // ""')
  [ -z "$cid" ] && { echo "needs-input: skip (not a draft-issue card)"; return 0; }
  # normalize literal "\n" -> real newline (defensive), drop blanks, then emit one
  # **Qn.** line + its OWN blank **An.** line per question (each its own paragraph) so
  # Q and A never share a line and the human types into an empty slot.
  items=$(printf '%s' "$questions" | awk '{ gsub(/\\n/, "\n"); print }' \
            | awk 'NF { n++; printf "**Q%d.** %s\n\n**A%d.**\n\n", n, $0, n }')
  block=$(printf '%s\n### ⚠ Needs input before this can ship\n\nType your answer on the **A** line under each question (leave the `Qn` / `An` labels in place), then drag this card back to **To Do**.\n\n%s%s' \
            "$START" "$items" "$END")
  # A question may contain newlines, so `items` reaches awk on STDIN and the two `-v`
  # assignments below carry only the fixed marker constants. Never pass caller text
  # through `-v`: an awk `-v` assignment cannot hold a literal newline (§6, TASK-470).
  [ -n "$items" ] || { echo "needs-input: REFUSED (no questions; body untouched)"; return 3; }
  # drop any prior block (markers inclusive), then append the fresh one
  stripped=$(printf '%s' "$body" | awk -v s="$START" -v e="$END" 'BEGIN{k=0} $0==s{k=1} k==0{print} $0==e{k=0}') \
    || { echo "needs-input: REFUSED (strip failed; body untouched)"; return 3; }
  # If there was no prior block, the strip must be a no-op. Anything else means awk ate
  # human-authored text, which is exactly the loss this gate exists to stop.
  case "$body" in
    *"$START"*) ;;
    *) [ "$stripped" = "$body" ] || {
         echo "needs-input: REFUSED (strip altered a body with no block; body untouched)"; return 3; } ;;
  esac
  nb=$(printf '%s\n\n%s' "$stripped" "$block")
  # Never write a body we did not successfully construct.
  case "$nb" in
    *"$START"*"$END"*) ;;
    *) echo "needs-input: REFUSED (block not constructed; body untouched)"; return 3 ;;
  esac
  gh api graphql -f query='mutation($d:ID!,$b:String!){updateProjectV2DraftIssue(input:{draftIssueId:$d,body:$b}){draftIssue{id}}}' \
    -f d="$cid" -f b="$nb" >/dev/null 2>&1 && echo "needs-input: set" || echo "needs-input: skip (write)"
}
SH
```

**Completeness guard (run start).** `set_needs_input` lives in this helper file alongside
`append_progress` + `append_learnings` (§6). A *stale* on-disk file can predate a function
— an early run that wrote only `append_progress` was the cause of a real regression: the
triage agent's `set_needs_input` call silently no-op'd and it hand-rolled a mangled Q&A
block. **This check is now check (2) of the §2c run-start self-tests and is FATAL** —
it is not advisory and it does not wait for a caller to trip over the gap. It caught a
missing `set_needs_input` again on 2026-08-23; the only reason that one was not another
silent no-op is that a human ran the guard by hand. Run it automatically, at run start,
before the first dispatch:

```bash
source .claude/auto-ship-progress.sh
for f in append_progress set_needs_input append_learnings; do
  type "$f" >/dev/null 2>&1 || echo "FATAL: STALE HELPER — $f missing; re-write the cat blocks (§6/§8.3; the first cat > truncates, so a full rewrite is safe)"
done
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
