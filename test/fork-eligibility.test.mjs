// behavior regression—fork eligibility by historical SOURCE LOCATION
// 非 capture time；覆盖 source-location eligibility and carry scenarios。
//
// 机械事实：session.fork 以 parent events[0..cut)
// 为 child seed，live child Session.inheritedEventCount = 共享前缀长度（= 首个被排除的
// parent 事件下标）；dsh-session 事件 seq === log 下标（seq=log.length、seed 从 0 连续）→
// parent 锚定的 sourcePayload.segments[].eventSeq < seedLength ⟺ 源位在 fork cut 内。
// legacy 单元仍直接用 eventSeq 编码 parent-log 下标；messageId 单元使用权威事件快照。
import { apply } from "../lib/index.js";
import { filterParentLaneForFork } from "../lib/carry-merge.js";
import { makeItem, serializeItem, parseLaneBody, withItemKey, newItemKey } from "../lib/structured-item.js";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function makeReq({ method = "GET", url = "/", headers = {}, body }) {
  const chunks = body == null ? [] : [Buffer.from(body)];
  return { method, url, headers, resume() {}, [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
}
function makeRes() { const state = {}; return { writeHead(c, h) { state.code = c; state.headers = h; }, end(b) { state.body = b ?? ""; }, state }; }
async function call(handler, req) { const res = makeRes(); await handler(req, res); return res.state; }
const bodyOf = (s) => { try { return JSON.parse(s.body); } catch { return s.body; } };

const SID_P = "session-fel-parent-00001";
const OTHER = "session-other-conv-000001";

function anchored(parentSid, comment, eventSeq, opts = {}) {
  const item = makeItem({
    kind: "source-aware",
    captureOrigin: SID_P,
    snapshot: opts.snapshot ?? `SRC-${eventSeq}`,
    comment,
    sourcePayload: { projectionVersion: 1, sessionId: parentSid, segments: [{ eventSeq, start: opts.start ?? 0, end: opts.end ?? 8 }] },
  });
  const withKey = opts.key ? withItemKey(item, opts.key) : item;
  return serializeItem(withKey);
}
function messageAnchored(parentSid, comment, messageId) {
  return serializeItem(makeItem({
    kind: "source-aware",
    captureOrigin: parentSid,
    snapshot: `S-${messageId}`,
    comment,
    sourcePayload: { sessionId: parentSid, messageId },
  }));
}
const srcInd = (comment) => serializeItem(makeItem({ kind: "source-independent", captureOrigin: SID_P, comment }));

const PARENT_EVENTS = [
  { seq: 1, type: "user/message", data: { id: "msg-before", content: [] } },
  { seq: 5, type: "user/message", data: { id: "msg-last-shared", content: [] } },
  { seq: 6, type: "user/message", data: { id: "msg-first-after", content: [] } },
  { seq: 9, type: "assistant/message", data: { message: { id: "msg-later" } } },
  { seq: 10, type: "user/message", data: { id: "msg-duplicate", content: [] } },
  { seq: 11, type: "user/message", data: { id: "msg-duplicate", content: [] } },
];

async function main() {
  const ws = await mkdtemp(join(tmpdir(), "dsh-fel-"));
  const notesRoot = join(ws, "notes");
  const sessions = new Map([[SID_P, { id: SID_P, header: { cwd: ws }, snapshotEvents: () => PARENT_EVENTS }]]);
  let handler;
  const eventListeners = new Map();
  const app = new Context();
  const fs = new LocalFileSystem(app, { cwd: ws, diffBasisMaxBytes: 1024 * 1024 });
  const ctx = { fs, get: () => sessions, webServer: { register: (cfg) => { handler = cfg.handler; } }, on: (name, fn) => { eventListeners.set(name, fn); } };
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(ws, "dsh-home");
  await apply(ctx);
  process.env.DSH_HOME = prevHome;
  const H = { host: "127.0.0.1:3080" };
  const createdListener = eventListeners.get("session/created");
  const getLane = async (sid, lane) => readFile(join(notesRoot, lane, `${sid}.md`), "utf8").catch(() => "");
  const putLane = async (sid, lane, body) => {
    const g = await call(handler, makeReq({ url: `/notes-api/${sid}/${lane}`, headers: H }));
    await call(handler, makeReq({ method: "PUT", url: `/notes-api/${sid}/${lane}`, headers: { ...H, "if-match": g.headers["x-notes-mtime"] ?? "0" }, body }));
  };
  const childOf = (id, seedLength) => {
    sessions.set(id, { id, header: { cwd: ws, parentSession: SID_P }, inheritedEventCount: seedLength });
    createdListener(sessions.get(id));
  };
  const carryAll = async (id) => call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: id, choice: "all" }) }));
  const applyAll = async (id, resolutions, observations) => call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: id, choice: "all", resolutions, observations }) }));
  const forkStatus = async (id) => bodyOf(await call(handler, makeReq({ url: `/notes-api/fork-status?sessionId=${id}`, headers: H })));
  const markerOf = async (id) => JSON.parse(await readFile(join(notesRoot, ".carry-over", `${id}.json`), "utf8"));

  const CUT = 6; // 父事件 0..5 共享（fork 于含 idx5 的轮）；≥6 为 cut 后
  const blocks = {
    hindsight3: anchored(SID_P, "HINDSIGHT seq3", 3, { key: "k-hindsight3" }),   // 源位 turn3（文件后置 = capture 晚）→ eligible
    srcIndNote: srcInd("普通便签（capture 后置）"),                              // class b：不改语义 → 保留
    future7: anchored(SID_P, "FUTURE seq8", 8, { key: "k-future7" }),            // 源位 turn7+ → 排除
    legacyText: "裸文本 legacy 段落",                                             // class d：不改 → 保留
    otherSid: anchored(OTHER, "CROSS-CONV seq9", 9, { key: "k-other" }),          // class c：不改 → 保留
    future9: anchored(SID_P, "FUTURE seq9", 9, { key: "k-future9" }),            // 源位 turn9 → 排除
    boundaryIn: anchored(SID_P, "BOUNDARY-IN seq5", 5, { key: "k-bin" }),        // = CUT-1 → 保留（≤ cut）
    boundaryOut: anchored(SID_P, "BOUNDARY-OUT seq6", 6, { key: "k-bout" }),     // = CUT → 排除（> cut）
    dupHindsight: anchored(SID_P, "HINDSIGHT seq3 dup", 3, { key: "k-hindsight3dup" }), // 同源位第二条 → 都保留（不 dedupe）
  };
  // 文件序故意非时序（capture 后置的 hindsight 放中间/后部）
  const parentL1 = [blocks.future7, blocks.hindsight3, blocks.srcIndNote, blocks.legacyText, blocks.otherSid, blocks.future9, blocks.boundaryIn, blocks.boundaryOut, blocks.dupHindsight].join("\n\n");
  await putLane(SID_P, "conversation_todo", parentL1);

  console.log("== unit：filterParentLaneForFork ==");
  {
    const r = filterParentLaneForFork(parentL1, { parentSessionId: SID_P, seedLength: CUT });
    ok("unit: 无 seedLength → 原样 + reason", filterParentLaneForFork(parentL1, { parentSessionId: SID_P, seedLength: null }).reason === "no-seed-length" && filterParentLaneForFork(parentL1, { parentSessionId: SID_P, seedLength: null }).filtered === 0);
    ok("unit: 排除 3 条 post-cut parent 锚定（future7/future9/boundaryOut）", r.filtered === 3 && r.excluded.map((e) => e.code).sort().join(",") === "after-cut,after-cut,after-cut", JSON.stringify(r.excluded));
    ok("unit: hindsight3/srcInd/legacy/otherSid/boundaryIn/dup 保留", !r.body.includes("FUTURE seq8") && !r.body.includes("FUTURE seq9") && !r.body.includes("BOUNDARY-OUT") && r.body.includes("HINDSIGHT seq3") && r.body.includes("普通便签") && r.body.includes("裸文本 legacy") && r.body.includes("CROSS-CONV") && r.body.includes("BOUNDARY-IN") && r.body.includes("HINDSIGHT seq3 dup"));
    const p1 = parseLaneBody(r.body);
    const itemComments = p1.nodes.filter((n) => n.type === "item" && n.item).map((n) => n.item.comment);
    ok("unit: 保留项可 parse、顺序 = 原相对序（含 legacy 原位）", itemComments.join("|") === "HINDSIGHT seq3|普通便签（capture 后置）|CROSS-CONV seq9|BOUNDARY-IN seq5|HINDSIGHT seq3 dup", JSON.stringify(itemComments));
    ok("unit: straddle（跨 cut 段）→ code straddle 排除", (() => {
      const straddle = serializeItem(makeItem({ kind: "source-aware", captureOrigin: SID_P, snapshot: "S", comment: "STRADDLE", sourcePayload: { projectionVersion: 1, sessionId: SID_P, segments: [{ eventSeq: 3, start: 0, end: 5 }, { eventSeq: 8, start: 0, end: 3 }] } }));
      const rr = filterParentLaneForFork([parentL1, straddle].join("\n\n"), { parentSessionId: SID_P, seedLength: CUT });
      return rr.excluded.some((e) => e.code === "straddle") && !rr.body.includes("STRADDLE");
    })());
    ok("unit: malformed structured 候选 → 整体 opaque legacy 保留（防御路径，不误判）", (() => {
      const malformed = "散乱文本\n--- dsh-note v1 begin\n（broken candidate）";
      const rr = filterParentLaneForFork(malformed, { parentSessionId: SID_P, seedLength: CUT });
      return rr.filtered === 0 && rr.body === malformed;
    })());
    ok("unit: 空/纯 legacy 输入 → 原样零过滤", (() => { const rr = filterParentLaneForFork("plain", { parentSessionId: SID_P, seedLength: CUT }); return rr.filtered === 0 && rr.body === "plain"; })());
  }

  console.log("== unit：messageId Source → authoritative parent event.seq fork-cut eligibility ==");
  {
    const body = [
      messageAnchored(SID_P, "MSG before", "msg-before"),
      messageAnchored(SID_P, "MSG last shared", "msg-last-shared"),
      messageAnchored(SID_P, "MSG first after", "msg-first-after"),
      messageAnchored(SID_P, "MSG later after", "msg-later"),
      messageAnchored(SID_P, "MSG missing", "msg-missing"),
      messageAnchored(SID_P, "MSG ambiguous", "msg-duplicate"),
      messageAnchored(OTHER, "MSG other session", "msg-first-after"),
    ].join("\n\n");
    const r = filterParentLaneForFork(body, { parentSessionId: SID_P, seedLength: CUT, parentSession: sessions.get(SID_P) });
    ok("messageId：唯一匹配且 seq < cut → included", r.body.includes("MSG before"));
    ok("messageId：唯一匹配且 seq = cut-1 → included", r.body.includes("MSG last shared"));
    ok("messageId：首个 post-cut seq = cut → excluded", !r.body.includes("MSG first after"));
    ok("messageId：后续 post-cut → excluded", !r.body.includes("MSG later after"));
    ok("messageId：另一会话 → non-comparable / included", r.body.includes("MSG other session"));
    ok("messageId：missing match → non-comparable / included", r.body.includes("MSG missing"));
    ok("messageId：duplicate match → non-comparable / included，不取 first", r.body.includes("MSG ambiguous"));
    ok("messageId：只过滤唯一正向 post-cut Source", r.filtered === 2 && r.excluded.every((e) => e.code === "after-cut"), JSON.stringify(r));
  }

  console.log("== integration：actual Session.inheritedEventCount + parent snapshotEvents ==");
  {
    const parentMessageLane = [
      messageAnchored(SID_P, "INTEGRATION before", "msg-before"),
      messageAnchored(SID_P, "INTEGRATION after", "msg-first-after"),
    ].join("\n\n");
    await putLane(SID_P, "deferred_work", parentMessageLane);
    const child = "session-fel-child-message-0001";
    childOf(child, CUT);
    const result = bodyOf(await carryAll(child));
    const got = await getLane(child, "deferred_work");
    ok("handler：从 live Session.inheritedEventCount 读取 cut", result.status === "carried" && result.results.some((r) => r.lane === "deferred_work" && r.eligibilityFiltered === 1), JSON.stringify(result));
    ok("handler：messageId Source 按 parent snapshotEvents 过滤", got.includes("INTEGRATION before") && !got.includes("INTEGRATION after"), got);
  }

  console.log("== atomicity：authoritative event-read failure =  explicit failure + zero writes ==");
  {
    const parent = sessions.get(SID_P);
    const originalSnapshotEvents = parent.snapshotEvents;
    const originalParentL1 = await getLane(SID_P, "conversation_todo");
    const originalParentL2 = await getLane(SID_P, "deferred_work");
    await putLane(SID_P, "conversation_todo", messageAnchored(SID_P, "ATOMIC parent L1", "msg-before"));
    await putLane(SID_P, "deferred_work", messageAnchored(SID_P, "ATOMIC parent L2", "msg-first-after"));
    const parentL1Before = await getLane(SID_P, "conversation_todo");
    const parentL2Before = await getLane(SID_P, "deferred_work");

    const carryChild = "session-fel-child-event-read-fail-1";
    childOf(carryChild, CUT);
    parent.snapshotEvents = () => { throw new Error("simulated authoritative snapshot failure"); };
    const carryFailure = await carryAll(carryChild);
    const carryFailureBody = bodyOf(carryFailure);
    const carryMarker = JSON.parse(await readFile(join(notesRoot, ".carry-over", `${carryChild}.json`), "utf8"));
    ok("carryover：snapshotEvents 抛错 → explicit CARRY_EVENT_READ_FAILED", carryFailure.code === 409 && carryFailureBody.code === "CARRY_EVENT_READ_FAILED", JSON.stringify(carryFailure));
    ok("carryover：multiple selected lanes → zero child lane writes", (await getLane(carryChild, "conversation_todo")) === "" && (await getLane(carryChild, "deferred_work")) === "");
    ok("carryover：marker remains unresolved and has no derivation bindings", carryMarker.status === "unresolved" && !("bindings" in carryMarker));
    ok("carryover：parent data unchanged", (await getLane(SID_P, "conversation_todo")) === parentL1Before && (await getLane(SID_P, "deferred_work")) === parentL2Before);

    parent.snapshotEvents = originalSnapshotEvents;
    const applyChildId = "session-fel-child-event-read-fail-2";
    childOf(applyChildId, CUT);
    await putLane(applyChildId, "conversation_todo", "ATOMIC child L1");
    await putLane(applyChildId, "deferred_work", "ATOMIC child L2");
    const preview = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: applyChildId, choice: "all" }) })));
    const observations = Object.fromEntries((preview.lanes ?? []).map((lane) => [lane.lane, { parent: lane.parent, child: lane.child }]));
    parent.snapshotEvents = () => { throw new Error("simulated authoritative snapshot failure"); };
    const applyFailure = await applyAll(applyChildId, { conversation_todo: "replace", deferred_work: "replace" }, observations);
    const applyFailureBody = bodyOf(applyFailure);
    const applyMarker = JSON.parse(await readFile(join(notesRoot, ".carry-over", `${applyChildId}.json`), "utf8"));
    ok("fork-apply：预检后 event-read 抛错 → explicit failure", applyFailure.code === 409 && applyFailureBody.code === "CARRY_EVENT_READ_FAILED", JSON.stringify(applyFailure));
    ok("fork-apply：抛错发生在 materialization 前 → zero child lane writes", (await getLane(applyChildId, "conversation_todo")) === "ATOMIC child L1" && (await getLane(applyChildId, "deferred_work")) === "ATOMIC child L2");
    ok("fork-apply：unresolved carry remains unresolved and no derivation binding is created", applyMarker.status === "unresolved" && !("bindings" in applyMarker));
    ok("fork-apply：parent data remains unchanged", (await getLane(SID_P, "conversation_todo")) === parentL1Before && (await getLane(SID_P, "deferred_work")) === parentL2Before);
    ok("fork-status：failed carry remains unresolved", (await forkStatus(carryChild)).status === "unresolved" && (await forkStatus(applyChildId)).status === "unresolved");
    await putLane(SID_P, "conversation_todo", originalParentL1);
    await putLane(SID_P, "deferred_work", originalParentL2);
    parent.snapshotEvents = originalSnapshotEvents;

    const noReadChild = "session-fel-child-parent-absent-no-read";
    childOf(noReadChild, CUT);
    sessions.delete(SID_P);
    const noReadResponse = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: noReadChild, choice: "some", lanes: ["conversation_todo"] }) }));
    const noReadBody = bodyOf(noReadResponse);
    ok("no-read-required + parent absent → normal carry succeeds", noReadResponse.code === 200 && noReadBody.status === "carried" && (await getLane(noReadChild, "conversation_todo")).includes("HINDSIGHT seq3"), JSON.stringify(noReadResponse));
    sessions.set(SID_P, parent);

    const missingCarryChild = "session-fel-child-parent-missing-1";
    childOf(missingCarryChild, CUT);
    sessions.delete(SID_P);
    const missingCarryResponse = await carryAll(missingCarryChild);
    const missingCarryBody = bodyOf(missingCarryResponse);
    const missingCarryMarker = await markerOf(missingCarryChild);
    ok("carryover：required parent Session missing → CARRY_EVENT_READ_FAILED", missingCarryResponse.code === 409 && missingCarryBody.code === "CARRY_EVENT_READ_FAILED", JSON.stringify(missingCarryResponse));
    ok("carryover：missing parent → zero child writes and unresolved/no bindings", (await getLane(missingCarryChild, "conversation_todo")) === "" && (await getLane(missingCarryChild, "deferred_work")) === "" && missingCarryMarker.status === "unresolved" && !("bindings" in missingCarryMarker));
    sessions.set(SID_P, parent);

    const missingApplyChild = "session-fel-child-parent-missing-2";
    childOf(missingApplyChild, CUT);
    await putLane(missingApplyChild, "conversation_todo", "MISSING-PARENT child L1");
    await putLane(missingApplyChild, "deferred_work", "MISSING-PARENT child L2");
    const missingPreview = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: missingApplyChild, choice: "all" }) })));
    const missingObservations = Object.fromEntries((missingPreview.lanes ?? []).map((lane) => [lane.lane, { parent: lane.parent, child: lane.child }]));
    sessions.delete(SID_P);
    const missingApplyResponse = await applyAll(missingApplyChild, { conversation_todo: "replace", deferred_work: "replace" }, missingObservations);
    const missingApplyBody = bodyOf(missingApplyResponse);
    const missingApplyMarker = await markerOf(missingApplyChild);
    ok("fork-apply：preflight 后 parent Session missing → CARRY_EVENT_READ_FAILED", missingApplyResponse.code === 409 && missingApplyBody.code === "CARRY_EVENT_READ_FAILED", JSON.stringify(missingApplyResponse));
    ok("fork-apply：missing parent → zero replacement writes and unresolved/no bindings", (await getLane(missingApplyChild, "conversation_todo")) === "MISSING-PARENT child L1" && (await getLane(missingApplyChild, "deferred_work")) === "MISSING-PARENT child L2" && missingApplyMarker.status === "unresolved" && !("bindings" in missingApplyMarker));
    sessions.set(SID_P, parent);
  }

  console.log("== S1+S2+S3+S4：future source excluded / hindsight 保留 / boundary / mixed lane ==");
  {
    const child = "session-fel-child-0000001";
    childOf(child, CUT);
    const res = bodyOf(await carryAll(child));
    ok("S1/S4: carry all 成功", res.status === "carried");
    const got = await getLane(child, "conversation_todo");
    const parsed = parseLaneBody(got);
    const aware = parsed.nodes.filter((n) => n.type === "item" && n.item.kind === "source-aware" && n.item.sourcePayload && n.item.sourcePayload.sessionId === SID_P);
    ok("S1: parent 锚定 post-cut（eventSeq ≥ 6）全部排除", !got.includes("FUTURE seq8") && !got.includes("FUTURE seq9") && !got.includes("BOUNDARY-OUT"));
    ok("S1: results 报告 eligibilityFiltered=3", res.results.some((r) => r.eligibilityFiltered === 3), JSON.stringify(res.results));
    ok("S2: hindsight（capture 后置、源位 seq3 < cut）保留（source-locus 非 capture-time）", got.includes("HINDSIGHT seq3") && got.includes("HINDSIGHT seq3 dup"));
    ok("S3: boundary ≤ cut（seq5）保留 / > cut（seq6）排除", got.includes("BOUNDARY-IN") && !got.includes("BOUNDARY-OUT"));
    ok("S4a: 无 parent 锚定 post-cut 泄漏（每一条 parent 锚定 eventSeq < 6）", aware.every((n) => n.item.sourcePayload.segments.every((sg) => sg.eventSeq < CUT)));
    ok("S4b: 同源位两条不 dedupe（hindsight ×2）", (got.match(/HINDSIGHT seq3/g) || []).length === 2);
    ok("S4c: 保留项顺序 = 原相对序（hindsight → srcInd → legacy → other → boundaryIn → dup）", (() => {
      const idx = (frag) => got.indexOf(frag);
      const order = [idx("HINDSIGHT seq3"), idx("普通便签"), idx("裸文本 legacy"), idx("CROSS-CONV"), idx("BOUNDARY-IN"), idx("HINDSIGHT seq3 dup")];
      return order.every((x) => x >= 0) && order.every((x, i) => i === 0 || x > order[i - 1]);
    })());
    ok("S4d: 无 provenance 重写——child 保留项 capture-origin == parent、sourcePayload 原样、snapshot 原样",
      parsed.nodes.filter((n) => n.type === "item" && n.item.kind === "source-aware").every((n) => n.item.captureOrigin === SID_P && n.item.snapshot && n.item.sourcePayload.sessionId === (n.item.comment === "CROSS-CONV seq9" ? OTHER : SID_P)));
    ok("S4e: parent lane 原文件未被改动（字节相等）", (await getLane(SID_P, "conversation_todo")) === parentL1);
  }

  console.log("== S5：all/some/none 授权不变（subject to eligibility）==");
  {
    const cNone = "session-fel-child-0000002";
    childOf(cNone, CUT);
    const rNone = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: cNone, choice: "none" }) })));
    ok("S5: none → 无 carry", rNone.status === "none" && (await getLane(cNone, "conversation_todo")) === "");
    const cSome = "session-fel-child-0000003";
    childOf(cSome, CUT);
    const rSome = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: cSome, choice: "some", lanes: ["conversation_todo"] }) })));
    ok("S5: some(conversation_todo) → 该 lane 过滤后 carry", rSome.status === "carried" && rSome.results.some((r) => r.eligibilityFiltered === 3));
    const gotSome = await getLane(cSome, "conversation_todo");
    ok("S5: some 过滤生效（无 post-cut parent 锚定）", !gotSome.includes("FUTURE seq8") && gotSome.includes("HINDSIGHT seq3"));
  }

  console.log("== S6：occupied child lane merge/replace 对过滤后 parent 生效 ==");
  {
    const cMerge = "session-fel-child-0000004";
    childOf(cMerge, CUT);
    await putLane(cMerge, "conversation_todo", "child 已有内容行");
    const conflict = bodyOf(await carryAll(cMerge));
    ok("S6: occupied child → conflict（预检不写）", conflict.status === "conflict" && conflict.conflicts.length === 1);
    const observations = conflict.observations;
    const rMerge = bodyOf(await applyAll(cMerge, { conversation_todo: "merge" }, observations));
    ok("S6: merge 应用成功", rMerge.status === "carried" && rMerge.results[0].outcome === "merged", JSON.stringify(rMerge));
    const gotMerge = await getLane(cMerge, "conversation_todo");
    ok("S6: merge wrapper parent 侧 = 过滤后 parent（无 post-cut parent 锚定）", gotMerge.includes("## 来自父分支") && !gotMerge.includes("FUTURE seq8") && !gotMerge.includes("BOUNDARY-OUT") && gotMerge.includes("child 已有内容行") && gotMerge.includes("HINDSIGHT seq3"));
    const cReplace = "session-fel-child-0000005";
    childOf(cReplace, CUT);
    await putLane(cReplace, "conversation_todo", "child 将被子分支覆盖");
    const conflict2 = bodyOf(await carryAll(cReplace));
    const rRep = bodyOf(await applyAll(cReplace, { conversation_todo: "replace" }, conflict2.observations));
    const gotRep = await getLane(cReplace, "conversation_todo");
    ok("S6: replace → 过滤后 parent 覆盖 child（无 post-cut）", rRep.status === "carried" && !gotRep.includes("FUTURE seq8") && gotRep.includes("HINDSIGHT seq3") && !gotRep.includes("child 将被子分支覆盖"));
    const cKeep = "session-fel-child-0000006";
    childOf(cKeep, CUT);
    await putLane(cKeep, "conversation_todo", "child keep 内容");
    const conflict3 = bodyOf(await carryAll(cKeep));
    const rKeep = bodyOf(await applyAll(cKeep, { conversation_todo: "keep" }, conflict3.observations));
    ok("S6: keep → child 原样保留（不写 parent 材料）", rKeep.status === "carried" && rKeep.results[0].outcome === "kept" && (await getLane(cKeep, "conversation_todo")) === "child keep 内容");
  }

  console.log("== S9：conflict preview 与 apply 同源过滤 + 全过滤父侧 elision ==");
  {
    const child = "session-fel-child-0000009";
    childOf(child, CUT);
    await putLane(child, "conversation_todo", "child 冲突内容");
    const conflict = bodyOf(await carryAll(child));
    ok("S9a: conflict payload parentContent 已按 fork 资格过滤（不显示 post-cut parent 锚定）", conflict.status === "conflict" && !conflict.conflicts[0].parentContent.includes("FUTURE seq8") && conflict.conflicts[0].parentContent.includes("HINDSIGHT seq3"), conflict.conflicts && conflict.conflicts[0].parentContent);
    const r = bodyOf(await applyAll(child, { conversation_todo: "merge" }, conflict.observations));
    ok("S9a2: merge 结果与 preview 一致（无 post-cut 泄漏进 wrapper parent 侧）", !(await getLane(child, "conversation_todo")).includes("FUTURE seq8") && (await getLane(child, "conversation_todo")).includes("child 冲突内容"));
    // 全 post-cut 的父 lane（L2）：eligible 为空 → child 空 / occupied-child merge = child only（无空 wrapper）
    const onlyFuture = anchored(SID_P, "ONLY-FUTURE seq8", 8, { key: "k-onlyfuture" });
    await putLane(SID_P, "deferred_work", onlyFuture);
    const cEmpty = "session-fel-child-0000010";
    childOf(cEmpty, CUT);
    const rEmpty = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: cEmpty, choice: "all" }) })));
    ok("S9b: 全 post-cut 父 lane → child lane 空（carried，eligibilityFiltered 报告）", rEmpty.status === "carried" && rEmpty.results.some((rr) => rr.lane === "deferred_work" && rr.eligibilityFiltered === 1) && (await getLane(cEmpty, "deferred_work")) === "");
    const cMergeEmpty = "session-fel-child-0000011";
    childOf(cMergeEmpty, CUT);
    await putLane(cMergeEmpty, "deferred_work", "child 有内容");
    const conflict2 = bodyOf(await carryAll(cMergeEmpty));
    const r2 = bodyOf(await applyAll(cMergeEmpty, { deferred_work: "merge" }, conflict2.observations));
    const got = await getLane(cMergeEmpty, "deferred_work");
    ok("S9c: 父侧全过滤 → merge = child only（无'来自父分支'空 wrapper、字节原样）", r2.status === "carried" && got === "child 有内容" && !got.includes("来自父分支") && !got.includes("ONLY-FUTURE"));
  }

  console.log("== S7：provenance（carried anchored 保留 origin/locator/snapshot；child holder；不 recapture）==");
  {
    const child = "session-fel-child-0000007";
    childOf(child, CUT);
    await carryAll(child);
    const got = await getLane(child, "conversation_todo");
    const parsed = parseLaneBody(got);
    const hs = parsed.nodes.filter((n) => n.type === "item" && n.item.comment === "HINDSIGHT seq3")[0];
    ok("S7: capture-origin 保持 parent", hs && hs.item.captureOrigin === SID_P);
    ok("S7: 历史 Source Anchor 原样（sessionId==parent + segments eventSeq 3 不变）", hs.item.sourcePayload.sessionId === SID_P && hs.item.sourcePayload.segments[0].eventSeq === 3);
    ok("S7: source snapshot 保留", hs.item.snapshot === "SRC-3");
    ok("S7: child holder 文件存在（holder=child），parent 文件不变", (await getLane(child, "conversation_todo")) !== "" && (await getLane(SID_P, "conversation_todo")) === parentL1);
    ok("S7: child item-key 为 child-local（≠ parent key，未复制 holder-local identity）", parseLaneBody(got).nodes.filter((n) => n.type === "item" && n.item.comment === "HINDSIGHT seq3")[0] !== undefined && !got.includes("k-hindsight3"));
  }

  console.log("== S8：parent/child 独立（child 编辑不动 parent）==");
  {
    const child = "session-fel-child-0000008";
    childOf(child, CUT);
    await carryAll(child);
    await putLane(child, "conversation_todo", "child 独立编辑后内容");
    ok("S8: parent 不受 child 编辑影响（字节相等）", (await getLane(SID_P, "conversation_todo")) === parentL1 && (await getLane(child, "conversation_todo")) === "child 独立编辑后内容");
  }


  console.log("== Supported eligibility matrix（A-L 显式验证）==");
  {
    // D: keyless 但有可比 parent 锚定 → 仍按 parent-anchor before/after 规则
    const keylessAfter = anchored(SID_P, "KEYLESS-FUTURE seq8", 8);           // 无 item-key
    const keylessBefore = anchored(SID_P, "KEYLESS-HINDSIGHT seq3", 3);       // 无 item-key
    await putLane(SID_P, "knowledge_candidate", [keylessAfter, keylessBefore].join("\n\n"));
    const cD = "session-fel-child-m000001";
    childOf(cD, CUT);
    const rD = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: cD, choice: "all" }) })));
    const gotD = await getLane(cD, "knowledge_candidate");
    ok("D: keyless 可比 parent 锚定 follow parent-anchor 规则（seq8 排除 / seq3 保留）", !gotD.includes("KEYLESS-FUTURE") && gotD.includes("KEYLESS-HINDSIGHT"), JSON.stringify(rD.results));
    // C: non-comparable（source-payload 行损坏 → item.sourcePayload undefined / opaque raw）→ 保留
    const goodBlock = anchored(SID_P, "NONCMP seq8", 8, { key: "k-noncmp" });
    const nonCmp = goodBlock.replace(/^dsh-meta source-payload: .*$/m, "dsh-meta source-payload: {broken json");
    await putLane(SID_P, "lesson_candidate", nonCmp);
    const cC = "session-fel-child-m000002";
    childOf(cC, CUT);
    const rC = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: cC, choice: "all" }) })));
    const gotC = await getLane(cC, "lesson_candidate");
    ok("C: non-comparable（损坏 locator → 无可比 parent 锚定）→ 保留（不因缺可比性被当作 post-fork）", gotC.includes("NONCMP seq8"), JSON.stringify(rC.results));
    // A/B: source-independent + 其它会话锚定保留（lane 级显式）
    ok("A: source-independent 保留", (await getLane("session-fel-child-0000001", "conversation_todo")).includes("普通便签（capture 后置）"));
    ok("B: 其它会话锚定保留", (await getLane("session-fel-child-0000001", "conversation_todo")).includes("CROSS-CONV"));
    // F/G: all = 完整矩阵下 eligible；some/none 不变（既有 S5 + 上面 all 断言）
    ok("F: all = supported matrix 全 eligible（parent post-cut 排除、其余保留）", (await getLane("session-fel-child-0000001", "conversation_todo")).includes("HINDSIGHT seq3") && !(await getLane("session-fel-child-0000001", "conversation_todo")).includes("FUTURE seq8"));
    // H/I/J/K/L: 由 S4/S6/S2/S7/S8 + 本 suite 既有断言覆盖（此处汇总命名引用）
    // H/I/J/K/L：真实断言（非恒真）——在已 carry 的 child 上复验 mixed-lane 顺序/
    // provenance/无 rewrite + parent 不变（J 的 capture-time 无关性 = S2 hindsight
    // 保留即证：capture 后置项因源位 ≤ cut 被保留）。
    const mChild = await getLane("session-fel-child-0000001", "conversation_todo");
    const mParsed = parseLaneBody(mChild);
    const mOrder = mParsed.nodes.filter((n) => n.type === "item" && n.item).map((n) => n.item.comment);
    const orderOk = mOrder.join("|") === "HINDSIGHT seq3|普通便签（capture 后置）|CROSS-CONV seq9|BOUNDARY-IN seq5|HINDSIGHT seq3 dup";
    const provOk = mParsed.nodes.filter((n) => n.type === "item" && n.item && n.item.kind === "source-aware")
      .every((n) => n.item.captureOrigin === SID_P && n.item.sourcePayload && n.item.sourcePayload.sessionId === (n.item.comment === "CROSS-CONV seq9" ? OTHER : SID_P) && typeof n.item.snapshot === "string");
    ok("H: mixed lane 保留顺序（hindsight→srcInd→other→boundaryIn→dup）", orderOk, JSON.stringify(mOrder));
    ok("K: 无 Source Anchor/provenance 重写（origin/locator.sessionId/snapshot 原样）", provOk);
    ok("J: 无 capture-time 依赖（hindsight 文件序靠后仍因源位 ≤ cut 保留）", mChild.includes("HINDSIGHT seq3") && !mChild.includes("FUTURE seq8"));
    ok("L: parent 文件未被 carry 改动", (await getLane(SID_P, "conversation_todo")) === parentL1);
  }

  console.log("\n结果：behavior regression fork eligibility " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed === 0 ? 0 : 1);
}
await main();
