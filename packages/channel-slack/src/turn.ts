import {
  makeAgentContext,
  makeReqId,
  type AgentContext,
  type AgentMessage,
  type HookBus,
  type Logger,
} from '@ax/core';
import { outcomeBlocks } from './blocks.js';
import { COPY } from './copy.js';
import { recheckAfterMiss } from './decision-answer.js';
import { findHeldDecision, type HeldDecision } from './decision-prompts.js';
import { decodeSlackEntities } from './format.js';
import {
  CONTINUATION_START_GRACE_MS,
  CONTINUATION_WAKE_MAX_MS,
  DECISION_LOOKUP_TIMEOUT_MS,
  PERMISSION_PROMPTS_PER_TURN_MAX,
  TURN_END_GRACE_MS,
  TURN_HARD_CAP_MS,
} from './limits.js';
import { logCode } from './log-code.js';
import { ADD_HOST, hostSubject, skillPromptFor } from './permission-prompts.js';
import { postLinkOnly, postPrompt } from './prompt-post.js';
import type { Prompt, PromptContext, PromptRegistry, PromptSubject } from './prompts.js';
import { createReplyStream, type ReplyClock, type ReplyOutcome } from './reply-stream.js';
import type { SlackApi } from './slack-api.js';
import type { InstallRow } from './store.js';
import type { PermissionIn, StreamChunkIn, TurnRegistry } from './turn-registry.js';

/**
 * One Slack turn: a person's message to an agent, the reply streamed back
 * into the Slack thread (design §5). A DM and a channel mention run the same
 * turn; its `mode` says which:
 *
 *   - `dm`: the owner, in a 1:1 DM with their own personal agent.
 *   - `attended`: a channel member who can use the channel's team agent.
 *   - `external`: anyone else the channel admits, run as the person who
 *     connected the channel.
 *
 * The turn's context is built here, by the host, from what admission and AX
 * decided (never from the message): the user, the agent, the thread's
 * conversation, and the mode's `source` and `audience` (`turnContextFields`,
 * the only place they come from; constant for a conversation, as memory
 * requires). The sender label is part of the message CONTENT, built by the
 * caller: untrusted text the model reads, nothing more.
 *
 * A call the turn holds for approval never runs, and the runner ends the turn
 * right after it, so the reply ends with one line saying whose approval it
 * waits for (reply-stream.ts `held`). The line never names the call, its tool
 * or connector, or the person.
 *
 *   - A turn that runs as the person who wrote (a DM, or an attended channel
 *     turn) lets them answer it in Slack (TASK-1095). Once the turn has
 *     ended, the held call's decision is looked up (decision-prompts.ts).
 *     Found, the reply ends with the ask alone, and a prompt with Allow and
 *     Deny follows it in the thread (prompt-post.ts), still inside the turn,
 *     so the conversation's next turn comes after it. Not found, or the
 *     prompt can't be posted: the line that sends them to their own Today,
 *     in the reply or as a message of its own after it. Only the first held
 *     call gets a prompt; any other waits in Today, which the prompt links.
 *   - Any other turn runs as someone else for them (the person who connected
 *     the channel, the agent's owner), whom they can't reach: the reply says
 *     the owner was asked, and nothing is looked up or posted.
 *
 * The two `chat:permission-request` cards get a prompt too, in a DM or an
 * attended turn only (permission-prompts.ts): after the reply, and after a
 * held call's prompt, in the order the cards came, one per host and one per
 * skill, at most PERMISSION_PROMPTS_PER_TURN_MAX between them.
 *
 *   - A host the sandbox was refused while the turn ran (the egress wall's
 *     card) is shown only once it passes the egress proxy's own HOST_RE,
 *     and its prompt links nowhere (nothing about a blocked host waits in
 *     Today).
 *   - A catalog skill the agent asked to use (request_capability's card;
 *     in Slack, in the continuation after that call's own hold was
 *     allowed) is asked about with its id and description, and its prompt links
 *     Today, where the same card waits. One that needs a key, or a bus
 *     without what its Allow calls, gets a link to the web app instead,
 *     with nothing to click.
 *
 * Should a prompt or a link for something that waits in Today not be
 * posted, the line that sends the person to Today follows instead, as for a
 * held call. A card that gets no prompt is counted, and logged by reason
 * and count once the turn has ended (`slack_permission_skipped`):
 * `outsider` (the turn's writer can't answer it here), `unavailable`
 * (nothing to call on a host's Allow: no `proxy:add-host`), `invalid-host`,
 * or `cap`. A woken turn's cards are asked about even when it said nothing
 * else, or never began: a card is all some continuations have to say.
 *
 * The reply ends at the first of: the turn's `chat:turn-end` (complete), its
 * `chat:turn-error` (error), a `terminated` invoke outcome
 * (`conversation:busy` → busy, never retried; anything else → error), a
 * thrown invoke (error), TURN_END_GRACE_MS after a complete invoke whose
 * turn-end never came (complete; counted from the turn's last chunk when
 * one came after the invoke answered, since an invoke can answer before its
 * turn has begun: `armGrace`), or TURN_HARD_CAP_MS (error). Failures are
 * logged as `slack_turn_failed` with a reason and a host code, never text.
 *
 * The cap ends the TURN too, not only its reply: the turn is asked to stop
 * (`agent:interrupt`, best-effort), so a turn nobody will see the end of
 * doesn't run, and spend, on for hours.
 *
 * After an Allow (TASK-1095) the agent carries on in a turn no message
 * started: @ax/decisions wakes it once the approval's undo window closes,
 * under the reqId the Allow gave it, and `followContinuation` streams that
 * turn into the prompt's thread, for the person who answered it. One reply
 * engine (`followReply`) serves both kinds of turn, so a chunk means the
 * same in each, and a call held again inside a continuation gets a prompt of
 * its own. What differs for a continuation: everything about it (thread,
 * person, user, agent, conversation, mode) comes from the prompt, never the
 * click; there is no message of theirs to put 👀 on; it isn't queued in the
 * conversation's lane; and its cap runs from its first chunk. It may also
 * never come (the session ended inside the window, or the wake-up was
 * refused), so nothing within CONTINUATION_START_GRACE_MS of the wake-up, or
 * an end before anything was said, ends it without a word in the thread (no
 * "I didn't have anything to add."), logged by code only as
 * `slack_continuation_missed` with a reason, `not-started` or `said-nothing`.
 * The prompt still says "I'll pick it up in a moment.", so it is then read
 * back from the decision (decision-answer.ts `recheckAfterMiss`) and redrawn
 * with what that says now: done, waiting for the agent's next ask, failed,
 * and so on. Nothing new to say, or no way to say it, leaves it as it is.
 */

