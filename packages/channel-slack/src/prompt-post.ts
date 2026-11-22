import { clampCodeUnits, type Logger } from '@ax/core';
import { linkOnlyBlocks, promptBlocks } from './blocks.js';
import { PROMPT_SUBJECT_MAX, REPLY_RATE_LIMIT_RETRIES, RETRY_AFTER_DEFAULT_MS } from './limits.js';
import { logCode } from './log-code.js';
import type { PromptContext, PromptRegistry, PromptSubject } from './prompts.js';
import type { ReplyClock } from './reply-stream.js';
import { SlackApiError, type SlackApi } from './slack-api.js';

/**
 * Posting an approval prompt (TASK-1095): the prompt is opened in the
 * registry (prompts.ts), which mints the id both buttons carry, then drawn
 * (blocks.ts `promptBlocks`) and posted in the turn's thread.
 *
 *   - Posted: the registry records the message's ts, so an answer can redraw
 *     it. True.
 *   - Not posted, for any reason: nothing is left open, so the id is gone
 *     and its buttons, should Slack have shown them after all (a post that
 *     timed out may have landed), point at Today. The registry refusing the
 *     prompt (`add` throws a PromptRegistryError: an outsider's turn, a full
 *     registry, a field it won't keep) counts the same: nothing is posted.
 *     Logged as `slack_reply_failed` with stage `prompt` and a code. False,
 *     and what happens instead is the caller's: a request that waits in
 *     Today (a held call, a skill) gets the Today line instead; a host
 *     prompt has nothing to fall back to (no Today item exists for it).
 *   - `ratelimited`: sent again after Slack's Retry-After, up to
 *     REPLY_RATE_LIMIT_RETRIES times, as a reply's own posts are
 *     (reply-stream.ts).
 *
 * The subject is outside text (a decision's summary, say). It is cut to
 * PROMPT_SUBJECT_MAX once, here, and that one string is what the registry
 * keeps and what the prompt is drawn from: the registry bounds how many
 * prompts it keeps, not how big each one is, and a prompt never shows more
 * than that many code units of its subject anyway. It is kept raw, never
 * cleaned: both draws, the prompt and its answered redraw (answers.ts), clean
 * it themselves, and cleaned text cleaned again reads differently (blocks.ts).
 *
 * A request Slack can't take at all (a skill that needs a key) is posted with
 * `postLinkOnly` instead: its subject and a line sending the person to the
 * web app (blocks.ts `linkOnlyBlocks`), nothing to click, and nothing opened.
 *
 * Never rejects.
 */

export interface PromptPostDeps {
  api: SlackApi;
  botToken: string;
  prompts: PromptRegistry;
  logger: Logger;
  /**
   * Today in the web app: the prompt links it, where the same request waits.
   * Host-built. Null for a request that doesn't wait there (a host the
   * sandbox was refused): the prompt then links nowhere.
   */
  todayLink: string | null;
  /** The turn's clock: a rate limit's wait runs on it. */
  clock: Pick<ReplyClock, 'setTimeout'>;
}

/** `send`, sent again after Slack's Retry-After each time it says `ratelimited`, at most REPLY_RATE_LIMIT_RETRIES times. */
async function retryRateLimited<T>(clock: Pick<ReplyClock, 'setTimeout'>, send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof SlackApiError) || err.code !== 'ratelimited' || attempt >= REPLY_RATE_LIMIT_RETRIES) throw err;
      const wait = err.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS;
      await new Promise<void>((resolve) => {
        clock.setTimeout(resolve, wait);
      });
    }
  }
}

/**
 * Open a prompt for the turn `c` about `subject`, shown as `subjectText`,
 * and post it in the turn's thread. True once it is posted and recorded.
 */
export async function postPrompt(
  d: PromptPostDeps,
  c: PromptContext,
  subject: PromptSubject,
  subjectText: string,
): Promise<boolean> {
  let opened: string | null = null;
  try {
    const text = clampCodeUnits(subjectText, PROMPT_SUBJECT_MAX);
    const prompt = d.prompts.add(c, subject, text);
    opened = prompt.id;
    const drawn = promptBlocks({ subject: text, promptId: prompt.id, todayLink: d.todayLink });
    const { ts } = await retryRateLimited(d.clock, () =>
      d.api.postBlocks(d.botToken, { channel: prompt.channel, threadTs: prompt.threadTs, ...drawn }),
    );
    d.prompts.posted(prompt.id, ts);
    return true;
  } catch (err) {
    if (opened !== null) d.prompts.remove(opened);
    logFailed(d.logger, c.installId, err);
    return false;
  }
}

/**
 * Post a request Slack can't take in the turn's thread: `subjectText` (raw,
 * as for a prompt: the draw cleans it) and `line` (a COPY line sending the
 * person to the web app), with nothing to click. Nothing is opened in the
 * registry. True once posted; else logged as for a prompt, and false.
 */
export async function postLinkOnly(
  d: Pick<PromptPostDeps, 'api' | 'botToken' | 'logger' | 'clock'>,
  c: Pick<PromptContext, 'installId' | 'channel' | 'threadTs'>,
  subjectText: string,
  line: string,
): Promise<boolean> {
  try {
    const drawn = linkOnlyBlocks({ subject: subjectText, line });
    await retryRateLimited(d.clock, () => d.api.postBlocks(d.botToken, { channel: c.channel, threadTs: c.threadTs, ...drawn }));
    return true;
  } catch (err) {
    logFailed(d.logger, c.installId, err);
    return false;
  }
}

/**
 * Post a plain markdown line in the turn's thread, sent again after Slack's
 * Retry-After when it says `ratelimited`, as a prompt is: it comes right
 * after them, in the same burst. Throws what the last try threw; the caller
 * logs it.
 */
export async function postLine(
  d: Pick<PromptPostDeps, 'api' | 'botToken' | 'clock'>,
  c: Pick<PromptContext, 'channel' | 'threadTs'>,
  markdownText: string,
): Promise<void> {
  await retryRateLimited(d.clock, () => d.api.postMessage(d.botToken, { channel: c.channel, threadTs: c.threadTs, markdownText }));
}

/** A post that didn't land: `slack_reply_failed`, stage `prompt`, by code. */
function logFailed(logger: Logger, installId: string, err: unknown): void {
  try {
    logger.warn('slack_reply_failed', { installId, stage: 'prompt', code: logCode(err) });
  } catch {
    // A log line never changes the turn.
  }
}
