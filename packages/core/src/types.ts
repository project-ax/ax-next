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

export type ChatOutcome =
  | { kind: 'complete'; messages: ChatMessage[] }
  | { kind: 'terminated'; reason: string; error?: unknown };

export type FireResult<P> =
  | { rejected: false; payload: P }
  | Rejection;
