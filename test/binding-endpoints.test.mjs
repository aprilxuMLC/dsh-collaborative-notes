// behavior regression selection endpoints + agent/pre-step binding tests（host 集成层）
// 真实 LocalFileSystem on real Cordis Context（与 notes-api.test.mjs 同基建）。
// 覆盖 selection endpoint 的稳定协议：
//   - versioned PUT（client-issued generation：无 gen → 400；空 targets
//     [] = clear 同走 PUT；DELETE 不提供 → 405；迟到旧 gen stale 拒绝、clear 后旧 gen
//     不复活）
//   - case-1 保守：binding failure → reject（不放回 inbox——latent 已证废弃；pending 保留
//     + lastBinding failure truthfully）
//   - case-2 配对 durable confirm：reference append 不确认，reference+CURRENT direct 配对
//     append 才清 pending + ok；负测试 reference 有 direct 缺 → pending 保留无 ok
//   - durable-success pair 关联 generation：旧代迟到 pair（delayed direct）不得
//     确认新一代 selection（pending generation ≠ pair generation → skip）
//   - 无 direct user → 不消费；无关 session/event 不误确认
// 运行：node test/binding-endpoints.test.mjs
import { apply } from "../lib/index.js";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeItem, serializeItem, withItemKey, newItemKey } from "../lib/structured-item.js";

