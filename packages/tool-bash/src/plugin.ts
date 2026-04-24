import { z } from 'zod';
import type {
  Plugin,
  SandboxSpawnInput,
  SandboxSpawnResult,
} from '@ax/core';

const PLUGIN_NAME = '@ax/tool-bash';

// 16 KiB cap on the command string is a belt-and-suspenders check:
// sandbox:spawn already caps argv element size, but rejecting here keeps
// the error localized ("bad input to bash tool") instead of bubbling
// through the spawn boundary. Matches the descriptor's maxLength so the
// LLM-visible schema and the runtime check stay in sync.
const MAX_COMMAND_BYTES = 16_384;

// Default 30s matches sandbox:spawn's own default; we re-assert it at the
// tool boundary so a later change to the sandbox default doesn't silently
// change this tool's behavior.
const DEFAULT_TIMEOUT_MS = 30_000;

const BashInputSchema = z.object({
  command: z.string().min(1).max(MAX_COMMAND_BYTES),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

export function createToolBashPlugin(): Plugin {
  return {
    manifest: {
      name: PLUGIN_NAME,
      version: '0.0.0',
      registers: ['tool:execute:bash'],
      calls: ['sandbox:spawn'],
      subscribes: [],
    },
    async init({ bus }) {
      bus.registerService(
        'tool:execute:bash',
        PLUGIN_NAME,
        async (ctx, raw) => {
          const parsed = BashInputSchema.parse(raw);
          // env: {} is deliberate — this tool never injects environment.
          // If a future config knob wants to pipe anything in, it flows
          // from the caller, not from the tool plugin itself (capabilities
          // minimized, invariant I5).
          const spawned = await bus.call<SandboxSpawnInput, SandboxSpawnResult>(
            'sandbox:spawn',
            ctx,
            {
              argv: ['/bin/bash', '-c', parsed.command],
              cwd: ctx.workspace.rootPath,
              env: {},
              timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            },
          );
          return {
            stdout: spawned.stdout,
            stderr: spawned.stderr,
            exitCode: spawned.exitCode,
            timedOut: spawned.timedOut,
            truncated: spawned.truncated,
          };
        },
      );
    },
  };
}
