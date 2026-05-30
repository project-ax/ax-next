// out-of-git Part D2: @ax/skills now stores bundle EXTRA files in the shared
// blob store (hard-deps blob:put/blob:get), so any harness that boots
// createSkillsPlugin() must provide a blob backend. Re-export the shared
// content-addressed in-process fake from @ax/test-harness (single source of
// truth — same helper @ax/agents + @ax/channel-web tests use).
export { mockBlobStoreServices as blobStoreFakeServices } from '@ax/test-harness';