/** Who a turn is from, and so whose context it runs under (`turnContextFields`). */
export type TurnMode = 'dm' | 'attended' | 'external';

/**
 * A turn's `source` and `audience`, from its mode alone: the one place a
 * Slack turn's identity context comes from. Approvals and memory both key
 * off it.
 *
 *   mode       source     audience
 *   dm         user       private    the owner, alone with their agent
 *   attended   user       shared     present, in a room
 *   external   external   shared     nobody with access to the agent
 *
 * Exact matches only: a mode this build doesn't know gets the most
 * restricted context, an outsider in a shared room. It fails closed, as
 * core's `isOutsiderTurn` and `audienceOf` do.
 */
export function turnContextFields(mode: TurnMode): {
  source: 'user' | 'external';
  audience: 'private' | 'shared';
} {
  switch (mode) {
    case 'dm':
      return { source: 'user', audience: 'private' };
    case 'attended':
      return { source: 'user', audience: 'shared' };
    case 'external':
    default:
      return { source: 'external', audience: 'shared' };
  }
}

export interface TurnDeps {
  bus: HookBus;
  api: SlackApi;
  registry: TurnRegistry;
  /** The open approval prompts (prompts.ts), where a held call's prompt is opened. */
  prompts: PromptRegistry;
  /** The web app's origin, for links in the bot's own lines. */
  publicOrigin: string;
  logger: Logger;
  clock: ReplyClock;
}

export interface TurnRequest {
  mode: TurnMode;
  /**
   * Who wrote, as the agent reads it in front of the text: the whole label,
   * built by the caller (format.ts `dmSenderLabel` for a DM). Display text
   * only, never identity.
   */
  label: string;
  install: InstallRow;
  botToken: string;
  channel: string;
  /** The message itself: 👀 goes on it while the agent works. */
  messageTs: string;
  threadTs: string;
  /** The sender's Slack user id: the reply's recipient. */
  senderSlackId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  /**
   * The sender's words as Slack sent them. The turn undoes Slack's `&amp;`,
   * `&lt;` and `&gt;` (format.ts `decodeSlackEntities`) and nothing else.
   */
  text: string;
}

/** A woken agent's turn to follow into a prompt's thread, after an Allow. */
export interface ContinuationRequest {
  /**
   * The prompt the Allow answered: where the reply goes (its channel and
   * thread), who it is for (its asker), and whose turn it is (its user,
   * agent, conversation and mode). Host-recorded when the prompt was posted.
   */
  prompt: Prompt;
  /** The bot token of the install the answer came through: the prompt's own (the click gate checked). */
  botToken: string;
  /** The `streamReqId` decisions:approve echoed: the woken runner emits under it. */
  reqId: string;
  /** ISO instant the agent is woken (the undo window's end), or null. */
  pendingUntil: string | null;
  /**
   * The prompt's message, as the click gate redrew it with the Allow's line
   * (the click's when it beat `posted`), or null. Redrawn again with what the
   * decision says when the agent never carries on in the thread.
   */
  messageTs: string | null;
}

