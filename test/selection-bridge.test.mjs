// Notes behavior regression selection bridge tests（happy-dom DOM 层，R1）
import { Window } from "happy-dom";
import { selectionToSegments, rangeExtentInContainer, nodeKeyToEvent, containerBasisText } from "../lib/selection-bridge.js";
import { buildLocator, resolveLocator, locatorSlicesMatch, ProjectionError, PROJECTION_VERSION_MARKDOWN, projectVisibleMarkdownContent } from "../lib/source-locator.js";
import { projectVisibleText } from "../lib/source-locator.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const SID = "session-abcdefgh";
// snapshot nodes：assistant-step turn:step / input-message messageId / tool-call callId
const SNAPSHOT = [
  { kind: "assistant", turn: 3, step: 5, seq: 101, content: [{ type: "text", text: "第一句中文。" }] },
  { kind: "assistant", turn: 4, step: 1, seq: 105, content: [{ type: "text", text: "duplicate duplicate" }] },
  { kind: "user", messageId: "m-9", seq: 99, content: [{ type: "text", text: "😀 emoji 🎉" }] },
  { kind: "assistant", turn: 5, step: 2, seq: 110, content: [{ type: "text", text: "跨节点" }, { type: "text", text: "第二节点" }] },
];
const contentBySeq = (sid, seq) => {
  if (sid !== SID) return undefined;
  const n = SNAPSHOT.find((x) => x.seq === seq);
  return n ? n.content : undefined;
};

function makeWindow(html) {
  const w = new Window();
  w.document.body.innerHTML = html;
  return w;
}

console.log("— B1: 单容器 selection（CJK 文本节点内）—");
{
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:3:5">第一句中文。</div>');
  const d = w.document;
  const container = d.querySelector("[data-chat-anchor-key]");
  const textNode = container.firstChild;
  const range = d.createRange();
  range.setStart(textNode, 1);
  range.setEnd(textNode, 4);
  const ext = rangeExtentInContainer(range, container, d);
  ok("extent 码点正确", ext.startCP === 1 && ext.endCP === 4 && ext.totalCP === 6);
  const seg = selectionToSegments(range, d, SNAPSHOT);
  ok("单 segment", seg.segments.length === 1);
  ok("eventSeq = 101（assistant-step 3:5）", seg.segments[0].eventSeq === 101);
  ok("extent 与投影一致", seg.segments[0].start === 1 && seg.segments[0].end === 4);
  ok("selectedText = 一句中", seg.selectedText === "一句中");
  const loc = buildLocator({ sessionId: SID, segments: seg.segments });
  ok("locator-only 重构 = 选区文本", resolveLocator(loc, contentBySeq).text === seg.selectedText);
  ok("capture-time consistency", locatorSlicesMatch(loc, contentBySeq, seg.selectedText));
}

console.log("— B2: 同容器跨 DOM 节点（span）—");
{
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:3:5">第一句<span>第二句</span>结尾</div>');
  const d = w.document;
  const span = d.querySelector("span");
  const spanText = span.firstChild;
  const leading = d.querySelector("[data-chat-anchor-key]").firstChild; // 第一句
  const range = d.createRange();
  range.setStart(leading, 0);
  range.setEnd(spanText, 2);
  const ext = rangeExtentInContainer(range, d.querySelector("[data-chat-anchor-key]"), d);
  ok("跨节点 extent 累计", ext.startCP === 0 && ext.endCP === 5, JSON.stringify(ext));
  // DOM basis（"第一句第二句结尾"）必须与 v1 projection（content 原文拼接）一致
  const snapB2 = [
    { kind: "assistant", turn: 3, step: 5, seq: 101, content: [{ type: "text", text: "第一句第二句结尾" }] },
  ];
  const seg = selectionToSegments(range, d, snapB2);
  ok("单 event segment（跨节点同容器）", seg.segments.length === 1 && seg.segments[0].eventSeq === 101);
  ok("selectedText = 第一句第二", seg.selectedText === "第一句第二");
}

console.log("— B3: 跨 event selection（两容器）—");
{
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:3:5">第一句中文。</div><div data-chat-anchor-key="user:m-9">😀 emoji 🎉</div>');
  const d = w.document;
  const anchors = d.querySelectorAll("[data-chat-anchor-key]");
  const first = anchors[0].firstChild;
  const last = anchors[1].firstChild;
  const range = d.createRange();
  range.setStart(first, 0);
  range.setEnd(last, 5);
  const seg = selectionToSegments(range, d, SNAPSHOT);
  ok("两 ordered segments", seg.segments.length === 2);
  ok("event 顺序 = 101, 99", seg.segments[0].eventSeq === 101 && seg.segments[1].eventSeq === 99);
  ok("首容器全文 + 末容器部分", seg.segments[0].start === 0 && seg.segments[0].end === 6 && seg.segments[1].start === 0 && seg.segments[1].end === 4);
  ok("selectedText 拼接", seg.selectedText === "第一句中文。😀 em");
  const loc = buildLocator({ sessionId: SID, segments: seg.segments });
  ok("cross-event locator-only 重构", resolveLocator(loc, contentBySeq).text === "第一句中文。😀 em");
}

console.log("— B4: reversed selection（backward range）—");
{
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:3:5">第一句中文。</div>');
  const d = w.document;
  const tn = d.querySelector("[data-chat-anchor-key]").firstChild;
  // backward selection：DOM Range 始终有序（start<=end）；方向信息在 anchor/focus，
  // extent 计算不依赖方向。构造有序 range 验证精确性。
  const range = d.createRange();
  range.setStart(tn, 1);
  range.setEnd(tn, 4);
  const ext = rangeExtentInContainer(range, d.querySelector("[data-chat-anchor-key]"), d);
  ok("有序 range extent 精确", ext.startCP === 1 && ext.endCP === 4, JSON.stringify(ext));
  const seg = selectionToSegments(range, d, SNAPSHOT);
  ok("选区仍精确", seg.selectedText === "一句中");
}

console.log("— B5: duplicate text（同容器重复，精确 extent）—");
{
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:4:1">duplicate duplicate</div>');
  const d = w.document;
  const tn = d.querySelector("[data-chat-anchor-key]").firstChild;
  const range = d.createRange();
  range.setStart(tn, 10);
  range.setEnd(tn, 19);
  const seg = selectionToSegments(range, d, SNAPSHOT);
  ok("第二处 duplicate 精确（无搜索）", seg.selectedText === "duplicate");
}

