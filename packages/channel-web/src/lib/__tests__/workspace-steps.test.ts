/**
 * The one shaping function both workspace paths call.
 *
 * Everything here is about what a reader ends up believing: that a failed step
 * says it failed, that a held one says it is waiting on them, that the header's
 * number is the number of rows underneath it, and that no MCP wire name ever
 * reaches the screen.
 */
import { describe, expect, it } from 'vitest';
import {
  STEP_DETAIL_MAX_CHARS,
  STEP_NAME_MAX_CHARS,
  UNNAMED_STEP,
  applyToolResult,
  applyToolUse,
  settleHolds,
  shapeSteps,
  stepDetail,
  type WorkspaceToolCall,
} from '../workspace-steps';

const done = (over: Partial<WorkspaceToolCall> = {}): WorkspaceToolCall => ({
  id: 'tu1',
  name: 'Bash',
  status: 'done',
  ...over,
});

/**
 * The SENTENCES a panel draws.
 *
 * A row is `{ text, status }` since TASK-419 — the status is what lets the
 * renderer mark a failure in the destructive token instead of leaving it the
 * same grey as a success. Most cases here are about the wording, so they read
 * the wording; the ones about the status say so and read `.steps` directly.
 */
const texts = (panel: { steps: Array<{ text: string }> } | null): string[] =>
  (panel?.steps ?? []).map((s) => s.text);

describe('shapeSteps', () => {
  it('is null for a turn that ran nothing, so no empty disclosure appears', () => {
    expect(shapeSteps([])).toBeNull();
  });

  it('names a call by its host-authored phrase, never by the mcp wire name', () => {
    const panel = shapeSteps([
      done({ name: 'mcp__linear__create_issue', phrase: 'Filing a Linear issue' }),
    ]);
    expect(texts(panel)).toEqual(['Filing a Linear issue']);
  });

  it('falls back to the STRIPPED tool name when there is no phrase', () => {
    const panel = shapeSteps([done({ name: 'mcp__ax-sandbox-tools__artifact_publish' })]);
    expect(texts(panel)).toEqual(['artifact_publish']);
  });

  it('keeps a row, named, when nothing legible survives fencing', () => {
    // A tool name made entirely of the characters that rewrite a surface. The
    // row still appears: a shorter list would disagree with what happened.
    const panel = shapeSteps([done({ name: '\u202E\u200B' })]);
    expect(texts(panel)).toEqual([UNNAMED_STEP]);
  });

  it('flattens a name that tries to rewrite the line it sits on', () => {
    const panel = shapeSteps([done({ phrase: 'Reading\u202Egnp.dorp-eteled' })]);
    expect(texts(panel)[0]).toBe('Reading gnp.dorp-eteled');
    expect(texts(panel)[0]).not.toContain('\u202E');
  });

  it('bounds a name that arrived without one', () => {
    const panel = shapeSteps([done({ phrase: 'x'.repeat(500) })]);
    expect(texts(panel)[0]?.length).toBeLessThanOrEqual(STEP_NAME_MAX_CHARS);
    expect(texts(panel)[0]?.endsWith('…')).toBe(true);
  });

  it('says a failed step failed, in words, not only in colour', () => {
    const panel = shapeSteps([done({ status: 'failed', phrase: 'Sending the email' })]);
    expect(texts(panel)).toEqual(["Sending the email — didn't finish"]);
    expect(panel?.label).toBe("1 step, 1 didn't finish");
  });

  it('says a held step is waiting on the reader', () => {
    const panel = shapeSteps([done({ status: 'waiting', phrase: 'Sending the email' })]);
    expect(texts(panel)).toEqual(['Sending the email — waiting for you']);
    expect(panel?.label).toBe('1 step, 1 waiting for you');
  });

  it('says a step still in flight is in progress', () => {
    const panel = shapeSteps([done({ status: 'running', phrase: 'Searching the web' })]);
    expect(texts(panel)).toEqual(['Searching the web — in progress']);
    expect(panel?.label).toBe('1 step, 1 in progress');
  });

  it('leads with the failure when a panel holds both a failure and a hold', () => {
    /*
      Across a panel, failure outranks a hold — the hold has the composer line
      and the approval card to announce itself, the failure has nowhere else.
      Per CALL the ordering is the other way round, which the two rows show.
    */
    const panel = shapeSteps([
      done({ id: 'a', status: 'waiting', phrase: 'Sending the email' }),
      done({ id: 'b', status: 'failed', phrase: 'Reading the calendar' }),
    ]);
    expect(panel?.label).toBe("2 steps, 1 didn't finish");
    expect(texts(panel)).toEqual([
      'Sending the email — waiting for you',
      "Reading the calendar — didn't finish",
    ]);
  });

  it('reports the count it renders, for every size', () => {
    for (const n of [1, 2, 7]) {
      const calls = Array.from({ length: n }, (_, i) => done({ id: `tu${i}` }));
      const panel = shapeSteps(calls);
      expect(panel).not.toBeNull();
      const reported = /^(\d+) steps?\b/.exec(panel!.label);
      expect(reported).not.toBeNull();
      expect(Number(reported![1])).toBe(panel!.steps.length);
      expect(panel!.steps).toHaveLength(n);
    }
  });
});

