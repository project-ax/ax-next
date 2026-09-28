/**
 * What memory correction SAYS — in one place, for every surface that offers it.
 *
 * Correcting a memory is about to show up in three places: the Memory tab
 * (`FactsMemory`), the "What I learned in this chat" block in the agent rail,
 * and the "Memory used" chip under an answer. If each of them picked its own
 * words, a person would meet "Edit" in one, "That's wrong" in another and
 * "Undo" as a row button in a third — three vocabularies for two operations —
 * and would reasonably wonder whether they do three different things. So the
 * words live here and the components render them. `decision-copy.ts` does the
 * same job for decisions; this is its sibling.
 *
 * THE VOCABULARY, which is small on purpose:
 *
 *   - **Fix** and **Forget** are the only row verbs. "Edit" is gone: it names
 *     the mechanism (change the text), where Fix names the reason a person is
 *     here (the memory is wrong).
 *   - **Undo** is never a row verb. It exists only on a receipt for something
 *     that just happened, and only for `UNDO_WINDOW_MS` — the same ten seconds
 *     an approval gets, so the app has one idea of "just happened".
 *   - History says **Replaced / Forgotten / Overridden / Retracted**. Fix
 *     asks one question — "It changed" or "It was never right" — and the
 *     answer decides which of the first and last a fixed memory gets:
 *     Replaced keeps the old version as something that used to be true,
 *     Retracted marks it as a mistake (TASK-624).
 *
 * Every string is a constant or a function of the row, never a sentence built
 * by string surgery out of another sentence. A test renders the Memory tab and
 * compares what it shows with these constants; that test is the reason this
 * file exists, and a second test scans the components so a correction string
 * cannot quietly move back inline.
 */
import { UNDO_WINDOW_MS, type FactMemoryStatement } from '@/lib/workspace-types';

// ── Row verbs ────────────────────────────────────────────────────────────────

export const MEMORY_FIX = 'Fix';
export const MEMORY_FORGET = 'Forget';

/** Each row button's accessible name carries the memory it acts on. */
export function memoryFixLabel(subject: string): string {
  return `${MEMORY_FIX}: ${subject}`;
}
export function memoryForgetLabel(subject: string): string {
  return `${MEMORY_FORGET}: ${subject}`;
}

// ── The Fix dialog ───────────────────────────────────────────────────────────

export const MEMORY_FIX_TITLE = 'Fix this memory';
export const MEMORY_FIX_FIELD_LABEL = 'What should I remember?';
export const MEMORY_FIX_HELPER =
  'Saving replaces what I remembered. The earlier version stays in History.';
/** A shared agent: the fix lands for everyone who uses it, so say so first. */
export const MEMORY_FIX_HELPER_TEAM =
  'Saving replaces it for the team. The earlier version stays in History.';
export const MEMORY_FIX_SAVE = 'Save';
export const MEMORY_FIX_SAVE_FAILED =
  'We could not save this fix. Your changes are still here.';

export function memoryFixHelper(visibility: MemoryVisibility): string {
  return visibility === 'team' ? MEMORY_FIX_HELPER_TEAM : MEMORY_FIX_HELPER;
}

/**
 * Fix's one question: did this memory change, or was it never right? The
 * answer is sent as `MemoryFixReason`; "It changed" is the default because it
 * is the common case (people move, jobs change) and the gentler claim.
 *
 * The two helpers are written as a pair on purpose. The difference between
 * the options is exactly what happens to the OLD version, so each one says
 * that and nothing else.
 */
export type MemoryFixReason = 'changed' | 'never-right';

export const MEMORY_FIX_REASON_LEGEND = 'What happened?';
export const MEMORY_FIX_REASON_CHANGED = 'It changed';
export const MEMORY_FIX_REASON_CHANGED_HELPER =
  "I'll keep the old version as something that used to be true.";
export const MEMORY_FIX_REASON_NEVER_RIGHT = 'It was never right';
export const MEMORY_FIX_REASON_NEVER_RIGHT_HELPER =
  "I'll treat the old version as a mistake, not as something that used to be true.";

/** Said once a Fix has been saved. */
export const MEMORY_UPDATED = 'Updated.';

// ── The Forget dialog ────────────────────────────────────────────────────────

