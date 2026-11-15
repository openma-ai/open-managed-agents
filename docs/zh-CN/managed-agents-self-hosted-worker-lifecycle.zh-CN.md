# Managed Agents 自部署服务与 Worker 生命周期

> 研究记录：2026-11-14。本文整理 Anthropic 最近的自部署文档和公开 Python SDK
> 源码，用来区分整个自部署服务、Work poller、sandbox worker 和 Session。
>
> 文档中能直接确认的内容标为“官方事实”。没有公开证据的服务端内部行为不在本文中
> 推断。

## 结论先行

Anthropic 的完整自部署服务采用 **per-session sandbox**：

```text
客户端 / ant / SDK
        │
        ▼
    cma-server
    ├─ API
    ├─ Session 与事件日志
    ├─ agent loop
    ├─ 模型调用
    └─ Environment Work queue
             │
             ▼
       dispatcher
             │
             ▼
   一个 Session 一个 sandbox pod
             │
             ▼
   pod 内 worker 执行 shell/file tools
             │
             └──── tool result / session events 回到 cma-server
```

这里的隔离单位是 **Session**，不是永久绑定的单个 Work。一个 Session 的下一次消息
可以创建新的 pod，但继续使用该 Session 的持久工作卷。Kubernetes 文档描述的是
dispatcher 轮询服务端 Work，并为每个 Session 创建 sandbox pod；turn 结束后 pod
可以被删除，卷仍可保留。

## 整个自部署服务的边界

官方自部署总览把系统拆成三类组件：

| 组件 | 职责 |
|---|---|
| `cma-server` | API、Session、事件历史、agent loop、模型调用 |
| PostgreSQL | agents、sessions、events 等持久化数据 |
| workers / dispatcher / sandboxes | 领取 Work，在隔离环境中执行 shell 和文件工具 |

`cma-server` 不执行 agent 的 shell/file tools；它负责控制面和模型调用。dispatcher
是执行面基础设施，负责领取 Work 和启动 sandbox。公开文档没有把 dispatcher 描述成
Session 状态机的拥有者。

生产 Kubernetes 部署使用两个 Helm chart：

- `cma-server`：数据库迁移和 server 服务；
- `cma-sandboxes`：dispatcher 和 sandbox pods；
- PostgreSQL 在两个 chart 之外运行。

Docker Compose quickstart 同时启动 server、PostgreSQL 和 workers，但官方明确它是
开发方案，不是生产部署方案。

## 一个 Work 的执行过程

官方公开资料可以确认下面这条时序：

```text
Session 需要继续执行
  → 服务端出现待领取的 Work
  → worker / dispatcher poll
  → claim
  → acknowledge
  → 启动或进入 Session worker
  → heartbeat 维持 Work lease
  → 执行工具并回传 Session 事件
  → Session idle、收到停止信号或 lease 失效
  → 本地清理
  → 仍持有 lease 时 stop Work
```

`ant beta:worker run` 的语义是“处理一个已经领取的 Session，然后退出”；它不是
一个无限轮询器。per-session sandbox 的入口可以使用这个命令，也可以在 sandbox 内
调用 SDK 的 `EnvironmentWorker.handle_item()`。

## `loop body` 是什么

在低层 SDK 代码中：

```python
async for work in client.beta.environments.work.poller(...):
    await handle_work(work)
```

缩进部分就是调用方的 **loop body**。poller 领取并 acknowledge Work 后，把 Work
交给这段代码。`handle_work()` 可以是：

- 同进程执行 `handle_item()`；
- 启动一个 per-session sandbox 并等待它退出；
- 调用用户自己的 worker 编排逻辑。

如果 `auto_stop=True`，poller 会在 loop body 返回或抛错后调用 `work.stop()`。如果
loop body 把 Work 交给另一个进程或 sandbox，外层必须使用 `auto_stop=False`，否则外层
poller 会在下游仍执行时结束它的 lease。

## `auto_stop` 的实际使用