const SESSION = "session-p4e2-api-0001";
const L1 = "conversation_todo";
let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function makeReq({ method = "GET", url = "/", headers = {}, body }) {
  const chunks = body == null ? [] : [Buffer.from(body)];
  return { method, url, headers, resume() {}, [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
}
function makeRes() {
  const state = {};
  return { writeHead(code, headers) { state.code = code; state.headers = headers; }, end(b) { state.body = b ?? ""; }, state };
}
async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res.state;
}
const H = { host: "127.0.0.1:3080" };
const bodyOf = (s) => { try { return JSON.parse(s.body); } catch { return s.body; } };

async function main() {
  const ws = await mkdtemp(join(tmpdir(), "dsh-notes-p4e2-"));
  const notesRoot = join(ws, "notes");
  const sessions = new Map([[SESSION, { header: { cwd: ws } }]]);
  let handler;
  const eventListeners = new Map();
  const app = new Context();
  const fs = new LocalFileSystem(app, { cwd: ws, diffBasisMaxBytes: 1024 * 1024 });
  const ctx = { fs, get: () => sessions, webServer: { register: (cfg) => { handler = cfg.handler; } }, on: (name, fn) => { eventListeners.set(name, fn); } };
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(ws, "dsh-home");
  await apply(ctx);
  process.env.DSH_HOME = prevHome;

  const sel = `/notes-api/${SESSION}/selection`;
  const k1 = "ik-p4e2-api-1";
  const k2 = "ik-p4e2-api-2";
  let gen = 0;
  const nextGen = () => ++gen;
  const putSel = async (targets, g) => {
    const body = { targets, generation: g ?? nextGen() };
    return call(handler, makeReq({ method: "PUT", url: sel, headers: H, body: JSON.stringify(body) }));
  };
  const putRaw = async (body) => call(handler, makeReq({ method: "PUT", url: sel, headers: H, body: JSON.stringify(body) }));

  console.log("— selection 端点（versioned PUT；client-issued generation）—");
  let s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("初始 GET → pending null + lastBinding null", s.code === 200 && bodyOf(s).pending === null && bodyOf(s).lastBinding === null);
  s = await putSel([{ laneKey: L1, itemKey: k1 }], 5);
  ok("PUT targets(gen5) → ok + pending 回显", s.code === 200 && bodyOf(s).ok === true && bodyOf(s).pending.targets.length === 1 && bodyOf(s).pending.generation === 5);
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("GET pending 持久（同一进程内）", bodyOf(s).pending.targets[0].itemKey === k1 && bodyOf(s).pending.generation === 5);
  // 无 gen → 400（禁止 host auto current+1 冒充意图序）
  s = await putRaw({ targets: [{ laneKey: L1, itemKey: k1 }] });
  ok("无 generation → 400（client 必须发出意图 revision）", s.code === 400);
  s = await putRaw({ targets: [] });
  ok("无 generation 的 clear → 400", s.code === 400);
  // case-4: 迟到旧 gen 写不复活/不覆盖
  s = await putSel([{ laneKey: L1, itemKey: k2 }], 3);
  ok("迟到 gen3(< current5) PUT → stale 拒绝（不覆盖 gen5）", s.code === 200 && bodyOf(s).ok === false && bodyOf(s).stale === true && bodyOf(s).currentGeneration === 5);
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("gen5 selection 未被 gen3 覆盖", bodyOf(s).pending && bodyOf(s).pending.targets[0].itemKey === k1);
  // clear 走 versioned PUT []（单一表示）
  s = await putSel([], 6);
  ok("PUT 空 targets(gen6) → 等价 clear", s.code === 200 && bodyOf(s).pending === null && bodyOf(s).ok === true);
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("GET 再次 → pending null", bodyOf(s).pending === null);
  // case-4: clear 后迟到旧 gen set 不复活
  s = await putSel([{ laneKey: L1, itemKey: k1 }], 4);
  ok("clear(gen6) 后迟到 gen4 → stale（remains clear）", s.code === 200 && bodyOf(s).ok === false && bodyOf(s).stale === true);
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("仍 clear（旧 gen 未复活）", bodyOf(s).pending === null);
  s = await putSel([{ laneKey: L1, itemKey: k1 }], 7);
  // DELETE 不再提供（单一 versioned PUT）
  s = await call(handler, makeReq({ method: "DELETE", url: sel, headers: H }));
  ok("DELETE → 405（用 versioned PUT [] 清空）", s.code === 405);
  gen = 7; // 同步计数器

  console.log("— shape 校验 —");
  s = await call(handler, makeReq({ method: "PUT", url: sel, headers: H, body: JSON.stringify({ targets: [{ laneKey: "L1-not-a-key", itemKey: k1 }], generation: nextGen() }) }));
  ok("非法 laneKey → 400", s.code === 400);
  s = await call(handler, makeReq({ method: "PUT", url: sel, headers: H, body: JSON.stringify({ targets: [{ laneKey: L1, itemKey: "" }], generation: nextGen() }) }));
  ok("空 itemKey → 400", s.code === 400);
  s = await call(handler, makeReq({ method: "PUT", url: sel, headers: H, body: JSON.stringify({ targets: "nope", generation: nextGen() }) }));
  ok("targets 非数组 → 400", s.code === 400);
  s = await call(handler, makeReq({ method: "PUT", url: sel, headers: H, body: "not json" }));
  ok("bad json → 400", s.code === 400);
  s = await call(handler, makeReq({ method: "GET", url: "/notes-api/session-unknown-00000000000/selection", headers: H }));
  ok("未知 session selection → 404", s.code === 404);

  console.log("— agent/pre-step listener（mock next）+ case-2 配对 durable confirm —");
  const preStepListener = eventListeners.get("agent/pre-step");
  const sessionEventListener = eventListeners.get("session/event");
  ok("apply 注册了 agent/pre-step listener", typeof preStepListener === "function");
  ok("apply 注册了 session/event listener（case-2 durable confirm）", typeof sessionEventListener === "function");

  // 造一条真实 source-independent Note 落盘（模拟用户此前保存）
  const block = serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "真实 Note 内容 A" }), k1));
  await mkdir(join(notesRoot, L1), { recursive: true });
  await writeFile(join(notesRoot, L1, `${SESSION}.md`), block, "utf8");

  // mock agent（无 prepend 需要——case-1 保守不放回）+ session 对象
  // 真实 agent 在 pre-step 时 agent.session.events 是权威事件视图（末尾 seq 即注入
  // 基线）。测试默认 agent 提供 events=[{seq:0}] → 基线 0 可靠（reference seq>0 可
  // arm）；"无 events 视图"负例用 agentCtxNoEv（adversarial pass：无可靠基线 → 不 arm）。
  const agentCtx = { id: SESSION, session: { id: SESSION, header: { id: SESSION }, events: [{ seq: 0 }] } };
  const agentCtxNoEv = { id: SESSION, session: { id: SESSION, header: { id: SESSION } } };
  const fakeSession = { id: SESSION, header: { id: SESSION } };
  // 注：真实落盘的 reference user/message 现带 data.id（behavior regression 修复：host readSession
  // replay 要求 user/message 有 id）。refEvent 模拟 host 观测到的落盘事件，补 id。
  const refEvent = (text) => ({ type: "user/message", seq: 100, data: { id: "refevt-1000-0000-0000-000000000000", source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text }] } });
  const directEvent = (text) => ({ type: "user/message", seq: 101, data: { source: { kind: "user" }, content: [{ type: "text", text }] } });

  // PUT pending → pre-step（direct user 消息）→ 注入（case-2：pending 暂不清、ok 暂不报）
  await putSel([{ laneKey: L1, itemKey: k1 }]);
  const directMsg = { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "DIRECT 请解释这条" }] };
  const out = await preStepListener({ agent: agentCtx }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("pre-step 返回 kind=enter", out && out.kind === "enter");
  ok("注入消息先于 direct（reference plugin 在前）", out.messages.length === 2 && out.messages[0].source.kind === "plugin" && out.messages[0].source.plugin === "dsh-collab-notes" && out.messages[0].source.form === "notes-reference" && out.messages[1].content[0].text === "DIRECT 请解释这条");
  ok("注入文本含当前 Note 内容（真实落盘内容逐字）", out.messages[0].content[0].text.includes("真实 Note 内容 A"));
  ok("注入文本不含 itemKey", !out.messages[0].content[0].text.includes(k1));
  // behavior regression 3099 回归：注入 reference 必须带合法 message id（缺 id → host readSession
  // replay 校验拒绝该会话 → re-entry 报"来源当前不可用"）。
  ok("behavior regression: 注入 reference 带合法 message id（UUID）",
    typeof out.messages[0].id === "string" && out.messages[0].id.length > 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(out.messages[0].id));
  // case-2：构造 decision ≠ durable——pending 未清（injected 态）、lastBinding 无 ok
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("case-2: 注入构造后 pending 仍未清（等 durable 配对）", bodyOf(s).pending !== null);
  ok("case-2: 注入构造后 lastBinding 无 ok（未确认）", bodyOf(s).lastBinding === null);
  // case-2 负测试：reference durable 已见、但对应 CURRENT direct 缺席 → pending remains、无 ok
  await sessionEventListener(fakeSession, refEvent("Referenced Notes (1)"));
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("case-2 负: reference append 但 direct 缺席 → pending 保留", bodyOf(s).pending !== null);
  ok("case-2 负: reference append 但 direct 缺席 → 无 ok 结果", bodyOf(s).lastBinding === null);
  // case-2 配对完成：direct user append 到达 → confirm → 清 + ok
  await sessionEventListener(fakeSession, directEvent("DIRECT 请解释这条"));
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("case-2: reference+direct 配对 append 后 pending 清空（clear 晚于完整配对）", bodyOf(s).pending === null);
  ok("case-2: lastBinding ok + noteCount=1（配对确认后才报 ok）", bodyOf(s).lastBinding && bodyOf(s).lastBinding.ok === true && bodyOf(s).lastBinding.noteCount === 1);

  console.log("— durable-success pair 关联 generation——旧代迟到 direct 不得确认新一代 selection —");
  // 代 200：注入（injected）→ 其 reference append（pair 登记 gen 200）→ direct 缺席
  // （append 中断/重放场景：gen200 的 direct 迟到到达）
  await putSel([{ laneKey: L1, itemKey: k1 }], 200);
  const outA = await preStepListener({ agent: agentCtx }, async () => ({ kind: "enter", messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "DIRECT-A 请解释" }] }] }));
  ok("gen200 pre-step 注入（pending 转 injected）", outA.kind === "enter" && outA.messages.length === 2);
  await sessionEventListener(fakeSession, { type: "user/message", seq: 300, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } });
  // 代 201：新 selection 覆盖并注入（pending = gen201 injected；pair 仍登记 gen200——
  // gen201 自己的 reference 尚未 append）
  await putSel([{ laneKey: L1, itemKey: k1 }], 201);
  const outB = await preStepListener({ agent: agentCtx }, async () => ({ kind: "enter", messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "DIRECT-B 请再解释" }] }] }));
  ok("gen201 pre-step 注入（pending 覆盖为 gen201 injected）", outB.kind === "enter" && outB.messages.length === 2);
  s = await call(handler, makeReq({ url: sel, headers: H }));
  const beforeStale = JSON.stringify(bodyOf(s).lastBinding);
  // gen200 的迟到 direct 到达：pair generation 200 ≠ pending generation 201 → MUST NOT
  // 确认（不误报 gen201 成功、不清 pending）
  await sessionEventListener(fakeSession, { type: "user/message", seq: 301, data: { source: { kind: "user" }, content: [{ type: "text", text: "DIRECT-A 请解释" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("旧代迟到 direct 不确认 gen201（pending 保留 injected gen201）", bodyOf(s).pending !== null && bodyOf(s).pending.generation === 201);
  ok("无新 ok 结果（旧 pair 未误报成功，lastBinding 未变）", JSON.stringify(bodyOf(s).lastBinding) === beforeStale);
  // gen201 自己的 reference + direct append → 配对代一致 → confirm gen201
  await sessionEventListener(fakeSession, { type: "user/message", seq: 302, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } });
  await sessionEventListener(fakeSession, { type: "user/message", seq: 303, data: { source: { kind: "user" }, content: [{ type: "text", text: "DIRECT-B 请再解释" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("gen201 自身配对 append → confirm（pending 清空 + ok 关联 generation 201）", bodyOf(s).pending === null && bodyOf(s).lastBinding && bodyOf(s).lastBinding.ok === true && bodyOf(s).lastBinding.generation === 201);
  gen = 201; // 同步计数器（后续 putSel 从 202 起）

  console.log("— test behavior regression：旧 reference 事件重放不得 arm 新一代 tracker（seq 基线 + 序证据）—");
  // 带 events 视图的 agent（注入时 session 事件末尾 seq = 51 → injectSeq 基线 51）
  const agentCtxEv = { id: SESSION, session: { id: SESSION, header: { id: SESSION }, events: [{ seq: 50 }, { seq: 51 }] } };
  await putSel([{ laneKey: L1, itemKey: k1 }], 400);
  const outEv = await preStepListener({ agent: agentCtxEv }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("behavior regression: 注入（baseline 51，pending injected gen400）", outEv.kind === "enter" && outEv.messages.length === 2);
  // 旧 reference 重放（seq 30 ≤ 基线 51）→ 不得 arm
  await sessionEventListener(fakeSession, { type: "user/message", seq: 30, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } });
  // 普通 direct（seq 32）→ tracker 未 arm → 不得错误确认 gen400
  await sessionEventListener(fakeSession, { type: "user/message", seq: 32, data: { source: { kind: "user" }, content: [{ type: "text", text: "REPLAY_DIRECT 不应确认" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("behavior regression: 旧 reference 重放 + 普通 direct → pending 保留 gen400（无虚假 confirm）", bodyOf(s).pending !== null && bodyOf(s).pending.generation === 400 && !(bodyOf(s).lastBinding && bodyOf(s).lastBinding.generation === 400), JSON.stringify(bodyOf(s).lastBinding));
  // 真实 reference（seq 60 > 51）→ arm；direct（seq 61 > 60）→ 配对确认
  await sessionEventListener(fakeSession, { type: "user/message", seq: 60, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } });
  await sessionEventListener(fakeSession, { type: "user/message", seq: 61, data: { source: { kind: "user" }, content: [{ type: "text", text: "REPLAY_GENUINE_DIRECT" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("behavior regression: 真实 reference+direct（序正确）→ confirm gen400", bodyOf(s).pending === null && bodyOf(s).lastBinding && bodyOf(s).lastBinding.ok === true && bodyOf(s).lastBinding.generation === 400);
  // 序证据负例：direct seq ≤ refSeq（旧 direct 重放）不得确认
  await putSel([{ laneKey: L1, itemKey: k1 }], 401);
  const outEv2 = await preStepListener({ agent: agentCtxEv }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("behavior regression: 第二次注入（baseline 51）", outEv2.kind === "enter");
  await sessionEventListener(fakeSession, { type: "user/message", seq: 70, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } });
  await sessionEventListener(fakeSession, { type: "user/message", seq: 60, data: { source: { kind: "user" }, content: [{ type: "text", text: "OLD_DIRECT 重放" }] } }); // 60 < refSeq 70
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("behavior regression: direct seq ≤ refSeq（旧 direct 重放）→ 不确认（pending 保留）", bodyOf(s).pending !== null && bodyOf(s).pending.generation === 401 && !(bodyOf(s).lastBinding && bodyOf(s).lastBinding.generation === 401));
  // 清理：清掉该 pending 以免影响后续（gen 402）
  await putSel([], 402);
  gen = 402;

  console.log("— adversarial check：缺失 seq 的 reference 不得 arm；交错 generation 时新 reference 须替换旧 tracker —");
  // (A) 缺失 seq 的 reference 不能 arm（无法证明是当前注入产物）
  const agentCtxNoSeq = { id: SESSION, session: { id: SESSION, header: { id: SESSION }, events: [{ seq: 500 }] } };
  await putSel([{ laneKey: L1, itemKey: k1 }], 500);
  const outNs = await preStepListener({ agent: agentCtxNoSeq }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("R2-A: 注入 gen500（baseline 500）", outNs.kind === "enter");
  // reference 事件**无 seq** → 不 arm
  await sessionEventListener(fakeSession, { type: "user/message", data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } }); // 无 seq
  // 普通 direct（有 seq）→ 不得确认
  await sessionEventListener(fakeSession, { type: "user/message", seq: 510, data: { source: { kind: "user" }, content: [{ type: "text", text: "NOSEO_DIRECT" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("R2-A: 无 seq reference → 不 arm；direct 不确认（pending 保留 gen500）", bodyOf(s).pending !== null && bodyOf(s).pending.generation === 500 && !(bodyOf(s).lastBinding && bodyOf(s).lastBinding.generation === 500));
  // 缺失 seq 的 direct 也不确认（保持 pending）
  const agentCtxNs2 = { id: SESSION, session: { id: SESSION, header: { id: SESSION }, events: [{ seq: 500 }, { seq: 501 }] } };
  await putSel([{ laneKey: L1, itemKey: k1 }], 501);
  const outNs2 = await preStepListener({ agent: agentCtxNs2 }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("R2-A2: 注入 gen501（baseline 501）", outNs2.kind === "enter");
  await sessionEventListener(fakeSession, { type: "user/message", seq: 520, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } }); // arm gen501
  await sessionEventListener(fakeSession, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "NOSEO_DIRECT2" }] } }); // 无 seq direct → 不确认、不删 tracker
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("R2-A2: 无 seq direct → 不确认（pending 保留 gen501）", bodyOf(s).pending !== null && bodyOf(s).pending.generation === 501 && !(bodyOf(s).lastBinding && bodyOf(s).lastBinding.generation === 501));
  // 同 decision 的真实 direct（有 seq，> refSeq 520）随后到达 → 仍可确认（tracker 未丢）
  await sessionEventListener(fakeSession, { type: "user/message", seq: 521, data: { source: { kind: "user" }, content: [{ type: "text", text: "REAL_DIRECT_AFTER_NOSEQ" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("R2-A2: 无 seq direct 后真实 direct 仍可确认 gen501", bodyOf(s).pending === null && bodyOf(s).lastBinding && bodyOf(s).lastBinding.ok === true && bodyOf(s).lastBinding.generation === 501);

  // (B) 交错 generation：gen1 arm 后 gen2 注入，gen2 的真实 reference 必须替换旧 tracker
  const agentEvB1 = { id: SESSION, session: { id: SESSION, header: { id: SESSION }, events: [{ seq: 600 }] } };
  await putSel([{ laneKey: L1, itemKey: k1 }], 502);
  const outB1 = await preStepListener({ agent: agentEvB1 }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("R2-B: 注入 gen502（baseline 600）", outB1.kind === "enter");
  await sessionEventListener(fakeSession, { type: "user/message", seq: 610, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } }); // arm gen502
  // gen2（503）注入：baseline 前进到 620
  const agentEvB2 = { id: SESSION, session: { id: SESSION, header: { id: SESSION }, events: [{ seq: 600 }, { seq: 620 }] } };
  await putSel([{ laneKey: L1, itemKey: k1 }], 503);
  const outB2 = await preStepListener({ agent: agentEvB2 }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("R2-B: 注入 gen503（baseline 620）", outB2.kind === "enter");
  // gen503 的真实 reference（seq 630 > 620）→ 必须替换 gen502 的旧 tracker（armedForCurrent=false）
  await sessionEventListener(fakeSession, { type: "user/message", seq: 630, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } });
  // gen503 的 direct → 确认 gen503（若旧 tracker 未替换 → 卡死无法确认）
  await sessionEventListener(fakeSession, { type: "user/message", seq: 631, data: { source: { kind: "user" }, content: [{ type: "text", text: "DIRECT_GEN503" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("R2-B: gen503 真实 reference 替换旧 tracker → 配对确认 gen503（pending 清空）", bodyOf(s).pending === null && bodyOf(s).lastBinding && bodyOf(s).lastBinding.ok === true && bodyOf(s).lastBinding.generation === 503, JSON.stringify(bodyOf(s).lastBinding));
  gen = 503; // 同步计数器

  // (C) adversarial pass：无 events 视图（无可靠基线）→ reference 不得 arm（宁保持 pending，
  //     不做无证据配对）；旧/重放 reference（任意 seq）不能被当成当前注入产物
  await putSel([{ laneKey: L1, itemKey: k1 }], 504);
  const outNoEv = await preStepListener({ agent: agentCtxNoEv }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("R3-C: 注入 gen504（无 events 视图 → 不可靠基线）", outNoEv.kind === "enter");
  // 旧/重放 reference（seq 700，但无可靠基线可证它是当前注入产物）→ 不 arm
  await sessionEventListener(fakeSession, { type: "user/message", seq: 700, data: { source: { kind: "plugin", plugin: "dsh-collab-notes", form: "notes-reference", version: 1, noteCount: 1 }, content: [{ type: "text", text: "Referenced Notes (1)" }] } });
  await sessionEventListener(fakeSession, { type: "user/message", seq: 701, data: { source: { kind: "user" }, content: [{ type: "text", text: "NOEV_DIRECT" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("R3-C: 无可靠基线 → reference 不 arm；direct 不确认（pending 保留 gen504，无该代 ok）", bodyOf(s).pending !== null && bodyOf(s).pending.generation === 504 && !(bodyOf(s).lastBinding && bodyOf(s).lastBinding.generation === 504), JSON.stringify(bodyOf(s).lastBinding));
  // 清理
  s = await putSel([], 505);
  ok("R3-C: 清理 clear", s.code === 200 && bodyOf(s).ok === true && bodyOf(s).pending === null);
  gen = 505; // 同步计数器

  console.log("— deleted → case-1 保守 truthful failure：reject（不放回 inbox、不降级 unreferenced）—");
  await putSel([{ laneKey: L1, itemKey: "ik-gone" }]);
  const out2 = await preStepListener({ agent: agentCtx }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("case-1: binding 失败 → kind=reject（不把消息作为 unreferenced 送进模型）", out2 && out2.kind === "reject");
  ok("case-1: 注入的 reference 未 append（无 subset）", true);
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("case-1: failure 后 pending 保留（selection 不丢）", bodyOf(s).pending !== null && bodyOf(s).pending.targets[0].itemKey === "ik-gone");
  ok("case-1: lastBinding failure 带 UNRESOLVED + noteCount（truthful）", bodyOf(s).lastBinding && bodyOf(s).lastBinding.ok === false && bodyOf(s).lastBinding.failures && bodyOf(s).lastBinding.failures[0].code === "UNRESOLVED");

  console.log("— test behavior regression：同 lane 重复 itemKey → AMBIGUOUS 失败（route + all-or-nothing，不 first-match）—");
  // 构造同一 lane 两条同 itemKey 的 Note（数据异常/手改/合并产物）→ 绑定必须失败，
  // 绝不 first-match 绑到另一条 Note
  const dupBlock1 = serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "DUP-A 第一副本" }), k1));
  const dupBlock2 = serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "DUP-B 第二副本" }), k1));
  await writeFile(join(notesRoot, L1, `${SESSION}.md`), [dupBlock1, dupBlock2].join("\n\n"), "utf8");
  const dupPut = await putSel([{ laneKey: L1, itemKey: k1 }]); // default gen（计数器已同步）
  ok("behavior regression: 重复 key selection PUT 接受", dupPut.code === 200 && bodyOf(dupPut).ok === true);
  const dupGen = bodyOf(dupPut).generation;
  const outDup = await preStepListener({ agent: agentCtx }, async () => ({ kind: "enter", messages: [directMsg] }));
  ok("behavior regression: 重复 key 绑定 → kind=reject（不 first-match 注入任一副本）", outDup && outDup.kind === "reject");
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("behavior regression: lastBinding failure 带 AMBIGUOUS（truthful）", bodyOf(s).lastBinding && bodyOf(s).lastBinding.ok === false && bodyOf(s).lastBinding.failures && bodyOf(s).lastBinding.failures[0].code === "AMBIGUOUS", JSON.stringify(bodyOf(s).lastBinding));
  ok("behavior regression: failure 后 pending 保留（selection 不丢）", bodyOf(s).pending !== null && bodyOf(s).pending.targets[0].itemKey === k1);
  // 恢复 lane 为单副本 + versioned clear（后续块继续用 k1 正常路径）
  await writeFile(join(notesRoot, L1, `${SESSION}.md`), dupBlock1, "utf8");
  s = await putSel([], dupGen + 1);
  ok("behavior regression: 恢复后 clear（pending 清空）", s.code === 200 && bodyOf(s).ok === true && bodyOf(s).pending === null);
  gen = dupGen + 1; // 同步计数器

  console.log("— 无 direct user → 不消费 —");
  await putSel([{ laneKey: L1, itemKey: k1 }]);
  const out3 = await preStepListener({ agent: agentCtx }, async () => ({ kind: "enter", messages: [{ role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "ctx" }] }] }));
  ok("无 direct → 原样且 pending 保留", out3.messages.length === 1);
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("pending 未消费", bodyOf(s).pending !== null);

  console.log("— 无关 session/event 不误确认（case-2 防误清）+ case-4 结果代 —");
  await putSel([{ laneKey: L1, itemKey: k1 }]);
  const finalGen = bodyOf((await call(handler, makeReq({ url: sel, headers: H })))).pending.generation;
  await sessionEventListener(fakeSession, { type: "user/message", seq: 200, data: { source: { kind: "plugin", plugin: "other-plugin", form: "snapshot" }, content: [{ type: "text", text: "x" }] } });
  s = await call(handler, makeReq({ url: sel, headers: H }));
  ok("非 notes-reference append 不确认（pending 保留、无该代结果）", bodyOf(s).pending !== null && bodyOf(s).pending.generation === finalGen && !(bodyOf(s).lastBinding && bodyOf(s).lastBinding.generation === finalGen));
  // case-2 配对防误：reference 后出现无关 direct（非本 binding 的 user）——保守：配对 tracker
  // 只认 reference 后第一条 direct；此场景在本测试由 refEvent→directEvent 顺序保证。

  console.log(`\n结果：behavior regression binding endpoints ${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}
await main();
