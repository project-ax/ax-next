import type { AgentContext, HookBus } from '@ax/core';
import {
  parseStored,
  serializeStored,
  validatePolicyInput,
  type PolicyErrorCode,
  type PolicyInput,
  type StoredPolicy,
} from './policy.js';
import { POLICY_STORAGE_KEY } from './shared.js';

export interface PolicyView {
  source: 'admin' | 'builtin';
  version: number;
  allowed: string[];
  default: string;
  updatedAt?: string;
  updatedBy?: string;
  warning?: 'saved-policy-unreadable';
}

export interface SaveInput {
  baseVersion: number;
  allowed: unknown;
  default: unknown;
}

export type SaveResult =
  | { ok: true; policy: PolicyView }
  | { ok: false; code: 'stale-version' }
  | { ok: false; code: PolicyErrorCode; message: string };

export interface PolicyStoreDeps {
  bus: HookBus;
  builtin: PolicyInput;
  now?: () => Date;
  /** How long a read is reused. Saves refresh the cache at once. Default 15 s. */
  ttlMs?: number;
}

export interface PolicyStore {
  read(ctx: AgentContext): Promise<PolicyView>;
  save(ctx: AgentContext, input: SaveInput, actorId: string): Promise<SaveResult>;
}

function clone(view: PolicyView): PolicyView {
  return { ...view, allowed: [...view.allowed] };
}

export function createPolicyStore(deps: PolicyStoreDeps): PolicyStore {
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? 15_000;
  let unreadableLogged = false;
  let savedGeneration = 0;
  let cache: { view: PolicyView; at: number } | null = null;

  // `storage:set` has no compare-and-swap, so the version check is only as
  // atomic as this chain. That is enough: the host is single-replica by design
  // (the Helm chart refuses replicas > 1), so every save goes through here.
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const builtinView = (warning?: 'saved-policy-unreadable'): PolicyView => ({
    source: 'builtin',
    version: 0,
    allowed: [...deps.builtin.allowed],
    default: deps.builtin.default,
    ...(warning !== undefined ? { warning } : {}),
  });

  async function load(ctx: AgentContext): Promise<PolicyView> {
    const out = await deps.bus.call<{ key: string }, { value: Uint8Array | undefined }>('storage:get', ctx, {
      key: POLICY_STORAGE_KEY,
    });
    const parsed = parseStored(out.value);
    if (parsed.kind === 'absent') return builtinView();
    if (parsed.kind === 'corrupt') {
      if (!unreadableLogged) {
        ctx.logger.error('model_policy_unreadable', { key: POLICY_STORAGE_KEY });
        unreadableLogged = true;
      }
      return builtinView('saved-policy-unreadable');
    }
    const d = parsed.doc;
    return {
      source: 'admin',
      version: d.version,
      allowed: [...d.allowed],
      default: d.default,
      updatedAt: d.updatedAt,
      updatedBy: d.updatedBy,
    };
  }

  return {
    async read(ctx) {
      if (cache !== null && now().getTime() - cache.at < ttlMs) return clone(cache.view);
      const generation = savedGeneration;
      const view = await load(ctx);
      if (generation !== savedGeneration && cache !== null) return clone(cache.view);
      cache = { view, at: now().getTime() };
      return clone(view);
    },

    save(ctx, input, actorId) {
      return serialize(async (): Promise<SaveResult> => {
        const checked = validatePolicyInput({ allowed: input.allowed, default: input.default });
        if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
        const current = await load(ctx); // bypass the cache: the version check must see the truth
        if (current.version !== input.baseVersion) return { ok: false, code: 'stale-version' };
        const doc: StoredPolicy = {
          version: current.version + 1,
          allowed: checked.value.allowed,
          default: checked.value.default,
          updatedAt: now().toISOString(),
          updatedBy: actorId,
        };
        await deps.bus.call('storage:set', ctx, { key: POLICY_STORAGE_KEY, value: serializeStored(doc) });
        const view: PolicyView = {
          source: 'admin',
          version: doc.version,
          allowed: [...doc.allowed],
          default: doc.default,
          updatedAt: doc.updatedAt,
          updatedBy: doc.updatedBy,
        };
        savedGeneration += 1;
        cache = { view, at: now().getTime() };
        return { ok: true, policy: clone(view) };
      });
    },
  };
}
