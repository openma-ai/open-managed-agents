# Competitor keywords — CMA alternative cluster

**Pillar:** `claude managed agents alternative`  
**Site:** https://openma.ai  
**GSC property:** `sc-domain:openma.ai`  
**GSC window:** 2026-10-07 → 2026-11-03 (28d)  
**Generated:** 2026-11-03 ~06:45 America/Detroit  
**Related plan:** `cluster-plan.md` / `.json`

Volumes: **Keyword Planner absolute volumes unavailable** → column shows `unknown`. GSC impressions are a **site-relative demand proxy only**, not market search volume. **No invented numbers.**

---

## Blocker: Google Ads Keyword Planner

| Check | Result |
|-------|--------|
| `https://www.google.com/` (curl) | HTTP 200 |
| `https://ads.google.com/` (curl) | HTTP 302 → login |
| `…/aw/keywordplanner/home` | Ends at `accounts.google.com` sign-in (HTTP 200 login page) |
| Box browser (prior) | Timed out to Google |
| `~/.config/claude-seo/` | **Missing** |
| `google-ads.yaml` / Ads Python lib | **Not found / not installed** |
| Google Trends | HTTP 429 |
| DataForSEO / Semrush / Ahrefs keys | **None** |

**Conclusion:** Network can reach Ads host, but Planner needs an authenticated Ads account or Ads API credentials. Until unblocked, leave `volume=unknown`.

**Unblock options for parent/user:**
1. Drop Ads API creds (developer token + OAuth + customer id) on the box, or
2. Complete Google Ads sign-in in box browser for Keyword Planner UI, or
3. Manually export Keyword Planner CSV into `/workspace/oma-seo-cluster/`.

---

## Keyword table

