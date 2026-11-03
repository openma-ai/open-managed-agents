# OpenMA (openma.ai) SEO Content Plan — Hub & Spoke

- **Site:** https://openma.ai  
- **Generated:** 2026-11-03 (~07:20 America/Detroit, UTC-5)  
- **Methodology:** [AgriciDaniel/claude-seo seo-cluster](https://github.com/AgriciDaniel/claude-seo/blob/main/skills/seo-cluster/SKILL.md) — seed expansion → SERP-overlap clustering → hub-spoke  
- **Seed:** `claude managed agents alternative`  
- **Owner rules:** outlines / title / meta / key points only — **no long-form body**; brand ≠ category demand; **openma.dev deprecated** (do not target); “open-source” / “self-hosted” prefix OK on category terms; OpenMA = **orchestration / managed runtime** (AX-like), not “just a coding agent”; “decoupling brain from hands” OK as theme; flag no-code carefully (OMA is low-code-ish, not pure no-code).

**Research inputs (do not invent SERPs/volumes):**  
`keyword-rank-volume-kd-2026-11-03.*` · `aisa-keyword-expand-2026-11-03.*` · `cluster-plan.*` · `serp-claude-managed-agents-2026-11-03.*` · `serp-openai-agents-api-2026-11-03.*` · `cma-and-competitor-seo-pages-2026-11-03.*` · `competitor-transparency-seo-pages-2026-11-03.*` · `competitor-keywords-*.*` · `gsc-overlay-fresh-2026-11-03.json`

---

## 1. Seed expansion (Step 1)

| Source | What it contributed |
|--------|---------------------|
| GSC 28d + early cluster | CMA-alt / Tag / what-is / pricing longtails (impressions as demand proxy) |
| AIsa / DataForSEO Labs+Ads | Volumes + KD for 200+ preferred-theme KWs; filled prior “unknown” rows where available |
| CMA / OpenAI SERP pulls | Related searches + PAA + organic `content_type` labels |
| Competitor planted phrases | Official CMA (agent harness, session runtime, brain/hands), Qoder AaaS, AX orchestration, TrueForge/Omnara alternatives |

**High-opportunity category terms** (from composite ranking; brand flood capped):

| Keyword | Vol | KD | Opp | Theme |
|---------|----:|---:|----:|-------|
| self-hosted ai agent | 5400 | 0 | 5400 | Self-host / OSS |
| claude agents sdk | 12100 | 9 | 1344 | Claude Agent SDK |
| claude agent sdk | 12100 | 15 | 807 | Claude Agent SDK |
| no code ai agent builder | 5400 | 10 | 540 | Platforms (**flag**) |
| open source ai agents | 9900 | 19 | 521 | Self-host / OSS |
| openai agent builder | 5400 | 13 | 415 | OpenAI / builder (**brand-ish**) |
| claude managed agents | 9900 | 33 | 300 | CMA hub |
| ai agent builder | 6600 | 35 | 189 | Platforms (**flag**) |
| ai agent platform | 2400 | 27 | 89 | Platforms |
| ai agent orchestration | 590 | 8 | 74 | Orchestration |
| no code ai agent platform | 1000 | 16 | 63 | Platforms (**flag**) |
| anthropic managed agents | 1300 | 28 | 46 | Managed agents category |
| openai agents sdk / agent sdk | 4400 | — | — | OpenAI compare |
| openai agents api | 480 | — | — | OpenAI compare |
| claude managed agents pricing | 260 | 17 | 15 | CMA pricing |
| open-source / open source ai agent platform | 590 | 29–33 | ~18–20 | OSS platform |
| claude managed agents alternative | 10 (Ads) / GSC 13 impr | — | — | Seed / pillar |

**Excluded from hubs:** navigational brand dumps (openclaw / cowork / hermes flood, openma brand-nav, **openma.dev**). Mention adjacent brands only inside comparison tables.

---

## 2. SERP-overlap clustering (Step 2)

### 2.1 Confirmed matrix (from `cluster-plan.json` serp_matrix)

Keyword order:  
0 alt · 1 openma vs CMA · 2 openai agents api alt · 3 CMA pricing · 4 OSS managed agents · 5 self-host how-to · 6 what-is CMA · 7 sandbox · 8 tag alt · 9 OSS claude tag · 10 self-hosted tag · 11 tag vs platforms

| Shared top-10 | Relationship | Action in this plan |
|--------------|--------------|---------------------|
| 7–10 | Same post | Merge secondaries into one URL (already applied on pillar + Tag landings) |
| 4–6 | Same cluster | CMA Alternatives; Self-Host & OSS Managed Agents; Tag family among themselves |
| 2–3 | Interlink | what-is ↔ pricing ↔ pillar; limited Tag↔CMA bridge |
| 0–1 | Separate | **Entire Claude Tag family vs CMA family** — do not merge |

**Same-cluster (examples):** pillar↔vs OpenMA (5), pillar↔OpenAI alt (5), pillar↔OSS managed agents (5), OSS↔self-host how-to (6), OpenAI alt↔OSS (5).  
**Separate:** Tag primaries ↔ CMA primaries (~0–1).

> Scoring note from plan: partial/lower-bound WebSearch synthesis; Tag↔CMA boundary spot-checked.

### 2.2 Theme co-clusters (SERP pairwise **not** run — budget; from AIsa expand labels)

Treat as **adjacent spokes / new clusters** under the same commercial program, not as proven same-SERP merges:

- Claude / Agents SDK (vol 12.1k)
- AI Agent Platforms + Orchestration
- OpenAI Agents API / SDK / AgentKit
- Self-hosted / open-source **AI agents** (broader than “managed agents”)

Before merging any of these into an existing URL, run SERP-overlap spot-checks (DataForSEO or WebSearch top-10 URL share).

### 2.3 SERP article-type distribution → template choice

Observed `content_type` on organics (from `serp-*-2026-11-03.json`; **not invented**):

| Query | Winning article types (organic counts) | Template implication for OpenMA |
|-------|----------------------------------------|----------------------------------|
| `claude managed agents` | reddit 1, blog_ugc 2, blog_vendor 2, forum_hn 1, youtube 1, pricing 1 | **Explainer / overview hub** (vendor-blog shape) + FAQ; AI Overview cites Anthropic docs — differentiate with limits + “when to use something else” |
| `claude managed agents alternative` | comparison 3, blog_vendor 2, reddit 1, github 1, blog_ugc 1, forum_hn 1 | **Comparison / alternatives listicle** (ultimate-guide commercial) with OSS+GitHub proof + decision table |
| `claude managed agents pricing` | pricing 7, reddit 1, official 1 | **Pricing breakdown / review** (session-hour + tokens + worked example); third parties own SERP — gap open |
| `openai agents api` | official 1, github 1, pricing 1, blog_vendor 1, review 1, youtube 2 | **Compare / review** vs managed multi-model runtime; migration+cost themes |
| `openai agents sdk` | tutorial 2, blog_vendor 2, blog_ugc 2 | **Explainer + compare** (SDK scope vs managed runtime / durability); not pure tutorial clone |
| `openai agentkit` | blog_ugc 2, blog_vendor 2, official 2, reddit 1, youtube 1 | Careful builder spoke; pair with low-code **flag** |

**Competitor pattern exemplars to emulate (structure only):** LangChain Fleet comparison matrix · Deep Agents vs Claude Agent SDK · TrueForge CMA alternatives/pricing · Omnara CMA alternatives · OpenAI cookbook migrate Claude Agent SDK → OpenAI Agents SDK · AX “agentic orchestration runtime”.

---

## 3. Hub-and-spoke architecture (Steps 4–5)

### Positioning one-liner (every page)

OpenMA is an **open-source / self-hostable agent orchestration & managed runtime** (brain/hands decoupling, sessions, sandboxes, multi-model) — peer to CMA / OpenAI Agents API / AX-style runtimes — **not** a Claude Code clone and **not** pure no-code Zapier-for-agents.

### Map

```
                    [PILLAR] CMA Alternative (commercial ultimate-guide)
                     /          |           |            \
        Cluster A          Cluster B     Cluster C     Cluster D
     CMA Compare/         What-is CMA    Self-host &    (Tag — optimize
     Pricing/OpenAI       + Sandbox      OSS Agents &    existing only)
                                         Platforms
                                              |
                                    Cluster E (theme; SERP TBD)
                                 Claude Agent SDK + migrate
                                              |
                                    Cluster F (theme; SERP TBD)
                                 AI Agent Platform / Orchestration
                                 (+ careful low-code builder spoke)
```

**Pillar keyword:** `claude managed agents alternative` (seed; Ads vol 10; GSC 13 impr @~18.5).  
**Category demand engines** (self-host / OSS / SDK / platform) attach as high-priority spokes even when Ads vol on exact “CMA alternative” is low — they feed the commercial pillar via mandatory links.

---

## 4. Priority pages (briefs — no body)

Status: `NEW` · `OPTIMIZE` · `EXISTING`. Volumes/KD from research files only; `—` = unknown / not in KD set.

### P0 — Ship / rewrite first

---

#### P0.1 — Pillar: CMA Alternative  
- **Slug:** `/claude-managed-agents-alternative/`  
- **Status:** NEW (absorb weak `/blog/open-source-alternatives-to-claude-managed-agents-2026/`)  
- **H1:** Claude Managed Agents Alternatives: Open-Source & Self-Hosted Options  
- **Meta title:** Claude Managed Agents Alternative (Open-Source) \| OpenMA  
- **Meta desc:** Compare Claude Managed Agents to self-hosted, multi-model managed runtimes. OpenMA as open orchestration — not Claude-only cloud lock-in.  
- **Primary KW:** claude managed agents alternative (vol 10 Ads / GSC 13)  
- **Secondary:** claude managed agents alternatives (10); open source alternative to claude managed agents (—); open source claude managed agents (10); self hosted claude managed agents (10); best claude managed agents alternative (—)  
- **SERP format to match:** comparison / alternatives listicle (3 comparison + vendor blogs on SERP)  
- **Template:** ultimate-guide (commercial) · target ~3000–3200w when written  
- **Outline / key points:**
  - What CMA is (Agent / Environment / Session / Events; hosted harness) — link what-is spoke
  - Why teams look elsewhere: model lock-in, data residency, session-hour economics
  - Decision table: OpenMA · TrueForge · Omnara · OpenAI Agents API · Bedrock/Foundry · DIY SDK
  - Platform vs coding-agent vs framework (bar: managed runtime shape, not just LangGraph/CrewAI)
  - Self-host / open-source path — link OSS + self-host spokes
  - Pricing pointer — link pricing spoke
  - Theme: decoupling brain (model) from hands (runtime/tools/sandbox)
  - FAQ (from related: free / github / reddit alts)
- **Internal links:** → what-is CMA; pricing; vs OpenMA; OSS managed agents; self-host how-to; OpenAI compare; Claude Agent SDK spoke; platform/orchestration hub; docs.openma.ai  
- **Inbound:** all Cluster A/B/C spokes mandatory back to pillar

---

#### P0.2 — OPTIMIZE: OpenMA vs CMA  
- **Slug:** `/blog/claude-managed-agents-vs-open-managed-agents/` (reuse)  
- **Status:** OPTIMIZE — **102 GSC impr / 0 clicks / pos ~29** (highest leverage)  
- **H1:** Claude Managed Agents vs OpenMA (Open Managed Agents)  
- **Meta title:** Claude Managed Agents vs OpenMA \| Comparison  
- **Meta desc:** Side-by-side: Anthropic-hosted CMA vs open-source, multi-model managed agent runtime. Sessions, sandboxes, lock-in, cost shape.  
- **Primary:** openma vs claude managed agents / claude managed agents vs open managed agents (—)  
- **Secondary:** claude managed agents alternative; anthropic managed agents (1300 / KD 28)  
- **SERP format:** comparison matrix (Fleet / Deep Agents / Everruns pattern)  
- **Outline:**
  - Feature matrix: model choice, self-host, API shape, sandbox, observability, multi-tenancy
  - When CMA wins vs when OpenMA wins
  - Not a coding-IDE comparison (defer OpenHands/Claude Code)
  - CTA → pillar + pricing + docs
- **Internal links:** ↔ pillar; → pricing; → what-is; → self-host; → docs

---

#### P0.3 — CMA hub (what-is)  
- **Slug:** `/what-is-claude-managed-agents/`  
- **Status:** NEW  
- **H1:** What Is Claude Managed Agents?  
- **Meta title:** What Is Claude Managed Agents? Overview \| OpenMA  
- **Meta desc:** Plain-English overview of Anthropic’s managed agent runtime — vs Agent SDK, limits, and when to consider open alternatives.  
- **Primary:** what is claude managed agents (90); also climb head `claude managed agents` (9900 / KD 33)  
- **Secondary:** what are claude managed agents (70); claude managed agents overview (30); anthropic managed agents (1300 / 28)  
- **SERP format:** explainer / vendor-blog (head SERP = UGC + vendor blogs; AI Overview = Anthropic docs)  
- **Outline:**
  - Definition + official docs map (overview, sessions, environments)
  - CMA vs Claude Agent SDK (hosted harness vs in-process)
  - Planted concepts: agent harness, long-running sessions, brain/hands
  - Limits (Claude-only, Anthropic cloud) → CTA to pillar / pricing
- **Internal links:** → pillar; → pricing; → sandbox; → Claude Agent SDK spoke; → vs OpenMA

---

#### P0.4 — CMA pricing  
- **Slug:** `/blog/claude-managed-agents-pricing/`  
- **Status:** NEW  
- **H1:** Claude Managed Agents Pricing (2026): Session Runtime + Tokens  
- **Meta title:** Claude Managed Agents Pricing Explained \| OpenMA  
- **Meta desc:** Break down CMA session-hour and token costs, hidden spend, and cheaper self-host / multi-model paths.  
- **Primary:** claude managed agents pricing (260 / KD 17)  
- **Secondary:** claude managed agents cost (30); anthropic managed agents pricing (10); related SERP noise = Claude Code pricing (disambiguate)  
- **SERP format:** **pricing** pages dominate (7/9) — match breakdown + calculator-style worked example; cite public $0.08/session-hour shape carefully  
- **Outline:**
  - Official components (tokens + session runtime as publicly documented)
  - Disambiguate vs Claude Code / Cowork plan pricing (SERP conflation)
  - Hidden costs: tools, retries, idle/running status
  - Worked monthly example
  - Contrast: self-host / OpenMA cost shape (outline only)
- **Internal links:** ↔ pillar; → vs OpenMA; → what-is; → OSS managed agents

---

#### P0.5 — Self-hosted AI agents (category)  
- **Slug:** `/self-hosted-ai-agents/`  
- **Status:** NEW  
- **H1:** Self-Hosted AI Agents: Run Agents on Your Infra  
- **Meta title:** Self-Hosted AI Agents (Open-Source Runtime) \| OpenMA  
- **Meta desc:** Why teams self-host AI agents — control, data residency, multi-model. OpenMA as open managed runtime you can deploy yourself.  
- **Primary:** self-hosted ai agent (5400 / KD 0); self hosted ai agents (5400 / KD —)  
- **Secondary:** self hosted agent(s) (50); best open source ai agents (50 / 0)  
- **SERP format:** best-of / how-to hybrid (theme cluster; **pairwise SERP TBD**)  
- **Outline:**
  - Self-host vs vendor-managed (CMA / OpenAI Agents API)
  - Runtime vs coding-agent vs chatbot frameworks
  - Security / residency / BYOK
  - Path: Docker/K8s sketch → link how-to spoke
  - OpenMA positioning (orchestration runtime, not IDE)
- **Internal links:** → pillar; → OSS agents; → OSS platform; → self-host managed how-to; → orchestration

---

#### P0.6 — Open-source AI agents / platform  
- **Slug:** `/open-source-ai-agents/` (platform twin: `/open-source-ai-agent-platform/` or merge if SERP overlap ≥7 later)  
- **Status:** NEW (also keep planned `/open-source-managed-agents/` for managed-agents phrase — GSC already shows homepage stealing 5 impr)  
- **H1:** Open-Source AI Agents & Agent Platforms  
- **Meta title:** Open-Source AI Agents & Platforms \| OpenMA  
- **Meta desc:** Open-source AI agents and agent platforms — managed-runtime shape, self-host, multi-model. How OpenMA fits vs frameworks.  
- **Primary:** open source ai agents (9900 / KD 19)  
- **Secondary:** open source ai agent platform (590 / 33); open-source ai agent platform (590 / 29); open source managed agents (10 Ads / GSC 5)  
- **SERP format:** best-of / comparison  
- **Outline:**
  - Define “open-source agent platform” vs libraries (LangGraph/CrewAI/AutoGen)
  - Table: OpenMA, TrueForge, OpenHands (**coding**), AX (**orchestration**), Omnara
  - Prefer category phrases; brands only as examples
  - Link CMA alternative for commercial intent
- **Internal links:** → pillar; → self-hosted; → `/open-source-managed-agents/`; → AX/orchestration spoke; → Claude Agent SDK

**Companion (same cluster, confirmed overlap with pillar):**  
- `/open-source-managed-agents/` — H1 “Open-Source Managed Agents”; primary `open source managed agents` / `managed agents open source`; best-of template; status NEW.

---

#### P0.7 — Claude Agent SDK: compare / migrate angle  
- **Slug:** `/blog/claude-agent-sdk-vs-managed-agents/`  
- **Status:** NEW  
- **H1:** Claude Agent SDK vs Managed Agents (and When to Migrate)  
- **Meta title:** Claude Agent SDK vs Claude Managed Agents \| OpenMA  
- **Meta desc:** Claude Agent SDK runs in your process; Managed Agents host the harness. Compare, then see model-agnostic runtime options.  
- **Primary:** claude agents sdk (12100 / KD 9) **or** claude agent sdk (12100 / KD 15) — pick one canonical; mirror plural in copy  
- **Secondary:** claude agent sdk vs claude code (70 / 2); claude agent sdk documentation (50); anthropic-ai/claude agent sdk (260 / 19); migrate themes from OpenAI cookbook  
- **SERP format:** comparison (Deep Agents vs Claude Agent SDK exemplar) + migrate checklist  
- **Outline:**
  - SDK scope: tools, sandbox-in-process, skills
  - vs CMA hosted runtime
  - vs OpenAI Agents SDK migration narrative (link OpenAI spoke)
  - Gap: multi-model + self-host managed runtime → OpenMA
  - “Brain/hands”: model SDK ≠ orchestration substrate
- **Internal links:** → what-is CMA; → pillar; → OpenAI Agents SDK/API; → orchestration; → docs

---

#### P0.8 — OpenAI Agents API / SDK compare  
- **Slug:** `/blog/openai-agents-api-vs-openma/` (optimize/extend existing `/blog/openai-agents-api-self-hosted/` if same SERP — check overlap before dual URLs)  
- **Status:** NEW or OPTIMIZE existing self-hosted post  
- **H1:** OpenAI Agents API & SDK vs Open Managed Agent Platforms  
- **Meta title:** OpenAI Agents API / SDK Alternative \| OpenMA  
- **Meta desc:** Agents API (managed Codex harness) vs Agents SDK (self-run) vs model-agnostic managed runtimes you can self-host.  
- **Primary:** openai agents api (480); openai agents sdk / openai agent sdk (4400)  
- **Secondary:** openai agentkit (1600); openai agents api alternative (—); openai agent builder (5400 / 13) — use carefully  
- **SERP format:** API = official+review+vendor; SDK = tutorial+vendor blog — ship **comparison/review**, not another Getting Started clone  
- **Outline:**
  - Naming map: Agents API vs SDK vs AgentKit / Agent Builder
  - Durable execution note (Temporal appears on SDK SERP)
  - Migration / cost / data-control themes from SERP reviews
  - Compare to CMA and OpenMA
  - When OpenAI-only stack is enough vs multi-model runtime
- **Internal links:** ↔ pillar; → Claude Agent SDK spoke; → self-host; → platform hub; existing self-hosted OpenAI post

---

#### P0.9 — AI agent platform / orchestration hub  
- **Slug:** `/ai-agent-platform/`  
- **Status:** NEW  
- **H1:** AI Agent Platform & Orchestration Runtime  
- **Meta title:** AI Agent Platform & Orchestration \| OpenMA  
- **Meta desc:** What an AI agent platform is — orchestration, sessions, sandboxes — vs builders and coding agents. OpenMA as open managed runtime.  
- **Primary:** ai agent platform (2400 / KD 27)  
- **Secondary:** ai agent orchestration (590 / 8); multi agent orchestration (880); ai agent orchestration platform (110); open-source ai agent platform (590 / 29); enterprise ai agent platform (140)  
- **SERP format:** explainer + light comparison (Fleet “agent platform comparison” pattern)  
- **Outline:**
  - Category definition: managed runtime / orchestration (AX-like), not chatbot UI
  - Primitives: tasks/sessions, sandbox, gateway/model, durability
  - Platform vs SDK vs no-code builder
  - OpenMA fit; link CMA alt for commercial proof
- **Internal links:** → pillar; → orchestration deep-dive (optional spoke); → self-host; → OSS; → SDK spokes

**Optional spoke:** `/ai-agent-orchestration/` if SERP overlap with platform hub &lt; 7 — primary `ai agent orchestration` (590 / 8).

---

#### P0.10 — Low-code / builder spoke (**FLAGGED**)  
- **Slug:** `/blog/ai-agent-builder-low-code/`  
- **Status:** NEW — **careful**; do **not** claim pure no-code  
- **H1:** AI Agent Builder: Low-Code Orchestration (Not Just No-Code)  
- **Meta title:** AI Agent Builder & Low-Code Platforms \| OpenMA  
- **Meta desc:** No-code AI agent builders are popular — but production agents need a real runtime. Where low-code orchestration fits vs pure no-code.  
- **Primary:** prefer `ai agent builder` (6600 / 35) or `low code ai agent platform` (210) over pure no-code as H1 promise  
- **Secondary (traffic, honest framing):** no code ai agent builder (5400 / 10); no code ai agent platform (1000 / 16); openai agent builder (5400 / 13)  
- **FLAG:** OMA is **low-code-ish / config + code**, not pure no-code. Page must disambiguate; win on “builder → production runtime” narrative.  
- **SERP format:** vendor blog / practical guide (AgentKit SERP is UGC+vendor); avoid fake “best no-code” listicle if product can’t deliver  
- **Outline:**
  - Intent split: no-code DIY vs production orchestration
  - OpenAI AgentKit / Agent Builder as reference point
  - What still needs code (tools, policies, sandboxes)
  - OpenMA: visual/config where honest + runtime depth
  - CTA to platform hub + docs — not “zero code forever”
- **Internal links:** → platform hub; → OpenAI compare; → pillar; → docs

---

### P1 — Same program, next wave

| Slug | Primary | Template | Notes |
|------|---------|----------|-------|
| `/blog/self-host-managed-agents-platform/` | how to self host managed agents platform (—) | how-to | Confirmed same cluster as OSS managed agents (overlap 6) |
| `/blog/claude-managed-agents-sandbox/` | claude managed agents sandbox (10) | explainer | Anthropic sandbox vs full self-hosted platform |
| `/blog/migrate-from-claude-agent-sdk/` | migrate / Claude Agent SDK → runtime | how-to | Pair with OpenAI cookbook pattern; OpenMA landing |
| `/blog/decoupling-brain-from-hands-agents/` | theme phrase (planted by Anthropic research) | explainer | Category education; links CMA hub + platform |

### P2 — Optimize existing (Tag cluster — separate SERP family)

Do **not** invent new Tag pillars. Optimize titles/meta + competitor tables; fix cannibalization.

| URL | Role | GSC signal |
|-----|------|------------|
| `/claude-tag-alternative/` | Tag commercial | 72 impr, CTR ~2.8%, pos ~7.9 |
| `/claude-tag-open-source/` | OSS Tag | 62 impr |
| `/self-hosted-claude-tag/` | Self-host Tag | 92 impr, best Tag CTR |
| `/blog/self-hosted-claude-tag-open-source/` | vs platforms | 81 impr |
| `/blog/claude-tag-open-source-alternative/` | cannibal risk | 62 impr / 0 clicks — consolidate |

**Docs:** `https://docs.openma.ai/` — 168 impr / 0 clicks → title/meta only (not a content spoke).

---

## 5. Internal link rules

| Type | Rule |
|------|------|
| Mandatory | Every spoke ↔ pillar (`/claude-managed-agents-alternative/`) |
| Cluster siblings | 2–3 links within CMA / Self-host / SDK-OpenAI groups |
| Cross-cluster | 0–1: what-is↔pricing; SDK↔CMA hub; platform↔self-host; Tag→CMA **only** where positioning overlaps |
| Anchor text | Target KW or close variant (no “click here”) |
| Deprecated | Never link or plant **openma.dev** |

Minimum 3 inbound internal links per page before publish.

---

## 6. Publishing priority (next actions)

1. **OPTIMIZE** `/blog/claude-managed-agents-vs-open-managed-agents/` (P0.2) — CTR unlock  
2. **NEW** pillar `/claude-managed-agents-alternative/` (P0.1)  
3. **NEW** `/what-is-claude-managed-agents/` (P0.3) + **NEW** pricing (P0.4)  
4. **NEW** `/self-hosted-ai-agents/` (P0.5) + `/open-source-ai-agents/` + `/open-source-managed-agents/` (P0.6)  
5. **NEW** Claude Agent SDK compare/migrate (P0.7)  
6. **NEW/OPTIMIZE** OpenAI Agents API/SDK compare (P0.8)  
7. **NEW** `/ai-agent-platform/` (P0.9)  
8. **NEW** low-code builder spoke with flag (P0.10) — after platform hub exists  
9. Tag landings optimize + docs snippet (P2)  
10. Spot-check SERP overlap for theme co-clusters (SDK / platform / self-hosted AI agents) before any URL merges

---

## 7. Assumptions & non-goals

- No invented search volumes or SERP lists; theme co-clusters marked where pairwise overlap wasn’t run.  
- Brand terms (OpenHands, AX, Qoder, TrueForge, Omnara, openma) ≠ category demand — use inside tables, target category phrases in titles.  
- OpenHands / Claude Code alternatives = coding-agent SERP — out of scope except disambiguation.  
- This file is **briefs only**; long-form bodies are a separate execute step.  
- Optional machine mirror: `content-plan-2026-11-03.json`.

