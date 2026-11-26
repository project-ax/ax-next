---
'@ax/core': minor
'@ax/conversations': minor
'@ax/ipc-core': patch
'@ax/chat-orchestrator': patch
'@ax/session-inmemory': patch
'@ax/session-postgres': patch
---

Three fixes for the moment an agent restarts its sandbox to start dev services. A message the agent answered as part of the reply it was already writing no longer leaves a spinner going after the restart. A message waiting for the old sandbox can't be picked up there once it has moved, and the old sandbox is cut off straight away instead of after its network closes. And a restart, or a sandbox that took a while to start, no longer takes the conversation back from a newer message that already has its own sandbox.