| Keyword | Cluster | GSC impr | GSC clicks | Pos | Volume | Competition notes | Recommended page / issue |
|---------|---------|----------|------------|-----|--------|-------------------|--------------------------|
| `claude managed agents alternative` | Pillar | 13 | 0 | 18.5 | unknown | Commercial SERP: Omnara, TrueForge/TrueFoundry, OpenMA comparison blog, Anthropic docs bleed. Seed currently lands on /blog/claude-managed-agents-vs-open-managed-agents/ (pos ~18.5). | `https://openma.ai/claude-managed-agents-alternative/` · #490 (cluster research parent); NEED NEW: seo landing pillar CMA-alt (draft below) |
| `claude managed agents alternatives` | Pillar | — | — | — | unknown | Same-post merge into pillar (plural). Omnara/TrueForge listicles own similar titles. | `https://openma.ai/claude-managed-agents-alternative/` · #490; same new pillar issue |
| `best claude managed agents alternative` | Pillar | — | — | — | unknown | Commercial modifier; same SERP family as seed. | `https://openma.ai/claude-managed-agents-alternative/` · #490; same new pillar issue |
| `open source alternative to claude managed agents` | Pillar | — | — | — | unknown | Weak existing post /blog/open-source-alternatives-to-claude-managed-agents-2026/ (4 impr) — absorb into pillar. | `https://openma.ai/claude-managed-agents-alternative/` · #490; pillar issue + absorb note |
| `open source claude managed agents` | Pillar | — | — | — | unknown | Open-source angle of seed; Omnara/TrueForge/OpenMA. | `https://openma.ai/claude-managed-agents-alternative/` · #490; pillar issue |
| `self hosted claude managed agents` | Pillar | 1 | 0 | 23.0 | unknown | GSC 1 impr on Tag how-to blog — wrong landing; pillar + self-host spoke should own. | `https://openma.ai/claude-managed-agents-alternative/` · #490; pillar + self-host how-to draft |
| `openma vs claude managed agents` | CMA Alternatives & Comparisons | — | — | — | unknown | Existing comparison URL already captures seed + head-term impressions but 0 clicks / pos 29 — highest-leverage optimize. Competitor listicles: Omnara, TrueForge. | `https://openma.ai/blog/claude-managed-agents-vs-open-managed-agents/` · #466 (comparison hub); NEED NEW: optimize CMA vs OpenMA post (draft below); also feeds #490 |
| `claude managed agents vs open managed agents` | CMA Alternatives & Comparisons | — | — | — | unknown | Exact title-shape for existing blog; GSC query-level not shown as exact string this window. | `https://openma.ai/blog/claude-managed-agents-vs-open-managed-agents/` · #466 + optimize draft |
| `openai agents api alternative` | CMA Alternatives & Comparisons | — | — | — | unknown | Adjacent commercial SERP (OpenAI Agents API). Existing /blog/openai-agents-api-self-hosted/ not in top page rows this 28d — low/zero GSC visibility. | `https://openma.ai/blog/openai-agents-api-self-hosted/` · #466; optional follow-up optimize after CMA pillar |
| `claude managed agents pricing` | CMA Alternatives & Comparisons | — | — | — | unknown | Pricing/cost SERP dominated by Anthropic + competitor comparison posts citing $0.08/session-hour etc. Gap page. Related secondary: claude managed agents cost. | `https://openma.ai/blog/claude-managed-agents-pricing/` · NEED NEW: seo pricing page (draft below); link from #466/#490 |
| `claude managed agents cost` | CMA Alternatives & Comparisons | — | — | — | unknown | Same-intent as pricing. | `https://openma.ai/blog/claude-managed-agents-pricing/` · same pricing draft |
| `open source managed agents` | Self-Host & Open-Source Managed Agents | 5 | 0 | 9.8 | unknown | Currently homepage captures 5 impr — wrong URL for commercial best-of. Competitors: Omnara, TrueForge, OpenHands, OpenGeni. | `https://openma.ai/open-source-managed-agents/` · NEED NEW: open-source managed agents best-of (draft); #489/#490 |
| `managed agents open source` | Self-Host & Open-Source Managed Agents | 5 | 0 | 10.6 | unknown | Word-order variant; also homepage today. | `https://openma.ai/open-source-managed-agents/` · same OSS managed agents draft |
| `how to self host managed agents platform` | Self-Host & Open-Source Managed Agents | — | — | — | unknown | How-to SERP; adjacent Omnara self-hosted guides. Related GSC: self hosted claude managed agents = 1. | `https://openma.ai/blog/self-host-managed-agents-platform/` · NEED NEW: self-host how-to (draft); related docs self-host already exist |
| `self host managed agents docker` | Self-Host & Open-Source Managed Agents | — | — | — | unknown | Docker long-tail; docs://self-host/node-docker may support but not commercial spoke. | `https://openma.ai/blog/self-host-managed-agents-platform/` · same self-host how-to draft |
| `what is claude managed agents` | What Is Claude Managed Agents | 7 | 0 | 67.9 | unknown | Anthropic-docs-dominated informational SERP. Currently comparison blog at pos ~68 — need dedicated explainer. | `https://openma.ai/what-is-claude-managed-agents/` · #462 |
| `claude managed agents` | What Is Claude Managed Agents | 18 | 0 | 67.4 | unknown | Head term; climb via explainer (#462) then interlink to pillar — do not target homepage. | `https://openma.ai/what-is-claude-managed-agents/` · #462 |
| `what are claude managed agents` | What Is Claude Managed Agents | 1 | 0 | 73.0 | unknown | Plural variant of explainer. | `https://openma.ai/what-is-claude-managed-agents/` · #462 |
| `claude managed agents sandbox` | What Is Claude Managed Agents | 1 | 0 | 23.0 | unknown | Anthropic sandbox docs dominate; differentiate Anthropic sandbox vs full self-hosted platform. | `https://openma.ai/blog/claude-managed-agents-sandbox/` · NEED NEW: sandbox explainer (draft); related #462 |
| `claude managed agents self-hosted sandboxes` | What Is Claude Managed Agents | 1 | 0 | 75.0 | unknown | Long-tail; same sandbox spoke. | `https://openma.ai/blog/claude-managed-agents-sandbox/` · sandbox draft |
| `claude tag alternative` | Claude Tag Alternatives (Open / Self-Hosted) | 17 | 0 | 10.7 | unknown | Separate SERP family from CMA (overlap 0–1). Competitors: AgentConnect, OpenTag, Ankole, Centaur. Page CTR 2.8% — optimize title/meta + competitor table. | `https://openma.ai/claude-tag-alternative/` · #467 |
| `opensource claude tag alternative` | Claude Tag Alternatives (Open / Self-Hosted) | 33 | 0 | 7.5 | unknown | Highest non-brand GSC query this window. Split across /claude-tag-alternative/ (14) and cannibal blog (19). | `https://openma.ai/claude-tag-alternative/` · #467; note cannibal /blog/claude-tag-open-source-alternative/ |
| `open source alternative to claude tag` | Claude Tag Alternatives (Open / Self-Hosted) | 18 | 0 | 6.6 | unknown | Split 11 vs 7 between landing and cannibal blog. | `https://openma.ai/claude-tag-alternative/` · #467 |
| `open source claude tag` | Claude Tag Alternatives (Open / Self-Hosted) | 30 | 1 | 10.3 | unknown | Existing /claude-tag-open-source/ owns majority; some bleed to self-hosted page. | `https://openma.ai/claude-tag-open-source/` · #467 |
| `claude tag open source` | Claude Tag Alternatives (Open / Self-Hosted) | 23 | 0 | 6.6 | unknown | Word-order variant; primarily /claude-tag-open-source/. | `https://openma.ai/claude-tag-open-source/` · #467 |
| `open claude tag` | Claude Tag Alternatives (Open / Self-Hosted) | 13 | 0 | 7.3 | unknown | Currently landing on /self-hosted-claude-tag/ — reinforce open-source spoke canonical. | `https://openma.ai/claude-tag-open-source/` · #467 |
| `self-hosted claude tag` | Claude Tag Alternatives (Open / Self-Hosted) | — | — | — | unknown | Best Tag CTR page (6.5%). Related query 'claude tag self hosted' 7 impr @pos 4. | `https://openma.ai/self-hosted-claude-tag/` · #467 |
| `claude tag self hosted` | Claude Tag Alternatives (Open / Self-Hosted) | 7 | 0 | 4.0 | unknown | Strong position; impressions split self-host landing vs blog. | `https://openma.ai/self-hosted-claude-tag/` · #467 |
| `claude tag vs self-hosted agent platforms` | Claude Tag Alternatives (Open / Self-Hosted) | 17 | 0 | 6.6 | unknown | Impressions fragmented across 5 URLs including comparison CMA blog and cannibal Tag blog — consolidate signal onto /blog/self-hosted-claude-tag-open-source/. | `https://openma.ai/blog/self-hosted-claude-tag-open-source/` · #467 |
| `omnara claude managed agents` | CMA Alternatives & Comparisons | — | — | — | unknown | Competitor brand+product; Omnara owns. Mention in pillar competitor table; do not create Omnara-primary page. | `https://openma.ai/claude-managed-agents-alternative/` · pillar draft only |
| `trueforge claude managed agents` | CMA Alternatives & Comparisons | — | — | — | unknown | TrueForge/TrueFoundry MIT harness listicle ranks for alternatives; include in pillar table. | `https://openma.ai/claude-managed-agents-alternative/` · pillar draft only |

### Page-level GSC proxies (when query-level missing)

| Page | Impr | Clicks | Pos | Role |
|------|------|--------|-----|------|
| https://openma.ai/blog/claude-managed-agents-vs-open-managed-agents/ | 102 | 0 | 29.3 | cluster-relevant |
| https://openma.ai/claude-tag-alternative/ | 72 | 2 | 7.9 | cluster-relevant |
| https://openma.ai/claude-tag-open-source/ | 62 | 3 | 7.4 | cluster-relevant |
| https://openma.ai/self-hosted-claude-tag/ | 92 | 6 | 5.7 | cluster-relevant |
| https://openma.ai/blog/self-hosted-claude-tag-open-source/ | 81 | 4 | 8.1 | cluster-relevant |
| https://openma.ai/blog/claude-tag-open-source-alternative/ | 62 | 0 | 7.4 | cluster-relevant |
| https://openma.ai/blog/open-source-alternatives-to-claude-managed-agents-2026/ | 4 | 0 | 6.8 | cluster-relevant |
| https://openma.ai/blog/migrate-from-claude-managed-agents/ | 3 | 0 | 7.0 | cluster-relevant |
| https://openma.ai/blog/openai-agents-api-self-hosted/ | — | — | — | not in top-46 page rows this window |
| https://docs.openma.ai/ | 168 | 0 | 4.8 | cluster-relevant |
| https://openma.ai/ | 703 | 69 | 4.2 | cluster-relevant |

---

## Existing GitHub seo issue mapping

| Issue | Maps to |
|-------|---------|
| #490 | Parent SERP/cluster research (this overlay feeds it) |
| #489 | Broader keyword research |
| #462 | `what is claude managed agents` explainer |
| #467 | Claude Tag alternatives optimize cluster |
| #466 | Comparison hub (platforms) |
| #463–#465 | Adjacent AAS / Devin / Cursor — not CMA-alt core |

**No GitHub comments/issues posted this turn.** Draft issue texts for parent approval are in `competitor-keywords-cma-alt.json` → `draft_github_issues_for_parent_approval` and summarized below.

---

## Draft issues (parent approval only — not filed)

### Draft 1: seo: landing page — Claude Managed Agents alternative (pillar)

```
## Goal
New pillar page for seed `claude managed agents alternative` consolidating open-source / self-hosted / best-alternative merges.

## Proposed URL
`https://openma.ai/claude-managed-agents-alternative/`

## Template / outline only (no long-form body here)
- Template: ultimate-guide (~3200 words when written)
- H1: Claude Managed Agents Alternatives: Open-Source & Self-Hosted Options
- Sections: what CMA is (link #462) · why look for alternatives · comparison table (OpenMA, Omnara, TrueForge, OpenAI Agents API, Gemini MA, Bedrock AgentCore, Foundry) · self-host path · pricing pointer · FAQ
- Absorb strongest bits from `/blog/open-source-alternatives-to-claude-managed-agents-2026/` (4 impr)

## Evidence (GSC 28d, sc-domain:openma.ai, 2026-10-07→2026-11-03)
- Query `claude managed agents alternative`: 13 impr / 0 clicks / pos 18.5 → currently comparison blog
- Keyword Planner absolute volume: **unknown** (blocked — no Ads auth)

## Links
- Parent research: #490 #489
- Related optimize: existing vs post
- Explainer: #462
```

### Draft 2: seo: optimize — Claude Managed Agents vs Open Managed Agents (CTR/depth)

```
## Goal
Optimize `https://openma.ai/blog/claude-managed-agents-vs-open-managed-agents/` — highest CMA leverage before new pages.

## Evidence (GSC 28d)
- Page: 102 impr / 0 clicks / CTR 0% / pos 29.3
- Captures queries: `claude managed agents` (18@67), `claude managed agents alternative` (13@18.5), `what is claude managed agents` (7@68), sandbox variants

## Changes (title/meta/H1/structure only this ticket)
- Retarget title/H1 toward OpenMA vs Claude Managed Agents + alternative intent
- Add comparison table + clear CTAs to pillar (when live) and #462
- Fix snippet CTR; deepen differentiators (BYOK, self-host, sandbox model)

## Related
#466 #490; pillar draft
```

### Draft 3: seo: landing page — Claude Managed Agents pricing

```
## Goal
New review/pricing spoke: `claude managed agents pricing` (+ cost secondary).

## Proposed URL
`/blog/claude-managed-agents-pricing/`

## Notes
- GSC exact query: none this 28d window
- Keyword Planner volume: **unknown**
- Outline only: Anthropic session-hour pricing explained · compare OpenMA/Omnara/TrueForge cost models · link pillar + vs post

## Related
#466 #490; pillar draft
```

### Draft 4: seo: landing page — Open source managed agents

```
## Goal
Best-of page for `open source managed agents` / `managed agents open source`.

## Proposed URL
`/open-source-managed-agents/`

## Evidence
- GSC: 5+5 impr currently on homepage (wrong landing)

## Related
#489 #490; self-host how-to draft
```

### Draft 5: seo: how-to — Self-host managed agents platform

```
## Goal
How-to spoke: `how to self host managed agents platform` (+ docker / self-host CMA secondaries).

## Proposed URL
`/blog/self-host-managed-agents-platform/`

## Evidence
- Related GSC: `self hosted claude managed agents` 1 impr @23 (wrong Tag blog)

## Related
docs self-host section exists — this is marketing/how-to spoke, not docs rewrite
```

### Draft 6: seo: explainer — Claude Managed Agents sandbox

```
## Goal
Explainer for `claude managed agents sandbox` (+ self-hosted sandboxes variants).

## Proposed URL
`/blog/claude-managed-agents-sandbox/`

## Evidence
- GSC: 1 impr each for sandbox / self-hosted sandboxes queries
- Differentiate Anthropic sandbox vs full self-hosted platform; interlink #462 + self-host how-to

## Related
#462
```

---

## Competitor landscape (SERP notes, not volumes)

**CMA commercial family:** Omnara, TrueForge/TrueFoundry, OpenMA, OpenAI Agents API, Gemini Managed Agents, Bedrock AgentCore, Microsoft Foundry Agent Service, LangChain deepagents, DigitalOcean Managed Agents, OpenGeni, OpenComputer.

**Claude Tag family (separate SERP):** AgentConnect, OpenTag, Ankole, Centaur + existing OpenMA Tag URLs.

Sources: Omnara/TrueFoundry public alternatives posts; prior `cluster-plan.md`; fresh GSC via SearchConsole.ai MCP.

---

## Chinese summary (for parent → user)

见同目录 `competitor-keywords-cma-alt.zh.md`。

