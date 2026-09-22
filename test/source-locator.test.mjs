// Notes behavior regression selection → locator / projection tests（v2）
import {
  projectVisibleText, buildLocator, serializeLocator, parseLocator, resolveLocator,
  locatorSlicesMatch, normalizeSelectionExtent, ProjectionError, PROJECTION_VERSION,
  PROJECTION_VERSION_MARKDOWN,
  isValidLocator,
  buildMessageIdentity,
  isValidMessageIdentity,
  isValidSourcePayload,
} from "../lib/source-locator.js";
import {
  makeItem, serializeItem, serializeLaneBody, parseLaneBody, KIND_SOURCE_AWARE,
} from "../lib/structured-item.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const SID = "session-abcdefgh";
const EVENTS = {
  1: [{ type: "text", text: "第一句中文。" }],
  2: [{ type: "text", text: "duplicate duplicate" }],
  3: [{ type: "text", text: "😀 emoji 🎉 混合" }],
  4: [{ type: "text", text: "跨节点" }, { type: "text", text: "第二节点" }],
  5: [{ type: "text", text: "marker 行: --- dsh-note v1 end\n与 begin" }],
};
const SESSIONS = { [SID]: EVENTS };
const source = (sid, seq) => SESSIONS[sid]?.[seq];

console.log("— P0: durable message identity —");
{
  const identity = buildMessageIdentity({ sessionId: SID, messageId: "message-stable-1" });
  ok("message identity 只含 sessionId + messageId", JSON.stringify(identity) === '{"sessionId":"session-abcdefgh","messageId":"message-stable-1"}');
  ok("message identity shape valid", isValidMessageIdentity(identity) && isValidSourcePayload(identity));
  ok("message identity rejects missing messageId", !isValidMessageIdentity({ sessionId: SID }));
  ok("message identity rejects coordinate fields as identity proof", !isValidMessageIdentity({ ...identity, eventSeq: 1 }));
}

console.log("— P1: projection 确定性 + R2 严格化 —");
{
  ok("text blocks 拼接", projectVisibleText(EVENTS[1]) === "第一句中文。");
  ok("CJK 码点", [...projectVisibleText(EVENTS[1])].length === 6);
  ok("emoji 按码点", [...projectVisibleText(EVENTS[3])].length === 12);
  ok("marker 行原样投影", projectVisibleText(EVENTS[5]) === "marker 行: --- dsh-note v1 end\n与 begin");
  ok("非数组 content → ProjectionError", (() => { try { projectVisibleText(null); return false; } catch (e) { return e instanceof ProjectionError; } })());
  ok("非 text block → UNSUPPORTED_CONTENT_BLOCK（不猜 hidden/unselectable）", (() => { try { projectVisibleText([{ type: "tool" }]); return false; } catch (e) { return e.code === "UNSUPPORTED_CONTENT_BLOCK"; } })());
  ok("mixed content → UNSUPPORTED_CONTENT_BLOCK（不猜 renderer 投影）", (() => { try { projectVisibleText([{ type: "tool" }, { type: "text", text: "正文" }]); return false; } catch (e) { return e.code === "UNSUPPORTED_CONTENT_BLOCK"; } })());
  ok("text block 缺 text → INVALID_EVENT_CONTENT", (() => { try { projectVisibleText([{ type: "text" }]); return false; } catch (e) { return e instanceof ProjectionError; } })());
  ok("unsupported version → throw", throws(() => projectVisibleText(EVENTS[1], 999)));
}

console.log("— P2: locator 构造/解析（R4 严格 + R6 plain data）—");
{
  const loc = buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 2 }] });
  ok("locator plain-data", JSON.stringify(loc).includes('"segments"') && !JSON.stringify(loc).includes("Range"));
  ok("serialize/parse round-trip", JSON.stringify(parseLocator(serializeLocator(loc))) === JSON.stringify(loc));
  ok("短 sessionId → throw", throws(() => buildLocator({ sessionId: "s1", segments: [{ eventSeq: 1, start: 0, end: 1 }] })));
  ok("非法 sessionId → throw", throws(() => buildLocator({ sessionId: "../evil", segments: [{ eventSeq: 1, start: 0, end: 1 }] })));
  ok("负 eventSeq → throw", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: -1, start: 0, end: 1 }] })));
  ok("小数 eventSeq → throw", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1.5, start: 0, end: 1 }] })));
  ok("start>end → throw", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 5, end: 2 }] })));
  ok("空 extent start===end → throw（selected text 必须非空）", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 2, end: 2 }] })));
  ok("空 segments → throw", throws(() => buildLocator({ sessionId: SID, segments: [] })));
  ok("rendererHint 函数 → throw", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: () => {} })));
  ok("rendererHint 循环引用 → throw", throws(() => { const o = {}; o.self = o; return buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: o }); }));
  ok("rendererHint undefined 字段 → throw", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: { a: undefined } })));
  ok("rendererHint plain record 允许", (() => { const l = buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: { node: "x", kind: 3 } }); return l.rendererHint.node === "x"; })());
  ok("rendererHint DOM Element → throw（R6）", throws(() => { const el = { nodeType: 1, nodeName: "DIV", dataset: {}, closest: () => null }; return buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: el }); }));
  ok("rendererHint class 实例 → throw（R6）", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: new (class Foo { constructor() { this.x = 1; } })() })));
}

