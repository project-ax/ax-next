import { describe, expect, it, vi } from 'vitest';
import { redirectRetiredChatPath } from '../retired-chat-path';

function at(pathname: string, search = '', hash = '') {
  const replaceState = vi.fn();
  return {
    location: { pathname, search, hash },
    history: { replaceState },
  };
}

describe('redirectRetiredChatPath (TASK-360)', () => {
  it.each(['/chat', '/chat/', '/chat/conv-123', '/chat/a/b/c'])(
    '%s lands on / with a REPLACE',
    (path) => {
      const w = at(path);
      expect(redirectRetiredChatPath(w.location, w.history)).toBe(true);
      expect(w.history.replaceState).toHaveBeenCalledTimes(1);
      expect(w.history.replaceState).toHaveBeenCalledWith(null, '', '/');
    },
  );

  it('preserves NOTHING from the old path — not the query, not the hash', () => {
    // A chat conversation id is not a workspace route; guessing one from it
    // would be worse than landing on Today (card decision).
    const w = at('/chat/conv-1', '?thread=abc', '#m-9');
    redirectRetiredChatPath(w.location, w.history);
    expect(w.history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it.each(['/', '/workspace', '/workspace/agents/a1', '/chatty', '/chats', '/setup', '/workspace/chat'])(
    'leaves %s alone',
    (path) => {
      const w = at(path);
      expect(redirectRetiredChatPath(w.location, w.history)).toBe(false);
      expect(w.history.replaceState).not.toHaveBeenCalled();
    },
  );
});
