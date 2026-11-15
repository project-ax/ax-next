import { makeAgentContext, type AgentContext, type HookBus, type Logger } from '@ax/core';
import { admitSender, findSenderUser, isTemporaryLookupFailure, type Admission } from './admission.js';
import { outcomeBlocks, type PromptAction } from './blocks.js';
import type { ChannelBinding, ChannelStore } from './channel-store.js';
import { agentAccess, type AgentAccess } from './channels.js';
import { COPY } from './copy.js';
import type { ClickHandler } from './interactions.js';
import { PROMPT_STEP_TIMEOUT_MS, SLACK_ID_RE } from './limits.js';
import { logCode } from './log-code.js';
import type { Prompt, PromptRegistry, PromptSubject } from './prompts.js';
import type { SecretStore } from './secrets.js';
import type { SlackApi } from './slack-api.js';
import type { InstallRow } from './store.js';

/**
 * The click gate (TASK-1095): who may answer an approval prompt, and what
 * their click does. The interactions route (interactions.ts) hands on only
 * what Slack signed: which button, which prompt id, which message and who
 * clicked. Every rule below is checked against the open prompt that id names
 * (prompts.ts), never against the message's text or a button's label, and
 * every one runs before the answer's hook does. In this order:
 *
 *   1. The install's bot token, from the vault. Without it nothing can be
 *      said: logged, and nothing is taken.
 *   2. The prompt is taken for this click (`claim`). One that isn't open
 *      (answered, expired, or forgotten by a restart) gets the clicker a
 *      private pointer to Today; one already being answered (a double click)
 *      gets silence. Anyone but the asker takes nothing (`not-asker`), so a
 *      bystander can never make the asker's own click wait: only steps 3
 *      and 4 run for them.
 *   3. It must be this install's prompt, in the clicked channel. Else
 *      silence.
 *   4. Anyone but the person whose turn it was is told, privately and once
 *      per prompt (`firstRefusal`), that only that person can answer, and
 *      no users.info or AX lookup is spent on them. The registry compared
 *      already; this compares again.
 *   5. The asker is admitted again from users.info (`admitSender`): a prompt
 *      lives a day, and a person can be deactivated or made a guest
 *      meanwhile. Slack briefly unavailable gets "try again"; a refusal,
 *      silence.
 *   6. Their verified email still maps to the AX user the turn ran as
 *      (`findSenderUser`), else they are told only the asker can answer.
 *   7. That user can still use the agent (`agentAccess`): a DM's personal
 *      agent, or an attended channel's team agent (`'yes'` only there, the
 *      router's own rule for an attended turn, channel-route.ts). Else the
 *      prompt closes.
 *   8. An attended prompt's channel is still connected to that agent
 *      (`channels.get`): a disconnected channel was promised no more
 *      answers. Else the prompt closes.
 *   9. Something here answers the prompt's kind of subject (`answers`), else
 *      the prompt closes. The answer runs as the prompt's user, agent and
 *      conversation, never as anything the click says.
 *  10. The prompt's message is redrawn with the answer's line where the
 *      buttons were (blocks.ts `outcomeBlocks`), the prompt is settled, and
 *      the answer's follow-up (the agent carrying on in the thread) starts,
 *      never awaited. An answer that says `settle: false` (a failure the
 *      asker can retry) keeps its buttons instead: its line goes to the
 *      asker privately, and the prompt is open again.
 *
 * One answer per prompt. Only an `ok` claim holds the prompt's lock, and the
 * click that took it lets go exactly once: `settle` once the prompt is
 * answered or closed for good, `release` on anything the asker can retry. A
 * refusal lets go BEFORE it says anything, so the asker's own click during
 * that Slack call isn't the silent busy one; a redraw happens while the lock
 * is still held, so a second click racing it is silent rather than told the
 * prompt is gone. A `finally` releases a lock nothing else let go of, and
 * never one this click didn't take.
 *
 * Every await has a deadline, PROMPT_STEP_TIMEOUT_MS: a step that hung
 * would otherwise hold the prompt, and keep every click on it silent, for as
 * long as it hung. A step past its deadline is a failure like any other:
 * "try again", and the prompt is open again. A redraw past it is logged, and
 * the answer still stands. The answer itself is the exception: past its
 * deadline it may still act (an approve that lands late), so a retry could
 * be a second answer (Allow, then Deny: approved AND dismissed). The click
 * ends at the deadline and tells the asker it's still going
 * (`COPY.promptStillWorking`), but the prompt stays taken until the answer
 * settles, and then ends as that answer says. One that never settles holds
 * it only until the registry lets a taken prompt go (prompts.ts).
 *
 * What the bot says here is COPY only. An answer's `line` is a COPY line
 * too: it is drawn as mrkdwn where the buttons were, and is the message's
 * notification text. A prompt's subject is redrawn from the raw text the
 * prompt was drawn from, never a cleaned copy (blocks.ts).
 *
 * Logs name the install, the subject's kind, and a reason, stage, action or
 * code (`slack_prompt_*`): never a Slack id, an email, a prompt or decision
 * id, the subject, or an error's message.
 */

