import { describe, expect, it } from 'vitest';
import { buildActivityPhraseMap } from '../activity-phrase-map.js';

describe('buildActivityPhraseMap', () => {
  it('maps bare tool names to their authored phrases', () => {
    const map = buildActivityPhraseMap([
      { name: 'memory_search', activityPhrase: 'Searching memory' },
      { name: 'artifact_publish', activityPhrase: 'Publishing a file' },
    ]);
    expect(map.get('memory_search')).toBe('Searching memory');
    expect(map.get('artifact_publish')).toBe('Publishing a file');
  });

  it('omits tools without a phrase', () => {
    const map = buildActivityPhraseMap([
      { name: 'Bash' },
      { name: 'memory_search', activityPhrase: 'Searching memory' },
    ]);
    expect(map.has('Bash')).toBe(false);
    expect(map.get('memory_search')).toBe('Searching memory');
  });

  it('omits blank phrases (nothing safe to display)', () => {
    const map = buildActivityPhraseMap([
      { name: 'weird', activityPhrase: '   ' },
    ]);
    expect(map.has('weird')).toBe(false);
  });
});
