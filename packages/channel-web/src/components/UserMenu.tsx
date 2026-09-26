/**
 * UserMenu — popover at the bottom of the sidebar.
 *
 * Click the user row → opens a popover with: Settings (every user — TASK-42),
 * a theme tri-toggle (Light / Dark / System), and Sign out. (Neither Routines
 * nor Credentials is a top-level entry anymore — both live inside Settings:
 * Routines is a Settings tab, credentials live on each connector.)
 *
 * SECURITY NOTE — UI affordance only. Every user can now open Settings; the
 * admin-only *tabs* inside it are gated in-shell. That in-shell gating is a UX
 * nicety, not a security boundary — the real access control sits on the server:
 * every `/admin/*` route checks `role === 'admin'` regardless of what the menu
 * or the shell shows, and the user-scoped Settings routes server-force the
 * caller's own id (a user can only ever read/change their own data).
 */
import { LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SETTINGS_OPENER_ATTR } from '../lib/settings-return-focus';
import { useUser } from '../lib/user-context';
import { signOut } from '../lib/auth';
import { useTheme, setTheme, type Theme } from '../lib/theme';
import { AvatarTile } from './AvatarTile';
import { SidebarSectionLabel } from './SidebarSectionLabel';

interface ThemeOption {
  value: Theme;
  label: string;
  Icon: typeof Sun;
}
const THEME_OPTIONS: ThemeOption[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  // 'auto' lets the OS preference drive (prefers-color-scheme); see lib/theme.ts.
  { value: 'auto', label: 'System', Icon: Monitor },
];

