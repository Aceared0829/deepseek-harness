# Agent Note: 在渲染进程启动完成前保留 Desktop 启动响应

Status: implemented

[English](2026-10-19-desktop-boot-response-lease.md) | 中文

## 问题

Desktop 开发启动在 Web 应用文档已经加载后，才从 Host 收集 index 注入表。文档随后执行 parser 阻塞的 bootstrap 行，并请求带 revision 的插件 bundle URL。HMR 可能在收集注入与这些请求之间发布数代客户端 bundle。`ClientModuleRegistry` 只保留当前图和上一批代，于是注入表中的 bootstrap URL 可能已不在任何一张表里。Host 返回 404，客户端模块系统无法挂载，窗口显示原生启动恢复对话框。React 渲染错误、缺少 root slot、未知 Session 消息，以及早先的 `MARKS_REMOTE_SPEC` 语法错误，都是下游现象或历史故障，不是这次失败的原因。

原先保留一代是为一请求与一次重建的竞态兜底；它无法覆盖任意次重建，固定保留 N 代在持续编辑下仍会失败。

## 决策

`ClientModuleRegistry.retainBootResponses()` 会快照当前图的启动 combo 脚本、combo map 与逐 row 回退 combo 响应，并返回幂等释放函数。Host 在 `collectIndexInjections()` 之前立即取得租约，因此注入表与保留响应描述同一代图，不受后续 HMR 重组影响。

Desktop Host 通过生命周期控制通道把租约与注入行一起返回给 Electron。Electron 为每个应用渲染进程最多保存一个租约，并串行执行其 boot 与释放操作。渲染进程在注入表启动路径与 `AppWebEntry.run()` 都结算后释放租约，失败也释放。渲染进程销毁、Host 替换、更新准备、后端失败与应用退出，都会在所属 Host 停止前释放或丢弃未完成租约。更新与退出先关闭 boot 准入；未完成的 Host 请求在该请求失败或返回后结算，迟到的租约直接释放，不暴露给渲染进程。Host 停止前失败的更新会重新开放准入。Host 在关闭或无法发送 boot 响应时也会释放自己的租约。

租约覆盖 combo 脚本与 map，因为它们是启动注入表直接公告的字节；逐 row 单资源回退 URL 也在租约内，因为批次已执行却未注册某 row 时，同一次启动会回退到该 URL。包内 chunk 保持懒加载，不在租约内。旧 revision 被请求时，其文件可能已被覆盖，保留响应计划会把新字节当作旧 URL 的内容返回。重建前已经物化的 chunk 继续通过普通 immutable 响应表可用；未被请求的旧 chunk 在 revision 变化后返回 404。

注册表在释放前独立持有每个租约。这不是有界代数缓存：渲染进程租约在启动 URL 不再需要解析时结束。

## 考虑过的替代方案

**固定保留若干代。** 持续 HMR 仍可能发布超过上限的代，bootstrap URL 会在渲染进程请求前被淘汰。

**用定时器或 TTL 过期。** 正确性会依赖渲染进程启动耗时，而 Host 既无法界定也无法观察这个时间。

**取得租约时急切读取并保留全部 bundle 与包内 chunk。** 这会为渲染进程可能永不请求的文件增加 I/O 与内存；在租约取得前已被覆盖的未请求 chunk，也无法保留其精确旧字节。

**Desktop 启动期间禁用 HMR。** 这会全局改变开发行为，而不是把保留范围绑定到需要特定启动代的渲染进程。

**在启动窗口内暂停整个构建管线。** Host 在收集表之前不知道渲染进程将执行哪代图；全局暂停会阻塞无关的构建发布，也没有缩小所有权范围。

**由渲染进程在 404 后恢复。** bootstrap 失败使客户端模块树与恢复 UI 难以挂载；此时文档已无法可靠地针对缺失代重试。

## 后果

无论 HMR 在渲染进程启动期间连续发布多少代，启动 bundle URL 都保持可解析。每个活跃渲染进程最多持有一个租约；重复 boot 请求会先释放上一个，再取得下一个。释放幂等，不影响其他渲染进程或更早物化的响应。

Host 可能在渲染进程启动期间持有启动 combo 与 map 计划。启动失败后的渲染进程释放是尽力而为，但销毁与退出路径也会释放或丢弃 Host 持有的租约，因此已失效的渲染进程不会无限期占用它。

协议现在随 boot 注入携带租约，并提供匹配的释放确认，因此不同协议代的 Desktop 与 Host 不能混用。`DESKTOP_HOST_PROTOCOL_VERSION` 随这次 wire 变更推进。

重建后首次请求上一代 combo map 时，仍会读取当前 authored map 文件，这一点不变。包内 chunk URL 只保留在其原始 revision 下已经物化的响应；陈旧且未物化的 chunk 会刻意返回 404，而不是混合代字节。

## 验证

Client Modules 测试覆盖显式租约跨三次重建、彼此独立且幂等的释放、保留逐 row 回退与 map URL，以及未物化的旧包内 chunk 返回 404 而不别名到新字节。Desktop 测试覆盖并发 boot 串行化、渲染进程所有权范围内的释放、释放被拒绝后保留至销毁、渲染进程销毁、后端停止前排空 boot 准入、拒绝过期 boot、Host 替换、畸形 IPC，以及 Electron Node 模式要求的 `process.send` 接收者。Web 测试覆盖启动结算后与注入失败后的释放，且不替换原生恢复。
