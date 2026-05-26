# apps/web/public/

Static files served at the site root.

## Files

| File | Purpose |
|---|---|
| `logo.svg` | Brand wordmark — header logo + SVG favicon |
| `logo.png` | Brand wordmark, rasterized at 950×610. Used as JSON-LD `Organization.logo` since Google rejects SVG there. |
| `og-default.svg` | Source for `og-default.png` (1200×630 OG card) |
| `og-default.png` | Open Graph default image (1200×630) — referenced by `Base.astro` `og:image` |
| `apple-touch-icon.png` | 180×180 iOS home-screen icon |
| `favicon-512.png` / `favicon-192.png` / `favicon-32.png` / `favicon-16.png` | PWA + browser favicons |
| `favicon.ico` | Multi-res ICO (16/32/48) — the path Google's favicon crawler checks first. Without one, Google falls back to a generic placeholder on the SERP. |
| `site.webmanifest` | PWA manifest |
| `robots.txt` | Crawler directives + sitemap pointer |

## Regenerating the raster assets

The PNG files are committed (so the static site doesn't need a render
step at deploy time), but they can be reproduced from the source SVGs:

```bash
cd apps/web/public

# Brand logo (Google JSON-LD Organization.logo — must be PNG, not SVG)
rsvg-convert -w 950 -h 610 logo.svg -o logo.png

# OG card
rsvg-convert -w 1200 -h 630 og-default.svg -o og-default.png

# Favicons. `_favicon-square.svg` is a thin wrapper that centers
# `logo.svg` (the canonical brand mark) inside a 512×512 frame with
# padding — used only as the rasterization source so the PNG set
# matches the SVG favicon at `/logo.svg`.
rsvg-convert -w 180 -h 180 _favicon-square.svg -o apple-touch-icon.png
rsvg-convert -w 192 -h 192 _favicon-square.svg -o favicon-192.png
rsvg-convert -w 512 -h 512 _favicon-square.svg -o favicon-512.png
rsvg-convert -w 32 -h 32 _favicon-square.svg -o favicon-32.png
rsvg-convert -w 16 -h 16 _favicon-square.svg -o favicon-16.png

# Multi-resolution favicon.ico (16/32/48) — Google's favicon crawler
# checks /favicon.ico first; without it the SERP falls back to a
# generic placeholder.
python3 -c "from PIL import Image; img = Image.open('favicon-192.png').convert('RGBA'); img.save('favicon.ico', sizes=[(16,16),(32,32),(48,48)])"
```

Requires `rsvg-convert` (`brew install librsvg`) and Python 3 with Pillow (`pip install Pillow`).

## What's not generated automatically

- Per-post OG images — `BlogPostSchemaInput.image` already supports
  per-post overrides. Wire `astro-og-canvas` later if blog volume
  justifies bespoke cards.
