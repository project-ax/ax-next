---
"@ax/credential-proxy": minor
"@ax/ipc-protocol": minor
"@ax/ipc-core": minor
"@ax/agent-runner-core": patch
---

When someone allows a website the agent was blocked from, the agent now finds out. The next message in that conversation's live session starts with a short system line saying the site is allowed, so the agent can try again. Before, the block message told it that retrying would never help, and nothing ever took that back, so it politely refused to try a site we had just said yes to.

The Allow still lasts only for that session. Whether it should last longer is a separate question.
