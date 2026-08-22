#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildHomeBinEnv,
  buildPythonVenvEnv,
  buildToolCacheEnv,
  buildTtyHintEnv,
  createHoldLatch,
  createToolPolicy,
  runRunner,
  type Loop,
  type LoopContext,
  type RunnerDeps,
} from '@ax/agent-runner-core';
import {
  ToolLoopAgent,
  generateText,
  stepCountIs,
  type ModelMessage,
  type Tool,
} from 'ai';
import {
  createCompactor,
  findContextWindowExceeded,
} from './compaction/compactor.js';
import {
  createMemoryTranscriptSource,
  type MemoryTranscriptSource,
} from './memory-transcript-source.js';
import {
  messagesForProvider,
  providerIdForModelRef,
  resolveModel,
} from './provider.js';
import { discoverInstalledSkills, buildSkillsPromptSection } from './skills-index.js';
import { buildBuiltinTools } from './tools/builtins.js';
import { buildHostTools } from './tools/host-tools.js';
import { assertAllToolsWrapped, mergeToolSets } from './tools/policy-wrap.js';
import { buildSandboxTools } from './tools/sandbox-tools.js';
import { buildSkillTool } from './tools/skill-tool.js';
import { toTurnBlocks } from './turn-blocks.js';
import { toUserModelMessage } from './user-message.js';

// ---------------------------------------------------------------------------
// Runner entry binary (aisdk variant) — the second runner.
//
// Everything that is NOT the agent loop — env read, IPC client, workspace
// materialize, uploads, skills projection, inbox wiring, turn-end commit and
// ship, `event.chat-end`, and the 0/1/2 exit-code contract — lives in
// `runRunner` (@ax/agent-runner-core), shared with
// @ax/agent-claude-sdk-runner. This file is the loop it drives: an `ai@7`
// `ToolLoopAgent`, our own tool set, and the message pump.
//
// The two runners must be HOST-INDISTINGUISHABLE: same IPC events, same
// transcript contract, same workspace choreography, same security policy. That
// constraint is the point — it is what keeps a second runner from becoming a
// second architecture. Where they differ is documented in README.md.
//
// SECURITY POSTURE (invariant I5):
//   - The runner holds NO real LLM credentials. `agentConfig.model` is resolved
//     against a provider built with the `ax-cred:<hex>` PLACEHOLDER that the
//     host-side credential-proxy substitutes mid-flight, and the provider is
//     forbidden from doing its own auth discovery (see provider.ts).
//   - EVERY tool call passes `wrapWithPolicy` -> the shared `ToolPolicy` ->
//     the host's `tool.pre-call` hook. There is no second path. The assembled
//     tool set is asserted for this at boot (`assertAllToolsWrapped`), so a
//     tool added later on a bypass path fails to start rather than quietly
//     skipping the gate.
//   - Skills come ONLY from the read-only `$CLAUDE_CONFIG_DIR/skills/`
//     projection, never from the agent-writable workspace (see skills-index.ts).
//
// Exit codes (owned by runRunner):
//   0 — chat completed normally (inbox returned cancel; loop drained).
//   1 — terminated abnormally (loop threw, IPC errored after retries, etc.).
//   2 — fatal during bootstrap (missing env, initial tool.list failure).
// ---------------------------------------------------------------------------

/** This binary's runner id, as written on `agents.runner` / `AgentConfig`. */
export const RUNNER_ID = 'aisdk';

/**
 * Ceiling on tool-calling steps within ONE user turn. `ai@7` defaults to 20;
 * agentic file work routinely needs more, and the real bound on a runaway turn
 * is the orchestrator's `chatTimeoutMs` plus the sandbox reaper, not this.
 * Deliberately NOT a context-window guard — that is compaction's job, and it
 * has its own trigger (`compaction/compactor.ts`).
 */
const MAX_STEPS_PER_TURN = 100;

/**
 * Ceiling on the rung-3 summarizer call (design §7).
 *
 * The call happens at the top of a turn with the user already waiting and
 * nothing on screen, so a hung summarizer reads as a hung agent. On timeout the
 * ladder's failure path takes over: the turn proceeds uncompacted on rungs 1-2,
 * which is a worse turn but a turn. Generous rather than tight — the input is
 * most of a context window, and giving up on a slow-but-working summarizer
 * costs the whole conversation.
 */
const SUMMARY_TIMEOUT_MS = 120_000;