console.log("— B6: Markdown 渲染结构（锚容器内多块）—");
{
  // renderer 协议：每 text block 渲染为容器直接子元素（<p>）；block 内联碎片在 <p> 内
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:5:2"><p>加粗 <strong>加粗</strong></p><p>斜体 <em>斜体</em></p></div>');
  const d = w.document;
  const strong = d.querySelector("strong").firstChild; // 第一 block 内
  const em = d.querySelector("em").firstChild;         // 第二 block 内
  const range = d.createRange();
  range.setStart(strong, 0);
  range.setEnd(em, 2);
  const ext = rangeExtentInContainer(range, d.querySelector("[data-chat-anchor-key]"), d);
  // basis = "加粗 加粗" + \n + "斜体 斜体"；strong(2)…第一 p 内到 em：p1 全文 5 + \n + em 前 2 = 8
  ok("渲染结构 extent（含 block 间 \\n）", ext.startCP === 3 && ext.endCP === 11, JSON.stringify(ext));
}

console.log("— B7: 无法定位 → truthful failure —");
{
  const w = makeWindow("<div>没有 anchor</div>");
  const d = w.document;
  const tn = d.body.firstChild.firstChild;
  const range = d.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, 1);
  ok("无 data-chat-anchor-key → throw", throws(() => selectionToSegments(range, d, SNAPSHOT)));
}

console.log("— B8: nodeKeyToEvent identity —");
{
  ok("assistant-step 匹配", nodeKeyToEvent("assistant-step:3:5", SNAPSHOT).seq === 101);
  ok("user messageId 匹配", nodeKeyToEvent("user:m-9", SNAPSHOT).seq === 99);
  ok("tool-call 无匹配 → reason", nodeKeyToEvent("tool-call:cc-1", SNAPSHOT).reason !== undefined);
  ok("bad key → reason", nodeKeyToEvent("nokey", SNAPSHOT).reason !== undefined);
}

console.log("— B9: emoji surrogate 跨节点 —");
{
  const w = makeWindow('<div data-chat-anchor-key="user:m-9">😀 emoji 🎉</div>');
  const d = w.document;
  const tn = d.querySelector("[data-chat-anchor-key]").firstChild;
  const range = d.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, 5); // UTF-16 5 = 😀(2)+空格(1)+e(1)+m(1) → 4 码点 "😀 em"
  const ext = rangeExtentInContainer(range, d.querySelector("[data-chat-anchor-key]"), d);
  ok("emoji surrogate 码点 offset", ext.endCP === 4);
  const seg = selectionToSegments(range, d, SNAPSHOT);
  ok("selectedText = 😀 em", seg.selectedText === "😀 em");
}


console.log("— R8: DOM 坐标与 projection 坐标一致性（跨 block）—");
{
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:5:2"><p>跨节点</p><p>第二节点</p></div>');
  const d = w.document;
  const p1 = d.querySelector("p").firstChild;          // "跨节点"
  const p2 = d.querySelectorAll("p")[1].firstChild;    // "第二节点"
  const range = d.createRange();
  range.setStart(p1, 0);
  range.setEnd(p2, 4);
  const ext = rangeExtentInContainer(range, d.querySelector("[data-chat-anchor-key]"), d);
  ok("跨 block extent 含中间 \\n", ext.startCP === 0 && ext.endCP === 8, JSON.stringify(ext)); // 跨节点(3)+\\n(1)+第二节点(4)
  const seg = selectionToSegments(range, d, SNAPSHOT);
  ok("跨 block selection → segments", seg.segments.length === 1 && seg.segments[0].eventSeq === 110);
  ok("selectedText = 跨节点\\n第二节点", seg.selectedText === "跨节点\n第二节点");
  // projection 一致性：snapshot content = [{text:跨节点},{text:第二节点}] → projection "跨节点\n第二节点"
  const loc = buildLocator({ sessionId: SID, segments: seg.segments });
  const resolved = resolveLocator(loc, contentBySeq);
  ok("locator-only 重构 == selection == projection", resolved.text === seg.selectedText && resolved.text === "跨节点\n第二节点");
}

console.log("— R9: eventSeq = 0 合法 —");
{
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:1:1">seq0</div>');
  const d = w.document;
  const tn = d.querySelector("[data-chat-anchor-key]").firstChild;
  const range = d.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, 2);
  const snap0 = [{ kind: "assistant", turn: 1, step: 1, seq: 0, content: [{ type: "text", text: "seq0" }] }];
  const seg = selectionToSegments(range, d, snap0);
  ok("seq=0 的 event 正常解析", seg.segments[0].eventSeq === 0);
  const loc = buildLocator({ sessionId: SID, segments: seg.segments });
  ok("seq=0 locator resolve", resolveLocator(loc, (sid, seq) => sid === SID && seq === 0 ? [{ type: "text", text: "seq0" }] : undefined).text === "se");
}

console.log("— R10: Element boundary Range —");
{
  const snapR10 = [
    { kind: "assistant", turn: 5, step: 2, seq: 110, content: [{ type: "text", text: "第一块" }, { type: "text", text: "第二块" }, { type: "text", text: "第三块" }] },
  ];
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:5:2"><p>第一块</p><p>第二块</p><p>第三块</p></div>');
  const d = w.document;
  const anchor = d.querySelector("[data-chat-anchor-key]");
  const range = d.createRange();
  range.setStart(anchor, 0); // Element boundary（startContainer = 容器元素）
  range.setEnd(anchor, 2);   // 覆盖前两个 <p>
  const ext = rangeExtentInContainer(range, anchor, d);
  ok("Element boundary 按 child offset 累计", ext.startCP === 0 && ext.endCP === 7, JSON.stringify(ext)); // 第一块(3)+\\n+第二块(3)
}



console.log("— R10b: 嵌套 Element boundary（p 作为 start/endContainer）—");
{
  const snapR10b = [
    { kind: "assistant", turn: 5, step: 2, seq: 110, content: [{ type: "text", text: "第一块" }, { type: "text", text: "第二块" }] },
  ];
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:5:2"><p>第一块</p><p>第二块</p></div>');
  const d = w.document;
  const ps = d.querySelectorAll("p");
  const range = d.createRange();
  range.setStart(ps[0], 0); // startContainer = 第一个 p（嵌套元素）
  range.setEnd(ps[1], 1);   // endContainer = 第二个 p（嵌套元素），off=1（其第一子节点）
  const ext = rangeExtentInContainer(range, d.querySelector("[data-chat-anchor-key]"), d);
  ok("嵌套 Element boundary endCP = 7", ext.startCP === 0 && ext.endCP === 7, JSON.stringify(ext));
  const seg = selectionToSegments(range, d, snapR10b);
  ok("嵌套 boundary selection 精确", seg.selectedText === "第一块\n第二块");
}

