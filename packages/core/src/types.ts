import type { Rejection } from './errors.js';

export interface ChatMessageText {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
export type ChatMessage = ChatMessageText;

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  output: unknown;
  isError?: boolean;
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolDescriptor[];
}

export interface LlmResponse {
  assistantMessage: ChatMessage;
  toolCalls: ToolCall[];
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  /**
   * JSON Schema for the tool's input. Used by LLM plugins (e.g.
   * `@ax/llm-anthropic`) to tell the model how to call this tool. Kept as
   * `unknown` because JSON Schema is big and we don't want to model it in
   * TS — the LLM plugin is the thing that actually cares about its shape.
   *
   * Required: empty/missing schemas silently neuter tool-calling, so we
   * force every tool to publish one.
   */
  inputSchema: unknown;
}

// Payload types for the `sandbox:spawn` service hook. Shared hook contracts
// live in @ax/core so tool plugins can call the sandbox through the bus
// without a cross-plugin import (invariant #2).
export interface SandboxSpawnInput {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface SandboxSpawnResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
  readonly timedOut: boolean;
}

export type ChatOutcome =
  | { kind: 'complete'; messages: ChatMessage[] }
  | { kind: 'terminated'; reason: string; error?: unknown };

export type FireResult<P> =
  | { rejected: false; payload: P }
  | Rejection;
