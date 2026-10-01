import { runnerForModel } from './store.js';
import type { Agent } from './types.js';
import type { AgentContext, HookBus } from '@ax/core';

/** Which models may be chosen, and which one is the Default. */
export interface ModelPolicy {
  allowed: readonly string[];
  default: string;
}

const PREFERRED_DEFAULT = 'anthropic/claude-sonnet-4-6';

/** The policy in force before (or without) @ax/model-policy: the boot list, Sonnet as Default when present. */
export function builtinPolicy(allowed: readonly string[]): ModelPolicy {
  return {
    allowed,
    default: allowed.includes(PREFERRED_DEFAULT) ? PREFERRED_DEFAULT : (allowed[0] ?? ''),
  };
}

interface GetPolicyOutput {
  allowed: string[];
  default: string;
}

/**
 * Ask @ax/model-policy for the live policy. Soft dependency: with no plugin, or
 * on any failure or unusable answer, the boot policy applies, so a storage
 * hiccup never blocks chats or agent edits (it is the pre-feature behaviour).
 */
export async function loadPolicy(
  bus: HookBus,
  ctx: AgentContext,
  boot: ModelPolicy,
): Promise<ModelPolicy> {
  if (!bus.hasService('models:get-policy')) return boot;
  try {
    const out = await bus.call<Record<string, never>, GetPolicyOutput>('models:get-policy', ctx, {});
    if (out.allowed.length > 0 && out.allowed.includes(out.default)) {
      return { allowed: out.allowed, default: out.default };
    }
    ctx.logger.error('agents_model_policy_invalid', {});
  } catch (err) {
    ctx.logger.error('agents_model_policy_unavailable', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return boot;
}

/**
 * The agent as chats should see it under `policy`. A model the admin has removed
 * is replaced by the Default (the original is kept in `requestedModel`), and the
 * runner follows the model. An allowed model on the wrong runner (`claude-sdk`
 * with a non-Anthropic model, which fails every turn) is corrected in the same
 * way. Pure: returns the same object when nothing needs to change, and never
 * touches storage, so re-adding a model brings agents back on their own.
 */
export function applyPolicy(agent: Agent, policy: ModelPolicy): Agent {
  if (!policy.allowed.includes(agent.model)) {
    return {
      ...agent,
      model: policy.default,
      runner: runnerForModel(policy.default),
      requestedModel: agent.model,
    };
  }
  if (agent.runner === 'claude-sdk' && runnerForModel(agent.model) !== 'claude-sdk') {
    return { ...agent, runner: 'aisdk' };
  }
  return agent;
}