console.log("— Source behavior regression: strict locator-only reconstruction（绑定 sessionId，R3）—");
{
  const loc = buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 1, end: 5 }] });
  const r = resolveLocator(loc, source);
  ok("locator-only 精确重构", r.text === "一句中文");
  const wrongSession = { ...loc, sessionId: "session-other1234" };
  ok("A locator + B session source → EVENT_NOT_FOUND", (() => { try { resolveLocator(wrongSession, source); return false; } catch (e) { return e.code === "EVENT_NOT_FOUND"; } })());
  ok("locator 无 sessionId → INVALID_LOCATOR", (() => { try { resolveLocator({ projectionVersion: 1, segments: [{ eventSeq: 1, start: 0, end: 1 }] }, source); return false; } catch (e) { return e.code === "INVALID_LOCATOR"; } })());
  ok("resolve 拒绝绕过 buildLocator 的空 extent", (() => { try { resolveLocator({ projectionVersion: 1, sessionId: SID, segments: [{ eventSeq: 1, start: 2, end: 2 }] }, source); return false; } catch (e) { return e.code === "INVALID_LOCATOR"; } })());
  ok("resolve 拒绝空 segments", (() => { try { resolveLocator({ projectionVersion: 1, sessionId: SID, segments: [] }, source); return false; } catch (e) { return e.code === "INVALID_LOCATOR"; } })());
  ok("resolve 拒绝负 start", (() => { try { resolveLocator({ projectionVersion: 1, sessionId: SID, segments: [{ eventSeq: 1, start: -1, end: 1 }] }, source); return false; } catch (e) { return e.code === "INVALID_LOCATOR"; } })());
  ok("duplicate text 第一处", resolveLocator(buildLocator({ sessionId: SID, segments: [{ eventSeq: 2, start: 0, end: 9 }] }), source).text === "duplicate");
  ok("duplicate text 第二处", resolveLocator(buildLocator({ sessionId: SID, segments: [{ eventSeq: 2, start: 10, end: 19 }] }), source).text === "duplicate");
  ok("emoji surrogate 码点", resolveLocator(buildLocator({ sessionId: SID, segments: [{ eventSeq: 3, start: 0, end: 2 }] }), source).text === "😀 ");
}

console.log("— behavior regression: capture-time consistency —");
{
  const loc = buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 2, end: 6 }] });
  ok("slices === selected text", locatorSlicesMatch(loc, source, "句中文。"));
  ok("不匹配 → false（不 search）", locatorSlicesMatch(loc, source, "别的内容") === false);
}

console.log("— P5: cross-event ordered segments —");
{
  const loc = buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 3 }, { eventSeq: 4, start: 0, end: 3 }, { eventSeq: 4, start: 4, end: 8 }] });
  const r = resolveLocator(loc, source);
  ok("cross-event 拼接", r.text === "第一句跨节点第二节点");
  ok("顺序保持", r.segments.map((s) => s.eventSeq).join(",") === "1,4,4");
}

