#!/usr/bin/env bash
#
# board-task-id.sh — allocate a `[TASK-n]` board id safely when several sessions are
# writing to the "TO DO" board at once.
#
# THE BUG THIS EXISTS FOR (TASK-426).
#
# Assigning a Task ID was a read-modify-write with no atomicity: read the board, take
# `max([TASK-n]) + 1`, write a card with that number. Every card-creation path in the
# auto-ship docs had its own copy of that snippet, and one of them computed the max from
# `$ITEMS` — a board snapshot bound once at the top of an orchestrator pass, minutes
# before the write. Measured 2026-09-19: two sessions each created a TASK-420 and a
# TASK-421 within minutes of each other, and a third landed on a TASK-454 another session
# had just taken. Nothing noticed until a later `jq` returned two ids for one number.
#
# Task IDs are the board's only stable handle. `Depends on` is a list of them, the
# journal keys on them, dispatch prompts name them, and `.claude/memory` rows cite them.
# A duplicate corrupts all four at once and silently: a dependency on "TASK-420" cannot
# say which card it means, and readiness is derived from exactly that field.
#
# WHAT THIS CAN AND CANNOT DO — the honest version.
#
# GitHub Projects v2 has no atomic counter and no uniqueness constraint on a card title.
# Two `item-create`s with the same title both succeed. So a collision cannot be prevented
# by construction through this API, and nothing here claims to. What it does instead is
# make a collision unable to SURVIVE:
#
#   1. Claim optimistically. Read the board and create the card in ONE process, so the
#      window between the read and the write is milliseconds instead of minutes.
#   2. Verify against a FRESH read. If another card now holds the same number, exactly
#      one party yields.
#   3. The yield rule is DETERMINISTIC, not randomized: the colliding card with the
#      lowest item node id keeps the number; every other one renumbers ITSELF. Both
#      racers compute the same winner from the same board, so one of them moves and the
#      other does not. Randomized backoff alone would let two racers pick the same next
#      number again, and again.
#
# THE INVARIANT THAT MAKES CONCURRENT SETTLES SAFE: a process only ever renames its OWN
# card. It never edits another session's. Renaming a card that is seconds old is free —
# nothing references it yet — which is why this runs at creation time and not at triage.
# By triage the dispatch prompt and the `Depends on` field have already been written.
#
# GUARD DIRECTION — which way does this fail?
#
# `check` fails CLOSED. A board it could not read, a reply that will not parse, and a
# reply that parses to zero cards are all exit 2, never exit 0. The ax-next board has
# never been empty, so "no cards" is the signature of a read that failed quietly, and
# "no cards, therefore no duplicates" is precisely the fail-open shape this script
# exists to remove.
#
# `settle` fails LOUD. If a duplicate is still there after the last attempt it exits 1
# and names both cards. There is no path that sees a duplicate and exits 0.
#
# The one thing that deliberately fails OPEN is the ID PARSER, which is more permissive
# than the doc's "is this card tagged?" regex (it does not require the space after the
# `]`). Over-matching makes the duplicate guard notice MORE collisions; under-matching
# would make it miss one.
#
# Usage:
#   scripts/board-task-id.sh check                       # any duplicated id on the board?
#   scripts/board-task-id.sh next                        # the next free number
#   scripts/board-task-id.sh claim --title <t> [--body <b> | --body-file <f>]
#   scripts/board-task-id.sh settle --item <PVTI_...>    # verify + yield a card's id
#
#   Any subcommand takes `--board <file|->` to read a normalized board from a file or
#   stdin instead of GitHub: a JSON array of `{item, draft, title}`. `check` and `next`
#   are then completely offline.
#
# Exit codes:
#   0  clean / settled / printed an answer
#   1  duplicates found (`check`), or a collision still unresolved (`settle`, `claim`)
#   2  usage error, or the board could not be read — fail CLOSED
#
# Environment:
#   BOARD_OWNER              default project-ax
#   BOARD_PROJECT_NUMBER     default 1
#   BOARD_TASK_ID_MAX_ATTEMPTS  default 6   settle rounds before giving up loudly
#   BOARD_TASK_ID_BACKOFF_MS    default 400 base backoff between rounds (plus jitter)

