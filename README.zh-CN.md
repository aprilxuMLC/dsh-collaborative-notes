# Collaborative Notes for DeepSeek Harness

[English](README.md) | **中文**

> **面向人机协作的共享注意力工作区：让一件事离开当前主线，却不离开协作。**  
> **A shared attention workspace for human–agent collaboration — where something can leave the main thread without leaving the collaboration.**

Collaborative Notes（协作便签）是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的人机协作插件。它不是普通笔记本，也不是任务管理器、长期记忆或知识库。它在当前对话旁边增加一块**共享的临时工作区**，帮助人和 Agent 决定：什么现在应该继续占据注意力，什么可以安全放下；放下以后，又怎样在真正需要时准确地拿回来。

当前 **release candidate** 针对 **DeepSeek Harness 0.1.5-rc.2** 验证。

---

# I. 它是什么，它为什么重要

### 对话是线性的，工作不是  
**Conversation is linear. Work is not.**

真实工作会不断产生旁支。东西一直留在对话里，主线会越来越重；东西随手扔进另一个笔记本，又容易丢掉“它当时为什么重要”。

Collaborative Notes 尝试提供第三种选择：

> **让一件事离开当前主线，但不离开协作。**  
> **Let something leave the main thread without leaving the collaboration.**

这背后不仅是一个记忆问题，也是一个注意力问题。

### 注意力稀释  
**Attention Dilution**

长程协作中，即使所有历史、文件、memory 和 Notes 都还存在，Agent 仍然会面对另一个问题：随着越来越多事项同时保持“可能相关”，此刻真正应该关心什么会变得越来越难判断。

信息没有丢失，并不意味着协作就更清晰。相反，如果所有东西都长期留在 active context 或工作集里，真正重要的约束可能被越来越多“也许有用”的状态稀释。

Collaborative Notes 尝试把**注意力本身也变成一种可以共同管理的资源**。当前真正需要的内容继续留在主线；其它内容一旦被可靠安置，就可以退出 Agent 的持续注意力，之后再由用户或当前任务重新把它带回前台。

这里利用了一种很朴素的人机差异。人不需要像模型一样，把所有事项持续塞进 active context；一个容易浏览的共享工作面可以提供成本很低的外围注意力——看一眼、置顶一下、选中一条，或者说一句“把这个拿回来”。Agent 则可以在需要时沿明确入口重新读取和恢复上下文。

> **人类的低成本外围注意力 + Agent 的按需重新激活。**  
> **Human peripheral attention + Agent on-demand reactivation.**

这是一种我们正在探索的分布式注意力协作方式，而不是简单给 Agent 塞进更大的 memory。它是否能够在不同用户和长程任务中稳定降低认知负担、提高任务质量，目前仍然是一项需要继续验证的产品假设。

### 记忆不等于注意力  
**Memory ≠ Attention**

“以后还能找到这件事”和“现在还应该持续关注这件事”不是同一个问题。

更大的 memory 回答的是“它还在不在”；attention management 回答的是“它现在该不该进入工作集”。

因此，Collaborative Notes 不只是帮助 Agent **记住更多**。同样重要的是，它允许已经可靠安置的事情暂时不用继续占据注意力。延后工作、知识候选和复盘素材可以退出当前主线，而不是永远作为三个 live queues 跟着对话往前走。

> **还存在，不等于现在优先。**  
> **Can be retrieved ≠ must stay in attention.**

但安全放下只有一半。另一半是：以后真的还能回来。

对于依赖具体对话内容产生的 Note，Collaborative Notes 会保留它和原始讨论之间的来源关系。因此，重新处理时可以先回到真正的 source，而不是靠全文搜索或模型猜测重新寻找一个“应该差不多在这里”的位置。

> **释放注意力，不等于丢失返回原始语境的路径。**  
> **Attention can be released without losing the return path.**

它也不要求当前 Agent 在 capture 时替未来预测所有上下文需求。未来获得相应读取权限、真正处理这条材料的 Agent 或工作流，可以先读 Note，再沿保存的来源回到原始讨论，然后根据自己当时真正要完成的任务补读足够的 surrounding context。