export const MEMORY_FORGET_TITLE = 'Forget this memory?';
export const MEMORY_FORGET_HELPER =
  'This memory will be removed from active results. It stays in History, and past conversations do not change.';
export const MEMORY_FORGET_HELPER_TEAM =
  'This memory will be removed from active results for the team. It stays in History, and past conversations do not change.';
export const MEMORY_FORGET_FAILED = 'We could not forget this memory. Try again.';

export function memoryForgetHelper(visibility: MemoryVisibility): string {
  return visibility === 'team' ? MEMORY_FORGET_HELPER_TEAM : MEMORY_FORGET_HELPER;
}

export const MEMORY_CANCEL = 'Cancel';

// ── The receipt ──────────────────────────────────────────────────────────────

/** What the receipt leads with once a memory has been forgotten. */
export const MEMORY_FORGOTTEN = 'Forgotten';
export const MEMORY_UNDO = 'Undo';

/** The receipt's button, counting down: "Undo 9s". */
export function memoryUndoText(secondsLeft: number): string {
  return `${MEMORY_UNDO} ${secondsLeft}s`;
}

/**
 * The receipt button's accessible name. Stable while the visible text ticks,
 * so a screen reader hears what it undoes rather than a number every second.
 */
export function memoryUndoLabel(subject: string): string {
  return `${MEMORY_UNDO} forgetting: ${subject}`;
}

/** Undo worked: the memory is in effect again. */
export const MEMORY_RESTORED = 'Remembered again.';

/**
 * Undo did not work. The first clause is the fact a person needs — nothing
 * came back — so they are not left thinking it did.
 */
export const MEMORY_UNDO_FAILED =
  'We could not bring that memory back, so it is still forgotten.';
export const MEMORY_UNDO_RETRY = 'Try again';

/**
 * Whole seconds of Undo left on a receipt that started at `since`, or 0 once
 * the offer is over. The same window `ApprovalCard` counts down. Clamped to
 * the window: a clock read from before `since` must not promise "Undo 73s".
 */
export function memoryUndoSecondsLeft(since: number, now: number = Date.now()): number {
  const left = Math.min(UNDO_WINDOW_MS, UNDO_WINDOW_MS - (now - since));
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}

// ── History ──────────────────────────────────────────────────────────────────

/**
 * Every way a memory stops being the one in effect, as a History badge.
 *
 * `retracted` is a memory someone fixed with "It was never right": History
 * shows it struck through, because it was a mistake rather than something
 * that used to be true. "It changed" leaves the old row `replaced`.
 */
export type MemoryClosureKind = NonNullable<FactMemoryStatement['closure']>;

export const MEMORY_CLOSURE_BADGE: Readonly<Record<MemoryClosureKind, string>> = {
  replaced: 'Replaced',
  forgotten: 'Forgotten',
  overridden: 'Overridden',
  retracted: 'Retracted',
};

export const MEMORY_OVERRIDDEN_NOTE = ' — another memory is used instead';
export const MEMORY_REPLACED_BY_UNKNOWN = ' — Replaced by a newer memory';
export function memoryReplacedBy(value: string): string {
  return ` — Replaced by: ${value}`;
}

export const MEMORY_HISTORY_TOGGLE = 'Show history';
export const MEMORY_HISTORY_TOGGLE_HELPER =
  'Include memories that were replaced or forgotten.';

// ── Who can correct ──────────────────────────────────────────────────────────

export type MemoryVisibility = 'personal' | 'team' | undefined;

export const MEMORY_TEAM_NOTICE =
  'Memories saved with this shared agent are visible to its team. Team members can fix or forget them.';
export const MEMORY_PERSONAL_NOTICE =
  'Memories saved with this personal agent are private to you.';

// ── How a memory reads ───────────────────────────────────────────────────────