set -uo pipefail

OWNER="${BOARD_OWNER:-project-ax}"
PNUM="${BOARD_PROJECT_NUMBER:-1}"
MAX_ATTEMPTS="${BOARD_TASK_ID_MAX_ATTEMPTS:-6}"
BACKOFF_MS="${BOARD_TASK_ID_BACKOFF_MS:-400}"

# A page cap so a misbehaving API cannot spin here forever. 60 pages x 100 = 6000 cards,
# comfortably above a board that passed 300 in Aug 2026 and never sheds Done cards.
MAX_PAGES=60

fatal() {
  echo "board-task-id.sh: FATAL: $*" >&2
}

usage() {
  # From the `# Usage:` line to the end of the header comment. A hardcoded line range
  # silently starts printing the wrong thing the first time anyone edits the header
  # above it, and a usage message that drifts is worse than none.
  sed -n '/^# Usage:/,/^$/p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'
}

# ---------------------------------------------------------------------------------
# Reading the board.
# ---------------------------------------------------------------------------------

# One GraphQL query, paginated. `fieldValueByName` is deliberately NOT requested: this
# needs titles and ids only, which keeps the read at ~1 point per 100-item page instead
# of the ~102 that `gh project item-list` costs by pulling every field value and body.
# The budget is shared with the poller, the merge queue and the builders.
#
# The DraftIssue `id` comes back in the SAME read, so renaming needs no second lookup
# hop — `gh project item-edit --title` addresses the content node and refuses a `PVTI_`
# id outright (measured, TASK-401).
PAGE_QUERY='query($o:String!,$n:Int!,$after:String){
  organization(login:$o){ projectV2(number:$n){ items(first:100, after:$after){
    pageInfo{ hasNextPage endCursor }
    nodes{
      id
      content{
        ... on DraftIssue{ id title }
        ... on Issue{ title }
        ... on PullRequest{ title } } } } } } }'

# read_board — echo the board as a normalized JSON array of {item, draft, title}.
# Non-zero on ANY failure to read it completely. Callers must treat that as fatal; a
# partial board is a board with cards you cannot see, and the max computed from it is a
# number somebody already holds.
read_board() {
  if [ -n "${BOARD_FILE:-}" ]; then
    local raw
    if [ "$BOARD_FILE" = "-" ]; then raw=$(cat); else raw=$(cat "$BOARD_FILE") || return 1; fi
    printf '%s' "$raw" | jq -ce '[.[] | {item, draft:(.draft // ""), title:(.title // "")}]' \
      2>/dev/null || return 1
    return 0
  fi

  local after="null" all="[]" page nodes hasnext cursor pages=0
  while :; do
    pages=$((pages + 1))
    if [ "$pages" -gt "$MAX_PAGES" ]; then return 1; fi
    # NOT piped: `$?` after a pipeline belongs to the pipeline TAIL, so `gh … | jq`
    # would launder a transient API failure into "the board is empty" — a different
    # diagnosis with a different remedy. Same rule §8.2 keeps for its own lookup.
    if [ "$after" = "null" ]; then
      page=$(gh api graphql -f query="$PAGE_QUERY" -f o="$OWNER" -F n="$PNUM" -F after=null) || return 1
    else
      page=$(gh api graphql -f query="$PAGE_QUERY" -f o="$OWNER" -F n="$PNUM" -f after="$after") || return 1
    fi
    # Covers both "gh exited 0 with nothing" and "gh exited 0 with HTML".
    [ -n "$page" ] || return 1
    printf '%s' "$page" | jq -e '.data.organization.projectV2.items' >/dev/null 2>&1 || return 1
    nodes=$(printf '%s' "$page" | jq -c '.data.organization.projectV2.items.nodes') || return 1
    all=$(jq -cn --argjson a "$all" --argjson b "$nodes" '$a + $b') || return 1
    hasnext=$(printf '%s' "$page" | jq -r '.data.organization.projectV2.items.pageInfo.hasNextPage')
    cursor=$(printf '%s' "$page" | jq -r '.data.organization.projectV2.items.pageInfo.endCursor')
    # Anything but the two booleans means the page did not have the shape we think it
    # has — and the default branch below is `break`, which would report a PARTIAL board
    # as a complete one. This is the one spot in this reader where an unchecked value
    # turns a read failure into a wrong ANSWER rather than an error.
    case "$hasnext" in
      true | false) : ;;
      *) return 1 ;;
    esac
    [ "$hasnext" = "true" ] || break
    [ -n "$cursor" ] && [ "$cursor" != "null" ] || return 1
    after="$cursor"
  done

  printf '%s' "$all" | jq -c '[.[] | {item:.id, draft:(.content.id // ""), title:(.content.title // "")}]'
}

