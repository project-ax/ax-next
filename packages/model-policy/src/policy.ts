import { isModelRef } from '@ax/core';
import { z } from 'zod';
import { MAX_ALLOWED_MODELS, MAX_REF_CHARS } from './shared.js';

export interface PolicyInput {
  allowed: string[];
  default: string;
}

export type PolicyErrorCode =
  | 'invalid-payload'
  | 'pick-at-least-one-model'
  | 'too-many-models'
  | 'invalid-model-ref'
  | 'duplicate-model'
  | 'default-not-selected';

export type PolicyValidation =
  | { ok: true; value: PolicyInput }
  | { ok: false; code: PolicyErrorCode; message: string };

const PREFERRED_DEFAULT = 'anthropic/claude-sonnet-4-6';

function fail(code: PolicyErrorCode, message: string): PolicyValidation {
  return { ok: false, code, message };
}

/** Validate a policy as an admin would submit it. Shape only: a model the live catalog no longer lists is still valid. */
export function validatePolicyInput(input: unknown): PolicyValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('invalid-payload', 'the policy must be an object');
  }
  const { allowed, default: def } = input as Record<string, unknown>;
  if (!Array.isArray(allowed) || allowed.some((r) => typeof r !== 'string')) {
    return fail('invalid-payload', 'allowed must be a list of model references');
  }
  const refs = allowed as string[];
  if (refs.length === 0) return fail('pick-at-least-one-model', 'pick at least one model');
  if (refs.length > MAX_ALLOWED_MODELS) {
    return fail('too-many-models', `at most ${MAX_ALLOWED_MODELS} models can be available`);
  }
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.length > MAX_REF_CHARS || !isModelRef(ref)) {
      return fail('invalid-model-ref', `'${ref.slice(0, 80)}' is not a valid model reference`);
    }
    if (seen.has(ref)) return fail('duplicate-model', `'${ref}' is listed twice`);
    seen.add(ref);
  }
  if (typeof def !== 'string' || !seen.has(def)) {
    return fail('default-not-selected', 'the Default must be one of the selected models');
  }
  return { ok: true, value: { allowed: [...refs], default: def } };
}

/** The Default for a built-in list: the preferred one if present, else Claude Sonnet, else the first entry. */
export function pickDefault(allowed: readonly string[], preferred?: string): string {
  if (preferred !== undefined && allowed.includes(preferred)) return preferred;
  if (allowed.includes(PREFERRED_DEFAULT)) return PREFERRED_DEFAULT;
  return allowed[0] ?? '';
}

export interface StoredPolicy {
  version: number;
  allowed: string[];
  default: string;
  updatedAt: string;
  updatedBy: string;
}

const storedSchema = z
  .object({
    version: z.number().int().min(1),
    allowed: z.array(z.string()),
    default: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string(),
  })
  .strict();

export type ParsedStored =
  | { kind: 'absent' }
  | { kind: 'ok'; doc: StoredPolicy }
  | { kind: 'corrupt' };

export function parseStored(bytes: Uint8Array | undefined): ParsedStored {
  if (bytes === undefined || bytes.length === 0) return { kind: 'absent' };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { kind: 'corrupt' };
  }
  const shape = storedSchema.safeParse(json);
  if (!shape.success) return { kind: 'corrupt' };
  const content = validatePolicyInput({ allowed: shape.data.allowed, default: shape.data.default });
  if (!content.ok) return { kind: 'corrupt' };
  return { kind: 'ok', doc: shape.data };
}

export function serializeStored(doc: StoredPolicy): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}
