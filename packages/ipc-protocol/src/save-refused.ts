import { z } from 'zod';

/**
 * Why the host refused a workspace save (TASK-720, TASK-731). A closed set of
 * machine codes, never prose: the client words them. Runner-reported and
 * therefore UNTRUSTED, which is fine: the worst a lying runner can do is pick
 * which of three fixed sentences the person sees.
 *   - `storage-full`: the person's storage limit refused the save.
 *   - `too-large`: one save was over the per-save size cap.
 *   - `refused`: any other refusal (a validator veto, an author check).
 * Shared by `event.turn-end` (a per-turn save) and `event.chat-end` (the
 * final/idle flush), so the two can never drift apart.
 */
export const SaveRefusedCodeSchema = z.enum(['storage-full', 'too-large', 'refused']);
export type SaveRefusedCode = z.infer<typeof SaveRefusedCodeSchema>;