interface AgentChoice {
  id: string;
  ownerId: string;
  ownerType: string;
  visibility: string;
  createdAt: Date;
}

/**
 * The sender's own personal agent: owned by them (`ownerType 'user'`,
 * `ownerId === userId`) with `visibility 'personal'`, the OLDEST by
 * `createdAt`, ties broken by id. Never a team agent, never someone else's.
 * An agent whose date can't be read sorts after every dated one. Null when
 * they have none.
 */
export function pickPersonalAgent(agents: ReadonlyArray<AgentChoice>, userId: string): string | null {
  let best: { id: string; at: number } | null = null;
  for (const a of agents) {
    if (a.ownerType !== 'user' || a.visibility !== 'personal' || a.ownerId !== userId) continue;
    const time = a.createdAt instanceof Date ? a.createdAt.getTime() : Number.NaN;
    const at = Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
    if (best === null || at < best.at || (at === best.at && a.id < best.id)) best = { id: a.id, at };
  }
  return best?.id ?? null;
}

/**
 * Tools whose result is something to open in the web app: both spellings,
 * since the runner serves them over its sandbox MCP server.
 */
const ARTIFACT_TOOLS = new Set([
  'artifact_publish',
  'show_visual',
  'mcp__ax-sandbox-tools__artifact_publish',
  'mcp__ax-sandbox-tools__show_visual',
]);

/**
 * Calls that are the runner's own plumbing, not something the agent did, so
 * they get no status and no step summary. `ToolSearch` is the Claude Agent
 * SDK loading a deferred tool's schema before the agent can call it. Exact
 * name only: a connector's own `mcp__x__ToolSearch` is a real step.
 *
 * A twin of channel-web's PLUMBING_TOOL_NAMES
 * (packages/channel-web/src/lib/workspace-steps.ts), which hides the same
 * calls from the web's step panel. It's kept here rather than imported (no
 * cross-plugin import). Change them together: turn.test.ts reads the web's
 * from its source and fails when the two differ.
 */
export const PLUMBING_TOOL_NAMES: ReadonlySet<string> = new Set(['ToolSearch']);

function isPlumbing(name: string | undefined): boolean {
  return name !== undefined && PLUMBING_TOOL_NAMES.has(name);
}

/**
 * A host code (`conversation:busy`, `chat-run-timeout`,
 * `agent-resolve:forbidden`). A terminated reason can be the runner's own
 * error text, so anything else is logged as `runner-error`.
 *
 * The same pattern as `HOST_REASON_RE` in @ax/chat-orchestrator
 * (packages/chat-orchestrator/src/orchestrator.ts, `outsiderReason`) and in
 * @ax/routines (packages/routines/src/fire.ts, `terminatedRunText`), where
 * the reason for its shape is spelled out. Change all three together; no
 * cross-plugin import.
 */
const HOST_CODE = /^[a-z0-9][a-z0-9:-]{0,63}$/;
const BUSY = 'conversation:busy';
/** chat-orchestrator's Stop (TASK-688): optional, so a preset without it still boots. */
const INTERRUPT = 'agent:interrupt';

type FailReason = 'busy' | 'terminated' | 'invoke-failed' | 'turn-error' | 'timeout';

/** Why a card asking the person's OK got no prompt (module header): logged as a count. */
type PermissionSkip = 'outsider' | 'unavailable' | 'invalid-host' | 'cap';

/**
 * What a reply asks the person in its thread once its turn has ended
 * (`askInThread`):
 *
 *   - `prompt`: Allow and Deny (prompt-post.ts). `inToday`: the same request
 *     waits in their Today too (a held call, a skill), so the prompt links
 *     it, and should the prompt not be posted, the line that sends them
 *     there follows instead. A host doesn't (channel-web keeps host cards
 *     out of Today): its prompt links nowhere, and has nothing to fall back
 *     to.
 *   - `web`: a request Slack can't take (a skill that needs a key): its
 *     subject and a line sending them to the web app, nothing to click,
 *     nothing opened. It waits in Today too, so it falls back the same way.
 */
type Ask =
  | { kind: 'prompt'; subject: PromptSubject; subjectText: string; inToday: boolean }
  | { kind: 'web'; subjectText: string };

