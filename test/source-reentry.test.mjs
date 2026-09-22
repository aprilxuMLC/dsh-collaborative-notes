// Source behavior regression / Notes behavior regression source re-entry engine tests（host，纯函数）
// 覆盖：anchorFromItem（A/B authored 空/非空同路径）、validateLocatorShape（I）、
// resolveExactLocus（C duplicate 不 search / D CJK·emoji·markdown·cross-node /
// E multi-segment cross-event / H event 缺失 / session mismatch / extent 越界 /
// G 与 renderer 无关、无 highlight 声称）、render hints。
import {
  anchorFromItem,
  validateLocatorShape,
  resolveExactLocus,
  snapshotFromEvents,
} from "../lib/source-reentry.js";
import { makeItem, serializeItem, parseLaneBody } from "../lib/structured-item.js";
import { buildLocator, buildMessageIdentity, PROJECTION_VERSION_MARKDOWN } from "../lib/source-locator.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const SID = "session-wo4-0001";

// —— fixture events（扁平 corpus 形态）——
function flatEvents() {
  return [
    { seq: 7, type: "user/message", time: 1, data: { id: "msg-dup-7", content: [{ type: "text", text: "DUP" }], source: { kind: "user" } } },
    { seq: 17, type: "user/message", time: 2, data: { id: "msg-dup-17", content: [{ type: "text", text: "DUP" }], source: { kind: "user" } } },
    { seq: 27, type: "user/message", time: 3, data: { id: "msg-cjk-27", content: [{ type: "text", text: "中文😀abc" }], source: { kind: "user" } } },
    { seq: 37, type: "assistant/message", time: 4, data: { turn: 3, step: 1, message: { content: [{ type: "text", text: "前 **加粗强调** 后 😀\n第二行" }] } } },
    { seq: 47, type: "user/message", time: 5, data: { id: "msg-x-47", content: [{ type: "text", text: "EVENT-A" }], source: { kind: "user" } } },
  ];
}

function snap() {
  return snapshotFromEvents(flatEvents());
}

// —— items ——
function makeItemObj({ snapshot, comment, sourcePayload }) {
  const block = serializeItem(makeItem({ kind: "source-aware", captureOrigin: SID, snapshot, comment: comment ?? "", sourcePayload }));
  const parsed = parseLaneBody(block);
  const node = parsed.nodes.find((n) => n.type === "item");
  if (!node) throw new Error("item did not parse");
  return node.item;
}

const locDup17 = buildLocator({ sessionId: SID, projectionVersion: 1, segments: [{ eventSeq: 17, start: 0, end: 3 }] });

console.log("— Notes behavior regression re-entry: anchorFromItem（A/B authored 无关）—");
{
  // A: authored 非空
  const itemA = makeItemObj({ snapshot: "DUP", comment: "my note here", sourcePayload: locDup17 });
  const a = anchorFromItem(itemA);
  ok("A1 非空 authored item → ok + locator", a.ok === true && a.locator.segments[0].eventSeq === 17);
  // B: authored 空（makeItem comment 空 → parse 无 comment 字段）
  const itemB = makeItemObj({ snapshot: "DUP", comment: "", sourcePayload: locDup17 });
  ok("B1 空 authored item（无 comment 字段）→ ok + 同一 locator", itemB.comment === undefined);
  const b = anchorFromItem(itemB);
  ok("B2 A/B 同 locator（re-entry 不依赖 authored text）", b.ok === true && JSON.stringify(a.locator) === JSON.stringify(b.locator));
  // 直接对象（不经序列化）也工作
  const direct = anchorFromItem({ kind: "source-aware", captureOrigin: SID, snapshot: "DUP", sourcePayload: locDup17 });
  ok("A3 直接 item 对象 → ok", direct.ok === true);
  const noAnchor = anchorFromItem({ kind: "source-independent", captureOrigin: SID, comment: "x" });
  ok("A4 source-independent → NO_SOURCE_ANCHOR", noAnchor.ok === false && noAnchor.code === "NO_SOURCE_ANCHOR");
  const noPayload = anchorFromItem({ kind: "source-aware", captureOrigin: SID, snapshot: "DUP" });
  ok("A5 source-aware 无 payload → NO_ANCHOR_LOCATOR", noPayload.ok === false && noPayload.code === "NO_ANCHOR_LOCATOR");
}

