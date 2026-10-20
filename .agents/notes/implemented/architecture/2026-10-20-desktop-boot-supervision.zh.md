# Agent Note：为 Host 启动设上限，并回滚无法启动的 profile

Status: implemented

[English](2026-10-20-desktop-boot-supervision.md) | 中文

## 问题

插件可以在不抛出壳能观测到的异常的情况下结束 Host。`process.exit()`、同步死循环或原生崩溃，都会让 Desktop 壳停在它既有失败路径没有覆盖的状态：

| 症状 | 为何逃过既有机制 |
|---|---|
| 窗口永远停在加载页 | `DesktopHostProcess.start()` 等待 `ready` IPC 消息且没有截止时间；卡在插件同步循环里的 Host 既不发消息也不退出，因此没有任何东西会拒绝 |
| 无法启动的 profile 每次启动都原样重试 | Host 之外没有任何地方记录上次启动失败过，因此导致失败的组合从未被替换 |
| 坏掉的组合一直是坏的 | pnpm 失败时 `installBundle` 会恢复 `package.json` 和 `pnpm-lock.yaml`，但插件安装成功后阻止启动的情形已经写入了 `cordis.patch.yml`，并被保留下来 |

壳被告知的致命失败已有原生恢复。这四种情况没有这样的报告。

## 决定

由壳监督 Host——它是唯一能在 Host 之后存活的参与者。

### 就绪截止时间

`DesktopHostProcess.start()` 布置 `HOST_READY_TIMEOUT_MS`（默认 120 秒，`DSH_DESKTOP_HOST_READY_TIMEOUT_MS`），到期即以 `DesktopHostReadyTimeoutError` 结束这次尝试，并附上保留的 stderr 尾部。`DesktopBackendController` 本就会在发布错误前停止失败的子进程，因此卡住的进程树由既有的逐级升级结束（`shutdown` → 10 秒后 SIGTERM → 5 秒后 SIGKILL）。该截止时间在 `ready`、任何失败以及 `stop()` 时清除，因此绝不会对已经结算的尝试或已在运行的 Host 触发。

该上限约束的是沉默，不是性能。进展缓慢的 Host 最终会报告 `ready`，不受影响；只有两分钟内什么都没报告的 Host 才会失败。提高它是改配置，不是改代码。

### 由壳持有的连续失败记录

`DesktopBootJournal`（`apps/desktop/src/boot-journal.ts`）把 `boot-failures.json` 写在 Electron userData 下——故意放在 profile 之外，这样回滚无法抹掉授权它自己的记录。每次未达到就绪即结束的启动记录：

- **组合指纹**：`package.json`、`cordis.yml` 和 `cordis.patch.yml` 的内容，包含"不存在"这一状态。对内容而非 mtime 求哈希，意味着任何 profile 写入都开启新一轮；这正是"改好再试"无需特例的原因。
- 该指纹连续失败的次数
- 失败类型：`address-in-use` 或 `composition`
- 该组合是否已用过回滚

达到就绪会删除该文件。

`main()` 在 `reconcileBackend()` 的拒绝路径中记录失败，`backend.start()` 正是在那里发布每一种就绪前失败。`bootJournal.markReady()` 在 `backend.start()` 解决后、任何窗口操作之前立即运行，因为这个解决正是记录要记录的事实。

### 一次自动回滚

`recoverUnstartableProfile()` 在 profile 准备阶段、Host 派生之前运行，因此失败的组合会在加载它的任何插件之前被替换。它复用 `DesktopProfileManager.disableAllPlugins()`——原生恢复按钮所用的同一个 `sanitizeProfile` 调用——并持有包操作所用的同一把 profile 写锁。

约束条件让恢复不至于变成第二种失败模式：

