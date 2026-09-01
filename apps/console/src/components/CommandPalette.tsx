import { useEffect, useState, type ComponentType } from "react";
import { useLocation, useNavigate } from "react-router";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

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
  icon: ComponentType<{ className?: string }>;
  aliases?: string;
}

const RECENT_STORAGE_KEY = "oma-command-recent";
export const COMMAND_PALETTE_OPEN_EVENT = "openma:command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}

function useCommands(): NavCommand[] {
  const { t } = useI18n();
  return [
    { label: t.nav.dashboard, to: "/", icon: DashboardIcon },
    { label: t.nav.agents, to: "/agents", icon: AgentIcon },
    { label: t.nav.sessions, to: "/sessions", icon: SessionsIcon },
    { label: t.nav.files, to: "/files", icon: FilesIcon },
    { label: t.nav.evalRuns, to: "/evals", icon: SessionsIcon, aliases: "evaluations evals" },
    { label: t.nav.environments, to: "/environments", icon: EnvIcon, aliases: "envs sandboxes" },
    { label: t.nav.credentialVaults, to: "/vaults", icon: VaultIcon, aliases: "secrets credentials" },
    { label: t.nav.skills, to: "/skills", icon: SkillsIcon },
    { label: t.nav.memoryStores, to: "/memory", icon: MemoryIcon },
    { label: t.nav.modelCards, to: "/model-cards", icon: ModelCardsIcon },
    { label: t.nav.apiKeys, to: "/api-keys", icon: ApiKeysIcon, aliases: "tokens" },
    { label: t.nav.localRuntimes, to: "/runtimes", icon: RuntimesIcon },
    { label: "Linear", to: "/integrations/linear", icon: LinearIcon },
    { label: "GitHub", to: "/integrations/github", icon: GitHubIcon },
    { label: "Slack", to: "/integrations/slack", icon: SlackIcon },
  ];
}

function readRecentPaths(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** One global command surface. Intent groups stay in a stable order while the
 * recent ring buffer reflects routes the user has actually visited. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentPaths, setRecentPaths] = useState<string[]>(readRecentPaths);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useI18n();
  const commands = useCommands();

  const remember = (path: string) => {
    setRecentPaths((current) => {
      const next = [path, ...current.filter((item) => item !== path)].slice(0, 4);
      try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // The in-memory ring buffer remains useful when storage is unavailable.
      }
      return next;
    });
  };

  useEffect(() => {
    const command = commands.find((item) =>
      item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`),
    );
    if (command) remember(command.to);
    // Route changes are the event; translated labels do not change the stored path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    };
  }, []);

  const go = (to: string) => {
    remember(to);
    setOpen(false);
    setQuery("");
    navigate(to);
  };

  const recentCommands = recentPaths
    .map((path) => commands.find((command) => command.to === path))
    .filter((command): command is NavCommand => Boolean(command));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchResults = normalizedQuery.length >= 2
    ? commands.filter((command) =>
        `${command.label} ${command.aliases ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
      ).slice(0, 6)
    : [];

  const renderCommand = (command: NavCommand, valuePrefix: string) => {
    const Icon = command.icon;
    return (
      <CommandItem
        key={`${valuePrefix}:${command.to}`}
        value={`${valuePrefix} ${command.label} ${command.aliases ?? ""}`}
        onSelect={() => go(command.to)}
        className="cursor-pointer"
      >
        <Icon className="size-4 opacity-60" />
        <span className="min-w-0 flex-1 truncate">{command.label}</span>
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      title={t.command.title}
      description={t.command.description}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t.command.jumpTo}
      />
      <CommandList>
        <CommandEmpty>{t.command.noMatches}</CommandEmpty>
        <CommandGroup heading="Recent">
          {recentCommands.map((command) => renderCommand(command, "recent"))}
        </CommandGroup>
        <CommandGroup heading="Actions">
          {renderCommand(commands.find((command) => command.to === "/agents")!, "view")}
          {renderCommand(commands.find((command) => command.to === "/sessions")!, "review")}
        </CommandGroup>
        <CommandGroup heading="Navigate">
          {commands.map((command) => renderCommand(command, "navigate"))}
        </CommandGroup>
        {searchResults.length > 0 && (
          <CommandGroup heading="Search">
            {searchResults.map((command) => renderCommand(command, "search"))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
