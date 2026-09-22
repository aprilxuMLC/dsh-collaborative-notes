// dsh-collab-notes — binding host adapter（pending selection → pre-step 注入）
//
// 职责（host 侧、browser-free）：维护 current-holder pending selection（内存，
// session-scoped，非 durable、不写 Note 文件/Pin/数据库），并在 agent/pre-step
// 时把选中 Notes 解析为 current-content reference 注入到 direct user 消息之前。
//
// Boundaries:
//   - selection = ephemeral one-shot（bind to next direct user request）；
//     成功注入后清 pending；失败保留（client 端 UI 同步清 tray / 显示 truthful 失败）；
//   - 只对 source.kind==="user" 的 claimed direct 消息消费 pending；工具内部 step
//     无 direct user 消息 → 不注入、不消费（等待真正用户提交）；
//   - 注入消息置于 direct user 之前；direct 文本原样；不进 systemPrompt；
//   - all-or-nothing：resolveBinding 任一失败 → 不注入 subset；pending 保留 + 返回
//     failure 供 host 呈现 truthful 状态；
//   - 同一 pending 只消费一次（幂等）；generation/version 防 stale 清空（R7/R8）。
//
// 本模块不依赖 ctx/webServer：lane 读取由调用方注入 reader（node 测试可 mock；
// 生产 reader = fs.withLock + readFile，host 同 notes GET 路径）。无任何写路径。
import { resolveBinding, renderReferenceText, notesReferenceSource } from "./reference-binding.js";

/** In-memory per-session pending selection（非 durable；重启即失——selection 本就是
 *  ephemeral，UI 在 holder 变化/重启后回到无选中。
 *
 * Generation ordering：session-local 只接受严格递增的
 * generation 写入（含 clear）。迟到的旧 generation PUT（乱序/陈旧 client）不得复活
 * 已被更新的 selection 或清掉新 selection。lastGen 每次接受写入后更新；gen <=
 * lastGen 的写一律拒绝（返回 { stale: true }）。 */
export function createPendingStore() {
  const map = new Map(); // sessionId -> { generation, targets, createdAt, state, noteCount }
  const lastGen = new Map(); // sessionId -> last accepted generation (monotonic)
  const lastResultGen = new Map(); // sessionId -> generation of last reported result
  return {
    get(sessionId) {
      const p = map.get(sessionId);
      return p ? { ...p } : undefined;
    },
    /** 最新接受的 generation（含 clear 语义）；无任何写入 → 0 */
    currentGeneration(sessionId) {
      return lastGen.get(sessionId) ?? 0;
    },
    /** 尝试写 selection（targets 数组或 [] = clear）。仅 gen > lastGen 接受；
     *  等 gen 拒绝（防重放）；旧 gen 拒绝。空 targets = clear（记 clearedGeneration）。 */
    set(sessionId, targets, generation) {
      const gen = Number.isSafeInteger(generation) ? generation : undefined;
      if (gen === undefined) return { stale: true, reason: "generation required" };
      const current = lastGen.get(sessionId) ?? 0;
      if (gen <= current) return { stale: true, reason: `generation ${gen} <= current ${current}` };
      lastGen.set(sessionId, gen);
      if (!Array.isArray(targets) || targets.length === 0) {
        map.delete(sessionId);
        return { cleared: true, generation: gen };
      }
      const next = { generation: gen, targets, createdAt: Date.now(), state: "pending" };
      map.set(sessionId, next);
      return { pending: { ...next }, generation: gen };
    },
    /** 注入已构造但尚未确认 durable（session/event append 观测前）。幂等：仅 pending 态可转 injected。
     *  @param {number|null} [baselineSeq]  注入时刻的 session 事件 seq 基线；配对把 reference append
     *   绑定到可验证的事件序证据——旧/重放事件
     *   （seq ≤ baseline）不得 arm 新一代 tracker）。
     *  @param {boolean} [baselineReliable] 基线是否来自权威事件视图（agent.session
     *   events 末尾 seq）。**缺失/不可靠的基线不得当作有效 0**——不可靠时 reference
     *   不得 arm（保持 pending，避免虚假配对）。 */
    markInjected(sessionId, noteCount, baselineSeq = null, baselineReliable = false) {
      const p = map.get(sessionId);
      if (!p || p.state !== "pending") return false;
      p.state = "injected";
      p.noteCount = noteCount;
      p.injectedAt = Date.now();
      const seqOk = Number.isSafeInteger(baselineSeq);
      p.injectSeq = seqOk ? baselineSeq : null;
      p.injectReliable = seqOk && baselineReliable === true;
      return true;
    },
    /** durable 确认（observed append）后才清除：pending 清除必须晚于
     *  reference 真正 append 成历史。仅 injected 态可确认；pending 态（从未注入）
     *  不清（binding 未发生）。记录结果所属 generation。 */
    confirmDurable(sessionId) {
      const p = map.get(sessionId);
      if (!p || p.state !== "injected") return false;
      lastResultGen.set(sessionId, p.generation);
      map.delete(sessionId);
      return true;
    },
    /** 失败结果（binding failure / injected stale）也绑定 generation：仅当结果来自当前
     *  最新 pending generation 时记录，防旧代结果误标新一代。 */
    noteResultGeneration(sessionId, generation) {
      lastResultGen.set(sessionId, generation);
    },
    /** 最近一次结果所属 generation（供 lastBinding 关联校验；0 = 无） */
    resultGeneration(sessionId) {
      return lastResultGen.get(sessionId) ?? 0;
    },
    clear(sessionId) {
      map.delete(sessionId);
    },
    has(sessionId) {
      return map.has(sessionId);
    },
    /** 测试/诊断：全部 pending（不进生产日志；仅导出供 node 测试） */
    _all() {
      return [...map.entries()].map(([k, v]) => ({ sessionId: k, ...v }));
    },
    /** 测试钩子：把 injected 态 pending 的 injectedAt 推到过去（模拟超时 recovery）。 */
    _forceStaleInjected(sessionId, ageMs = 60000) {
      const p = map.get(sessionId);
      if (!p || p.state !== "injected") return false;
      p.injectedAt = Date.now() - ageMs;
      return true;
    },
  };
}