console.log("— R10c: 更深嵌套（strong 在 p 内）—");
{
  const snapR10c = [
    { kind: "assistant", turn: 5, step: 2, seq: 110, content: [{ type: "text", text: "前中后" }, { type: "text", text: "第二" }] },
  ];
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:5:2"><p>前<strong>中</strong>后</p><p>第二</p></div>');
  const d = w.document;
  const strong = d.querySelector("strong");
  const secondP = d.querySelectorAll("p")[1];
  const range = d.createRange();
  range.setStart(strong.firstChild, 0); // strong 内文本 offset 0
  range.setEnd(secondP, 1);             // 第二个 p 作为 endContainer
  const ext = rangeExtentInContainer(range, d.querySelector("[data-chat-anchor-key]"), d);
  // basis = "前中后\n第二"；strong 在 p1 内（前(1)中(1)后(1)），strong 起始 = 1
  ok("深嵌套 boundary start=1", ext.startCP === 1, JSON.stringify(ext));
  ok("深嵌套 boundary endCP = 6", ext.endCP === 6, JSON.stringify(ext)); // 前中后(3)+\n+第二前1
}

console.log("— R12: tool-call/non-text projection 未被证明 → truthful reject —");{
  const w = makeWindow('<div data-chat-anchor-key="tool-call:cc-1">tool 输出</div>');
  const d = w.document;
  const tn = d.querySelector("[data-chat-anchor-key]").firstChild;
  const range = d.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, 4);
  const snapTool = [{ kind: "tool", callId: "cc-1", seq: 120, content: [{ type: "tool-call", callId: "cc-1" }, { type: "text", text: "tool 输出" }] }];
  const err = (() => { try { selectionToSegments(range, d, snapTool); return null; } catch (e) { return e.message; } })();
  ok("tool-call capture → 不猜 hidden，返回 projection failure", err !== null && /unsupported content block/i.test(err));
  // text-only 仍可 capture（DOM basis 与 content 一致）
  const snapText = [{ kind: "assistant", turn: 3, step: 5, seq: 101, content: [{ type: "text", text: "纯文本" }] }];
  const w2 = makeWindow('<div data-chat-anchor-key="assistant-step:3:5">纯文本</div>');
  const d2 = w2.document;
  const r2 = d2.createRange();
  r2.setStart(d2.querySelector("[data-chat-anchor-key]").firstChild, 0);
  r2.setEnd(d2.querySelector("[data-chat-anchor-key]").firstChild, 2);
  const seg2 = selectionToSegments(r2, d2, snapText);
  ok("text-only capture 正常", seg2.segments[0].eventSeq === 101);
}

console.log("— R13: v2 capture bridge（真实 DOM Selection → v2 locator → resolve）—");
{
  // renderer 一致性假设：rendered DOM 文本 == v2 projection 文本（DOM basis 与 projection 同坐标）
  const content = [{ type: "text", text: "加粗 **加粗** 和 [链接](u)" }];
  const snap = [{ kind: "assistant", turn: 3, step: 5, seq: 101, content }];
  const src = (sid, seq) => sid === SID && seq === 101 ? content : undefined;
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:3:5"><p>加粗 <strong>加粗</strong> 和 <a href="u">链接</a></p></div>');
  const d = w.document;
  // 一致性前置：DOM basis == v2 projection
  const basis = containerBasisText(d.querySelector("[data-chat-anchor-key]"), d);
  const proj = projectVisibleMarkdownContent(content).text;
  ok("rendered DOM basis == v2 projection（renderer 一致性）", basis === proj, JSON.stringify({ basis, proj }));
  // 真实 DOM Selection：选中 strong 内的 "加粗"（第 2 处）
  const strong = d.querySelector("strong").firstChild;
  const range = d.createRange();
  range.setStart(strong, 0);
  range.setEnd(strong, 2);
  const seg = selectionToSegments(range, d, snap, { projectionVersion: PROJECTION_VERSION_MARKDOWN });
  ok("v2 segments 单 event + extent 精确", seg.segments.length === 1 && seg.segments[0].start === 3 && seg.segments[0].end === 5, JSON.stringify(seg.segments));
  ok("v2 返回 projectionVersion", seg.projectionVersion === PROJECTION_VERSION_MARKDOWN);
  ok("v2 selectedText = 加粗", seg.selectedText === "加粗");
  const loc = buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: seg.segments });
  ok("v2 locator-only 重构 = 选中可见文本", resolveLocator(loc, src).text === "加粗");
  ok("v2 capture-time consistency", locatorSlicesMatch(loc, src, "加粗"));
}

console.log("— R14: v2 非 text block truthful reject + 非法 projectionVersion —");
{
  const snapTool = [{ kind: "assistant", turn: 3, step: 5, seq: 101, content: [{ type: "tool-call", callId: "cc-1" }, { type: "text", text: "x" }] }];
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:3:5"><p>x</p></div>');
  const d = w.document;
  const tn = d.querySelector("[data-chat-anchor-key] p").firstChild;
  const range = d.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, 1);
  const err = (() => { try { selectionToSegments(range, d, snapTool, { projectionVersion: PROJECTION_VERSION_MARKDOWN }); return null; } catch (e) { return e.message; } })();
  ok("v2 非 text block → 不猜 hidden，返回 projection failure", err !== null && /unsupported content block/i.test(err));
  const w2 = makeWindow('<div data-chat-anchor-key="assistant-step:3:5">x</div>');
  const d2 = w2.document;
  const r2 = d2.createRange();
  r2.setStart(d2.querySelector("[data-chat-anchor-key]").firstChild, 0);
  r2.setEnd(d2.querySelector("[data-chat-anchor-key]").firstChild, 1);
  const err2 = (() => { try { selectionToSegments(r2, d2, SNAPSHOT, { projectionVersion: 99 }); return null; } catch (e) { return e.message; } })();
  ok("非法 projectionVersion → 明确拒绝", err2 !== null && /unsupported projectionVersion/.test(err2));
}

