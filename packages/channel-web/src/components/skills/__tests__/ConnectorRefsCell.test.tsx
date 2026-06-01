import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConnectorRefsCell } from '../ConnectorRefsCell';

// TASK-118 — the demoted connector display: a count summary as the visible
// content, the raw ids behind the trigger's accessible name (NOT a `title`,
// which would fire a second native browser tooltip alongside the Radix one).
function renderCell(connectors: string[]) {
  return render(
    <TooltipProvider>
      <ConnectorRefsCell connectors={connectors} />
    </TooltipProvider>,
  );
}

describe('ConnectorRefsCell', () => {
  it('renders an em-dash when there are no connectors', () => {
    renderCell([]);
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders a singular count for one connector', () => {
    renderCell(['github']);
    expect(screen.getByText('1 connector')).toBeTruthy();
  });

  it('renders a plural count for multiple connectors', () => {
    renderCell(['github', 'slack', 'linear']);
    expect(screen.getByText('3 connectors')).toBeTruthy();
  });

  it('exposes the raw ids via the accessible name, not a title attribute', () => {
    renderCell(['github', 'slack']);
    const trigger = screen.getByText('2 connectors');
    // aria-label carries the count + the raw ids…
    expect(trigger.getAttribute('aria-label')).toBe('2 connectors: github, slack');
    // …and there is NO `title` (which would double up with the Radix tooltip).
    expect(trigger.getAttribute('title')).toBeNull();
  });
});