/** What one answer did: the line the prompt now shows, and work that follows it (never awaited by the route). */
export interface Answer {
  /**
   * A COPY line, never text from outside: it takes the buttons' place as
   * mrkdwn, and is the message's notification text.
   */
  line: string;
  /** False when the prompt should stay answerable (a transient failure the asker can retry). */
  settle: boolean;
  follow?: () => void;
}

export type SubjectAnswer = (
  ctx: AgentContext,
  prompt: Prompt,
  action: PromptAction,
  extra: { install: InstallRow; botToken: string },
) => Promise<Answer>;

export interface AnswerDeps {
  bus: HookBus;
  api: SlackApi;
  secrets: Pick<SecretStore, 'get'>;
  prompts: PromptRegistry;
  channels: Pick<ChannelStore, 'get'>;
  /** The web app's origin, for the Today link. */
  publicOrigin: string;
  logger: Logger;
  /** One per subject kind. PR A registers `decision`; PR B adds `host` and `skill`. */
  answers: Partial<Record<PromptSubject['kind'], SubjectAnswer>>;
}

const SESSION = 'channel-slack';

/** A step that took longer than PROMPT_STEP_TIMEOUT_MS. Its code is all that is logged. */
class StepTimeoutError extends Error {
  readonly code = 'timeout';
  constructor() {
    super('channel-slack: a step of a click took too long');
    this.name = 'StepTimeoutError';
  }
}

/**
 * `work`'s answer, or a StepTimeoutError once PROMPT_STEP_TIMEOUT_MS has
 * passed. The timer is cleared either way, so an answered click leaves none
 * behind; a late answer, or a late failure, of the abandoned work is ignored.
 */
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError()), PROMPT_STEP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A ctx for a lookup about a person, before the answer: no agent, and the AX user once known. */
const lookupCtx = (userId: string, logger: Logger): AgentContext =>
  makeAgentContext({ sessionId: SESSION, agentId: '', userId, logger });

/**
 * Step 7: whether `agents:resolve`'s answer still lets the prompt's user
 * answer for its agent. A DM's agent is the asker's personal agent, which
 * resolves as `'not-team'`; an attended prompt's is the channel's team
 * agent, where only `'yes'` attends (channel-route.ts `decideTier`).
 */
function reaches(mode: Prompt['mode'], access: AgentAccess): boolean {
  return access === 'yes' || (mode === 'dm' && access === 'not-team');
}

