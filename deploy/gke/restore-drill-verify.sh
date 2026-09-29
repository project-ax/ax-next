#!/bin/sh
# deploy/gke/restore-drill-verify.sh — the checks the restore drill runs INSIDE
# its throwaway pod, against the two restored copies of the production disks.
#
#   sh restore-drill-verify.sh <workspace-dir> <facts-dir>
#
# `backups.sh drill` ships this file into the pod as a ConfigMap and runs it
# with the agent image (so git and node are the same ones production uses). It
# lives in its own file, not inside the pod manifest, so the tests can run it
# against real git repos and a real sqlite file on any machine.
#
# It only READS the restored copy (sqlite may write its own -wal/-shm files
# while it recovers, which is the point: a snapshot is a crash-consistent image,
# and opening the database is what proves it recovers). Nothing here can reach
# production: the pod only mounts disks that were created from snapshots.
#
# Output ends with exactly one line the drill parses:
#   DRILL-RESULT: PASS
#   DRILL-RESULT: FAIL <n> check(s) failed
# The exit status matches (0 pass, 1 fail).
#
# POSIX sh on purpose: the image's /bin/sh is dash.

set -u

if [ "$#" -ne 2 ]; then
  echo "usage: sh restore-drill-verify.sh <workspace-dir> <facts-dir>" >&2
  echo "DRILL-RESULT: FAIL 1 check(s) failed"
  exit 1
fi

WS=$1
FACTS=$2
# Repos are checked newest-first, and the cap keeps a deployment with thousands
# of agents from turning a drill into an hours-long fsck. Override with
# MAX_REPOS=... when you want a fuller check.
MAX_REPOS=${MAX_REPOS:-25}

failures=0
fail() {
  failures=$((failures + 1))
  echo "FAIL: $*"
}
ok() { echo "ok:   $*"; }
warn() { echo "warn: $*"; }

# Every git call in this file goes through here. The repositories on the disk
# are written by agents, so their contents and their own config are untrusted:
# this is a read-only check, and nothing a repository says may make git run a
# program. `fsck` and `log` on a bare repo do not consult these settings today;
# they are switched off anyway so that stays true if git changes.
#   safe.directory   the copy is owned by whoever wrote it in production, and the
#                    ownership guard would only get in the way of a disposable disk
#   core.fsmonitor / core.hooksPath / core.pager   no helper programs
#   GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT       no system config, no prompts
safe_git() {
  GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git \
    -c safe.directory='*' -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat \
    "$@"
}

# ── Workspace disk: the git repos ─────────────────────────────────────────────
echo "== workspace disk ($WS)"
if [ ! -d "$WS" ]; then
  fail "workspace mount $WS is not a directory"
else
  # ws-*.git is the layout the local workspace backend writes; repo.git is the
  # single-repo layout older installs used (deploy/README.md "Reset workspace
  # storage" deletes both).
  repos=$(ls -dt "$WS"/ws-*.git "$WS"/repo.git 2>/dev/null || true)
  total=0
  if [ -n "$repos" ]; then
    total=$(printf '%s\n' "$repos" | wc -l | tr -d ' ')
  fi
  if [ "$total" -eq 0 ]; then
    fail "no ws-*.git repositories found on the restored workspace disk"
  else
    ok "$total repositories found (checking the newest $MAX_REPOS)"
    checked=0
    for repo in $repos; do
      [ "$checked" -lt "$MAX_REPOS" ] || break
      checked=$((checked + 1))
      if out=$(safe_git --git-dir="$repo" fsck --connectivity-only --no-progress 2>&1); then
        newest=$(safe_git --git-dir="$repo" log -1 --all --format='%h %cI' 2>/dev/null || true)
        ok "$(basename "$repo") fsck clean${newest:+ (newest commit $newest)}"
      else
        fail "$(basename "$repo") fsck failed: $(printf '%s' "$out" | head -3 | tr '\n' ' ')"
      fi
    done
  fi
  if [ -d "$WS/blobs" ]; then
    ok "blobs/ present"
  else
    warn "no blobs/ directory (fine on a deployment that has never stored an attachment or artifact)"
  fi
  df -h "$WS" 2>/dev/null | tail -1 | sed 's/^/      /'
fi

# ── Facts disk: facts.db ──────────────────────────────────────────────────────
echo "== facts disk ($FACTS)"
DB="$FACTS/facts.db"
if [ ! -f "$DB" ]; then
  fail "$DB not found on the restored facts disk"
elif ! command -v node >/dev/null 2>&1; then
  fail "node is not available in this image, so facts.db cannot be opened"
else
  # node:sqlite ships inside Node, so this needs no npm package. Virtual tables
  # (the full-text and vector indexes) are skipped when counting: opening them
  # needs the sqlite-vec extension, which this pod deliberately does not load.
  # PRAGMA integrity_check still walks every page of the file.
  #
  # The checker goes to a file rather than a `node -e '...'` string, and the
  # heredoc is not inside a $( ): it holds quotes of both kinds, which macOS's
  # bash 3.2 (also `sh` there) cannot parse inside a command substitution.
  CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/drill-verify.XXXXXX") || {
    echo "FAIL: cannot create a scratch directory under ${TMPDIR:-/tmp}"
    echo "DRILL-RESULT: FAIL $((failures + 1)) check(s) failed"
    exit 1
  }
  cat > "$CHECK_DIR/check-facts.js" <<'JSEOF'
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[2];
let db;
let verdicts;
try {
  db = new DatabaseSync(path);
  // A torn or half-restored file often opens fine and only fails here, or does
  // not even open: both are a FAIL, and neither is allowed to be a stack trace.
  verdicts = db.prepare("PRAGMA integrity_check").all().map((r) => String(Object.values(r)[0]));
} catch (e) {
  console.log("FAIL: could not open or check " + path + ": " + e.message);
  process.exit(1);
}
let bad = false;
if (verdicts.length === 1 && verdicts[0] === "ok") {
  console.log("ok:   facts.db integrity_check = ok");
} else {
  bad = true;
  console.log("FAIL: facts.db integrity_check: " + verdicts.slice(0, 3).join("; "));
}
const tables = db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all()
  .filter((t) => !/^\s*CREATE VIRTUAL TABLE/i.test(t.sql || ""));
let total = 0;
for (const t of tables) {
  try {
    const quoted = '"' + t.name.replace(/"/g, '""') + '"';
    const n = db.prepare("SELECT count(*) AS n FROM " + quoted).get().n;
    total += Number(n);
    console.log("      " + t.name + ": " + n + " rows");
  } catch (e) {
    bad = true;
    console.log("FAIL: could not read table " + t.name + ": " + e.message);
  }
}
if (tables.length === 0) {
  bad = true;
  console.log("FAIL: facts.db has no tables");
} else if (total === 0) {
  console.log("warn: facts.db opens cleanly but every table is empty. If the live memory has facts in it, this copy is wrong.");
}
db.close();
process.exit(bad ? 1 : 0);
JSEOF
  if ! node --no-warnings "$CHECK_DIR/check-facts.js" "$DB"; then
    failures=$((failures + 1))
  fi
  rm -rf "$CHECK_DIR"
fi

echo "=="
if [ "$failures" -eq 0 ]; then
  echo "DRILL-RESULT: PASS"
  exit 0
fi
echo "DRILL-RESULT: FAIL $failures check(s) failed"
exit 1
