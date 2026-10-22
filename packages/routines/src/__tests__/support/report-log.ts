import { expect } from 'vitest';
import { createLogger, type AgentContext } from '@ax/core';

/** Every key a report refusal's log line may carry: the logger's own, a fixed stage and reason, and ids (TASK-907). */
const REFUSAL_LOG_KEYS = ['level', 'ts', 'reqId', 'msg', 'stage', 'reason', 'agentId', 'conversationId', 'dispatchId', 'routineId'];

/** `ctx` with a logger that keeps its lines, so a test reads what an operator would. */
export function logged(ctx: AgentContext): { ctx: AgentContext; lines: string[] } {
  const lines: string[] = [];
  return { ctx: { ...ctx, logger: createLogger({ reqId: ctx.reqId, writer: line => { lines.push(line); } }) }, lines };
}

/**
 * The lines hold exactly one report refusal, at info, with this stage and
 * reason, and nothing but ids beside them. `secret` matches the report's text,
 * which no line may carry.
 */
export function expectOneRefusal(lines: readonly string[], expected: { stage: 'tool' | 'hook'; reason: string }, secret: RegExp, label: string): void {
  const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.msg === 'routines_report_refused');
  expect(entries, label).toEqual([expect.objectContaining({ level: 'info', ...expected })]);
  for (const key of Object.keys(entries[0] ?? {})) expect(REFUSAL_LOG_KEYS, `${label}: ${key}`).toContain(key);
  expect(lines.join('\n'), label).not.toMatch(secret);
}