describe('the live accumulator', () => {
  it('starts a fresh call as running — a call made is not a call finished', () => {
    // `running` is the internal status word; the rendered row says "in progress".
    const calls = applyToolUse([], {
      toolCallId: 'tu1',
      toolName: 'Bash',
      activityPhrase: 'Running a command',
    });
    expect(calls).toEqual([
      { id: 'tu1', name: 'Bash', phrase: 'Running a command', status: 'running' },
    ]);
  });

  it('does not double-count a replayed tool-use', () => {
    const frame = { toolCallId: 'tu1', toolName: 'Bash', activityPhrase: undefined };
    const once = applyToolUse([], frame);
    const twice = applyToolUse(once, frame);
    expect(twice).toHaveLength(1);
  });

  it('does not walk a settled row back to running on a replay', () => {
    const frame = { toolCallId: 'tu1', toolName: 'Bash', activityPhrase: undefined };
    const settled = applyToolResult(applyToolUse([], frame), {
      toolCallId: 'tu1',
      isError: true,
    });
    expect(applyToolUse(settled, frame)[0]?.status).toBe('failed');
  });

  it('revises the row a result answers, rather than adding a second one', () => {
    const calls = applyToolResult(
      applyToolUse([], { toolCallId: 'tu1', toolName: 'Bash' }),
      { toolCallId: 'tu1' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('done');
  });

  it('reads a held result as waiting even when it also carries an error', () => {
    // The runners omit `is_error` on a hold, but a stale or foreign row
    // carrying both must still read as waiting on a person, not as a failure.
    const calls = applyToolResult(
      applyToolUse([], { toolCallId: 'tu1', toolName: 'Bash' }),
      { toolCallId: 'tu1', isError: true, held: true },
    );
    expect(calls[0]?.status).toBe('waiting');
  });

  it('drops a result for a call it never saw rather than inventing a row', () => {
    const calls = applyToolResult([], { toolCallId: 'ghost' });
    expect(calls).toEqual([]);
  });

  it('keeps call order, so the panel reads in the order things happened', () => {
    let calls = applyToolUse([], { toolCallId: 'a', toolName: 'First' });
    calls = applyToolUse(calls, { toolCallId: 'b', toolName: 'Second' });
    calls = applyToolResult(calls, { toolCallId: 'b' });
    calls = applyToolResult(calls, { toolCallId: 'a' });
    expect(texts(shapeSteps(calls))).toEqual(['First', 'Second']);
  });
});

/**
 * TASK-419: the rows have to tell two calls to the SAME tool apart.
 *
 * The walk found a panel reading `Write`, `Bash`, `Bash` — a list that reports
 * a count and nothing else. The count was right and the rows were useless, so
 * the defect is in what a row SAYS, not in whether it appears.
 */
describe('telling one call from the next', () => {
  it('draws two Bash calls as two DIFFERENT rows', () => {
    const rows = shapeSteps([
      done({ id: 'a', detail: stepDetail({ command: 'pnpm build' }) }),
      done({ id: 'b', detail: stepDetail({ command: 'pnpm test' }) }),
    ])!.steps.map((step) => step.text);
    expect(rows).toEqual(['Bash: pnpm build', 'Bash: pnpm test']);
    // The assertion the card is actually about: not "they read nicely", but
    // "they do not read the same".
    expect(rows[0]).not.toBe(rows[1]);
  });

  it('still says which one when the call is mid-flight or failed', () => {
    // The status suffix keeps its em dash, and the detail keeps its colon, so
    // the two halves cannot be mistaken for each other.
    const panel = shapeSteps([
      { id: 'a', name: 'Bash', detail: 'pnpm build', status: 'running' },
      { id: 'b', name: 'Bash', detail: 'pnpm test', status: 'failed' },
    ]);
    expect(texts(panel)).toEqual([
      'Bash: pnpm build — in progress',
      'Bash: pnpm test — didn\'t finish',
    ]);
  });

  it('leaves a row bare rather than ending it in a dangling separator', () => {
    // A tool whose input has no string in it at all (`TodoWrite` takes a list).
    // There is no "which one" to show, so the row is just the name.
    expect(stepDetail({ todos: [] })).toBeUndefined();
    expect(texts(shapeSteps([done({ detail: stepDetail({ todos: [] }) })]))).toEqual([
      'Bash',
    ]);
  });

  it('hands the renderer the STATE of each row, not just its words', () => {
    /*
      TASK-419 again, the third half of it. A failed step used to arrive as a
      plain string, so the renderer had nothing to mark it with and drew it in
      the same grey as a success — the difference lived entirely in three
      trailing words. Anything that wanted to colour the row would have had to
      match our own copy back out of it, which is two modules owning one
      sentence. The status rides along instead.
    */
    const panel = shapeSteps([
      done({ id: 'a' }),
      { id: 'b', name: 'Bash', status: 'failed' },
      { id: 'c', name: 'Bash', status: 'waiting' },
      { id: 'd', name: 'Bash', status: 'running' },
    ]);
    expect(panel?.steps.map((s) => s.status)).toEqual([
      'done',
      'failed',
      'waiting',
      'running',
    ]);
  });

  it('qualifies a host-authored phrase too, not only a bare tool name', () => {
    const panel = shapeSteps([
      done({
        name: 'mcp__linear__create_issue',
        phrase: 'Filing a Linear issue',
        detail: stepDetail({ title: 'Login is broken' }),
      }),
    ]);
    expect(texts(panel)).toEqual(['Filing a Linear issue: Login is broken']);
  });
});

describe('stepDetail', () => {
  it('picks the argument a person would ask about first', () => {
    // `command` over everything, then the path, then what was searched for.
    expect(stepDetail({ description: 'run the build', command: 'pnpm build' })).toBe(
      'pnpm build',
    );
    expect(stepDetail({ content: 'the whole file', file_path: 'src/app.ts' })).toBe(
      'src/app.ts',
    );
    expect(stepDetail({ pattern: 'TODO', output_mode: 'files' })).toBe('TODO');
    expect(stepDetail({ url: 'https://example.com/x' })).toBe('https://example.com/x');
  });

  it('never picks the file BODY over the file path', () => {
    // The one mistake that would turn a step list back into a wall of text.
    expect(stepDetail({ file_path: 'src/app.ts', content: 'x'.repeat(5000) })).toBe(
      'src/app.ts',
    );
  });

  it('falls back to the first string an unknown tool carries', () => {
    // MCP servers name their arguments whatever they like; a fixed list cannot
    // enumerate them, and a row with no qualifier at all is the thing we are
    // fixing.
    expect(stepDetail({ issueId: 'LIN-4', teamKey: 'ENG' })).toBe('LIN-4');
  });

  it('has nothing to say about an input that is not an object of arguments', () => {
    expect(stepDetail(undefined)).toBeUndefined();
    expect(stepDetail(null)).toBeUndefined();
    expect(stepDetail('pnpm build')).toBeUndefined();
    expect(stepDetail(['pnpm build'])).toBeUndefined();
    expect(stepDetail({ limit: 5, deep: true })).toBeUndefined();
  });

  it('fences the model\'s own words before they reach a row', () => {
    // This string is authored by the MODEL — it is whatever it decided to put
    // in the tool's arguments. React escapes markup, so the risk was never
    // script; it is a row that reorders what the reader sees (`fence-line.ts`).
    const fenced = stepDetail({ command: 'rm\u202Egnp.dorp-eteled' })!;
    expect(fenced).not.toContain('\u202E');
    expect(fenced).toBe('rm gnp.dorp-eteled');
  });

  it('bounds a detail that arrived without a bound, and marks the cut', () => {
    const long = stepDetail({ command: 'x'.repeat(5000) })!;
    expect([...long]).toHaveLength(STEP_DETAIL_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps the qualifier cap BELOW the name cap, so a secret that slipped the name guard stays masked', () => {
    /*
      REVIEW FINDING on this card. The first draft collapsed both caps into one
      200, which is a widening dressed up as a simplification: `namesASecret`
      filters key NAMES, so a credential under an innocent one (`value`, `arg`)
      still reaches the fallback — and `fenceLine` returns a value UNCHANGED
      when it fits. At 200 a 148-character token came out entire; at 120 it is
      a masked prefix. The ordering is the invariant, not the numbers.
    */
    expect(STEP_DETAIL_MAX_CHARS).toBeLessThan(STEP_NAME_MAX_CHARS);
    const token = `sk-live-${'a'.repeat(140)}`;
    const drawn = stepDetail({ value: token })!;
    expect(drawn.endsWith('…')).toBe(true);
    expect(drawn).not.toContain(token);
  });

  it('keeps a realistic deep path whole rather than cutting it (TASK-436)', () => {
    /*
      THE REGRESSION THIS CARD EXISTS FOR. The detail cap was 60, which is
      shorter than an ordinary path inside an agent's workspace — so the row
      read `/permanent/projects/quarterly-review/…` and the rest of the path
      existed NOWHERE on the surface. It was not hidden; it was gone.

      This asserts the value SURVIVES, not that it is visually clamped: the
      clamp is CSS now, and jsdom has neither CSS nor layout, so an assertion
      about the clamp would be vacuous by construction.
    */
    const path =
      '/permanent/projects/quarterly-review/2026-Q3/attachments/regional-breakdown-emea.csv';
    expect(path.length).toBeGreaterThan(60);
    expect(path.length).toBeLessThanOrEqual(STEP_DETAIL_MAX_CHARS);
    expect(stepDetail({ file_path: path })).toBe(path);
  });

  it('puts the whole row in the step text, uncut, for a long call', () => {
    const path = '/permanent/notes/' + 'a'.repeat(80) + '.md';
    const panel = shapeSteps([
      { id: 'c1', name: 'Read', detail: stepDetail({ file_path: path }), status: 'done' },
    ])!;
    expect(panel.steps[0]!.text).toBe(`Read: ${path}`);
    expect(panel.steps[0]!.text).not.toContain('…');
  });

  it('never lets an argument that names a secret qualify the row', () => {
    /*
      Review finding on this card. The fallback takes the first string an
      unknown tool carries, and MCP servers name their arguments whatever they
      like — so `{ token: 'sk-live-…' }` drew a row that was the leading
      characters of a live token. The guard is on the NAME, matched word by
      word, and a skipped key hands the choice to the next candidate.
    */
    expect(stepDetail({ token: 'sk-live-abcdef', resource: 'issues' })).toBe('issues');
    expect(stepDetail({ apiKey: 'sk-live-abcdef', project: 'ax' })).toBe('ax');
    expect(stepDetail({ API_KEY: 'sk-live-abcdef', project: 'ax' })).toBe('ax');
    expect(stepDetail({ 'x-auth-token': 'sk-live-abcdef', q: 'ax' })).toBe('ax');
    // Nothing else to fall back to: the row keeps its bare name rather than
    // showing the secret, which is where it was before this card.
    expect(stepDetail({ password: 'hunter2' })).toBeUndefined();
  });

  it.each([
    // The smushed spellings. The splitter cannot break these apart, so they
    // have to be in the set by name — and the first version of this guard
    // leaked on every one of them while catching `apiKey` / `api_key` /
    // `API_KEY`. `apikey` is the smushed form of the guard's own motivating
    // example, which is the part that made this worth a second pass.
    'apikey',
    'APIKEY',
    'apitoken',
    'APITOKEN',
    'authtoken',
    'accesskey',
    'accesstoken',
    'secretkey',
    'privatekey',
    'sessiontoken',
    'clientsecret',
    'refreshtoken',
    // The abbreviations. Whole-word matching means `pass` does not eat
    // `passenger` any more than `key` eats `keyword`, so leaving these out was
    // never required by the anti-substring rule — and `pwd` and `pass` are
    // among the commonest secret field names there are.
    'pwd',
    'pass',
    'pat',
    'creds',
    'cred',
    'sig',
  ])('refuses to qualify a row from an argument named %s', (key) => {
    expect(stepDetail({ [key]: 'sk-live-abcdef', resource: 'issues' })).toBe('issues');
    // With nothing else to fall back to the row keeps its bare name. It must
    // never be the secret, and it must never be a PREFIX of the secret.
    expect(stepDetail({ [key]: 'sk-live-abcdef' })).toBeUndefined();
  });

  it('still shows a session id, which is a handle and not a credential', () => {
    /*
      Deliberate: `session` is NOT in the set. A session TOKEN is covered by
      `token` in every spelling with a boundary and by `sessiontoken` in the
      one without, while `session` on its own would blank `sessionId` — a
      correlation handle, and a genuinely useful qualifier on the one surface
      whose job is to say which call this was.
    */
    expect(stepDetail({ sessionId: 'sess_9f2a' })).toBe('sess_9f2a');
    expect(stepDetail({ sessionToken: 'sk-live-abcdef', q: 'ax' })).toBe('ax');
    expect(stepDetail({ session_token: 'sk-live-abcdef', q: 'ax' })).toBe('ax');
    expect(stepDetail({ sessiontoken: 'sk-live-abcdef', q: 'ax' })).toBe('ax');
  });

  it('does not mistake an ordinary word for a secret', () => {
    /*
      Word by word, not substring: these are all legitimate qualifiers, and a
      guard that ate them would quietly take rows back to saying nothing.

      This case passes whether or not `namesASecret` runs, so it does not
      exercise the guard — it is kept deliberately, as the thing that fails if
      somebody ever "generalises" the rule into a substring or suffix match.
      `monkey` is the one that matters: "ends with `key`" would catch `apikey`
      and `monkey` alike, which is why the smushed forms are enumerated instead.
    */
    expect(stepDetail({ keyword: 'invoice' })).toBe('invoice');
    expect(stepDetail({ passenger: 'Ada' })).toBe('Ada');
    expect(stepDetail({ authored: 'yes' })).toBe('yes');
    expect(stepDetail({ monkey: 'Bobo' })).toBe('Bobo');
    expect(stepDetail({ path: '/tmp/x' })).toBe('/tmp/x');
    expect(stepDetail({ sigma: '3' })).toBe('3');
  });

  it('skips a key whose value fences down to nothing', () => {
    // An all-invisible command is the same absence as a missing one, so the
    // next candidate gets its turn rather than the row ending in a colon.
    expect(stepDetail({ command: '\u200B\u202E', file_path: 'src/app.ts' })).toBe(
      'src/app.ts',
    );
  });
});

describe('settleHolds — a hold the person has since answered (TASK-517)', () => {
  const held = (over: Partial<WorkspaceToolCall> = {}): WorkspaceToolCall =>
    done({ status: 'waiting', phrase: 'Reading a web page', ...over });
  const none = { callIds: new Set<string>(), toolNames: new Set<string>() };

  it('a settled hold does not render the waiting qualifier', () => {
    const panel = shapeSteps(settleHolds([held()], none));
    expect(texts(panel)).toEqual(['Reading a web page — no longer waiting for you']);
    expect(panel?.steps[0]?.status).toBe('settled');
    // And the header stops counting it as waiting.
    expect(panel?.label).toBe('1 step');
  });

  it('a hold whose call id is still open stays waiting', () => {
    const calls = settleHolds([held({ id: 'tu1' })], {
      callIds: new Set(['tu1']),
      toolNames: new Set(),
    });
    expect(calls[0]?.status).toBe('waiting');
  });

  it('a hold whose TOOL still has an open decision stays waiting, prefix or not', () => {
    // The re-held call (TASK-254) carries a different id from the row's.
    const calls = settleHolds([held({ id: 'tu2', name: 'mcp__ax-host-tools__web_extract' })], {
      callIds: new Set(['tu1']),
      toolNames: new Set(['web_extract']),
    });
    expect(calls[0]?.status).toBe('waiting');
  });

  it('an UNKNOWN set of open decisions settles nothing', () => {
    // A failed read is not "nothing is open"; the old reading stands.
    expect(settleHolds([held()], null)[0]?.status).toBe('waiting');
  });

  it('touches only held rows', () => {
    const calls = settleHolds(
      [done({ id: 'a' }), done({ id: 'b', status: 'failed' }), done({ id: 'c', status: 'running' })],
      none,
    );
    expect(calls.map((c) => c.status)).toEqual(['done', 'failed', 'running']);
  });
});
