import { Button } from "@/components/ui/button";
import {
  BookOpenIcon,
  CheckIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
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

import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { authClient } from "../lib/auth-client";
import { Avatar } from "./Avatar";
import { useI18n, AVAILABLE_LOCALES } from "../i18n";

/**
 * Bottom-of-sidebar user profile menu. Single click target opens a
 * dropdown grouping the three account-scoped chrome items:
 *
 *   - Documentation (opens docs site in a new tab)
 *   - Theme picker (light / dark / system)
 *   - Sign out
 *
 * The trigger row uses the SAME custom recipe the brand row in
 * SidebarHeader uses — `h-11 px-3 flex items-center gap-2` with the
 * avatar fixed at x=12 and the text collapsing via
 * `group-data-[collapsible=icon]:hidden`. When the sidebar narrows to
 * icon mode the avatar stays put and the openma-style row visually
 * mirrors the brand row at the top.
 */
const THEME_OPTIONS = [
  { value: "light" as const, label: "Light", Icon: SunIcon },
  { value: "dark" as const, label: "Dark", Icon: MoonIcon },
  { value: "system" as const, label: "System", Icon: MonitorIcon },
];

export function UserProfile() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { t, locale, setLocale } = useI18n();

  if (!user) return null;

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = "/login";
  };

  const label = user.name || user.email || "Account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost"
          type="button"
          aria-label={t.profile.accountMenu}
          className="console-sidebar-row"
        >
          <span data-sidebar-slot data-sidebar-track="icon">
            <Avatar name={label} size="sm" />
          </span>
          <div className="min-w-0 text-left leading-tight" data-sidebar-track="label">
            <div className="text-sm text-sidebar-foreground truncate">
              {user.name || user.email}
            </div>
            {user.email && user.name && (
              <div className="text-xs text-fg-subtle truncate">
                {user.email}
              </div>
            )}
          </div>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        className="w-56"
        collisionPadding={8}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="leading-tight">
            <div className="text-sm font-medium text-fg truncate">
              {user.name || user.email}
            </div>
            {user.email && user.name && (
              <div className="text-xs text-fg-subtle truncate">
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
              {t.profile.documentation}
            </a>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-fg-subtle font-medium">
          Language
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {AVAILABLE_LOCALES.map(({ value, label, flag }) => {
            const active = locale === value;
            return (
              <DropdownMenuItem
                key={value}
                onClick={() => setLocale(value)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="size-4 inline-flex items-center justify-center text-xs font-mono opacity-80">
                  {flag}
                </span>
                {label}
                {active && <CheckIcon className="ml-auto size-4 text-brand" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-fg-subtle font-medium">
          {t.profile.theme}
        </DropdownMenuLabel>
        <DropdownMenuGroup>
          {THEME_OPTIONS.map(({ value, label: optLabel, Icon }) => {
            const active = theme === value;
            return (
              <DropdownMenuItem
                key={value}
                onClick={() => setTheme(value)}
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
          {t.profile.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
