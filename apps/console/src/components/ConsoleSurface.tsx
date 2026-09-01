import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface DashboardLayoutProps {
  intro: ReactNode;
  kpis: ReactNode;
  secondary?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function DashboardLayout({ intro, kpis, secondary, children, className }: DashboardLayoutProps) {
  return (
    <div className={cn("console-dashboard-layout", className)} data-testid="dashboard-layout">
      <div className="console-dashboard-intro" data-dashboard-slot="intro">
        {intro}
      </div>
      <div
        className="console-kpi-row"
        data-dashboard-slot="kpis"
        data-testid="dashboard-primary-kpis"
      >
        {kpis}
      </div>
      {secondary && (
        <div className="console-dashboard-secondary" data-dashboard-slot="secondary">
          {secondary}
        </div>
      )}
      <div className="console-activity-grid" data-dashboard-slot="activity">
        {children}
      </div>
    </div>
  );
}

interface ConsolePanelProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function ConsolePanel({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: ConsolePanelProps) {
  return (
    <section className={cn("console-panel", className)}>
      <header className="console-panel-header">
        <div className="min-w-0">
          <h2 className="console-panel-title">{title}</h2>
          {description && <p className="console-panel-description">{description}</p>}
        </div>
        {action && <div className="console-panel-action">{action}</div>}
      </header>
      <div className={cn("console-panel-content", contentClassName)}>{children}</div>
    </section>
  );
}

interface KpiCardProps {
  label: string;
  value: number | string | undefined;
  onClick: () => void;
}

export function KpiCard({ label, value, onClick }: KpiCardProps) {
  const displayValue = value ?? "–";
  return (
    <Button
      variant="ghost"
      type="button"
      className="console-kpi-card"
      aria-label={`${label}: ${displayValue}`}
      onClick={onClick}
    >
      <span className="console-kpi-value">{displayValue}</span>
      <span className="console-kpi-label">{label}</span>
    </Button>
  );
}