console.log("— R15: 真实 renderer nodeKey 形态（<anchorSeq>:<kind><id>）适配 —");
{
  // 真实 DSH renderer 的 data-chat-anchor-key：
  //   assistant-step: `14:assistant-step1:1`（anchorSeq:kind turn:step）
  //   input-message:  `13:input-message<uuid>`（anchorSeq:kind uuid）
  //   tool-call:      `9:tool-call<callId>`
  const snap = [
    { kind: "assistant", turn: 1, step: 1, seq: 17, content: [{ type: "text", text: "assistant markdown" }] },
    { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 7, content: [{ type: "text", text: "user msg" }] },
    { kind: "tool", callId: "call-abc123", seq: 12, content: [{ type: "tool-call", callId: "call-abc123" }] },
  ];
  ok("assistant-step 真实形态 → seq 17", nodeKeyToEvent("14:assistant-step1:1", snap).seq === 17);
  ok("input-message 真实形态（uuid）→ seq 7", nodeKeyToEvent("13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35", snap).seq === 7);
  ok("tool-call 真实形态 → seq 12", nodeKeyToEvent("9:tool-callcall-abc123", snap).seq === 12);
  ok("旧桥形态 assistant-step:3:5 仍兼容", nodeKeyToEvent("assistant-step:3:5", SNAPSHOT).seq === 101);
  ok("旧桥形态 user:m-9 仍兼容", nodeKeyToEvent("user:m-9", SNAPSHOT).seq === 99);
  ok("真实形态 uuid 未匹配 → 明确 reason", nodeKeyToEvent("13:input-message00000000-0000-0000-0000-000000000000", snap).reason !== undefined);
  ok("真实形态无 kind 前缀 → 回退 prefix 为 kind（旧桥）", nodeKeyToEvent("nokey", SNAPSHOT).reason !== undefined);
}

console.log("— DOM basis 对齐验证 —");
{
  // 一致：DOM basis == projection → capture 成功
  const snapOk = [{ kind: "assistant", turn: 3, step: 5, seq: 101, content: [{ type: "text", text: "加粗 **加粗** 和 [链接](u)" }] }];
  const w = makeWindow('<div data-chat-anchor-key="assistant-step:3:5"><p>加粗 <strong>加粗</strong> 和 <a href="u">链接</a></p></div>');
  const d = w.document;
  const tn = d.querySelector("strong").firstChild;
  const range = d.createRange();
  range.setStart(tn, 0);
  range.setEnd(tn, 2);
  const seg = selectionToSegments(range, d, snapOk, { projectionVersion: PROJECTION_VERSION_MARKDOWN });
  ok("v2 一致 basis → capture 成功", seg.segments.length === 1, JSON.stringify(seg.segments));
  // 不一致：DOM basis ≠ projection（DOM 文本与 source 不对应）→ 明确拒绝
  const snapBad = [{ kind: "assistant", turn: 3, step: 5, seq: 101, content: [{ type: "text", text: "完全不同内容" }] }];
  const w2 = makeWindow('<div data-chat-anchor-key="assistant-step:3:5">加粗 **加粗**</div>');
  const d2 = w2.document;
  const r2 = d2.createRange();
  r2.setStart(d2.querySelector("[data-chat-anchor-key]").firstChild, 0);
  r2.setEnd(d2.querySelector("[data-chat-anchor-key]").firstChild, 2);
  const err = (() => { try { selectionToSegments(r2, d2, snapBad); return null; } catch (e) { return e.message; } })();
  ok("v1 不一致 basis → 明确拒绝（unmappable）", err !== null && /prefix-match/.test(err));
  // 时间戳附加：basis = projection + 附加（chrome span）→ extent 裁剪到 projection 长度
  // 结构（adversarial check：fixture 模拟真实 renderer——源码在内容分支 `_text` 内，时间戳在
  // 同一 `[data-time-hover-root]` 行容器的 actions 兄弟分支；判定不依赖 class/包装推断）
  const snapTs = [{ kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "第二句 普通文本" }] }];
  // 真实 renderer 形态：行容器 [data-time-hover-root]，内容分支 _text（无 button），
  // actions 分支含交互控件 <button type="button" aria-label="复制">（MessageIconActions）。
  const REAL_USER_HTML = (text, ts) =>
    `<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">` +
    `<div class="row" data-time-hover-root="true">` +
    `<div class="content"><div class="_text">${text}</div></div>` +
    `<div class="actions"><button type="button" aria-label="复制"></button><span class="timeStart">${ts}</span></div></div></div>`;
  const w3 = makeWindow(REAL_USER_HTML("第二句 普通文本", "05:08"));
  const d3 = w3.document;
  const anchor3 = d3.querySelector("[data-chat-anchor-key]");
  const tn3 = d3.querySelector("._text").firstChild; // 源文本节点（8 码点）
  const tsNode = d3.querySelector(".timeStart").firstChild; // 时间戳文本（5 码点）
  // basis = "第二句 普通文本" + "05:08"（同一直接子 DIV 内，无元素间 \n）
  // 单容器：源内容内选择
  const r3 = d3.createRange();
  r3.setStart(tn3, 0);
  r3.setEnd(tn3, 7);
  const seg3 = selectionToSegments(r3, d3, snapTs);
  ok("时间戳附加 basis → 源内容内 capture 成功", seg3.segments[0].start === 0 && seg3.segments[0].end === 7, JSON.stringify(seg3.segments));
  // 覆盖到 chrome span：尾部文本节点位于 source-bearing 子树（_text 包装）之外 →
  // 结构性正证 → chrome 排除，裁剪到投影长 8
  const r4 = d3.createRange();
  r4.setStart(tn3, 0);
  r4.setEnd(tsNode, 5); // 含时间戳（span 内文本）
  const seg4 = selectionToSegments(r4, d3, snapTs);
  ok("选中含 chrome span 时间戳 → 结构上在内容子树外 → 机械排除（裁剪到投影长）", seg4.segments[0].start === 0 && seg4.segments[0].end === 8, JSON.stringify(seg4.segments));
  ok("chrome 排除后 selectedText = 源内容（不含时间戳）", seg4.selectedText === "第二句 普通文本", JSON.stringify(seg4.selectedText));
  // 仅选 chrome span → 无 source 贡献 → 拒绝
  const r4b = d3.createRange();
  r4b.setStart(tsNode, 0);
  r4b.setEnd(tsNode, 5);
  const err4b = (() => { try { selectionToSegments(r4b, d3, snapTs); return null; } catch (e) { return e.message; } })();
  ok("仅选 chrome span → 拒绝（no source-bearing content）", err4b !== null && /no source-bearing content/.test(err4b));
  // 跨容器：首容器"隐式到尾"（Range 终点在其它容器）→ 尾部 chrome span 结构排除，source 保留
  const w4 = makeWindow(REAL_USER_HTML("第二句 普通文本", "05:08") + '<div data-chat-anchor-key="14:assistant-step1:1">assistant 内容</div>');
  const d4 = w4.document;
  const snapCross = [
    { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "第二句 普通文本" }] },
    { kind: "assistant", turn: 1, step: 1, seq: 17, content: [{ type: "text", text: "assistant 内容" }] },
  ];
  const uNode = d4.querySelector("._text").firstChild;
  const aNode = d4.querySelectorAll("[data-chat-anchor-key]")[1].firstChild;
  const r5 = d4.createRange();
  r5.setStart(uNode, 4);   // 源内容内 "普通" 起点
  r5.setEnd(aNode, 8);     // 终点在 assistant 容器（跨容器）→ user 隐式到尾含 chrome span
  const seg5 = selectionToSegments(r5, d4, snapCross);
  ok("跨容器首容器含 chrome span → 结构性排除，source 保留", seg5.segments[0].eventSeq === 99 && seg5.segments[0].start === 4 && seg5.segments[0].end === 8, JSON.stringify(seg5.segments));
  ok("跨容器两 segments（时间戳被排除）", seg5.segments.length === 2 && seg5.segments[1].eventSeq === 17, JSON.stringify(seg5.segments));
  // 对照：首容器无 renderer 附加（总长 == 投影长）→ 跨容器成功
  const w5 = makeWindow(REAL_USER_HTML("第二句 普通文本", "") + '<div data-chat-anchor-key="14:assistant-step1:1">assistant 内容</div>');
  const d5 = w5.document;
  const uNode5 = d5.querySelector("._text").firstChild;
  const aNode5 = d5.querySelectorAll("[data-chat-anchor-key]")[1].firstChild;
  const r5b = d5.createRange();
  r5b.setStart(uNode5, 4);
  r5b.setEnd(aNode5, 8);
  const seg5b = selectionToSegments(r5b, d5, snapCross);
  ok("跨容器首容器无附加 → 两 segments 成功", seg5b.segments.length === 2 && seg5b.segments[0].eventSeq === 99 && seg5b.segments[1].eventSeq === 17, JSON.stringify(seg5b.segments));
  ok("跨容器 selectedText 精确（无附加）", seg5b.selectedText === "普通文本assistan", JSON.stringify(seg5b.selectedText));
}

