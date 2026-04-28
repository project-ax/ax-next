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
  // JSON Schema for the tool's input. Required so LLM providers can forward
  // the shape to the model. Kept as an opaque object so plugins can emit any
  // valid JSON Schema draft without coupling to a specific zod version.
  inputSchema: Record<string, unknown>;
  /**
   * Where the tool physically runs:
   * - `'sandbox'`: the agent runtime dispatches locally, never hits the host.
   * - `'host'`: the agent sends `tool.execute-host` and waits for the host.
   *
   * Must match the corresponding field on `@ax/ipc-protocol`'s
   * `ToolDescriptorSchema` — see that file for the cross-boundary shape.
   */
  executesIn: 'sandbox' | 'host';
}

export type AgentOutcome =
  | { kind: 'complete'; messages: ChatMessage[] }
  | { kind: 'terminated'; reason: string; error?: unknown };

export type FireResult<P> =
  | { rejected: false; payload: P }
  | Rejection;
