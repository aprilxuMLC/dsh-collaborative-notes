// behavior regression pre-step wiring tests（node，mock ctx/agent/next/laneReader）
// 覆盖 lifecycle：成功注入→清 pending + lastBinding ok；失败→保留 pending +
// lastBinding failure（truthful）；无 pending→原样；无 direct→不消费；reject 决策
// →原样透传；lane 读失败→failure；跨 session 隔离；injected in-flight 下同轮
// 无 direct 延续 pass-through（不重复注入）；injected（无论超时与否）+
// 后续 direct → MUST reject（BINDING_UNCONFIRMED_IN_FLIGHT / _TIMEOUT），pending
// 保留、reject 不清已注入 binding；成功绑定后历史中 reference 被动（不自动重读）。
import {
  createPreStepBinding,
  confirmDurableBinding,
  createPendingStore,
} from "../lib/binding-wiring.js";
import { makeItem, serializeItem, withItemKey, newItemKey } from "../lib/structured-item.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const SID = "session-p4e2-wire-0001";
const SID2 = "session-p4e2-wire-0002";
const CWD = "/ws";
const k1 = "ik-p4e2-w1";
const userMsg = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
// 无 direct user 的后续 step 消息（如多 step 工具轮的 tool result claim）
const toolMsg = (text) => ({ role: "tool", source: { kind: "tool" }, content: [{ type: "text", text }] });

function makeItemBody(comment, key = k1) {
  return serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SID, comment }), key));
}
function makeEnv({ laneBodies = {}, failLane = null } = {}) {
  const store = createPendingStore();
  const reads = [];
  const results = [];
  const prepended = [];
  const laneReader = async (sessionId, cwd, laneKey) => {
    reads.push({ sessionId, cwd, laneKey });
    if (failLane === laneKey) throw new Error("boom-read");
    return laneBodies[laneKey] ?? "";
  };
  const cwdOf = (sessionId) => (sessionId === SID || sessionId === SID2 ? CWD : undefined);
  const handler = createPreStepBinding({ store, laneReader, cwdOf, onResult: (sid, r) => results.push({ sid, ...r }) });
  const confirm = (sid) => confirmDurableBinding({ store, onResult: (s, r) => results.push({ sid: s, ...r }) }, sid);
  const agentOf = (sid) => ({ id: sid, session: { id: sid, header: { cwd: CWD } }, inbox: { prepend: (t, m) => prepended.push({ t, m }) } });
  return { store, reads, results, prepended, handler, confirm, agentOf };
}
const nextEnter = async (messages) => ({ kind: "enter", messages });
const agentOf = (sid) => ({ id: sid, session: { id: sid, header: { cwd: CWD } } });

console.log("== 成功注入：enter + injected（case-2：不清 pending、不报 ok 直到 durable confirm）==");
{
  const env = makeEnv({ laneBodies: { conversation_todo: makeItemBody("A") } });
  env.store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 1);
  const out = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("DIRECT 请解释")]));
  ok("kind=enter", out && out.kind === "enter");
  ok("messages = [reference(plugin), direct(user)]", out.messages.length === 2 && out.messages[0].source.kind === "plugin" && out.messages[0].source.plugin === "dsh-collab-notes" && out.messages[1].source.kind === "user");
  ok("direct 文本原样", out.messages[1].content[0].text === "DIRECT 请解释");
  ok("case-2: 注入构造后 pending 仍在（injected 态，未清）", env.store.get(SID) && env.store.get(SID).state === "injected");
  ok("case-2: 构造后无 lastBinding ok（未 durable 确认）", env.results.length === 0);
  // durable 确认（session/event append 观测）后才清 + ok
  const confirmed = env.confirm(SID);
  ok("case-2: durable confirm 成功", confirmed === true);
  ok("case-2: confirm 后 pending 清空", !env.store.has(SID));
  ok("case-2: confirm 后 lastBinding ok + noteCount=1", env.results.length === 1 && env.results[0].ok === true && env.results[0].noteCount === 1);
}

console.log("== case-2 防误清：injected 未 confirm 前，同轮后续 pre-step（无 direct）不重复注入/不误清 ==");
{
  const env = makeEnv({ laneBodies: { conversation_todo: makeItemBody("A") } });
  env.store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 1);
  const o1 = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("d1")]));
  ok("第一次注入（2 messages）", o1.messages.length === 2);
  ok("pending 仍 injected", env.store.get(SID) && env.store.get(SID).state === "injected");
  // 同轮后续 step（多 step 工具轮）的 claim 无 direct user → 原样延续（不重复注入、不误清）
  const o2 = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([toolMsg("tool-result-1")]));
  ok("无 direct 的后续 pre-step 原样 1 message（不重复注入）", o2.messages.length === 1 && o2.messages[0].content[0].text === "tool-result-1");
  ok("pending 未误清（仍 injected）", env.store.get(SID) && env.store.get(SID).state === "injected");
  env.confirm(SID);
  ok("confirm 后 pending 清空", !env.store.has(SID));
}

