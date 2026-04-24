# @ax/llm-anthropic

Plugin that registers the `llm:call` service hook and routes it through `@anthropic-ai/sdk`.

## Config

```ts
import { createLlmAnthropicPlugin } from '@ax/llm-anthropic';

createLlmAnthropicPlugin({
  model: 'claude-sonnet-4-6',      // optional; default claude-sonnet-4-6
  maxTokens: 4096,                  // optional; default 4096
});
```

`ANTHROPIC_API_KEY` must be set in the process env at plugin `init()` time. The plugin throws `PluginError({ code: 'init-failed' })` with a no-key-leak message if it's missing.

## Error handling

- Transient HTTP errors (429, 500, 502, 503, 504) are retried once with a 1 s delay.
- Any other error surfaces as `PluginError({ code: 'unknown', hookName: 'llm:call' })` with the API key string redacted from the message (`<redacted>`). The original SDK error is preserved on `err.cause` for debugging but excluded from `toJSON()` output to keep logs clean.
- No dynamic-import / fixture / env-var test backdoors. Tests inject via the `clientFactory` config option.

## Manual smoke

There's a one-shot script at `scripts/smoke.ts` that makes a real call against `api.anthropic.com`. Run it once per PR that touches this package — it's NOT wired into CI.

```bash
ANTHROPIC_API_KEY=<your-key> \
  node --import tsx/esm packages/llm-anthropic/scripts/smoke.ts
```

Exits 0 on success. Do not capture and commit the output.

## Security

See `SECURITY.md` for the supply-chain audit, pinned SDK version, and boundary review.
