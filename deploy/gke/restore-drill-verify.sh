#!/bin/sh
# deploy/gke/restore-drill-verify.sh — the checks the restore drill runs INSIDE
# its throwaway pod, against the two restored copies of the production disks.
#
#   sh restore-drill-verify.sh <workspace-dir> <facts-dir>
#
# `backups.sh drill` ships this file into the pod as a ConfigMap and runs it
# with the agent image (so node is the same one production uses). It lives in
# its own file, not inside the pod manifest, so the tests can run it against a
# real blob tree and a real sqlite file on any machine.
#
# The "workspace" disk is the host's `<release>-workspace` PVC. Since the
# agent-files cutover (TASK-995/996) the only live data on it is `blobs/`, the
# fs blob store: every attachment, artifact and skill file, each stored at
# blobs/<aa>/<bb>/<sha256> and named by the sha256 of its own bytes. That
# makes a restored copy checkable without trusting it: hash a file, compare
# with its name. Old `ws-*.git` repos may still sit next to it until the reset
# in deploy/GKE.md has run; nothing reads them, so they are reported and not
# checked, and this script never runs git.
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
# Blobs are hashed newest-first, and the cap keeps a large store from turning a
# drill into an hours-long read. Override with MAX_BLOBS=... for a fuller check.
MAX_BLOBS=${MAX_BLOBS:-25}

failures=0
fail() {
  failures=$((failures + 1))
  echo "FAIL: $*"
}
warn() { echo "warn: $*"; }

if ! command -v node >/dev/null 2>&1; then
  fail "node is not available in this image, so blobs and facts.db cannot be checked"
  echo "DRILL-RESULT: FAIL $failures check(s) failed"
  exit 1
fi

# The checkers go to files rather than `node -e '...'` strings, and the
# heredocs are not inside a $( ): they hold quotes of both kinds, which macOS's
# bash 3.2 (also `sh` there) cannot parse inside a command substitution.
CHECK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/drill-verify.XXXXXX") || {
  echo "FAIL: cannot create a scratch directory under ${TMPDIR:-/tmp}"
  echo "DRILL-RESULT: FAIL $((failures + 1)) check(s) failed"
  exit 1
}
trap 'rm -rf "$CHECK_DIR"' EXIT

# ── Workspace disk: blobs/ ────────────────────────────────────────────────────
echo "== workspace disk ($WS)"
if [ ! -d "$WS" ]; then
  fail "workspace mount $WS is not a directory"
else
  legacy=0
  for d in "$WS"/ws-*.git "$WS"/repo.git; do
    [ -d "$d" ] && legacy=$((legacy + 1))
  done
  if [ "$legacy" -gt 0 ]; then
    warn "$legacy old git workspace repos (ws-*.git) still on the disk. Nothing reads them since TASK-995; deploy/GKE.md \"Reset after the agent-files cutover\" deletes them."
  fi
  if [ ! -d "$WS/blobs" ]; then
    # The blob store creates its root at boot, so a disk from a running fs
    # deployment always has one. Missing means the wrong disk, or a bad copy.
    fail "no blobs/ directory on the restored workspace disk"
  else
    cat > "$CHECK_DIR/check-blobs.js" <<'JSEOF'
// Only the live tree counts: blobs/<aa>/<bb>/<sha>, every level validated by
// name. `.retired/`, `lost+found`, temp files and anything else are skipped,
// exactly as the store's own walk skips them. Nothing is followed: a symlink
// or other non-regular file where a blob should be is a FAIL.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.argv[2];
const max = Number(process.argv[3]);
const SHARD = /^[0-9a-f]{2}$/;
const SHA = /^[0-9a-f]{64}$/;
let bad = 0;
const found = [];
function dirs(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch (e) {
    bad++;
    console.log("FAIL: cannot read " + p + ": " + e.message);
    return [];
  }
}
for (const a of dirs(root)) {
  if (!a.isDirectory() || !SHARD.test(a.name)) continue;
  for (const b of dirs(path.join(root, a.name))) {
    if (!b.isDirectory() || !SHARD.test(b.name)) continue;
    const dir = path.join(root, a.name, b.name);
    for (const f of dirs(dir)) {
      if (!SHA.test(f.name)) continue;
      const file = path.join(dir, f.name);
      if (f.name.slice(0, 2) !== a.name || f.name.slice(2, 4) !== b.name) {
        bad++;
        console.log("FAIL: " + f.name + " is filed under the wrong shard (" + a.name + "/" + b.name + ")");
        continue;
      }
      const st = fs.lstatSync(file);
      if (!st.isFile()) {
        bad++;
        console.log("FAIL: " + f.name + " is not a regular file");
        continue;
      }
      found.push({ sha: f.name, file, mtime: st.mtimeMs, size: st.size });
    }
  }
}
if (found.length === 0) {
  console.log("warn: blobs/ holds no stored files. Fine on a deployment that has never stored an attachment, artifact or skill file; wrong if it has.");
} else {
  found.sort((x, y) => y.mtime - x.mtime);
  const n = Math.min(max, found.length);
  console.log("ok:   " + found.length + " blobs found (hashing the newest " + n + ")");
  let total = 0;
  for (const f of found) total += f.size;
  console.log("      " + total + " bytes in the live tree");
  for (const f of found.slice(0, n)) {
    const h = crypto.createHash("sha256");
    const fd = fs.openSync(f.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const buf = Buffer.alloc(1 << 20);
      let r;
      while ((r = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, r));
    } finally {
      fs.closeSync(fd);
    }
    const got = h.digest("hex");
    if (got === f.sha) {
      console.log("ok:   " + f.sha.slice(0, 12) + " hash matches (" + f.size + " bytes)");
    } else {
      bad++;
      console.log("FAIL: " + f.sha.slice(0, 12) + " content does not match its name (got " + got.slice(0, 12) + ")");
    }
  }
}
process.exit(bad === 0 ? 0 : 1);
JSEOF
    if ! node --no-warnings "$CHECK_DIR/check-blobs.js" "$WS/blobs" "$MAX_BLOBS"; then
      failures=$((failures + 1))
    fi
  fi
  df -h "$WS" 2>/dev/null | tail -1 | sed 's/^/      /'
fi

# ── Facts disk: facts.db ──────────────────────────────────────────────────────
echo "== facts disk ($FACTS)"
DB="$FACTS/facts.db"
if [ ! -f "$DB" ]; then
  fail "$DB not found on the restored facts disk"
else
  # node:sqlite ships inside Node, so this needs no npm package. Virtual tables
  # (the full-text and vector indexes) are skipped when counting: opening them
  # needs the sqlite-vec extension, which this pod deliberately does not load.
  # PRAGMA integrity_check still walks every page of the file.
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
fi

echo "=="
if [ "$failures" -eq 0 ]; then
  echo "DRILL-RESULT: PASS"
  exit 0
fi
echo "DRILL-RESULT: FAIL $failures check(s) failed"
exit 1
