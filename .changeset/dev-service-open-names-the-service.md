---
'@ax/core': minor
'@ax/sandbox-protocol': minor
'@ax/sandbox-k8s': patch
'@ax/chat-orchestrator': patch
---

A dev service that won't start now tells you which one and why, instead of "The agent stopped unexpectedly." The sandbox waits as long as its own startup budget allows (2 minutes per service, so a slow JVM stack gets its time) and cleans up the moment it gives up. A service that runs but never becomes ready, or whose image can't be pulled, is named too. The agent hears about it at its next turn, so it can explain instead of retrying blind.
