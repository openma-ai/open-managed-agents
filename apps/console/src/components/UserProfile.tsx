import {
  BookOpenIcon,
  CheckIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { authClient } from "../lib/auth-client";
import { Avatar } from "./Avatar";

/**
 * Bottom-of-sidebar user profile menu. Single click target (the user
 * avatar + name row) opens a dropdown grouping the three things a
 * signed-in user reaches for from the chrome:
 *
 *   - Documentation (opens docs site in a new tab)
 *   - Theme picker (light / dark / system)
 *   - Sign out
 *
 * Replaces the previous footer stack of three separate rows
 * (Documentation SidebarMenuItem + ThemeToggle segmented control +
 * UserMenu button) — they belong together, and consolidating frees up
 * the footer for the chrome that actually navigates somewhere.
 */
const THEME_OPTIONS = [
  { value: "light" as const, label: "Light", Icon: SunIcon },
  { value: "dark" as const, label: "Dark", Icon: MoonIcon },
  { value: "system" as const, label: "System", Icon: MonitorIcon },
];

export function UserProfile() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();

  if (!user) return null;

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/login";
  };

  const label = user.name || user.email || "Account";

  return (
    <SidebarMenu className="px-2">
      <SidebarMenuItem>
        <DropdownMenu>
          {/* Trigger uses shadcn `SidebarMenuButton size="lg"` so the
              collapse behaviour is identical to every nav row — when
              the sidebar shrinks to icon mode the button auto-resizes
              to 32×32 + p-2, with only the leading 16-px icon
              visible. Previously this was a custom `<button h-11 px-3>`
              that just hid the text on collapse without resizing the
              button itself — the avatar stayed at its expanded x
              position while everything else snapped to centre, hence
              the "behaviour is different" the user called out. */}
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip={label}>
              <UserIcon className="size-4 opacity-80" />
              <div className="flex-1 min-w-0 text-left leading-tight">
                <div className="text-sm text-sidebar-foreground truncate">
                  {user.name || user.email}
                </div>
                {user.email && user.name && (
                  <div className="text-[11px] text-fg-subtle truncate">
                    {user.email}
                  </div>
                )}
              </div>
            </SidebarMenuButton>
          </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        className="w-56"
        // Sidebar-relative trigger means the dropdown reaches across to
        // the main canvas; collisionPadding keeps it inside the viewport
        // when the sidebar is at the bottom edge.
        collisionPadding={8}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="leading-tight">
            <div className="text-sm font-medium text-fg truncate">
              {user.name || user.email}
            </div>
            {user.email && user.name && (
              <div className="text-[11px] text-fg-subtle truncate">
                {user.email}
              </div>
            )}
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <a
              href="https://docs.openma.dev"
              target="_blank"
              rel="noopener noreferrer"
            >
              <BookOpenIcon className="size-4 opacity-80" />
              Documentation
            </a>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-fg-subtle font-medium">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {THEME_OPTIONS.map(({ value, label: optLabel, Icon }) => {
            const active = theme === value;
            return (
              <DropdownMenuItem
                key={value}
                onClick={() => setTheme(value)}
                // Keep the menu open on click so the user can preview
                // each theme without re-opening. Use onSelect's default
                // close-on-pick? No — leave open. (User reopens to pick
                // again is more friction than benefit.)
                onSelect={(e) => e.preventDefault()}
              >
                <Icon className="size-4 opacity-80" />
                {optLabel}
                {active && <CheckIcon className="ml-auto size-4 text-brand" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={handleSignOut}
          className="text-danger focus:text-danger focus:bg-danger/10"
        >
          <LogOutIcon className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