### 官方部署示例

官方部署示例都不把 `auto_stop=True` 作为交接方案：

```text
Webhook + handle_item()
  → poller(auto_stop=False)
  → handle_item() 自己收尾

per-session sandbox
  → host poller(auto_stop=False)
  → sandbox 内 worker 自己收尾

EnvironmentWorker.run()
  → 内部直接调用 aiter_work(auto_stop=False)
  → _handle_item() 自己收尾
```

`EnvironmentWorker.run()` 不是调用公开的 `work.poller()` 方法，而是直接调用内部
`aiter_work()`，并传入 `auto_stop=False`。它只是和公开 poller 共享底层的 poll/ack
迭代实现。

### 低层 API 的默认能力

公开的低层 `work.poller()` / `aiter_work()` 默认值仍然是 `auto_stop=True`：

```text
poller(auto_stop=True)
  → loop body 返回或抛错
  → work.stop()          # force 被省略，服务端默认 false
```

这是一种“poller 自己拥有整个 Work 生命周期”的通用低层模式；它不是官方
per-session sandbox 部署示例的主路径。

### `force=True` 出现在哪里

公开 SDK 中有两类明确的 `force=True`：

1. `EnvironmentWorker` / `handle_item()` 正常完成或取消后的最终收尾；
2. poller 在 acknowledge 永久失败、Work 无法交给消费者时的 best-effort 清理。

因此不能把 `auto_stop=True` 和 `EnvironmentWorker` 的正常收尾混为一条路径：

```text
低层 poller 的正常 auto_stop
  → stop(force 默认 false)

EnvironmentWorker 的正常 per-item 收尾
  → 本地清理完成
  → stop(force=True)
```

## `EnvironmentWorker` 与 sandbox 内 worker 的状态机

这两个角色需要分开：

| 角色 | 是否领取 Work | 执行什么 | 谁负责最终 stop |
|---|---:|---|---|
| `EnvironmentWorker.run()` | 是 | 轮询、ack，然后为每个 Work 运行 per-item flow | `EnvironmentWorker` 的 per-item flow |
| `EnvironmentWorker.handle_item()` | 否，要求 Work 已经领取 | 在当前进程执行一个已领取的 Session | `handle_item()` 的 per-item flow |
| per-session sandbox 内的 `ant beta:worker run` | 否，Work 由外层 dispatcher 领取 | 执行一个已领取的 Session，然后退出 | sandbox 内 worker |
| 外层 dispatcher / `work.poller(auto_stop=False)` | 是 | 领取 Work、启动 sandbox、等待或交接 | 下游 sandbox worker |

因此，per-session sandbox 中不能再让 sandbox 调用 `EnvironmentWorker.run()`：
`run()` 会重新轮询队列。sandbox 入口应使用 `ant beta:worker run` 或
`EnvironmentWorker.handle_item()`，因为它们消费的是外层已经 claim/ack 的那个 Work。

`EnvironmentWorker.run()` 的公开源码调用关系是：

```text
run()
  → aiter_work(auto_stop=False)
  → _handle_item(work_item)
  → heartbeat + SessionToolRunner 并行
  → cleanup
  → 当前 lease 仍有效时 stop(force=True)
```

下面是 sandbox 内 worker（也就是 `handle_item()` / `ant beta:worker run` 的 per-item
flow）的简化状态机。代码是按公开 SDK 抽出的伪代码，不是逐字复制：

```python
async def handle_one_work(work):
    lease = Lease()

    async with task_group() as tg:
        tg.start_soon(heartbeat_loop, work, lease)

        try:
            # SessionToolRunner 负责模型事件、工具调用和 max_idle 判断
            await run_session_tools(work.session_id, max_idle=60)

            # idle / runner 完成分支
            lease.finish("runner_done")

        finally:
            # bash/tool context、skills、memory store 的收尾
            await cleanup_tools_and_memory()

            # runner 正常返回时取消 heartbeat；
            # heartbeat 先结束时则取消 runner。
            tg.cancel_scope.cancel()

    if not lease.lost:
        await work.stop(force=True)
```

