// Stub. Real implementation lands in the next commit.
import type { ContentBlock } from '@ax/ipc-protocol';

export type ParsedTurnRole = 'user' | 'assistant';

export interface ParsedTurn {
  turnId: string;
  turnIndex: number;
  role: ParsedTurnRole;
  contentBlocks: ContentBlock[];
  createdAt: string;
}

export function parseJsonlToTurns(_bytes: Uint8Array): ParsedTurn[] {
  return [];
}
