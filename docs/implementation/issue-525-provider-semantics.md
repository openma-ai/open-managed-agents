# Sandbox 恢复语义核对（#525）

## 已确定的边界

attempt 只获得执行访问和可用性；不获得 create / destroy / renewLease / suspend / resume 权限。Session 持有持久的资源引用。sandbox worker 的管理 lease、provider 的 TTL/暂停策略、attempt 的执行 lease 是三种不同机制，不能互相推导。

同一个 handle 只表示同一个可寻址资源，不保证同一台机器、同一个进程、相同内存或仍然有效的连接。网络断开也不证明命令没有执行。恢复文件、恢复进程和重新执行业务必须分开。

本次检查依据仓库实现、已安装/锁定的 SDK，以及下列官方文档。表中没有宣称完成真实云服务认证；尤其没有通过模拟 SDK 来证明 provider 的内存、网络、删除幂等或旧客户端撤权承诺。

## 实际 Node 路径

`apps/main-node/src/sandbox-provider.ts` 真正选择的是下列六个 provider（`litebox` / `boxlite` 是别名），以及用于自托管测试的 local-subprocess。其他 managed-runtime 包不能误写成当前 Node factory 已接入。

| 实现及版本依据 | 当前 OpenMA 行为 | 必须保留的语义差异 |
|---|---|---|
| local-subprocess；本仓源码 | handle 绑定主机、工作目录及文件系统身份；重新打开目录，绝不因找不到旧目录而新建替代品 | 文件仍在不代表子进程仍在。无跨主机恢复，也没有远端 lease。销毁只针对该 allocation |
| Sprites；锁定 `@fly/sprites 0.2.2` | handle 是隔离 allocation 的 Sprite 名；resume 查找已有 Sprite。保活调用 task API；sleep/唤醒属于 provider | 睡眠保留磁盘，不能据此保证 RAM、命令或 TCP 连接。OpenMA 只承诺 filesystem retention；不是 portable checkpoint。删除后不以同名 create 冒充重连。[官方生命周期](https://docs.sprites.dev/working-with-sprites/)、[官方 checkpoint 说明](https://github.com/superfly/pi-sprites/blob/main/docs/checkpoints.md) |
| E2B；声明 optional peer `^2.46.1`，本锁文件未固定安装版本 | create 独立实例；`Sandbox.connect(id)` 重连/自动唤醒原 ID；`setTimeout` 更新 provider 期限；kill 删除 | full pause 与 filesystem-only pause 不同；connect 可能包含 resume 和期限更新，不是纯 GET。kill 后不能恢复。最新文档中的模式必须对实际安装 SDK/控制面再确认；不能从包声明推断部署版本。[官方 persistence](https://docs.e2b.dev/sandbox/persistence)、[官方 SDK](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/sandboxApi.ts) |
| OpenSandbox；锁定 SDK `1.1.1` | 先查状态；paused 用 resume，其他可恢复状态 connect；恢复后刷新客户端配置；renew 与 pause 分离；portable filesystem snapshot 使用新 allocation | Docker 冻结、Kubernetes rootfs 重建、Fast Sandbox 的 checkpoint/路由迁移不能混用。Kubernetes 普通 rootfs 模式不保留进程；Fast/QEMU 的内存能力需要后端配置。ID 可不变而 endpoint/进程改变。暂停期间的绝对过期不能当成取消。[官方 pause/resume](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/pause-resume.md)、[Fast Sandbox](https://open-sandbox.ai/architecture/fast-sandbox/storage) |
| Daytona；声明 optional peer `^0.171.0`，本锁文件未固定安装版本 | exact ID get；stopped/archived 分支 start 原资源；其他不认识的状态拒绝。delete 后读回确认 404 | 这条适配路径是 stop/start，不是热恢复。当前官方 container stop 保文件、丢内存；VM pause 另有语义，GPU stop 还可能删除。不能把这些新产品能力赋给旧 SDK 路径。[官方 persistence](https://www.daytona.io/docs/en/persistence/) |
| LiteBox；锁定 `@boxlite-ai/boxlite 0.9.0` | 使用 native runtime 的 exact ID get；持久 runtimeHome/host 元数据；`autoRemove:false`、`detach:true`；删除后 get 确认缺失 | 同主机、同 runtimeHome 才能按值重开。get 不等于 VM restart；宿主重启、VM 退出后的进程连续性需要真实 probe。默认 SimpleBox 的自动清理语义不能套用到这里。[官方仓库](https://github.com/boxlite-ai/boxlite) |
| BoxRun；直接 REST，无 SDK 锁定；服务端版本由部署决定 | exact box ID GET；只接受可用状态；exec 要有有效 terminal exit；force DELETE 只有已确认成功/不存在才完成回收 | GET 不创建替代实例。SSE EOF 不等于命令完成；202 不等于已删除。BoxLite REST 各版本的自动启动、暂停与 TTL 必须对部署版本测试，不能由产品名称推断。[官方 REST 合同入口](https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/README.md) |

## 其他已有 managed-runtime 适配

这些包也被本次 allocation isolation 修复覆盖，但不是上述 Node factory 的新增选项。

| 实现 | 适配语义与限制 |
|---|---|
| Modal；声明 optional peer `^0.10.0`，未锁定安装 | 当前 `suspend` 是同步 `/workspace` 后 detach，并保留 Volume；本地 `#detached` 不能证明 provider 进程已经停止。resume 重新检查原资源；不把 Volume 或 native snapshot 宣称为 portable OpenMA checkpoint。官方 memory snapshot 会创建新的 sandbox，且有连接和后台进程限制；当前适配未提供该能力。[官方 lifecycle](https://modal.com/docs/guide/sandboxes)、[snapshots](https://modal.com/docs/guide/sandbox-snapshots) |
| Blaxel；声明 optional peer `^0.3.19`，未锁定安装 | 当前显式 suspend 调用 archive/unarchive，保守承诺 filesystem；不能与自动 standby 混同。standby 文档描述内存保持但不保持外部连接，archive 则保留文件系统增量、重启进程。renewLease 方法只是可用性检查，不表示拥有可延展的独占 provider lease。[官方 overview](https://docs.blaxel.ai/Sandboxes/Overview)、[archive](https://docs.blaxel.ai/Sandboxes/Archive) |
| Superserve；声明 optional peer `^0.8.2`，未锁定安装 | 当前 pause/resume 使用 retained ID，OpenMA 只提升 filesystem 保证。官方 full pause 保内存/进程，但默认 pause 返回“已接受”，应区分 ready 状态；active-time timeout 与 idle timeout 是两种策略。文档要求 idle timeout SDK 0.11.6+，当前声明不能证明具备它。这里 renewLease 同样不是 TTL 延长。[官方 lifecycle](https://docs.superserve.ai/sandbox/lifecycle) |
| Vercel；锁定 SDK `3.2.2` | persistent name 是稳定逻辑资源；stop/自动 snapshot 后可用新运行 session 恢复磁盘。不能将 persistent name 当作永不变化的进程 incarnation。OpenMA 不把此路径提升为 portable checkpoint。[官方 persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)、[snapshots](https://vercel.com/docs/sandbox/concepts/snapshots) |
| Cloudflare；本仓锁定 Sandbox SDK 路径 | managed adapter 明确拒绝 runtime-scoped resume；通过 filesystem backup/restore 到独立 allocation 恢复。DO ID 持久不等于 container 内存、临时磁盘或进程持久。本次不改 CF 调度架构。[官方 SDK 0.x 生命周期](https://developers.cloudflare.com/sandbox/sdk/concepts/sandboxes/) |

## 统一 Port 哪里容易误导

- `resume(handle)` 的实际含义包含“连接”“自动唤醒”“冷启动原盘”。它只能供资源层使用；不能成为 attempt 自动重发命令的理由。
- `suspend: ['filesystem']` 表示适配层最低保留保证，不证明物理进程已停。Modal detach 是明显例子；Superserve 异步 pause 也不能拿 accepted 当 drained。
- `runtimeId` 有时是 physical ID，有时是 persistent name。额外保留 allocation incarnation 和 provider namespace，永不依靠逻辑 Session 名删除资源。
- `lease:true` 也不等于独占执行权。provider TTL、保活 task、资源管理 CAS 都不能替代 canonical attempt fence。
- `stopped` / `unknown` 不应是同义词。网络、鉴权、代理错误不能推出实例死亡；404 也需确认来自权威 provider 的精确资源查询。

## 最小公共不变量和待验证项

持久 Session binding 是唯一引用来源；SDK 对象只是缓存。资源层可以自行创建、连接、唤醒和续租，只向调用者交付可用的访问能力。任何替换都必须有新 allocation、显式保留范围和 readiness；不能把恢复环境解释为重新执行业务。

新 owner 拿到 handle **并不会自动使旧 SDK client 失效**。本地能力撤销及 DB fencing 只能挡住后续派发/结果提交，不能收回已发送的 HTTP 请求。旧清理只能删除不可重新采用的独立 allocation；未知远端操作必须保留证据，不能按 attempt lease 到期清空。

接入认证仍需对各部署版本实际 probe：原 ID 重连与实例死亡、pause 后 PID/内存/文件/网络分别保留情况、延迟命令在 owner 更换后的完成、重复 delete 的 202/404、丢失 create 响应后的按 allocation 查找，以及 provider 自身隐式重试/自动唤醒。未跑这些 probe 的能力保留为待验证，不写成“不支持”，也不承诺 exactly-once。
