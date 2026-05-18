import { describe, it, expect } from 'vitest';
import { ARTIFACT_PUBLISH_DESCRIPTOR, ARTIFACT_PUBLISH_TOOL_NAME } from '../descriptor.js';

describe('artifact_publish descriptor', () => {
  it('declares the tool name', () => {
    expect(ARTIFACT_PUBLISH_TOOL_NAME).toBe('artifact_publish');
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.name).toBe('artifact_publish');
  });

  it('executes in the sandbox (D1)', () => {
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.executesIn).toBe('sandbox');
  });

  it('declares a JSON-schema for path + optional displayName', () => {
    const schema = ARTIFACT_PUBLISH_DESCRIPTOR.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = (schema.properties as Record<string, unknown>) ?? {};
    expect((props.path as Record<string, unknown>).type).toBe('string');
    expect((props.displayName as Record<string, unknown>).type).toBe('string');
    expect(schema.required).toEqual(['path']);
  });

  it('description mentions the allowlist', () => {
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.description).toMatch(/workspace/);
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.description).toMatch(/artifacts/);
  });
});
