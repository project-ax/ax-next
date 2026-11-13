import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';

const ORIGIN = 'https://canopyworks.ai';
const LINK = 'https://canopyworks.ai/workspace/agents/agt_123';

/** Every string the bot can say, with the link-taking ones filled in. */
function everyLine(): Array<[string, string]> {
  return Object.entries(COPY).map(([key, value]) => {
    if (typeof value === 'string') return [key, value];
    return [key, key === 'artifactLink' ? value(LINK) : value(ORIGIN)];
  });
}

describe('COPY: everything the bot says in Slack', () => {
  it('has exactly the lines the plan names', () => {
    expect(Object.keys(COPY).sort()).toEqual(
      [
        'artifactLink',
        'busy',
        'emptyReply',
        'filesUnsupported',
        'mentionRefusal',
        'noAgent',
        'notMapped',
        'queueFull',
        'statusDefault',
        'turnFailed',
      ].sort(),
    );
  });

  it('never names the product: the deployment is white-labeled through Branding', () => {
    for (const [key, line] of everyLine()) expect(line, key).not.toMatch(/\bAX\b/);
  });

  it('never pings anyone or a channel: no <!, <@ or <# anywhere', () => {
    for (const [key, line] of everyLine()) expect(line, key).not.toMatch(/<[!@#]/);
  });

  it('the sign-in and make-an-agent lines link to the web app', () => {
    expect(COPY.notMapped(ORIGIN)).toContain(`](${ORIGIN})`);
    expect(COPY.noAgent(ORIGIN)).toContain(`](${ORIGIN})`);
    expect(COPY.artifactLink(LINK)).toContain(`](${LINK})`);
  });
});
