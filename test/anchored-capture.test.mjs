// Source behavior regression / Notes behavior regression host anchored-commit engine tests
// 依据：host-authoritative capture validation and bounded renderer projection rules.
// 覆盖 A authoritative validation / B item 序列化 / C whole-lane append（distinct +
// order）/ D failure invariants（校验失败 / 降级 / 静默截断 / source-independent 降格）。
import { appendCaptureBlock } from "../lib/capture-append.js";
import {
  validateAnchoredProposal,
  buildAnchoredItem,
  appendAnchoredItemToLane,
  prepareAnchoredCommit,
  buildSnapshotFromEvents,
  snapshotEventSource,
} from "../lib/anchored-capture.js";
import { parseLaneBody, serializeLaneBody } from "../lib/structured-item.js";
import { PROJECTION_VERSION, resolveLocator } from "../lib/source-locator.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const SID = "session-wo3-0001";
const SNAP = [
  { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 7, content: [{ type: "text", text: "SOURCE-A" }] },
  { kind: "assistant", messageId: "assistant-message-17", turn: 1, step: 1, seq: 17, content: [{ type: "text", text: "ASSISTANT-B" }] },
];

console.log("— Notes behavior regression A: authoritative proposal validation —");
{
  // 1. 合法 proposal：host reconstruction == effective
  const good = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [{ text: "04:56", reason: "after-projection" }] },
    SNAP,
    SID
  );
  ok("A1 合法 proposal → ok", good.ok === true, JSON.stringify(good).slice(0, 160));
  ok("A1 validated.sourcePayload 是稳定 message identity", good.ok && good.validated.sourcePayload.sessionId === SID && good.validated.sourcePayload.messageId === SNAP[0].messageId && good.validated.segments.length === 1);
  // 2. effective 与 host reconstruction 不一致 → reject（篡改/伪造）
  const tampered = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "HACKED-TEXT", unresolved: [] },
    SNAP,
    SID
  );
  ok("A2 effective 与 host 不一致 → reject（EFFECTIVE_MISMATCH）", tampered.ok === false && tampered.code === "EFFECTIVE_MISMATCH", JSON.stringify(tampered).slice(0, 120));
  // 3. segment 越界（exceeds projection）→ reject（RECONSTRUCT_FAILED）
  const oob = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 999 }], effectiveSourceText: "x", unresolved: [] },
    SNAP,
    SID
  );
  ok("A3 segment 越界 → reject（host 无法重建）", oob.ok === false && (oob.code === "RECONSTRUCT_FAILED" || oob.code === "INVALID_LOCATOR"), JSON.stringify(oob).slice(0, 120));
  // 4. event 缺失（host snapshot 无 seq 17）→ reject（EVENT_NOT_FOUND via RECONSTRUCT_FAILED）
  const missing = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 99, start: 0, end: 3 }], effectiveSourceText: "abc", unresolved: [] },
    SNAP,
    SID
  );
  ok("A4 host 无该 event → reject", missing.ok === false, JSON.stringify(missing).slice(0, 140));
  // 5. 无 segments → reject（NO_POSITIVE_SOURCE）
  const empty = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [], effectiveSourceText: "", unresolved: [] },
    SNAP,
    SID
  );
  ok("A5 无 positive source → reject（NO_POSITIVE_SOURCE）", empty.ok === false && empty.code === "NO_POSITIVE_SOURCE");
  const emptyExtent = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 2, end: 2 }], effectiveSourceText: "", unresolved: [] },
    SNAP,
    SID
  );
  ok("A5b 空 selected extent → reject（INVALID_LOCATOR；不产生 source-aware item）", emptyExtent.ok === false && emptyExtent.code === "INVALID_LOCATOR", JSON.stringify(emptyExtent).slice(0, 150));
  // 6. unresolved 落在已知 source event 投影内（identity：startCP < projLen）→ reject
  const hidesSource = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [{ eventSeq: 7, text: "SOURCE-A", startCP: 2, endCP: 10, reason: "after-projection" }] },
    SNAP,
    SID
  );
  ok("A6 unresolved 落在投影内（startCP<projLen）→ reject（UNRESOLVED_INSIDE_PROJECTION）", hidesSource.ok === false && hidesSource.code === "UNRESOLVED_INSIDE_PROJECTION", JSON.stringify(hidesSource).slice(0, 150));
  // 7. 无效 sessionId → reject
  const badSid = validateAnchoredProposal(
    { sessionId: "bad!", projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [] },
    SNAP,
    SID
  );
  ok("A7 无效 sessionId → reject（INVALID_SESSION）", badSid.ok === false && badSid.code === "INVALID_SESSION");
  // 8. unresolved 文本恰是 source 子串（duplicate/substring）但坐标在投影外
  //    （after-projection startCP ≥ projLen）→ 合法（不误拒；identity 判定非文本扫描）
  const legitTail = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [{ eventSeq: 7, text: "URCE-A", startCP: 8, endCP: 14, reason: "after-projection" }] },
    SNAP,
    SID
  );
  ok("A8 unresolved 文本为 source 子串但坐标在投影外 → ok（非文本扫描，不误拒）", legitTail.ok === true, JSON.stringify(legitTail).slice(0, 140));
  // 9. 跨 session mismatch：candidate session A + snapshot session B（seq 相同）→ reject
  const snapB = [
    { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 7, content: [{ type: "text", text: "DIFFERENT-B" }] },
  ];
  const cross = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 11 }], effectiveSourceText: "SOURCE-A" },
    snapB,
    "session-wo3-other" // snapshot 来自另一会话
  );
  ok("A9 跨 session（snapshot session ≠ candidate session）→ reject（SESSION_MISMATCH）", cross.ok === false && cross.code === "SESSION_MISMATCH", JSON.stringify(cross).slice(0, 150));
}