console.log("— R17: effective-source 归一化（selection projection）—");
{
  // source → turn-tail(chrome) → source：turn-tail 被机械排除，两 source 保留
  const w = makeWindow(
    '<div data-chat-anchor-key="14:assistant-step1:1">assistant 第一</div>' +
    '<div data-chat-anchor-key="9:turn-tail1">06:32 · 用时 0秒</div>' +
    '<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">user 消息</div>'
  );
  const d = w.document;
  const snap = [
    { kind: "assistant", turn: 1, step: 1, seq: 17, content: [{ type: "text", text: "assistant 第一" }] },
    { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 25, content: [{ type: "text", text: "user 消息" }] },
  ];
  const anchors = d.querySelectorAll("[data-chat-anchor-key]");
  const aT = anchors[0].firstChild;
  const uT = anchors[2].firstChild;
  const r = d.createRange();
  r.setStart(aT, 0);
  r.setEnd(uT, 4);
  const seg = selectionToSegments(r, d, snap);
  ok("turn-tail chrome 排除 → 两 source segments", seg.segments.length === 2 && seg.segments[0].eventSeq === 17 && seg.segments[1].eventSeq === 25, JSON.stringify(seg.segments));
  ok("turn-tail 不在 nodeKeys", !seg.nodeKeys.some((k) => k.includes("turn-tail")), JSON.stringify(seg.nodeKeys));
  ok("selectedText 不含 turn-tail 文本", !seg.selectedText.includes("用时"), JSON.stringify(seg.selectedText));

  // 仅选 turn-tail（全 chrome）→ 拒绝（无 source-bearing 内容）
  const w2 = makeWindow('<div data-chat-anchor-key="9:turn-tail1">06:32 · 用时 0秒</div>');
  const d2 = w2.document;
  const tn = d2.querySelector("[data-chat-anchor-key]").firstChild;
  const r2 = d2.createRange();
  r2.setStart(tn, 0);
  r2.setEnd(tn, 4);
  const err2 = (() => { try { selectionToSegments(r2, d2, snap); return null; } catch (e) { return e.message; } })();
  ok("仅 chrome 容器 → 拒绝（no source-bearing content）", err2 !== null && /no source-bearing content/.test(err2));

  // context-inject（source identity 但显示 ≠ source）→ 拒绝
  const w3 = makeWindow('<div data-chat-anchor-key="13:input-message109a1db6-e5f0-4f83-afa1-ccd84b5f2604">上下文注入\n@deepseek-ai/dsh-system-prompt</div>');
  const d3 = w3.document;
  const snapCtx = [
    { kind: "user", messageId: "109a1db6-e5f0-4f83-afa1-ccd84b5f2604", seq: 8, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }] },
  ];
  const tn3 = d3.querySelector("[data-chat-anchor-key]").firstChild;
  const r3 = d3.createRange();
  r3.setStart(tn3, 0);
  r3.setEnd(tn3, 8);
  const err3 = (() => { try { selectionToSegments(r3, d3, snapCtx); return null; } catch (e) { return e.message; } })();
  ok("context-inject 显示≠source → 拒绝（prefix-match）", err3 !== null && /prefix-match/.test(err3));
}

