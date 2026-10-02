# Spend control follow-ups (TASK-716, TASK-722)

The Usage settings now include a rolling 24-hour workspace cap, per-person
overrides, and model price overrides. The workspace cap defaults to $100.
Per-person defaults stay at $5 per 24 hours and 60 messages per hour. Existing
saved settings inherit the workspace cap until an admin changes it.

## Accounting and enforcement

Spend is the sum, across people, of `max(runner, proxy) + helpers`. Taking
the larger ledger avoids counting a normal agent request twice while still
counting requests made directly by sandbox code. The workspace total includes
people outside the admin view's 200-row display limit.

New turns stop at a person's cap or the workspace cap. Host helper calls use
the read-only `usage:check` service and stop at either cap, or on suspension.
The proxy allows an existing task to reach twice the person's effective cap
before refusing its next provider request. The workspace cap applies at 1x.
This is a circuit breaker, not a reservation system: requests already running
can finish and add spend. The proxy caches verdicts for up to 15 seconds, and
settings refresh across hosts within 15 seconds. Neither cap promises an exact
final bill.

Per-person overrides replace only the supplied daily/hourly fields; clearing
them restores workspace defaults. They never raise the workspace allowance.
Model prices use exact normalized model references, with known Anthropic and
OpenRouter prefixes ignored and other vendor namespaces preserved. All four
rates are USD per million tokens, in increments of $0.01. Changes affect future
records. Unknown models and unreadable responses keep conservative pricing.

Admission persists a turn marker. An interrupted or failed admitted turn that
has not reported usage receives the configured assumed cost, once. Repeated
terminal events and refusals before admission add nothing. Normal IPC reports
use the original turn ID in their payload rather than the IPC request ID;
decision continuations use that same ID at their admission gate. If interruption
wins a race with a late normal report, the assumed charge remains. The proxy's
larger measured total still takes precedence.

The account menu reads `/api/usage` for the authenticated person only. It shows
estimated spend against their effective allowance and messages in the last
hour. Read failures show an unavailable state with Retry.

## Kill switch policy

Keep the existing separation between model access and human authorization.
Pausing a person blocks new model calls and attempts to interrupt running
tasks. It does not revoke a tool action that a person already approved. A host
replay of that action may finish even when the agent's subsequent model turn
is refused. Revoking approved actions would need a separate authorization
control. The Usage tab states this policy; the existing decisions canary
already verifies it.

## Production acceptance, October 2, 2026

Vinay authorized the bounded checks in this session. They ran against deployed
image `dea6d4c8`, using a disposable user and two personal AI SDK agents:
Anthropic Haiku 4.5 and OpenRouter DeepSeek V4.1 Flash.

- Both normal chat turns completed with `OK`. The first Anthropic turn recorded
  5,970 micro-USD in each ledger. The first OpenRouter turn recorded 90,465
  micro-USD in each ledger. These are the deployed conservative estimates.
- One direct streaming inference request per provider used a 16-output-token
  ceiling. Anthropic completed with usage counters. OpenRouter returned six
  parsed events and counters of 36 input and 16 output tokens.
- After both direct probes, cumulative proxy usage exceeded runner usage by
  exactly 1,773 micro-USD: 33 for the Anthropic probe and 1,740 for OpenRouter
  under the deployed fallback price. The direct requests are counted.
- The OpenRouter read-only `/api/v1/auth/key` request returned 401. Anthropic's
  read-only `/v1/files?limit=1` request returned 404, including with the Files
  beta header. The proxy audit recorded `credentialInjected: false` for both
  negative probes. Anthropic's model-list endpoint is explicitly allowlisted
  for the Claude client and is unsuitable as a negative probe.
- The first attempt to deliver the script through a model-generated encoded
  command was corrupted before it made any network request. The operator then
  installed the exact script in the disposable runner and asked it to execute
  the short fixed command. No inference probe was retried.
- Both disposable agents, their conversations and sessions, the temporary
  authentication session and user were removed. Database checks returned zero
  remaining fixture rows, and no fixture sandbox claims remained. Usage and
  audit records remain as evidence of the real spend.

`scripts/provider-metering-live-probe.py` collects the same limited evidence.
Run it only inside an operator-approved disposable sandbox with the normal
placeholder credential, proxy, and CA configuration. Install the exact file
through the operator channel; avoid asking a model to transcribe encoded code.
A 404 requires the proxy audit to confirm no credential injection; status
alone cannot establish that. `--non-inference-only` repeats just the read-only
check. The script prints counters and statuses, never keys or response data.

## Hook boundary review

- Alternate implementation for `usage:check`: an in-memory allowance service
  for an embedded host, or a remote organization budget service.
- Payload field names that might leak: none. Input is empty; identity comes
  from `AgentContext`. Output is `{ blocked, reason? }`.
- Subscriber risk: this is a service call, not a notification. Consumers use
  stable refusal codes without relying on a database or provider transport.
- Wire surface: no new IPC action. HTTP schemas live in `usage-limits`.

## Security review

- Sandbox: no new sandbox capability or key reach. The helper gate narrows
  existing provider access. The probe uses fixed HTTPS destinations, fixed
  credential variable names, stdin curl configuration, the configured CA,
  and bounded output/time limits. It exposes no handles through hooks.
- Injection: runner/provider counters remain untrusted and bounded. Turn IDs
  and admin model references are parameterized in SQL; prices and overrides
  are validated, bounded and admin-only. Personal usage derives identity from
  the session. React renders model/user strings as text. A shell fragment in
  a model reference fails validation and is never executed.
- Supply chain: N/A: no package manifests, lockfile entries, or dependencies
  changed. The probe uses Python's standard library and existing sandbox curl.
