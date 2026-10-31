// ---------------------------------------------------------------------------
// @ax/validator-identity — the `identity:scan` service (TASK-989): the
// write-time check on an agent's identity, soul and Instructions. @ax/agents
// stores them and calls this on every write, from the agent's own
// `update_identity` tool and from people's editors alike, and refuses the write
// on anything but `clean` (it also fails closed when this service is missing or
// throws). The text is frozen into the session config at spawn and composed
// VERBATIM into the system prompt, so this scan is the prompt-injection gate on
// it. The check is `scanIdentityText` in identity-safety-scan.ts: no I/O, no
// bus calls; the one side effect is an `identity_scan_refused` log line
// carrying the category only. A refusal is an ANSWER, not a throw; only a
// malformed payload throws. The payload is `{ text, kind? }`:
// `kind: 'instructions'` (people's Instructions) skips only the weak
// egress-near-secret heuristic; absent or `'self-description'` (identity, soul)
// is the full check.
//
// Until TASK-995 this plugin also gated the agent's writes to its identity
// FILES in the git workspace: a veto on that tier's pre-apply event, with a
// bootstrap window read back from the workspace and a byte-exact check on the
// bootstrap script. The runner stopped reading those files in TASK-989, and the
// git tier is gone, so the gate went with it. A file by one of those names in
// the agent's home is an ordinary file: nothing composes it into a prompt (the
// runner's agent-files canary plants one and checks).
//
// Capability budget: registers `identity:scan` (pure). NO spawn, NO file I/O,
// NO network, NO bus calls. See SECURITY.md.
// ---------------------------------------------------------------------------

import type { Plugin } from '@ax/core';
import { PluginError } from '@ax/core';
import {
  IDENTITY_TEXT_KINDS,
  scanIdentityText,
  type IdentityScanOutput,
  type IdentityTextKind,
} from './identity-safety-scan.js';

const PLUGIN_NAME = '@ax/validator-identity';

const IDENTITY_SCAN_HOOK = 'identity:scan';

function isTextKind(value: unknown): value is IdentityTextKind {
  return (IDENTITY_TEXT_KINDS as readonly unknown[]).includes(value);
}

/**
 * The `identity:scan` payload's text and kind, or an `invalid-payload` throw.
 * The caller is another plugin, but the payload is still checked here rather
 * than trusted: a missing or non-string `text` must not reach the scan and
 * come back looking like a verdict, and an unknown `kind` must not quietly
 * pick a laxer check. An absent `kind` is `self-description`, the full check.
 * The message is fixed and never quotes the input.
 */
function scanInputFrom(input: unknown): { text: string; kind: IdentityTextKind } {
  if (typeof input === 'object' && input !== null) {
    const { text, kind } = input as { text?: unknown; kind?: unknown };
    if (typeof text === 'string') {
      if (kind === undefined) return { text, kind: 'self-description' };
      if (isTextKind(kind)) return { text, kind };
    }
  }
  throw new PluginError({
    code: 'invalid-payload',
    plugin: PLUGIN_NAME,
    hookName: IDENTITY_SCAN_HOOK,
    message: `${IDENTITY_SCAN_HOOK} expects { text: string, kind?: 'self-description' | 'instructions' }`,
  });
}

export function createValidatorIdentityPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      // `identity:scan` — the write-time check @ax/agents calls (TASK-989).
      // ONE authoritative scanner, a service hook like validator-skill's
      // `skills:scan`. @ax/agents declares it as an optionalCall and fails
      // closed without it.
      registers: [IDENTITY_SCAN_HOOK],
      calls: [],
      subscribes: [],
    },
    init({ bus }) {
      // A refusal is the answer, not an error: the caller maps it to "not
      // saved". The log carries the category only — never the text, which is
      // untrusted and may be a person's private Instructions.
      bus.registerService<unknown, IdentityScanOutput>(
        IDENTITY_SCAN_HOOK,
        PLUGIN_NAME,
        async (ctx, input) => {
          const { text, kind } = scanInputFrom(input);
          const result = scanIdentityText(text, kind);
          if (result.verdict === 'refused') {
            ctx.logger.warn('identity_scan_refused', { category: result.category });
          }
          return result;
        },
      );
    },
  };
}
