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

  it('input schema is {path, title, artifactId?}, path+title required, no extra keys', () => {
    const schema = ARTIFACT_PUBLISH_DESCRIPTOR.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
    expect(Object.keys(props).sort()).toEqual(['artifactId', 'path', 'title']);
    expect(props.path!.type).toBe('string');
    expect(props.title!.type).toBe('string');
    expect(props.title!.maxLength).toBe(200);
    expect(props.artifactId!.type).toBe('string');
    expect(schema.required).toEqual(['path', 'title']);
    expect(schema.additionalProperties).toBe(false);
    // The chat-visual marker is set only by show_visual; the model can't hide a
    // deliverable or un-hide a chart through this tool.
    expect(props).not.toHaveProperty('visual');
    expect(JSON.stringify(schema)).not.toMatch(/visual|hidden/i);
  });

  it('the description says: publish only things for the person, publish again after changes, no helper files, inline everything in HTML, and what a page cannot do (frames, shadow DOM, document.write, over 4 MiB)', () => {
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.description).toBe(
      'Publish a finished file from your files folder so the person can open it, preview it and share it. Give it a short human name in `title`, like "Q3 pipeline report". Publish only things meant for the person — never helper scripts, scratch notes or intermediate data. After you change the file, publish it again: the same path (or the same artifactId) adds a new version, and anyone with its link sees the newest one. To update something you published in an earlier chat, edit its file and publish that path again. Web pages open in a locked-down viewer with no internet access, so keep every script, style and image inside the HTML file; fetch(), forms and outside scripts or fonts won\'t work. HTML pages also run with no nested frames (iframe, frame, object, embed), no shadow DOM (attachShadow or declarative shadow DOM) and no document.write, and an HTML page over 4 MiB is refused. Returns { artifactId, version, title, kind, extension, url, path }. Symlinks and files over 100 MiB are refused.',
    );
  });

  it('never offers the scratch artifacts/ folder (C2)', () => {
    const d = JSON.stringify(ARTIFACT_PUBLISH_DESCRIPTOR);
    expect(d).not.toMatch(/artifacts\//);
    expect(d).not.toMatch(/scratch space/);
    expect(d).not.toMatch(/displayName/);
  });

  it('names the files folder by ROLE, never by a hardcoded path', () => {
    // The static catalog entry cannot know this session's root, so it names the
    // folder by role; the operating notes carry the literal.
    expect(ARTIFACT_PUBLISH_DESCRIPTOR.description).toMatch(/your files folder/);
    expect(JSON.stringify(ARTIFACT_PUBLISH_DESCRIPTOR)).not.toMatch(/\/files\b/);
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
