# 贡献指南

**English.** Canonical contribution guide for the openma-ai org. It lives in `open-managed-agents` first; copy it to other org repos or an org `.github` repo and replace only **本仓库**. Shared rules: conventional-commit titles, squash merge, small PRs, green CI with a root cause for failures, a compatibility check on dependency bumps plus a follow-up bump downstream after release, private security reports, and an evidence report on every PR before merge.

以下各节是组织约定。「本仓库」只适用于 `open-managed-agents`。复制到别的仓库时换掉「本仓库」一节，并改掉文中指向本仓库文件的链接。

## 分支 / Branches

从 `main` 拉出。人工分支用小写：

```text
<type>/<kebab-summary>
```

`type` 与 PR 标题类型一致。近期合并：`fix/ci-minio-image`（#227）、`feat/sql-realtime-fanout`（#222）、`refactor/split-node-assembly`（#234）、`docs/discord-community`（#197）。关联 issue 时把编号放进名字，例如 `fix/196-session-update-idle`。

工具前缀保持原样：`dependabot/…`、`codex/…`、`cursor/…`。deepseek-harness-acp 的 dsh 升级分支是 `codex/bump-dsh-<version>`。

一个分支一件事。跟上 `main` 用 rebase。

## PR 标题与 squash / PR titles