- **监听冲突永不回滚。** `listen EADDRINUSE` 意味着另一个 DSH 实例；改 profile 修不了它，改写只会白白毁掉一份可用的组合。
- **每个组合只回滚一次。** `recordRollback()` 置下一个标记，在同一指纹后续失败后依然存在，因此恢复后仍无法启动的 profile 会上报失败，而不是循环改写自身。
- **回滚失败不导致启动失败。** 写失败只记日志并继续启动，让 Host 自己的诊断解释问题，而不是被一条 I/O 错误替换。
- **未初始化的 profile 不记录任何东西。** 尚不存在的 profile 目录正要在本次启动中被创建，没有尝试过任何组合。

成功启动后，回滚会在工作区打开时用原生消息框说明，因为 profile 已不再加载用户配置的内容。

### 可替换 Host 的存活探测

`DesktopHostProcess.probe()` 发送既有的 `update-tasks` 控制请求，并报告是否收到回答。卡在同步循环里的 Host 不会作答，而进程仍然存活——窗口继续渲染，启动 IPC 请求干脆不结算。

检测与恢复都默认开启。`DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS` 每 30 秒探测一次，`DSH_DESKTOP_HOST_STALL_PROBES` 默认为 `3`，因此沉默 90 秒的 Host 会被替换。一次事件中首次未作答的探测总会写入一份 `host` 崩溃报告说明卡顿，所以即使 Host 自行恢复也会留下记录。

### 测量「卡顿」到底意味着什么

探测超时只说明 Host 停止作答，不说明它的循环是被阻塞了，还是某个请求只是慢。`apps/desktop-host` 在进程整个生命周期里运行 `monitorEventLoopDelay`，并把分布附加到每个 `inspect` 回答上。Node 从 Host 自己拥有的定时器投递这些样本，而定时器恰恰是阻塞循环会卡住的东西，因此 `max` 报告的就是循环被连续占用的最长一段。壳保留最后一次测量并引用在卡顿报告里：

> `... did not answer a probe within 10000 ms ... Before that, its event loop was blocked for up to 4800 ms (p99 240 ms, p50 1 ms over 30000 ms).`

这句话把「插件卡住了」和「请求慢」区分开：`max` 很大而 `p50` 很小，是一次阻塞；`p99` 在多份样本上都很大，是持续压力。采样是尽力而为——平台拒绝直方图时 Host 只损失这份测量，报告会说明没有可用测量。

该阈值通过安装交接所用的同一路径把检测变成恢复：清空启动租约，使渲染器不再向注定被替换的 Host 请求注入；`backend.stop()`；`backend.start(prepareHostEnvironment)`；然后丢弃缓存的导航并针对新 URL 重新加载页面。`DSH_DESKTOP_HOST_STALL_RECOVERIES`（默认 `1`）限定每个应用进程的重启次数，超出额度的卡顿会弹出原生消息框，而不是无限重启。

把间隔或阈值设为 `0` 可只保留检测、不做替换，这正是"绝不能牺牲长任务"的部署想要的。这个权衡是显式的而非偶然的：单靠探测无法区分被真正阻塞 90 秒的工作与卡死的插件，所以默认值选择放弃那部分工作，以避免留下一个冻结的窗口。

## 考虑过的替代方案

**只上报，永不重启。** 保留卡住的 Host 能保住它的工作，但用户看到的是一个冻结的窗口，且无法区分长任务与死掉的插件。有上限的重启配合崩溃报告与额度耗尽提示，能给回一个可用的应用，以及发生了什么事的记录。

**单次探测未作答就重启。** 30 秒一次的单个探测无法区分卡死的插件与慢请求。三次探测把决策代价定在 90 秒沉默——长到足够一个合法的慢操作完成，短到冻结窗口不会持续。

**运行期卡顿也走 profile 回滚。** 就绪之后的卡顿不是"无法启动的组合"，所以 app-boot 恢复路径是错的工具：重启 Host 能隔离故障，而不丢弃可用的插件配置。

**把任何就绪前失败都视为可回滚，包括监听冲突。** 实现便宜，但会因为恰好有第二个 DSH 实例在运行就改写一份可用的 profile。

