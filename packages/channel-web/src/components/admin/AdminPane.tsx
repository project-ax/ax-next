import type { ReactNode } from 'react';

export interface AdminPaneProps {
  header: ReactNode;
  children: ReactNode;
}

export function AdminPane({ header, children }: AdminPaneProps) {
  return (
    <main className="flex-1 flex flex-col min-w-0 font-sans antialiased">
      {header}
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-24">{children}</div>
    </main>
  );
}
