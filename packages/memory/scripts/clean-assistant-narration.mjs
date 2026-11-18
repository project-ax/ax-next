// clean-assistant-narration.mjs: a one-off cleanup for TASK-1151.
//
// Memory used to save the agent's play-by-play of its own work as facts
// ("assistant | created_artifact | the Q3 dashboard", "assistant | ran_tests |
// all 42 passed"), plus what it said it couldn't do ("assistant |
// stated_limitation | cannot browse the internet"). The observer stops saving
// those in the change that ships this file. This deletes the ones already
// saved. The artifact, the file and the test run are the real record, and a
// transcript copy of them is stale the moment it lands.
//
// It changes nothing unless you pass --apply. Deleting people's memories is
// hard to undo, so it also refuses, and changes nothing, whenever it can't
// finish cleanly.
//
// WHAT IT DELETES
//   Rows the observer saved (provenance `extracted`), in every agent, that the
//   observer would drop today: `classifyAgentFact` in
//   packages/memory/src/self-report.ts calls them `context`, `own-narration`,
//   `action-narration` or `capability`. Rows a person or the agent saved on
//   purpose (provenance `human` or `agent`) are never read, and a fact about
//   anyone but the assistant is never deleted. Each row goes with its
//   full-text (FTS5) and vector (vec0) search rows, in ONE transaction, the
//   way the store's own forget does it (packages/memory-facts-sqlite/src/purge.ts).
//
// ONE RULE, NOT TWO
//   This file has no copy of the rule. The runbook pipes self-report.ts in
//   front of it, so it deletes with the observer's own function. That's why
//   it declares `classifyAgentFact` instead of importing it, why everything
//   lives inside one function (the top-level scope is shared with that
//   file), and why there's no `#!` line (it would land mid-program).
//
// WHAT IT PRINTS
//   Exactly one line of JSON, counts only. Never a fact's value, predicate,
//   subject, id or agent key: those are people's memories, and a predicate is
//   written by a model from the chat, so it can say anything.
//     {"mode":"dry-run","examined":n,"delete":{"context":n,"own-narration":n,
//      "action-narration":n,"capability":n},"keep":{"identity":n,"other":n},
//      "ftsRows":n,"vecRows":n,"keptClosedByDeleted":n,"deleted":n,"refused":null}
//   - examined: every `extracted` row it read. A fact about anyone but the
//     assistant counts here and nowhere else.
//   - keep.identity: every predicate with an identity word in it (`name`,
//     `persona`, `style`, `rule`, `preference`, `default`, ...). That's a bit
//     wider than "its name and its rules": `renamed_file` counts here too.
//   - ftsRows, vecRows: the search rows the deleted facts have. vecRows is
//     null when there are vectors but the extension isn't loaded (no
//     --vec-extension, or a wrong one).
//   - keptClosedByDeleted: kept rows whose `closed_by` points at a row this
//     would delete.
//
// EXIT CODES
//   0  Done: a dry run, or an apply that committed.
//   2  Refused. Nothing changed.
//      Before reading anything, it prints only {"refused":"<why>"}:
//        unknown-argument    anything but --apply and --vec-extension=<path>
//        classifier-missing  self-report.ts wasn't piped in first
//        no-database-path    AX_MEMORY_FACTS_DB_PATH is unset or empty, or
//                            no file is there (it won't create one)
//      After reading, an apply prints the full line, with "deleted":0 and:
//        vectors-need-extension       vectors exist but the extension isn't
//                                     loaded, so their rows can't be deleted
//        kept-rows-closed-by-deleted  a kept row was closed by a row it would
//                                     delete, and would be left closed by a
//                                     row that no longer exists
//   1  Error. Nothing changed: the transaction rolls back. stderr gets one
//      line, `narration-cleanup: failed: <reason>`. The reason is SQLite's
//      generic error string or a code, never the error's message, because a
//      message can quote a row.
//
// WHO RUNS IT
//   Not the builder. The builder runs it only through its test
//   (packages/memory/src/__tests__/narration-cleanup.test.ts), against
//   throwaway databases. The orchestrator runs it after the deploy that ships
//   the new filter: on kind first, then on prod.
//
// RUNBOOK
//   Every command below names its context. On our machines the default one is
//   GKE prod, and that's not a surprise anyone needs today.
//
// Run it from a clean checkout of the commit the host image was built from.
// It deletes with that checkout's self-report.ts, and the host filters with
// the image's, so the two must match. On GKE, `make gke-deploy` tags the image
// with the commit's short sha, so the tag must be the start of `git rev-parse
// HEAD`. kind's image is always `ax-next/agent:dev`, so there, run
// `make image` from this checkout first.
//   KCTX=kind-ax-next-dev        # or your GKE context, for prod
//   kubectl --context "$KCTX" -n ax-next get deploy ax-next-host -o jsonpath='{.spec.template.spec.containers[*].image}'; echo
//   git rev-parse HEAD
// Prod only: the facts disk must have a recent snapshot. This exits 0 and
// prints a "newest snapshot" line for the facts disk when it does. (It also
// exits 0 when a brand-new schedule hasn't taken its first snapshot yet, so
// read that line too.)
//   bash deploy/gke/backups.sh status --context "$KCTX"
// The vector extension inside the pod (expect exactly one path):
//   VEC0=$(kubectl --context "$KCTX" -n ax-next exec deploy/ax-next-host -c host -- sh -c 'ls /opt/ax-next/host/node_modules/.pnpm/sqlite-vec-linux-*/node_modules/sqlite-vec-linux-*/vec0.so')
// Dry run (changes nothing; one line of counts):
//   cat packages/memory/src/self-report.ts packages/memory/scripts/clean-assistant-narration.mjs | kubectl --context "$KCTX" -n ax-next exec -i deploy/ax-next-host -c host -- node --input-type=module-typescript - --vec-extension="$VEC0"
// Read the counts. A null vecRows means VEC0 is wrong: stop there.
// Apply: the same line plus --apply. Then dry-run again: every "delete" count must be 0.
//
// AFTERWARDS
//   - The agent's /memory files keep showing deleted rows until its next
//     memory write re-renders them.
//   - Old "Used N memories" chips in past chats keep their text: a recall
//     receipt keeps its own copy of the rows it used.

