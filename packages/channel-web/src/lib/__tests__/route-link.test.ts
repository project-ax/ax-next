import { describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { routeLinkProps } from '../route-link.js';
import type { WorkspaceRoute } from '../workspace-route.js';

const route: WorkspaceRoute = { kind: 'tasks' };

function click(over: Partial<React.MouseEvent<HTMLAnchorElement>> = {}) {
  const preventDefault = vi.fn();
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault,
    ...over,
  } as unknown as React.MouseEvent<HTMLAnchorElement>;
  return { event, preventDefault };
}

describe('routeLinkProps', () => {
  it('links to the route’s own address', () => {
    expect(routeLinkProps(route, () => {}).href).toBe('/workspace/tasks');
  });

  it('a plain click stays in the app', () => {
    const onNavigate = vi.fn();
    const { event, preventDefault } = click();
    routeLinkProps(route, onNavigate).onClick(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(route);
  });

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'])('a %s click is left to the browser', (key) => {
    const onNavigate = vi.fn();
    const { event, preventDefault } = click({ [key]: true });
    routeLinkProps(route, onNavigate).onClick(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('a middle click is left to the browser', () => {
    const onNavigate = vi.fn();
    const { event, preventDefault } = click({ button: 1 });
    routeLinkProps(route, onNavigate).onClick(event);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('a click something else already handled is left alone', () => {
    const onNavigate = vi.fn();
    const { event } = click({ defaultPrevented: true });
    routeLinkProps(route, onNavigate).onClick(event);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
