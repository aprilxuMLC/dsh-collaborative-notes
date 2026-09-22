# DeepSeek Harness 集成参考

这是 `dsh-collab-notes` 当前公开候选形态的集成说明。

## 目标版本与安装形态

当前 release candidate 针对 **DeepSeek Harness `0.1.5-rc.2`** 验证。预期公开仓库为 `aprilxuMLC/dsh-collaborative-notes`，发布本身是单独的 release gate，目前尚未公开。公开后预期使用：

```sh
dsh plugin --profile web add github:aprilxuMLC/dsh-collaborative-notes
dsh web
```

Package 已包含运行所需的构建产物和唯一的 Skill template source。在 DSH `0.1.5-rc.2` apply 时，插件通过 host runtime registry 注册渲染后的 Skill，不创建 user-root Skill 文件。由于候选尚未公开，不能声称未经认证的 GitHub 安装已经验证；正式发布仍必须从全新 public repository 完成 clean-install 与 runtime E2E。

安装并成功重启 profile 后，Notes 入口（`📝`）会出现在 conversation header 的工具区，Collaborative Notes Skill 也会在当前运行时注册。更新 Bundle 并重启后，这项能力会恢复。移除 Bundle 并重启后，Notes UI 入口和运行时 Skill 会消失，但 workspace Notes 数据保留；重新安装并重启后，两者恢复，并继续使用仍然有效的 workspace binding。

## 第一次使用与存储

第一次使用路径是：打开 Notes，确认建议位置或选择其它位置，创建一条 Note，并可选地引用选中的文字。默认建议位置是 workspace 下的 `notes` 目录；自定义目录只有在 host 的目录选择能力接受后才会使用。安装不会静默猜测或重新绑定 Notes root。

实现使用 workspace-backed durable state 和逻辑 Notes interface。workspace binding 与 Note 文件是持久的；Pin 等浏览器本地注意力偏好不替代这个 binding。一个 workspace 对应一个确认过的 Notes location；正常 Notes 操作不要求 Agent 知道物理路径。卸载插件不会把 workspace Notes 当作 package 文件主动删除；只要原 binding 仍有效，重新安装会继续使用它。

## 逻辑能力

四个语义 lane 是 `conversation_todo`、`deferred_work`、`knowledge_candidate`、`lesson_candidate`，显示为 L1–L4。读、搜索、创建、更新、删除、移动，以及支持的 Source、carry、re-entry 操作，都受用户权限和 stale-write precondition 约束。具体文件、HTTP carrier 和 host service 属于 adapter 实现细节。

## Source capture 与回来源

当前 DSH profile 支持同一条普通可选择的 user 或 assistant message，并要求一个 authoritative message identity。跨不同消息的 selection 必须 fail closed，不能静默选一条，也不能伪造无来源 Note。

已接受的 Source 会把 authored Note content、selected snapshot 和 durable Source relationship 分开保存。回来源先确认记录的消息，再只在该消息内查找保存文本；不会跨 message 搜索后重新绑定。能机械得到精确 span 时优先精确高亮；否则可以使用明确标注的 broader message-level cue。

## 当前会话引用与历史读取

选中的 Note 可随下一条请求提供给当前会话 Agent。这不会广播给其他 Agent，也不会建立长期权限。跨 session 读取必须在当前请求中明确且限定范围；能读历史 Source 不代表获得修改、删除、关闭、执行或 formalization 权限。

## Fork 与 carry

普通 fork 可以由用户明确选择全部、部分或不 carry，前提是通过 eligibility 检查。Carry 后的 Note 是 child-local state；parent 与 child 的编辑、关闭、删除和 Pin 不自动传播。历史 Source 与 capture-origin 不因 carry 改写；仅有 `parentSession` 不会产生 authority。Continuable subagent 与普通 fork 分开处理。

## 当前资格边界

- reasoning、Think、tool-call surface 不作为稳定 selected-text capture surface 宣称；
- 当前 DSH profile 不声称支持多消息/多事件 selected capture；Core 的 ordered-loci 语义仍保留给其他 host/profile；
- Source re-entry 不使用相似匹配或推断式历史 rebind；
- 很早的 host session 与超大 cold/non-attached read 仍有 host-specific 可读性、deadline 或内存资格边界；
- exact renderer span 不是普适保证，较宽提示必须如实标注；
- 删除需要用户授权，host 也不对所有通用外部 writer 提供 Notes-specific mechanical enforcement。

## 开发与可复现验证

客户端源码是 `src/client.js`；`npm run bundle` 会生成运行时客户端产物 `lib/client.js`。Host/runtime 行为位于 `lib/`。运行 `npm run verify:public` 可依次执行构建、bundle contract、公开客户端测试和 Skill materialization validation。依赖 Host 的 runtime 检查需要受支持的 DSH `0.1.5-rc.2` 环境，并与本地命令分开记录。

## 更新与卸载

公开发布后，update / uninstall 使用 package name：

```sh
dsh plugin --profile web update dsh-collab-notes
dsh plugin --profile web remove dsh-collab-notes
```

添加、更新或移除 Bundle 后重启对应 profile。移除 Bundle 并重启后，runtime Skill 不再进入 discovery，同时 workspace Notes 数据保留。真正公开后还需要从 published repository 重新验证完整安装、更新和卸载路径。
