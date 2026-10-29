/**
 * Small shared pieces of the Tasks surfaces (the minimal redesign, 2026-10-29):
 * the kind icon, an icon-and-few-words meta chip, an icon-only action button
 * and link, and the status pill.
 *
 * WORDS MOVE INTO TOOLTIPS, NEVER OUT OF THE PAGE. The design replaces meta
 * text with icons, so every icon here carries its full sentence twice: a
 * Tooltip for sighted pointer and keyboard users, and an accessible name
 * (`aria-label`, or visually hidden text) for screen readers. A chip or
 * button that dropped its words would be a guessing game for exactly the
 * non-technical people the redesign is for.
 */
import type { ComponentProps, ReactNode, Ref } from 'react';
import { ListChecks, RefreshCw, Repeat2, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TASK_GROUP_LABELS, type TaskGroup } from '@/lib/task-groups';
import { TASK_KIND_LABELS } from '@/lib/task-kinds';
import { cn } from '@/lib/utils';
import { StateDot } from './bits';

type Kind = keyof typeof TASK_KIND_LABELS;

/** One glyph per kind: a loop that never ends, a checklist that does, and a job on repeat. */
export const TASK_KIND_ICONS: Record<Kind, LucideIcon> = {
  'stay-on-top': RefreshCw,
  'get-done': ListChecks,
  repeat: Repeat2,
};

/** The short word beside a kind icon; the tooltip says the whole label. */
export const TASK_KIND_SHORT: Record<Kind, string> = {
  'stay-on-top': 'Stay on top',
  'get-done': 'Get done',
  repeat: 'Repeat',
};

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs text-[12px]">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The kind's icon alone, named for screen readers and in a tooltip. */
export function TaskKindIcon({ kind, className }: { kind: Kind; className?: string }) {
  const Icon = TASK_KIND_ICONS[kind];
  return (
    <Tip label={TASK_KIND_LABELS[kind]}>
      <span className={cn('inline-flex shrink-0 text-muted-foreground', className)}>
        <Icon aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{TASK_KIND_LABELS[kind]}</span>
      </span>
    </Tip>
  );
}

/**
 * An icon and at most a couple of words (“20 min”, “Nov 3”), with the whole
 * sentence in a tooltip and in hidden text. The visible words are hidden from
 * screen readers so the sentence isn't read twice.
 */
export function MetaChip({
  icon: Icon,
  label,
  description,
  emphasis = false,
  className,
}: {
  icon: LucideIcon;
  label?: string;
  /** The full sentence the icon and short label stand for. */
  description: string;
  emphasis?: boolean;
  className?: string;
}) {
  return (
    <Tip label={description}>
      <span
        tabIndex={0}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-sm text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          emphasis ? 'text-foreground' : 'text-muted-foreground',
          className,
        )}
      >
        <Icon aria-hidden="true" className="size-3.5" />
        {label !== undefined && <span aria-hidden="true">{label}</span>}
        <span className="sr-only">{description}</span>
      </span>
    </Tip>
  );
}

/**
 * An icon-only button: `label` is its accessible name and its tooltip. Takes
 * every `Button` prop, so callers keep their refs, `aria-describedby` and
 * disabled reasons.
 */
export function IconAction({
  icon: Icon,
  label,
  variant = 'outline',
  busy,
  ref,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'aria-label'> & {
  icon: LucideIcon;
  label: string;
  /** A spinner (or anything) shown in place of the icon while a press is on its way. */
  busy?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Tip label={label}>
      <Button ref={ref} type="button" size="icon" variant={variant} aria-label={label} {...props}>
        {busy ?? <Icon aria-hidden="true" />}
        {children}
      </Button>
    </Tip>
  );
}

/**
 * A link drawn as an icon-only button (ArrowUpRight "See what it did"): a real
 * `<a>`, so it opens in a new tab too. Its name is `label` in hidden text,
 * followed by `children` (more hidden words, say the entry's time, so a list
 * of them still says which is which); the tooltip says `label`.
 */
export function IconLink({
  icon: Icon,
  label,
  className,
  children,
  ...props
}: Omit<ComponentProps<'a'>, 'aria-label'> & { icon: LucideIcon; label: string }) {
  return (
    <Tip label={label}>
      <Button asChild variant="ghost" size="icon" className={cn('size-7 shrink-0 text-muted-foreground', className)}>
        <a {...props}>
          <Icon aria-hidden="true" />
          <span className="sr-only">{label}</span>
          {children}
        </a>
      </Button>
    </Tip>
  );
}

const PILL: Record<TaskGroup, string> = {
  'needs-you': 'bg-warning-soft text-warning',
  'off-track': 'bg-destructive-soft text-destructive',
  'on-track': 'bg-primary-soft text-primary',
  done: 'bg-primary-soft text-primary',
  'no-recent-update': 'bg-canvas text-muted-foreground',
  'no-update': 'bg-canvas text-muted-foreground',
  paused: 'bg-canvas text-muted-foreground',
};

/** The task's state as a pill: its mark's shape and colour, and its word. Never colour alone. */
export function TaskStatusPill({ group, label, className }: { group: TaskGroup; label?: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      size="compact"
      className={cn('gap-1.5 border-transparent px-2 py-1 text-[12px]', PILL[group], className)}
    >
      <StateDot state={group} />
      {label ?? TASK_GROUP_LABELS[group]}
    </Badge>
  );
}
