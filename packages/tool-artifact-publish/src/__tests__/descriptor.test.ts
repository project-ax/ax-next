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

  it('names the publishable locations by ROLE, never by a hardcoded path', () => {
    const d = ARTIFACT_PUBLISH_DESCRIPTOR.description;
    // The static catalog entry cannot know this session's roots, so it names the
    // two locations by role and defers to the operating notes for the literals.
    expect(d).toMatch(/files directory/);
    expect(d).toMatch(/artifacts\/ subdirectory/);
    expect(d).toMatch(/operating notes/);
  });

  it('does not hardcode the retired sandbox-absolute paths', () => {
    // `/agent/workspace/**` named a directory nothing creates, and both literals
    // were only ever true on k8s — a subprocess-sandbox agent that believed them
    // wrote its deliverable somewhere it could not publish from.
    const d = ARTIFACT_PUBLISH_DESCRIPTOR.description;
    expect(d).not.toMatch(/\/agent\//);
    expect(d).not.toMatch(/\/ephemeral\//);
    expect(d).not.toMatch(/workspace/);
  });

  it('carries a non-empty activityPhrase (<=40 chars)', () => {
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.activityPhrase).toBeTruthy();
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.activityPhrase!.length).toBeGreaterThan(0);
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.activityPhrase!.length).toBeLessThanOrEqual(40);
  });
});
