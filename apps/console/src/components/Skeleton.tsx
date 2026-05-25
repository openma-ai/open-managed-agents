import type { CSSProperties, JSX } from "react";

import { Skeleton as ShadcnSkeleton } from "@/components/ui/skeleton";

interface SkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "full";
  style?: CSSProperties;
}

const radiusCls: Record<NonNullable<SkeletonProps["rounded"]>, string> = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
};

/**
 * Static placeholder block for in-flight content. Wraps shadcn `Skeleton`
 * but swaps the default `animate-pulse` for `skeleton-pulse` (defined in
 * index.css) so a long list of placeholder rows doesn't read as
 * "flashing" — the in-house pulse goes 0.4↔0.65 with the soft ease
 * curve, where Tailwind's animate-pulse is 0.5↔1 (uniform).
 * prefers-reduced-motion freezes both.
 *
 * Caller controls width/height via className. Example:
 *   <Skeleton className="h-4 w-32" />
 *   <Skeleton className="h-9 w-9" rounded="full" />
 */
export function Skeleton({ className = "", rounded = "md", style }: SkeletonProps): JSX.Element {
  return (
    <ShadcnSkeleton
      aria-hidden="true"
      style={style}
      className={`!animate-none skeleton-pulse ${radiusCls[rounded]} ${className}`}
    />
  );
}

interface SkeletonRowsProps {
  count: number;
  height?: number;
  gap?: number;
}

/**
 * Convenience for "loading a tabular list" — N evenly-spaced full-width
 * rows. Match approximate row height of your real table to avoid a
 * jarring layout shift when data lands.
 */
export function SkeletonRows({ count, height = 36, gap = 12 }: SkeletonRowsProps): JSX.Element {
  return (
    <div className="px-4 py-3" style={{ display: "grid", gap: `${gap}px` }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="w-full" rounded="md" style={{ height: `${height}px` }} />
      ))}
    </div>
  );
}