标题用 [Conventional Commits](https://www.conventionalcommits.org/)。squash 之后它就是 `main` 上的提交说明，GitHub 再追加 `(#编号)`：

```text
<type>(<scope>): <祈使句，说明做了什么>
```

`scope` 可省略。常用 type：`feat` `fix` `refactor` `perf` `docs` `test` `ci` `chore`。依赖用 `chore(deps):`。一篇 PR 一个 type。近期合进去的标题也不都是这个格式：#224 是 `fix+feat(...)`；#237 是 `Workspace persistence semantics: durable_mount vs fenced checkpoint_restore, shared Session outputs`；#239 是 `CMA retry_status semantics + live-found fixes (...)`。新 PR 用单一 conventional type。

发版提交的主题是 `release: vX.Y.Z`（见「发布」），普通 PR 不用这个前缀。

合并方式是 **squash**。本仓库近期 `main` 上每篇 PR 是一个单父提交，主题即 PR 标题。#202 写明仓库不接受 merge commit，因此把多篇依赖 PR 合成一篇再 squash。deepseek-harness-acp 历史上有过 merge commit（#30）；新 PR 按 squash 合。

## 小 PR / Small PRs

一次改一个问题或一个职责。`main-node` 控制面拆分是一串短 PR（#225、#228–#234），每篇只动一层。文档、重命名、行为变更分开。

lockfile 冲突时可以把多篇依赖更新合成一篇，跑一次完整 CI（#202 包含 #201–#206）。描述里列出被包含的 PR。

## 证据报告 / Evidence report

**合并前，PR 描述或一条评论里必须有证据报告，并且对应当前 head SHA。** 缺段，或证据还停在旧 SHA 上，就不合并。仓库没有把这件事做成 status check：作者填写，维护者核对。模板是 `.github/pull_request_template.md`。

六段都要出现。没有内容就写「不适用」并给一句原因。

### 问题 / 动机

缺陷要有**在真实产品上**的复现：命令、版本、原样输出。只写推理不够。新能力写清谁在什么场景下需要它。

### 根因

写到代码或外部依赖的哪一层。上游变更（镜像仓库、npm 发布）和本仓库的缺陷分开写。

### 改动说明

做了什么、刻意没做什么。点名关键文件，不贴大段 diff。

### 验证证据

- 当前 head SHA。
- 该 SHA 上的 CI run 链接，写明 workflow 和 job。旧 push 的绿 run 不算。
- 跑过的测试名称和通过数（例如 `8 files / 42 tests`）。本地和 CI 都写。
- 改了 UI 或可见行为时，把截图或录屏嵌进 PR。可以直接拖进 GitHub。需要稳定链接时，推到孤立分支 `pr-assets`：

  ```bash
  git checkout --orphan pr-assets
  git rm -rf .
  mkdir -p pr-<编号>
  # 只放 png / webm。不要放密钥，也不要放未剪辑的大体积录屏。
  git add pr-<编号>
  git commit -m "pr-assets: <编号>"
  git push -u origin pr-assets
  ```

  链接形式：`https://raw.githubusercontent.com/openma-ai/<repo>/pr-assets/pr-<编号>/<file>`。`pr-assets` 只存证据，不在上面开发。

### 未验证的部分

写明没跑的检查和原因。作者自己的 mock、fixture、测试替身，与真实产品或上游行为分开。mock 通过不等于 KVM 沙箱、托管环境或下游仓库已经验证。

### 风险与回滚

最坏情况，以及怎么退回：revert 这篇 squash 提交，或发一个修复版本。发版和迁移要写用户会看到什么。

### 示例

#227 的缩写，只示范格式。新 PR 按自己的改动重写。

> **问题 / 动机。** `pnpm test:integration:storage` 在 CI run [36001613340](https://github.com/openma-ai/open-managed-agents/actions/runs/36001613340) 的 global setup 失败，测试还没开始。日志是 MinIO 匿名拉取 `401 unauthorized`。干净机器上 `docker pull quay.io/minio/minio@sha256:d249d1fb…` 同样 401。
>
> **根因。** 仓库代码没有变化。`quay.io/minio/minio` 停止匿名拉取。
>
> **改动说明。** 测试镜像改为可匿名拉取的 `cgr.dev/chainguard/minio`，并钉住 manifest digest。
>
> **验证证据。** 本地 `pnpm test:integration:storage`：8 files / 42 tests 通过。合并前该 PR head 上的 CI storage 步骤通过。
>
> **未验证的部分。** 这是 CI 用的 MinIO 镜像，不是产品运行时依赖。没有改 S3 条件写相关的产品代码，也就没有另做产品级 S3 手工验证。
>
> **风险与回滚。** 只影响存储集成测试。revert 该提交即回到旧镜像引用。

## CI / 必须是绿的

合并前，当前 head SHA 上该 PR 该跑的 CI 全部成功。失败先读日志，写出根因，再改代码或改测试。不要对同一 SHA 反复 Re-run，直到碰巧变绿再合。

Re-run 可以用来收集第二次日志。第一次红、第二次绿时，报告里写明两次差异（超时、外部注册表、被 concurrency 取消的 run）。说不清原因就继续查。#227 的处理是确认 MinIO 注册表 401，然后更换镜像。

`concurrency.cancel-in-progress: true` 会取消同一 ref 上还在跑的旧 workflow。被取消的 run 不是 flake；看新 SHA 上的 run。

## 依赖升级 / Dependency upgrades

Dependabot 和手工 lockfile 更新都要做兼容性检查。CI 变绿只是其中一步：

- 读上游 changelog / release notes，列出行为变化。
- 跑本仓库已有的兼容矩阵，而不是只跑默认单测。deepseek-harness-acp 的 job `dsh-compatibility` 按 `runtime/compatibility.json` 安装多个 `@deepseek-ai/dsh` 并做 profile smoke。定时 workflow `dsh-update.yml` 会打开 `chore: upgrade bundled dsh to <version>`。#33 给这个 workflow 加了 Cursor agent 复查；人仍然负责合并。
- 升级 PR 不顺便给本包打版本。dsh 自动 PR 的正文写明：This PR does not bump or release the ACP package。
- 适配修不好就不合并。

发布之后，下游另开 bump PR，把依赖改到刚发布的版本，并跑下游自己的 CI：

- Martty 的 `npm/package.json` 依赖 `@openma/deepseek-harness-acp`。CHANGELOG 记录过随 0.4.29、0.4.31 的升级；#135 跟上了 0.4.35 的打包修复。
- openma-common 打 tag 并发布到 npm 之后，消费仓库把 `@openma/common` 改到新版本并提交 lockfile（该仓库 `CONTRIBUTING.md` 的 release checklist）。

## 沙箱 provider 适配器 / Sandbox provider adapters

### 反例：#353 OpenSandbox adapter / Anti-pattern

[#353](https://github.com/openma-ai/open-managed-agents/pull/353) 是我们自己的反例。

**做了什么。** 手写了一套 lifecycle / execd HTTP 客户端，把厂商协议重新实现了一遍。测试只对着我们自己写的 HTTP 替身跑，替身是照我们对文档的理解写的。合并后还发了博客，说 OpenMA 已经支持 OpenSandbox。

**真实服务上坏在哪。** 外部贡献者 @jwx0925 在真实服务器上跑出了下面的问题：

- 命令流是空行分隔的 JSON 记录，不带 `data:` 前缀。我们按 SSE 解析，`execution_complete` 被丢掉。
- 上传时 `metadata` 被当成普通文本字段发出去，服务端要求它是 multipart 的文件 part，于是返回 HTTP 400 `INVALID_FILE_METADATA`。重启后恢复 session 输出也要走上传，所以这一条也坏了。

[#363](https://github.com/openma-ai/open-managed-agents/pull/363) 在手写客户端上打了补丁（已关闭）。[#364](https://github.com/openma-ai/open-managed-agents/pull/364) 换成了官方 SDK。

**规则。**

- 厂商有官方 SDK 就用 SDK。按本仓库的 provider 依赖边界（`scripts/provider-package-boundaries.test.mjs`）声明成可选 peer dependency，并且懒加载。
- 测试替身只能来自真实服务上抓到的流量，或者直接用 SDK 本身。不能照我们自己对文档的理解来写。
- 合并前，必须对真实服务跑过一次 live 认证测试。测试默认不跑、需要显式开启，写法参照 #364 的 `test:certification`。PR 的验证证据里写明跑的是哪个服务、哪个版本。
- live 验证之前，博客、docs、README 里都不能说支持。

## 发布 / Release

以该仓库的 workflow 为准。组织里实际有两种。

**打 tag。** deepseek-harness-acp、Martty、openma-common：

1. 版本写进清单。Martty 还要求 tag、`npm/package.json`、`Cargo.toml` 一致（`scripts/check-release-tag.mjs`）。
2. dsh 与 Martty 在 `main` 上的发版提交主题为 `release: vX.Y.Z`（dsh `v0.4.36`、Martty `v0.3.0`）。openma-common 是发版 PR 合并后再打同名 tag。
3. `git tag vX.Y.Z && git push origin vX.Y.Z`。tag 指向 `main` 上的那次提交。
4. tag 触发发布：dsh `release.yml` 先确认 tag 在 `main` 上，再跑测试、dsh 兼容矩阵和 standalone smoke，然后用 npm OIDC 发布。Martty `package-npm.yml` 监听 `v*.*.*`。
5. openma-common 的 `v*` tag 由 `release-tag.yml` 校验后用 npm OIDC 发布 `@openma/common`；发布后再更新消费方。

**Changesets。** 用来发布 `@openma/cli` / `@openma/sdk`。步骤在「本仓库」。本仓库的 `version-pr` 会跑 MySQL 集成，但没有 `Enable KVM for Litebox`；没有 `/dev/kvm` 时 Litebox 用例会失败。

发版提交只含版本和 changelog。功能先进普通 PR。发版后按上一节给下游开 bump PR。

## 安全 / Security

私下报告，不要开公开 issue。本仓库走 [`SECURITY.md`](SECURITY.md) 和 [Private vulnerability reporting](https://github.com/openma-ai/open-managed-agents/security/advisories/new)。复制到别的仓库时改成那个仓库的私下渠道。

发行物里不带调试端口，也不带密钥：

- 发布的 Node 进程、镜像 `CMD`、安装包里不开 `--inspect`、`9229`，也不开 Chrome `--remote-debugging-port`。
- 镜像只暴露产品端口，不额外 `EXPOSE` 调试端口。
- `.env`、`.dev.vars`、token、keystore 不进 git、npm 包、GHCR 镜像或桌面安装包。

依赖安全公告单独修（Backchat 有 `chore: prepare Backchat v0.0.9 security release`）。修法仍走普通 PR 和证据报告；公告细节走私下渠道。

## 本仓库：open-managed-agents

`docs/github-pr-flow.md` 描述的是产品里 agent 如何挂上 GitHub 仓库并开 PR，不是本文。`apps/main-node/Dockerfile` 的 `EXPOSE` 是 `8787`。

Node 用 `.node-version`（当前 24.18.0，`engines.node` 为 `24.x`）。pnpm 用根 `package.json` 的 `packageManager`（当前 `pnpm@11.0.8`）。用 Corepack，安装与 CI 一样带 `--frozen-lockfile`。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

| 命令 | 作用 |
|---|---|
| `pnpm dev` | Wrangler：API + agent worker，`http://localhost:8787` |
| `pnpm dev:console` | Console（Vite），`http://localhost:5173` |
| `pnpm dev:docs` | 文档站，`http://localhost:4321` |
| `docker compose up -d` | Node 自部署。先按 README 准备 `.env` |

提交前跑 `pnpm typecheck`，以及改过的包的测试。动到公共路径就跑 `pnpm test`。`pnpm test` 不包含 CI 里随后的 Console agent editor E2E、protocol coverage、storage、MySQL。E2E 需要 Playwright；storage 和 MySQL 需要 Docker。MySQL 之前还有一步把 `/dev/kvm` 交给 runner 用户，见下。

Workflow `CI`（`.github/workflows/ci.yml`，PR 与 `main`，job `verify`，`runs-on: ubuntu-latest`，超时 30 分钟）的顺序：

1. `pnpm typecheck`
2. `pnpm test`
3. 安装 Playwright Chromium，然后 `pnpm test:e2e:agent-editor`
4. `pnpm test:coverage:protocol`
5. `pnpm test:integration:storage` — Testcontainers + MinIO（Chainguard 镜像，#227）
6. `Enable KVM for Litebox`
7. `pnpm test:integration:mysql` — Testcontainers `mysql:8.4`（`apps/main-node/vitest.mysql.config.ts`）。套件是 `test/persistence.mysql.integration.ts` 和 `test/main-node.mysql.integration.ts`。2026-10-02，#237 合并后的 [CI run 36998373962](https://github.com/openma-ai/open-managed-agents/actions/runs/36998373962)（head `0d5c5f00`）测得 **2 files / 16 tests**（6 + 10）。#239 没有改 `ci.yml` 或这两个文件。这不是一条会自动更新的「最新 run」指针。

**KVM。** 步骤注释写明：ubuntu-24.04 runner 上有 `/dev/kvm`，属主 `root:kvm`，模式 `0660`，runner 用户不在 `kvm` 组。`Enable KVM for Litebox` 在 MySQL 之前执行。设备不存在就报错并让 job 失败，MySQL 不会跑。它写入 udev 规则，再 `chmod 666 /dev/kvm`。`chmod` 失败，或当前用户最终不是既可读又可写，同样失败。

`pnpm test:integration:mysql` 里，`apps/main-node/test/persistence.mysql.integration.ts` 的 “runs official /v1/sessions on two real Node owners…”（#237）会启动两个真实 Node owner，`SANDBOX_PROVIDER=litebox`。在 Linux 上它要求 `/dev/kvm` 可读可写。真实的是 Litebox 沙箱。模型不是上游 LLM：测试用 `scripts/bootstrap-model-card.mjs` 给工作区建一张 model card（key 是 `fixture`，`base_url` 指向测试进程在 `127.0.0.1` 上起的 SSE 服务器），按脚本回放 `tool_use` 和文本；两个 owner 从共享 MySQL 读同一张卡，进程环境里没有模型 key。这不是 Haven，不是托管环境，也不是 boxrun（另一台机器上的 `boxlite serve`）。同一文件里其余用例是 MySQL + MinIO 上的独立 actor 进程，不起 microVM。`main-node.mysql.integration.ts` 把被测服务的 `OPENMA_TEST_SANDBOX_PROVIDER` 设为 `local-subprocess`，也不是 Litebox。

`packages/sandbox-adapter-litebox` 的单测仍然 `vi.mock("@boxlite-ai/boxlite")`，不打开 `/dev/kvm`。`pnpm test` 里这份通过，不能当成 microVM 已经跑过。`Release` 的 `version-pr` 见下面的表。

| Workflow | 何时跑 | Job |
|---|---|---|
| `Build OpenMA Server Image` | server 相关路径上的 PR；`main` 上同一组路径的 push；tag `openma-server-v*`；`workflow_dispatch` | `verify`（main-node / main-fly 的 typecheck 与 test，console build），`build`（GHCR；PR 只构建不推送。tag 增加版本别名） |
| `Build Sandbox Base Image` | `main` 上改了 `apps/agent/Dockerfile`，或手动触发 | `build`，推到 Docker Hub |
| `Release` | 仅 `main` 的 push，以及 `workflow_dispatch` | `version-pr`、`publish`。`version-pr` 跑 MySQL 集成，但没有 KVM 步骤，见下 |

`release.yml` 的 `version-pr` 在 `ubuntu-latest` 上跑 `pnpm typecheck`、`pnpm test`、storage 和 `pnpm test:integration:mysql`，没有 `Enable KVM for Litebox`。没有可读可写的 `/dev/kvm` 时，两 owner 的 Litebox 用例会失败。自 #237 起这条 workflow 没有完整跑完：[#237 的 run 36998373909](https://github.com/openma-ai/open-managed-agents/actions/runs/36998373909) 在任何 job 开始前被取消；[#239 的 run 37004877345](https://github.com/openma-ai/open-managed-agents/actions/runs/37004877345) 在 2026-10-02 核对时仍是 pending，jobs 为空。

`@openma/cli` 与 `@openma/sdk` 用 changesets，细节在 [`docs/release-process.md`](docs/release-process.md)：

1. 这两个包有用户可见变更时，在功能 PR 里运行 `pnpm changeset`，把 `.changeset/*.md` 一并提交。内部包 `@open-managed-agents/*` 不发 npm，不要给它们加 changeset。会进 npm 包的路径是 `src/`、`README.md` 和运行时依赖。只改测试或 devDependency 不用 changeset。拿不准时用 `pnpm changeset --empty`。
2. CI 的 `release-check` 与 `verify` 并行，不装依赖。漏了 changeset 会失败。changeset 或版本号是 minor / major 时，PR 要有 `release:minor` / `release:major`，否则失败；patch 不需要 label。Version Packages PR 的 CHANGELOG 还要盖住该包上一个 `@openma/<name>@*` tag 以来、改了上述路径的每个已合并 PR。
3. 合并后 `release.yml` 的 `version-pr` 打开或更新标题为 `chore: version packages` 的 PR。
4. 核对版本和 changelog 后再合并。`publish` 在 `pnpm release` 之前跑 `node scripts/release-check.mjs --publish`，不改变 bump 和发布方式。它挂在 GitHub Environment `production` 上，批准后用 npm OIDC 发布。稳定版 tag 形如 `@openma/cli@0.6.0`。beta：`pnpm changeset pre enter beta`，版本带 `-beta.N`，npm dist-tag 为 `beta`。
5. 也有过人工发版 PR：`chore: release stable CLI 0.6.0 and SDK 1.0.0`（#209），在 beta.2 之后执行 `changeset pre exit`。

用户文档在 `apps/docs`。站点上的 Contributing 页仍是旧的 What / Why / Test plan 提纲；GitHub 上以本文件和 PR 模板为准。

问题和讨论可以到 [Discord](https://discord.gg/P3EfQFm5bD)（中英文都可以）。可复现的缺陷用 GitHub Issue。
