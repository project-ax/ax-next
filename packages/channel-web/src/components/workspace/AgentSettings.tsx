/**
 * An agent's settings page (TASK-888) — the things you TELL one agent, on a
 * page of their own rather than squeezed into the 296px rail.
 *
 * A full page, not a dialog, on purpose (decided 2026-10-08): connector
 * sign-in round-trips leave the app and need a real URL to come back to. So
 * every section has its own address (`/workspace/agents/:id/settings/:section`,
 * see `lib/workspace-route.ts`) and survives a reload.
 *
 * It is drawn BY the mounted `AgentView`, in place of the conversation and the
 * rail — never as a sibling route that would unmount it. That is what lets
 * "Back to chat" land on the very conversation that was open, with a reply
 * still streaming into it if one was.
 *
 * Two shapes, one component:
 *
 *   - desktop: a back button and breadcrumb, a 200px section nav on the left,
 *     and one section in a column no wider than 720px (the admin two-pane
 *     pattern, built from the same `SidebarRow`);
 *   - below `md`: the list of sections first, a tap drills in, and
 *     "Settings" comes back out. Every target is 44px tall.
 *
 * Skills and Routines use the existing services, scoped to this agent.
 * Model selection remains a workspace-default empty state.
 */
import { useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import {
  AppWindow,
  ArrowLeft,
  Brain,
  Clock,
  Cpu,
  MessageSquare,
  Plug,
  ScrollText,
  Sparkles,
  Users,
} from 'lucide-react';
import { Card, EmptyState, List, ListRow } from '@project-ax/ui';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUser } from '@/lib/user-context';
import { SkillsAppStore } from '@/components/settings/SkillsAppStore';
import { RoutinesTab } from '@/components/routines/RoutinesTab';
import { useAgentRail } from '@/lib/workspace-rail';
import { SHARING_COPY } from '@/lib/sharing-copy';
import type { AgentDetail } from '@/lib/workspace-api';
import {
  AGENT_SETTINGS_SECTIONS,
  type AgentSettingsSection,
} from '@/lib/workspace-route';
import { SidebarRow } from '../SidebarRow';
import { useGrantRevoke } from './AgentRail';
import { AgentAdvancedLimits } from './AgentAdvancedLimits';
import { AgentApps } from './AgentApps';
import { AgentSharing } from './AgentSharing';
import { AgentSlack } from './AgentSlack';
import { ConnectorsTab } from './ConnectorsTab';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

interface SectionCopy {
  label: string;
  Icon: Icon;
  /** The line under the section's heading. `null` when its content says it. */
  description: (name: string) => string | null;
  /** The one-line summary on the phone's section list. */
  summary: (name: string) => string;
}

/** One map, so the nav, the heading and the phone list cannot drift apart. */
export const SETTINGS_SECTIONS: Record<AgentSettingsSection, SectionCopy> = {
  instructions: {
    label: 'Instructions',
    Icon: ScrollText,
    description: (name) => `Kept word for word. ${name} reads them before every run.`,
    summary: (name) => `Rules ${name} follows every time`,
  },
  sharing: {
    label: SHARING_COPY.nav.label,
    Icon: Users,
    // The section opens with "Who can use <agent>?", which says it.
    description: () => null,
    summary: SHARING_COPY.nav.summary,
  },
  model: {
    label: 'Model',
    Icon: Cpu,
    description: (name) => `The AI model ${name} thinks with.`,
    summary: () => 'Workspace default',
  },
  connectors: {
    label: 'Connectors',
    Icon: Plug,
    // Connectors supplies visible guidance alongside its Add action.
    description: () => null,
    summary: (name) => `Tools ${name} can work in`,
  },
  slack: {
    label: 'Slack',
    Icon: MessageSquare,
    // Personal agents have no channels, so this can't promise any.
    description: (name) => `How ${name} works in Slack.`,
    summary: (name) => `How ${name} works in Slack`,
  },
  apps: {
    label: 'Apps',
    Icon: AppWindow,
    description: (name) => `Apps built on your apps platform that use ${name} and its connectors.`,
    summary: (name) => `Apps that use ${name}`,
  },
  memory: {
    label: 'Memory',
    Icon: Brain,
    description: (name) => `What ${name} remembers across all your conversations. If something's wrong or out of date, fix it or forget it.`,
    summary: (name) => `What ${name} remembers`,
  },
  skills: {
    label: 'Skills',
    Icon: Sparkles,
    description: () => null,
    summary: () => 'Instructions this agent can reuse',
  },
  routines: {
    label: 'Housekeeping',
    Icon: Clock,
    description: () => null,
    summary: () => 'Built-in maintenance and self-improvement',
  },
};

export interface AgentSettingsProps {
  agent: AgentDetail['agent'];
  section: AgentSettingsSection;
  onSection: (section: AgentSettingsSection) => void;
  /** Back to this agent's chat — the conversation that was open stays open. */
  onBack: () => void;
  /** Below `md`: the section list first, then one section at a time. */
  compact: boolean;
  /** Generic Settings entry opens the phone index; direct section links drill in. */
  startOnList?: boolean;
  /** A turn is streaming or settling — the connectors read re-reads on its edges. */
  busy: boolean;
  /** The rules editor, built by `AgentView`, which owns the save path. */
  instructions: ReactNode;
  /** The memories list, or `null` when this deployment keeps none. */
  memory: ReactNode;
}