console.log("— 尾部 chrome 结构验证（须行容器结构正证，wrapper 外 ≠ chrome）—");
{
  // 真实 renderer 形态：`[data-time-hover-root]` 行容器，源码在内容分支 `_text` 内，
  // 时间戳在 actions 兄弟分支。结构判据不读取任何 class/local 名——fixture 用中性
  // class（_text/content/actions）仅作层级，判定靠行容器 + 内容分支定位。
  const USER_REAL = (body) =>
    `<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">` +
    `<div class="row" data-time-hover-root="true">` +
    `<div class="content"><div class="_text">${body}</div></div>` +
    `<div class="actions"><button type="button" aria-label="复制"></button><span class="timeStart">${""}</span></div></div></div>`;

  // 1. 源码在 `_text` 内 + 时间戳 span 在 actions 分支 → 尾部文本节点结构性位于
  //    source-bearing 子树（_text 包装）之外 → 机械排除
  const snapTs = [{ kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "SOURCE" }] }];
  const w = makeWindow(USER_REAL("SOURCE").replace('class="timeStart"></span>', 'class="timeStart">05:08</span>'));
  const d = w.document;
  const srcNode = d.querySelector("._text").firstChild;          // "SOURCE"（6 码点）
  const tsNode = d.querySelector(".timeStart").firstChild;       // "05:08"（5 码点）
  const r = d.createRange();
  r.setStart(srcNode, 0);
  r.setEnd(tsNode, 5); // 覆盖 SOURCE + chrome span
  const seg = selectionToSegments(r, d, snapTs);
  ok("chrome 尾部位于内容包装外 → 结构性排除", seg.segments[0].start === 0 && seg.segments[0].end === 6, JSON.stringify(seg.segments));
  ok("selectedText 不含尾部", seg.selectedText === "SOURCE", JSON.stringify(seg.selectedText));

  // 2. source + 无结构分离的尾部（裸文本延伸：源码与尾部同一文本节点 / 同一包装）→ reject
  const w6 = makeWindow('<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35"><div class="row"><div class="content"><div class="_text">SOURCE-UNKNOWN-TAIL</div></div></div></div>');
  const d6 = w6.document;
  const tn6 = d6.querySelector("._text").firstChild;
  const r6 = d6.createRange();
  r6.setStart(tn6, 0);
  r6.setEnd(tn6, 12); // SOURCE(6) + 未知尾部（同文本节点内）
  const err6 = (() => { try { selectionToSegments(r6, d6, snapTs); return null; } catch (e) { return e.message; } })();
  ok("未知尾部（与源码同文本节点/同包装）→ reject", err6 !== null && /cannot verify as renderer-only chrome/.test(err6));

  // 3. source-bearing 尾部（DOM 以另一 source 文本延伸，无结构分离）→ reject
  const w7 = makeWindow('<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35"><div class="row"><div class="content"><div class="_text">SOURCE-BEARING-EXTRA</div></div></div></div>');
  const d7 = w7.document;
  const snap7 = [
    { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "SOURCE" }] },
    { kind: "user", messageId: "x-00000000-0000-0000-0000-000000000099", seq: 100, content: [{ type: "text", text: "SOURCE-BEARING-EXTRA" }] },
  ];
  const tn7 = d7.querySelector("._text").firstChild;
  const r7 = d7.createRange();
  r7.setStart(tn7, 0);
  r7.setEnd(tn7, 20);
  // 尾部与投影共享文本节点（无法结构分离）→ 先于 tailSourceLike reject
  const err7 = (() => { try { selectionToSegments(r7, d7, snap7); return null; } catch (e) { return e.message; } })();
  ok("source-bearing 扩展尾部（无结构分离）→ reject", err7 !== null && /cannot verify as renderer-only chrome/.test(err7));
  // 4. 仅 chrome span → reject（no source-bearing content）
  const w5 = makeWindow(USER_REAL("SOURCE").replace('class="timeStart"></span>', 'class="timeStart">05:08</span>'));
  const d5 = w5.document;
  const tsNode5 = d5.querySelector(".timeStart").firstChild;
  const r5 = d5.createRange();
  r5.setStart(tsNode5, 0);
  r5.setEnd(tsNode5, 5); // 仅时间戳
  const err5 = (() => { try { selectionToSegments(r5, d5, snapTs); return null; } catch (e) { return e.message; } })();
  ok("仅 chrome → reject（no source-bearing content）", err5 !== null && /no source-bearing content/.test(err5));
}