console.log("== injected 未超时 + 后续 direct user → MUST reject（无论超时与否，新 direct 不得绕过未决 binding）==");
{
  const env = makeEnv({ laneBodies: { conversation_todo: makeItemBody("A") } });
  env.store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 1);
  const o1 = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("d1")]));
  ok("第一次注入（injected，未超时窗口内）", o1.kind === "enter" && env.store.get(SID).state === "injected");
  // 未 _forceStaleInjected → 未超时；仍必须 reject（不受 timeout 影响）
  const o2 = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("d2")]));
  ok("kind=reject", o2 && o2.kind === "reject");
  ok("failure 记录 BINDING_UNCONFIRMED_IN_FLIGHT", env.results.some((r) => r.ok === false && r.failures && r.failures[0].code === "BINDING_UNCONFIRMED_IN_FLIGHT"));
  ok("pending 保留（selection 不丢，injected 态不清）", env.store.get(SID) && env.store.get(SID).state === "injected");
  // d1 的注入仍可 durable confirm（配对成功 → 清 + ok）；reject d2 不得清掉 d1 的 binding
  const confirmed = env.confirm(SID);
  ok("d1 durable confirm 仍成功（reject d2 不清 d1 pending）", confirmed === true && !env.store.has(SID));
}

console.log("== 绑定失败（deleted）：case-1 保守 reject（不放回——latent 废弃；不降级 unreferenced）==");
{
  const env = makeEnv({ laneBodies: { conversation_todo: makeItemBody("A") } });
  env.store.set(SID, [{ laneKey: "conversation_todo", itemKey: "ik-missing" }], 1);
  const out = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("DIRECT")]));
  ok("case-1: kind=reject（阻止 unreferenced model call）", out && out.kind === "reject");
  ok("case-1: 不放回 inbox（无 latent 自动执行；不会自动 prepend）", env.prepended.length === 0);
  ok("case-1: pending 保留（selection 不丢）", env.store.has(SID));
  ok("case-1: lastBinding failure 带 failures（truthful）", env.results.length === 1 && env.results[0].ok === false && env.results[0].failures && env.results[0].failures[0].code === "UNRESOLVED");
}

console.log("== case-3 recovery：injected 超时未确认 → 后续 direct 不得 pass-through unreferenced ==");
{
  const env = makeEnv({ laneBodies: { conversation_todo: makeItemBody("A") } });
  env.store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 1);
  // 第一次注入 → injected（不确认）
  const o1 = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("d1")]));
  ok("第一次注入（enter, injected）", o1.kind === "enter" && env.store.get(SID).state === "injected");
  // 模拟超时（把 injectedAt 推到过去）
  env.store._forceStaleInjected(SID);
  // 后续 direct user pre-step：不得 pass-through unreferenced → reject + failure
  const o2 = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("d2")]));
  ok("case-3: injected 超时 + 后续 direct → reject（不 silent unreferenced）", o2.kind === "reject");
  ok("case-3: failure 记录 BINDING_UNCONFIRMED_TIMEOUT", env.results.some((r) => r.ok === false && r.failures && r.failures[0].code === "BINDING_UNCONFIRMED_TIMEOUT"));
  ok("case-3: pending 保留（未静默清）", env.store.has(SID));
}

console.log("== lane 读失败 → case-1 reject + failure（不静默）==");
{
  const env = makeEnv({ failLane: "deferred_work" });
  env.store.set(SID, [{ laneKey: "deferred_work", itemKey: k1 }], 1);
  const out = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("D")]));
  ok("kind=reject + failure 记录 LANE_READ_FAILED + pending 保留", out.kind === "reject" && env.results[0].ok === false && env.results[0].failures[0].code === "LANE_READ_FAILED" && env.store.has(SID));
}

console.log("== 无 pending / 无 direct / reject 透传 / 跨 session ==");
{
  const env = makeEnv({ laneBodies: { conversation_todo: makeItemBody("A") } });
  const noPending = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([userMsg("hi")]));
  ok("无 pending → 原样", noPending.messages.length === 1);

  env.store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 1);
  const snapOnly = await env.handler({ agent: env.agentOf(SID) }, () => nextEnter([{ role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "ctx" }] }]));
  ok("无 direct user → 原样且 pending 未消费", snapOnly.messages.length === 1 && env.store.has(SID));

  const rejected = await env.handler({ agent: env.agentOf(SID) }, () => Promise.resolve({ kind: "reject" }));
  ok("决策 reject → 透传 reject", rejected && rejected.kind === "reject" && env.store.has(SID));

  // 跨 session：SID2 无 pending → 原样（不串 holder）
  const s2 = await env.handler({ agent: env.agentOf(SID2) }, () => nextEnter([userMsg("other-holder")]));
  ok("其它 session 不消费 SID 的 pending", s2.messages.length === 1 && s2.messages[0].content[0].text === "other-holder");
}

console.log("== 无 cwd（session 不可见）→ 不处理 ==");
{
  const store = createPendingStore();
  const laneReader = async () => "";
  const handler = createPreStepBinding({ store, laneReader, cwdOf: () => undefined });
  store.set("session-ghost-0001", [{ laneKey: "conversation_todo", itemKey: k1 }], 1);
  const out = await handler({ agent: { id: "session-ghost-0001" } }, () => nextEnter([userMsg("hi")]));
  ok("cwd 不可得 → 原样且 pending 保留", out.messages.length === 1 && store.has("session-ghost-0001"));
}

console.log("\n结果：behavior regression pre-step wiring " + passed + " 通过 / " + failed + " 失败");
process.exit(failed === 0 ? 0 : 1);
