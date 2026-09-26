export { createMemoryPlugin } from './plugin.js';
export type { MemoryPluginConfig } from './plugin.js';
export {
  MEMORY_RECALL_HOOK,
  MEMORY_REMEMBER_HOOK,
  MEMORY_FORGET_HOOK,
  FACTS_RECALL_HOOK,
  FACTS_RECORD_HOOK,
  FACTS_SUPERSEDE_HOOK,
  CHAT_END_HOOK,
  DEFAULT_MEMORY_OPS_MODEL,
  DEFAULT_OBSERVER_TIMEOUT_MS,
} from './plugin.js';
export {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_MODEL_ID,
  EXTRACTION_PROMPT_FINGERPRINT,
  EXTRACTION_PROMPT_MODEL_FINGERPRINT,
  buildExtractionPrompt,
  extractionFingerprint,
  extractionPromptShape,
} from './extraction-prompt.js';
export {
  NO_CREDENTIAL_EVENT,
  NOTE_FAILED_EVENT,
  OBSERVER_FAILED_EVENT,
  OBSERVER_RUN_EVENT,
  isMissingCredential,
  memoryFailureEvent,
} from './failure.js';
export { SPEAKER_SUBJECT, rewriteSpeaker } from './subject.js';
// `SLOT_SYNONYMS` and `relationToWords` are deliberately NOT re-exported:
// they are how `deriveSlot` is implemented, no consumer outside this package
// exists, and the in-package tests import them from `./slots.js` directly.
//
// `SLOTS` is ALSO the injected profile's whitelist (design §4.1) — the same
// constant, not a copy. `augment.ts` imports it rather than keeping a
// `PROFILE_SLOTS` of its own, and `scripts/__tests__/slot-vocabulary-single-owner.test.js`
// is the guard that fails if a second copy appears.
export { SLOTS, PENDING_SLOT, deriveSlot } from './slots.js';
export type { Slot } from './slots.js';
export { selectProfileRows } from './profile.js';
export type { ProfileRow } from './profile.js';
export {
  escapeStatementText,
  approxTokens,
  renderNotedAt,
  formatDay,
  formatMonthYear,
  MAX_VALUE_CHARS,
} from './render.js';
export {
  SYSTEM_PROMPT_AUGMENT_HOOK,
  RULES_READ_HOOK,
  buildMemoryBlock,
  assembleUnderCap,
  rankDigestSubjects,
  registerSystemPromptAugment,
  DEFAULTS as MEMORY_BLOCK_DEFAULTS,
} from './augment.js';
export {
  RULES_WRITE_HOOK,
  MAX_RULES_CHARS,
  registerRulesHooks,
} from './rules.js';
export type {
  MemoryRulesReadInput,
  MemoryRulesReadOutput,
  MemoryRulesWriteInput,
  MemoryRulesWriteOutput,
} from './rules.js';
export type {
  MemoryBlockConfig,
  SystemPromptAugmentInput,
  SystemPromptAugmentOutput,
  BlockPart,
  AssembledBlock,
} from './augment.js';
export { resolveOwnerUserId } from './owner.js';
export type { MemoryExportConfig } from './exporter.js';
export { MEMORY_EXPORT_FLUSH_HOOK } from './exporter.js';
export {
  MEMORY_MOUNT_PATH,
  validateVolumeConfig,
  volumeAgentKey,
} from './export-volume.js';
export type { MemoryVolumeConfig } from './export-volume.js';
export {
  MEMORY_RECALL_DESCRIPTOR,
  MEMORY_RECALL_TOOL_HOOK,
  registerMemoryRecall,
} from './recall-tool.js';
export {
  MEMORY_NOTE_DESCRIPTOR,
  MEMORY_NOTE_TOOL_HOOK,
  registerMemoryNote,
} from './note-tool.js';
export type { MemoryNoteInput, MemoryNoteResult } from './note-tool.js';
export {
  formatEvidenceWhen,
  relativeTime,
  renderEvidenceTable,
  renderRecallResult,
} from './evidence.js';
export { DEFAULT_RECALL_LIMIT } from './types.js';
export type {
  MemoryStatement,
  MemoryStatementKind,
  MemoryRecallInput,
  MemoryRecallOutput,
  MemoryRememberInput,
  MemoryRememberOutput,
  MemoryForgetInput,
  MemoryForgetOutput,
} from './types.js';