/** 归一化 claimed messages：哪些是 direct user（source.kind === "user"）。
 *  仅这些消息可携带新用户提交；plugin/recall/snapshot 上下文不视为 direct。 */
export function directUserIndices(messages) {
  const out = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    if (m && m.source && m.source.kind === "user") out.push(i);
  });
  return out;
}

/**
 * pre-step 注入决策（纯逻辑）：给定当前 pending 与本轮 decision messages，返回
 * 注入计划。
 * @param {object} opts
 * @param {Array<object>} opts.messages  本轮 decision.messages（claimed + 已有上下文）
 * @param {object|undefined} opts.pending { generation, targets }
 * @param {(targets:Array<{laneKey:string,itemKey:string}>) => Promise<{ok:true, notes:Array}|{ok:false, failures:Array}>} opts.resolve
 *       调用方注入的 lane 读取 + resolveBinding 组合（生产 = fs 读各 lane → resolveBinding）
 * @param {(input:{laneKey:string,itemKey:string,item:object,projection:object}) => Promise<string|null>|string|null} [opts.resolveCarry]
 *       当前 child-owned exact derivation resolver；只为 source-independent projection
 *       添加 immediate-parent metadata，失败/未知时返回 null。
 * @returns {Promise<{kind:"noop"} | {kind:"inject", messages:Array<object>, noteCount:number}
 *          | {kind:"failure", messages:Array<object>, failures:Array, noteCount:number}
 *          | {kind:"no-direct-user", messages:Array<object>}>}
 */
export async function planPreStep({ messages, pending, resolve, resolveCarry }) {
  const list = Array.isArray(messages) ? messages : [];
  const direct = directUserIndices(list);
  if (direct.length === 0) {
    // 无 direct user（工具内部 step / 空决策）→ 不消费 pending，不注入
    return { kind: "no-direct-user", messages: list };
  }
  if (!pending || !Array.isArray(pending.targets) || pending.targets.length === 0) {
    return { kind: "noop", messages: list };
  }
  const result = await resolve(pending.targets);
  if (!result.ok) {
    // all-or-nothing：不注入 subset；pending 保留（不清）；failure 计划携带 direct
    // 消息（供 wiring reject + 放回 inbox——不降级为 unreferenced request）。
    return {
      kind: "failure",
      messages: list,
      directIndices: direct,
      failures: result.failures || [],
      noteCount: pending.targets.length,
    };
  }
  const projectedNotes = [];
  for (const note of result.notes) {
    const target = pending.targets[note.ordinal];
    let projection = note.projection;
    if (projection?.type === "source-independent" && typeof resolveCarry === "function" && target) {
      try {
        const carriedFromSession = await resolveCarry({
          laneKey: note.laneKey,
          itemKey: target.itemKey,
          item: projection,
          projection,
        });
        if (typeof carriedFromSession === "string" && carriedFromSession.length > 0) {
          projection = { ...projection, carriedFromSession };
        }
      } catch {
        // Unknown/inaccessible derivation is deliberately omitted.
      }
    }
    projectedNotes.push({ ...note, projection });
  }
  const rendered = renderReferenceText(projectedNotes);
  if (!rendered.ok) {
    return {
      kind: "failure",
      messages: list,
      directIndices: direct,
      failures: [{ code: rendered.code, reason: rendered.reason }],
      noteCount: pending.targets.length,
    };
  }
  const referenceMessage = {
    role: "user",
    // 注入的 reference 落盘成 user/message 事件后必须带 message id，
    // host readSession replay 校验（seed user/message must have data.id）拒绝该会话 →
    // re-entry 报"来源当前不可用"。普通 client 消息自带 id；host 对 listener 注入
    // 消息不补 id（dsh-agent-loop preStep 直接 append）。故注入消息必须自带合法 id
    //（node crypto.randomUUID，与 host 消息 id 同格式）。
    id: crypto.randomUUID(),
    source: notesReferenceSource(result.notes.length),
    content: [{ type: "text", text: rendered.text }],
  };
  // 注入：reference 置于**第一条** direct user 消息之前；其余消息顺序不变
  const out = [];
  let injected = false;
  list.forEach((m, i) => {
    if (!injected && direct.includes(i)) {
      out.push(referenceMessage);
      injected = true;
    }
    out.push(m);
  });
  return { kind: "inject", messages: out, noteCount: result.notes.length, directIndices: direct };
}
