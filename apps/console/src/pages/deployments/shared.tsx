import { useState, type ReactNode } from "react";
import { CalendarClockIcon, ChevronDownIcon, HandIcon } from "lucide-react";
import type { BetaManagedAgentsDeployment } from "@anthropic-ai/sdk/resources/beta/deployments";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { FacetedFilter, type FacetedFilterOption } from "../../components/FacetedFilter";
import type { Messages } from "../../i18n/types";

export type Deployment = BetaManagedAgentsDeployment;

/** Managed metadata has no author field, so the Console records the
 *  creator's email under this key when it creates a deployment. */
export const CREATED_BY_METADATA_KEY = "created_by";

export function deploymentCreator(deployment: Deployment): string | null {
  return deployment.metadata?.[CREATED_BY_METADATA_KEY] || null;
}

export type DeploymentState = "active" | "paused" | "archived";

export function deploymentState(deployment: Deployment): DeploymentState {
  if (deployment.archived_at) return "archived";
  return deployment.status;
}

export const fill = (text: string, values: Readonly<Record<string, string | number>>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) =>
    values[key] === undefined ? match : String(values[key]),
  );

const STATE_CLASS: Record<DeploymentState, string> = {
  active: "bg-success-subtle text-success",
  paused: "bg-warning-subtle text-warning",
  archived: "bg-bg-surface text-fg-subtle",
};

export function DeploymentStatePill({
  deployment,
  m,
}: {
  deployment: Deployment;
  m: Messages["deployments"];
}) {
  const state = deploymentState(deployment);
  return (
    <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${STATE_CLASS[state]}`}>
      {m[state]}
    </span>
  );
}

/** "Manual" or the cron expression with its zone. */
export function TriggerSummary({
  deployment,
  m,
}: {
  deployment: Deployment;
  m: Messages["deployments"];
}) {
  const schedule = deployment.schedule;
  if (!schedule) {
    return (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <HandIcon className="size-3.5" aria-hidden="true" />
        {m.manual}
      </span>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-fg-muted"
      title={`${schedule.expression} (${schedule.timezone})`}
    >
      <CalendarClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="font-mono text-xs">{schedule.expression}</span>
      <span className="truncate text-xs text-fg-subtle">{schedule.timezone}</span>
    </span>
  );
}

/** "Tue, Nov 3, 2026, 9:00 AM" in the viewer's locale. When `timeZone`
 *  is given the wall clock is shown in that zone. */
export function formatRunTime(value: Date | string, locale: string, timeZone?: string): string {
  return new Date(value).toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** A button that opens a searchable option list — used where a plain
 *  `<Select>` would be unwieldy (time zones) or where picking appends to
 *  a list (vaults). */
export function SearchPicker({
  label,
  options,
  value,
  onValueChange,
  searchPlaceholder,
  empty,
  id,
  variant = "field",
  icon,
}: {
  label: ReactNode;
  options: FacetedFilterOption[];
  value: string;
  onValueChange: (value: string) => void;
  searchPlaceholder: string;
  empty?: ReactNode;
  id?: string;
  /** `field` renders like a select trigger; `ghost` like an inline action. */
  variant?: "field" | "ghost";
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant={variant === "field" ? "outline" : "ghost"}
          className={cn(
            variant === "field" && "w-full justify-between font-normal",
            variant === "ghost" && "px-2",
          )}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          {icon}
          <span className="truncate">{label}</span>
          {variant === "field" && <ChevronDownIcon className="size-4 opacity-60" aria-hidden="true" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-80 p-0">
        {options.length === 0 && empty ? (
          <p className="px-3 py-3 text-sm text-fg-subtle">{empty}</p>
        ) : (
          <FacetedFilter
            options={options}
            value={value}
            onValueChange={(next) => {
              onValueChange(next);
              setOpen(false);
            }}
            searchPlaceholder={searchPlaceholder}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Two-column settings section: heading + hint on the left, fields on the right. */
export function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section
      className="grid gap-4 border-t border-border py-6 first:border-t-0 first:pt-0 md:grid-cols-[200px_minmax(0,1fr)] md:gap-8"
      aria-label={title}
    >
      <div>
        <h2 className="text-sm font-medium text-fg">{title}</h2>
        <p className="mt-1 text-sm text-fg-muted">{hint}</p>
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}
