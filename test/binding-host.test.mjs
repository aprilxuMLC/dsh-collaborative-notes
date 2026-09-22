// behavior regression binding-host adapter tests（node，纯逻辑，mock resolve）
// 覆盖：pending store（set/clear/has/generation）、direct-user 判定、
// planPreStep（noop / no-direct-user / inject 序 / failure all-or-nothing）、
// reference 消息形状（plugin source、置于 direct 前、direct 文本原样）。
import {
  createPendingStore,
  directUserIndices,
  planPreStep,
} from "../lib/binding-host.js";
import { makeItem, serializeItem, withItemKey, newItemKey } from "../lib/structured-item.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const SID = "session-p4e2-host-0001";
const k1 = "ik-p4e2-h1";
const userMsg = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
const snapMsg = (text) => ({ role: "user", source: { kind: "plugin", plugin: "x", form: "snapshot" }, content: [{ type: "text", text }] });

const okResolve = async () => {
  const body = serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SID, comment: "A" }), k1));
  return { ok: true, notes: [{ ordinal: 0, laneKey: "conversation_todo", projection: { type: "source-independent", authored: "A" } }] };
};
const failResolve = async () => ({ ok: false, failures: [{ ordinal: 0, laneKey: "conversation_todo", itemKey: k1, code: "UNRESOLVED", reason: "gone" }] });

console.log("== createPendingStore（case-4 generation 单调）==");
{
  const store = createPendingStore();
  ok("初始无 pending", !store.has(SID));
  ok("set targets → pending 带 generation/createdAt", store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 3).pending.generation === 3);
  ok("has → true", store.has(SID));
  ok("currentGeneration = 3", store.currentGeneration(SID) === 3);
  const got = store.get(SID);
  ok("get 返回拷贝（targets 不变更引用）", Array.isArray(got.targets) && got.targets.length === 1);
  ok("等 gen 写 → stale 拒（防重放）", store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 3).stale === true);
  ok("旧 gen 写 → stale 拒（不覆盖更新 selection）", store.set(SID, [{ laneKey: "conversation_todo", itemKey: "newer" }], 2).stale === true);
  ok("旧 gen 被拒后 pending 仍是 gen3", store.get(SID).generation === 3 && store.get(SID).targets[0].itemKey === k1);
  ok("更高 gen → 接受", store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 4).pending.generation === 4);
  // clear 也是单调写：gen5 clear
  ok("clear 后 currentGeneration 仍推进（gen5）", (store.set(SID, [], 5).cleared === true) && !store.has(SID) && store.currentGeneration(SID) === 5);
  // case-4: clear 后迟到旧 gen set 不复活
  ok("case-4: clear(gen5) 后迟到 gen3 → stale（remains clear）", store.set(SID, [{ laneKey: "x", itemKey: "y" }], 3).stale === true && !store.has(SID));
  // result generation 关联
  store.set(SID, [{ laneKey: "conversation_todo", itemKey: k1 }], 6);
  store.markInjected(SID, 1);
  ok("markInjected → injected", store.get(SID).state === "injected");
  store.confirmDurable(SID);
  ok("confirmDurable → 清 + resultGeneration=6", !store.has(SID) && store.resultGeneration(SID) === 6);
  const store2 = createPendingStore();
  ok("store 相互独立（session-scoped，无跨 holder 泄漏）", !store2.has(SID) && store2.currentGeneration(SID) === 0);
}

console.log("== directUserIndices ==");
{
  ok("识别 direct user（source.kind user）", directUserIndices([userMsg("hi")]).join(",") === "0");
  ok("忽略 plugin snapshot 上下文", directUserIndices([snapMsg("ctx"), userMsg("hi")]).join(",") === "1");
  ok("无 direct → 空", directUserIndices([snapMsg("ctx")]).length === 0);
  ok("多条 direct（罕见）全列出", directUserIndices([userMsg("a"), userMsg("b")]).join(",") === "0,1");
}

console.log("== planPreStep：noop / no-direct-user ==");
{
  const noPending = await planPreStep({ messages: [userMsg("hi")], pending: undefined, resolve: okResolve });
  ok("无 pending → noop 且 messages 原样", noPending.kind === "noop" && noPending.messages.length === 1);
  const noDirect = await planPreStep({ messages: [snapMsg("ctx")], pending: { targets: [{ laneKey: "conversation_todo", itemKey: k1 }] }, resolve: okResolve });
  ok("无 direct user → no-direct-user（不消费、不注入）", noDirect.kind === "no-direct-user" && noDirect.messages.length === 1);
}

