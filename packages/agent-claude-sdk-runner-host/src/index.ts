// TASK-75 (2026-05-30): the `parseJsonlToTurns` runtime export was removed —
// its only consumer was conversations:get's git-jsonl transcript read, deleted
// in TASK-66/70 when the display-event log + transcript-row store became the
// source of truth. The parser still lives in `./parse.js` (with its own tests)
// and can be re-exported if a future consumer earns it. The `ParsedTurn` types
// remain re-exported as the package's public transcript-shape contract.
export type { ParsedTurn, ParsedTurnRole } from './parse.js';