heartbeat 不是另一个独立的 worker，它是同一个 per-item flow 里的并发任务：

```python
async def heartbeat_loop(work, lease):
    while not lease.ended:
        response = await work.heartbeat()

        if response.state in {"stopping", "stopped"}:
            lease.finish("heartbeat_stop")
            return

        if response.lease_extended is False:
            lease.finish("heartbeat_stop")
            return

        # 412 / lease TTL 超时会进入 lease_lost / assumed_lost
        # 这些情况同样结束当前 task group，但不再 stop Work。
```

状态机可以画成两个竞争分支：

```text
                 claim + ack
                     │
          ┌──────────┴──────────┐
          │                     │
     idle / runner          heartbeat
       先结束                 先结束
          │                     │
  runner_done             stopping / stopped /
          │               lease_extended=false /
          │               lease_lost / TTL expired
          │                     │
          └──────────┬──────────┘
                     ▼
          取消另一条并发任务
                     │
                本地 cleanup
                     │
          ┌──────────┴──────────┐
          │                     │
    lease 仍由自己持有       lease 已丢失
          │                     │
   stop(force=True)          不调用 stop()
          │                     │
          └──────────┬──────────┘
                     ▼
                进程退出
```

这里的 `idle / runner` 分支不是读取 Work 的 `stopping` 状态，而是
`SessionToolRunner` 在 Session 没有新工作、超过 `max_idle` 后自行返回。相反，
`heartbeat` 分支读取的是 Work lease 的服务端状态。两条分支最后都进入本地 cleanup，
但只有仍然持有 lease 的分支才可以发送最终的 `stop(force=True)`。

## Worker 什么时候进入收尾

沙箱内 worker 的收尾有几条互相竞争的触发路径。

### 1. 正常完成

Session tool runner 结束，并在 `max_idle` 窗口内没有新的工作时，worker 进入清理：

```text
tool runner 返回
  → 关闭 bash/tool context
  → 同步并卸载 memory store（如果有）
  → lease 仍归当前 worker
  → stop(force=True)
  → 进程退出
```

CLI `ant beta:worker run` 的 `max-idle` 默认是 60 秒；`requires_action` 等待不被当成
普通 idle。sandbox pod 的删除是后续的基础设施回收，不是 worker 判断收尾的条件。

### 2. 外部 graceful stop

运维或控制面调用：

```text
work.stop(force=False)
  → Work = stopping
  → 下一次 heartbeat 返回 stopping
  → worker 取消或完成当前工具调用
  → 清理
  → Work = stopped
```

官方运维文档说明，Python worker 可能先让当前工具调用完成；`force=True` 会立即把
Work 标成 `stopped`，但不会让正在运行的工具更早被杀掉。工具是否停止仍由 worker
下一次 heartbeat 或进程取消处理。

### 3. Lease 失效或被接管

heartbeat 返回下面任一情况时，当前 worker 必须停止继续服务：

- Work 状态是 `stopping` 或 `stopped`；
- `lease_extended` 为 false；
- heartbeat 返回 412，说明 Work 已经被重新排队或其他 worker 持有；
- 连续瞬时错误持续整个 lease TTL，worker 只能假定 lease 已丢失。

如果确认 lease 已丢失，worker **不能再调用 `stop()`**，因为 Work 已经不属于它。
它只负责结束本地执行，让队列或新的 worker 继续处理。

### 4. 进程被硬杀

硬杀不会执行 worker teardown。未完成的 memory sync 可能丢失，sandbox 进程也不会主动
上报最后的清理结果。运维侧应先发送 SIGTERM/SIGINT，并为 worker 留出清理时间；只有
在确认它没有正常退出时才使用 hard kill。

## `stopping` 和 `stopped` 的关系

`stopping` 不是正常执行结束的必经状态。

