export interface DividerProps {
  orientation?: 'horizontal' | 'vertical';
}

export function Divider({ orientation = 'horizontal' }: DividerProps) {
  if (orientation === 'vertical') {
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        className="ax-self-stretch ax-border-l ax-border-solid ax-border-line-border"
      />
    );
  }
  return <hr className="ax-m-none ax-border-0 ax-border-t ax-border-solid ax-border-line-border" />;
}