console.log("— Notes behavior regression re-entry: validateLocatorShape（I 兼容性 truthful）—");
{
  ok("I1 合法 locator → ok", validateLocatorShape(locDup17).ok === true);
  const badProj = { ...locDup17, projectionVersion: 99 };
  const v1 = validateLocatorShape(badProj);
  ok("I2 unsupported projection → INCOMPATIBLE_PROJECTION（不重解）", v1.ok === false && v1.code === "INCOMPATIBLE_PROJECTION" && /not interpretable/.test(v1.reason));
  const badShape = { ...locDup17, segments: [{ eventSeq: 17, start: 5, end: 2 }] };
  const v2 = validateLocatorShape(badShape);
  ok("I3 invalid shape → INCOMPATIBLE_LOCATOR", v2.ok === false && v2.code === "INCOMPATIBLE_LOCATOR");
}

console.log("— Notes behavior regression re-entry: resolveExactLocus —");
{
  const nodes = snap();
  // 单段 exact
  const r1 = resolveExactLocus(locDup17, nodes, SID, "DUP");
  ok("R1 exact 单段 → text DUP + perSegment", r1.ok === true && r1.text === "DUP" && r1.perSegment.length === 1 && r1.perSegment[0].text === "DUP");
  ok("R1 render hint（user → messageId msg-dup-17）", r1.ok && r1.perSegment[0].hint.messageId === "msg-dup-17");
  // C: duplicate 文本在 7 与 17 —— locator 只按 event 17 取（无 search/first-match）
  const rC = resolveExactLocus(locDup17, nodes, SID, "DUP");
  ok("C1 duplicate 文本 → 取 event17 的发生处（非 search/first-match）", rC.ok && rC.perSegment[0].hint.messageId === "msg-dup-17");
  const locDup7 = buildLocator({ sessionId: SID, projectionVersion: 1, segments: [{ eventSeq: 7, start: 0, end: 3 }] });
  const rC2 = resolveExactLocus(locDup7, nodes, SID, "DUP");
  ok("C2 指向 event7 → 取 event7（msg-dup-7）", rC2.ok && rC2.perSegment[0].hint.messageId === "msg-dup-7");
  // D: CJK + emoji code-point extent
  const locCjk = buildLocator({ sessionId: SID, projectionVersion: 1, segments: [{ eventSeq: 27, start: 0, end: 3 }] });
  const rD = resolveExactLocus(locCjk, nodes, SID, "中文😀");
  ok("D1 CJK+emoji [0,3) → 中文😀（按码点非字节）", rD.ok && rD.text === "中文😀" && [...rD.text].length === 3);
  const locCjk2 = buildLocator({ sessionId: SID, projectionVersion: 1, segments: [{ eventSeq: 27, start: 2, end: 4 }] });
  const rD2 = resolveExactLocus(locCjk2, nodes, SID, "😀a");
  ok("D2 CJK+emoji [2,4) → 😀a", rD2.ok && rD2.text === "😀a");
  // D: markdown v2（bold 跨节点）
  const mdVisible = "前 加粗强调 后 😀\n第二行";
  const mdText = "加粗强调";
  const mdStart = mdVisible.indexOf(mdText);
  const locMd = buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 37, start: mdStart, end: mdStart + [...mdText].length }] });
  const rMd = resolveExactLocus(locMd, nodes, SID, mdText);
  ok("D3 markdown v2 bold extent → 加粗强调（markdown 投影重建；hint 用真实 turn 3/step 1）", rMd.ok && rMd.text === "加粗强调" && rMd.perSegment[0].hint.turn === 3 && rMd.perSegment[0].hint.step === 1);
  // E: multi-segment cross-event 顺序
  const locX = buildLocator({ sessionId: SID, projectionVersion: 1, segments: [{ eventSeq: 47, start: 0, end: 4 }, { eventSeq: 27, start: 0, end: 2 }] });
  const rE = resolveExactLocus(locX, nodes, SID, "EVEN中文");
  ok("E1 multi-segment cross-event → EVEN中文（ordered）", rE.ok && rE.text === "EVEN中文" && rE.perSegment.length === 2 && rE.perSegment[1].hint.messageId === "msg-cjk-27");
  // session mismatch（跨 basis 拒绝）
  const rM = resolveExactLocus(locDup17, nodes, "session-wo4-9999", "DUP");
  ok("R2 snapshot session != locator session → SESSION_MISMATCH", rM.ok === false && rM.code === "SESSION_MISMATCH");
  // H: event 缺失 → truthful unavailable（不 search/rebind、无文本猜测）
  const locMissing = buildLocator({ sessionId: SID, projectionVersion: 1, segments: [{ eventSeq: 999, start: 0, end: 3 }] });
  const rH = resolveExactLocus(locMissing, nodes, SID, "missing");
  ok("H1 event 缺失 → REENTRY_EVENT_UNAVAILABLE（truthful，不 rebind）", rH.ok === false && rH.code === "REENTRY_EVENT_UNAVAILABLE");
  // extent 越界（事件在但旧 extent 超当前投影长度）→ incompatible
  const locExt = { ...locDup17, segments: [{ eventSeq: 17, start: 0, end: 50 }] };
  const rExt = resolveExactLocus(locExt, nodes, SID, "DUP");
  ok("R3 extent 越界 → REENTRY_EXTENT_INCOMPATIBLE（不用当前投影重解）", rExt.ok === false && rExt.code === "REENTRY_EXTENT_INCOMPATIBLE");
  // Historical S binding: the persisted selected text is an independent
  // capture-time input. A locator resolving current Y must not be presented as
  // an exact re-entry for historical X.
  const driftEvents = flatEvents().map((event) => event.seq === 17
    ? { ...event, data: { ...event.data, content: [{ type: "text", text: "NEW" }] } }
    : event);
  const driftNodes = snapshotFromEvents(driftEvents);
  const rDrift = resolveExactLocus(locDup17, driftNodes, SID, "DUP");
  ok("S-binding current Y != persisted X → HISTORICAL_S_MISMATCH（不冒充 exact）", rDrift.ok === false && rDrift.code === "HISTORICAL_S_MISMATCH" && rDrift.historicalSnapshot === "DUP" && rDrift.currentSourceText === "NEW" && rDrift.perSegment?.[0]?.text === "NEW" && rDrift.perSegment?.[0]?.hint?.messageId === "msg-dup-17");
  const rNoSnapshot = resolveExactLocus(locDup17, nodes, SID);
  ok("S-binding 缺少 persisted S → HISTORICAL_S_REQUIRED（fail closed）", rNoSnapshot.ok === false && rNoSnapshot.code === "HISTORICAL_S_REQUIRED");
  // G: engine 无 renderer 依赖——exact read 独立成功；返回不含任何 highlight 声称
  ok("G1 exact read 与 renderer 无关且无 highlight 字段", r1.ok && !("highlighted" in r1) && !("render" in r1));
}