export interface AiSdkLoopDeps extends RunnerDeps {
  /**
   * The transcript store. Constructed in `main()` OUTSIDE `runRunner` because
   * it is both the loop's message array and the shell's `TranscriptSource`, and
   * the shell builds its source before it builds the loop. One array, one
   * owner — a second copy would drift.
   */
  transcript: MemoryTranscriptSource;
}

export function createAiSdkLoop(deps: AiSdkLoopDeps): Loop {
  const {
    client,
    env,
    agentConfig,
    tools: catalog,
    localDispatcher,
    flushWorkspaceForHostTool,
    proxyStartup,
    pythonVenvReady,
    homeDir,
    systemPrompt,
    resumeSessionId,
    transcript,
  } = deps;

  // ---- `AgentConfig.runner` gets its first real reader -------------------
  //
  // PR 2 threaded this field through every wire copy and left it unconsumed.
  // The check it earns here is a SELF-CHECK: the host picked a binary out of
  // `ChatOrchestratorConfig.runnerBinaries` by the agent's runner id, and if
  // that map is mis-keyed (`aisdk` -> the claude-sdk binary, or the reverse)
  // the operator's explicit choice is silently ignored and the agent runs on
  // the wrong harness with a transcript in the wrong format. Failing at boot
  // is recoverable — fix the map, retry; running the wrong loop produces a
  // conversation nobody can explain later.
  //
  // NOTE for anyone tracing the design: this is NOT the cross-runner resume
  // demotion. `agentConfig.runner` is the frozen snapshot of the agent's
  // CURRENT runner, not of whatever wrote the stored transcript, and those two
  // diverge exactly when someone switches an agent's runner mid-conversation —
  // which is the case the demotion exists for. The transcript's own header
  // line is authoritative there; see transcript-codec.ts.
  if (agentConfig.runner !== RUNNER_ID) {
    throw new Error(
      `agent-aisdk-runner: this session was configured for runner ` +
        `"${agentConfig.runner}" but the host spawned the "${RUNNER_ID}" binary. ` +
        `Check the runner-id -> binary map (ChatOrchestratorConfig.runnerBinaries).`,
    );
  }

  return {
    async run(ctx: LoopContext): Promise<number> {
      // The env the Bash tool's child shell inherits. Same layering, same
      // ordering rationale, as the claude-sdk loop's `query({ env })` literal —
      // read that file's long comment for the per-layer "why". The difference
      // is only WHO consumes it: there the SDK subprocess, here our own Bash.
      //
      //   tty hints    — an overridable FLOOR, so a real forwarded TERM wins
      //   proxy env    — HTTPS_PROXY + the ax-cred placeholders + CA paths
      //   HOME         — the agent's working frame
      //   tool caches  — npx/uvx caches onto the ephemeral tier, not HOME
      //   python venv  — PATH + VIRTUAL_ENV + pip CA trust, when ready
      //   $HOME/bin    — APPENDED, never prepended: HOME is model-writable and
      //                  restored across sessions, so a leading entry would let
      //                  an injected `$HOME/bin/git` shadow the trusted binary.
      const pythonVenvEnv = buildPythonVenvEnv({
        ephemeralRoot: pythonVenvReady ? env.ephemeralRoot : undefined,
        currentPath: proxyStartup.providerEnv.PATH,
        caCertFile:
          proxyStartup.providerEnv.SSL_CERT_FILE ??
          proxyStartup.providerEnv.NODE_EXTRA_CA_CERTS,
      });
      const bashEnv: Record<string, string> = {
        ...buildTtyHintEnv(),
        ...proxyStartup.providerEnv,
        HOME: homeDir,
        ...buildToolCacheEnv(env.ephemeralRoot),
        ...pythonVenvEnv,
        ...buildHomeBinEnv(
          homeDir,
          pythonVenvEnv.PATH ?? proxyStartup.providerEnv.PATH,
        ),
      };

      // ONE policy instance, shared by every tool. The re-root target is always
      // the GOVERNED tier (`env.workspaceRoot`, /agent) — never cwd — so a
      // `.ax/**` or `.claude/**` self-edit lands back on the validated,
      // git-backed tree even when the agent's working frame is the ungoverned
      // NFS mount. `broaden` widens from the `.ax/uploads/` safety net to the
      // full validator policy exactly when that mount is wired (TASK-164 §14).
      const policy = createToolPolicy({
        client,
        workspaceRoot: env.workspaceRoot,
        broaden: env.userFilesRoot !== undefined,
        recognizedRoots: [homeDir, env.ephemeralRoot].filter(
          (r): r is string => r !== undefined,
        ),
        drainEgressBlocks: async () => {
          const r = (await client.call('proxy.drain-egress-blocks', {})) as {
            hosts: string[];
          };
          return r.hosts;
        },
      });

      // ONE latch, shared by every tool this turn. A tool's `execute` cannot
      // stop the loop by itself here (unlike the claude-sdk runner's SDK
      // hook) — `stopWhen` below is what actually ends the turn, and it reads
      // this same instance.
      const holdLatch = createHoldLatch();

      // Skills: the read-only projection is the SOLE discovery path. Names +
      // descriptions go into the prompt; bodies load on demand through the
      // `Skill` tool. Discovery never throws — a malformed bundle is skipped
      // with a loud log, not a dead session.
      const skills = await discoverInstalledSkills();

      // Merged rather than spread: one flat namespace means a collision must be
      // an error, not a last-write-wins coin flip. See mergeToolSets.
      const tools = mergeToolSets([
        {
          label: 'built-ins',
          tools: buildBuiltinTools({ policy, homeDir, env: bashEnv, holdLatch }),
        },
        {
          label: 'host catalog tools',
          tools: buildHostTools({
            policy,
            client,
            tools: catalog,
            flushWorkspace: flushWorkspaceForHostTool,
            holdLatch,
          }),
        },
        {
          label: 'sandbox catalog tools',
          tools: buildSandboxTools({
            policy,
            dispatcher: localDispatcher,
            tools: catalog,
            holdLatch,
          }),
        },
        { label: 'the Skill tool', tools: buildSkillTool({ policy, skills, holdLatch }) },
      ]) as unknown as Record<string, Tool>;
      // I₁, enforced rather than asserted in prose. `WebFetch`/`WebSearch`/
      // `Task`/`AskUserQuestion`/`TodoWrite` are absent by construction here —
      // on this runner "disabled" means "never registered", so there is no
      // deny-list to keep in sync. (Web capability is unaffected: @ax/web-tools
      // supplies web_search/web_extract as ordinary host tools above.)
      assertAllToolsWrapped(tools, holdLatch);

      // One parse, one opinion about which provider this is: `provider.ts`
      // owns both the model construction and the per-provider send-site
      // message policy, so the turn loop never re-derives "is this Anthropic?".
      const providerId = providerIdForModelRef(agentConfig.model);

      const instructions = composeInstructions(
        systemPrompt,
        buildSkillsPromptSection(skills),
      );

      // Compaction (design §7). `prepareStep` is the only hook that can rewrite
      // the message list per step AND have the rewrite carry forward to the
      // rest of the turn, which is what makes a long tool loop survivable.
      //
      // SEND-SITE ONLY, like the reasoning prune above it: `transcript` keeps
      // every message, and each step recomputes the compaction from what it is
      // handed. Nothing here reaches the host's stored bytes.
      //
      // Rung 3 (summarize) is the exception to "send-site only" and rides
      // `turn()` below, not `prepareStep`. It costs a model call, so it is the
      // one rung whose result is written back to `transcript` and published to
      // the host.
      const model = resolveModel({
        modelRef: agentConfig.model,
        providerEnv: proxyStartup.providerEnv,
      });
      const compactor = createCompactor({
        modelRef: agentConfig.model,
        instructions,
        toolCount: Object.keys(tools).length,
        // The agent's OWN model summarizes (design §7). A dedicated summarizer
        // model would mean a second entry in the per-agent allow-list and a
        // second credential to resolve, to save money on a call that happens
        // once per several dozen turns. `tools` is deliberately not passed:
        // this call reads, it does not act.
        summarizeText: async ({ instructions: summaryInstructions, prompt }) => {
          const { text } = await generateText({
            model,
            instructions: summaryInstructions,
            prompt,
            abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
          });
          return text;
        },
      });

      const agent = new ToolLoopAgent({
        model,
        instructions,
        tools,
        // The tool's `execute` cannot stop the loop by itself (it returns
        // text, not a signal) — the latch composes with the step cap so a
        // hold ends the turn after the step that tripped it.
        stopWhen: [stepCountIs(MAX_STEPS_PER_TURN), () => holdLatch.tripped],
        prepareStep: ({ steps, messages }) => compactor.step({ steps, messages }),
      });

      // The transcript session id. On resume the shell already seeded it (and
      // already restored our message array through the transcript source); on a
      // fresh boot we mint one and report it, because the shell's deferred
      // `conversation.store-runner-session` bind is gated on having one.
      if (ctx.getTranscriptSessionId() === null && resumeSessionId === null) {
        ctx.setTranscriptSessionId(randomUUID());
      }

      for (;;) {
        const next = await ctx.nextMessage();
        // null = the inbox said cancel (or hit its idle floor). Drain and exit;
        // the shell emits the single `event.chat-end` on the way out.
        if (next === null) return 0;

        // Per-turn latch: a hold in one turn must not bleed into the next.
        holdLatch.reset();

        transcript.append([toUserModelMessage(next.content)]);

        // Rung 3 of the compaction ladder (design §7), at the only point in the
        // turn where it is safe: the message list is quiescent — every tool call
        // has its result, no signed thinking block is mid-flight — and the
        // rewrite can be made durable before a single token of this turn is
        // spent. `turn()` decides; it declines unless rungs 1-2 would leave the
        // conversation over the threshold anyway, and it never throws.
        //
        // Unlike rungs 1-2 this DOES rewrite the transcript, because a model
        // call cannot be recomputed for free the way a mask or a prune can. The
        // two writes belong together: adopting the shorter list without
        // publishing it would leave the host's stored copy long, and the next
        // resume would silently undo the compaction and buy the summarizer call
        // again.
        const compacted = await compactor.turn({ messages: transcript.messages() });
        if (compacted.summarized) {
          transcript.replace(compacted.messages);
          await ctx.replaceTranscript();
        }

        // Send-site only. `messagesForProvider` prunes prior-turn reasoning for
        // providers that reject a replay of it (design §6) — the transcript
        // itself is untouched, because its persisted bytes are the host's
        // source of truth and rewriting them would break `prefixHash` and force
        // a full resync on every resume.
        const result = await agent.stream({
          messages: messagesForProvider({
            providerId,
            messages: transcript.messages(),
          }),
        });

        // Live streaming. Per-delta so the SSE fan-out feels like typing; the
        // canonical record comes from the response messages below, never from
        // this loop — see turn-blocks.ts.
        //
        // A provider failure arrives as an `error` PART rather than a rejected
        // promise; `await result.steps` then throws a generic
        // `AI_NoOutputGeneratedError: No output generated. Check the stream for
        // errors.` which loses the actual cause. Capture the part so the
        // `chat:turn-error` the user sees names the real failure.
        let streamError: unknown;
        for await (const part of result.fullStream) {
          if (part.type === 'error') {
            streamError = part.error;
          } else if (part.type === 'text-delta') {
            if (part.text.length > 0) {
              await ctx.emitChunk({ kind: 'text', text: part.text });
            }
          } else if (part.type === 'reasoning-delta') {
            if (part.text.length > 0) {
              await ctx.emitChunk({ kind: 'thinking', text: part.text });
            }
          } else if (part.type === 'tool-call') {
            await ctx.emitChunk({
              kind: 'tool-use',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: (part.input ?? {}) as Record<string, unknown>,
            });
          } else if (part.type === 'tool-result') {
            await ctx.emitChunk({
              kind: 'tool-result',
              toolCallId: part.toolCallId,
              output: renderStreamedOutput(part.output),
            });
          } else if (part.type === 'tool-error') {
            // A thrown executor. `ai@7` still produces a tool result for the
            // model (`error-text`) and continues the loop, so this is a failed
            // tool, not a failed turn — mark it and keep going.
            await ctx.emitChunk({
              kind: 'tool-result',
              toolCallId: part.toolCallId,
              output: errorText(part.error),
              isError: true,
            });
          }
          // start / start-step / finish-step / text-start / raw / … are
          // bookkeeping the host does not need.
        }

        // A step that fails AFTER an earlier one succeeded closes the stream
        // with an `error` part and leaves `result.steps` RESOLVED, carrying the
        // steps that did work (verified against ai@7.0.70: the step loop's
        // `catch` enqueues the error and closes; `NoOutputGeneratedError` only
        // fires when NOTHING was produced). So the catch below never runs for
        // that case, and without this line the turn would end as a SUCCESS with
        // partial content and the failure silently dropped — no
        // `chat:turn-error`, no retry card, nothing in the log.
        //
        // Any `error` part means the turn failed: tool failures arrive as
        // `tool-error` (handled above, loop continues) and cancellation arrives
        // as `abort`, so this branch is not stealing either of them.
        if (streamError !== undefined) throw modelCallError(undefined, streamError);

        // EVERY step's messages, not `result.response.messages` — that carries
        // only the LAST step's, which on a tool-using turn silently drops every
        // tool call and tool result from both the transcript and the persisted
        // turn. (Verified against ai@7.0.70.)
        let steps;
        try {
          steps = await result.steps;
        } catch (err) {
          throw modelCallError(err, streamError);
        }
        const newMessages: ModelMessage[] = steps.flatMap(
          (s) => s.response.messages,
        );
        transcript.append(newMessages);

        const { contentBlocks, toolResultBlocks, assistantText } =
          toTurnBlocks(newMessages);
        if (assistantText.length > 0) ctx.recordAssistantText(assistantText);

        await ctx.endTurn({
          contentBlocks,
          toolResultBlocks,
          // NO `beforeCommit`. Its absence is the point: the claude-sdk loop
          // must wait for the SDK to flush its jsonl before the shell can ship
          // (the TASK-11 / PR #163 / F-1-F-2 lineage). Here the messages are
          // already in `transcript` by the time this line runs — durability is
          // a function return, not a poll. Do not "restore" a wait here.
          readTurnId: async (_sessionId, role) =>
            transcript.lastUuidOfRole(role),
        });
      }
    },
  };
}

