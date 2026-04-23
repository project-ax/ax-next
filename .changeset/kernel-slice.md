---
'@ax/core': minor
'@ax/test-harness': minor
---

Initial kernel slice: `HookBus` (service + subscriber hooks), `ChatContext`, `PluginError`, `bootstrap` (manifest validation, cycle + missing-service checks), orchestration loop registered as `chat:run`, and `@ax/test-harness` with `createTestHarness` and `MockServices.basics`. Calling `chat:run` with no LLM plugin returns `{ kind: 'terminated', reason: 'no-service:llm:call' }`.
