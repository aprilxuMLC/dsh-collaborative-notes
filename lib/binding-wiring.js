// dsh-collab-notes — pre-step binding wiring（ctx 接线层，node 可测）
//
// 把 pending store + planPreStep 接到 agent/pre-step 生命周期：
//
// 成功注入路径：
//   listener 返回 {kind:"enter", messages:[...含 reference]} 让 reference 随本 step
//   append 成 user/message 历史；但 **pending 不清、ok 不报**——store.markInjected
//   记为 in-flight。由 host 侧 ctx.on("session/event") 观察：仅 notes-reference
//   append 不确认——须等**同一 decision 的 CURRENT direct user 也 append**（配对）后
//   才 confirmDurable + onResult{ok:true}。pending 清除严格晚于完整配对 durable。
//   若 injected 超时未确认（append 前 abort/中断）→ timeout recovery：后续 direct user
//   不得 pass-through unreferenced → reject + BINDING_UNCONFIRMED_TIMEOUT（pending
//   保留）。
//
// binding failure 路径（当前保守默认）：
//   不返回 enter(原样)——那会把 claimed 作为 unreferenced request 送进模型。
//   早期 prepend("next-turn") 方案已废弃（latent：claim=head、followup=tail → 旧失败
//   请求在后续无关提交前被自动执行，真实 trace 复现 B 饿死）。rc.2 无现成
//   preserve-work affordance（无 pre-admission hook、composer 仅 admission 失败恢复
//   草稿）。**保守默认**：failure → {kind:"reject"}（宁 reject 不 latent/不
//   unreferenced），pending 保留 + onResult{ok:false,generation,failures}。最终
//   当 host 提供 preserve-work 能力时，可替换本分支。
//
// noop / no-direct-user：原样（pending 保留）。
// reject 决策（其它 listener 产生）：原样透传。
import { createPendingStore, planPreStep } from "./binding-host.js";
import { resolveBinding } from "./reference-binding.js";
import { liveSessionEvents } from "./live-session-events.js";

