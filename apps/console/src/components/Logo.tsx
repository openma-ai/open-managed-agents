/**
 * Brand mark — `[horse]` logo. Inlined as React SVG (no `<img>` round-
 * trip and no width/height-attr-vs-CSS-class mismatch that previously
 * caused an 8-px collapse on first paint when CSS resized 32×32 →
 * 24×24).
 *
 * Artwork copied verbatim from `public/logo.svg` (horse paths + mask)
 * — same visual identity as before. JetBrains Mono brackets render
 * via the bundled font (`@fontsource-variable/jetbrains-mono` imported
 * from main.tsx), so the glyphs are ready synchronously with the JS
 * bundle and don't race a Google Fonts request.
 */
const SIZE_PX = {
  sm: 24,
  md: 28,
  lg: 32,
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
      viewBox="196 55 162 113"
      role="img"
      aria-label="openma"
      className={`shrink-0 ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <mask id="oma-logo-mask" maskUnits="userSpaceOnUse">
          <rect x="-200" y="-200" width="900" height="900" fill="white" />
          <rect x="-4" y="16.4" width="62.2" height="108.8" fill="black" rx="2" />
          <rect x="96" y="16.4" width="62.2" height="108.8" fill="black" rx="2" />
        </mask>
      </defs>
      <g
        transform="translate(200, 40)"
        fill="none"
        stroke="#FF6B50"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <text
          fontFamily="'JetBrains Mono Variable', 'JetBrains Mono', 'SF Mono', monospace"
          fontSize="90"
          fontWeight="800"
          fill="#FF6B50"
          stroke="none"
          x="0"
          y="102"
        >
          [
        </text>
        <g transform="translate(52, 10)">
          <path d="M30,50 Q28,30 22,8 Q35,20 40,45" mask="url(#oma-logo-mask)" />
          <path
            d="M30,50 Q28,58 30,65"
            strokeWidth="3"
            mask="url(#oma-logo-mask)"
          />
          <circle cx="34" cy="52" r="3.5" fill="#FF6B50" stroke="none" />
        </g>
        <text
          fontFamily="'JetBrains Mono Variable', 'JetBrains Mono', 'SF Mono', monospace"
          fontSize="90"
          fontWeight="800"
          fill="#FF6B50"
          stroke="none"
          x="100"
          y="102"
        >
          ]
        </text>
      </g>
    </svg>
  );
}