**首次失败即回滚。** 单次失败通常是过期锁、瞬时读取问题或端口情况。同一组合连续三次失败才是证据；一次只是样本。

**把记录放在 profile 目录里。** 回滚会重命名 `cordis.patch.yml`；放在它旁边的记录离被连同它所描述的组合一起丢失只差一次重命名。

**用 Config 字段暴露失败上限。** 壳没有 profile 级 Config；`DSH_DESKTOP_*` 环境变量是壳可调项的既有界面，而这个上限本就不打算按次启动调整。

## 后果

- 阻止启动的插件代价是一次卡住的启动（至多两分钟），而不是无限挂起；并且在 profile 自动恢复前至多三次启动。
- 壳现在会在失败时向 userData 写一个很小的文件，并在成功时删除它。丢失或损坏的记录只损失自动回滚；`evaluate()` 忽略它，`recordFailure()` 是尽力而为。
- 恢复在 Host 启动前改写 profile，意味着用户的插件会在没有事先对话框的情况下被禁用。对话框事后解释并指名失败次数。这是有意的权衡：无法启动的 profile 显示不了对话框。
- `DesktopBackendHost` 新增了必需的 `probe()` 成员，因此每个测试替身都需要它。`welcome-startup.spec.ts` 整体 mock 该模块，现在也要提供 `HOST_READY_TIMEOUT_MS`。
- 存活探测与卡顿替换默认开启，因此事件循环卡死的 Host 会在沉默 90 秒后被替换。这意味着接受丢失卡住循环所持的工作——这是相对"留下冻结窗口"的有意取舍。
- 本次改动还修掉了 journal 暴露出的测试卫生缺陷：`welcome-startup.spec.ts` 曾把 `app.getPath('userData')` mock 成固定路径 `/desktop-user-data`，于是每次运行都把 journal 记录写到了盘符根目录旁。现在改用临时目录并在 `afterEach` 中删除。`main-startup.spec.ts` 同样每个文件只创建一次 profile 目录却从不删除，现在在 `afterAll` 中清理。journal 自身针对未初始化 profile 的 `existsSync` 守卫保留，因为它是独立于这两个 mock 的真实正确性规则。
- `plugin-development` 的实践条目现在明确要求生命周期钩子不得占住事件循环，因为那正是这套监督机制只能收容、无法预防的缺陷。

## 测试

- [boot-journal.spec.ts](../../../../apps/desktop/tests/boot-journal.spec.ts) 固定失败规则：未达上限不前回滚、任何组合变化开启新记录、监听冲突豁免、单次回滚标记、就绪清除、损坏记录被忽略，以及未初始化 profile 的豁免。
- [host-process.spec.ts](../../../../apps/desktop/tests/host-process.spec.ts) 固定：占用事件循环的 Host 在其截止时间失败并带上保留的 stderr、报告过 `ready` 的 Host 之后永不失败，以及 `probe()` 报告未作答的 Host 但不判定其失败。
- [main-startup.spec.ts](../../../../apps/desktop/tests/main-startup.spec.ts) 固定接线：已达成的连续失败在准备阶段回滚并上报、就绪清除记录、就绪前失败记录一次、存活探测只上报一次卡顿，以及配置的阈值会替换 Host、未达阈值时不动它、额度用尽后只上报不再重启。
- [duration-env.spec.ts](../../../../apps/desktop/tests/duration-env.spec.ts) 固定五个设置的范围与默认值，包括默认值本身（30 秒间隔、3 次探测）以及把任一值设为 `0` 时只检测不替换。
- [event-loop-delay.spec.ts](../../../../apps/desktop-host/tests/event-loop-delay.spec.ts) 固定采样器行为：首个样本前不报告、空转的循环被报告为很大的最大值且百分位有序、重置后只描述自己的窗口、重复停止幂等、整数毫秒，以及平台拒绝直方图时不抛异常。
- `main-startup.spec.ts` 另外固定：卡顿报告引用最后一次作答探测测到的延迟，且在没有可用测量时说明这一点。
