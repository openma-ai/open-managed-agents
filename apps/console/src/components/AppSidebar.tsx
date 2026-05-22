import { useMemo } from "react";
import type { ComponentType } from "react";
import { NavLink, useLocation } from "react-router";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import { TenantSwitcher } from "./TenantSwitcher";
import { Logo } from "./Logo";
import { UserProfile } from "./UserProfile";
import {
  AgentIcon,
  ApiKeysIcon,
  RuntimesIcon,
  DashboardIcon,
  EnvIcon,
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

/* ── Navigation groups — single source of truth for sidebar items ── */
const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: DashboardIcon, end: true }],
  },
  {
    label: "Managed Agents",
    items: [
      { to: "/agents", label: "Agents", icon: AgentIcon },
      { to: "/sessions", label: "Sessions", icon: SessionsIcon },
      { to: "/files", label: "Files", icon: FilesIcon },
      { to: "/evals", label: "Eval Runs", icon: SessionsIcon },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { to: "/environments", label: "Environments", icon: EnvIcon },
      { to: "/vaults", label: "Credential Vaults", icon: VaultIcon },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/skills", label: "Skills", icon: SkillsIcon },
      { to: "/memory", label: "Memory Stores", icon: MemoryIcon },
      { to: "/model-cards", label: "Model Cards", icon: ModelCardsIcon },
      { to: "/api-keys", label: "API Keys", icon: ApiKeysIcon },
      { to: "/runtimes", label: "Local Runtimes", icon: RuntimesIcon },
    ],
  },
  {
    label: "Integrations",
    items: [
      { to: "/integrations/linear", label: "Linear", icon: LinearIcon },
      { to: "/integrations/github", label: "GitHub", icon: GitHubIcon },
      { to: "/integrations/slack", label: "Slack", icon: SlackIcon },
    ],
  },
];

/**
 * Console sidebar. Single vertical "icon axis" runs at 24px from the
 * sidebar's left edge — brand logo, tenant avatar, every nav-item icon,
 * and the footer user avatar all centre on that x:
 *
 *   - Custom rows (brand, tenant trigger, user-profile trigger) use
 *     `h-11 px-3 flex items-center gap-2` + a 24-square element
 *     (Logo h-6 w-6, Avatar size="sm") → centre at 12 + 12 = 24px.
 *   - `SidebarMenuButton`-driven rows (nav items) inherit shadcn's
 *     `px-2` group wrapper + button's own `px-2` + `size-4` icon
 *     → centre at 8 + 8 + 8 = 24px.
 *
 * Footer hosts a single `UserProfile` dropdown that bundles
 * Documentation, theme picker, and Sign out — previously three
 * separate rows; consolidated because they all belong to "the
 * signed-in user's account menu", not navigation.
 */
export function AppSidebar() {
  const { pathname } = useLocation();

  // Plugin-contributed groups (hosted-only extensions). Default empty
  // in OSS — hosted overlay-replaces plugins/registry.ts to add
  // billing / etc.
  const groups = useMemo(
    () => [...navGroups, ...consolePlugins.flatMap((p) => p.navGroups ?? [])],
    [],
  );

  const isItemActive = (to: string, end?: boolean) => {
    if (end) return pathname === to;
    return pathname === to || pathname.startsWith(`${to}/`);
  };

  return (
    // shadcn's default left-side Sidebar adds `border-r` to its outer
    // fixed-position container (sidebar.tsx:236), which renders a
    // top-to-bottom divider between the sidebar and the AppShell top
    // toolbar — breaks the "single continuous stage" look. Negate with
    // `border-r-0`; the rounded panel below the toolbar carries its
    // own `border-l` so the main canvas still has a clean edge.
    <Sidebar collapsible="icon" className="border-r-0">
      {/* Brand row — h-11 to match the AppShell top toolbar on the
          right; logo locked to 24×24 so its centre is at exactly 24px
          from the sidebar's left edge. */}
      <SidebarHeader className="p-0">
        <div className="h-11 px-3 flex items-center gap-2 text-brand group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:justify-center">
          <Logo size="sm" className="!h-6 !w-6" />
          <span className="font-mono font-bold text-base group-data-[collapsible=icon]:hidden">
            openma
          </span>
        </div>
        <TenantSwitcher />
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = isItemActive(item.to, item.end);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.label}
                      >
                        <NavLink to={item.to} end={item.end}>
                          <item.icon className="size-4 opacity-80" />
                          <span>{item.label}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="p-0">
        <UserProfile />
      </SidebarFooter>
    </Sidebar>
  );
}