/**
 * Join the composed system prompt and the skills index.
 *
 * A bare `+` is wrong here: `buildSystemPrompt` does NOT end with a newline
 * (its last operational note ends mid-sentence), and the skills section STARTS
 * with a markdown heading — so concatenating them directly yields
 * `...reasonably can.## Available skills`, a heading the model reads as prose.
 * That silently degrades the one thing the section exists to do. Separate with a
 * blank line, and skip the separator entirely when there is no section.
 */
export function composeInstructions(prompt: string, section: string): string {
  if (section.length === 0) return prompt;
  // `trimEnd()`, NOT `.replace(/\s+$/, '')`. The composed prompt includes
  // agent-authored `.ax/` files, so it counts as uncontrolled input, and a
  // trailing-whitespace regex is quadratic on a string of many repeated
  // whitespace chars (CodeQL js/polynomial-redos — it flagged exactly this).
  // `governed-paths.ts` already dodges the same rule for trailing slashes with
  // a loop; `trimEnd` is the native, linear equivalent here.
  return `${prompt.trimEnd()}\n\n${section}`;
}

/**
 * Build the error that ends the run when the model call fails.
 *
 * Prefers the `error` stream part over whatever `await result.steps` threw:
 * the SDK's wrapper (`AI_NoOutputGeneratedError: No output generated. Check the
 * stream for errors.`) is true but useless, and it is what the user would
 * otherwise see in the retry card. The original is kept as `cause`.
 */