```text
正常完成：
  runner 返回 → 清理 → stop(force=True) → stopped

外部优雅停止：
  stop(force=False) → stopping → heartbeat → 清理 → stopped

lease 丢失：
  heartbeat 发现 ownership 已失效 → 本地退出 → 不发送 stop
```

这也是为什么 `force=True` 的含义不能理解成“强制杀掉 sandbox 进程”：它首先是
Work API 的状态确认方式；本地工具进程是否停止，仍由 worker 的取消和 provider 的
进程管理负责。

## Work 结束后，sandbox 可以 pause 吗

可以，但这不是 Work 的状态迁移，而是 sandbox runtime 的另一条生命周期。worker
结束一个 Work 后，应该释放 Work 的 claim；是否保留 sandbox 由 sandbox 控制面决定：

```text
worker:
  claim + ack
    → 执行 Session
    → 同步事件、memory、outputs
    → stop Work（当前仍持有 claim 时 force=True）
    → worker 进程退出或等待下一次激活

sandbox 控制面:
  execution 完成
    → 等待 idleMs，期间不再续 provider lease
    → storage.sync("before_stop")
    → 写入最新 workspace checkpoint
    → provider.pause()
       ├─ kind="self": 同一个 sandbox 被唤醒，内存/进程是否保留由 provider 决定
       └─ kind="snapshot": sandbox 停止，下一次从 checkpoint 创建新 sandbox
```

因此，“worker 结束后 pause”不能实现成 worker 自己退出后再自救：如果 worker 是
sandbox 的 PID 1，进程退出可能连 sandbox 一起结束。需要让 Session 控制面或一个很小
的 supervisor 在 worker 结束后调用 provider 的 pause；或者让 worker 只结束当前 Work，
继续作为常驻进程等待下一次激活。两者都不能继续持有已经结束的 Work lease。

OMA 已经有这条控制面路径。`endExecution()` 在 turn 结束时先同步和 checkpoint，
然后 arm idle timer；timer 到期后 `idlePause()` 只在没有执行中的情况下调用
`SandboxLifecyclePort.pause()`，并把 `ResumeRef` 持久化。见
[`session-sandbox-execution-end.ts`](../../packages/session-runtime/src/session-sandbox-execution-end.ts:23)、
[`session-sandbox-idle-pause.ts`](../../packages/session-runtime/src/session-sandbox-idle-pause.ts:1)
和 [`sandbox-ports.ts`](../../packages/sandbox/src/sandbox-ports.ts:80)。这说明 pause
属于 Session/sandbox 控制面，不属于 `stop(force=...)` 的 Work API。

在 OMA 的 managed-runtime host 里，worker 也不是 sandbox 的 PID 1：host 通过
`spawnDuplexProcess()` 启动 worker 子进程，等待它退出；如果计划选择
`retained_runtime`，host 随后调用 `sandbox.suspend()`，再发布最终 workspace/output。
所以“worker 进程退出”和“sandbox runtime 被释放”可以是两个独立动作。对应代码在
[`provider-runtime.ts`](../../packages/managed-runtime-sandbox/src/provider-runtime.ts:1404)、
[`host.ts`](../../packages/managed-runtime-host/src/host.ts:723) 和
[`output-before-pause.test.ts`](../../packages/managed-runtime-host/test/output-before-pause.test.ts:1)。

### E2B

E2B 有原生的 memory pause/resume：pause 返回同一个 runtime id，connect 会把 paused
sandbox 唤醒。如果 worker 只是一个已经退出的子进程，pause 不会把它复活；它保留的是
sandbox 中仍在运行的其他进程和内存。下一次 Session 事件由控制面 connect/resume，再
启动新的 worker/Work。OMA 的 E2B adapter 已经这样实现：
`pause()` 使用 memory suspend，返回 `kind: "self"`；`resume()` 使用同一个 handle
connect；filesystem snapshot 则是 `kind: "snapshot"`，恢复时会创建新 sandbox。见
[`e2b/v2.ts`](../../packages/sandbox-adapter-e2b/src/v2.ts:8) 和
[`e2b.ts`](../../packages/sandbox-adapter-e2b/src/e2b.ts:335)。

