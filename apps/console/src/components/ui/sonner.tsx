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
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