function modelCallError(wrapped: unknown, streamError: unknown): Error {
  // The compaction ceiling is not a model failure and its message is written
  // for the person reading the retry card, so it is re-raised as itself rather
  // than wrapped in `model call failed: …`. It reaches us buried in the SDK's
  // own error, which is why this searches the cause chain.
  const ceiling =
    findContextWindowExceeded(streamError) ?? findContextWindowExceeded(wrapped);
  if (ceiling !== undefined) return ceiling;

  const inner = streamError ?? wrapped;
  const detail =
    inner instanceof Error ? `${inner.name}: ${inner.message}` : String(inner);
  const err = new Error(`model call failed: ${detail}`, {
    ...(inner instanceof Error ? { cause: inner } : {}),
  });
  err.name = 'ModelCallError';
  return err;
}

/** Flatten a streamed tool output for the wire (full fidelity rides turn-end). */
function renderStreamedOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || typeof output !== 'object') return String(output);
  const o = output as { type?: unknown; value?: unknown };
  if (typeof o.value === 'string') return o.value;
  return JSON.stringify(o.value ?? o);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function main(): Promise<number> {
  // Built here, outside `runRunner`, so the SAME instance is both the shell's
  // transcript source and the loop's message store (see AiSdkLoopDeps).
  const transcript = createMemoryTranscriptSource();

  return runRunner((deps) => createAiSdkLoop({ ...deps, transcript }), {
    createTranscriptSource: () => transcript,
    // The F2a guard's non-conversation branch asks "is there a transcript on
    // disk for this bound session?". For this runner the answer is always no:
    // nothing is written to disk, and a fresh process starts with an empty
    // array. A non-conversation session therefore always starts fresh, which
    // is the correct (and only possible) answer here.
    hasLocalTranscript: async () => false,
    // No `afterMaterialize`: there is no SDK `projects/` symlink to scaffold
    // because there is no on-disk transcript to redirect.
    //
    // Anthropic through the AI SDK accepts PDFs as `file` content parts, so the
    // shell's attachment pass may emit `document` blocks; user-message.ts maps
    // them onto that shape. Verified against the SDK's own
    // `userModelMessageSchema`, not assumed.
    supportsDocumentBlocks: true,
  });
}

// ESM main-module guard. `require.main === module` doesn't work in ESM.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `runner: fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    });
}