所以这里保存的不是一个提前压缩好的“未来上下文包”，而是一个以后重新获得真实上下文的把手。

> **保存未来上下文的把手，而不是预先打包未来上下文。**  
> **Future Context Handle, not Future Context Package.**

这也是为什么 Collaborative Notes 刻意保持一个小核心。它负责 capture、暂存、路由、provenance 和 reactivation；真正的后续加工由不同 consumer 完成。L2 可以进入 BACKLOG 或工作规划，L3 可以进入知识整理，L4 可以进入复盘或 Agent improvement workflow。

| 便签 | 未来消费者 | 后续工作 |
|---|---|---|
| **L2 延后工作** | BACKLOG / 工作规划 Agent | 排序、合并、安排、执行 |
| **L3 知识候选** | 知识整理 Agent / Workflow | 核验、去重、重组、正式沉淀 |
| **L4 复盘素材** | 复盘 / Agent improvement Workflow | 复盘、验证、接受，再决定是否改变 Rule / Skill / Prompt / Workflow |

因此，一条东西被记下来，只说明它值得以后处理，并不说明处理已经发生。

> **候选状态，不是正式状态。**  
> **Candidate ≠ Formal State.**

知识候选不等于已经验证的知识，复盘素材不等于已经接受的规则，延后工作也不等于已经派发任务。

默认的协作方式仍然是**用户主导 capture，人和 Agent 协作维护**。如果你已经决定“把这个记下来”，当前 Agent 可以帮助把 Note 写清楚；Agent 也可以建议“这个要不要留一条？”，但 proposal 本身不是 capture。它不会因为一句话看起来重要，就自动扫描普通对话、大量挖掘 Notes，或者把轻量 capture 提前变成知识整理和 formalization。捕获阶段也不会仅因为几条内容相似，就自动去重、合并、重排或重写；这些整理属于后续 consolidation，因为“同一个问题重复出现过几次”本身也可能是有价值的过程证据。

Collaborative Notes 的过程状态也默认是局部的。其它 conversation 的 Notes 不应该仅仅因为技术上可访问，就自动进入当前 Agent 的工作集；需要时，可以由用户明确指定目标，再按当前请求进行有限读取。

> **默认局部，需要时明确取用。**  
> **Local by Default, Explicitly Retrieved When Needed.**

---

# II. 现在实际能做什么

## 能力速览  
**Capability Overview**

当前版本主要提供几类能力：用四个 lane 安置不同时间尺度的事项；直接创建普通 Note，或者从对话原文建立带 Source 的 Note；从 Note 回到原始 discussion；把选中的 Notes 随下一条消息提供给**当前会话中的 Agent**；让当前 Agent 通过正式 Notes operations 读取和维护当前 Notes；按用户明确要求读取其它指定 conversation；以及在 conversation fork 时决定哪些 Notes carry 到新分支。

四个 lane 表示的是不同的后续处理意图，而不是优先级：

| 默认类别 | 用途 |
|---|---|
| **L1 会话待办** · `conversation_todo` | 当前会话里之后还需要回来处理的事项 |
| **L2 延后工作** · `deferred_work` | 值得做，但现在不应该打断当前主线的工作 |
| **L3 知识候选** · `knowledge_candidate` | 值得以后核验、整理和正式沉淀的知识素材 |
| **L4 复盘素材** · `lesson_candidate` | 值得以后复盘、可能影响未来做法的经验候选 |

L1 所代表的责任仍然属于当前 conversation；L1 只是当前会话责任的一种可选共享表示，不是当前 Agent 所有责任的完整登记册，没有 L1 Note 也不等于当前 Agent 没有这项责任。L2 / L3 / L4 在被可靠安置以后，则可以真正离开当前主线。

普通 Note 可以没有历史 Source。例如你突然想到“这个之后应该让另一个模型独立审核”，这个想法是在表达时才进入协作状态。系统会保留它的 capture origin，但不会为了形式完整而虚构一个 historical Source。

