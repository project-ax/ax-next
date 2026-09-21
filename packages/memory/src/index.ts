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
  OBSERVER_FAILED_EVENT,
  OBSERVER_RUN_EVENT,
  isMissingCredential,
  memoryFailureEvent,
} from './failure.js';
export { SPEAKER_SUBJECT, rewriteSpeaker } from './subject.js';
export { resolveOwnerUserId } from './owner.js';
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