export function UserMenu({
  onOpenAdminSettings,
}: {
  onOpenAdminSettings?: (() => void) | undefined;
} = {}) {
  const user = useUser();
  const theme = useTheme();

  if (!user) return null;

  return (
    <div className="user-row-wrap relative border-t border-border p-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
      <button
        type="button"
        // TASK-443 — where focus comes back to when Settings closes.
        //
        // Settings is a pane swap, not an overlay: opening it unmounts this
        // whole sidebar, so there is no surviving node for a captured-ref
        // restore to aim at, and a detached-node restore silently lands on
        // `<body>`. `focusSettingsOpener` finds THIS control's successor in the
        // re-mounted tree by this attribute instead. See
        // `lib/settings-return-focus.ts`.
        //
        // Conditional on purpose: only a menu that can really open Settings
        // claims to be the door to it. `UserMenu` renders the item either way
        // (that was TASK-340's dead-control bug), and marking a menu whose
        // `onOpenAdminSettings` is undefined would hand focus to a control
        // that goes nowhere.
        {...(onOpenAdminSettings ? { [SETTINGS_OPENER_ATTR]: '' } : {})}
        // Keep `user-row` as a structural test hook — no CSS targets it.
        // The wrap (`user-row-wrap`) already has `p-2`, so the trigger
        // takes `w-full` and fills the wrap's content area exactly —
        // earlier `w-[calc(100%-16px)]` left an extra 16px gap on the
        // right edge and pushed the avatar off-centre when collapsed.
        className="
          user-row group flex items-center gap-2.5 cursor-pointer w-full
          px-2 py-[7px] rounded-lg transition-colors
          hover:bg-muted aria-expanded:bg-muted
          [body.sidebar-collapsed_&]:justify-center [body.sidebar-collapsed_&]:px-0
        "
      >
        <AvatarTile
          shape="round"
          size={26}
          gradientStrength={26}
          className="user-avatar text-[11px] tracking-[0.04em] text-foreground"
        >
          {user.name[0]?.toUpperCase() ?? 'U'}
        </AvatarTile>
        <span className="flex flex-col gap-px min-w-0 flex-1 text-left [body.sidebar-collapsed_&]:hidden">
          <span className="user-name text-[12.5px] leading-[1.15] tracking-[-0.005em] text-foreground truncate">
            {user.name}
          </span>
          <span className="user-email text-[10.5px] leading-[1.15] text-muted-foreground truncate">
            {user.email}
          </span>
        </span>
        <svg
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="
            shrink-0 h-2.5 w-2.5 text-muted-foreground transition-transform duration-150
            group-aria-expanded:rotate-180
            [body.sidebar-collapsed_&]:hidden
          "
        >
          <path
            d="M2.5 6 L5 3.5 L7.5 6"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={4}
          // Match the trigger's width so the menu keeps its old full-width
          // look in the expanded sidebar, with a floor for the collapsed rail
          // (where the trigger is only an avatar).
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-60 p-1.5 rounded-[10px] bg-card shadow-popover"
        >
          <div className="flex items-center gap-2.5 px-2.5 pb-2 mb-1 border-b border-border">
            <AvatarTile
              shape="round"
              size={36}
              background="muted"
              className="text-foreground font-semibold text-sm"
            >
              {user.name[0]?.toUpperCase() ?? 'U'}
            </AvatarTile>
            <div className="min-w-0">
              <div className="text-[14px] tracking-[-0.01em] leading-[1.1] text-foreground truncate">
                {user.name}
              </div>
              <div className="text-[11px] leading-[1.2] text-muted-foreground truncate">
                {user.email}
              </div>
            </div>
          </div>
          <DropdownMenuItem
            className="gap-2.5 px-2.5 py-2 text-[12.5px] [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
            onSelect={() => onOpenAdminSettings?.()}
            data-action="settings"
          >
            <Settings aria-hidden="true" strokeWidth={1.4} />
            <span>Settings</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {/*
            (C5) Three unlabelled icons. A sun, a moon and a rectangle tell a
            first-time reader nothing — and the one that matters most, "System",
            is the least guessable of the three — so each option carries a
            visible label, not a `title` only a patient mouse user would find.

            (TASK-500) These are the menu's own radio items, not a hand-rolled
            `role="radiogroup"` of buttons. Inside a Radix menu the content
            swallows Tab and the roving focus walks only menu items, so the old
            buttons were unreachable from the keyboard: ArrowDown went straight
            from Settings to Sign out. `DropdownMenuRadioItem` is a
            `menuitemradio` in that roving set, so the arrow keys land on each
            theme and Enter/Space picks it — the WAI-ARIA menu pattern, which
            also makes the ARIA valid (a `radiogroup` is not an allowed child
            of a `menu`).

            They stack vertically on purpose: a menu's arrow keys are Up/Down,
            and a horizontal row whose options you reach with ArrowDown would
            teach the wrong key.
          */}
          <DropdownMenuLabel className="px-2.5 pt-1.5 pb-1 text-[11px] font-normal text-muted-foreground">
            Theme
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-label="Theme"
            data-action="theme"
            value={theme}
            onValueChange={(v) => {
              // Radix hands back a bare string; only a value we rendered is a Theme.
              const next = THEME_OPTIONS.find((o) => o.value === v)?.value;
              if (next) setTheme(next);
            }}
          >
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                data-value={value}
                // Picking a theme is try-and-compare: keep the menu open so the
                // next arrow press can preview another one. Radix still fires
                // `onValueChange` — its handler ignores `defaultPrevented`.
                onSelect={(event) => event.preventDefault()}
                className="gap-2.5 py-2 pr-2.5 text-[12.5px] [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0"
              >
                <Icon className="text-muted-foreground" aria-hidden="true" strokeWidth={1.4} />
                <span>{label}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2.5 px-2.5 py-2 text-[12.5px] [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
            onSelect={() => signOut()}
            data-action="sign-out"
          >
            <LogOut aria-hidden="true" strokeWidth={1.4} />
            <span>Sign out</span>
          </DropdownMenuItem>
          <SidebarSectionLabel className="px-2.5 pt-2 pb-1 mt-1 border-t border-border">
            ax v0.3
          </SidebarSectionLabel>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