# board_or_die — read the board, or exit 2 saying which way it failed.
#
# The empty case is fatal on purpose and is the whole point of the guard-direction note
# in the header: a truncated or garbled read that still parses is indistinguishable from
# a board with nothing on it, and treating it as clean is the fail-open shape.
board_or_die() {
  local b
  b=$(read_board) || {
    fatal "could not read the board (owner=$OWNER project=$PNUM). Not treating that as a pass — an unread board has not been checked."
    exit 2
  }
  if [ -z "$b" ] || [ "$(printf '%s' "$b" | jq -r 'length')" = "0" ]; then
    fatal "the board read back EMPTY. That is not a clean board, it is a read that failed quietly (truncated page, wrong project, revoked token)."
    exit 2
  fi
  printf '%s' "$b"
}

# ---------------------------------------------------------------------------------
# Id parsing. Deliberately more permissive than the doc's tagger (no required space
# after the `]`): over-matching finds MORE duplicates, under-matching misses one.
# ---------------------------------------------------------------------------------
JQ_WITH_IDS='
def parsed: [ capture("^\\[(?<p>ARCH|CLI|SYNC|FAULTA|TASK)-(?<n>[0-9]+)\\]") ];
map(. as $c | ($c.title | parsed) as $m
    | $c + (if ($m|length) > 0
            then {tid: ($m[0].p + "-" + $m[0].n), num: ($m[0].n|tonumber), prefix: $m[0].p}
            else {tid: null, num: null, prefix: null} end))'

# next_num — highest number on the board + 1, across ALL prefixes.
#
# One counter for every prefix, not one per prefix: `ARCH-7` and `TASK-7` are distinct
# ids, but handing out a fresh `TASK-7` next to a historical `ARCH-7` invites exactly the
# human misreading the whole card is about. Numeric comparison, not lexical — `TASK-99`
# sorts above `TASK-401` as a string, and the answer 100 is a number a live card holds.
next_num() {
  printf '%s' "$1" | jq -r "$JQ_WITH_IDS"' | [.[].num // empty] | (max // 0) + 1'
}

# next_or_die — next_num, with the answer PROVEN to be a number before anyone stamps it
# onto a card. A jq that fails prints nothing on stdout, so an unchecked `$(next_num …)`
# is the empty string, and `[TASK-$NEXT]` then becomes the literal title `[TASK-] …`:
# a card with no id at all, which every consumer (readiness, `Depends on`, the journal)
# reads as "untagged" and which no guard in this file would ever flag as a duplicate.
# Silently wrong is worse here than loudly absent.
next_or_die() {
  local n
  n=$(next_num "$1") || n=
  case "$n" in
    '' | *[!0-9]*)
      fatal "could not compute the next free number from the board (got '${n:-<empty>}'). Nothing was created or renamed."
      return 2
      ;;
  esac
  printf '%s' "$n"
}

