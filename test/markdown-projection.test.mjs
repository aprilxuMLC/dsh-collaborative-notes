// Notes behavior regression Markdown visible-text projection v2 全链路
import {
  projectVisibleText, projectVisibleMarkdownContent, buildLocator, resolveLocator,
  locatorSlicesMatch, PROJECTION_VERSION_MARKDOWN, ProjectionError,
} from "../lib/source-locator.js";
import { projectVisibleMarkdown } from "../lib/markdown-projection.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const SID = "session-abcdefgh";

// 每个测试：content（持久化 event blocks）→ 模拟用户选中 rendered visible 子串
// 注意：projection 与 locator 全链路为「码点」单位（与 selection-bridge 一致），
// 故索引一律用码点 indexOf（UTF-16 indexOf 在含 astral 字符时错位）。
function cpIndexOf(str, sub, from = 0) {
  const a = [...str]; const b = [...sub];
  for (let i = from; i + b.length <= a.length; i++) {
    let ok = true;
    for (let k = 0; k < b.length; k++) if (a[i + k] !== b[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
function runProof(content, selectedVisible, eventSource) {
  const projected = projectVisibleText(content, PROJECTION_VERSION_MARKDOWN);
  const visIdx = cpIndexOf(projected, selectedVisible);
  if (visIdx < 0) return { error: "selected not in projection" };
  const loc = buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: visIdx, end: visIdx + [...selectedVisible].length }] });
  // clear ephemeral：locator 是 plain data
  const r = resolveLocator(loc, eventSource);
  return { loc, resolved: r.text, match: r.text === selectedVisible, projected };
}

console.log("— M1: inline emphasis/link —");
{
  const content = [{ type: "text", text: "**加粗** 和 [链接](https://x.com) 还有 `code`" }];
  const p = projectVisibleText(content, PROJECTION_VERSION_MARKDOWN);
  ok("projection 去 markdown 标记", p === "加粗 和 链接 还有 code", JSON.stringify(p));
  for (const sel of ["加粗", "链接", "code"]) {
    const r = runProof(content, sel, (sid, seq) => sid === SID && seq === 1 ? content : undefined);
    ok(`选中 [${sel}] → locator-only 重构精确`, r.match, r.resolved);
    ok(`capture-time consistency [${sel}]`, locatorSlicesMatch(r.loc, (sid, seq) => sid === SID && seq === 1 ? content : undefined, sel));
  }
}

console.log("— M2: block Markdown（标题/列表/引用）—");
{
  const content = [{ type: "text", text: "# 标题\n- 列表项\n> 引用文本" }];
  const p = projectVisibleText(content, PROJECTION_VERSION_MARKDOWN);
  ok("block projection", p === "标题\n列表项\n引用文本", JSON.stringify(p));
  for (const sel of ["标题", "列表项", "引用文本"]) {
    const r = runProof(content, sel, (sid, seq) => sid === SID && seq === 1 ? content : undefined);
    ok(`选中 [${sel}] → 重构精确`, r.match, r.resolved);
  }
}

console.log("— M2b: GFM table follows browser textContent shape —");
{
  const src = "前置段落。\n\n| 环节 | 操作 | 结果 |\n| --- | --- | --- |\n| 读（空） | 四道 `notes-read` | ✅ 均返回 |\n\n后置段落。";
  const p = projectVisibleMarkdown(src);
  const want = "前置段落。\n环节操作结果读（空）四道 notes-read✅ 均返回\n后置段落。";
  ok("表格 cell/row 间不虚构换行、块间保留换行", p.visibleText === want, JSON.stringify(p.visibleText));
  ok("表格 projection source map 与 visible 等长", p.sourceOffsets.length === [...p.visibleText].length, JSON.stringify(p.sourceOffsets));
  const tableText = "读（空）四道 notes-read✅ 均返回";
  const tableOffset = cpIndexOf(p.visibleText, tableText);
  const sourceChars = [...src];
  const mapped = p.sourceOffsets.slice(tableOffset, tableOffset + [...tableText].length).map((i) => sourceChars[i]).join("");
  ok("表格可见文本保持 source offsets", mapped === "读（空）四道 `notes-read`✅ 均返回".replaceAll("`", ""), JSON.stringify(mapped));
}

console.log("— M3: duplicate text（重复文本精确 extent）—");
{
  const content = [{ type: "text", text: "重复 重复 和 **重复**" }];
  const p = projectVisibleText(content, PROJECTION_VERSION_MARKDOWN);
  const first = cpIndexOf(p, "重复");
  const second = cpIndexOf(p, "重复", first + 1);
  const third = cpIndexOf(p, "重复", second + 1);
  const src = (sid, seq) => sid === SID && seq === 1 ? content : undefined;
  const r1 = resolveLocator(buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: first, end: first + 2 }] }), src);
  const r2 = resolveLocator(buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: second, end: second + 2 }] }), src);
  const r3 = resolveLocator(buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: third, end: third + 2 }] }), src);
  ok("三处重复文本各自精确（无搜索）", r1.text === "重复" && r2.text === "重复" && r3.text === "重复");
}

