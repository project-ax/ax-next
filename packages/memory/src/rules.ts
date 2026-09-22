import {
  MEMORY_RULES_PATH,
  PluginError,
  type AgentContext,
  type HookBus,
  type WorkspaceVersion,
} from '@ax/core';

import { resolveMemoryAccess } from './access.js';
import { RULES_READ_HOOK } from './augment.js';
import { PLUGIN_NAME } from './plugin-name.js';

export const RULES_WRITE_HOOK = 'memory:rules:write';

export const MAX_RULES_CHARS = 16_384;

const MAX_ATTEMPTS = 3;

export interface MemoryRulesReadInput {
  agentId: string;
}

export interface MemoryRulesReadOutput {
  body: string;
}

export interface MemoryRulesWriteInput {
  agentId: string;
  body: string;
}

export interface MemoryRulesWriteOutput {
  written: boolean;
  body: string;
}

const WORKSPACE_READ_HOOK = 'workspace:read';
const WORKSPACE_APPLY_HOOK = 'workspace:apply';

function invalid(message: string, hookName: string): PluginError {
  return new PluginError({ code: 'invalid-payload', plugin: PLUGIN_NAME, hookName, message });
}

function invalidReturn(message: string, hookName: string): PluginError {
  return new PluginError({ code: 'invalid-return', plugin: PLUGIN_NAME, hookName, message });
}

function parseAgentId(input: unknown, ctx: AgentContext, hookName: string): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('input must be an object carrying agentId', hookName);
  }
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (key !== 'agentId' && (hookName !== RULES_WRITE_HOOK || key !== 'body')) {
      throw invalid('input carries a field this hook does not take', hookName);
    }
  }
  const agentId = (input as { agentId?: unknown }).agentId;
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw invalid('agentId must be a non-empty string', hookName);
  }
  if (agentId !== ctx.agentId) {
    throw invalid('agentId does not match the calling context', hookName);
  }
}

interface RulesBaseline {
  found: boolean;
  bytes?: Uint8Array;
  version?: WorkspaceVersion;
}

async function readCurrent(
  bus: HookBus,
  ctx: AgentContext,
  version: WorkspaceVersion | null | undefined,
): Promise<RulesBaseline> {
  const out = await bus.call<
    { path: string; version?: WorkspaceVersion },
    { found?: unknown; bytes?: unknown; version?: unknown } | null
  >(WORKSPACE_READ_HOOK, ctx, {
    path: MEMORY_RULES_PATH,
    ...(version !== undefined && version !== null ? { version } : {}),
  });
  if (out === null || typeof out !== 'object' || typeof out.found !== 'boolean') {
    throw invalidReturn(`${WORKSPACE_READ_HOOK} returned no usable result`, RULES_READ_HOOK);
  }
  if (!out.found) return { found: false };
  if (!(out.bytes instanceof Uint8Array)) {
    throw invalidReturn(`${WORKSPACE_READ_HOOK} returned a file with no bytes`, RULES_READ_HOOK);
  }
  if (out.version !== undefined && (typeof out.version !== 'string' || out.version === '')) {
    throw invalidReturn(`${WORKSPACE_READ_HOOK} returned an unusable version`, RULES_READ_HOOK);
  }
  if (version !== undefined && version !== null && out.version !== version) {
    throw invalidReturn(
      `${WORKSPACE_READ_HOOK} returned a different version than requested`,
      RULES_READ_HOOK,
    );
  }
  return {
    found: true,
    bytes: out.bytes,
    ...(out.version !== undefined ? { version: out.version as WorkspaceVersion } : {}),
  };
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidReturn(`${WORKSPACE_READ_HOOK} returned bytes that are not valid UTF-8`, RULES_READ_HOOK);
  }
}

async function writeRules(
  bus: HookBus,
  ctx: AgentContext,
  body: string,
): Promise<{ stored: string; changed: boolean }> {
  const trimmed = body.trimEnd();
  const stored = trimmed.length === 0 ? '' : `${trimmed}\n`;
  const bytes = new TextEncoder().encode(stored);

  let versionHint: WorkspaceVersion | null | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const baseline = await readCurrent(bus, ctx, versionHint);
    if (baseline.found && baseline.version === undefined) {
      throw invalidReturn(
        `${WORKSPACE_READ_HOOK} returned a file with no version`,
        RULES_WRITE_HOOK,
      );
    }
    const current = baseline.found ? decode(baseline.bytes!) : null;
    if (current === stored) return { stored, changed: false };
    const parent = baseline.found ? baseline.version! : (versionHint ?? null);
    await resolveMemoryAccess(bus, ctx);
    try {
      const applied = await bus.call<
        {
          changes: Array<{ path: string; kind: 'put'; content: Uint8Array }>;
          parent: WorkspaceVersion | null;
          reason: string;
        },
        { version?: unknown } | null
      >(WORKSPACE_APPLY_HOOK, ctx, {
        changes: [{ path: MEMORY_RULES_PATH, kind: 'put', content: bytes }],
        parent,
        reason: RULES_WRITE_HOOK,
      });
      if (
        applied === null ||
        typeof applied !== 'object' ||
        typeof applied.version !== 'string' ||
        applied.version === ''
      ) {
        throw invalidReturn(`${WORKSPACE_APPLY_HOOK} returned no usable version`, RULES_WRITE_HOOK);
      }
      return { stored, changed: true };
    } catch (err) {
      lastError = err;
      if (!(err instanceof PluginError && err.code === 'parent-mismatch')) throw err;
      const actual = (err.cause as { actualParent?: unknown } | undefined)?.actualParent;
      if (typeof actual === 'string' && actual !== '') {
        versionHint = actual as WorkspaceVersion;
      } else if (actual === null) {
        versionHint = null;
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

export function registerRulesHooks(bus: HookBus): void {
  bus.registerService<MemoryRulesReadInput, MemoryRulesReadOutput>(
    RULES_READ_HOOK,
    PLUGIN_NAME,
    async (ctx: AgentContext, input: MemoryRulesReadInput) => {
      parseAgentId(input, ctx, RULES_READ_HOOK);
      await resolveMemoryAccess(bus, ctx);
      const baseline = await readCurrent(bus, ctx, undefined);
      return { body: baseline.found ? decode(baseline.bytes!) : '' };
    },
  );

  bus.registerService<MemoryRulesWriteInput, MemoryRulesWriteOutput>(
    RULES_WRITE_HOOK,
    PLUGIN_NAME,
    async (ctx: AgentContext, input: MemoryRulesWriteInput) => {
      parseAgentId(input, ctx, RULES_WRITE_HOOK);
      const body = input?.body;
      if (typeof body !== 'string') {
        throw invalid('body must be a string', RULES_WRITE_HOOK);
      }
      if (body.length > MAX_RULES_CHARS) {
        throw invalid(`rules must be ${MAX_RULES_CHARS} characters or fewer`, RULES_WRITE_HOOK);
      }
      await resolveMemoryAccess(bus, ctx);
      const { stored, changed } = await writeRules(bus, ctx, body);
      return { written: changed, body: stored };
    },
  );
}
