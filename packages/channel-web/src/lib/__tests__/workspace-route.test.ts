/**
 * The workspace's URL contract.
 *
 * Pure string ↔ route translation, kept out of the shell so the grammar can
 * be pinned without mounting React. The shell owns history; this owns what a
 * path means.
 */
import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_AGENT_TABS,
  parseWorkspaceRoute,
  workspaceRoutePath,
  type WorkspaceRoute,
} from '../workspace-route';

describe('parseWorkspaceRoute', () => {
  it('reads the workspace root as Today', () => {
    expect(parseWorkspaceRoute('/workspace')).toEqual({ kind: 'today' });
  });

  it('reads bare / as Today, because that is the landing surface', () => {
    // App.tsx routes `/` to the workspace when the preview is on. The shell
    // canonicalizes the URL after mount; parsing has to agree meanwhile.
    expect(parseWorkspaceRoute('/')).toEqual({ kind: 'today' });
  });

  it('ignores a trailing slash', () => {
    expect(parseWorkspaceRoute('/workspace/')).toEqual({ kind: 'today' });
  });

  it('reads the activity path', () => {
    expect(parseWorkspaceRoute('/workspace/activity')).toEqual({
      kind: 'activity',
    });
  });

  it('reads an agent with no tab as that agent on chat', () => {
    expect(parseWorkspaceRoute('/workspace/agents/a1')).toEqual({
      kind: 'agent',
      id: 'a1',
      tab: 'chat',
    });
  });

  it.each(WORKSPACE_AGENT_TABS)('reads the %s tab', (tab) => {
    expect(parseWorkspaceRoute(`/workspace/agents/a1/${tab}`)).toEqual({
      kind: 'agent',
      id: 'a1',
      tab,
    });
  });

  it('decodes a percent-encoded agent id', () => {
    expect(parseWorkspaceRoute('/workspace/agents/a%2Fb')).toEqual({
      kind: 'agent',
      id: 'a/b',
      tab: 'chat',
    });
  });

  it('keeps the agent when the tab is one we do not know', () => {
    // Greedy: the deepest prefix we understand wins. A typo in the tab should
    // still land you on the right agent rather than back at Today.
    expect(parseWorkspaceRoute('/workspace/agents/a1/bogus')).toEqual({
      kind: 'agent',
      id: 'a1',
      tab: 'chat',
    });
  });

  it('drops trailing segments it has no meaning for', () => {
    expect(parseWorkspaceRoute('/workspace/agents/a1/files/extra')).toEqual({
      kind: 'agent',
      id: 'a1',
      tab: 'files',
    });
  });

  it('falls back to Today on an unknown workspace path', () => {
    expect(parseWorkspaceRoute('/workspace/nope')).toEqual({ kind: 'today' });
  });

  it('falls back to Today when the agent id is missing', () => {
    expect(parseWorkspaceRoute('/workspace/agents')).toEqual({ kind: 'today' });
    expect(parseWorkspaceRoute('/workspace/agents/')).toEqual({ kind: 'today' });
  });

  it('falls back to Today rather than throwing on a malformed escape', () => {
    // decodeURIComponent throws URIError on a truncated escape. A link
    // someone mangled in a chat client must not take the whole shell down.
    expect(parseWorkspaceRoute('/workspace/agents/%E0%A4%A')).toEqual({
      kind: 'today',
    });
  });

  it.each(['..', '.', '%2E%2E', '%2e'])(
    'refuses %s as an agent id, so a link cannot inject a dot-segment',
    (segment) => {
      // The id is URL-supplied now, and workspace-api interpolates it into
      // `/api/workspace/agents/<id>/...`. encodeURIComponent leaves `..`
      // exactly as it found it, so the browser would normalize the request
      // to a DIFFERENT endpoint before it ever left. A slash is fine by
      // contrast — it encodes to %2F and stays one segment.
      expect(parseWorkspaceRoute(`/workspace/agents/${segment}`)).toEqual({
        kind: 'today',
      });
    },
  );

  it('falls back to Today on a path outside the workspace entirely', () => {
    expect(parseWorkspaceRoute('/admin/agents')).toEqual({ kind: 'today' });
  });
});

describe('workspaceRoutePath', () => {
  it('writes Today as the workspace root', () => {
    expect(workspaceRoutePath({ kind: 'today' })).toBe('/workspace');
  });

  it('writes activity', () => {
    expect(workspaceRoutePath({ kind: 'activity' })).toBe('/workspace/activity');
  });

  it('omits the chat tab, so an agent has one short shareable URL', () => {
    expect(workspaceRoutePath({ kind: 'agent', id: 'a1', tab: 'chat' })).toBe(
      '/workspace/agents/a1',
    );
  });

  it('writes a non-default tab', () => {
    expect(workspaceRoutePath({ kind: 'agent', id: 'a1', tab: 'files' })).toBe(
      '/workspace/agents/a1/files',
    );
  });

  it('percent-encodes an agent id that would otherwise change the path shape', () => {
    expect(
      workspaceRoutePath({ kind: 'agent', id: 'a/b c', tab: 'chat' }),
    ).toBe('/workspace/agents/a%2Fb%20c');
  });
});

describe('the two halves agree', () => {
  const ROUTES: readonly WorkspaceRoute[] = [
    { kind: 'today' },
    { kind: 'activity' },
    { kind: 'agent', id: 'a1', tab: 'chat' },
    { kind: 'agent', id: 'a1', tab: 'did' },
    { kind: 'agent', id: 'a1', tab: 'files' },
    { kind: 'agent', id: 'a1', tab: 'memory' },
    { kind: 'agent', id: 'agent with spaces/and-slash', tab: 'files' },
  ];

  it.each(ROUTES)('round-trips %j', (route) => {
    expect(parseWorkspaceRoute(workspaceRoutePath(route))).toEqual(route);
  });
});
