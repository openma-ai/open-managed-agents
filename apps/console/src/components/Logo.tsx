/**
 * Canonical OpenMA mark. Inlined as React SVG (no `<img>` round-
 * trip and no width/height-attr-vs-CSS-class mismatch that previously
 * caused an 8-px collapse on first paint when CSS resized 32×32 →
 * 24×24).
 *
 * trip) and filled with the semantic brand token so a parent text color cannot
 * accidentally turn the product mark gray.
 */
const SIZE_PX = {
  sm: 24,
  md: 28,
  lg: 32,
} as const;

interface LogoProps {
  size?: keyof typeof SIZE_PX;
  /** Brand is the product identity. Current is reserved for intentional
   * monochrome or inverse treatments supplied by the surrounding surface. */
  tone?: "brand" | "current";
  className?: string;
}

export function Logo({ size = "sm", tone = "brand", className = "" }: LogoProps) {
  const px = SIZE_PX[size];
  const fill = tone === "brand" ? "var(--brand)" : "currentColor";
  return (
    <svg
      width={px}
      height={px}
      viewBox="240 244 548 454"
      role="img"
      aria-label="openma"
      className={`shrink-0 ${className}`.trim()}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill={fill}>
        <path d="M279 363H346C356 363 363 371 363 381V397C363 407 356 414 346 414H320C312 414 308 419 308 427V620C308 628 313 633 321 633H349C357 633 363 640 363 648V665C363 675 355 683 345 683H279C265 683 254 672 254 658V388C254 374 265 363 279 363Z" />
        <path d="M748 363H681C671 363 666 371 666 381V397C666 407 673 414 683 414H708C716 414 720 419 720 427V620C720 628 715 633 707 633H680C671 633 666 640 666 648V665C666 675 674 683 684 683H748C762 683 773 672 773 658V388C773 374 762 363 748 363Z" />
        <path d="M500 258C496 258 491 260 488 264C486 267 485 271 485 275V343C485 351 491 357 499 357H575C583 357 587 348 581 342L507 264C505 261 503 258 500 258Z" />
        <circle cx="535" cy="520" r="42" />
      </g>
    </svg>
  );
}
