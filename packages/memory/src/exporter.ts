import { PluginError, type AgentContext, type HookBus } from '@ax/core';

import { memoryReadScope, resolveMemoryAccess } from './access.js';
import { buildFactsExport, type ExportFact } from './export-render.js';
import { syncFactsVolume, type MemoryVolumeConfig } from './export-volume.js';
import { PLUGIN_NAME } from './plugin-name.js';

export const FACTS_SCAN_HOOK = 'memory:facts:scan';
export const MEMORY_EXPORT_FLUSH_HOOK = 'memory:export:flush';
export const MEMORY_EXPORT_FAILED_EVENT = 'memory_export_failed';

const DEFAULT_DEBOUNCE_MS = 250;
const SCAN_PAGE_LIMIT = 200;

export interface MemoryExportConfig {
  debounceMs?: number;
  /**
   * Required: the volume is the only place the export is written (TASK-991).
   * There is no copy in the agent's workspace.
   */
  volume: MemoryVolumeConfig;
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

function invalidReturn(message: string): PluginError {
  return new PluginError({
    code: 'invalid-return',
    plugin: PLUGIN_NAME,
    hookName: FACTS_SCAN_HOOK,
    message,
  });
}

export function createMemoryExporter(bus: HookBus, config: MemoryExportConfig) {
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
      // A volume sync failure is a plain Node error, so `code` alone says only
      // 'unknown'. Its errno (EACCES, ENOSPC, …) says what went wrong without
      // the message, which carries the full path. Only an errno-shaped string
      // is logged: anything else under `code` is not ours to echo.
      const errno = errnoOf(err);
      ctx.logger.warn(MEMORY_EXPORT_FAILED_EVENT, {
        agentId: ctx.agentId,
        code,
        ...(errno === undefined ? {} : { errno }),
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

  // One pass, no retry: a failure is logged by `fail()` and the next schedule
  // or flush tries again. The volume sync works out what changed by itself.
  async function runPass(ctx: AgentContext): Promise<{ changed: boolean }> {
    const access = await resolveMemoryAccess(bus, ctx);
    const rows = await scanAll(ctx, memoryReadScope(access));
    const desired = buildFactsExport(rows, access);
    // Again before publishing: access can be revoked while the scan runs.
    await resolveMemoryAccess(bus, ctx);
    return syncFactsVolume(config.volume, ctx.agentId, desired);
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

const ERRNO_RE = /^E[A-Z0-9]{1,31}$/;

function errnoOf(err: unknown): string | undefined {
  if (err instanceof PluginError || typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && ERRNO_RE.test(code) ? code : undefined;
}
