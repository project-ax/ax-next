import type { ReactNode } from 'react';

export interface AdminPaneProps {
  header: ReactNode;
  children: ReactNode;
}

export function AdminPane({ header, children }: AdminPaneProps) {
  return (
    <main className="ax-panel flex-1 min-h-0 min-w-0 overflow-y-auto px-6 py-8 font-sans antialiased md:px-8">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 pb-16">
        {header}
        <div className="min-w-0">{children}</div>
      </div>
    </main>
  );
}
