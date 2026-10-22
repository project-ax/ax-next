/**
 * route-link — props that make an in-app link a real link (TASK-910).
 *
 * An `<a href>` that a plain click turns into a route change, and that the
 * browser keeps for everything else: open in a new tab, copy the address, a
 * middle click. Relative imports only, like the other lib modules.
 */
import type React from 'react';
import { workspaceRoutePath, type WorkspaceRoute } from './workspace-route.js';

export function routeLinkProps(
  route: WorkspaceRoute,
  onNavigate: (route: WorkspaceRoute) => void,
): { href: string; onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void } {
  return {
    href: workspaceRoutePath(route),
    onClick: (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      onNavigate(route);
    },
  };
}