console.log("— M4: CJK/emoji（码点 extent）—");
{
  const content = [{ type: "text", text: "😀 表情 **粗体中文** 🎉" }];
  const p = projectVisibleText(content, PROJECTION_VERSION_MARKDOWN);
  ok("emoji/CJK projection", p === "😀 表情 粗体中文 🎉", JSON.stringify(p));
  const idx = cpIndexOf(p, "粗体中文");
  const r = resolveLocator(buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: idx, end: idx + 4 }] }), (sid, seq) => sid === SID && seq === 1 ? content : undefined);
  ok("CJK 码点重构", r.text === "粗体中文");
}

console.log("— M5: cross-node（多 text block，block 间 \\n）—");
{
  const content = [{ type: "text", text: "第一块 **粗**" }, { type: "text", text: "- 第二块" }];
  const p = projectVisibleText(content, PROJECTION_VERSION_MARKDOWN);
  ok("cross-node projection", p === "第一块 粗\n第二块", JSON.stringify(p));
  const idx = cpIndexOf(p, "粗");
  const r = resolveLocator(buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: idx, end: idx + 1 }] }), (sid, seq) => sid === SID && seq === 1 ? content : undefined);
  ok("cross-node 重构", r.text === "粗");
}

console.log("— M6: cross-event（ordered segments）—");
{
  const ev1 = [{ type: "text", text: "第一句 **强调**" }];
  const ev2 = [{ type: "text", text: "第二句 [链接](u)" }];
  const src = (sid, seq) => sid === SID ? (seq === 1 ? ev1 : seq === 2 ? ev2 : undefined) : undefined;
  const p1 = projectVisibleText(ev1, PROJECTION_VERSION_MARKDOWN);
  const p2 = projectVisibleText(ev2, PROJECTION_VERSION_MARKDOWN);
  const sel1 = "强调"; const sel2 = "链接";
  const i1 = cpIndexOf(p1, sel1); const i2 = cpIndexOf(p2, sel2);
  const loc = buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: i1, end: i1 + 2 }, { eventSeq: 2, start: i2, end: i2 + 2 }] });
  const r = resolveLocator(loc, src);
  ok("cross-event 重构 = 强调+链接", r.text === "强调链接");
  ok("cross-event 顺序保持", r.segments.map((s) => s.eventSeq).join(",") === "1,2");
}

console.log("— M7: source map 一致性（visible ↔ 源）—");
{
  const content = [{ type: "text", text: "**加粗** 与 [文字](u) 和 `码`" }];
  const m = projectVisibleMarkdownContent(content);
  ok("sourceOffsets 长度 = visible 长度", m.sourceOffsets.length === [...m.text].length);
  // 任选 visible 子串 → sourceOffsets → 源 slice → re-project == 同一 visible
  const sel = "文字";
  const idx = cpIndexOf(m.text, sel);
  const selOffsets = m.sourceOffsets.slice(idx, idx + [...sel].length);
  const srcChars = [...content[0].text];
  const reconstructed = selOffsets.map((o) => srcChars[o]).join("");
  ok("源 slice 得回选中可见文本（source map 一致性）", reconstructed === sel);
  // 完整：源 content → projectVisibleText 稳定
  const again = projectVisibleMarkdownContent(content);
  ok("rebuild projection 稳定（同 content → 同 visible/offsets）", again.text === m.text && JSON.stringify(again.sourceOffsets) === JSON.stringify(m.sourceOffsets));

  const astral = [{ type: "text", text: "A😀B" }];
  const astralMap = projectVisibleMarkdownContent(astral);
  ok("v2 astral source map 按码点计数", astralMap.text === "A😀B" && astralMap.sourceOffsets.length === 3, JSON.stringify(astralMap));
  ok("v2 astral source map 保持源坐标", JSON.stringify(astralMap.sourceOffsets) === JSON.stringify([0, 1, 2]), JSON.stringify(astralMap.sourceOffsets));
}

