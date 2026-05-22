/**
 * Brand mark — `[horse]` logo. Inlined as a React SVG component (no
 * `<img>` round-trip) and uses `<path>` brackets instead of text + a
 * font family. The previous incarnation used `<img src="/logo.svg">`
 * with `<text font-family="JetBrains Mono">[</text>` inside; both
 * sources of layout jump:
 *
 *   1. The `<img>` request was async — the box was sized via CSS, but
 *      the rendered glyphs only appeared after the SVG round-tripped.
 *   2. The SVG `<text>` resolved against the browser's font stack; with
 *      Google Fonts `display=swap` the initial paint used SF Mono /
 *      Menlo, then re-laid out when JetBrains Mono loaded, shifting
 *      bracket widths.
 *
 * Inlining + path brackets eliminates both — the logo paints
 * identically on first frame regardless of font load order.
 */
const SIZE_PX = {
  sm: 32,
  md: 36,
  lg: 40,
} as const;

interface LogoProps {
  size?: keyof typeof SIZE_PX;
  className?: string;
}

export function Logo({ size = "sm", className = "" }: LogoProps) {
  const px = SIZE_PX[size];
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 160 160"
      role="img"
      aria-label="openma"
      className={`shrink-0 ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g
        stroke="#FF6B50"
        strokeWidth={14}
        strokeLinecap="square"
        strokeLinejoin="round"
        fill="none"
      >
        {/* Left bracket [ — three strokes (top cap, vertical, bottom cap) */}
        <path d="M55,30 L25,30 L25,130 L55,130" />
        {/* Right bracket ] */}
        <path d="M105,30 L135,30 L135,130 L105,130" />
      </g>
      {/* Centre dot — same coral, paints the "horse" eye spot from the
          original logo at a much simpler geometry. */}
      <circle cx="80" cy="80" r="6" fill="#FF6B50" />
    </svg>
  );
}
