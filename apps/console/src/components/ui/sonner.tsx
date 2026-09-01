import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { useTheme } from "@/lib/theme"

/**
 * Sonner Toaster wired into the console's own `useTheme` (lib/theme.ts)
 * — the shadcn template ships with `next-themes`, but the console already
 * has its own light/dark/system manager that owns the `.dark` class on
 * `<html>`. Reading from it keeps the toast colour mode in lock-step
 * with the rest of the app on manual toggles (next-themes would only
 * see the system preference, not in-app overrides).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { effective } = useTheme()

  return (
    <Sonner
      theme={effective}
      className="toaster group"
      // Match the previous Radix Toast placement: bottom-right on desktop,
      // top-center on narrow viewports. swipeDirections / closeButton fall
      // back to sonner defaults.
      position="bottom-right"
      duration={4000}
      richColors
      expand
      gap={8}
      visibleToasts={3}
      offset={16}
      mobileOffset={12}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--bg)",
          "--normal-text": "var(--fg)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--success-subtle)",
          "--success-text": "var(--success)",
          "--success-border":
            "color-mix(in srgb, var(--success) 24%, var(--border))",
          "--info-bg": "var(--info-subtle)",
          "--info-text": "var(--info)",
          "--info-border":
            "color-mix(in srgb, var(--info) 24%, var(--border))",
          "--warning-bg": "var(--warning-subtle)",
          "--warning-text": "var(--warning)",
          "--warning-border":
            "color-mix(in srgb, var(--warning) 24%, var(--border))",
          "--error-bg": "var(--danger-subtle)",
          "--error-text": "var(--danger)",
          "--error-border":
            "color-mix(in srgb, var(--danger) 24%, var(--border))",
          "--border-radius": "var(--radius-md)",
          "--width": "min(22rem, calc(100vw - 2rem))",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast !gap-2 !p-3 !font-sans !text-sm !shadow-sm",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