console.log("== planPreStep：inject 序 ==");
{
  // host 真实序：claimed direct user 在前，插件 append 的上下文（runtime snapshot
  // 等）在尾部（agent-loop preStep 默认 [...claimed, context]；listener 在其上改）。
  const p = await planPreStep({
    messages: [userMsg("DIRECT 用户请求原样"), snapMsg("runtime-context-tail")],
    pending: { generation: 1, targets: [{ laneKey: "conversation_todo", itemKey: k1 }] },
    resolve: okResolve,
  });
  ok("kind=inject", p.kind === "inject");
  if (p.kind === "inject") {
    const roles = p.messages.map((m) => `${m.role}:${m.source && m.source.kind}${m.source && m.source.plugin ? ":" + m.source.plugin : ""}`);
    ok("reference 置于 direct user 之前（首元素），ctx 尾部不动", roles[0].startsWith("user:plugin:dsh-collab-notes") && roles[1] === "user:user" && roles[2] === "user:plugin:x", roles.join(" | "));
    ok("reference 消息含 content text 与 noteCount", typeof p.messages[0].content[0].text === "string" && p.messages[0].source.noteCount === 1);
    ok("direct user 文本原样保留", p.messages[1].content[0].text === "DIRECT 用户请求原样");
    ok("非 direct 消息数量不变（ctx 保留尾部）", p.messages.length === 3 && p.messages[2].content[0].text === "runtime-context-tail" && p.messages[2].source.kind === "plugin");
    ok("reference 非用户手写（plugin source，可区分渲染）", p.messages[0].source.kind === "plugin");
    // reference 一定位于第一条 direct user 之前（相对序不变量，与 ctx 位置无关）
    const directIdx = p.messages.findIndex((m) => m.source && m.source.kind === "user");
    ok("相对序：reference(index0) < direct user(index1)", directIdx === 1);
  }

  const carried = await planPreStep({
    messages: [userMsg("DIRECT")],
    pending: { generation: 2, targets: [{ laneKey: "conversation_todo", itemKey: k1 }] },
    resolve: okResolve,
    resolveCarry: ({ laneKey, itemKey }) => laneKey === "conversation_todo" && itemKey === k1 ? "session-parent-0001" : null,
  });
  ok("exact-derived source-independent reference includes one carry line", carried.kind === "inject"
    && carried.messages[0].content[0].text.split("Carried from session: session-parent-0001").length === 2);
  ok("carry line does not expose itemKey", carried.kind === "inject" && !carried.messages[0].content[0].text.includes(k1));

  const anchoredResolve = async () => ({ ok: true, notes: [{
    ordinal: 0,
    laneKey: "conversation_todo",
    projection: { type: "anchored", authored: "A", snapshot: "S", locator: { sessionId: "session-src-0001", messageId: "msg-1" } },
  }] });
  const anchoredCarried = await planPreStep({
    messages: [userMsg("DIRECT")],
    pending: { generation: 3, targets: [{ laneKey: "conversation_todo", itemKey: k1 }] },
    resolve: anchoredResolve,
    resolveCarry: () => "session-parent-0001",
  });
  ok("anchored reference remains unchanged and has no carry line", anchoredCarried.kind === "inject"
    && !anchoredCarried.messages[0].content[0].text.includes("Carried from session")
    && anchoredCarried.messages[0].content[0].text.includes("Source Anchor"));
}

console.log("== planPreStep：failure all-or-nothing ==");
{
  const f = await planPreStep({
    messages: [userMsg("DIRECT")],
    pending: { generation: 1, targets: [{ laneKey: "conversation_todo", itemKey: k1 }] },
    resolve: failResolve,
  });
  ok("resolve 失败 → kind=failure（不注入 subset）", f.kind === "failure" && f.failures.length === 1 && f.failures[0].code === "UNRESOLVED");
  ok("failure 时 messages 原样（direct 消息未被替换/不假装绑定）", f.kind === "failure" && f.messages.length === 1 && f.messages[0].content[0].text === "DIRECT");
  ok("failure 报告 noteCount（truthful：N 条未达 bound）", f.kind === "failure" && f.noteCount === 1);
}

console.log("\n结果：behavior regression binding-host adapter " + passed + " 通过 / " + failed + " 失败");
process.exit(failed === 0 ? 0 : 1);