# ---------------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------------
cmd_check() {
  local board dups
  board=$(board_or_die) || exit $?
  # The `||` is the whole guard, and it is not decoration. jq prints its errors on
  # stderr and nothing on stdout, so a filter that failed to compile or choked on the
  # data leaves `$dups` EMPTY -- identical to "no duplicates found". `set -o pipefail`
  # makes the pipeline carry jq's status, and this turns it into an exit 2. Without it,
  # the single most alarming answer this script can give (a board it could not analyse)
  # would print "ok".
  dups=$(printf '%s' "$board" | jq -r "$JQ_WITH_IDS"'
    | map(select(.tid != null)) | group_by(.tid) | map(select(length > 1))
    | .[] | "\(.[0].tid) is held by \(length) cards: " + ([.[] | "\(.item) (\(.title))"] | join("  |  "))') || {
    fatal "could not analyse the board JSON. Not treating that as a pass — nothing was checked."
    return 2
  }
  if [ -n "$dups" ]; then
    fatal "duplicate Task IDs on the board:"
    printf '%s\n' "$dups" >&2
    echo "  Renumber the card with FEWER references (a brand-new card has none), then fix" >&2
    echo "  any 'Depends on' entry that pointed at it. Title edits need the DI_ content id." >&2
    return 1
  fi
  echo "board-task-id.sh: every [PREFIX-n] on the board is held by exactly one card — ok."
  return 0
}

# ---------------------------------------------------------------------------------
# settle
# ---------------------------------------------------------------------------------

backoff() {
  # Base plus up to one base of jitter. The jitter is not what resolves a collision —
  # the deterministic keeper rule does that — it only stops two racers from re-reading
  # in lockstep.
  local ms=$((BACKOFF_MS + (RANDOM % (BACKOFF_MS + 1))))
  # `printf -v`, a BUILTIN, and not `sleep "$(awk "BEGIN{printf \"%.3f\", $ms/1000}")"`.
  # That awk form is what this function shipped with for about an hour and it HUNG the
  # script, which is worth the four lines it takes to say why. The nested `\"` inside a
  # `$( )` inside `"…"` did not survive parsing: awk was handed `BEGINprintf "%.3f"`, in
  # which `BEGIN` is no longer a block keyword but a bare pattern — so the program was no
  # longer BEGIN-only, awk fell back to its default "read input and print", and stdin was
  # the never-written pipe every test runner and `child_process.spawn` hands a child.
  # It waited forever, silently, with no error and no exit code. A BEGIN-only awk that
  # stops being BEGIN-only turns into a blocking read; keeping the formatting in the
  # shell removes the failure mode instead of re-quoting around it.
  local secs
  printf -v secs '%d.%03d' "$((ms / 1000))" "$((ms % 1000))"
  sleep "$secs"
}

