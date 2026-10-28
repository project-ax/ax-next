import { expect, it } from 'vitest';
import { ChatEndHistory, MAX_CHAT_END_HISTORY_BYTES } from '../chat-end-history.js';

it('keeps ordinary messages unchanged and in order', () => {
  const history = new ChatEndHistory();
  history.push({ role: 'user', content: 'hello' });
  history.push({ role: 'assistant', content: 'hi' });
  expect(history.messages()).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
  expect(history.dropped).toBe(0);
  expect(history.shortened).toBe(0);
  expect(MAX_CHAT_END_HISTORY_BYTES).toBe(2 * 1024 * 1024);
});

it.each(['\u{1f642}', '\\', '"', '\n', '\u0000', '\ud800'])('bounds JSON bytes and marks a shortened %j message', char => {
  const history = new ChatEndHistory();
  history.push({ role: 'assistant', content: char.repeat(2 * 1024 * 1024) });
  const messages = history.messages();
  expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.content).toContain('[Message shortened for the final chat summary.]');
  expect(history.shortened).toBe(1);
});

it('retains the newest whole messages when earlier context exceeds the budget', () => {
  const history = new ChatEndHistory();
  for (let i = 0; i < 20; i++) history.push({ role: 'assistant', content: `${i}:` + 'x'.repeat(200_000) });
  expect(history.dropped).toBeGreaterThan(0);
  expect(history.messages().at(-1)!.content.startsWith('19:')).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(history.messages()))).toBeLessThanOrEqual(2 * 1024 * 1024);
});

it('also respects the wire message-count limit for tiny messages', () => {
  const history = new ChatEndHistory();
  for (let i = 0; i < 60_000; i++) history.push({ role: 'user', content: '' });
  expect(history.messages()).toHaveLength(50_000);
  expect(history.dropped).toBe(10_000);
  expect(Buffer.byteLength(JSON.stringify(history.messages()))).toBeLessThanOrEqual(2 * 1024 * 1024);
});