console.log("— R19: 尾部 chrome 结构验证（adversarial check：wrapper 外 ≠ chrome——须行容器结构正证）—");
{
  const snapTs = [{ kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "SOURCE" }] }];
  // 行容器 fixture：源码在内容分支 _text、actions 分支含交互控件 button（MessageIconActions）
  // + 时间戳 span —— 真实 renderer 形态（adversarial check：chrome 分支须有稳定正向交互控件标识）
  const ROW_HTML = (contentHtml, actionsHtml) =>
    '<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">' +
    '<div class="row" data-time-hover-root="true">' +
    '<div class="content"><div class="_text">' + contentHtml + '</div></div>' +
    (actionsHtml ? '<div class="actions"><button type="button" aria-label="复制"></button>' + actionsHtml + '</div>' : '') +
    '</div></div>';

  // 1. 无行容器（任意 wrapper，如 adversarial check 对抗例）→ 无法证明 chrome → truthful reject
  const adv0 = makeWindow(
    '<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">' +
    '<div class="content"><span>SOURCE</span><span>UNIQUE-SOURCE-BEARING</span></div>' +
    '<div class="actions"><span>12:00</span></div></div>'
  );
  const d0 = adv0.document;
  const src0 = d0.querySelectorAll(".content span")[0].firstChild;      // "SOURCE"
  const extra0 = d0.querySelectorAll(".content span")[1].firstChild;    // "UNIQUE-SOURCE-BEARING"
  const r0 = d0.createRange();
  r0.setStart(src0, 0);
  r0.setEnd(extra0, 20);
  const err0 = (() => { try { selectionToSegments(r0, d0, snapTs); return null; } catch (e) { return e.message; } })();
  ok("无行容器的 source-bearing sibling（test 对抗例）→ truthful reject（不静默裁剪）", err0 !== null && /cannot verify as renderer-only chrome/.test(err0));

  // 2. 行容器内：源码分支内容区 + actions 分支时间戳 → 行容器结构正证 → 排除
  const w1 = makeWindow(ROW_HTML("SOURCE", '<span class="timeStart">05:08</span>'));
  const d1 = w1.document;
  const src1 = d1.querySelector("._text").firstChild;
  const ts1 = d1.querySelector(".timeStart").firstChild;
  const r1 = d1.createRange();
  r1.setStart(src1, 0);
  r1.setEnd(ts1, 5);
  const seg1 = selectionToSegments(r1, d1, snapTs);
  ok("行容器内 actions 分支时间戳 → 结构性正证排除", seg1.segments[0].start === 0 && seg1.segments[0].end === 6, JSON.stringify(seg1.segments));

  // 3. 行容器内源码分支中、位于投影后的未知 sibling（source-bearing 内容用 chrome class
  //    且与源码同内容分支）→ 在内容分支内 → 无法正证 → truthful reject
  const w2 = makeWindow(ROW_HTML('SOURCE<span class="h1_x_timeStart">UNIQUE-SOURCE-BEARING</span>', ''));
  const d2 = w2.document;
  const src2 = d2.querySelector("._text").firstChild;           // "SOURCE"
  const extra2 = d2.querySelector(".h1_x_timeStart").firstChild; // "UNIQUE-SOURCE-BEARING"
  const r2 = d2.createRange();
  r2.setStart(src2, 0);
  r2.setEnd(extra2, 20);
  const err2 = (() => { try { selectionToSegments(r2, d2, snapTs); return null; } catch (e) { return e.message; } })();
  ok("内容分支内 source-bearing + chrome class → truthful reject（在内容分支内，无法正证）", err2 !== null && /cannot verify as renderer-only chrome/.test(err2));

  // 4. 混合文本（源码+尾部同文本节点）→ 无法切割 → truthful reject
  const w3 = makeWindow(ROW_HTML("SOURCEUNIQUE-SOURCE-BEARING", ""));
  const d3 = w3.document;
  const mixed = d3.querySelector("._text").firstChild;
  const r3 = d3.createRange();
  r3.setStart(mixed, 0);
  r3.setEnd(mixed, 26);
  const err3 = (() => { try { selectionToSegments(r3, d3, snapTs); return null; } catch (e) { return e.message; } })();
  ok("混合文本（源码+尾部同节点）→ truthful reject", err3 !== null && /cannot verify as renderer-only chrome/.test(err3));

  // 5. actions 分支（时间格式文本通过节点级 chrome 正证）但该时间文本匹配另一 source
  //    投影 → tailSourceLike truthful reject（不因时间格式而静默裁剪 source 文本）
  const snap5 = [
    { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "SOURCE" }] },
    { kind: "user", messageId: "x-00000000-0000-0000-0000-000000000099", seq: 100, content: [{ type: "text", text: "会议在 05:08 开始" }] },
  ];
  const w5 = makeWindow(ROW_HTML("SOURCE", '<span class="timeStart">05:08</span>'));
  const d5 = w5.document;
  const src5 = d5.querySelector("._text").firstChild;
  const ts5 = d5.querySelector(".timeStart").firstChild;
  const r5 = d5.createRange();
  r5.setStart(src5, 0);
  r5.setEnd(ts5, 5); // SOURCE + "05:08"（另一 source 投影含 "05:08" 子串）
  const err5 = (() => { try { selectionToSegments(r5, d5, snap5); return null; } catch (e) { return e.message; } })();
  ok("时间格式 chrome 位文本匹配另一 source 投影 → tailSourceLike truthful reject", err5 !== null && /matches a source projection/.test(err5));

  // 6. 无 class 的结构分离尾部（纯 span 无 class 在 actions 分支）→ 行容器结构正证，仍排除
  const w6 = makeWindow(ROW_HTML("SOURCE", "<span>05:08</span>"));
  const d6 = w6.document;
  const src6 = d6.querySelector("._text").firstChild;
  const ts6 = d6.querySelector(".actions span").firstChild;
  const r6 = d6.createRange();
  r6.setStart(src6, 0);
  r6.setEnd(ts6, 5);
  const seg6 = selectionToSegments(r6, d6, snapTs);
  ok("无 class 的 actions 分支尾部 → 行容器结构正证排除（不依赖 class 名）", seg6.segments[0].start === 0 && seg6.segments[0].end === 6, JSON.stringify(seg6.segments));
}

console.log("— R20: adversarial check/6 对抗回归（行容器两分支 + chrome 分支须含交互控件 button 正证）—");
{
  const snapTs = [{ kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "SOURCE" }] }];
  // 真实形态 fixture：actions 分支含交互控件 button（MessageIconActions）
  const REAL_ROW = (contentHtml, actionsHtml) =>
    '<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">' +
    '<div class="row" data-time-hover-root="true">' +
    '<div class="content"><div class="_text">' + contentHtml + '</div></div>' +
    (actionsHtml ? '<div class="actions">' + actionsHtml + '</div>' : '') +
    '</div></div>';

  // 对抗 1（adversarial check 精确例）：行容器内 content + 未知 source-bearing 分支 + actions
  // （3 个含文本直接子）→ 非已验证两分支形态 → 未知分支无法确认 → truthful reject（不裁剪）
  const w1 = makeWindow(
    '<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">' +
    '<div class="row" data-time-hover-root="true">' +
    '<div class="content"><div class="_text">SOURCE</div></div>' +
    '<div class="unmapped-source">UNIQUE-SOURCE-BEARING</div>' +
    '<div class="actions"><button type="button" aria-label="复制"></button>12:00</div>' +
    '</div></div>'
  );
  const d1 = w1.document;
  const src1 = d1.querySelector("._text").firstChild;                    // "SOURCE"
  const unk1 = d1.querySelector(".unmapped-source").firstChild;          // "UNIQUE-SOURCE-BEARING"
  const r1 = d1.createRange();
  r1.setStart(src1, 0);
  r1.setEnd(unk1, 20); // 覆盖 SOURCE + 未知 source-bearing 分支
  const err1 = (() => { try { selectionToSegments(r1, d1, snapTs); return null; } catch (e) { return e.message; } })();
  ok("行容器 3 含文本分支（未知 source-bearing）→ truthful reject（不静默裁剪）", err1 !== null && /cannot verify as renderer-only chrome/.test(err1));

  // 对抗 2（adversarial check 精确例）：两分支形态，但第二分支**无交互控件 button** 且承载
  // 未映射 source（不在 snapshot，tailSourceLike 无法发现）→ 无法证明第二分支是 chrome
  // → truthful reject（不裁剪）
  const w2 = makeWindow(REAL_ROW("SOURCE", '<span class="actions-content">UNIQUE-SOURCE-BEARING</span>'));
  const d2 = w2.document;
  const src2 = d2.querySelector("._text").firstChild;
  const unk2 = d2.querySelector(".actions-content").firstChild;
  const r2 = d2.createRange();
  r2.setStart(src2, 0);
  r2.setEnd(unk2, 20);
  const err2 = (() => { try { selectionToSegments(r2, d2, snapTs); return null; } catch (e) { return e.message; } })();
  ok("两分支第二分支无 button（承载未映射 source）→ truthful reject（不静默裁剪）", err2 !== null && /cannot verify as renderer-only chrome/.test(err2));

  // 对抗 3（真实形态回归）：两分支，第二分支 actions 含交互控件 button → 结构性正证排除
  const w3 = makeWindow(REAL_ROW("SOURCE", '<button type="button" aria-label="复制"></button><span class="timeStart">12:00</span>'));
  const d3 = w3.document;
  const src3 = d3.querySelector("._text").firstChild;
  const act3 = d3.querySelector(".timeStart").firstChild;
  const r3 = d3.createRange();
  r3.setStart(src3, 0);
  r3.setEnd(act3, 5);
  const seg3 = selectionToSegments(r3, d3, snapTs);
  ok("两分支形态（第二分支含交互控件 button）→ 结构性正证排除", seg3.segments[0].start === 0 && seg3.segments[0].end === 6, JSON.stringify(seg3.segments));

  // 对抗 4：真实形态下，actions 分支时间格式文本匹配另一 source 投影 → tailSourceLike reject
  const snap4 = [
    { kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "SOURCE" }] },
    { kind: "user", messageId: "x-00000000-0000-0000-0000-000000000099", seq: 100, content: [{ type: "text", text: "会议在 05:08 开始" }] },
  ];
  const w4 = makeWindow(REAL_ROW("SOURCE", '<button type="button" aria-label="复制"></button><span class="timeStart">05:08</span>'));
  const d4 = w4.document;
  const src4 = d4.querySelector("._text").firstChild;
  const ts4 = d4.querySelector(".timeStart").firstChild;
  const r4 = d4.createRange();
  r4.setStart(src4, 0);
  r4.setEnd(ts4, 5);
  const err4 = (() => { try { selectionToSegments(r4, d4, snap4); return null; } catch (e) { return e.message; } })();
  ok("真实形态时间格式 chrome 位匹配另一 source 投影 → tailSourceLike truthful reject", err4 !== null && /matches a source projection/.test(err4));
}