console.log("— Notes behavior regression B: structured-item 序列化 —");
{
  const v = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [{ text: "04:56", reason: "after-projection" }] },
    SNAP,
    SID
  );
  const item = buildAnchoredItem(v, { captureOrigin: SID, comment: "test note" });
  ok("B1 item source-aware + snapshot + sourcePayload", item.kind === "source-aware" && item.snapshot === "SOURCE-A" && item.comment === "test note" && item.sourcePayload.sessionId === SID);
  // comment 为空 → 合法 anchored capture
  const itemNoComment = buildAnchoredItem(v, { captureOrigin: SID, comment: "" });
  ok("B2 comment 空 → 合法 item（snapshot 保留）", itemNoComment.kind === "source-aware" && itemNoComment.snapshot === "SOURCE-A" && (itemNoComment.comment ?? "") === "");
}

console.log("— Notes behavior regression C: whole-lane append（distinct + order + legacy 共存）—");
{
  const v = validateAnchoredProposal(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [] },
    SNAP,
    SID
  );
  const item1 = buildAnchoredItem(v, { captureOrigin: SID, comment: "first" });
  const item2 = buildAnchoredItem(v, { captureOrigin: SID, comment: "second (identical capture)" });
  // 空 lane → append item1
  const lane1 = appendAnchoredItemToLane("", item1);
  const parsed1 = parseLaneBody(lane1);
  ok("C1 空 lane append → 1 item", parsed1.nodes.length === 1 && parsed1.nodes[0].type === "item");
  // 相同/高度相似 capture 再次 append → 2 distinct items（不 dedupe / replace）
  const lane2 = appendAnchoredItemToLane(lane1, item2);
  const parsed2 = parseLaneBody(lane2);
  ok("C2 相同 capture 再次 append → 2 distinct items（不 dedupe/replace）", parsed2.nodes.length === 2 && parsed2.nodes.every((n) => n.type === "item"), JSON.stringify(parsed2.nodes.map((n) => n.item.comment)));
  // legacy 文本 + item 共存且顺序保持（1 legacy + lane2 的 2 items + 新增 item = 4）
  const lane3 = appendAnchoredItemToLane("自由文本\n" + lane2, item1);
  const parsed3 = parseLaneBody(lane3);
  ok("C3 legacy + items 共存保序", parsed3.nodes.length === 4 && parsed3.nodes[0].type === "legacy" && parsed3.nodes[0].text.includes("自由文本") && parsed3.nodes.slice(1).every((n) => n.type === "item"), JSON.stringify(parsed3.nodes.map((n) => n.type)));
  // round-trip 稳定
  ok("C4 lane round-trip 稳定", serializeLaneBody(parseLaneBody(lane3)) === lane3);
}