如果你从当前对话中选中一段原文，再使用“引用选中到便签”，系统会分别保留 Note 正文、capture 时接受的 source snapshot，以及指向原始 message 的 Source Anchor。普通编辑可以修改 Note 正文，但不会偷偷改写已经建立的 historical Source。

当前 DSH 版本的一次 Source capture 必须来自**同一条普通、可选择的 user 或 assistant message**。跨多条 message 的 selection 不会被自动拆分或猜测；reasoning / Think / tool-call 等 surface 也不属于当前已经验证的稳定 capture 范围。这是当前 DSH adapter 的边界，不是未来跨 host Core 的永久限制。

对于带 historical Source 的 Note，可以使用 **↪ 回来源**。系统先定位已经记录的原始 message，再在这条 message 中寻找保存的原始文本。如果同样的 selected text 在该 message 中出现多次，当前实现会展示所有 exact literal matches，而不是猜测“当年到底是第几个”。

如果当前 renderer 无法机械构造更窄的 exact cue，但 source message 本身仍然可以可靠确认，界面可以显示较宽的 message-level cue，并明确表示它是 broader / non-exact，而不是冒充原来的精确选区。

Source 当前暂时读不到，也不会自动被解释成 historical provenance 已经损坏。系统不会为了维持“成功体验”而搜索另一段相似文本，并把它重新绑定成原 Source。

你还可以在 Notes 面板中选择一条或多条 Note。发送下一条消息时，它们会作为引用随这次请求一起提供给**当前会话中的 Agent**。这不会广播给其它 Agent，也不会自动建立长期跨 session 权限，更不会把 Note 变成 system instruction。

当前 Agent 也可以通过 Collaborative Notes Skill 直接读取和维护当前 holder 的 Notes。它不需要知道物理 Notes 路径；修改前需要读取当前版本，出现 stale conflict 后应重新读取而不是直接覆盖。历史 Source 可读，也不等于 Agent 自动获得修改、closure 或执行权限。

跨 conversation 访问则需要当前请求中明确、有限的授权。例如“看看昨天那个 DSH conversation 的便签”，可以授权本次读取；但不会因此产生以后持续扫描所有 conversation 的 standing authority。

Fork 时，你可以明确选择 **全部带走 / 只带一部分 / 不带**。能否 carry 还取决于 Note 是否属于 fork 的 shared history。带到 child 以后，parent Note 和 child Note 独立演化：一边的 edit、closure、deletion 或 Pin 不会自动传播到另一边。已有 historical Source 也不会因为 carry 被偷偷改成 child conversation。

当前 holder 的 Notes 还可以搜索、排序、置顶、编辑和删除。这些是 attention-management affordance，不会改变 Source identity、优先级、formalization status 或 Agent authority。

Collaborative Notes 也刻意区分“已经处理”和“已经删除”。工具调用成功不等于用户问题已经解决，离开当前 model context 也不等于 closure。即使一条 Note 已经处理完成，永久删除仍然需要用户授权。

---

# III. 安装、第一次使用与当前支持边界

需要：

- DeepSeek Harness `0.1.5-rc.2`
- Node.js 与 `pnpm` 可在 PATH 中使用

**已发布的公开仓库：**

`aprilxuMLC/dsh-collaborative-notes`

公开后预期使用的 GitHub 安装命令为：

~~~sh
dsh plugin --profile web add github:aprilxuMLC/dsh-collaborative-notes
~~~

然后启动或重新启动 Web profile：

~~~sh
dsh web
~~~

安装并成功重启 profile 后，Notes 入口（`📝`）会出现在 conversation header 的工具区，Collaborative Notes Skill 也会在当前运行时注册。更新 Bundle 并重启后，这项能力会恢复。移除 Bundle 并重启后，Notes UI 入口和运行时 Skill 会消失，但 workspace Notes 数据保留；重新安装并重启后，两者恢复，并继续使用仍然有效的 workspace binding。

