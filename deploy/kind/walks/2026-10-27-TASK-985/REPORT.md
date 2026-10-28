# Agent Tasks PR 5 acceptance — TASK-985

**PASS**, 2026-10-27 local time (2026-10-28 UTC). This completes PR 5's kind acceptance after merged #1066, #1068, #1070 and #1071. Email, sharing and “Also ask” remain deferred. No production deployment was performed.

## Tested runtime

- Source: `f9290b121e40a89312546706d6c6979b88d9a325`, merged #1071.
- Cluster: explicitly `kind-ax-next-dev`; namespace `ax-next`; Helm revision 28.
- Image: `ax-next/agent:task985-f9290b121`. The loaded OCI revision equals the source. Host/runner use this image, without a development mount.
- Digests of the live routines, contract, orchestrator and SPA bytes match the built image, before and after the host restart. See [proof.json](proof.json).
- Three paused schema 19 fixtures (Repeat, Stay on top, Get done) were created before upgrade. Schema 20 preserved their owners, revisions, schedules, signature settings, addresses and explicitly staged legacy aliases. Original kind secret hashes were unchanged throughout.

## Results

| Scenario | Evidence |
| --- | --- |
| Durable FIFO, batching and full read | 21 signed Stay-on-top updates persisted before acknowledgement. First entry exceeded 4096 bytes. A delivery-ID retry returned 202 without another row. The receiver started no run before its 60-second response target. Two real runner check-ins consumed 20 then 1; a follow-up burst used a random tail marker absent from the prompt and also drained 20+1. Structural transcript checks found 20 assistant read-tool calls with 20 paired results; exactly one successful result contained that marker, which was then quoted in report notes. No address or signing secret reached the runner. |
| Task kinds and signatures | Repeat completed its ordinary custom/GitHub-signed job. Get done accepted Stripe input and reported. A member's Stay-on-top task accepted Zendesk input and reported. Slack's authenticated address verification returned its challenge without queueing a run or claiming accepted input; a subsequent signed Slack event was admitted. Bad signatures were refused and counted. |
| Legacy URLs and replacement | Existing signed aliases worked after upgrade. Browser Copy matched the saved address; cancel preserved it. Confirmed replacement revoked both the old task address and its legacy alias. Another task's legacy delivery still returned 202 and deduplicated. Work accepted before replacement still reported. |
| Missing report and retry | An intentionally contradictory no-tool brief produced a first check-in without a report. Its update remained unseen and was released for retry. The real scheduler's second check-in reported and consumed the same input. No manual repair was needed. The report capability was available in routine context; a missing-capability assumption in an early driver was discarded. |
| Restart, serialization and idempotency | A real Bash `sleep 75` held a task check-in open. Another event was accepted; manual Check now returned 409; a reply returned `queued`. During the host rollout there was at most one active dispatch. One later attempt was interrupted by the restart, its session binding was cleared, and a subsequent check-in consumed the remaining update. Accepted/completed timestamps prove no overlap. Retrying the queued reply after restart and after completion returned `replayed`, with no new run or wake intent. |
| Response, work hours and safety | First-arrival response target was exactly 60 seconds. Work hours 03:00–04:00 UTC deferred a night-time event to 03:00; manual reconciliation remained available. Every measured full-check deadline was exactly 3600 seconds after actual acceptance. A real scheduler tick ran a safety check with no pending app input and reset that deadline again. |
| Connection status and retention | Waiting/connected/signature/last-accepted states appeared in the live browser. Failed signature tests never claimed connected. Status reads were no-store. Refusal counts survived restart. A controlled 503 cleared old UI status, hid provider details and recovered on retry. Expired counts disappeared immediately from reads and were physically pruned by the existing scheduler. |
| Repeat limits | 38 sequential signed attempts produced 35 durable deliveries: 3 active and 32 waiting. The next 3 were 429, all counted as capacity refusals. Replaying an accepted delivery at capacity still returned 202. The fixture was paused after the probe; queued fixture work was explicitly cancelled during cleanup. |
| Creator billing and privacy | Member-created work ran and recorded its session as that member. Its own usage bucket recorded 1 turn and 38851 cost-micros. Team admin reads of its detail/setup/status were 404; a peer could not read personal setup or the full-read transcript. The admin's browser dropped the old private setup when navigating to a forbidden task; the member could open their own task and setup. |
| Approvals | A real chat tool call requested `routine_create`. The browser showed Allow once / Always Allow / Decline, with no task row created beforehand. Decline created nothing and granted no standing consent. |
| Desktop/mobile | 1280 px and 390 px live pages passed Copy/Replace/Cancel, response 2m Save/reopen, required safety schedule, signing preset, refusal/retry, ownership and report views. No horizontal overflow or squeezed secret action. Final success pass had no page or console errors; the controlled 503 and privacy 404 were expected probes. |

## Fixture acceleration and driver notes

These were real HTTP, PostgreSQL, scheduler, runner and browser paths. To avoid waiting an hour, only an owned fixture's stored safety due time was moved five seconds ahead; its configured interval remained 1h. Only that fixture's refusal bucket timestamps were aged to exercise expiry. The report distinguishes those injections from the independently verified timer calculations.

Legacy aliases were explicitly staged on the three disposable schema 19 rows before upgrade. This walk verifies their continuity and task-local revocation; the implementation's earlier migration tests cover the original pre-18 backfill.

An attempted force-delete found the old host already gone and changed nothing. The actual restart evidence comes from the rollout, interrupted-run record, cleared session, persisted receipt and subsequent reporting run. A first browser controller used a canonical terminal and stalled on a long command; restarting the controller in raw input mode resolved that driver issue. Neither required a product change. The initial full-read substring check could also match the brief; the follow-up replaced it with assistant tool-use/result pairing and a marker absent from all prompt text. Both follow-up runner reports and cleanup passed.

## Cleanup

Removed only the walk's 4 agents, 8 authored tasks (and their materialized defaults), 3 accounts, 1 team and 10 owned runner pods, including the narrow full-read follow-up. Task definitions, queue/dispatch/session rows and cleanup jobs for those agents are zero. Fixture usage rows were removed. The private fixture manifest was deleted, browsers and the owned forward closed.

Original user/agent/task counts, definition fingerprint and all 72 preexisting request receipts are unchanged. Existing Kubernetes secret hashes match the baseline. Credential deletion leaves the implementation's encrypted-empty tombstones: 12-byte IV plus 16-byte tag, with zero ciphertext. There is no remaining signing-secret payload; older tombstones were preserved. No raw values, cookies, signing keys, bearer URLs or exported Helm values are included in these artifacts.

## Screenshots

- [Waiting for first update](desktop-waiting.png)
- [Connected and accepted](desktop-connected.png)
- [Stripe preset and required safety schedule](desktop-editor-stripe.png)
- [Live approval gate](desktop-approval.png)
- [Team admin's private-task 404](desktop-admin-private-task404.png)
- [Mobile FIFO result and counted refusal](mobile-fifo-connected.png)
- [Mobile retryable status error](mobile-retryable-status.png)
- [Mobile address replacement](mobile-setup-replaced.png)
- [Member's report](mobile-member-report.png)

All bearer inputs in screenshots are masked.