# settle_item <PVTI_id> — verify the card's id is unique, yielding if it is not.
# Sets SETTLED_TID on success. Returns 0 settled, 1 unresolved, 2 unusable input.
SETTLED_TID=""
settle_item() {
  local item="$1" attempt=1
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    local board mine tid cohort_n keeper nextn draft rest newtitle
    board=$(board_or_die) || exit $?

    mine=$(printf '%s' "$board" | jq -c "$JQ_WITH_IDS"' | map(select(.item == $i)) | .[0] // empty' \
      --arg i "$item")
    if [ -z "$mine" ]; then
      # Not necessarily a bad id. `claim` creates the card and re-reads it immediately,
      # and Projects v2 does not promise read-after-write consistency. Treating the first
      # absence as fatal would make `claim` report failure for a card it really did
      # create — and the obvious remedy for THAT, creating another one, is the worst
      # answer available. So an absent item is retried like any other unsettled state and
      # only becomes fatal once the attempts run out. A genuinely bogus id still fails
      # loudly, a couple of backoffs later.
      if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        echo "board-task-id.sh: $item is not on the board yet (attempt $attempt/$MAX_ATTEMPTS) — re-reading." >&2
        attempt=$((attempt + 1))
        backoff
        continue
      fi
      fatal "item $item is not on the board after $MAX_ATTEMPTS reads. Nothing was renamed."
      return 2
    fi
    tid=$(printf '%s' "$mine" | jq -r '.tid // empty')
    if [ -z "$tid" ]; then
      fatal "item $item carries no [PREFIX-n] in its title, so there is no id to settle."
      return 2
    fi

    cohort_n=$(printf '%s' "$board" | jq -r "$JQ_WITH_IDS"' | map(select(.tid == $t)) | length' --arg t "$tid")
    if [ "$cohort_n" = "1" ]; then
      SETTLED_TID="$tid"
      # Prose to STDERR, the id to STDOUT. A settle that YIELDS changes the card's
      # number, and a caller still holding the old `$TASK_ID` would go on to dispatch,
      # journal and set `Depends on` against an id this card no longer carries — silent
      # id drift, which is the exact failure this script exists to end. So the surviving
      # id is machine-readable output, not something to read out of a sentence.
      echo "board-task-id.sh: $tid is held by exactly one card ($item) — settled." >&2
      return 0
    fi

    # Deterministic tiebreak: lowest item node id keeps the number. Both racers read the
    # same cohort and compute the same keeper, so exactly one of them moves.
    keeper=$(printf '%s' "$board" | jq -r "$JQ_WITH_IDS"'
      | map(select(.tid == $t)) | sort_by(.item) | .[0].item' --arg t "$tid")

    if [ "$keeper" = "$item" ]; then
      # I keep the number; somebody else has to move. Wait and look again rather than
      # renaming a card that may already be referenced by a branch, a PR title or a
      # `Depends on` entry.
      echo "board-task-id.sh: $tid is held by $cohort_n cards; $item has the lowest item id and keeps it. Waiting for the other holder(s) to yield (attempt $attempt/$MAX_ATTEMPTS)." >&2
      attempt=$((attempt + 1))
      [ "$attempt" -le "$MAX_ATTEMPTS" ] && backoff
      continue
    fi

    # I yield. Only ever my own card.
    nextn=$(next_or_die "$board") || return 2
    draft=$(printf '%s' "$mine" | jq -r '.draft // empty')
    if [ -z "$draft" ]; then
      fatal "$item collides on $tid but has no draft-issue content id, so its title cannot be edited (a linked issue/PR?). Renumber it by hand."
      return 2
    fi
    # `sub` and not shell string surgery: a title can contain anything, including the
    # characters a `${x#…}` pattern would treat as a glob.
    rest=$(printf '%s' "$mine" | jq -r '.title | sub("^\\[(ARCH|CLI|SYNC|FAULTA|TASK)-[0-9]+\\]\\s*"; "")')
    newtitle="[$(printf '%s' "$mine" | jq -r '.prefix')-$nextn] $rest"

    echo "board-task-id.sh: COLLISION on $tid ($cohort_n cards). $item is not the keeper, so it yields -> [${tid%%-*}-$nextn]." >&2
    # NOT piped, for the same reason read_board is not: this `||` has to see gh's own rc.
    # `>&2`, because stdout is this script's machine-readable channel and `gh` prints a
    # chatty `Edited item "…"` line on success. Redirection does not touch the exit
    # status, so the `if !` still sees gh's own rc — this is not the pipe trap, it is the
    # opposite: keep the status, get the noise out of the answer.
    if ! gh project item-edit --id "$draft" --title "$newtitle" >&2; then
      fatal "item-edit refused $draft — $item still carries $tid."
      return 1
    fi
    attempt=$((attempt + 1))
    # Loop round and re-verify: two yielders can land on the same next number, and the
    # next round's keeper rule separates them.
    [ "$attempt" -le "$MAX_ATTEMPTS" ] && backoff
  done

  # One last read purely to name the cards a human has to repair. `|| board='[]'` is the
  # ONLY place a failed read is tolerated, and it is safe because this arm has already
  # decided to fail: the outcome is `return 1` either way, and the fallback degrades the
  # MESSAGE, never the verdict.
  local board stuck_tid holders
  board=$(read_board) || board='[]'
  stuck_tid=$(printf '%s' "$board" | jq -r "$JQ_WITH_IDS"'
    | map(select(.item == $i)) | .[0].tid // empty' --arg i "$item")
  holders=$(printf '%s' "$board" | jq -r "$JQ_WITH_IDS"'
    | map(select(.tid == $t)) | [.[] | "\(.item) (\(.title))"] | join("  |  ")' \
    --arg t "${stuck_tid:-none}")
  fatal "$item is STILL sharing ${stuck_tid:-its Task ID} after $MAX_ATTEMPTS attempts. Holders: ${holders:-<board unreadable>}"
  echo "  Renumber the card with FEWER references by hand and repair any 'Depends on' that pointed at it." >&2
  return 1
}

cmd_settle() {
  local item=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --item) item="${2:-}"; shift 2 ;;
      *) echo "board-task-id.sh: settle: unexpected argument '$1'" >&2; return 2 ;;
    esac
  done
  [ -n "$item" ] || { echo "board-task-id.sh: settle needs --item <PVTI_...>" >&2; return 2; }
  settle_item "$item" || return $?
  # The id that SURVIVED, for the caller to carry forward. See the stdout/stderr split in
  # settle_item: a yield renames the card, so the id you passed in is not always the id
  # you get back — and that is the whole reason to ask.
  echo "$SETTLED_TID"
}

# ---------------------------------------------------------------------------------
# claim
# ---------------------------------------------------------------------------------
cmd_claim() {
  local title="" body="" body_file=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --title) title="${2:-}"; shift 2 ;;
      --body) body="${2:-}"; shift 2 ;;
      --body-file) body_file="${2:-}"; shift 2 ;;
      *) echo "board-task-id.sh: claim: unexpected argument '$1'" >&2; return 2 ;;
    esac
  done
  [ -n "$title" ] || { echo "board-task-id.sh: claim needs --title <title>" >&2; return 2; }
  if [ -n "$body_file" ]; then
    if [ "$body_file" = "-" ]; then body=$(cat); else
      body=$(cat "$body_file") || { fatal "cannot read --body-file $body_file"; return 2; }
    fi
  fi
  if [ -n "${BOARD_FILE:-}" ]; then
    echo "board-task-id.sh: claim writes to the real board; --board is for check/next only." >&2
    return 2
  fi

  # The read and the create happen in THIS process, back to back. That is the whole of
  # the "same invocation" rule: computing the max in one tool call and creating the card
  # in a later one is how 2026-09-19's third collision happened.
  local board nextn created item
  board=$(board_or_die) || exit $?
  nextn=$(next_or_die "$board") || return 2

  created=$(gh project item-create "$PNUM" --owner "$OWNER" \
    --title "[TASK-$nextn] $title" --body "$body" --format json) || {
    fatal "item-create failed; no card was created."
    return 1
  }
  item=$(printf '%s' "$created" | jq -r '.id // empty')
  if [ -z "$item" ]; then
    fatal "item-create returned no item id. A card MAY have been created — run 'check' before creating another."
    return 1
  fi

  settle_item "$item" || return $?
  # stdout is the machine-readable answer: the id that survived, and the item it is on.
  echo "$SETTLED_TID $item"
  return 0
}

# ---------------------------------------------------------------------------------

BOARD_FILE=""
SUB="${1:-}"
[ "$#" -gt 0 ] && shift

case "$SUB" in
  -h | --help | help | '') usage; [ -z "$SUB" ] && exit 2; exit 0 ;;
esac

# `--board` is global, so strip it before the subcommand sees the rest.
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --board) BOARD_FILE="${2:-}"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
export BOARD_FILE

if ! command -v jq >/dev/null 2>&1; then
  fatal "jq is not on PATH. Every path here parses board JSON, so this cannot run."
  exit 2
fi

case "$SUB" in
  check)  cmd_check  "${ARGS[@]+"${ARGS[@]}"}" ;;
  next)   board=$(board_or_die) || exit $?; next_or_die "$board" || exit 2; echo ;;
  claim)  cmd_claim  "${ARGS[@]+"${ARGS[@]}"}" ;;
  settle) cmd_settle "${ARGS[@]+"${ARGS[@]}"}" ;;
  *) echo "board-task-id.sh: unknown subcommand '$SUB' (check | next | claim | settle)" >&2; exit 2 ;;
esac
