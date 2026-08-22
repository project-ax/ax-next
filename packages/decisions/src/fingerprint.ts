import { createHash } from 'node:crypto';

/**
 * The idempotency key for "is this the call the human approved?".
 *
 * Canonical-JSON so key order cannot change the answer, and deliberately
 * EXCLUDING `call.id` — a retried call is a new id and the same call, and the
 * whole point is that approving once authorises exactly one execution of one
 * call shape.
 *
 * This is what makes the attended path honest without trusting the model: when
 * the still-warm agent re-issues its held call after approval, the pre-call
 * gate matches on this fingerprint. If the model changed so much as one
 * character of the input, it does not match, and the call holds again. The
 * human's approval is bound to what they read, not to the agent's good faith.
 *
 * TOTAL BY CONSTRUCTION. This runs inside a `tool:pre-call` subscriber, where
 * `HookBus.fire` swallows a throw as a clean pass — i.e. a SILENT ALLOW. A
 * model-authored input containing a BigInt or a cycle must therefore produce a
 * digest, never an exception. Both degrade to a marker token: two genuinely
 * different unserialisable inputs may share a digest, which can only ever make
 * the gate hold a call it might have let through — the safe direction.
 */
export function callFingerprint(call: { name: string; input: unknown }): string {
  let canon: string;
  try {
    canon = canonical([call.name, call.input], new Set());
  } catch {
    // Belt and braces: `canonical` handles every case it knows about, and this
    // catch is what keeps an unknown one from becoming a silent allow. A call
    // we cannot canonicalise gets a digest keyed on its NAME only, so it can
    // still be held, listed and approved — it just cannot be distinguished
    // from another uncanonicalisable call to the same tool.
    canon = `\u0000uncanonicalisable:${JSON.stringify(call.name)}`;
  }
  return createHash('sha256').update(canon).digest('hex');
}

/**
 * `seen` is the set of objects on the CURRENT path, not every object ever
 * visited: a value repeated in two sibling branches is not a cycle, and
 * collapsing it would make two different inputs agree.
 */
function canonical(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      // `JSON.stringify` renders NaN and Infinity as the string "null", so the
      // `??` below is only reached for a value it cannot represent at all.
      return JSON.stringify(value) ?? 'null';
    case 'bigint':
      // JSON.stringify THROWS on a BigInt. Given its own token so it is
      // distinguishable from the equivalent number.
      return `"\u0000bigint:${value.toString()}"`;
    case 'undefined':
    case 'function':
    case 'symbol':
      // What `JSON.stringify` does with these in an array position.
      return 'null';
    case 'object':
      break;
    default:
      return 'null';
  }

  if (value === null) return 'null';

  const obj = value as object;
  if (seen.has(obj)) return '"\u0000cycle"';
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => canonical(v, seen)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      // Exactly the keys `JSON.stringify` drops, so the fingerprint of a call
      // agrees with the fingerprint of that call after a JSON round-trip
      // through the database. If it did not, an approved call would stop
      // matching itself the moment the row was read back.
      .filter(([, v]) => {
        const t = typeof v;
        return t !== 'undefined' && t !== 'function' && t !== 'symbol';
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}
