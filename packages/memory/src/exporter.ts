import { createHash } from 'node:crypto';

import {
  MEMORY_FACTS_EXPORT_ROOT,
  PluginError,
  type AgentContext,
  type HookBus,
  type WorkspaceListOutput,
  type WorkspaceReadOutput,
  type WorkspaceVersion,
} from '@ax/core';

import { memoryReadScope, resolveMemoryAccess } from './access.js';
import { buildFactsExport, type ExportFact } from './export-render.js';
import { parseFactsPath, type FactsChange, type FactsPath } from './export-paths.js';
import { syncFactsVolume, type MemoryVolumeConfig } from './export-volume.js';
import { PLUGIN_NAME } from './plugin-name.js';

export const FACTS_SCAN_HOOK = 'memory:facts:scan';
export const MEMORY_EXPORT_FLUSH_HOOK = 'memory:export:flush';
export const MEMORY_EXPORT_FAILED_EVENT = 'memory_export_failed';

const WORKSPACE_LIST_HOOK = 'workspace:list';
const WORKSPACE_READ_HOOK = 'workspace:read';
const WORKSPACE_APPLY_HOOK = 'workspace:apply';

const DEFAULT_DEBOUNCE_MS = 250;
const SCAN_PAGE_LIMIT = 200;
const MAX_ATTEMPTS = 3;

export interface MemoryExportConfig {
  debounceMs?: number;
  volume?: MemoryVolumeConfig;
}

interface EngineScanOutput {
  statements?: unknown;
  nextAfter?: unknown;
}

interface AgentExportState {
  key: string;
  ctx: AgentContext;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: Promise<void> | undefined;
  drainedChanged: boolean;
  lastError: unknown;
}

function invalidReturn(message: string, hookName: string = FACTS_SCAN_HOOK): PluginError {
  return new PluginError({
    code: 'invalid-return',
    plugin: PLUGIN_NAME,
    hookName,
    message,
  });
}

