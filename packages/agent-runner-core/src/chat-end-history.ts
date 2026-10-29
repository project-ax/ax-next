import { CHAT_END_MESSAGES_MAX, type AgentMessage } from '@ax/ipc-protocol';

// This is a bounded recent-text projection for chat:end subscribers, not the
// canonical transcript. Reserve half the 4 MiB wire frame for its envelope
// and other outcome fields. Count serialized JSON bytes, including escaping.
export const MAX_CHAT_END_HISTORY_BYTES = 2 * 1024 * 1024;
const SHORTENED = '\n[Message shortened for the final chat summary.]';

function fit(message: AgentMessage): { message: AgentMessage; bytes: number; shortened: boolean } {
  const limit = MAX_CHAT_END_HISTORY_BYTES - 2;
  if (message.content.length <= limit) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes <= limit) return { message, bytes, shortened: false };
  }
  // JSON's escaped UTF-8 cost per code point. Iteration never splits a
  // surrogate pair; an unpaired surrogate is JSON-escaped into six bytes.
  let remaining = limit - Buffer.byteLength(JSON.stringify({ role: message.role, content: SHORTENED }));
  let end = 0;
  for (const char of message.content) {
    const cp = char.codePointAt(0)!;
    const cost = cp === 34 || cp === 92 || [8, 9, 10, 12, 13].includes(cp) ? 2
      : cp < 32 || (cp >= 0xd800 && cp <= 0xdfff) ? 6
        : cp < 128 ? 1 : cp < 2048 ? 2 : cp <= 0xffff ? 3 : 4;
    if (cost > remaining) break;
    remaining -= cost;
    end += char.length;
  }
  const clipped = { role: message.role, content: message.content.slice(0, end) + SHORTENED };
  return { message: clipped, bytes: Buffer.byteLength(JSON.stringify(clipped)), shortened: true };
}

export class ChatEndHistory {
  private entries: Array<{ message: AgentMessage; bytes: number }> = [];
  private head = 0;
  private bytes = 2;
  dropped = 0;
  shortened = 0;

  push(message: AgentMessage): void {
    const entry = fit(message);
    if (entry.shortened) this.shortened++;
    const count = this.entries.length - this.head;
    this.entries.push(entry);
    this.bytes += entry.bytes + (count > 0 ? 1 : 0);
    while (this.bytes > MAX_CHAT_END_HISTORY_BYTES || this.entries.length - this.head > CHAT_END_MESSAGES_MAX) {
      this.bytes -= this.entries[this.head++]!.bytes + (this.entries.length > this.head ? 1 : 0);
      this.dropped++;
    }
    if (this.head > 1024 && this.head * 2 >= this.entries.length) {
      this.entries = this.entries.slice(this.head);
      this.head = 0;
    }
  }

  messages(): AgentMessage[] {
    return this.entries.slice(this.head).map(entry => entry.message);
  }
}
