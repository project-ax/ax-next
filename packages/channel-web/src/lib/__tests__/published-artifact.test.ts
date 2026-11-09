import { describe, expect, it } from 'vitest';
import { claimedArtifactId, isArtifactPublishToolName } from '../published-artifact';

describe('published-artifact', () => {
  it('knows both spellings of the publish tool, and nothing else', () => {
    expect(isArtifactPublishToolName('artifact_publish')).toBe(true);
    expect(isArtifactPublishToolName('mcp__ax-sandbox-tools__artifact_publish')).toBe(true);
    expect(isArtifactPublishToolName('mcp__evil__artifact_publish')).toBe(false);
    expect(isArtifactPublishToolName(undefined)).toBe(false);
  });

  it('reads the claimed id from a string or text-part result', () => {
    expect(claimedArtifactId('{"artifactId":"abc_1","version":1}')).toBe('abc_1');
    expect(claimedArtifactId([{ type: 'text', text: '{"artifactId":"x-2"}' }])).toBe('x-2');
  });

  it('refuses an id that is not the id shape, and anything not JSON', () => {
    expect(claimedArtifactId('{"artifactId":"../etc/passwd"}')).toBeNull();
    expect(claimedArtifactId('published it!')).toBeNull();
    expect(claimedArtifactId({ artifactId: 'abc' })).toBeNull();
  });
});
