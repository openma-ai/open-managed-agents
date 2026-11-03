# CMA 竞品关键词叠加（中文摘要）

**时间：** 2026-11-03（America/Detroit）  
**站点：** openma.ai · GSC `sc-domain:openma.ai` · 近 28 天（2026-10-07 → 2026-11-03）  
**支柱词：** `claude managed agents alternative`

## 结论

1. **Keyword Planner 仍拿不到绝对搜索量。** 盒子 curl 能打开 ads.google.com，但会跳到 Google 登录墙；无 Ads API / `~/.config/claude-seo` 凭证；Trends 429。**volume 一律标 `unknown`，未编造。**
2. **已用 SearchConsole.ai 拉了新鲜 GSC**（与既有 cluster-plan 基本一致）。非品牌需求仍以 **Claude Tag** 变体最强（如 `opensource claude tag alternative` 33 展现），CMA 种子词 13 展现 / 位次 ~18.5 / 0 点击，落在对比博文上。
3. **杠杆仍是：** 先优化 `/blog/claude-managed-agents-vs-open-managed-agents/`（页级 102 展现 / 0 点击），再写支柱页与 #462 explainer；Tag 簇继续走 #467 优化现有页。
4. **未发 GitHub issue/评论。** 缺的 pillar / pricing / OSS managed agents / self-host how-to / sandbox / 对比文优化等草稿在英文报告 JSON 里，待你确认再开 issue。

## 关键 GSC（非品牌 / 簇相关）

| 查询 | 展现 | 点击 | 位次 |
|------|------|------|------|
| opensource claude tag alternative | 33 | 0 | 7.5 |
| open source claude tag | 30 | 1 | 10.3 |
| claude tag open source | 23 | 0 | 6.6 |
| open source alternative to claude tag | 18 | 0 | 6.6 |
| claude managed agents | 18 | 0 | 67.4 |
| claude tag alternative | 17 | 0 | 10.7 |
| claude tag vs self-hosted agent platforms | 17 | 0 | 6.6 |
| claude managed agents alternative | 13 | 0 | 18.5 |
| open claude tag | 13 | 0 | 7.3 |
| what is claude managed agents | 7 | 0 | 67.9 |
| open source managed agents | 5 | 0 | 9.8 |

## 解阻 Keyword Planner（任选）

- 提供 Google Ads API 凭证；或  
- 在盒子浏览器登录 Ads 并授权 Keyword Planner；或  
- 人工导出 CSV 放到 `/workspace/oma-seo-cluster/`。

## 产出文件

- `/workspace/oma-seo-cluster/competitor-keywords-cma-alt.md`
- `/workspace/oma-seo-cluster/competitor-keywords-cma-alt.json`
- `/workspace/oma-seo-cluster/competitor-keywords-cma-alt.zh.md`（本文件）
