import { useEffect, useState } from "react";
import { ChevronsUpDownIcon, PlusIcon, CheckIcon } from "lucide-react";

import { useApi, getActiveTenantId, setActiveTenantId } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar } from "./Avatar";

// Slot beneath the logo in the sidebar. Opens a dropdown with all
// memberships + "Create workspace" button. Switching writes
// localStorage and reloads the page so every already-mounted query
// refetches under the new tenant.
//
// Built on shadcn DropdownMenu (Radix → Floating UI under the hood):
// the popover auto-flips between top/bottom and shifts on the cross
// axis when it would otherwise collide with the viewport, so nothing
// gets clipped no matter where the trigger sits in the sidebar (top,
// middle, or bottom). The earlier hand-rolled `bottom-full mb-1`
// version assumed "always upward, always fits" and broke whenever
// the sidebar shrank or the dropdown grew past the available space.

interface Tenant {
  id: string;
  name: string;
  role: string;
}

function displayName(t: Tenant): string {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) return t.id;
  return trimmed;
}

export function TenantSwitcher() {
  const [active, setActive] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);

  // TQ replaces the previous mount-once useEffect that hand-rolled a fetch
  // + setState. Dedup means a re-mount (sidebar collapse/expand) reuses the
  // cached membership list rather than re-hitting /v1/me/tenants. A 401 on
  // first paint (pre-auth) is silenced by useApi's auth-error list.
  const { data: tenantsRes } = useApiQuery<{ data: Tenant[] }>(
    "/v1/me/tenants",
  );
  const tenants = tenantsRes?.data ?? [];

  // Sync the active-tenant pin once the membership list lands. The
  // localStorage pin is the source of truth across page loads; on first
  // visit (or when the stored id is no longer a valid membership) we
  // fall back to whichever tenant the backend resolved (its own fallback
  // chain ends at user.tenantId).
  useEffect(() => {
    if (tenants.length === 0) return;
    const stored = getActiveTenantId();
    if (stored && tenants.some((t) => t.id === stored)) {
      setActive(stored);
    } else {
      setActive(tenants[0].id);
      setActiveTenantId(tenants[0].id);
    }
  }, [tenants]);

  const switchTo = (id: string) => {
    setActiveTenantId(id);
    // Full reload — cheaper than threading active-tenant context through
    // every page's query state. Acceptable cost: sub-second on modern HW.
    window.location.reload();
  };

  // Always render the row — even before `/v1/me/tenants` resolves —
  // so the sidebar layout doesn't change height between empty and
  // loaded states. Previously this returned null pre-fetch, which made
  // the SidebarFooter shorter on first paint and then grew by 44 px
  // when tenants landed, shifting the user-profile row below it
  // downward in a visible "jump together with the avatar" twitch.
  const current = tenants.find((t) => t.id === active);

  // `current` resolves on the second pass (after the useEffect picks
  // the active tenant from the loaded list). Until then the row holds
  // its 44 px footprint with a brand-tinted skeleton avatar so the
  // only visual change when data lands is the initial letter + name
  // appearing on top of the existing block.
  const ready = current != null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Switch workspace"
            disabled={!ready}
            className="w-full h-11 px-3 flex items-center gap-2 hover:bg-sidebar-accent transition-colors text-left disabled:cursor-default disabled:hover:bg-transparent outline-none focus-visible:bg-sidebar-accent"
          >
            {ready ? (
              <Avatar name={current.name} size="sm" squared />
            ) : (
              <div className="size-6 rounded-md bg-brand-subtle shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
              <div className="text-sm font-medium truncate text-fg">
                {ready ? displayName(current) : " "}
              </div>
              {ready && tenants.length > 1 && (
                <div className="text-[10px] text-fg-subtle uppercase tracking-wider">
                  {current.role}
                </div>
              )}
            </div>
            {ready && (
              <ChevronsUpDownIcon
                className="w-3.5 h-3.5 text-fg-subtle shrink-0 group-data-[collapsible=icon]:hidden"
                aria-hidden="true"
              />
            )}
          </button>
        </DropdownMenuTrigger>

        {/* `side="bottom"` is the preferred placement; Radix auto-flips
            to top if the dropdown would overflow the viewport. `align`
            anchors the popover's left edge to the trigger; the menu
            width matches the trigger width (--radix-dropdown-menu-
            trigger-width). collisionPadding keeps a small breathing
            margin from viewport edges. */}
        <DropdownMenuContent
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 max-h-72 overflow-y-auto"
        >
          {tenants.map((t) => (
            <DropdownMenuItem
              key={t.id}
              onSelect={() => switchTo(t.id)}
              className="flex items-center gap-2"
            >
              <Avatar name={displayName(t)} size="xs" squared />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{displayName(t)}</div>
                <div className="text-[10px] text-fg-subtle font-mono">{t.id}</div>
              </div>
              {t.id === active && (
                <CheckIcon className="size-3.5 text-success shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setCreateOpen(true)}
            className="text-fg-muted"
          >
            <PlusIcon className="size-4 shrink-0" />
            Create workspace…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateTenantModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(t) => {
          // Optimistic: append to list and switch immediately. The reload
          // ensures every page refetches with the new tenant header.
          setActiveTenantId(t.id);
          window.location.reload();
        }}
      />
    </>
  );
}

function CreateTenantModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (t: Tenant) => void;
}) {
  const { api } = useApi();
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setWorking(true);
    setError("");
    try {
      const res = await api<Tenant>("/v1/tenants", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      onCreated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create workspace">
      <div className="space-y-4">
        <p className="text-sm text-fg-muted">
          A workspace is an isolated container for agents, sessions, vaults,
          and integrations. You'll be the owner of the new one.
        </p>
        <div>
          <label htmlFor="tenant-create-name" className="block text-xs uppercase tracking-wider text-fg-subtle mb-1">
            Name
          </label>
          <input
            id="tenant-create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="e.g. Acme Production"
            autoFocus
            disabled={working}
            className="w-full bg-bg border border-border rounded-lg px-3 py-2 min-h-11 sm:min-h-0 text-sm outline-none focus:border-border-strong"
          />
        </div>
        {error && (
          <div className="bg-danger-subtle border border-danger/30 text-danger text-sm rounded px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            disabled={working}
            className="inline-flex items-center justify-center px-4 py-2 min-h-11 sm:min-h-0 rounded-lg border border-border text-sm text-fg-muted hover:bg-bg-surface disabled:opacity-40"
          >
            Cancel
          </button>
          <Button onClick={submit} disabled={working || !name.trim()}>
            {working ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
