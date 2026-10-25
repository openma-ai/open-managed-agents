---
title: "OpenSandbox 是什么，以及 OpenMA 为什么接上它"
description: "AAIF 旗下的自托管沙箱协议与实现，以及 Open Managed Agents 把它做成可选 sandbox provider。"
publishedAt: 2026-10-25
author: openma
tags: ["opensandbox", "sandbox", "self-host", "aaif", "harbor"]
---

Agent 真正干活的地方，往往是沙箱。模型在外面想，命令、改文件、装依赖都在盒子里发生。盒子要能自己搭，出网要能控，密钥尽量别塞进盒子里。OpenSandbox 做的就是这一层。

它现在归在 Agentic AI Foundation（AAIF）下面，由阿里贡献进去。和 MCP、OpenEnv 一样，走中立治理，不绑死一家云。

## 它到底是什么

OpenSandbox 同时给你两样东西：一套公开的 OpenAPI（生命周期、盒内执行、出网与凭证），以及可以自己部署的参考实现。本地用 Docker 起，集群上走 Kubernetes。你可以按契约对接，也可以直接把参考实现装进自己的机房。

Harbor 已经把它当成一种后端，`-e opensandbox` 就能在评测任务里用。E2B、Modal、Daytona 是并列的其他后端。应用面对的是 Harbor 或自己的平台契约，各家沙箱的方言留在后端适配层里。

有一点要说清楚：OpenSandbox 官方并不打算把 E2B 的线协议当兼容目标。它更在意自己那套 lifecycle / execd / egress 契约能不能长期稳定。迁移可以靠对照表或有限的适配层，别指望换底座之后还能原样用 E2B SDK。

## 和 OpenEnv、Harbor 怎么排

这几个名字容易搅在一起。

OpenEnv 管的是环境怎么被训和评调用：外面统一是 `reset` / `step` / `state`，里面可以是游戏，也可以是真实 coding agent。Harbor 管任务、沙箱选型、harness 和 verifier。OpenSandbox 只回答「进程在哪跑」。

常见拼法是 OpenEnv 包一层 Harbor，Harbor 再选 OpenSandbox 当执行底座。Coding agent 仍是 Claude Code、Codex、OpenCode 这类 harness，跑在沙箱里，OpenSandbox 本身不扮演 harness。

## 我们怎么接

Open Managed Agents（OpenMA）有自己的 sandbox 契约：`SandboxProviderPort`、租约、fence、harness 监督、workspace、credential egress。这条契约比「创建容器再 exec」厚得多，我们不会拿 OpenSandbox 的 API 去替换它。

做法和接 E2B、Daytona 一样：OpenSandbox 做成一个 provider adapter。运维侧设 `SANDBOX_PROVIDER=opensandbox`，指到你的 OpenSandbox 服务，会话和 Environment Work 仍走 OpenMA 原来的控制面。密钥继续留在控制面一侧，和 Harbor 风格的 inference / credential proxy 同一思路，盒子里尽量只拿短时凭证。

对自托管、要控数据出境、或者不想把沙箱绑在某一家 SaaS 上的团队，这一下把平台内核和执行底座拆开了。内核还是 OpenMA，底座可以换成自己机房里的 OpenSandbox。

## 怎么开

自托管起好 OpenSandbox 之后，在 OpenMA 里选 opensandbox provider，配上服务地址和 API key（具体环境变量以文档为准）。需要跑 Harbor 评测时，也可以直接 `harbor run -e opensandbox`，和 OpenMA 这条线并行。

## 参考

1. [AAIF：四项新项目公告（含 OpenSandbox）](https://aaif.io/news/agentic-ai-foundation-announces-four-new-projects)
2. [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox)
3. [OpenSandbox API](https://open-sandbox.ai/api/)
4. [Harbor × OpenSandbox 评测示例](https://open-sandbox.ai/examples/harbor-evaluation)
5. [Open Managed Agents](https://github.com/openma-ai/open-managed-agents)
6. [PR #353：OpenSandbox provider adapter](https://github.com/openma-ai/open-managed-agents/pull/353)
