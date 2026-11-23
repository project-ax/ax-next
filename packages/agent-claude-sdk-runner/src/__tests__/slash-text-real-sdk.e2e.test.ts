import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepSlashAsText, SLASH_TEXT_GUARD } from '../slash-text.js';
import { stripClaudeCodeEnv } from './real-sdk-env.js';
import {
  HAVE_BINARY,
  lastUserBlockText,
  makeSandboxDirs,
  mainFloors,
  openSession,
  removeTree,
  startScriptedServer,
  type ScriptedServer,
  type Session,
} from './scripted-model.js';

// ---------------------------------------------------------------------------
// TASK-1217 item 3 — what the CLI does with a turn whose text starts with `/`,
// on the REAL claude binary (plan M8). In SDK streaming mode the CLI treats it
// as a slash command:
//   - `/update-config …` / `/simplify` are expanded into the bundled skill's
//     prompt with NO `Skill` call, so `tool.pre-call` never sees them;
//   - `/clear` makes no model call and switches the CLI to a NEW session id
//     (the runner keeps the first `system/init` id, so the shipped transcript
//     would stop following the conversation);
//   - `/hello there` (any unknown word) is answered by the CLI itself
//     ("Unknown command: /hello") and the model never sees the message.
// Nothing in AX offers `/` commands, so `keepSlashAsText` puts an invisible
// U+200B in front of any text that starts with `/`; the CLI then reads it as
// words.
//
//   CONTROL  raw strings: expansion, a new session id, "Unknown command".
//   FIX      every prompt goes through the REAL `keepSlashAsText`: each turn
//            makes exactly one agent-loop call whose last user block is
//            U+200B + the original, nothing is expanded, there is one session
//            id throughout, and no result is "Unknown command".
//
// Skips itself when the platform's native binary is not installed.
// ---------------------------------------------------------------------------

let server: ScriptedServer;
let tmp: string;
let files: string;
let cfg: string;

beforeEach(async () => {
  ({ tmp, files, cfg } = await makeSandboxDirs('ax-t1217-slash-'));
  server = await startScriptedServer();
});

afterEach(async () => {
  await server.close();
  await removeTree(tmp);
});

const open = (): Promise<Session> =>
  openSession({ server, cfg, files, env: { ...stripClaudeCodeEnv(), ...mainFloors() } });

/** Agent-loop calls the turn made, counted around `send`. */
async function turn(s: Session, content: unknown): Promise<{ calls: number; result: string; sessionId: string }> {
  const before = server.agentCalls().length;
  const { result } = await s.send(content);
  const text = (result as { result?: unknown }).result;
  return {
    calls: server.agentCalls().length - before,
    result: typeof text === 'string' ? text : '',
    sessionId: String((result as { session_id?: unknown }).session_id),
  };
}

describe.skipIf(!HAVE_BINARY)('a turn that starts with "/" on the real claude-sdk binary (TASK-1217)', () => {
  it('CONTROL: raw, "/update-config" is expanded, "/hello" is swallowed, and "/clear" starts a new session id', async () => {
    const s = await open();
    try {
      const expand = await turn(s, '/update-config add a hook please');
      expect(expand.calls).toBe(1);
      expect(lastUserBlockText(server.agentCalls().at(-1)?.body ?? '{}'), 'the CLI did not expand the command').toContain('## User Request');

      const unknown = await turn(s, '/hello there friend');
      expect(unknown.calls, 'the model must not see a swallowed command').toBe(0);
      expect(unknown.result).toContain('Unknown command: /hello');

      const hello = await turn(s, 'hello');
      expect(hello.calls).toBe(1);
      const clear = await turn(s, '/clear');
      expect(clear.calls, '/clear makes no model call').toBe(0);
      await turn(s, 'after clear');
      const ids = new Set(s.inits().map((i) => String(i['session_id'])));
      expect(ids.size, 'a later system/init should carry a different session id').toBeGreaterThan(1);
    } finally {
      await s.close();
    }
  }, 90_000);

  it('FIX: through keepSlashAsText every turn is words: one model call, no expansion, one session id', async () => {
    const prompts = [
      '/update-config add a hook please',
      '/hello there friend',
      '/clear',
      '/simplify',
      '  /compact',
    ];
    const s = await open();
    try {
      for (const original of prompts) {
        const guarded = keepSlashAsText(original);
        expect(guarded).toBe(`${SLASH_TEXT_GUARD}${original}`);
        const t = await turn(s, guarded);
        expect(t.calls, `${original}: exactly one model call`).toBe(1);
        expect(t.result).not.toContain('Unknown command');
        const last = lastUserBlockText(server.agentCalls().at(-1)?.body ?? '{}');
        expect(last).toBe(`${SLASH_TEXT_GUARD}${original}`);
        expect(last).not.toContain('## User Request');
      }
      // An attachment-style turn: an array of blocks, the text block guarded.
      const arrayTurn = await turn(s, keepSlashAsText([{ type: 'text', text: '/update-config add a hook please' }]));
      expect(arrayTurn.calls).toBe(1);
      expect(lastUserBlockText(server.agentCalls().at(-1)?.body ?? '{}')).toBe(`${SLASH_TEXT_GUARD}/update-config add a hook please`);

      const ids = new Set(s.inits().map((i) => String(i['session_id'])));
      expect(ids.size, 'the CLI switched session ids').toBe(1);
    } finally {
      await s.close();
    }
  }, 90_000);
});
