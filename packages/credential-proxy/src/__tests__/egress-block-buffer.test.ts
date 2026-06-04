import { describe, it, expect } from 'vitest';
import { SessionEgressBlockBuffer } from '../egress-block-buffer.js';

// ---------------------------------------------------------------------------
// Unit tests for the per-session allowlist-block buffer (TASK — agent-visible
// egress-block note). The buffer accumulates the hostnames a session was
// egress-blocked on, so the runner can drain them at PostToolUse and inject an
// actionable remediation note into the agent's context.
//
// The buffer is deliberately mechanism-free: it stores attributed (sessionId,
// host) pairs and nothing else. The `blockedReason === 'allowlist'` filter and
// the host extraction live in the plugin's onAudit; the buffer just records
// what it's told and drains-and-clears per session.
// ---------------------------------------------------------------------------

describe('SessionEgressBlockBuffer', () => {
  it('records a host and drains it back (insertion order)', () => {
    const buf = new SessionEgressBlockBuffer();
    buf.record('s1', 'github.com');
    buf.record('s1', 'release-assets.githubusercontent.com');
    expect(buf.drain('s1')).toEqual([
      'github.com',
      'release-assets.githubusercontent.com',
    ]);
  });

  it('drain CLEARS the session — a second drain returns []', () => {
    const buf = new SessionEgressBlockBuffer();
    buf.record('s1', 'github.com');
    expect(buf.drain('s1')).toEqual(['github.com']);
    expect(buf.drain('s1')).toEqual([]);
  });

  it('dedups a host recorded twice within a session', () => {
    const buf = new SessionEgressBlockBuffer();
    buf.record('s1', 'github.com');
    buf.record('s1', 'github.com');
    expect(buf.drain('s1')).toEqual(['github.com']);
  });

  it('isolates sessions — draining one never touches another', () => {
    const buf = new SessionEgressBlockBuffer();
    buf.record('s1', 'a.example');
    buf.record('s2', 'b.example');
    expect(buf.drain('s1')).toEqual(['a.example']);
    expect(buf.drain('s2')).toEqual(['b.example']);
  });

  it('drain of an unknown session returns []', () => {
    const buf = new SessionEgressBlockBuffer();
    expect(buf.drain('never-seen')).toEqual([]);
  });

  it('ignores empty sessionId or empty host (unattributed blocks)', () => {
    const buf = new SessionEgressBlockBuffer();
    buf.record('', 'github.com');
    buf.record('s1', '');
    expect(buf.drain('')).toEqual([]);
    expect(buf.drain('s1')).toEqual([]);
  });

  it('caps hosts per session and drops new hosts past the cap (memory guard)', () => {
    const buf = new SessionEgressBlockBuffer(2);
    buf.record('s1', 'first.example');
    buf.record('s1', 'second.example');
    buf.record('s1', 'third.example'); // dropped — over cap
    expect(buf.drain('s1')).toEqual(['first.example', 'second.example']);
  });

  it('forget() drops a session without surfacing it (close-session cleanup)', () => {
    const buf = new SessionEgressBlockBuffer();
    buf.record('s1', 'github.com');
    buf.forget('s1');
    expect(buf.drain('s1')).toEqual([]);
  });
});
