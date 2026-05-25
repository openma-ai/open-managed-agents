import {
  Avatar as ShadcnAvatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Initial-circle avatar. Image when present, falls back to a brand-tinted
 * circle with the entity's first letter (uppercase). Used for tenants,
 * users, and bot personas — anywhere a visual id sits next to a name.
 *
 * Wraps shadcn `Avatar` so AvatarPrimitive's image-error fallback handling
 * (auto-shows the fallback if the URL 404s) replaces the previous
 * onError style:none hack. Sizes are pinned manually because shadcn
 * only ships sm / default (size-8) / lg — we still need xs for dense
 * rows. squared is preserved for tenant avatars (read as "workspace"
 * rather than "person").
 */
const SIZE: Record<"xs" | "sm" | "md" | "lg", string> = {
  xs: "size-5 text-[10px]",
  sm: "size-6 text-[11px]",
  md: "size-7 text-[12px]",
  lg: "size-8 text-[13px]",
};

interface AvatarProps {
  /** Display name; first character is used for the fallback initial. */
  name: string;
  /** Optional image url (e.g. persona avatar from an integration). */
  src?: string | null;
  size?: keyof typeof SIZE;
  /** Use rounded-md (square-ish) instead of rounded-full. Tenant avatars
   *  use this so they read as "workspace" not "person". */
  squared?: boolean;
  className?: string;
}

export function Avatar({ name, src, size = "md", squared, className = "" }: AvatarProps) {
  const initial = (name?.trim().charAt(0) || "?").toUpperCase();
  const shape = squared ? "rounded-md after:rounded-md *:rounded-md" : "rounded-full";

  return (
    <ShadcnAvatar className={cn(SIZE[size], shape, "shrink-0", className)}>
      {src && (
        <AvatarImage
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className={squared ? "rounded-md" : undefined}
        />
      )}
      <AvatarFallback
        className={cn(
          "bg-brand-subtle text-brand font-mono font-bold",
          squared ? "rounded-md" : "rounded-full",
        )}
      >
        {initial}
      </AvatarFallback>
    </ShadcnAvatar>
  );
}