export function createClickHandler(d: AnswerDeps): ClickHandler {
  const todayLink = `${d.publicOrigin}/workspace`;

  return async (install, click) => {
    const installId = install.installId;
    const log = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, string | boolean>): void => {
      try {
        d.logger[level](msg, { installId, ...fields });
      } catch {
        // A log line never changes what a click does.
      }
    };

    // 1. The bot token. Nothing can be said without it, so nothing is taken.
    let botToken: string | null;
    try {
      botToken = await bounded(() => d.secrets.get(install, 'bot-token'));
    } catch (err) {
      log('error', 'slack_prompt_failed', { stage: 'bot-token', code: logCode(err) });
      return;
    }
    if (botToken === null) {
      log('error', 'slack_prompt_failed', { stage: 'bot-token', code: 'missing' });
      return;
    }
    const token = botToken;

    /** A line only the clicker sees, in `threadTs` when there is one. A failure is logged, never thrown. */
    const tell = async (text: string, threadTs: string | null, kind?: PromptSubject['kind']): Promise<void> => {
      try {
        await bounded(() =>
          d.api.postEphemeral(token, {
            channel: click.channel,
            user: click.slackUserId,
            text,
            ...(threadTs !== null ? { threadTs } : {}),
          }),
        );
      } catch (err) {
        log('warn', 'slack_prompt_failed', { ...(kind !== undefined ? { kind } : {}), stage: 'ephemeral', code: logCode(err) });
      }
    };

    // 2. Take the prompt for this click. `gone` and `busy` took nothing, and
    // carry no prompt to name a kind by.
    const claim = d.prompts.claim(click.promptId, click.slackUserId);
    if (!claim.ok && claim.reason !== 'not-asker') {
      log('info', 'slack_prompt_declined', { reason: claim.reason });
      if (claim.reason === 'gone') await tell(COPY.promptGone(todayLink), click.threadTs);
      return;
    }
    const prompt = claim.prompt;
    const kind = prompt.subject.kind;
    const declined = (reason: string, fields: Record<string, string> = {}): void =>
      log('info', 'slack_prompt_declined', { kind, reason, ...fields });

    /** Whether this click holds the prompt's lock: only an `ok` claim took it, and it is let go of once. */
    let held = claim.ok;
    const letGo = (how: 'settle' | 'release'): void => {
      if (!held) return;
      held = false;
      if (how === 'settle') d.prompts.settle(prompt.id);
      else d.prompts.release(prompt.id);
    };

    /** The prompt's message, redrawn with `line` where its buttons were. A failure is logged, never thrown. */
    const redraw = async (line: string): Promise<void> => {
      // A click can beat the prompt's own `posted`: then the message Slack signed as clicked.
      const ts = prompt.messageTs ?? (SLACK_ID_RE.test(click.messageTs) ? click.messageTs : null);
      if (ts === null) {
        log('warn', 'slack_prompt_failed', { kind, stage: 'update', code: 'no-message' });
        return;
      }
      try {
        await bounded(() =>
          d.api.updateMessage(token, {
            channel: prompt.channel,
            ts,
            ...outcomeBlocks({ subject: prompt.subjectText, line }),
          }),
        );
      } catch (err) {
        log('warn', 'slack_prompt_failed', { kind, stage: 'update', code: logCode(err) });
      }
    };

    /** Closed for good: the reason logged, `COPY.promptClosed` where the buttons were, then settled. */
    const close = async (reason: string): Promise<void> => {
      declined(reason);
      await redraw(COPY.promptClosed);
      letGo('settle');
    };

    /** A failure the asker can retry: the prompt is open again before they hear so. */
    const failed = async (stage: string, err: unknown): Promise<void> => {
      letGo('release');
      log('error', 'slack_prompt_failed', { kind, stage, code: logCode(err) });
      await tell(COPY.promptFailed, prompt.threadTs, kind);
    };

    /** Set once the answer outlived its deadline: the lock then waits for that answer, not for this click. */
    let parked = false;

    /**
     * 10. The answer shows where the buttons were, and the prompt is settled.
     * Only an explicit `false` keeps it open: one answer per prompt fails closed.
     */
    const finish = async (out: Answer): Promise<void> => {
      const settled = out.settle !== false;
      if (settled) {
        await redraw(out.line);
        letGo('settle');
      } else {
        // Its buttons stay, so the asker can try again: the line goes to them alone.
        letGo('release');
        await tell(out.line, prompt.threadTs, kind);
      }
      log('info', 'slack_prompt_answered', { kind, action: click.action, settled });
      try {
        out.follow?.();
      } catch (err) {
        log('error', 'slack_prompt_failed', { kind, stage: 'follow', code: logCode(err) });
      }
    };

    /**
     * An answer that outlived its deadline, once it settles: what it says
     * then, after the asker has been told it's still going. Never rejects,
     * and lets go of the prompt whatever happens.
     */
    const landLate = async (running: Promise<Answer>, stillWorking: Promise<void>): Promise<void> => {
      try {
        let out: Answer;
        try {
          out = await running;
        } catch (err) {
          await stillWorking;
          await failed('late-answer', err);
          return;
        }
        await stillWorking;
        await finish(out);
      } catch (err) {
        log('error', 'slack_prompt_failed', { kind, stage: 'late-answer', code: logCode(err) });
      } finally {
        letGo('release');
      }
    };

    try {
      // 3. This install's prompt, in the clicked channel.
      if (prompt.installId !== installId || prompt.channel !== click.channel) {
        letGo('release');
        declined('mismatch');
        return;
      }

      // 4. Only the asker. No users.info and no AX lookup for anyone else.
      if (!claim.ok || click.slackUserId !== prompt.askerSlackId) {
        letGo('release');
        declined('not-asker');
        if (d.prompts.firstRefusal(prompt.id, click.slackUserId)) {
          await tell(COPY.promptOnlyAsker, prompt.threadTs, kind);
        }
        return;
      }

      // 5. The asker, admitted again from users.info.
      const teamId = install.teamId;
      let admission: Admission;
      try {
        admission =
          teamId === null
            ? { ok: false, reason: 'other-workspace' }
            : await bounded(() => admitSender(d.api, token, click.slackUserId, teamId));
      } catch (err) {
        // Only the deadline: admitSender itself never rejects.
        admission = { ok: false, reason: 'lookup-failed', code: logCode(err) };
      }
      if (!admission.ok) {
        letGo('release');
        declined('not-admitted', { code: admission.code ?? admission.reason });
        if (isTemporaryLookupFailure(admission)) await tell(COPY.promptFailed, prompt.threadTs, kind);
        return;
      }
      const email = admission.email;

      // 6. Their verified email still maps to the AX user the turn ran as.
      let mapped: string | null;
      try {
        mapped = await bounded(() => findSenderUser(d.bus, lookupCtx('', d.logger), email, { installId, logger: d.logger }));
      } catch (err) {
        await failed('find-user', err);
        return;
      }
      if (mapped !== prompt.userId) {
        letGo('release');
        declined('not-mapped');
        await tell(COPY.promptOnlyAsker, prompt.threadTs, kind);
        return;
      }

      // 7. That user can still use the agent.
      let access: AgentAccess;
      try {
        access = await bounded(() =>
          agentAccess(d.bus, lookupCtx(prompt.userId, d.logger), prompt.agentId, prompt.userId),
        );
      } catch (err) {
        await failed('agent-access', err);
        return;
      }
      if (!reaches(prompt.mode, access)) {
        await close('no-access');
        return;
      }

      // 8. An attended prompt's channel is still connected to that agent.
      if (prompt.mode === 'attended') {
        let binding: ChannelBinding | null;
        try {
          binding = await bounded(() => d.channels.get(prompt.installId, prompt.channel));
        } catch (err) {
          await failed('binding', err);
          return;
        }
        if (binding === null || binding.agentId !== prompt.agentId) {
          await close('disconnected');
          return;
        }
      }

      // 9. The answer, as the prompt's user, agent and conversation.
      const answer = Object.hasOwn(d.answers, kind) ? d.answers[kind] : undefined;
      if (answer === undefined) {
        await close('unsupported');
        return;
      }
      const ctx = makeAgentContext({
        sessionId: SESSION,
        agentId: prompt.agentId,
        userId: prompt.userId,
        conversationId: prompt.conversationId,
        logger: d.logger,
      });
      // Called once, whatever its deadline says: past it, the answer may still act.
      const running = (async () => answer(ctx, prompt, click.action, { install, botToken: token }))();
      let out: Answer;
      try {
        out = await bounded(() => running);
      } catch (err) {
        if (!(err instanceof StepTimeoutError)) {
          await failed('answer', err);
          return;
        }
        // Past its deadline, the answer may still land (an approve, say), and
        // a retry would then be a second answer. So the prompt stays taken
        // until it settles, and this click hands its lock to the wait: the
        // asker's next click is the silent busy one. An answer that never
        // settles holds it no longer than the registry lets a taken prompt
        // outlive its expiry (prompts.ts).
        parked = true;
        log('warn', 'slack_prompt_failed', { kind, stage: 'answer', code: logCode(err) });
        const stillWorking = tell(COPY.promptStillWorking, prompt.threadTs, kind);
        void landLate(running, stillWorking);
        await stillWorking;
        return;
      }
      await finish(out);
    } finally {
      // A parked click's lock belongs to its late answer (`landLate`).
      if (!parked) letGo('release');
    }
  };
}