interface Decision {
  outcome: ReplyOutcome;
  fail?: { reason: FailReason; code?: string };
  /** A woken turn that never began: given up without a word. */
  notStarted?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chunk kinds that arrive in stream order between two runs of text. */
const BREAKS_TEXT: ReadonlySet<string> = new Set(['tool-use', 'tool-result', 'thinking']);

/** The newlines that make `next` start a paragraph after text ending in `tail`; none it already has. */
function paragraphBreak(tail: string, next: string): string {
  const have = (/\n*$/.exec(tail)?.[0].length ?? 0) + (/^\n*/.exec(next)?.[0].length ?? 0);
  return '\n'.repeat(Math.max(0, 2 - have));
}

/**
 * How the turn a reply follows begins.
 *
 *   - `invoke`: the reply starts it itself, with `message` (`agent:invoke`).
 *     Its cap runs from now, 👀 goes on the person's message (`messageTs`)
 *     while the agent works, and a reply with nothing to say says so.
 *   - `woken`: something else starts it (decisions waking the agent after an
 *     Allow). Its cap runs from its first chunk; nothing within `withinMs`
 *     (not a chunk, an end or an error), or an end before anything was said,
 *     ends the reply without a single Slack call.
 */
type ReplyStart =
  | { kind: 'invoke'; message: AgentMessage; messageTs: string }
  | {
      kind: 'woken';
      withinMs: number;
      /** Once it has been given up without a word: what the thread's prompt says then. Never rejects. */
      missed: (ctx: AgentContext) => Promise<void>;
    };

/** One reply: where it goes, who it is for, whose turn it follows, and how that turn begins. */
interface ReplySpec {
  installId: string;
  teamId: string;
  botToken: string;
  channel: string;
  threadTs: string;
  /** Slack's id for the person the reply is for: its recipient, and the asker of any prompt it posts. */
  recipientSlackId: string;
  mode: TurnMode;
  userId: string;
  agentId: string;
  conversationId: string;
  /** The turn's reqId: its chunks, its end and its error are matched by it. */
  reqId: string;
  start: ReplyStart;
}

/** Run one turn to the end of its reply. Never rejects. */
export async function runTurn(d: TurnDeps, r: TurnRequest): Promise<void> {
  await followReply(d, {
    installId: r.install.installId,
    teamId: r.install.teamId ?? '',
    botToken: r.botToken,
    channel: r.channel,
    threadTs: r.threadTs,
    recipientSlackId: r.senderSlackId,
    mode: r.mode,
    userId: r.userId,
    agentId: r.agentId,
    conversationId: r.conversationId,
    reqId: makeReqId(),
    start: {
      kind: 'invoke',
      // As its sender typed it: `if x &lt; 3` reaches the model as `if x < 3`.
      message: { role: 'user', content: `${r.label}: ${decodeSlackEntities(r.text)}` },
      messageTs: r.messageTs,
    },
  });
}

/**
 * Follow a woken agent's turn into the answered prompt's thread (module
 * header). The turn's sink is registered before this returns, since the
 * click handler doesn't await it and the turn may begin at the wake-up.
 * Not queued in the conversation's lane (the sink must be there by the
 * wake-up, and a lane could hold it back), and not tracked by the lifetime,
 * like a turn. Never rejects.
 */
export function followContinuation(d: TurnDeps, c: ContinuationRequest): Promise<void> {
  const p = c.prompt;
  return followReply(d, {
    installId: p.installId,
    teamId: p.teamId,
    botToken: c.botToken,
    channel: p.channel,
    threadTs: p.threadTs,
    recipientSlackId: p.askerSlackId,
    mode: p.mode,
    userId: p.userId,
    agentId: p.agentId,
    conversationId: p.conversationId,
    reqId: c.reqId,
    start: {
      kind: 'woken',
      withinMs: continuationStartMs(c.pendingUntil, d.clock.now()),
      missed: (ctx) => redrawMissed(d, c, ctx),
    },
  });
}

/**
 * The prompt an Allow answered, once its continuation was given up: redrawn
 * with what its decision says now (decision-answer.ts `recheckAfterMiss`),
 * where the Allow's line was. Nothing new to say, no message to redraw, or a
 * failure (logged by code: `slack_prompt_failed`, stage `update`) leaves it
 * as it is. Never posts in the thread. Never rejects.
 */
async function redrawMissed(d: TurnDeps, c: ContinuationRequest, ctx: AgentContext): Promise<void> {
  const p = c.prompt;
  const ts = c.messageTs;
  if (ts === null) return;
  try {
    const line = await recheckAfterMiss(d.bus, ctx, p, {
      todayLink: `${d.publicOrigin}/workspace`,
      timeoutMs: DECISION_LOOKUP_TIMEOUT_MS,
      logger: d.logger,
    });
    if (line === null) return;
    await d.api.updateMessage(c.botToken, {
      channel: p.channel,
      ts,
      ...outcomeBlocks({ subject: p.subjectText, line }),
    });
  } catch (err) {
    try {
      d.logger.warn('slack_prompt_failed', { installId: p.installId, kind: 'decision', stage: 'update', code: logCode(err) });
    } catch {
      // A log line never changes the turn.
    }
  }
}

/**
 * How long a woken turn has to begin: until the wake-up at `pendingUntil`
 * (none, one that can't be read, or one already past: from now; one further
 * out than CONTINUATION_WAKE_MAX_MS: that long), then
 * CONTINUATION_START_GRACE_MS.
 */
function continuationStartMs(pendingUntil: string | null, nowMs: number): number {
  const wakeAt = typeof pendingUntil === 'string' ? Date.parse(pendingUntil) : Number.NaN;
  const untilWake = Number.isFinite(wakeAt) ? Math.min(Math.max(0, wakeAt - nowMs), CONTINUATION_WAKE_MAX_MS) : 0;
  return untilWake + CONTINUATION_START_GRACE_MS;
}

/**
 * Follow one turn into its reply, to the end (module header): the reply
 * engine `runTurn` and `followContinuation` share. Registers the turn's sink
 * before its first await. Never rejects.
 */
async function followReply(d: TurnDeps, s: ReplySpec): Promise<void> {
  const installId = s.installId;
  const quietly = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // A log line never changes the turn.
    }
  };
  const start = s.start;

  const { source, audience } = turnContextFields(s.mode);
  /*
    Whose approval a held call waits for. @ax/decisions files a hold under
    the turn's user. A turn with source 'user' runs as the person who wrote,
    so it waits in their own Today. Any other turn runs as someone else for
    them (the person who connected the channel: the agent's owner), whom
    they can't reach.
  */
  const approver = source === 'user' ? 'sender' : 'owner';
  /*
    Whether the person who wrote can answer a held call, or a card, here,
    with a prompt (TASK-1095): only when the turn runs as them, `source`
    'user', which is exactly a DM or an attended turn. The mode is narrowed
    again for the registry, which refuses any other mode itself. An
    outsider's turn never gets a prompt. `context` is every prompt's: where
    it goes, who may answer it, and whose turn the answer runs as.
  */
  const asking =
    source === 'user' && (s.mode === 'dm' || s.mode === 'attended')
      ? {
          prompts: d.prompts,
          context: {
            installId,
            teamId: s.teamId,
            channel: s.channel,
            threadTs: s.threadTs,
            askerSlackId: s.recipientSlackId,
            userId: s.userId,
            agentId: s.agentId,
            conversationId: s.conversationId,
            mode: s.mode,
          } satisfies PromptContext,
        }
      : null;
  // Today: the web app's workspace root (channel-web `WORKSPACE_ROOT_PATH`).
  const todayLink = `${d.publicOrigin}/workspace`;

  const ctx = makeAgentContext({
    sessionId: makeReqId(),
    reqId: s.reqId,
    agentId: s.agentId,
    userId: s.userId,
    conversationId: s.conversationId,
    source,
    audience,
  });

  let replyLogger = d.logger;
  quietly(() => {
    replyLogger = d.logger.child({ installId });
  });
  const stream = createReplyStream({
    api: d.api,
    botToken: s.botToken,
    target: {
      channel: s.channel,
      threadTs: s.threadTs,
      recipientUserId: s.recipientSlackId,
      recipientTeamId: s.teamId,
    },
    // 👀 goes only on a message the person sent, and only `working()` puts
    // it there (below). A woken turn has no such message and never calls it,
    // so nothing is reacted to.
    messageTs: start.kind === 'invoke' ? start.messageTs : s.threadTs,
    agentLink: `${d.publicOrigin}/workspace/agents/${encodeURIComponent(s.agentId)}`,
    todayLink,
    logger: replyLogger,
    clock: d.clock,
  });

  let decided = false;
  let settle!: (decision: Decision) => void;
  const decision = new Promise<Decision>((resolve) => {
    settle = resolve;
  });
  const decide = (next: Decision): void => {
    if (decided) return;
    decided = true;
    settle(next);
  };

  /** Every call's tool name by id: a result finds its artifact tool here, and a step summary its plumbing call. */
  const toolNames = new Map<string, string>();
  /**
   * The first call the turn held, when its writer can answer it here
   * (`asking`): whose line ends the reply waits until the turn has ended and
   * the call's decision has been looked up. Later holds change nothing. Set
   * in `onChunk`, so declared wide: TypeScript would read it as null forever.
   */
  let firstHeld = null as { callId: string | undefined } | null;
  /**
   * The reply has been given something to show: text, a status, an artifact
   * or a held call. A plumbing call (PLUMBING_TOOL_NAMES) and its summary are
   * none of these. A woken turn that ends without any is given up quietly.
   */
  let said = false;
  /** The turn has begun: the reply invoked it, or (woken) its first chunk came. */
  let started = start.kind === 'invoke';
  /**
   * Text after other work (a tool call or its result, thinking) starts a new
   * paragraph. claude-sdk sends whole text blocks, so without this the block
   * after a tool call is glued to the one before ("…handling.Done!"). Inside
   * one uninterrupted run nothing is added: aisdk sends word-sized deltas.
   *
   * Only kinds that arrive in stream order count. A `step-summary` arrives
   * late (@ax/step-summaries answers off the stream's path) and can land
   * between two word deltas; the tool call it describes already made the
   * break. A kind this build doesn't know doesn't count either: a missed break
   * glues two paragraphs, a wrong one splits a sentence.
   */
  let textTail = '';
  let otherSinceText = false;
  const onChunk = (c: StreamChunkIn): void => {
    // A woken turn's first chunk, of any kind: it has begun, and from now it
    // runs under the cap.
    if (!started) {
      started = true;
      armCap();
    }
    // Its own turn is still going after its invoke answered (see `armGrace`):
    // the grace runs from this chunk, not from that answer.
    if (grace !== null && !decided) armGrace();
    if (c.kind !== 'text') {
      if (textTail !== '' && c.kind !== undefined && BREAKS_TEXT.has(c.kind)) otherSinceText = true;
    } else if (c.text !== undefined && c.text !== '') {
      const text = otherSinceText ? paragraphBreak(textTail, c.text) + c.text : c.text;
      otherSinceText = false;
      textTail = (textTail + text).slice(-2);
      said = true;
      stream.text(text);
      return;
    }
    switch (c.kind) {
      case 'text':
        return;
      case 'tool-use':
        if (c.toolCallId !== undefined && c.toolName !== undefined) toolNames.set(c.toolCallId, c.toolName);
        if (isPlumbing(c.toolName)) return;
        said = true;
        stream.status(c.activityPhrase ?? COPY.statusDefault);
        return;
      case 'step-summary':
        if (c.toolCallId !== undefined && isPlumbing(toolNames.get(c.toolCallId))) return;
        if (c.text !== undefined) {
          said = true;
          stream.status(c.text);
        }
        return;
      case 'tool-result': {
        // Held: the call never ran and waits for someone's approval. The reply
        // ends saying whose (once), and it is no artifact. When the writer can
        // answer it here, that waits for the call's decision (below).
        if (c.held === true) {
          said = true;
          if (asking === null) stream.held(approver);
          else if (firstHeld === null) firstHeld = { callId: c.toolCallId };
          return;
        }
        if (c.isError === true || c.toolCallId === undefined) return;
        const tool = toolNames.get(c.toolCallId);
        if (tool !== undefined && ARTIFACT_TOOLS.has(tool)) {
          said = true;
          stream.artifact();
        }
        return;
      }
      default:
        // `thinking` stays private, and a kind this build doesn't know is skipped.
        return;
    }
  };

  /*
    The cards asking the person's OK that this turn heard, as what to ask
    after its reply, in the order they came (module header). Never more
    kept than the cap: anything else is only counted.
  */
  const permissions: Array<{ key: string; ask: Ask }> = [];
  const skipped = new Map<PermissionSkip, number>();
  const skip = (reason: PermissionSkip): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };
  /** What to ask about one card, keyed by what it asks for; null when it is not asked about (counted). */
  const askFor = (p: PermissionIn): { key: string; ask: Ask } | null => {
    if (p.kind === 'skill') {
      // Buttons only for a skill that needs nothing but a yes: anything else, the web app.
      const shown = skillPromptFor(p, d.bus);
      return {
        key: `skill:${p.skillId}`,
        ask:
          shown.kind === 'buttons'
            ? { kind: 'prompt', subject: { kind: 'skill', skillId: p.skillId }, subjectText: shown.subjectText, inToday: true }
            : { kind: 'web', subjectText: shown.subjectText },
      };
    }
    if (!d.bus.hasService(ADD_HOST)) {
      skip('unavailable');
      return null;
    }
    // The host is the sandbox's: shown only once the proxy's own pattern takes it.
    const subjectText = hostSubject(p.host);
    if (subjectText === null) {
      skip('invalid-host');
      return null;
    }
    return {
      key: `host:${p.host}`,
      ask: { kind: 'prompt', subject: { kind: 'host', host: p.host, sessionId: p.sessionId }, subjectText, inToday: false },
    };
  };
  const onPermission = (p: PermissionIn): void => {
    if (asking === null) {
      skip('outsider');
      return;
    }
    const card = askFor(p);
    if (card === null) return;
    // One prompt per host, one per skill: a repeat is that prompt, never one over the cap.
    if (permissions.some((q) => q.key === card.key)) return;
    if (permissions.length >= PERMISSION_PROMPTS_PER_TURN_MAX) {
      skip('cap');
      return;
    }
    permissions.push(card);
  };
  /** Every card's ask, in the order the cards came. */
  const askPermissions = async (): Promise<void> => {
    if (asking === null) return;
    for (const { ask } of permissions) await askInThread(d, asking.prompts, s.botToken, asking.context, ask, todayLink);
  };

  // Registered before agent:invoke: a fast turn's first chunk can beat the
  // call's return. And before this function's first await: a woken turn's
  // follower is started without being awaited.
  const unregister = d.registry.register({
    reqId: s.reqId,
    conversationId: s.conversationId,
    chunk: onChunk,
    end: () => decide({ outcome: 'complete' }),
    error: () => decide({ outcome: 'error', fail: { reason: 'turn-error' } }),
    permission: onPermission,
  });
  // 👀 on the sender's message while a cold runner starts, not a blank thread
  // (walk on kind, 2026-11-13); it comes off once the reply shows. A woken
  // turn has no message of theirs to put it on.
  if (start.kind === 'invoke') stream.working();
  /**
   * Ask chat-orchestrator to stop the conversation's in-flight turn: the
   * same Stop the web app's button sends (`{ conversationId, userId }`; it
   * re-checks ownership itself). Best-effort and logged by code: the reply
   * ends either way. `interrupted: false` means nothing was running by then.
   * Never rejects.
   */
  const interruptTurn = async (): Promise<void> => {
    try {
      if (!d.bus.hasService(INTERRUPT)) {
        quietly(() => d.logger.warn('slack_turn_interrupt_failed', { installId, code: 'unavailable' }));
        return;
      }
      const out = await d.bus.call<{ conversationId: string; userId: string }, unknown>(INTERRUPT, ctx, {
        conversationId: s.conversationId,
        userId: s.userId,
      });
      const interrupted = isRecord(out) && out['interrupted'] === true;
      quietly(() => d.logger.info('slack_turn_interrupted', { installId, reason: 'timeout', interrupted }));
    } catch (err) {
      quietly(() => d.logger.warn('slack_turn_interrupt_failed', { installId, code: logCode(err) }));
    }
  };
  /*
    The stop the cap sent, awaited before this turn returns. The lane is
    released when this function returns, and the orchestrator stops "the
    conversation's in-flight turn": released first, the next queued DM in the
    thread could start before the stop lands and be the turn it stops.
  */
  let interrupting: Promise<void> | null = null;
  let cap: unknown = null;
  /** The hard cap, from now: armed when the turn begins (`started`), which a woken turn's first chunk is. */
  const armCap = (): void => {
    cap = d.clock.setTimeout(() => {
      // A turn that already ended is not stopped again.
      if (decided) return;
      decide({ outcome: 'error', fail: { reason: 'timeout' } });
      // Sent now, not after the reply: the turn is still burning until it lands.
      interrupting = interruptTurn();
    }, TURN_HARD_CAP_MS);
  };
  let grace: unknown = null;
  /**
   * The invoke answered complete: finish TURN_END_GRACE_MS from now unless
   * the turn's own turn-end comes first. Pushed back by each chunk of the
   * turn's own that comes after (`onChunk`): chat-orchestrator answers a
   * session's oldest waiting invoke on a turn-end that names no reqId (a
   * warm agent's dark reaction to a Deny, say), so an invoke can answer
   * before its own turn has even begun, and a fixed grace would cut that
   * turn's reply short. A turn that has really ended sends no more chunks,
   * so it is finished as before.
   */
  const armGrace = (): void => {
    if (grace !== null) d.clock.clearTimeout(grace);
    grace = d.clock.setTimeout(() => decide({ outcome: 'complete' }), TURN_END_GRACE_MS);
  };
  let startBy: unknown = null;

  if (start.kind === 'invoke') {
    armCap();
    const message = start.message;
    void (async () => {
      try {
        const outcome = await d.bus.call<{ message: AgentMessage }, unknown>('agent:invoke', ctx, { message });
        if (isRecord(outcome) && outcome['kind'] === 'terminated') {
          const raw = outcome['reason'];
          const code = typeof raw === 'string' && HOST_CODE.test(raw) ? raw : 'runner-error';
          // Busy: the conversation's session is running a turn of another
          // mode. Say so and back off; a retry would pay its costs again.
          decide(
            code === BUSY
              ? { outcome: 'busy', fail: { reason: 'busy', code } }
              : { outcome: 'error', fail: { reason: 'terminated', code } },
          );
          return;
        }
        // Complete: the turn-end decides. Should it never come, finish anyway.
        if (!decided) armGrace();
      } catch (err) {
        decide({ outcome: 'error', fail: { reason: 'invoke-failed', code: logCode(err) } });
      }
    })();
  } else {
    // Woken: nothing by then (not a chunk, an end or an error) and it isn't
    // coming. A turn that has begun is never given up here: the cap is its.
    startBy = d.clock.setTimeout(() => {
      if (!started) decide({ outcome: 'complete', notStarted: true });
    }, start.withinMs);
  }

  const { outcome, fail, notStarted } = await decision;
  if (cap !== null) d.clock.clearTimeout(cap);
  if (grace !== null) d.clock.clearTimeout(grace);
  if (startBy !== null) d.clock.clearTimeout(startBy);
  unregister();
  // Every card the turn will hear has come: what got no prompt, by reason and count only (never a host).
  for (const [reason, count] of skipped) {
    quietly(() => d.logger.info('slack_permission_skipped', { installId, reason, count }));
  }
  // Given up without a word: the reply was never given anything, so nothing
  // of it reached Slack, and nothing is sent in the thread now (Review Focus
  // 3). Only the prompt is redrawn, with what its decision says (`missed`).
  // A card heard in the conversation meanwhile is still asked about: it is
  // the person's own (a conversation is one person's), and nothing else
  // would ask them here.
  if (notStarted === true) {
    quietly(() => d.logger.info('slack_continuation_missed', { installId, reason: 'not-started' }));
    if (start.kind === 'woken') await start.missed(ctx);
    await askPermissions();
    return;
  }
  if (fail !== undefined) {
    quietly(() =>
      d.logger.warn('slack_turn_failed', {
        installId,
        reason: fail.reason,
        ...(fail.code !== undefined ? { code: fail.code } : {}),
      }),
    );
  }
  if (start.kind === 'woken' && outcome === 'complete' && !said) {
    quietly(() => d.logger.info('slack_continuation_missed', { installId, reason: 'said-nothing' }));
    await start.missed(ctx);
    // A continuation whose only output was a card (the skill request_capability
    // asks for, re-issued after its Allow): no reply to put it after, so it is
    // asked about on its own.
    await askPermissions();
    return;
  }
  /*
    A call held for the person who wrote: the decision it waits as. Found,
    the reply ends with the ask and the prompt follows it; not found, the
    reply sends them to their own Today, as before buttons.
  */
  let found: HeldDecision | null = null;
  if (firstHeld !== null) {
    const callId = firstHeld.callId;
    if (callId !== undefined) {
      found = await findHeldDecision(
        d.bus,
        ctx,
        { userId: s.userId, agentId: s.agentId, conversationId: s.conversationId, toolCallId: callId },
        DECISION_LOOKUP_TIMEOUT_MS,
        { installId, logger: d.logger },
      );
    }
    stream.held(found !== null ? 'asked' : 'sender');
  }
  try {
    await stream.finish(outcome);
    // After the reply: for a turn, before its lane lets the conversation's next turn start.
    if (found !== null && asking !== null) {
      await askInThread(
        d,
        asking.prompts,
        s.botToken,
        asking.context,
        { kind: 'prompt', subject: { kind: 'decision', decisionId: found.decisionId }, subjectText: found.summary, inToday: true },
        todayLink,
      );
    }
    // Then the cards', in the order they came.
    await askPermissions();
  } finally {
    // The sender has their reply; the lane waits for the stop (see `interrupting`).
    if (interrupting !== null) await interrupting;
  }
}