export function createMemoryExporter(bus: HookBus, config: MemoryExportConfig = {}) {
  const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new PluginError({
      code: 'invalid-payload',
      plugin: PLUGIN_NAME,
      message: `export debounceMs must be a non-negative finite number (got ${String(config.debounceMs)})`,
    });
  }

  const states = new Map<string, AgentExportState>();
  let stopped = false;

  function stateFor(ctx: AgentContext): AgentExportState {
    const key = JSON.stringify([ctx.agentId]);
    let state = states.get(key);
    if (state === undefined) {
      state = {
        key,
        ctx,
        dirty: false,
        timer: undefined,
        running: undefined,
        drainedChanged: false,
        lastError: undefined,
      };
      states.set(key, state);
    }
    return state;
  }

  function maybeDrop(state: AgentExportState): void {
    if (!state.dirty && state.timer === undefined && state.running === undefined) {
      states.delete(state.key);
    }
  }

  function fail(ctx: AgentContext, err: unknown): void {
    try {
      const code = err instanceof PluginError ? err.code : 'unknown';
      ctx.logger.warn(MEMORY_EXPORT_FAILED_EVENT, {
        agentId: ctx.agentId,
        code,
      });
    } catch {
    }
  }

  async function scanAll(ctx: AgentContext, accessScope: { ownerUserId?: string }): Promise<ExportFact[]> {
    const rows: ExportFact[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const input: { ownerUserId?: string; after?: string; limit: number } = {
        ...accessScope,
        limit: SCAN_PAGE_LIMIT,
      };
      if (after !== undefined) input.after = after;
      const page = await bus.call<typeof input, EngineScanOutput | null>(
        FACTS_SCAN_HOOK,
        ctx,
        input,
      );
      if (page === null || typeof page !== 'object' || !Array.isArray(page.statements)) {
        throw invalidReturn(`${FACTS_SCAN_HOOK} returned no statements page; refusing a partial export`);
      }
      if (page.nextAfter !== undefined) {
        if (typeof page.nextAfter !== 'string' || page.nextAfter === '') {
          throw invalidReturn(`${FACTS_SCAN_HOOK} returned a malformed cursor; refusing a partial export`);
        }
        if (seen.has(page.nextAfter)) {
          throw invalidReturn(`${FACTS_SCAN_HOOK} repeated a cursor; refusing a partial export`);
        }
        seen.add(page.nextAfter);
      }
      for (const row of page.statements) rows.push(row as ExportFact);
      if (page.nextAfter === undefined) return rows;
      after = page.nextAfter;
    }
  }

  async function listPaths(ctx: AgentContext, version?: string): Promise<string[]> {
    const input: { pathGlob: string; version?: string } = {
      pathGlob: `${MEMORY_FACTS_EXPORT_ROOT}/**`,
    };
    if (version !== undefined) input.version = version;
    const list = await bus.call<typeof input, WorkspaceListOutput | null>(
      WORKSPACE_LIST_HOOK,
      ctx,
      input,
    );
    if (list === null || typeof list !== 'object' || !Array.isArray(list.paths)) {
      throw invalidReturn(`${WORKSPACE_LIST_HOOK} returned no path list`);
    }
    return list.paths;
  }

  async function readFile(
    ctx: AgentContext,
    path: FactsPath,
    version: string | undefined,
    existing: Map<FactsPath, Uint8Array>,
  ): Promise<string | undefined> {
    const readInput: { path: string; version?: string } = { path };
    if (version !== undefined) readInput.version = version;
    const read = await bus.call<typeof readInput, WorkspaceReadOutput | null>(
      WORKSPACE_READ_HOOK,
      ctx,
      readInput,
    );
    if (read === null || typeof read !== 'object' || typeof read.found !== 'boolean') {
      throw invalidReturn(`${WORKSPACE_READ_HOOK} returned an unreadable result`, WORKSPACE_READ_HOOK);
    }
    if (!read.found) {
      if (version !== undefined) {
        throw invalidReturn(
          `${WORKSPACE_READ_HOOK} lost a file pinned at ${version}: ${path}`,
          WORKSPACE_READ_HOOK,
        );
      }
      return undefined;
    }
    if (!(read.bytes instanceof Uint8Array)) {
      throw invalidReturn(`${WORKSPACE_READ_HOOK} returned non-bytes content for ${path}`, WORKSPACE_READ_HOOK);
    }
    if (typeof read.version !== 'string' || read.version === '') {
      throw invalidReturn(`${WORKSPACE_READ_HOOK} returned no version for ${path}`, WORKSPACE_READ_HOOK);
    }
    if (version !== undefined && read.version !== version) {
      throw invalidReturn(
        `${WORKSPACE_READ_HOOK} returned a different version than requested for ${path}`,
        WORKSPACE_READ_HOOK,
      );
    }
    existing.set(path, read.bytes);
    return read.version;
  }

  async function collectExisting(
    ctx: AgentContext,
    paths: string[],
    pin: string | undefined,
  ): Promise<{ pin: string | undefined; existing: Map<FactsPath, Uint8Array> }> {
    const existing = new Map<FactsPath, Uint8Array>();
    for (const raw of paths) {
      const path = parseFactsPath(raw);
      if (path === undefined) continue;
      const version = await readFile(ctx, path, pin, existing);
      if (pin === undefined && version !== undefined) pin = version;
    }
    return { pin, existing };
  }

  async function readBaseline(
    ctx: AgentContext,
    parentHint: string | null | undefined,
  ): Promise<{ parent: WorkspaceVersion | null; existing: Map<FactsPath, Uint8Array> }> {
    if (typeof parentHint === 'string') {
      const paths = await listPaths(ctx, parentHint);
      const { existing } = await collectExisting(ctx, paths, parentHint);
      return { parent: parentHint as WorkspaceVersion, existing };
    }

    const paths = await listPaths(ctx);
    const existing = new Map<FactsPath, Uint8Array>();
    let pin: string | undefined;
    for (const raw of paths) {
      const path = parseFactsPath(raw);
      if (path === undefined) continue;
      const version = await readFile(ctx, path, pin, existing);
      if (pin === undefined && version !== undefined) {
        pin = version;
        const pinnedPaths = await listPaths(ctx, pin);
        existing.clear();
        const collected = await collectExisting(ctx, pinnedPaths, pin);
        return { parent: pin as WorkspaceVersion, existing: collected.existing };
      }
    }
    if (parentHint === null) return { parent: null, existing };
    return { parent: (pin as WorkspaceVersion | undefined) ?? null, existing };
  }

  async function attemptOnce(
    ctx: AgentContext,
    parentHint: string | null | undefined,
  ): Promise<{ changed: boolean }> {
    const access = await resolveMemoryAccess(bus, ctx);
    const rows = await scanAll(ctx, memoryReadScope(access));
    const desired = buildFactsExport(rows, access);
    const { parent, existing } = await readBaseline(ctx, parentHint);

    const changes: FactsChange[] = [];
    const encoder = new TextEncoder();
    for (const [path, content] of desired) {
      const bytes = encoder.encode(content);
      const current = existing.get(path);
      if (
        current !== undefined &&
        createHash('sha256').update(current).digest('hex') ===
          createHash('sha256').update(bytes).digest('hex')
      ) {
        continue;
      }
      changes.push({ path, kind: 'put', content: bytes });
    }
    for (const path of existing.keys()) {
      if (!desired.has(path)) changes.push({ path, kind: 'delete' });
    }

    if (changes.length > 0) {
      await resolveMemoryAccess(bus, ctx);
      const applied = await bus.call<
        { changes: FactsChange[]; parent: WorkspaceVersion | null; reason: string },
        { version?: unknown } | null
      >(WORKSPACE_APPLY_HOOK, ctx, {
        changes,
        parent,
        reason: 'memory:export',
      });
      if (
        applied === null ||
        typeof applied !== 'object' ||
        typeof applied.version !== 'string' ||
        applied.version === ''
      ) {
        throw invalidReturn(`${WORKSPACE_APPLY_HOOK} returned no usable version`);
      }
    }

    if (config.volume !== undefined) {
      await resolveMemoryAccess(bus, ctx);
      await syncFactsVolume(config.volume, ctx.agentId, desired);
    }

    return { changed: changes.length > 0 };
  }

  async function runPass(ctx: AgentContext): Promise<{ changed: boolean }> {
    let lastError: unknown;
    let parentHint: string | null | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await attemptOnce(ctx, parentHint);
      } catch (err) {
        lastError = err;
        if (!(err instanceof PluginError && err.code === 'parent-mismatch')) throw err;
        const actual = (err.cause as { actualParent?: unknown } | undefined)?.actualParent;
        parentHint =
          typeof actual === 'string' && actual !== '' ? actual : actual === null ? null : undefined;
        if (attempt === MAX_ATTEMPTS) throw err;
      }
    }
    throw lastError;
  }

  function ensureRunning(state: AgentExportState): Promise<void> {
    if (state.running === undefined) {
      state.running = (async () => {
        let anyChanged = false;
        while (state.dirty) {
          state.dirty = false;
          const passCtx = state.ctx;
          try {
            const result = await runPass(passCtx);
            anyChanged = anyChanged || result.changed;
            state.lastError = undefined;
          } catch (err) {
            state.lastError = err;
            fail(passCtx, err);
          }
        }
        state.drainedChanged = anyChanged;
      })()
        .catch(() => undefined)
        .finally(() => {
          state.running = undefined;
          maybeDrop(state);
        });
    }
    return state.running;
  }

  function kick(state: AgentExportState): void {
    state.timer = undefined;
    void ensureRunning(state);
  }

  return {
    schedule(ctx: AgentContext): void {
      if (stopped) {
        fail(
          ctx,
          new PluginError({
            code: 'unavailable',
            plugin: PLUGIN_NAME,
            message: 'memory exporter is shut down',
          }),
        );
        return;
      }
      const state = stateFor(ctx);
      state.ctx = ctx;
      state.dirty = true;
      if (state.timer !== undefined) clearTimeout(state.timer);
      const timer = setTimeout(() => kick(state), debounceMs);
      (timer as { unref?: () => void }).unref?.();
      state.timer = timer;
    },

    async flush(ctx: AgentContext): Promise<{ changed: boolean }> {
      if (stopped) {
        throw new PluginError({
          code: 'unavailable',
          plugin: PLUGIN_NAME,
          hookName: MEMORY_EXPORT_FLUSH_HOOK,
          message: 'memory exporter is shut down',
        });
      }
      await resolveMemoryAccess(bus, ctx);
      if (stopped) {
        throw new PluginError({
          code: 'unavailable',
          plugin: PLUGIN_NAME,
          hookName: MEMORY_EXPORT_FLUSH_HOOK,
          message: 'memory exporter is shut down',
        });
      }
      const state = stateFor(ctx);
      state.ctx = ctx;
      state.dirty = true;
      if (state.timer !== undefined) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      let changed = false;
      do {
        await ensureRunning(state);
        changed = changed || state.drainedChanged;
      } while (state.dirty && !stopped);
      await resolveMemoryAccess(bus, ctx);
      if (state.lastError !== undefined) throw state.lastError;
      return { changed };
    },

    async shutdown(): Promise<void> {
      stopped = true;
      for (const state of states.values()) {
        if (state.timer !== undefined) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
      }
      for (;;) {
        const pending = [...states.values()].filter(
          (state) => state.dirty || state.running !== undefined,
        );
        if (pending.length === 0) return;
        await Promise.all(pending.map((state) => ensureRunning(state)));
      }
    },
  };
}