console.log("— M8: 不支持的构造（local unsupported，truthful reject）—");
{
  // This path does not prove a universal renderer treatment for non-text blocks;
  // this local projection rejects them rather than treating them as hidden.
  ok("非 text block v2 → UNSUPPORTED_CONTENT_BLOCK", (() => { try { projectVisibleText([{ type: "tool" }], PROJECTION_VERSION_MARKDOWN); return false; } catch (e) { return e.code === "UNSUPPORTED_CONTENT_BLOCK"; } })());
  ok("mixed content v2 → UNSUPPORTED_CONTENT_BLOCK", (() => { try { projectVisibleText([{ type: "tool" }, { type: "text", text: "正文" }], PROJECTION_VERSION_MARKDOWN); return false; } catch (e) { return e.code === "UNSUPPORTED_CONTENT_BLOCK"; } })());
  const reasoningMixed = [{ type: "reasoning", text: "内部 reasoning，不是正文" }, { type: "text", text: "正文 **加粗**" }];
  const reasoningProjection = projectVisibleText(reasoningMixed, PROJECTION_VERSION_MARKDOWN);
  ok("DSH rc.2 reasoning + text → 只投影 visible text", reasoningProjection === "正文 加粗", JSON.stringify(reasoningProjection));
  const reasoningOffsetMap = projectVisibleMarkdownContent([{ type: "reasoning", text: "abc" }, { type: "text", text: "XY" }]);
  ok("reasoning omission 不移动 accepted visible projection 坐标", reasoningOffsetMap.text === "XY" && JSON.stringify(reasoningOffsetMap.sourceOffsets) === JSON.stringify([0, 1]), JSON.stringify(reasoningOffsetMap));
}

console.log("— M9: 普通文本不误投影（test recheck-1）—");
{
  const cases = [
    ["intraword 下划线", "foo_bar_baz", "foo_bar_baz"],
    ["intraword 下划线（数字）", "x_1_y", "x_1_y"],
    ["HTML tag 原样", "<b>bold</b>", "<b>bold</b>"],
    ["HTML tag 行内", "a <i>x</i> b", "a <i>x</i> b"],
    ["三连星 em+strong", "***bold***", "bold"],
    ["双星 strong", "**bold**", "bold"],
    ["合法 autolink 保留", "<https://x.com>", "https://x.com"],
    ["合法 email autolink", "<a@b.c>", "a@b.c"],
  ];
  for (const [name, src, want] of cases) {
    const got = projectVisibleMarkdown(src).visibleText;
    ok(`${name} → ${JSON.stringify(want)}`, got === want, JSON.stringify(got));
    // 全链路：选中该可见文本 → locator-only 重构精确
    const content = [{ type: "text", text: src }];
    const idx = cpIndexOf(got, want);
    const r = resolveLocator(buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: idx, end: idx + [...want].length }] }), (sid, seq) => sid === SID && seq === 1 ? content : undefined);
    ok(`${name} locator-only 重构精确`, r.text === want, JSON.stringify(r.text));
  }
}

console.log("— M10: 嵌套强调/删除线/双下划线（test recheck-2 adversarial）—");
{
  const cases = [
    ["双下划线 intraword", "foo__bar__baz", "foo__bar__baz"],
    ["双下划线 intraword 数字", "x__1__y", "x__1__y"],
    ["strong 内 em", "**bold *inner***", "bold inner"],
    ["删除线内 strong", "~~**bold**~~", "bold"],
    ["em 内 strong", "*a **b** c*", "a b c"],
    ["strong 内 em（尾）", "**a *b* c**", "a b c"],
    ["删除线内 strong+em", "~~a **b** c~~", "a b c"],
    ["link 文本含 emphasis", "[**bold**](u)", "bold"],
    ["link 文本含 em", "[a *b* c](u)", "a b c"],
    ["未闭合 strong 字面", "**bold", "**bold"],
    ["未闭合混合字面", "a **b* c", "a *b c"],
    ["三连星 em+strong", "***bold***", "bold"],
    ["深层嵌套", "**a *b **c** d* e**", "a b c d e"],
  ];
  for (const [name, src, want] of cases) {
    const got = projectVisibleMarkdown(src).visibleText;
    ok(`${name} → ${JSON.stringify(want)}`, got === want, JSON.stringify(got));
    const content = [{ type: "text", text: src }];
    const idx = cpIndexOf(got, want);
    if (idx < 0) { ok(`${name} locator-only 重构（选中不在投影）`, false, "idx<0"); continue; }
    const r = resolveLocator(buildLocator({ sessionId: SID, projectionVersion: PROJECTION_VERSION_MARKDOWN, segments: [{ eventSeq: 1, start: idx, end: idx + [...want].length }] }), (sid, seq) => sid === SID && seq === 1 ? content : undefined);
    ok(`${name} locator-only 重构精确`, r.text === want, JSON.stringify(r.text));
  }
  // 深层嵌套深度保护：>32 层不爆栈（字面保留）
  const deep = "**".repeat(40) + "x" + "**".repeat(40);
  const pDeep = projectVisibleMarkdown(deep).visibleText;
  ok("深层嵌套不爆栈（深度保护）", typeof pDeep === "string" && pDeep.length > 0, JSON.stringify(pDeep.slice(0, 20)));
}

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
