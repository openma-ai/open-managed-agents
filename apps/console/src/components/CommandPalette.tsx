import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { ComponentType } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

import { ROUTE_CHORDS } from "../lib/route-chords";
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

interface NavCommand {
  label: string;
  to: string;
  group: string;
  icon: ComponentType<{ className?: string }>;
  // Aliases helps fuzzy match — typing "envs" matches "Environments".
  aliases?: string;
}

// Mirrors the sidebar nav in Layout.tsx — kept inline so the palette is
// self-contained. If the sidebar gains an item, add it here too. (We
// intentionally don't auto-derive from Layout's navGroups because the
// palette wants slightly different ordering and aliases.)
const COMMANDS: NavCommand[] = [
  { label: "Dashboard",          to: "/",                          group: "Overview",       icon: DashboardIcon },
  { label: "Agents",             to: "/agents",                    group: "Managed Agents", icon: AgentIcon },
  { label: "Sessions",           to: "/sessions",                  group: "Managed Agents", icon: SessionsIcon },
  { label: "Files",              to: "/files",                     group: "Managed Agents", icon: FilesIcon },
  { label: "Eval Runs",          to: "/evals",                     group: "Managed Agents", icon: SessionsIcon, aliases: "evaluations evals" },
  { label: "Environments",       to: "/environments",              group: "Infrastructure", icon: EnvIcon, aliases: "envs sandboxes" },
  { label: "Credential Vaults",  to: "/vaults",                    group: "Infrastructure", icon: VaultIcon, aliases: "secrets credentials" },
  { label: "Skills",             to: "/skills",                    group: "Configuration",  icon: SkillsIcon },
  { label: "Memory Stores",      to: "/memory",                    group: "Configuration",  icon: MemoryIcon },
  { label: "Model Cards",        to: "/model-cards",               group: "Configuration",  icon: ModelCardsIcon },
  { label: "API Keys",           to: "/api-keys",                  group: "Configuration",  icon: ApiKeysIcon, aliases: "tokens" },
  { label: "Local Runtimes",     to: "/runtimes",                  group: "Configuration",  icon: RuntimesIcon },
  { label: "Linear",             to: "/integrations/linear",       group: "Integrations",   icon: LinearIcon },
  { label: "GitHub",             to: "/integrations/github",       group: "Integrations",   icon: GitHubIcon },
  { label: "Slack",              to: "/integrations/slack",        group: "Integrations",   icon: SlackIcon },
];

/**
 * Global Cmd+K (⌘K / Ctrl+K) command palette. Quick-jump anywhere in the
 * console without going through the sidebar. Mounts once at the layout
 * level; listens on `window` for the keybinding.
 *
 * Built on shadcn `CommandDialog` (Dialog + cmdk Command). Replaces the
 * hand-rolled Radix Dialog + raw cmdk pairing — the shadcn primitive
 * already wires title/description for a11y, top-1/3 placement, and
 * appropriate sizing.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K on mac, Ctrl+K everywhere else. Same combo as Linear, Raycast,
      // Slack — universal "open command palette".
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (cmdK) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    nav(to);
  };

  // Group commands by their `group` field for cmdk's grouped rendering.
  const grouped = COMMANDS.reduce<Record<string, NavCommand[]>>((acc, cmd) => {
    (acc[cmd.group] ??= []).push(cmd);
    return acc;
  }, {});

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump to any page in the console."
    >
      <CommandInput placeholder="Jump to…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {Object.entries(grouped).map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((cmd) => {
              const Icon = cmd.icon;
              const chord = ROUTE_CHORDS[cmd.to];
              return (
                <CommandItem
                  key={cmd.to}
                  value={`${cmd.label} ${cmd.aliases ?? ""}`}
                  onSelect={() => go(cmd.to)}
                  className="cursor-pointer"
                >
                  <Icon className="size-4 opacity-60 shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{cmd.label}</span>
                  <span className="text-[11px] text-fg-subtle">{cmd.group}</span>
                  {chord && (
                    <CommandShortcut className="font-mono text-[10px] border border-border rounded px-1.5 py-0.5">
                      g {chord}
                    </CommandShortcut>
                  )}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
