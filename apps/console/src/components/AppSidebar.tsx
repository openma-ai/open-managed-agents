import { useMemo } from "react";
import type { ComponentType } from "react";
import { NavLink, useLocation } from "react-router";
import { BookOpenIcon, LogOutIcon } from "lucide-react";

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

import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { authClient } from "../lib/auth-client";
import { TenantSwitcher } from "./TenantSwitcher";
import { Logo } from "./Logo";
import { Avatar } from "./Avatar";
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

const themeOptions = [
  { value: "light" as const, label: "Light" },
  { value: "dark" as const, label: "Dark" },
  { value: "system" as const, label: "System" },
];

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex items-center rounded-md bg-sidebar-accent p-0.5 gap-0.5 mx-2">
      {themeOptions.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          className={`flex-1 inline-flex items-center justify-center px-2 py-1 text-xs rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
            theme === opt.value
              ? "bg-sidebar text-sidebar-foreground font-medium shadow-sm"
              : "text-fg-muted hover:text-sidebar-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function UserMenu() {
  const { user } = useAuth();
  if (!user) return null;
  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/login";
  };
  // h-11 px-3 + size="sm" avatar (24x24) puts the avatar's center on
  // the same x as the brand logo, tenant-switcher avatar, and the
  // SidebarMenuButton icons in <SidebarContent> — single 24px-from-edge
  // vertical axis for every icon in the column.
  return (
    <button
      type="button"
      onClick={handleSignOut}
      title={`Sign out (${user.name || user.email})`}
      aria-label={`Sign out (${user.name || user.email})`}
      className="w-full h-11 px-3 flex items-center gap-2 hover:bg-sidebar-accent transition-colors"
    >
      <Avatar name={user.name || user.email} size="sm" />
      <div className="flex-1 min-w-0 text-left leading-tight group-data-[collapsible=icon]:hidden">
        <div className="text-sm text-sidebar-foreground truncate">
          {user.name || user.email}
        </div>
        {user.email && user.name && (
          <div className="text-[11px] text-fg-subtle truncate">{user.email}</div>
        )}
      </div>
      <LogOutIcon className="size-4 text-fg-subtle group-hover:text-fg-muted shrink-0 group-data-[collapsible=icon]:hidden" />
    </button>
  );
}

/**
 * Console sidebar. Single vertical "icon axis" runs at 24px from the
 * sidebar's left edge — brand logo, tenant avatar, nav-item icons,
 * and footer doc/logout/user avatar all centre on that x:
 *
 *   - Custom rows (brand, tenant trigger, user menu) use
 *     `h-11 px-3 flex items-center gap-2` + 24-square element (logo /
 *     avatar) → centre at 12 + 12 = 24px.
 *   - `SidebarMenuButton`-driven rows (nav items, doc link, theme
 *     toggle) inherit shadcn's `px-2` group wrapper + button's own
 *     `px-2` + `size-4` icon → centre at 8 + 8 + 8 = 24px.
 *
 * Active-route highlighting uses `useLocation` rather than `NavLink`'s
 * isActive because `SidebarMenuButton` already renders the brand-tinted
 * active state via `data-[active]` — passing it through `isActive` keeps
 * the styling consistent with everything else in shadcn.
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
    <Sidebar collapsible="icon">
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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Documentation">
              <a
                href="https://docs.openma.dev"
                target="_blank"
                rel="noopener noreferrer"
              >
                <BookOpenIcon className="size-4 opacity-80" />
                <span>Documentation</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="group-data-[collapsible=icon]:hidden">
          <ThemeToggle />
        </div>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
