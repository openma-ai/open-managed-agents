#!/usr/bin/env python3
"""Render per-page Open Graph cards (1200x630) into public/og/.

Cards reuse the layout of public/og-default.svg: brand row, eyebrow,
serif headline, footer URL and the orange accent bar. Headlines come
from the landing-page list below and from blog frontmatter titles.

    python3 scripts/og-images.py      # from apps/web

Requires Python 3 with cairosvg. Output PNGs are committed so the
static build has no render step.
"""
import pathlib, re, textwrap
from xml.sax.saxutils import escape
import cairosvg

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "og"
LOGO = re.search(r'(<g transform="translate\(0 -40\).*?</g>)',
                 (ROOT / "public" / "og-default.svg").read_text(), re.S).group(1)

LANDING = {
    "ai-agent-platform": "AI Agent Platform & Orchestration Runtime",
    "claude-managed-agents-alternative": "Claude Managed Agents Alternatives: Open-Source & Self-Hosted",
    "open-source-managed-agents": "Open-Source Managed Agent Runtimes Compared",
    "self-hosted-ai-agents": "Self-Hosted AI Agents: Run Agents on Your Infra",
    "what-is-claude-managed-agents": "What Is Claude Managed Agents?",
    "open-source-ai-agents": "Open-Source AI Agents & Agent Platforms",
    "claude-tag-alternative": "Open-Source, Self-Hosted Claude Tag Alternative",
    "claude-tag-open-source": "Open-Source Claude Tag: Build Tag-Style Agents",
    "self-hosted-claude-tag": "Self-Hosted Claude Tag: Open-Source Runtime for Tag-Style Agents",
}

def card(headline: str, eyebrow: str, path: str) -> str:
    size, width = 64, 24
    lines = textwrap.wrap(headline, width, break_on_hyphens=False)
    if len(lines) > 3:
        size, width = 52, 30
        lines = textwrap.wrap(headline, width, break_on_hyphens=False)
    # cairosvg has no per-glyph fallback, so CJK titles get a CJK face.
    family = "Noto Serif CJK SC" if re.search(r"[\u3000-\u9fff]", headline) else "DM Sans"
    top = 300 if len(lines) < 3 else 270
    tspans = "".join(
        f'<tspan x="80" y="{top + i * int(size * 1.18)}">{escape(l)}</tspan>'
        for i, l in enumerate(lines))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fff7ed"/><stop offset="100%" stop-color="#ffedd5"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<g opacity="0.18" transform="translate(960, 80)"><rect width="160" height="36" fill="#f84f32" rx="4"/><rect y="56" width="160" height="36" fill="#f84f32" rx="4"/><rect y="112" width="160" height="36" fill="#f84f32" rx="4"/></g>
<g transform="translate(80, 100)">{LOGO}<text x="82" y="0" font-family="JetBrains Mono, monospace" font-weight="700" font-size="36" fill="#16181d">openma</text></g>
<text x="80" y="200" font-family="DM Sans, sans-serif" font-weight="500" font-size="22" letter-spacing="3" fill="#ea580c">{escape(eyebrow)}</text>
<text font-family="{family}" font-weight="700" font-size="{size}" fill="#16181d">{tspans}</text>
<text x="80" y="560" font-family="JetBrains Mono, monospace" font-weight="500" font-size="22" fill="#4a4f5a">openma.ai{escape(path)}</text>
<rect y="620" width="1200" height="10" fill="#f84f32"/>
</svg>'''

def render(name: str, headline: str, eyebrow: str, path: str):
    dest = OUT / f"{name}.png"
    dest.parent.mkdir(parents=True, exist_ok=True)
    cairosvg.svg2png(bytestring=card(headline, eyebrow, path).encode(), write_to=str(dest),
                     output_width=1200, output_height=630)
    print(dest.relative_to(ROOT))

for slug, h in LANDING.items():
    render(slug, h, "GUIDE", f"/{slug}/")

for md in sorted((ROOT / "src" / "content" / "blog").glob("*.md")):
    m = re.search(r'^title:\s*"?(.*?)"?\s*$', md.read_text(), re.M)
    title = re.sub(r"\s*\|\s*OpenMA$", "", m.group(1))
    render(f"blog/{md.stem}", title, "BLOG", f"/blog/{md.stem}/")

# Chinese posts: src/content/blog/zh/<slug>.md -> /zh/blog/<slug>/, og/blog/zh/<slug>.png
for md in sorted((ROOT / "src" / "content" / "blog" / "zh").glob("*.md")):
    m = re.search(r'^title:\s*"?(.*?)"?\s*$', md.read_text(), re.M)
    render(f"blog/zh/{md.stem}", m.group(1), "BLOG", f"/zh/blog/{md.stem}/")