console.log("— Notes behavior regression D: prepareAnchoredCommit 编排 + failure invariants —");
{
  // 成功编排
  const okc = prepareAnchoredCommit(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [] },
    SNAP,
    { captureOrigin: SID, comment: "note", existingBody: "", snapshotSessionId: SID }
  );
  ok("D1 prepare ok → body + item + validated", okc.ok === true && okc.item.snapshot === "SOURCE-A" && typeof okc.body === "string");
  // 校验失败 → 不产生 item / body
  const badc = prepareAnchoredCommit(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "TAMPERED", unresolved: [] },
    SNAP,
    { captureOrigin: SID, comment: "", existingBody: "", snapshotSessionId: SID }
  );
  ok("D2 校验失败 → ok:false 无 item", badc.ok === false && badc.item === undefined && badc.body === undefined, JSON.stringify(badc).slice(0, 120));
  // unresolved 降级（落在投影内）→ 失败
  const badc2 = prepareAnchoredCommit(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [{ eventSeq: 7, text: "SOURCE-A", startCP: 0, endCP: 8 }] },
    SNAP,
    { captureOrigin: SID, comment: "", existingBody: "", snapshotSessionId: SID }
  );
  ok("D3 unresolved 落在投影内 → ok:false（UNRESOLVED_INSIDE_PROJECTION）", badc2.ok === false && badc2.code === "UNRESOLVED_INSIDE_PROJECTION");
  // snapshot 不因 comment/存储 convenience 截断（item.snapshot == 完整 effective）
  const long = prepareAnchoredCommit(
    { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 7, start: 0, end: 4 }, { eventSeq: 7, start: 4, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [] },
    SNAP,
    { captureOrigin: SID, comment: "x".repeat(500), existingBody: "", snapshotSessionId: SID }
  );
  ok("D4 snapshot 完整（不因 comment 截断）", long.ok === true && long.item.snapshot === "SOURCE-A" && (long.item.comment ?? "").length === 500);
}

