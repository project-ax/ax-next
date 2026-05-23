# Findings report format

Emit this at the end of the sweep. Keep it plain and factual — when something is broken,
say so with the evidence. Fill every row; "didn't get to it" is itself a result (`SKIP`
with a reason), not a blank.

---

## 1. Header

```text
# chat-qa-sweep — <date> — <git sha / branch under test>
Cluster: ax-next-dev (kind)   Image: <tag>   Agent under test: <name/id>
Summary: <N> PASS · <N> GLITCH · <N> FAIL · <N> SKIP
```

## 2. Results table

One row per scenario (15 happy-path + 4 fault). Result ∈ `PASS` / `GLITCH` / `FAIL` /
`SKIP`. Evidence = a concrete pointer (snapshot/screenshot ref, network status code, the
console line). UI surface = which component proved it (or, for a FAIL, which one *should*
have shown the error but didn't).

| # | Scenario | Category | Result | Evidence | UI surface |
|---|----------|----------|--------|----------|------------|
| 1 | New chat | happy | | | |
| 2 | Always a response | happy | | | |
| 3 | npx command | happy | | | |
| 4 | Use a skill | happy | | | |
| 5 | Upload attachment | happy | | | |
| 6 | Download attachment | happy | | | |
| 7 | Artifact creation | happy | | | |
| 8 | Load old session + continue (deep) | happy | | | |
| 9 | Title generation | happy | | | |
| 10 | Parallel sessions | happy | | | |
| 11 | Cancel / stop streaming turn | happy | | | |
| 12 | Rapid double-submit race | happy | | | |
| 13 | Hostile input | happy | | | |
| 14 | Error-presentation sanity (/error) | happy | | | |
| 15 | Glitch sweep (aggregate) | happy | | | |
| A | Sandbox killed mid-session | fault | | | |
| B | Host killed mid-session | fault | | | |
| C | LLM provider error | fault | | | |
| D | Temporary network error | fault | | | |

## 3. Glitch log

Every GLITCH and FAIL gets an entry — the table is the index, this is the detail:

```text
### [FAIL] #8(c) — old attachment chip not downloadable on reload
Symptom:   clicking the reconstructed AttachmentChip did nothing.
Evidence:  screenshot reload-08.png; browser_network_requests shows no fetch on click;
           console: "TypeError: Cannot read properties of undefined (reading 'url')".
Expected:  click → GET /api/.../attachment → file download (worked live in #6).
Scope:     read-path chip reconstruction (conversations:get), not the live-turn path.
Hand-off:  candidate for k8s-acceptance-loop to fix; add a regression test on the
           read-path chip download.
```

## 4. Cluster-restored checklist

Copy the checklist from `fault-injection.md` and tick each, so the report proves the
cluster was left clean:

- [ ] A — normal message works (sandbox respawns)
- [ ] B — host Ready, port-forward alive, session reloads
- [ ] C — **real Anthropic key restored**, normal message succeeds
- [ ] D — port-forward alive, /health 200
- [ ] Final clean end-to-end message + response, no console errors

If any box can't be ticked, say so at the **top** of the report — a dirty cluster is the
most important thing for the reader to know.

## 5. Triage summary

For each non-PASS, one line: **real bug** vs **environment/test-setup**, and where it goes
next.

```text
- #8(c) FAIL  → real bug (read-path chip download). Hand to k8s-acceptance-loop + regression test.
- #4 SKIP     → environment (no skill attached to the test agent). Re-run after attaching one.
- C  GLITCH   → real bug (provider error shows raw stack instead of friendly Alert copy).
```

Close with a one-sentence verdict: is the chat UI shippable as-is, or are there FAILs that
block?