export function AgentSettings(props: AgentSettingsProps) {
  const { agent, section, onSection, onBack, compact } = props;
  // A URL names a section on reload/auth return. Only a generic Settings
  // entry asks for the phone index first; its local back button returns there.
  const [drilled, setDrilled] = useState(!props.startOnList);
  const copy = SETTINGS_SECTIONS[section];
  const subtitle = `These only change ${agent.name}. Connectors your whole team shares live in Admin.`;

  if (compact && !drilled) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="flex h-14 shrink-0 items-center px-2">
          <Button variant="ghost" onClick={onBack} className="min-h-11 gap-2 px-2">
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            Chat
          </Button>
        </div>
        <div className="px-4 pb-6">
          <h1 className="font-brand text-[22px] font-semibold">{agent.name} settings</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">{subtitle}</p>
          <Card flush>
            <List label="Settings sections">
              {AGENT_SETTINGS_SECTIONS.map((id) => {
                const { label, Icon, summary } = SETTINGS_SECTIONS[id];
                return (
                  <ListRow
                    key={id}
                    title={label}
                    description={summary(agent.name)}
                    leading={<Icon aria-hidden="true" width={18} height={18} />}
                    onOpen={() => {
                      onSection(id);
                      setDrilled(true);
                    }}
                  />
                );
              })}
            </List>
          </Card>
        </div>
      </div>
    );
  }

  if (compact) {
    const description = copy.description(agent.name);
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
        <div className="flex h-14 shrink-0 items-center px-2">
          <Button variant="ghost" onClick={() => setDrilled(false)} className="min-h-11 gap-2 px-2">
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            Settings
          </Button>
        </div>
        <div className="px-4 pb-6">
          <h1 className="font-brand text-[22px] font-semibold">{copy.label}</h1>
          {description !== null && (
            <p className="mt-1 text-[13.5px] text-muted-foreground">{description}</p>
          )}
          <div className="mt-5">
            <SectionBody {...props} />
          </div>
        </div>
      </div>
    );
  }

  const description = copy.description(agent.name);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background">
      <div className="w-full px-6 pb-10 pt-4">
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 px-2">
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            Back to chat
          </Button>
          <Breadcrumb>
            <BreadcrumbList className="text-[12.5px]">
              <BreadcrumbItem>
                <span className="max-w-[24ch] truncate" title={agent.name}>
                  {agent.name}
                </span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>Settings</BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{copy.label}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <div className="mt-6 px-2">
          <h1 className="font-brand text-[24px] font-semibold">{agent.name} settings</h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:gap-8">
          <nav aria-label="Settings sections" className="w-full shrink-0 lg:w-[200px]">
            <ul className="m-0 flex list-none flex-wrap gap-px p-0 lg:flex-col">
              {AGENT_SETTINGS_SECTIONS.map((id) => {
                const { label, Icon } = SETTINGS_SECTIONS[id];
                const active = id === section;
                return (
                  <li key={id}>
                    <SidebarRow
                      active={active}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onSection(id)}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          'size-3.5 shrink-0',
                          active ? 'text-primary' : 'text-muted-foreground',
                        )}
                      />
                      <span>{label}</span>
                    </SidebarRow>
                  </li>
                );
              })}
            </ul>
          </nav>
          <section aria-labelledby="agent-settings-section" className="min-w-0 max-w-[720px] flex-1">
            <h2 id="agent-settings-section" className="text-[15px] font-semibold">
              {copy.label}
            </h2>
            {description !== null && (
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>
            )}
            <div className="mt-4">
              <SectionBody {...props} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SectionBody({ agent, section, busy, instructions, memory, onSection }: AgentSettingsProps) {
  const isAdmin = useUser()?.role === 'admin';
  switch (section) {
    case 'instructions':
      return <>{instructions}</>;
    case 'sharing':
      return <AgentSharing key={agent.id} agent={agent} onSection={onSection} />;
    case 'connectors':
      return <ConnectorsSection agent={agent} busy={busy} />;
    case 'slack':
      return <AgentSlack key={agent.id} agentId={agent.id} agentName={agent.name} />;
    case 'apps':
      return <AgentApps key={agent.id} agentId={agent.id} agentName={agent.name} />;
    case 'memory':
      return memory !== null && memory !== undefined ? (
        <>{memory}</>
      ) : (
        <EmptyState
          icon={Brain}
          title="No memories to show"
          description={`Memory isn't switched on for this workspace yet, so ${agent.name} isn't keeping notes. Ask your workspace administrator about turning it on.`}
        />
      );
    case 'model':
      return (
        <EmptyState
          icon={Cpu}
          title="Using the workspace default"
          description={`Picking a model just for ${agent.name} isn't here yet. Until it is, ${agent.name} uses whatever model your admin set for the whole workspace.`}
        />
      );
    case 'skills':
      return <SkillsAppStore key={agent.id} isAdmin={isAdmin} agentId={agent.id} agentName={agent.name} />;
    case 'routines':
      return (
        <>
          <RoutinesTab key={agent.id} isAdmin={isAdmin} agentId={agent.id} agentName={agent.name} onViewSkills={() => onSection('skills')} />
          <AgentAdvancedLimits key={`limits-${agent.id}`} agentId={agent.id} agentName={agent.name} />
        </>
      );
  }
}

/** Mount the connector manager only while its settings section is open. */
function ConnectorsSection({ agent, busy }: { agent: AgentDetail['agent']; busy: boolean }) {
  const { rail, loading, error, revoke, refresh } = useAgentRail(agent.id, agent.state, busy);
  const { revoking, notice, onRevoke } = useGrantRevoke(revoke);
  return (
    <ConnectorsTab
      agentId={agent.id}
      name={agent.name}
      rail={rail}
      loading={loading}
      error={error}
      revoking={revoking}
      notice={notice}
      onRevoke={onRevoke}
      onConnectorsChanged={refresh}
    />
  );
}
