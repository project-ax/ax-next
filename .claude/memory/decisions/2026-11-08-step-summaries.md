# 2026-11-08 — Step titles summarize reasoning (Vinay)

- **Decision:** live step titles are one-line summaries of the agent's reasoning, matching Claude's ("Planning an animated SVG of a pelican cycling."). They come from `@ax/step-summaries`: a host plugin that watches `chat:stream-chunk`, uses the fast model, and emits a `step-summary` chunk plus a display event keyed by the call id.
- **Why:** the user chose this over Bash `description` or prompting the agent to narrate, to match Claude.
- **J4 still holds:** raw reasoning never reaches the workspace. Only the validated summary line does.
- Measured on prod (7 days to 11-08): 304 of 406 assistant lines had reasoning (average about 1,650 characters), and 267 had reasoning followed by a tool call. Reasoning is stored as `"type":"reasoning"` in `conversations_v1_transcripts.line`.
