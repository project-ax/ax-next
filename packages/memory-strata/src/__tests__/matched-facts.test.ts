import { describe, expect, it } from 'vitest';
import { extractMatchedFacts } from '../matched-facts.js';

const BODY = [
  '# Doc',
  '',
  '## Facts',
  '- (2026-02-01) User attended the Austin Film Festival 48-hour challenge.',
  '- User is researching fish stocking levels for a 55-gallon tank.',
  '- (2026-03-10) User volunteered at the Portland Film Festival.',
  '- User enjoyed films like Parasite.',
  '',
].join('\n');

describe('extractMatchedFacts', () => {
  it('returns every fact line matching any query token', () => {
    expect(extractMatchedFacts(BODY, 'film festivals attended')).toEqual([
      '(2026-02-01) User attended the Austin Film Festival 48-hour challenge.',
      '(2026-03-10) User volunteered at the Portland Film Festival.',
      'User enjoyed films like Parasite.',
    ]);
  });
  it('prefix-stems: festival matches festivals and vice versa', () => {
    expect(extractMatchedFacts(BODY, 'festival')).toHaveLength(2);
  });
  it('drops stopword-only queries', () => {
    expect(extractMatchedFacts(BODY, 'how many did I')).toEqual([]);
  });
  it('caps output at maxLines', () => {
    expect(extractMatchedFacts(BODY, 'user', { maxLines: 2 })).toHaveLength(2);
  });
  it('returns [] for a body with no fact lines', () => {
    expect(extractMatchedFacts('# Doc\n\nprose only\n', 'festival')).toEqual([]);
  });
});
