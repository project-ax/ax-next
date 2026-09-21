/**
 * Speaker rewrite — design §3.2.
 *
 * The extractor canonicalizes whoever is talking as the literal subject
 * `user`. The store is keyed by `agentId` ALONE (one agent, one memory), so
 * left as-is that collapses every person who talks to a team agent into one
 * subject: `lives_in` would close each time a different person said where
 * they live, and each of them would read the last one's answer as their own.
 *
 * So at record time the speaker becomes `user:<userId>`, and at recall time
 * the same rewrite runs on `about` — otherwise a read would look for a
 * subject no write ever stored. One function, both directions, which is the
 * point: the write key and the read key cannot drift apart if they are
 * computed by the same code.
 *
 * `@ax/decisions` uses the same shape for the same reason.
 */

/** The literal subject the extraction prompt emits for whoever is speaking. */
export const SPEAKER_SUBJECT = 'user';

/**
 * Rewrite the canonical speaker subject to the per-person one.
 *
 * Only the EXACT literal `user` is rewritten. `about` is free text carrying
 * model output, and a broader rule (prefix match, case folding, trimming)
 * would start rewriting subjects that merely look like the speaker — a
 * `user:bob` arriving from an extractor would become `user:bob:<userId>` under
 * a prefix rule, and the subject of a statement about "User Research" would be
 * mangled under a case-folding one. Narrow and literal is the safe direction:
 * a missed rewrite can collapse two team members into one subject, while an
 * over-eager one corrupts a subject key permanently.
 *
 * Note this is NOT an access-control boundary. A caller can still write any
 * `about` it likes, including `user:someone-else`. What limits where that
 * row lands is `resolveMemoryAccess`: on a personal agent only the owner
 * ever reads it; on a team agent it is shared knowledge and a
 * `user:someone-else` subject is visible to teammates as written — so the
 * rewrite must stay per-CALLER (`user:alice` and `user:bob` never collapse
 * into one speaker). Subject naming is organization; `agents:resolve` is the
 * barrier.
 */
export function rewriteSpeaker(about: string, userId: string): string {
  return about === SPEAKER_SUBJECT ? `${SPEAKER_SUBJECT}:${userId}` : about;
}