console.log("— Notes behavior regression helper: buildSnapshotFromEvents —");
{
  const events = [
    { event: { seq: 7, type: "user/message", data: { id: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", content: [{ type: "text", text: "SOURCE-A" }], source: { kind: "user" } } } },
    { event: { seq: 8, type: "user/message", data: { id: "7420765e-59b5-406c-a0d9-ce479cd9947d", content: [{ type: "text", text: "CTX" }], source: { kind: "plugin" } } } },
    { event: { seq: 17, type: "assistant/message", data: { message: { id: "assistant-message-17", content: [{ type: "text", text: "ASSISTANT-B" }] } } } },
  ];
  // 测试 fixture：短会话 mock 事件无 data.turn → 显式 allowAsmIndexFallback（兼容路径；
  // 真实 host 长会话路径不传此 opt——见 lib/anchored-capture.js identity 规则）
  const nodes = buildSnapshotFromEvents(events, { allowAsmIndexFallback: true });
  ok("E1 events → snapshotNodes（user/assistant）", nodes.length === 3 && nodes[0].kind === "user" && nodes[2].kind === "assistant" && nodes[2].seq === 17);
  ok("E2 eventSource 按 seq 取 content", snapshotEventSource(nodes, SID)(SID, 7)[0].text === "SOURCE-A" && snapshotEventSource(nodes, SID)(SID, 99) === undefined);
  // host reconstruction via snapshot nodes（模拟完整链路）
  const loc = { sessionId: SID, projectionVersion: PROJECTION_VERSION, segments: [{ eventSeq: 17, start: 0, end: 11 }] };
  const rb = resolveLocator(loc, snapshotEventSource(nodes, SID));
  ok("E3 snapshot nodes 支持 locator-only reconstruct", rb.text === "ASSISTANT-B");
}

// behavior regression production 长会话 identity 回归：host session.history 返回**有界窗口**（窗口
// 起点 ≠ 会话起点），assistant 事件携带**真实全局 turn/step**（renderer 身份）。
// snapshot 必须用真实 turn/step（393..398），不得用窗口内 asmIndex（1..N）冒充。
console.log("— behavior regression: bounded-window assistant identity（真实全局 turn/step）—");
{
  // 模拟长会话窗口：assistant/message 带真实 turn 393..398（与 asmIndex 明显错位）
  const mk = (seq, turn, step, text) => ({ event: { seq, type: "assistant/message", data: { turn, step, message: { content: [{ type: "text", text }] } } } });
  const events = [
    mk(5697000, 393, 1, "T393-1"),
    mk(5697100, 393, 2, "T393-2"),
    mk(5697200, 394, 1, "T394-1"),
    mk(5697300, 397, 13, "T397-13"), // ← 用户实际选中（DOM assistant-step397:13）
    mk(5697400, 398, 5, "T398-5"),
  ];
  const nodes = buildSnapshotFromEvents(events); // 真实 host 路径：不传 allowAsmIndexFallback
  const byTurn = (t, s) => nodes.find((n) => n.kind === "assistant" && n.turn === t && n.step === s);
  ok("bounded-window-1 bounded window 用真实全局 turn（393..398，非 1..N）",
    nodes.length === 5 && byTurn(393, 1)?.seq === 5697000 && byTurn(397, 13)?.seq === 5697300 && byTurn(398, 5)?.seq === 5697400);
  ok("bounded-window-2 无 asmIndex 残留（node 数 == 带真实 turn 的 assistant 数）",
    nodes.every((n) => n.kind !== "assistant" || (n.turn >= 393 && n.turn <= 398)));
  // 关键：DOM renderer 的 assistant-step397:13 现在能命中 snapshot
  ok("bounded-window-3 DOM assistant-step397:13 命中 snapshot（修复前 asmIndex 1..5 无法命中）",
    nodes.some((n) => n.kind === "assistant" && n.turn === 397 && n.step === 13));
  // user/message 不受影响（messageId 身份）
  const withUser = [
    { event: { seq: 1, type: "user/message", data: { id: "u-1", content: [{ type: "text", text: "U1" }], source: { kind: "user" } } } },
    mk(5697000, 393, 1, "T393-1"),
  ];
  const nodes2 = buildSnapshotFromEvents(withUser);
  ok("bounded-window-4 user messageId 身份保留", nodes2.length === 2 && nodes2[0].kind === "user" && nodes2[0].messageId === "u-1");
}
console.log("— behavior regression: 缺权威 turn/step 的 bounded 真实路径 → truthful skip（不 guess/rebind）—");
{
  // 真实 host 路径（不传 allowAsmIndexFallback）：assistant/message 缺 data.turn →
  // 无权威身份 → skip（不 asmIndex 冒充）。既有 asmIndex 仅测试 fixture opt-in。
  const events = [
    { event: { seq: 7, type: "user/message", data: { id: "u-7", content: [{ type: "text", text: "U" }], source: { kind: "user" } } } },
    { event: { seq: 17, type: "assistant/message", data: { message: { content: [{ type: "text", text: "A" }] } } } }, // 无 turn
  ];
  const strict = buildSnapshotFromEvents(events); // 真实路径
  ok("bounded-window-5 真实路径缺 turn → assistant truthful skip（不 guess）",
    strict.length === 1 && strict[0].kind === "user");
  const compat = buildSnapshotFromEvents(events, { allowAsmIndexFallback: true }); // fixture 兼容
  ok("bounded-window-6 fixture 显式 opt-in 才 asmIndex 回退", compat.length === 2 && compat[1].kind === "assistant" && compat[1].turn === 1);
  // annotateAssistant 回调仍可用（显式权威）
  const ann = buildSnapshotFromEvents(events, { annotateAssistant: () => ({ turn: 42, step: 7 }) });
  ok("bounded-window-7 annotateAssistant 回调提供权威 turn/step", ann.length === 2 && ann[1].turn === 42 && ann[1].step === 7);
}
console.log("— Notes behavior regression F: capture block append（保留原文空白，安全分隔）—");
{
  const block = "--- dsh-note v1 begin\ndsh-meta kind: source-aware\n--- dsh-note v1 end";
  // 空 lane → block 原样
  ok("F1 空 lane → block 原样", appendCaptureBlock("", block) === block);
  // 首尾空白保留（原文所有字符不丢）
  const withWs = "\n  既有内容  \n\n";
  const out = appendCaptureBlock(withWs, block);
  ok("F2 原文首尾空白保留", out.startsWith("\n  既有内容  \n\n\n\n"), JSON.stringify(out.slice(0, 30)));
  ok("F3 block 在 \n\n 分隔后", out.endsWith(block), JSON.stringify(out.slice(-20)));
  // 无空白普通文本
  ok("F4 普通文本 + \n\n + block", appendCaptureBlock("abc", block) === "abc\n\n" + block);
  // 不 trim：前后空格保留
  const out2 = appendCaptureBlock("  x  ", block);
  ok("F5 不 trim（前后空格保留）", out2 === "  x  \n\n" + block, JSON.stringify(out2));
}
console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