function words(v: string): string {
  return v.replace(/_/g, ' ');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function subjectText(row: FactMemoryStatement): string {
  if (row.aboutText === 'you') return 'You';
  if (row.aboutText !== undefined) return capitalize(row.aboutText);
  return capitalize(words(row.about));
}

/** "You — lives in: Boston". Every surface names a memory the same way. */
export function memoryStatementText(row: FactMemoryStatement): string {
  return `${subjectText(row)} — ${words(row.relation)}: ${row.value}`;
}

/** The profile's short form: "lives in". */
export function memorySlotText(row: FactMemoryStatement): string {
  return words(row.slot ?? row.relation);
}

// ── The "Used N memories" chip (TASK-628) ────────────────────────────────────

/**
 * The chip under an answer counts only what `memory_recall` handed the model
 * for THAT answer — not everything the agent remembers, and not what it might
 * have looked at. A row that has been closed since says how, in words that
 * match what happened to it:
 *
 *   - `retracted` — someone fixed it with "It was never right": Fixed.
 *   - `replaced` — a newer version replaced it. That is a person's "It
 *     changed" fix OR a later chat learning something new, and the chip
 *     cannot honestly tell the two apart, so it says "Updated", not "Fixed".
 *   - `forgotten` — someone forgot it.
 */
export function memoryUsedLabel(n: number): string {
  return n === 1 ? 'Used 1 memory' : `Used ${n} memories`;
}

/** Where a used memory came from. Extracted rows carry no `savedBy`. */
export function memoryUsedSource(row: FactMemoryStatement): string {
  if (row.savedBy === 'person') return 'Saved by a person';
  if (row.savedBy === 'agent') return 'Noted by the agent';
  return 'From a chat';
}

/** "Saved by a person · Sep 1, 2026"; just the source when there is no date. */
export function memoryUsedDetail(row: FactMemoryStatement, date: string): string {
  const source = memoryUsedSource(row);
  return date === '' ? source : `${source} · ${date}`;
}

export type MemoryUsedSinceKind = 'replaced' | 'forgotten' | 'retracted';

export const MEMORY_USED_SINCE: Readonly<Record<MemoryUsedSinceKind, string>> = {
  replaced: 'Updated since this answer',
  retracted: 'Fixed since this answer',
  forgotten: 'Forgotten since this answer',
};

// ── "What I learned in this chat" — the rail block (TASK-627) ───────────────

export const LEARNED_TITLE = 'What I learned in this chat';

/** The header badge while rows the person has not seen are listed. */
export function learnedNewBadge(count: number): string {
  return `${count} new`;
}

/** The rail toggle's accessible name while there are unseen rows (mobile). */
export function learnedToggleLabel(count: number): string {
  return `Agent details, ${count} new ${count === 1 ? 'memory' : 'memories'}`;
}

/** Said once per batch to a screen reader, politely. */
export function learnedAnnouncement(count: number): string {
  return `Learned ${count} ${count === 1 ? 'thing' : 'things'} from this chat.`;
}

export const LEARNED_EARLIER = 'Earlier in this chat';
export const LEARNED_FROM_YOUR_MESSAGE = 'from your message';

/** When a live batch landed. Whole minutes and hours; never a date. */
export function learnedAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

export function learnedMore(count: number): string {
  return `+${count} more from this chat`;
}
export const LEARNED_SEE_ALL = 'See all memory →';

/** Before the first read lands. Not one of the six: it is gone in a moment. */
export const LEARNED_LOADING = 'Checking what I’ve picked up from this chat…';

// The six states. Each one says which state it is: an empty list is a claim.
export const LEARNED_NOTHING_NEW = 'Nothing new to remember from this chat yet.';
export const LEARNED_EXTRACTING = 'Reading over your last few messages…';
export const LEARNED_PAUSED =
  "Memory's paused, so I'm not saving anything from this chat right now. An admin can switch it back on under Admin → AI model keys.";
export const LEARNED_PAUSED_ACTION = 'Fix this';
/**
 * No "retry now" button: nothing can retry a pass on demand yet, and the next
 * pass re-reads the same messages on its own (TASK-626's held cursor). A
 * button here would promise something no route does.
 */
export const LEARNED_SAVE_FAILED =
  "I couldn't save anything from your last few messages. Nothing's lost — I'll try again on my own in a little while.";
export const LEARNED_READ_FAILED =
  "I can't show what I've learned here just now. That means unknown, not empty — try reloading.";
export const LEARNED_READ_FAILED_ACTION = 'Try again';
export const LEARNED_NOT_ENABLED =
  "This workspace doesn't keep memory yet. Ask your workspace admin about switching it on.";
