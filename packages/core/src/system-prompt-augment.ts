import { z } from 'zod';

// ---------------------------------------------------------------------------
// System-prompt contributions (W1, `docs/plans/2026-10-12-w1-prompt-contributions-design.md`).
//
// Any plugin may add a block to an agent's system prompt by registering ONE
// service whose name starts with one of the two prefixes below. The
// orchestrator finds them with `bus.listServices()`, calls them in parallel,
// and owns ordering, the deadline and validation. Providers never see each
// other's output.
//
// - Required (`…:required:<name>`): may return `rules`. If it fails (throws,
//   misses the orchestrator's deadline, or returns invalid output) the WHOLE
//   augment is skipped for that spawn — context without the Rules that govern
//   it is the worst outcome. Register as required only if you carry `rules`.
// - Optional (`…:optional:<name>`): `brief`, `context` and `recall`. A failure
//   drops just this provider's blocks.
//
// Sections set the order: `rules`, `brief`, `context`, then `recall`; within a
// section, by service name. Only `rules` and `brief` reach bootstrap mode.
//
// `rules` is for text a person wrote that no agent can change. `brief` is what
// this session is for, built only from what people wrote plus the provider's
// own fixed text, and no agent can change any of it: a task's name, what to do
// and going well when, which change only with the person's yes, even under
// Always Allow. It reaches bootstrap mode so a check-in run by an agent still
// in its first-run chat knows what it is for. `context` and `recall` may carry
// agent- or third-party-written text, and the provider frames it as
// information, never as instructions or as another section.
//
// Lives in the kernel because the providers and the orchestrator must share
// one definition, and plugins may not import each other (invariant 2).
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT_AUGMENT_REQUIRED_PREFIX = 'system-prompt:augment:required:';
export const SYSTEM_PROMPT_AUGMENT_OPTIONAL_PREFIX = 'system-prompt:augment:optional:';

/**
 * Any single body longer than this makes a provider's result invalid. About 8k
 * tokens — ten times memory's whole cap — so one provider can't crowd out the
 * conversation. Checked by the orchestrator, not by the schema, so the failure
 * is reported as `too_large` rather than as a generic schema error.
 */
export const SYSTEM_PROMPT_AUGMENT_MAX_BODY_CHARS = 32_000;

/** The input carries nothing; providers read `ctx` (userId, agentId, …). */
export type SystemPromptAugmentInput = Record<string, never>;

/**
 * One provider's result: at most one body per section. Strict — an unknown
 * key is invalid, not ignored. Providers should register this as their
 * `returns` schema; the orchestrator validates every result again regardless,
 * because `returns` is optional on the bus.
 */
export const SystemPromptAugmentOutputSchema = z
  .object({
    rules: z.string().optional(),
    brief: z.string().optional(),
    context: z.string().optional(),
    recall: z.string().optional(),
  })
  .strict();

export type SystemPromptAugmentOutput = z.infer<typeof SystemPromptAugmentOutputSchema>;

// ---------------------------------------------------------------------------
// `chat:system-prompt-landed` (TASK-908). Fired by the orchestrator on the
// fresh-spawn path right after the augment is built and before any proxy or
// sandbox session opens. `providers` holds the full service names of the
// providers whose step succeeded AND returned at least one non-empty body, in
// plain code-unit order; it is `[]` when a failed required provider suppressed
// the augment and when nothing landed. A subscriber may veto, and the turn then
// ends `terminated` with `system-prompt:<reason>`. A subscriber keys off
// provider names it owns and never parses another's. Parsed leniently: an
// unknown key is dropped, never refused, so an additive field can't break
// subscribers.
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT_LANDED_HOOK = 'chat:system-prompt-landed';

export const SystemPromptLandedPayloadSchema = z.object({
  reqId: z.string().min(1),
  providers: z.array(z.string()),
});

export type SystemPromptLandedPayload = z.infer<typeof SystemPromptLandedPayloadSchema>;