E2B 的自动 timeout 也被配置为 pause 并保留 memory，但它只是 provider backstop；
OMA 仍以自己的 `idleMs` timer 决定何时 pause，并要求 provider lease 比 idle window
更长。这样 provider 先回收时，控制面仍能通过 `self` handle 判断 sandbox 是否存在，
必要时退回最新 filesystem snapshot。

### 其他 provider 的差异

“pause”在不同厂商并不是同一个保证，至少要分成三类：

| Provider | 空闲后的动作 | 能否保留进程内存 | OMA 应暴露的语义 |
|---|---|---:|---|
| E2B | 原生 pause/connect | 是 | `self`，memory retained |
| Daytona VM | provider 有 pause/resume；容器只有 stop/start | VM 是；容器否 | 当前 OMA adapter 用 filesystem stop/start；memory pause 属于 provider-specific |
| Sprites | 空闲冻结/挂起，下一次请求唤醒 | 不应当作可移植保证 | 当前 OMA adapter 只承诺 retained filesystem |
| Modal | `idle_timeout` 是 terminate；Exit Snapshot 只保存文件系统 | 否 | `snapshot` / durable Volume |
| Cloudflare Sandbox | backup/snapshot 后停止 | 否 | `snapshot` |
| Superserve | provider pause/resume，可保留运行态 | provider 支持，但不作为跨 provider checkpoint | 当前 OMA adapter 只承诺 retained filesystem |

