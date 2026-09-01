import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { SearchIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router";

import { openCommandPalette } from "./CommandPalette";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserProfile } from "./UserProfile";
import {
  AgentIcon,
  ApiKeysIcon,
  RuntimesIcon,
  DashboardIcon,
  EnvIcon,
  FeishuIcon,
  FilesIcon,
  GitHubIcon,
  LinearIcon,
  MemoryIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  SlackIcon,
  VaultIcon,
} from "./icons";
import { consolePlugins } from "../plugins/registry";
import { useI18n } from "../i18n";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

function useNavGroups(): NavGroup[] {
  const { t } = useI18n();
  return [
    {
      label: t.nav.overview,
      items: [{ to: "/", label: t.nav.dashboard, icon: DashboardIcon, end: true }],
    },
    {
      label: t.nav.managedAgents,
      items: [
        { to: "/agents", label: t.nav.agents, icon: AgentIcon },
        { to: "/sessions", label: t.nav.sessions, icon: SessionsIcon },
        { to: "/files", label: t.nav.files, icon: FilesIcon },
        { to: "/evals", label: t.nav.evalRuns, icon: SessionsIcon },
      ],
    },
    {
      label: t.nav.infrastructure,
      items: [
        { to: "/environments", label: t.nav.environments, icon: EnvIcon },
        { to: "/vaults", label: t.nav.credentialVaults, icon: VaultIcon },
      ],
    },
    {
      label: t.nav.configuration,
      items: [
        { to: "/skills", label: t.nav.skills, icon: SkillsIcon },
        { to: "/memory", label: t.nav.memoryStores, icon: MemoryIcon },
        { to: "/model-cards", label: t.nav.modelCards, icon: ModelCardsIcon },
        { to: "/api-keys", label: t.nav.apiKeys, icon: ApiKeysIcon },
        { to: "/runtimes", label: t.nav.localRuntimes, icon: RuntimesIcon },
      ],
    },
    {
      label: t.nav.integrations,
      items: [
        { to: "/integrations/linear", label: "Linear", icon: LinearIcon },
        { to: "/integrations/github", label: "GitHub", icon: GitHubIcon },
        { to: "/integrations/slack", label: "Slack", icon: SlackIcon },
        { to: "/integrations/feishu", label: "Feishu", icon: FeishuIcon },
      ],
    },
  ];
}

export function AppSidebar() {
  const { pathname } = useLocation();
  const { t } = useI18n();
  const navGroups = [
    ...useNavGroups(),
    ...consolePlugins.flatMap((plugin) => plugin.navGroups ?? []),
  ];

  return (
    <aside className="console-sidebar" aria-label="Workspace navigation" data-sidebar="sidebar">
      <div className="console-sidebar-tenant">
        <TenantSwitcher />
        <Button
          variant="ghost"
          type="button"
          className="console-sidebar-search"
          aria-label={t.command.title}
          data-sidebar-search
          onClick={openCommandPalette}
        >
          <SearchIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <nav className="console-sidebar-nav" aria-label="Console">
        {navGroups.map((group, groupIndex) => (
          <section className="console-sidebar-group" key={group.label}>
            {groupIndex > 0 && (
              <div className="console-sidebar-group-label" data-sidebar-track="label">
                {group.label}
              </div>
            )}
            {group.items.map((item) => {
              const active = item.end
                ? pathname === item.to
                : pathname === item.to || pathname.startsWith(`${item.to}/`);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className="console-sidebar-row"
                  data-active={active || undefined}
                  aria-current={active ? "page" : undefined}
                >
                  <span data-sidebar-slot data-sidebar-track="icon">
                    <item.icon className="size-4" />
                  </span>
                  <span data-sidebar-track="label">{item.label}</span>
                </NavLink>
              );
            })}
          </section>
        ))}
      </nav>

      <footer className="console-sidebar-footer">
        <UserProfile />
      </footer>
    </aside>
  );
}