/**
 * After a reply: one `ask` in the reply's thread, for the person `c` says
 * asked (prompt-post.ts). Should a request that waits in their Today not be
 * shown here, the line that sends them to their own Today follows instead,
 * as a message of its own: one try, logged by code when it fails
 * (`slack_reply_failed`, stage `held`). A host has no such line. Never
 * rejects.
 */
async function askInThread(
  d: Pick<TurnDeps, 'api' | 'logger' | 'clock'>,
  prompts: PromptRegistry,
  botToken: string,
  c: PromptContext,
  ask: Ask,
  todayLink: string,
): Promise<void> {
  const posting = { api: d.api, botToken, logger: d.logger, clock: d.clock };
  const posted =
    ask.kind === 'web'
      ? await postLinkOnly(posting, c, ask.subjectText, COPY.skillNeedsWeb(todayLink))
      : await postPrompt({ ...posting, prompts, todayLink: ask.inToday ? todayLink : null }, c, ask.subject, ask.subjectText);
  // Nothing about a blocked host waits in Today: nothing to send them to.
  if (posted || (ask.kind === 'prompt' && !ask.inToday)) return;
  try {
    await d.api.postMessage(botToken, {
      channel: c.channel,
      threadTs: c.threadTs,
      markdownText: COPY.heldForSender(todayLink),
    });
  } catch (err) {
    try {
      d.logger.warn('slack_reply_failed', { installId: c.installId, stage: 'held', code: logCode(err) });
    } catch {
      // A log line never changes the turn.
    }
  }
}