E2B、Daytona、Sprites、Modal、Superserve 的 OMA 适配都已经把“provider runtime
暂停”和“Work claim”分开；适配器只向核心声明 `self` 还是 `snapshot`，核心不根据厂商
名称猜测内存是否存在。Daytona 官方也明确区分 pause/resume（保留 RAM/进程）和
stop/start（只保留文件系统）；Modal 官方的 idle timeout 则是终止 sandbox，而不是
暂停。见 [E2B SDK](https://e2b.dev/docs/sdk-reference/python-sdk/v2.5.0/sandbox_sync)、
[Daytona Pause & Resume](https://docs.rl.trydaytona.com/docs/documentation/lifecycle/pause-and-resume/)、
[Daytona Stop & Start](https://docs.rl.trydaytona.com/docs/documentation/lifecycle/stop-and-start/)、
[Modal Sandboxes](https://modal.com/docs/guide/sandboxes)、
[Modal Exit Snapshots](https://modal.com/docs/guide/sandbox-exit-snapshots) 和
[Fly.io Sprites](https://fly.io/run-agent-code/)。

当前 OMA 的边界是：Work worker 结束后不再持有 Work；Session/sandbox 控制面按
`idleMs` 决定是否 pause。要让“同一个 worker 进程”在 pause 后继续，必须明确选择常驻
worker + 外部唤醒；要让“同一个 Session sandbox”继续，worker 可以退出，控制面保存
`ResumeRef`，下次重新 attach/resume 并启动新的 worker。

## 各家 provider 的 worker 协议其实是什么

它们通常没有 CMA 那种 `claim → ack → heartbeat → stop` 的 Work 协议。provider 提供
的是 runtime API，worker 或 host 自己组合出执行协议：

| Provider | worker/host 持有的东西 | 空闲或失联后的收尾 | 是否需要 worker 通知 provider pause |
|---|---|---|---:|
| E2B | sandbox id、command handle、timeout | timeout 可配置成 pause；connect 唤醒同一 sandbox | 否，provider 可自动 pause；显式 pause 由 host 调 API |
| Daytona | sandbox id、process/session handle、activity lease | auto-pause/auto-stop 根据 activity；pause 或 stop 由 provider 状态机完成 | 否，activity/TTL 是 provider 的控制信号 |
| Sprites | Sprite 名称、Service/Task 名称、task expiry | Task 到期后 Sprite 自动 pause；warm wake 保留进程，cold wake 丢 RAM | 否，worker 只需续 Task；过期就是隐式 pause |
| Modal | Sandbox id、command handle | idle timeout 直接 terminate；需要 Volume/Exit Snapshot 恢复 | 不支持 runtime pause |
| Cloudflare Sandbox | Session/DO 句柄、snapshot/backup ref | 控制面或 provider backstop 做 backup + stop | 没有原生 pause 回调 |

其中 Sprites 最接近“worker lease”模型：worker 周期性 `PUT /v1/tasks/:name` 刷新
`expire`，退出时删除 Task；worker 崩溃时 Task 自然过期，Sprite 自己 pause。这里也
没有一条“worker 通知控制面 pause”的消息，pause 是 provider 根据 lease expiry 自己
做的。[Sprites Task/Service 文档](https://github.com/superfly/sprites-docs/blob/main/keeping-sprites-running.mdx)

Daytona 也是类似的 activity 模型：后台进程本身不一定算 activity，orchestrator 需要
调用 activity/Toolbox API；auto-pause 到期后由 Daytona 转移到 `paused`，不是 worker
向 CMA 发事件。[Daytona lifecycle](https://www.daytona.io/docs/en/sandboxes/)

因此 CMA 原生语义只能得到这条链：

```text
CMA control plane
  → 创建/排队 Work
  → worker claim + ack
  → worker heartbeat
  → worker stop Work

provider control plane（CMA 不知道内部细节）
  → 根据 timeout / activity / task expiry 自动 pause、stop 或 terminate
```

官方 CMA 文档只定义了 `auto_stop`：sandbox 自己拥有 Work 收尾时，poller 要设
`auto_stop=False`；文档没有定义 worker 完成后通知 CMA “请 pause 这个 sandbox” 的
接口。[worker reference](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-reference)

所以如果我们严格模拟 CMA，而不增加 OMA 扩展，唯一可行的是：

1. worker 只负责 `stop Work` 并退出；
2. provider 自己按 timeout/activity/task expiry pause；
3. 下一次 Work 到来时，外部 launcher 根据稳定的 Session/sandbox id 做 resume 或重建。

如果要求 **CMA 控制面明确知道并记录 pause**，那就必须增加 provider-specific
launcher/supervisor 或 OMA 的 `SandboxLifecyclePort`；这已经超出 CMA worker 协议本身。

## 公开的 CMA provider 集成：实际代码怎么做

直接看公开实现后，三家的共同结构比抽象的 provider API 更清楚：

### E2B cookbook

E2B 的 webhook router 直接使用 CMA Work poller：

```text
session.status_run_started webhook
  → router 启动 drain
  → work.poller(auto_stop=False)
  → claim + ack
  → 按 session_id 查找或创建 E2B sandbox
  → Sandbox.create/connect(lifecycle: on_timeout=pause)
  → 在 sandbox 中启动 detached worker，传入 work_id/session_id
  → worker.handle_item() 自己 heartbeat + stop Work
  → worker 因 max_idle 返回并退出
  → E2B timeout 负责 pause；下一次 webhook connect 同一个 sandbox
```

这套实现的关键不是 worker 通知 CMA pause，而是 router 保存
`session_id → sandbox_id`，E2B 自己在 timeout 时 pause。源码见 E2B cookbook 的
[`app_webhook_server.py`](https://github.com/e2b-dev/e2b-cookbook/blob/main/examples/anthropic-managed-agents/python/anthropic_managed_agents_e2b/app_webhook_server.py)、
[`sandbox_worker.py`](https://github.com/e2b-dev/e2b-cookbook/blob/main/examples/anthropic-managed-agents/python/anthropic_managed_agents_e2b/sandbox_worker.py)
和 [`worker_runtime.py`](https://github.com/e2b-dev/e2b-cookbook/blob/main/examples/anthropic-managed-agents/python/anthropic_managed_agents_e2b/worker_runtime.py)。

### Daytona guide

Daytona 的实现把控制面再明确地放在自己的 orchestrator：

```text
orchestrator poll + ack
  → get_or_create stable per-session Daytona sandbox
  → 启动 sandbox_runner.py
  → sandbox_runner 调 EnvironmentWorker.handle_item()
  → runner max_idle 返回，自己结束 Work

janitor:
  → refresh sandbox + probe runner PID
  → Session = idle      → force-stop leftover Work → Daytona.stop()
  → Session = running 且 runner 消失 → 重新 poll/reclaim 并重启 runner
  → Session = terminated → archive sandbox
```

这里确实存在“控制面通知 provider 停止 sandbox”，但通知者是 Daytona 集成自己的
`janitor`，不是 CMA server，也不是 worker 发给 CMA 的 pause 事件。源码见
[`orchestrator_lib.py`](https://github.com/daytona/guides/blob/main/python/claude/claude-managed-agents/orchestrator_lib.py)、
[`host_lib.py`](https://github.com/daytona/guides/blob/main/python/claude/claude-managed-agents/host_lib.py)
和 [`sandbox_runner.py`](https://github.com/daytona/guides/blob/main/python/claude/claude-managed-agents/sandbox_runner.py)。

`janitor` 这个名字是 Daytona 的实现名，但它代表的是更通用的
`SessionSandboxSupervisor`：对账 CMA 的期望状态和 provider 的实际状态，再执行幂等修复。
它不属于 CMA Work worker，也不等于 provider 自带的 timeout/lease。

```text
期望状态：Session / Work
实际状态：sandbox / worker / provider lease

Session running + sandbox 没有 worker
  → 启动或重新启动 worker

Session idle + sandbox 仍在运行
  → pause/stop sandbox

Session terminated
  → archive/delete sandbox

sandbox 被外部杀掉但 Work 仍挂着
  → force-stop 旧 Work
  → 让后续 poller 重新领取
```

不同 provider 可以用不同触发方式承载同一个角色：Daytona 使用周期性 janitor，E2B
使用 webhook 加 sandbox timeout，Sprites 使用 Task lease expiry 加 webhook。OMA 可以
统一保留这个边界：`SessionSandboxSupervisor` 负责 provider 的
`ensure_running/pause/stop/resume` 和异常对账，sandbox worker 只负责
`handle_item`、heartbeat 和 Work 收尾。

### Sprites reference

Sprites 的实现最接近 provider 自己拥有一层 worker lease：

```text
dispatcher webhook
  → work.poller(auto_stop=False)
  → create/reuse one Sprite per Session
  → exec worker with work_id/session_id

Sprite worker:
  → acquire Sprite-wide lock
  → Task cma-worker expire=5m
  → every 60s refresh Task
  → EnvironmentWorker.handle_item()
  → worker finally stops Work and exits
  → Task deleted; if process crashes, Task expires
  → Sprite provider automatically pauses
```

Sprites 因此没有“worker → CMA pause”回调。Task expiry 就是 provider 的失联收尾；
下一次 `session.status_run_started` webhook 重新唤醒 dispatcher，dispatcher 再把同一
个 Sprite 交给新的 worker。源码见
[`dispatch/main.py`](https://github.com/fly-apps/sprites-claude-managed-agents/blob/main/dispatch/src/sprites_claude_managed_agents_dispatch/main.py)、
[`worker/main.py`](https://github.com/fly-apps/sprites-claude-managed-agents/blob/main/worker/src/sprites_claude_managed_agents_worker/main.py)
和 [`worker/tasks.py`](https://github.com/fly-apps/sprites-claude-managed-agents/blob/main/worker/src/sprites_claude_managed_agents_worker/tasks.py)。

三家实现的共同协议可以写成（E2B/Sprites 调用 `poller(auto_stop=False)`；Daytona 绕过高层 `poller`，显式执行 `poll + ack`）：

```text
CMA Work:
  poll → claim → ack → worker heartbeat → worker.handle_item() → stop Work

Provider integration:
  session_id → stable sandbox identity
  + provider timeout / janitor / Task lease
  → pause or stop runtime
  → next webhook/work reconnects or restarts worker
```

所以真正的结论是：CMA 没有缺一个“pause callback”；它把 sandbox runtime 的
暂停/停止责任留给 self-hosted 集成方。E2B 用 provider timeout，Daytona 用 janitor，
Sprites 用 Task expiry。我们若要贴近这些真实实现，应该实现的是同一个外部
`SessionSandboxSupervisor`，而不是往 CMA Work 协议里硬塞 `worker_finished → pause`。

## ACK reclaim 和 heartbeat lease loss 不是一回事

低层 poller 的 `reclaim_older_than_ms` 文档描述的是：重新浮出**已经领取但没有及时
acknowledge 的 Work**。它不是 heartbeat TTL 的同义词。

需要区分：

```text
claim 后一直没有 ACK
  → poller 的 reclaim_older_than_ms 处理

ACK 后 heartbeat 失败 / lease 过期 / 412
  → 当前 worker 放弃执行
  → Work 归队或由其他 worker 接管
```

公开 SDK 明确实现了第二条的 worker 行为，但完整 self-hosted server 的内部回收器和
状态存储没有作为公开源码仓库发布。因此本文不把服务端内部的 reclaim 实现描述成
已经完全可见的 CMA 代码。

## 公开代码和未公开部分

### 公开

- Python SDK 的 `work.stop()` 客户端方法；
- `_poller.py` 的 poll、ack、`auto_stop` 和失败清理；
- `_worker.py` 的 heartbeat、lease 判断、tool runner、memory 清理和最终 stop；
- 官方自部署 worker 文档和 Kubernetes 部署文档。

### 没有公开到同等程度

- 完整 self-hosted `cma-server` 的服务端 Work 状态迁移实现；
- dispatcher 内部的所有回收和重试细节；
- 一个 Session 事件是否直接调用 `work.stop(force=False)`。

官方文档只明确说 Session/服务端产生 Work，dispatcher 轮询并领取，sandbox worker
执行并回传结果；没有证据表明“Session 事件自动直接调用 graceful Work stop”。

## 对 OMA 的收敛建议

如果采用 per-session sandbox，边界可以收敛为一条路径：

```text
控制面 / dispatcher
  → poll + claim + ack
  → E2B/Sprites: poller(auto_stop=False)；Daytona: 显式 poll + ack
  → 启动一个 Session sandbox

sandbox 内 worker
  → heartbeat + lease fence
  → 执行工具
  → normal / stop / lease-loss 分支清理
  → 当前仍持有 lease 时 stop(force=True)
  → lease 丢失时退出且不 stop
```

这样 `auto_stop` 只存在于外层交接边界；sandbox 内 worker 是唯一拥有该 Work 最终
收尾责任的执行者。`stopping` 由显式 graceful stop 触发，不能作为正常完成的默认
中间态。

## 官方依据

- [Self-hosted Claude Managed Agents 总览](https://platform.claude.com/docs/en/managed-agents/self-hosted)
- [Self-hosted Quickstart](https://platform.claude.com/docs/en/managed-agents/self-hosted/quickstart)
- [Kubernetes 部署](https://platform.claude.com/docs/en/managed-agents/self-hosted/kubernetes)
- [Deploy self-hosted workers](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-workers)
- [Self-hosted worker reference](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-reference)
- [Monitor and troubleshoot workers](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-operations)
- [Python SDK `_poller.py`](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/lib/environments/_poller.py)
- [Python SDK `_worker.py`](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/lib/environments/_worker.py)
- [Python SDK `work.py`](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/resources/beta/environments/work.py)