/** 生产 lane reader（依赖注入 fs + 路径解析；与 notes GET 同安全路径）。 */
export function makeLaneReader({ fs, readFile, resolvePath, sep, ensureInsideNotes }) {
  return async function laneReader(sessionId, cwd, laneKey) {
    const file = resolvePath(cwd, "notes", laneKey, `${sessionId}.md`);
    if (typeof ensureInsideNotes === "function") await ensureInsideNotes(file, cwd);
    const target = await fs.resolve(file, { cwd });
    let body = "";
    await fs.withLock(target.targetKey, async () => {
      try {
        body = await readFile(file, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        body = ""; // absent lane file = empty body
      }
    });
    return body;
  };
}

/**
 * 构造 pre-step listener handler（bound 到 store）。
 * @param {object} opts
 * @param {ReturnType<createPendingStore>} opts.store
 * @param {(sessionId:string, cwd:string, laneKey:string) => Promise<string>} opts.laneReader
 * @param {(sessionId:string) => string|undefined} opts.cwdOf
 * @param {(sessionId:string, r:{ok:boolean,noteCount?:number,failures?:Array}) => void} opts.onResult
 *       成功仅在 durable 确认后回调（由 confirmDurableBinding 触发）；失败在 reject 时回调。
 * @param {(input:{sessionId:string,laneKey:string,itemKey:string,item:object,projection:object}) => Promise<string|null>|string|null} [opts.resolveCarry]
 *       current-child exact derivation resolver for source-independent Notes.
 * @param {(sessionId:string) => boolean} [opts.isConfirmed]  测试钩子：当前是否已确认
 */
export function createPreStepBinding({ store, laneReader, cwdOf, onResult, resolveCarry, injectedTimeoutMs = 30000 }) {
  return async function preStepBinding({ agent }, next) {
    const decision = await next();
    if (!decision || decision.kind === "reject") return decision;
    const sessionId = agent && (agent.id ?? agent.session?.id);
    const cwd = sessionId ? cwdOf(sessionId) : undefined;
    if (!sessionId || !cwd) return decision;
    const pending = store.get(sessionId);
    if (!pending) return decision;
    // injected in-flight：已构造 reference、等 durable 配对确认。
    // **只要出现新的 direct user 请求**（无论 injected 是否
    // 超时），MUST NOT pass-through unreferenced → reject。超时只影响 failure 分类
    // （BINDING_UNCONFIRMED_TIMEOUT vs BINDING_UNCONFIRMED_IN_FLIGHT），不影响
    // "新 direct 不得绕过未决 binding"的不变式。同 turn 后续 step（无 direct user，
    // 如多 step 工具轮）仍正常 pass-through——那是同一已注入轮的延续，不产生新
    // unreferenced 请求。
    if (pending.state === "injected") {
      const directIndices = directUserIndicesOf(decision.messages);
      if (directIndices.length > 0) {
        const timedOut = !(pending.injectedAt && Date.now() - pending.injectedAt <= injectedTimeoutMs);
        const code = timedOut ? "BINDING_UNCONFIRMED_TIMEOUT" : "BINDING_UNCONFIRMED_IN_FLIGHT";
        onResult?.(sessionId, {
          ok: false,
          noteCount: pending.noteCount ?? 1,
          generation: pending.generation,
          failures: [{ code, reason: "a prior injected reference was never durably confirmed; this new direct request is rejected rather than submitted unreferenced (selection retained)" }],
        });
        return { kind: "reject" };
      }
      return decision; // 无新 direct（同 turn 后续 step）：正常延续，pass-through
    }
    const resolve = async (targets) => {
      const lanes = [...new Set(targets.map((t) => t.laneKey))];
      const bodies = {};
      for (const laneKey of lanes) {
        try {
          bodies[laneKey] = await laneReader(sessionId, cwd, laneKey);
        } catch (e) {
          return { ok: false, failures: [{ code: "LANE_READ_FAILED", reason: String((e && e.message) || e) }] };
        }
      }
      return resolveBinding(bodies, targets);
    };
    const plan = await planPreStep({
      messages: decision.messages,
      pending,
      resolve,
      resolveCarry: resolveCarry
        ? (input) => resolveCarry({ ...input, sessionId })
        : undefined,
    });
    if (plan.kind === "inject") {
      // 不立即 clear/ok——reference 尚未 append。markInjected 后由 host 的
      // session/event 观测在 reference + CURRENT direct 配对 append 后 confirm。
      // 注入时从 agent.session 的**权威事件快照**
      // 读取末尾 seq 作为基线；reference 只有 seq > 基线才可能是本次注入的产物。
      // **无 events 视图/不可靠时不得把基线当作有效 0**（baselineReliable=false →
      // host 侧不 arm、宁保持 pending，不做无证据配对）。
      let baselineSeq = null;
      let baselineReliable = false;
      try {
        const evs = liveSessionEvents(agent?.session);
        if (Array.isArray(evs) && evs.length > 0) {
          const last = evs[evs.length - 1];
          if (last && Number.isSafeInteger(last.seq)) {
            baselineSeq = last.seq;
            baselineReliable = true;
          }
        }
      } catch { baselineSeq = null; baselineReliable = false; }
      store.markInjected(sessionId, plan.noteCount, baselineSeq, baselineReliable);
      return { kind: "enter", messages: plan.messages };
    }
    if (plan.kind === "failure") {
      // binding 失败不得降级为 unreferenced model request。
      // (2026-09-05)：prepend("next-turn") 导致 latent（旧失败请求在后续提交前被自动
      // 执行，真实 trace 复现 B 饿死）→ 废弃。rc.2 无现成 preserve-work affordance
      // （无 pre-admission hook、composer 仅在 admission 失败时恢复草稿）→ STOP 报告
      // 保守默认：**不 prepend**、reject
      // （宁丢文本不 latent/不 unreferenced）、pending 保留 + lastBinding failure。
      onResult?.(sessionId, { ok: false, noteCount: plan.noteCount, generation: pending.generation, failures: plan.failures });
      return { kind: "reject" };
    }
    return decision; // noop / no-direct-user：原样（pending 保留）
  };
}

function directUserIndicesOf(messages) {
  return (Array.isArray(messages) ? messages : []).flatMap((m, i) => (m && m.source && m.source.kind === "user" ? [i] : []));
}

/**
 * durable 确认入口（host 在 ctx.on("session/event") 观测到 notes-reference append 后
 * 调用）。pending 为 injected 态 → clear + onResult ok。
 * @returns {boolean} 是否确认并清除
 */
export function confirmDurableBinding({ store, onResult }, sessionId) {
  const p = store.get(sessionId);
  if (!p || p.state !== "injected") return false;
  const generation = p.generation;
  store.confirmDurable(sessionId);
  onResult?.(sessionId, { ok: true, noteCount: p.noteCount ?? 1, generation });
  return true;
}

export { createPendingStore };