console.log("— Notes behavior regressionv3: message identity re-entry —");
{
  const identity = buildMessageIdentity({ sessionId: SID, messageId: "msg-dup-17" });
  const moved = snapshotFromEvents(flatEvents().map((event) => event.data.id === "msg-dup-17" ? { ...event, seq: 701 } : event));
  const exact = resolveExactLocus(identity, moved, SID, "DUP");
  ok("identity follows Message.id after eventSeq movement", exact.ok && exact.text === "DUP" && exact.perSegment[0].eventSeq === 701 && exact.perSegment[0].start === 0 && exact.perSegment[0].end === 3 && exact.perSegment[0].exactSpan === undefined);
  ok("identity re-entry exposes messageId cue", exact.ok && exact.perSegment[0].hint.messageId === "msg-dup-17");
  const partialEvents = [...flatEvents(), { seq: 57, type: "user/message", time: 6, data: { id: "msg-partial-57", content: [{ type: "text", text: "prefix target suffix" }], source: { kind: "user" } } }];
  const partial = resolveExactLocus(buildMessageIdentity({ sessionId: SID, messageId: "msg-partial-57" }), snapshotFromEvents(partialEvents), SID, "target");
  ok("identity partial S unique → exact current cue", partial.ok === true && partial.text === "target" && partial.matchCount === 1 && partial.cueKind === "exact" && partial.perSegment.length === 1 && partial.perSegment[0].start === 7 && partial.perSegment[0].end === 13 && partial.perSegment[0].exactSpan === undefined);
  const duplicatePartial = resolveExactLocus(buildMessageIdentity({ sessionId: SID, messageId: "msg-partial-57" }), snapshotFromEvents([...flatEvents(), { seq: 57, type: "user/message", time: 6, data: { id: "msg-partial-57", content: [{ type: "text", text: "target / target" }], source: { kind: "user" } } }]), SID, "target");
  ok("identity partial S duplicate → all exact current cues", duplicatePartial.ok === true && duplicatePartial.matchCount === 2 && duplicatePartial.cueKind === "exact" && duplicatePartial.perSegment.length === 2 && duplicatePartial.perSegment.every((part) => part.hint.messageId === "msg-partial-57") && duplicatePartial.perSegment[0].start === 0 && duplicatePartial.perSegment[0].end === 6 && duplicatePartial.perSegment[1].start === 9 && duplicatePartial.perSegment[1].end === 15);
  const crossMessage = resolveExactLocus(buildMessageIdentity({ sessionId: SID, messageId: "msg-partial-57" }), snapshotFromEvents([...flatEvents(), { seq: 57, type: "user/message", time: 6, data: { id: "msg-partial-57", content: [{ type: "text", text: "other message" }], source: { kind: "user" } } }, { seq: 67, type: "user/message", time: 7, data: { id: "msg-other-67", content: [{ type: "text", text: "target" }], source: { kind: "user" } } }]), SID, "target");
  ok("identity partial S never rebinds to another message", crossMessage.ok === false && crossMessage.code === "HISTORICAL_S_MISMATCH" && crossMessage.perSegment?.length === 1 && crossMessage.perSegment[0].hint.messageId === "msg-partial-57");
  const projectionUnavailable = resolveExactLocus(buildMessageIdentity({ sessionId: SID, messageId: "msg-unprojectable-57" }), snapshotFromEvents([...flatEvents(), { seq: 57, type: "user/message", time: 6, data: { id: "msg-unprojectable-57", content: [{ type: "image", url: "opaque" }], source: { kind: "user" } } }]), SID, "target");
  ok("identity projection unavailable → source success with broader cue", projectionUnavailable.ok === true && projectionUnavailable.projectionUnavailable === true && projectionUnavailable.perSegment[0].exactSpan === false);
  const assistantPartial = resolveExactLocus(buildMessageIdentity({ sessionId: SID, messageId: "msg-assistant-67" }), snapshotFromEvents([...flatEvents(), { seq: 67, type: "assistant/message", time: 7, data: { turn: 5, step: 2, message: { id: "msg-assistant-67", content: [{ type: "text", text: "assistant prefix target suffix" }] } } }]), SID, "target");
  ok("assistant identity partial S → existing turn/step renderer cue", assistantPartial.ok === true && assistantPartial.matchCount === 1 && assistantPartial.perSegment[0].hint.turn === 5 && assistantPartial.perSegment[0].hint.step === 2 && assistantPartial.perSegment[0].hint.messageId === undefined);
  const drift = resolveExactLocus(identity, snapshotFromEvents(flatEvents().map((event) => event.data.id === "msg-dup-17" ? { ...event, data: { ...event.data, content: [{ type: "text", text: "CHANGED" }] } } : event)), SID, "DUP");
  ok("identity reliable projection contradiction → HISTORICAL_S_MISMATCH", drift.ok === false && drift.code === "HISTORICAL_S_MISMATCH" && drift.historicalSnapshot === "DUP");
  const ambiguous = resolveExactLocus(identity, snapshotFromEvents([...flatEvents(), { ...flatEvents()[0], seq: 777, data: { ...flatEvents()[0].data, id: "msg-dup-17" } }]), SID, "DUP");
  ok("duplicate Message.id is ambiguous", ambiguous.ok === false && ambiguous.code === "REENTRY_SOURCE_IDENTITY_AMBIGUOUS");
}

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
