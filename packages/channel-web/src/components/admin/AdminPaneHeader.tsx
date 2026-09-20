import type { ReactNode } from 'react';

export interface AdminPaneHeaderProps {
  eyebrow: string;
  title: string;
  /** Optional right-aligned slot — typically a status badge or count. */
  badge?: ReactNode;
}

/**
 * THE `h1` OF THE SETTINGS SURFACE (TASK-446).
 *
 * `AdminShell` mounts this on every one of its nine tabs and mounts nothing
 * else that is always present, so this title — and only this title — is the
 * page heading a screen-reader user lands on. It used to be a `<span>`, which
 * left the whole surface with no `h1` at all while six of the nine tab bodies
 * went straight to `h2` (or, on Skills and Connectors, straight to `h3`).
 *
 * The eyebrow stays a `<span>` deliberately. "Settings" / "Admin" is the
 * section this tab belongs to, not a heading of its own — promoting it would
 * put the same two words at the top of the outline on every tab and make the
 * real title look like a subsection of the nav group it came from.
 *
 * Preflight resets heading typography, so the rendered pixels are unchanged.
 */
export function AdminPaneHeader({ eyebrow, title, badge }: AdminPaneHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-4 px-8 pt-[18px] pb-4 border-b border-rule-soft">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-[11px] tracking-[0.06em] uppercase text-muted-foreground font-medium">
          {eyebrow}
        </span>
        <h1 className="text-[19px] font-medium tracking-[-0.012em]">{title}</h1>
      </div>
      {badge && <div className="flex items-center gap-3.5">{badge}</div>}
    </header>
  );
}