console.log("— P6: selection 归一（R4 严格 + 跨 event 拒绝）—");
{
  ok("backward 归一", JSON.stringify(normalizeSelectionExtent({ anchorOffset: 5, focusOffset: 2 })) === '{"start":2,"end":5}');
  ok("forward 归一", JSON.stringify(normalizeSelectionExtent({ anchorOffset: 1, focusOffset: 3 })) === '{"start":1,"end":3}');
  ok("空选区", JSON.stringify(normalizeSelectionExtent({ anchorOffset: 3, focusOffset: 3 })) === '{"start":3,"end":3}');
  ok("小数 offset → throw", throws(() => normalizeSelectionExtent({ anchorOffset: 1.5, focusOffset: 2 })));
  ok("NaN offset → throw", throws(() => normalizeSelectionExtent({ anchorOffset: NaN, focusOffset: 2 })));
  ok("Infinity offset → throw", throws(() => normalizeSelectionExtent({ anchorOffset: Infinity, focusOffset: 2 })));
  ok("负 offset → throw", throws(() => normalizeSelectionExtent({ anchorOffset: -1, focusOffset: 2 })));
  ok("跨 event 输入 → CROSS_EVENT_UNSUPPORTED", (() => { try { normalizeSelectionExtent({ anchorIndex: 0, focusIndex: 1, anchorOffset: 1, focusOffset: 2 }); return false; } catch (e) { return e.code === "CROSS_EVENT_UNSUPPORTED"; } })());
}

console.log("— P7: truthful failure（无 search/rebind）—");
{
  ok("event 不存在 → EVENT_NOT_FOUND", throws(() => resolveLocator(buildLocator({ sessionId: SID, segments: [{ eventSeq: 99, start: 0, end: 1 }] }), source)));
  ok("extent 越界 → EXTENT_INVALID", throws(() => resolveLocator(buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 999 }] }), source)));
  ok("unsupported version resolve → throw", throws(() => resolveLocator({ projectionVersion: 999, sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }] }, source)));
}

console.log("— P8: Notes behavior regression sourcePayload 集成（R5 locator schema 验证）—");
{
  const locator = buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 1, end: 5 }] });
  const item = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID, snapshot: "原文", comment: "评论", sourcePayload: locator });
  const t = serializeItem(item) + "\n";
  const p = parseLaneBody(t);
  const i = p.nodes.find((n) => n.type === "item").item;
  ok("locator 经 structured item round-trip", JSON.stringify(i.sourcePayload) === JSON.stringify(locator));
  ok("round-trip 稳定", serializeLaneBody(parseLaneBody(t)) === t);
  ok("持久化 locator 可 strict 重构", resolveLocator(i.sourcePayload, source).text === "一句中文");
  ok("invalid source-payload makeItem → throw（R11）", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID, snapshot: "s", sourcePayload: { not: "a locator" } })));
  // 手工构造含 invalid source-payload 的块 → parse raw 保守
  const tBad = "--- dsh-note v1 begin\ndsh-meta kind: source-aware\ndsh-meta origin: " + SID + "\ndsh-meta snapshot-length: 1\ndsh-meta source-payload: {not-a-locator}\n--- dsh-body\nx\n--- dsh-note v1 end\n";
  const pBad = parseLaneBody(tBad);
  const iBad = pBad.nodes.find((n) => n.type === "item");
  ok("invalid source-payload → 不设为 sourcePayload", iBad && iBad.item.sourcePayload === undefined);
  ok("invalid source-payload raw 保留（round-trip）", serializeLaneBody(pBad) === tBad);
  const futurePayload = { projectionVersion: 99, sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }] };
  const fItem = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID, snapshot: "s", sourcePayload: futurePayload });
  const tF = serializeItem(fItem) + "\n";
  const pF = parseLaneBody(tF);
  const iF = pF.nodes.find((n) => n.type === "item");
  ok("future-version payload → 不按当前解析", iF.item.sourcePayload === undefined);
  ok("future-version payload raw 保留（bytes 不丢）", serializeLaneBody(pF) === tF);
  ok("isValidLocator 拒绝 future version", isValidLocator(futurePayload) === false);
  ok("isValidLocator 接受当前 locator", isValidLocator(locator) === true);
  ok("isValidLocator 拒绝空 extent", isValidLocator({ ...locator, segments: [{ eventSeq: 1, start: 2, end: 2 }] }) === false);
  ok("rendererHint NaN → throw", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: { score: NaN } })));
  ok("rendererHint Infinity → throw", throws(() => buildLocator({ sessionId: SID, segments: [{ eventSeq: 1, start: 0, end: 1 }], rendererHint: { score: Infinity } })));
  ok("malformed supported v2 locator → INVALID_LOCATOR（不误报 unsupported）", (() => { try { parseLocator(JSON.stringify({ projectionVersion: PROJECTION_VERSION_MARKDOWN, sessionId: SID, segments: [] })); return false; } catch (e) { return e.code === "INVALID_LOCATOR"; } })());
}

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