/* global classifyAgentFact */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * The whole cleanup. Returns the exit code, and the last line sets
 * `process.exitCode` rather than calling `process.exit()`, which can cut the
 * JSON line off when stdout is a pipe through the pod.
 */
function cleanAssistantNarration() {
  const DROPPED = ['context', 'own-narration', 'action-narration', 'capability'];
  const KEPT = ['identity', 'other'];
  const VEC_FLAG = '--vec-extension=';
  const print = (report) => console.log(JSON.stringify(report));
  const refuse = (refused) => {
    print({ refused });
    return 2;
  };

  let apply = false;
  let vecExtension;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') {
      apply = true;
    } else if (arg.startsWith(VEC_FLAG) && arg.length > VEC_FLAG.length && vecExtension === undefined) {
      vecExtension = arg.slice(VEC_FLAG.length);
    } else {
      return refuse('unknown-argument');
    }
  }
  if (typeof classifyAgentFact !== 'function') return refuse('classifier-missing');
  const databasePath = process.env.AX_MEMORY_FACTS_DB_PATH;
  // Checked before opening: a read-write open of a missing path creates an
  // empty database there.
  if (!databasePath || !existsSync(databasePath)) return refuse('no-database-path');

  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: !apply, allowExtension: true });
    db.exec('PRAGMA busy_timeout = 5000');
    const hasVec =
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_facts_v1_vec'").get() !== undefined;
    let vecLoaded = false;
    if (vecExtension !== undefined) {
      try {
        db.loadExtension(vecExtension);
        vecLoaded = true;
      } catch {
        // A wrong path counts as no path: vecRows is null and an apply refuses.
      }
    }

    // An apply reads and deletes under one write lock, so nothing it counted
    // can change before it deletes. A dry run reads one consistent snapshot.
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      examined: 0,
      delete: { context: 0, 'own-narration': 0, 'action-narration': 0, capability: 0 },
      keep: { identity: 0, other: 0 },
      ftsRows: 0,
      vecRows: hasVec && !vecLoaded ? null : 0,
      keptClosedByDeleted: 0,
      deleted: 0,
      refused: null,
    };
    const doomed = new Set();
    const facts = db.prepare(
      "SELECT id, about, relation, value FROM memory_facts_v1 WHERE provenance = 'extracted'",
    );
    for (const row of facts.iterate()) {
      report.examined += 1;
      const kind = classifyAgentFact({ subject: row.about, predicate: row.relation, object: row.value });
      if (kind === null) continue;
      if (DROPPED.includes(kind)) {
        report.delete[kind] += 1;
        doomed.add(row.id);
      } else if (KEPT.includes(kind)) {
        report.keep[kind] += 1;
      } else {
        // self-report.ts grew a class this file doesn't know. Stop, don't guess.
        throw Object.assign(new Error('unknown class'), { code: 'unknown-class' });
      }
    }

    const closed = db.prepare('SELECT id, closed_by FROM memory_facts_v1 WHERE closed_by IS NOT NULL');
    for (const row of closed.iterate()) {
      if (doomed.has(row.closed_by) && !doomed.has(row.id)) report.keptClosedByDeleted += 1;
    }

    // ONE pass over the full-text table. Its `id` is UNINDEXED, so a lookup by
    // id scans the whole table, and one per deleted fact, under an apply's
    // write lock, took 5.1 s at 20,000 rows and 1,000 deletions. The live
    // host waits 5 s for that lock before a memory write fails.
    const ftsRowids = [];
    for (const row of db.prepare('SELECT rowid, id FROM memory_facts_v1_fts').iterate()) {
      if (doomed.has(row.id)) ftsRowids.push(row.rowid);
    }
    report.ftsRows = ftsRowids.length;
    // vec0 answers a lookup by its `id` primary key directly.
    const countVec =
      hasVec && vecLoaded ? db.prepare('SELECT COUNT(*) AS n FROM memory_facts_v1_vec WHERE id = ?') : undefined;
    if (countVec !== undefined) {
      for (const id of doomed) report.vecRows += countVec.get(id).n;
    }

    if (!apply) {
      db.exec('ROLLBACK');
      print(report);
      return 0;
    }

    if (hasVec && !vecLoaded && doomed.size > 0) report.refused = 'vectors-need-extension';
    else if (report.keptClosedByDeleted > 0) report.refused = 'kept-rows-closed-by-deleted';
    if (report.refused !== null) {
      db.exec('ROLLBACK');
      print(report);
      return 2;
    }

    if (doomed.size > 0) {
      // The search rows first, as purge.ts does. The rowids were read under
      // this same write lock, so they still name the same rows.
      const dropFts = db.prepare('DELETE FROM memory_facts_v1_fts WHERE rowid = ?');
      for (const rowid of ftsRowids) dropFts.run(rowid);
      const dropVec = hasVec ? db.prepare('DELETE FROM memory_facts_v1_vec WHERE id = ?') : undefined;
      const dropFact = db.prepare('DELETE FROM memory_facts_v1 WHERE id = ?');
      for (const id of doomed) {
        dropVec?.run(id);
        report.deleted += Number(dropFact.run(id).changes);
      }
    }
    if (report.deleted !== doomed.size) {
      throw Object.assign(new Error('deleted count mismatch'), { code: 'deleted-count-mismatch' });
    }
    db.exec('COMMIT');
    print(report);
    return 0;
  } catch (err) {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      // Closing the connection rolls back too. The first error is the one to report.
    }
    console.error(`narration-cleanup: failed: ${err?.errstr ?? err?.code ?? 'unknown error'}`);
    return 1;
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing left to report: the exit code is already decided.
    }
  }
}

process.exitCode = cleanAssistantNarration();
