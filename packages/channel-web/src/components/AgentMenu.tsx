/**
 * AgentMenu — popover anchored under the agent chip.
 *
 * Pure presentational: it reads the agent list + active id from the
 * store and forwards picks back to the parent. The deferred-switch
 * decision lives in `agent-store.ts`'s `pickAgent`, not here.
 *
 * Class names like `agent-menu-row` are kept as test hooks (no CSS
 * targets them — they're queryable structural names only).
 */
import type { Agent } from '../../mock/agents';
import { SidebarSectionLabel } from './SidebarSectionLabel';

export interface AgentMenuProps {
  agents: Agent[];
  /** The agent that should render with a checkmark (pending OR selected). */
  activeId: string | null;
  onPick: (agentId: string) => void;
}

export function AgentMenu({ agents, activeId, onPick }: AgentMenuProps) {
  // We deliberately do NOT use `role="menu"` / `role="menuitem"` here.
  // WAI-ARIA expects menus to implement full keyboard navigation
  // (arrow up/down to traverse, Esc to close, Enter to activate). We
  // don't, and shipping the role without the semantics is worse than
  // letting the popover stay a plain group of buttons — each button
  // already has its own accessibility, and `aria-current="true"` on
  // the active row gives screen readers the "this is the selected one"
  // signal without false-promising menu keyboard nav.
  return (
    <div
      className="
        absolute left-0 top-[calc(100%+4px)] z-[70] min-w-[260px]
        rounded-[10px] border border-border bg-background shadow-popover
        p-1.5
        animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150
      "
    >
      <SidebarSectionLabel className="px-2.5 pt-2 pb-1">
        switch agent
      </SidebarSectionLabel>
      <div className="flex flex-col gap-px">
        {agents.map((agent) => {
          const isActive = activeId === agent.id;
          return (
            <button
              key={agent.id}
              className="
                agent-menu-row group flex items-center gap-2.5 cursor-pointer
                px-2.5 py-[7px] rounded-md transition-colors
                hover:bg-muted aria-current:bg-muted text-left
              "
              type="button"
              {...(isActive ? { 'aria-current': 'true' as const } : {})}
              onClick={() => onPick(agent.id)}
            >
              <span
                aria-hidden="true"
                className="
                  inline-flex items-center justify-center shrink-0
                  h-[22px] w-[22px] rounded-md bg-muted border border-border
                "
              >
                <span
                  className="h-[5px] w-[5px] rounded-full bg-primary"
                  style={agent.color ? { background: agent.color } : undefined}
                />
              </span>
              <div className="flex flex-col gap-px min-w-0 flex-1">
                <div className="text-[14px] tracking-[-0.01em] leading-[1.1] text-foreground">
                  {agent.name}
                </div>
                <div className="text-[11px] leading-[1.2] text-muted-foreground truncate">
                  {agent.desc}
                </div>
              </div>
              {isActive && (
                <span aria-hidden="true" className="shrink-0 h-3.5 w-3.5 text-primary text-[12px] leading-none">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-1 pt-1 border-t border-border">
        <div className="px-2.5 pt-2 pb-1 text-[10.5px] tracking-[0.04em] text-ink-ghost text-center">
          a new session starts on your next message
        </div>
      </div>
      {/* The footnote above keeps its lower-case sentence-style copy and
         tighter tracking; it isn't a section label. */}
    </div>
  );
}
