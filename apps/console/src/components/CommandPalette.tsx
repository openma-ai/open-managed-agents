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
import { useI18n } from "../i18n";

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
function useCommands(): NavCommand[] {
  const { t } = useI18n();
  return [
    { label: t.nav.dashboard,          to: "/",                          group: t.nav.overview,       icon: DashboardIcon },
    { label: t.nav.agents,             to: "/agents",                    group: t.nav.managedAgents, icon: AgentIcon },
    { label: t.nav.sessions,           to: "/sessions",                  group: t.nav.managedAgents, icon: SessionsIcon },
    { label: t.nav.files,              to: "/files",                     group: t.nav.managedAgents, icon: FilesIcon },
    { label: t.nav.evalRuns,           to: "/evals",                     group: t.nav.managedAgents, icon: SessionsIcon, aliases: "evaluations evals" },
    { label: t.nav.environments,       to: "/environments",              group: t.nav.infrastructure, icon: EnvIcon, aliases: "envs sandboxes" },
    { label: t.nav.credentialVaults,   to: "/vaults",                    group: t.nav.infrastructure, icon: VaultIcon, aliases: "secrets credentials" },
    { label: t.nav.skills,             to: "/skills",                    group: t.nav.configuration,  icon: SkillsIcon },
    { label: t.nav.memoryStores,       to: "/memory",                    group: t.nav.configuration,  icon: MemoryIcon },
    { label: t.nav.modelCards,         to: "/model-cards",               group: t.nav.configuration,  icon: ModelCardsIcon },
    { label: t.nav.apiKeys,            to: "/api-keys",                  group: t.nav.configuration,  icon: ApiKeysIcon, aliases: "tokens" },
    { label: t.nav.localRuntimes,      to: "/runtimes",                  group: t.nav.configuration,  icon: RuntimesIcon },
    { label: "Linear",                 to: "/integrations/linear",       group: t.nav.integrations,   icon: LinearIcon },
    { label: "GitHub",                 to: "/integrations/github",       group: t.nav.integrations,   icon: GitHubIcon },
    { label: "Slack",                  to: "/integrations/slack",        group: t.nav.integrations,   icon: SlackIcon },
  ];
}

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
  const { t } = useI18n();
  const COMMANDS = useCommands();

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
      title={t.command.title}
      description={t.command.description}
    >
      <CommandInput placeholder={t.command.jumpTo} />
      <CommandList>
        <CommandEmpty>{t.command.noMatches}</CommandEmpty>
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