当前 release candidate 已包含运行所需的构建产物，因此公开 GitHub 发布形态不要求用户 clone 源码后再手工 build。仓库现已发布，未经认证的 GitHub 安装以及 clean-install/runtime E2E 已完成本 release gate 的验证。

第一次使用路径是：打开 Notes → 确认建议位置或选择其它位置 → 创建一条 Note → 可选地引用选中的文字。默认建议位置是 workspace 下的 `notes` 目录；自定义目录只有在 host 的目录选择能力接受后才会使用。一个 workspace 只有一个持久化确认的 binding。插件不会仅仅因为安装完成，就静默替用户猜测或重新绑定一个 Notes root。

Collaborative Notes 使用 workspace-backed durable state，而不是隐藏的远程 Notes 服务。workspace binding 与 Note 文件是持久的；Pin 等浏览器本地注意力偏好不替代这个 binding。一个 workspace 对应一个经过确认的 Notes location；正常 Agent 操作通过逻辑 Notes interface 完成，不需要知道真实文件路径。卸载插件不会把 workspace Notes 当作 package 文件一起删除；只要原 binding 仍有效，重新安装会继续使用它。

安装时使用的是 GitHub repository 名 `dsh-collaborative-notes`；update / uninstall 针对的是 package 名 `dsh-collab-notes`：

~~~sh
dsh plugin --profile web update dsh-collab-notes
dsh plugin --profile web remove dsh-collab-notes
~~~

添加、更新或移除 Bundle 后，需要重新启动对应 profile。

## 当前支持范围与已知边界  
**Current Support Boundary**

当前 release candidate 已针对 **DeepSeek Harness 0.1.5-rc.2** 完成隔离 clean-install 和当前 exercised product path 的验证，但仍有明确边界：

- Source capture 当前限于单条普通、可选择的 user 或 assistant message；
- reasoning / Think / tool-call 暂不作为稳定 Source capture surface；
- Source re-entry 不通过跨 message 的相似文本搜索重建 historical identity；
- 某些很早期的 DSH conversation 可能因为 host 自身的 historical-session replay 问题暂时无法读取；
- Source 暂时不可访问不会导致已有 provenance 被自动改写；
- 当前验证不构成对未来 DSH 版本的无条件兼容承诺；
- 永久删除在产品与 Agent 行为语义上需要用户授权；当前 DSH 并不对所有通用文件或外部写入路径提供 Notes-specific 的机械 enforcement。

这部分会保留完整，不会为了让 README 更短而隐藏 qualification。

---

# IV. 深入了解设计与开发

如果只想使用插件，前面三部分已经足够。想理解为什么这样设计，可以继续读公开文档。

| 文档 | 适合什么时候读 |
|---|---|
| [**Concept**](docs/concept.zh-CN.md) | 想理解 Memory / Attention、Attention Dilution、staging、provenance、downstream workflow 等设计思想 |
| [**Core Contract**](docs/core-contract.md) | 想知道哪些行为属于稳定的产品 contract |
| [**Agent Guide**](docs/agent-guide.zh-CN.md) | 想知道 Agent 应怎样使用 Notes、什么时候不能自动 capture、formalize、delete 或跨 session 扩权 |
| [**DSH Integration Reference**](docs/dsh-integration.zh-CN.md) | 想安装、开发、适配或核对当前 DSH 实现与支持边界 |

公开仓库只保留面向使用者和实现者需要的当前文档。内部研究、probe、部署证据和设计过程历史在本发布面之外单独维护。

公开仓库会同时包含源码和当前 release 所需的构建产物。公开候选的可复现检查入口是 `npm run verify:public`；它依次运行构建、bundle contract、客户端测试和 Skill materialization validation。隔离的 DSH `0.1.5-rc.2` runtime 检查另外覆盖真实 `/api/notes-api` carrier、四个 lane 的读写、首次 workspace setup、save → readback 以及重启后的 workspace binding 保留。这些检查不替代后续从公开仓库进行的 clean-install gate。

最终公开 release 的门槛仍然是从全新 public repository 出发完成匿名 browse / clone / download / clean-install / runtime E2E。

## License

MIT License.
