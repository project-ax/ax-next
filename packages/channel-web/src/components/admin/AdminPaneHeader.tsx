import type { ReactNode, Ref } from 'react';
import { SettingsHelp } from '../settings/SettingsLayout';

export interface AdminPaneHeaderProps {
  eyebrow: string;
  title: string;
  badge?: ReactNode;
  help?: string | undefined;
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  actionsRef?: Ref<HTMLDivElement> | undefined;
}

/** The single page heading also receives focus when Settings opens. */
export function AdminPaneHeader({ title, badge, help, headingRef, actionsRef }: AdminPaneHeaderProps) {
  return <header className="flex min-h-11 flex-wrap items-center gap-2">
    <h1 ref={headingRef} tabIndex={-1} className="text-[22px] font-semibold leading-[30px] tracking-[-0.025em] outline-none">{title}</h1>
    {help && <SettingsHelp title={title}>{help}</SettingsHelp>}
    <div ref={actionsRef} className="ml-auto flex flex-wrap items-center gap-2" />
    {badge}
  </header>;
}
