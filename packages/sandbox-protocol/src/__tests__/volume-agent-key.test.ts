import { describe, expect, it } from 'vitest';
import { MEMORY_FACTS_EXPORT_ROOT } from '../index.js';

describe('memory export volume layout', () => {
  it('pins the facts directory inside an agent\'s slot of the memory export volume', () => {
    // On-disk layout of every existing export: changing it strands them all.
    expect(MEMORY_FACTS_EXPORT_ROOT).toBe('permanent/memory/facts');
  });
});