console.log("— R21: adversarial check 对抗回归（button 是分支级证据；chrome 排除须节点级文本形态正证）—");
{
  const snapTs = [{ kind: "user", messageId: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", seq: 99, content: [{ type: "text", text: "SOURCE" }] }];
  const ROW = (contentHtml, actionsHtml) =>
    '<div data-chat-anchor-key="13:input-message63cb3cea-12f5-4d88-94d7-b37cdcda9e35">' +
    '<div class="row" data-time-hover-root="true">' +
    '<div class="content"><div class="_text">' + contentHtml + '</div></div>' +
    (actionsHtml ? '<div class="actions">' + actionsHtml + '</div>' : '') +
    '</div></div>';

  // 对抗 1（adversarial check 精确例）：actions 含 button + 未知 source-bearing 裸 span
  // （非时间格式、非 button 内文本）→ 节点级无法正证 → truthful reject（不静默裁剪）
  const w1 = makeWindow(ROW("SOURCE", '<button type="button" aria-label="复制"></button><span>UNIQUE-SOURCE-BEARING</span>'));
  const d1 = w1.document;
  const src1 = d1.querySelector("._text").firstChild;
  const unk1 = d1.querySelector(".actions span").firstChild; // UNIQUE-SOURCE-BEARING
  const r1 = d1.createRange();
  r1.setStart(src1, 0);
  r1.setEnd(unk1, 20);
  const err1 = (() => { try { selectionToSegments(r1, d1, snapTs); return null; } catch (e) { return e.message; } })();
  ok("button 分支内未知 source 裸 span → truthful reject（不因分支含 button 而裁剪）", err1 !== null && /cannot verify as renderer-only chrome/.test(err1));

  // 对抗 2：actions 含 button + 非时间格式文本（看似 chrome 位）→ 节点级无法正证 → reject
  const w2 = makeWindow(ROW("SOURCE", '<button type="button" aria-label="复制"></button><span>用时统计</span>'));
  const d2 = w2.document;
  const src2 = d2.querySelector("._text").firstChild;
  const txt2 = d2.querySelector(".actions span").firstChild;
  const r2 = d2.createRange();
  r2.setStart(src2, 0);
  r2.setEnd(txt2, 4);
  const err2 = (() => { try { selectionToSegments(r2, d2, snapTs); return null; } catch (e) { return e.message; } })();
  ok("button 分支内非时间格式文本 → truthful reject", err2 !== null && /cannot verify as renderer-only chrome/.test(err2));

  // 对抗 3（真实形态回归）：actions 含 button + 时间格式 span（真实时间戳）
  // → 节点级时间戳正证 → 机械排除
  const w3 = makeWindow(ROW("SOURCE", '<button type="button" aria-label="复制"></button><span class="timeStart">05:08</span>'));
  const d3 = w3.document;
  const src3 = d3.querySelector("._text").firstChild;
  const ts3 = d3.querySelector(".timeStart").firstChild;
  const r3 = d3.createRange();
  r3.setStart(src3, 0);
  r3.setEnd(ts3, 5);
  const seg3 = selectionToSegments(r3, d3, snapTs);
  ok("button 分支内时间格式文本（真实时间戳形态）→ 节点级正证排除", seg3.segments[0].start === 0 && seg3.segments[0].end === 6, JSON.stringify(seg3.segments));

  // 对抗 4：仅 button 内文本（操作标签在 button 内）→ button 内文本节点级正证 chrome
  const w4 = makeWindow(ROW("SOURCE", '<button type="button" aria-label="复制">复制</button><span class="timeStart">05:08</span>'));
  const d4 = w4.document;
  const src4 = d4.querySelector("._text").firstChild;
  const btnText4 = d4.querySelector("button").firstChild; // "复制"
  const r4 = d4.createRange();
  r4.setStart(src4, 0);
  r4.setEnd(btnText4, 2);
  const seg4 = selectionToSegments(r4, d4, snapTs);
  ok("button 内操作标签文本 → 节点级正证排除", seg4.segments[0].start === 0 && seg4.segments[0].end === 6, JSON.stringify(seg4.segments));
}

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
