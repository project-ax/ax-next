/**
 * TASK-336 / audit C3, A13, E3 — the retired user-facing vocabulary, guarded.
 *
 * The product called the same thing three names. A conversation was a
 * "session" on the new-chat button and in the agent menu, a "conversation" in
 * the sidebar, and a "chat" in prose. A key was a "credential" on one button
 * and a "key" on the tab that button lives in. None of it is wrong, exactly —
 * it just makes a reader work out that three words mean one thing.
 *
 * A copy fix does not stay fixed, so this scans the source the way
 * `memory-strata`'s deprecated-model-ids test does. Comments are stripped
 * before scanning, deliberately: a comment explaining what a string USED to say
 * is history worth keeping, while the same text in a rendered literal is
 * something we would actually show someone.
 *
 * The hard boundary this must not cross (invariant 1, and the card's own): this
 * is about DISPLAY STRINGS. `SessionList`, `sessionId`, `/api/chat/sessions`
 * and `session-store` are code and stay exactly as they are — which is why the
 * patterns below are prose, not the word "session" on its own.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

/** Retired phrasing → what replaced it, for the failure message. */
const RETIRED: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /new session/i, replacement: '"New chat"' },
  { pattern: /unknown artifact/i, replacement: '"File unavailable"' },
  { pattern: /update credentials/i, replacement: '"Update key"' },
  { pattern: /set credential\b/i, replacement: '"Add key" / "Replace key"' },
  // Added after the first run of this guard missed `SessionRow`'s delete
  // confirm ("delete this session?"). The three named renames were not the
  // whole sweep, which is the argument for a scanner over a checklist.
  // Deliberately narrow: it must not catch "Your session has ended", which is
  // the sign-in session and is correct.
  { pattern: /this session\b/i, replacement: '"chat" — this one means a conversation' },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Tests are allowed to name the old copy — several assert it is gone.
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip block and line comments. Crude on purpose — it only has to stop a
 * comment's prose from reading as rendered copy, and over-stripping would at
 * worst let something through, which the reviewer still sees in the diff.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('retired user-facing vocabulary', () => {
  it('is gone from every rendered string in channel-web', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const body = withoutComments(readFileSync(file, 'utf8'));
      for (const { pattern, replacement } of RETIRED) {
        for (const line of body.split('\n')) {
          if (pattern.test(line)) {
            offenders.push(
              `${file.slice(SRC.length + 1)}: ${line.trim().slice(0, 90)}\n` +
                `    → use ${replacement}`,
            );
          }
        }
      }
    }
    expect(offenders.join('\n')).toBe('');
  });

  it('leaves the sign-in session alone, because that one IS a session', () => {
    // The guard must not tempt anyone into renaming the thing that ends when
    // you are signed out. `HTTP_SESSION_ENDED` is shared by LoginPage and
    // SignInAgainButton and is correct as it stands.
    const http = readFileSync(join(SRC, 'lib', 'http.ts'), 'utf8');
    expect(http).toContain('Your session has ended.');
  });
});
