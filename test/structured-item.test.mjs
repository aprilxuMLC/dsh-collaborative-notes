// Notes behavior regression structured item representation tests
// node test/structured-item.test.mjs
import {
  parseLaneBody, serializeLaneBody, serializeItem, makeItem, unknownMeta,
  KIND_SOURCE_AWARE, KIND_SOURCE_INDEPENDENT, BEGIN_LINE, END_LINE, BODY_LINE,
  inspectItemKey, isValidItemKey,
  isValidGeneratedItemKey,
} from "../lib/structured-item.js";
import { resolveLocator } from "../lib/source-locator.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
function items(parsed) { return parsed.nodes.filter((n) => n.type === "item").map((n) => n.item); }
function legacy(parsed) { return parsed.nodes.filter((n) => n.type === "legacy").map((n) => n.text); }

// ---- R1: adversarial reserved-line content（collision-free）----
const RESERVED = [BEGIN_LINE, END_LINE, BODY_LINE];

// ---- behavior regression structured Agent addressing: one canonical key-row inspector ----
console.log("— behavior regression: canonical item-key inspection —");
{
  const keyed = makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "addressable" });
  keyed.unknownMeta = [{ raw: "dsh-meta item-key: ik-test-1" }];
  ok("one valid item-key row is addressable", inspectItemKey(keyed).status === "valid" && inspectItemKey(keyed).key === "ik-test-1");
  ok("generated key syntax accepted", isValidItemKey("ik-mtu8rorb-s4nffqxzvc6h8mj"));
  const missing = { ...keyed, unknownMeta: [] };
  ok("missing key is non-addressable", inspectItemKey(missing).status === "missing");
  const duplicate = { ...keyed, unknownMeta: [{ raw: "dsh-meta item-key: ik-one" }, { raw: "dsh-meta item-key: ik-two" }] };
  ok("duplicate key rows are non-addressable", inspectItemKey(duplicate).status === "duplicate");
  const historicalOpaque = { ...keyed, unknownMeta: [{ raw: "dsh-meta item-key: 历史 key/一" }] };
  ok("historical opaque key remains addressable", inspectItemKey(historicalOpaque).status === "valid" && inspectItemKey(historicalOpaque).key === "历史 key/一");
  const malformed = { ...keyed, unknownMeta: [{ raw: "dsh-meta item-key:    " }] };
  ok("empty normalized key is non-addressable", inspectItemKey(malformed).status === "malformed");
  ok("strict syntax is only a fresh-key generator invariant", !isValidGeneratedItemKey("历史 key/一") && isValidGeneratedItemKey("ik-test-1"));
}
console.log("— R1: reserved lines inside snapshot/comment survive exactly —");
for (const r of RESERVED) {
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\ndsh-meta snapshot-length: ${[...r].length}\n${BODY_LINE}\n${r}\n${END_LINE}\n`;
  const p = parseLaneBody(t);
  const its = items(p);
  ok(`snapshot 含 [${r}] → 1 item 无 legacy 分裂`, its.length === 1 && legacy(p).length === 0);
  ok(`snapshot 精确保留 [${r}]`, its[0].snapshot === r);
  ok(`provenance 关联保持`, its[0].captureOrigin === "session-a" && its[0].kind === KIND_SOURCE_AWARE);
  ok(`round-trip 稳定`, serializeLaneBody(parseLaneBody(t)) === t);
}
// comment 中的 reserved 行（payload = snapshot + comment 无分隔拼接，用 serializeItem 保证一致性）
for (const r of RESERVED) {
  const item = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "sn", comment: r });
  const t = serializeItem(item) + "\n";
  const p = parseLaneBody(t);
  const its = items(p);
  ok(`comment 含 [${r}] → snapshot+comment 均精确`, its.length === 1 && its[0].snapshot === "sn" && its[0].comment === r);
  ok(`comment [${r}] round-trip`, serializeLaneBody(parseLaneBody(t)) === t);
}
// 组合 adversarial：snapshot 含 begin + end + body 行（多行）
const multiReserved = `${BEGIN_LINE}\n${END_LINE}\n${BODY_LINE}\n结尾`;
const tM = `${BEGIN_LINE}\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\ndsh-meta snapshot-length: ${[...multiReserved].length}\n${BODY_LINE}\n${multiReserved}\n${END_LINE}\n`;
{
  const p = parseLaneBody(tM);
  ok("多行 reserved snapshot 精确", items(p)[0].snapshot === multiReserved);
  ok("多行 reserved snapshot 无 legacy 分裂", legacy(p).length === 0);
  ok("多行 reserved round-trip", serializeLaneBody(p) === tM);
}
// source-independent 正文含 reserved 行
for (const r of RESERVED) {
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: ${[...r].length}\n${BODY_LINE}\n${r}\n${END_LINE}\n`;
  const its = items(parseLaneBody(t));
  ok(`source-independent 正文含 [${r}] 精确`, its[0].comment === r);
}

// ---- R2: malformed → opaque legacy（不制造部分合法 item）----
console.log("— R2: malformed candidate stays opaque, never partial valid item —");
const malformedCases = [
  ["begin 无 end", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 3\n${BODY_LINE}\nabc\n`],
  ["body 短于声明", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 10\n${BODY_LINE}\nabc\n${END_LINE}\n`],
  ["body 长于声明（行内剩余）", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 3\n${BODY_LINE}\nabcXYZ\n${END_LINE}\n`],
  ["缺 body 头", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 3\nabc\n${END_LINE}\n`],
  ["kind 无效", `${BEGIN_LINE}\ndsh-meta kind: bogus\ndsh-meta origin: session-a\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["缺 kind", `${BEGIN_LINE}\ndsh-meta origin: session-a\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["缺 origin", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["origin 无效（session 形状）", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: ../evil\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["origin 无效（短）", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: ab\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["duplicate kind", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["duplicate origin", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta origin: session-b\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["source-independent 声明 snapshot-length", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 1\ndsh-meta snapshot-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["source-aware 缺 snapshot-length", `${BEGIN_LINE}\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\n${BODY_LINE}\ncontent\n${END_LINE}\n`],
  ["source-aware 声明 body-length", `${BEGIN_LINE}\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\ndsh-meta body-length: 1\ndsh-meta snapshot-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`],
  ["unsupported v2", `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`.replace(BEGIN_LINE, "--- dsh-note v2 begin")],
];
for (const [name, body] of malformedCases) {
  const p = parseLaneBody(body);
  ok(`${name} → 0 item（无部分合法 item）`, items(p).length === 0);
  ok(`${name} → 内容保留为 opaque legacy（不丢字节）`, serializeLaneBody(p) === body || legacy(p).join("\n").length > 0);
}

// ---- R3: unknown metadata verbatim（有序 raw，重复/空白/空值/拼写）----
console.log("— R3: unknown metadata verbatim —");
const tUnknown = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 1\ndsh-meta future-key: value\n${BODY_LINE}\nx\n${END_LINE}\n`;
{
  const its = items(parseLaneBody(tUnknown));
  ok("unknown 单字段保留 raw", its[0].unknownMeta[0].raw === "dsh-meta future-key: value");
  ok("unknown round-trip", serializeLaneBody(parseLaneBody(tUnknown)) === tUnknown);
}
const tDup = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 1\ndsh-meta future: one\ndsh-meta future: two\n${BODY_LINE}\nx\n${END_LINE}\n`;
{
  const its = items(parseLaneBody(tDup));
  ok("duplicate unknown keys 保留两个", its[0].unknownMeta.length === 2);
  ok("duplicate unknown 顺序保持", its[0].unknownMeta[0].raw === "dsh-meta future: one" && its[0].unknownMeta[1].raw === "dsh-meta future: two");
  ok("duplicate unknown round-trip", serializeLaneBody(parseLaneBody(tDup)) === tDup);
}
const tSpace = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 1\ndsh-meta spaced:  value with spaces  \n${BODY_LINE}\nx\n${END_LINE}\n`;
{
  const its = items(parseLaneBody(tSpace));
  ok("unknown 空白/拼写 verbatim", its[0].unknownMeta[0].raw === "dsh-meta spaced:  value with spaces  ");
  ok("unknown 空白 round-trip", serializeLaneBody(parseLaneBody(tSpace)) === tSpace);
}
const tEmpty = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: 1\ndsh-meta empty:\n${BODY_LINE}\nx\n${END_LINE}\n`;
{
  const its = items(parseLaneBody(tEmpty));
  ok("empty unknown 保留", its[0].unknownMeta[0].raw === "dsh-meta empty:");
  ok("empty unknown round-trip", serializeLaneBody(parseLaneBody(tEmpty)) === tEmpty);
}
// parse → modify known field → serialize：unknown 不丢
{
  const p = parseLaneBody(tDup);
  const i = items(p)[0];
  i.comment = "modified";
  const out = serializeLaneBody(p);
  ok("modify known 后 unknown 仍保留两个", (out.match(/dsh-meta future:/g) || []).length === 2);
  ok("modify known 后 comment 更新", out.includes("modified") && !out.includes("\nx\n"));
}

// ---- R4: makeItem 非法组合 reject ----
console.log("— R4: makeItem rejects invalid —");
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
ok("source-aware 缺 snapshot → throw", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh" })));
ok("source-independent 带 snapshot → throw", throws(() => makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", snapshot: "x" })));
ok("kind 非法 → throw", throws(() => makeItem({ kind: "bogus", captureOrigin: "session-abcdefgh" })));
ok("origin 非法 → throw", throws(() => makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "../evil" })));
ok("origin 非法短 → throw", throws(() => makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "ab" })));
ok("source-aware 合法（snapshot 空串允许）", (() => { const i = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "" }); return i.snapshot === ""; })());
ok("source-independent 合法（comment）", (() => { const i = makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "c" }); return i.comment === "c"; })());

// ---- R5: 基础语义回归（保留 v0 的覆盖）----
console.log("— 基础语义（回归）—");
{
  const body = "- [2026-08-31] 普通笔记内容";
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: ${[...body].length}\n${BODY_LINE}\n${body}\n${END_LINE}\n`;
  const p = parseLaneBody(t);
  const i = items(p)[0];
  ok("source-independent 解析", i.kind === KIND_SOURCE_INDEPENDENT && i.comment === body);
  ok("round-trip", serializeLaneBody(p) === t);
}
{
  const snap = "> 原文引用\n> 第二行";
  const comm = "我的评论：要注意 X";
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\ndsh-meta snapshot-length: ${[...snap].length}\ndsh-meta comment-length: ${[...comm].length}\n${BODY_LINE}\n${snap}${comm}\n${END_LINE}\n`;
  const p = parseLaneBody(t);
  const i = items(p)[0];
  ok("source-aware snapshot/comment 精确切分", i.snapshot === snap && i.comment === comm);
  ok("roles 机械区分", i.snapshot !== i.comment);
  ok("round-trip", serializeLaneBody(p) === t);
}
{
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\ndsh-meta snapshot-length: 8\n${BODY_LINE}\nsnapshot\n${END_LINE}\n`;
  const i = items(parseLaneBody(t))[0];
  ok("comment-free source-aware", i.snapshot === "snapshot" && i.comment === undefined);
}
{
  // CJK + emoji（码点计数）
  const body = "- 便签：需要整理的事项 😀 中文";
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-a\ndsh-meta body-length: ${[...body].length}\n${BODY_LINE}\n${body}\n${END_LINE}\n`;
  const i = items(parseLaneBody(t))[0];
  ok("CJK/emoji 按码点精确保留", i.comment === body);
  ok("CJK/emoji round-trip", serializeLaneBody(parseLaneBody(t)) === t);
}
{
  // code fences in snapshot
  const snap = "```js\nconst x = 1;\n```";
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-aware\ndsh-meta origin: session-a\ndsh-meta snapshot-length: ${[...snap].length}\n${BODY_LINE}\n${snap}\n${END_LINE}\n`;
  ok("code fence snapshot 精确", items(parseLaneBody(t))[0].snapshot === snap);
}
{
  // duplicate identical captures remain two items
  const a = serializeItem(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "same" }));
  ok("duplicate identical items 保持两个", items(parseLaneBody(a + "\n" + a + "\n")).length === 2);
}
{
  // order preserved
  const p = parseLaneBody("legacyA\n\n" + serializeItem(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "b" })) + "\n\nlegacyB\n");
  ok("节点顺序 legacy,item,legacy", p.nodes.map((n) => n.type).join(",") === "legacy,item,legacy");
}
{
  // no auto migration / dedupe
  ok("纯 legacy 不迁移", parseLaneBody("- legacy\n## 标题\n").nodes[0].type === "legacy");
}
{
  // human inspectable
  const out = serializeLaneBody(parseLaneBody(`${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta origin: session-abcdefgh\ndsh-meta body-length: 2\n${BODY_LINE}\n内容\n${END_LINE}\n`));
  ok("输出纯文本 Markdown 可检查", out.includes("内容") && !/base64/.test(out));
}

// ---- Serialization edge cases: 空 payload / 尾换行 / 连续尾空行精确 round-trip ----
console.log("— C2: payload 边界精确 round-trip —");
{
  const cases = [
    ["空 payload（source-independent）", KIND_SOURCE_INDEPENDENT, "", undefined, undefined],
    ["空 payload（source-aware snapshot 空）", KIND_SOURCE_AWARE, "", "", undefined],
    ["空 snapshot + 非空 comment", KIND_SOURCE_AWARE, "", "comment", undefined],
    ["尾换行 payload（source-independent）", KIND_SOURCE_INDEPENDENT, "x\n", undefined, undefined],
    ["尾换行 comment", KIND_SOURCE_AWARE, "snap", "comment\n", undefined],
    ["连续尾空行", KIND_SOURCE_INDEPENDENT, "x\n\n\n", undefined, undefined],
    ["多行 snapshot + 多行 comment", KIND_SOURCE_AWARE, "s1\n\ns2", "c1\nc2\n", undefined],
  ];
  for (const [name, kind, snapshot, comment] of cases) {
    const item = kind === KIND_SOURCE_AWARE
      ? makeItem({ kind, captureOrigin: "session-abcdefgh", snapshot, comment })
      : makeItem({ kind, captureOrigin: "session-abcdefgh", comment: snapshot });
    const t = serializeItem(item) + "\n";
    const p = parseLaneBody(t);
    const i = items(p)[0];
    const bodyExact = kind === KIND_SOURCE_AWARE ? i.snapshot === snapshot && (i.comment ?? "") === (comment ?? "") : i.comment === snapshot;
    ok(`[${name}] 解析精确`, i !== undefined && bodyExact);
    ok(`[${name}] round-trip`, serializeLaneBody(p) === t);
  }
}

// ---- Serialization edge cases: unknown metadata 相对 known 位置保持 ----
console.log("— C2: metadata 行顺序（known/unknown 交错）保持 —");
{
  const t = `${BEGIN_LINE}\ndsh-meta kind: source-independent\ndsh-meta future-a: 1\ndsh-meta origin: session-abcdefgh\ndsh-meta future-b: 2\ndsh-meta body-length: 1\n${BODY_LINE}\nx\n${END_LINE}\n`;
  const p = parseLaneBody(t);
  ok("known/unknown 交错解析", items(p)[0].kind === KIND_SOURCE_INDEPENDENT && items(p)[0].captureOrigin === "session-abcdefgh");
  ok("metadata 顺序 round-trip", serializeLaneBody(p) === t);
  // modify known field → 顺序仍保持
  const i = items(p)[0];
  i.comment = "yy";
  const out = serializeLaneBody(p);
  const metaLines = out.split("\n").filter((l) => l.startsWith("dsh-meta "));
  ok("modify 后顺序保持（future-a 在 origin 前、future-b 在长度前）", metaLines.indexOf("dsh-meta future-a: 1") < metaLines.indexOf("dsh-meta origin: session-abcdefgh") && metaLines.indexOf("dsh-meta future-b: 2") < metaLines.indexOf("dsh-meta body-length: 2"));
}

// ---- Source payload construction ----
console.log("— C2: makeItem sourcePayload（不静默忽略）—");
{
  const goodLocator = { projectionVersion: 1, sessionId: "session-abcdefgh", segments: [{ eventSeq: 1, start: 0, end: 2 }] };
  const i = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: goodLocator });
  ok("source-aware 接受合法 locator sourcePayload", JSON.stringify(i.sourcePayload) === JSON.stringify(goodLocator));
  ok("serialize 输出 source-payload（Notes behavior regression durable 格式）", serializeItem(i).includes("dsh-meta source-payload:"));
  ok("source-independent 带 sourcePayload → throw", throws(() => makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", sourcePayload: goodLocator })));
  // R11: 非法 locator 构造时拒绝
  ok("primitive sourcePayload → throw", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: "not-object" })));
  ok("无 projectionVersion 对象 → throw（R11）", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: { not: "a locator" } })));
  ok("非整数 projectionVersion → throw（R11）", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: { projectionVersion: "1", sessionId: "session-abcdefgh", segments: [{ eventSeq: 1, start: 0, end: 2 }] } })));
  ok("缺字段 sourcePayload → throw", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: { projectionVersion: 1 } })));
  ok("空 segments sourcePayload → throw", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: { projectionVersion: 1, sessionId: "session-abcdefgh", segments: [] } })));
  ok("非法 sessionId sourcePayload → throw", throws(() => makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: { projectionVersion: 1, sessionId: "s1", segments: [{ eventSeq: 1, start: 0, end: 2 }] } })));
  // future version → 接受为 opaque（serialize 输出；parse raw 保守）
  const future = { projectionVersion: 99, sessionId: "session-abcdefgh", segments: [{ eventSeq: 1, start: 0, end: 2 }] };
  const fItem = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s", sourcePayload: future });
  ok("future version sourcePayload 接受为 opaque", fItem.sourcePayload.projectionVersion === 99);
  ok("future serialize 输出 + parse raw 保留", serializeItem(fItem).includes("dsh-meta source-payload:"));
  const noSp = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s" });
  ok("无 sourcePayload 可正常 serialize", !throws(() => serializeItem(noSp)));
}

// ---- test recheck-1: v2 locator durable round-trip（make → serialize → parse → resolve）----
console.log("— C2-v2: v2 sourcePayload durable round-trip —");
{
  const v2Locator = { projectionVersion: 2, sessionId: "session-abcdefgh", segments: [{ eventSeq: 1, start: 0, end: 3 }] };
  const item = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "**粗** 文", sourcePayload: v2Locator });
  ok("v2 locator sourcePayload 接受", JSON.stringify(item.sourcePayload) === JSON.stringify(v2Locator));
  const t = serializeItem(item) + "\n";
  ok("v2 serialize 输出 source-payload", t.includes("dsh-meta source-payload:"));
  const p = parseLaneBody(t);
  const its = items(p);
  ok("v2 parse 仍为 structured item（非 raw）", its.length === 1);
  ok("v2 sourcePayload 语义恢复（非 raw 保留）", JSON.stringify(its[0].sourcePayload) === JSON.stringify(v2Locator));
  ok("v2 round-trip 稳定", serializeLaneBody(p) === t);
  // 语义闭环：v2 locator + persisted content → locator-only resolve
  const content = [{ type: "text", text: "**粗** 文" }];
  const resolved = resolveLocator(v2Locator, (sid, seq) => sid === "session-abcdefgh" && seq === 1 ? content : undefined);
  ok("v2 locator-only 重构 = 可见文本", resolved.text === "粗 文", JSON.stringify(resolved.text));
}

console.log("— C2-v3: sessionId + messageId source identity round-trip —");
{
  const identity = { sessionId: "session-abcdefgh", messageId: "message-stable-1" };
  const item = makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: identity.sessionId, snapshot: "历史选中", sourcePayload: identity });
  const parsed = parseLaneBody(serializeItem(item)).nodes.find((n) => n.type === "item")?.item;
  ok("new identity sourcePayload accepted", JSON.stringify(parsed?.sourcePayload) === JSON.stringify(identity));
  ok("new identity has no durable event coordinates", parsed?.sourcePayload?.segments === undefined && parsed?.sourcePayload?.projectionVersion === undefined);
}

// ---- Comment metadata: 无 comment 条目添加 comment 后 serialize 自动补写 comment-length ----
console.log("— C3: 添加/删除 comment 后 serializer 长度字段自动同步 —");
{
  // 正向：无 comment → 添加 comment → serialize → 再 parse 仍为 structured
  const t0 = serializeItem(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "原文" })) + "\n";
  const p0 = parseLaneBody(t0);
  ok("初始无 comment 解析为 structured", items(p0).length === 1 && items(p0)[0].comment === undefined);
  const i0 = items(p0)[0];
  i0.comment = "新增评论";
  const out = serializeLaneBody(p0);
  ok("serialize 自动补写 comment-length", out.includes("dsh-meta comment-length: 4"));
  const p1 = parseLaneBody(out);
  ok("再 parse 仍为 structured（非 opaque legacy）", items(p1).length === 1);
  ok("snapshot 保持", items(p1)[0].snapshot === "原文");
  ok("comment 保持", items(p1)[0].comment === "新增评论");
  ok("round-trip 稳定", serializeLaneBody(parseLaneBody(out)) === out);

  // 反向：有 comment → 删除 comment（设为空）→ serialize → 再 parse 仍 structured
  const t2 = serializeItem(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-abcdefgh", snapshot: "s2", comment: "要删的评论" })) + "\n";
  const p2 = parseLaneBody(t2);
  const i2 = items(p2)[0];
  ok("初始有 comment", i2.comment === "要删的评论");
  i2.comment = "";
  const out2 = serializeLaneBody(p2);
  ok("comment 清空后移除 comment-length", !out2.includes("dsh-meta comment-length"));
  const p3 = parseLaneBody(out2);
  ok("清空 comment 后再 parse 仍 structured", items(p3).length === 1);
  ok("snapshot 保持", items(p3)[0].snapshot === "s2");
  ok("comment 缺省（undefined）", items(p3)[0].comment === undefined);

  // source-independent 不受影响
  const t4 = serializeItem(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "body" })) + "\n";
  const p4 = parseLaneBody(t4);
  items(p4)[0].comment = "改";
  const out4 = serializeLaneBody(p4);
  ok("SI 修改 comment 后 round-trip", items(parseLaneBody(out4))[0].comment === "改");
}



console.log("— behavior regression: holder-local item-key（opaque unknown-meta row）—");
{
  const { getItemKey, withItemKey, newItemKey, ITEM_KEY_META } = await import("../lib/structured-item.js");
  const k1 = newItemKey(), k2 = newItemKey();
  ok("item-key 是 fresh opaque token（每次不同）", typeof k1 === "string" && k1.length > 6 && k1 !== k2);

  // makeItem 产物（无 metaOrder 路径）→ withItemKey → serialize → parse → key 保留、round-trip 字节稳定
  const it = makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "hello" });
  const keyed = withItemKey(it, k1);
  const s1 = serializeItem(keyed);
  ok("withItemKey 新增 unknown-meta 行且 serialize 含 item-key", s1.includes(`dsh-meta item-key: ${k1}`));
  const p1 = parseLaneBody(s1);
  ok("makeItem+key round-trip 稳定（serialize(parse)==原）", serializeItem(p1.nodes[0].item) === s1);
  ok("parse 后 getItemKey 取回同一 token", getItemKey(p1.nodes[0].item) === k1);

  // parse 产物（带 metaOrder 路径）→ withItemKey → serialize → parse → key 保留
  const old = serializeItem(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "old" }));
  const parsedOld = parseLaneBody(old).nodes[0].item;
  const keyed2 = withItemKey(parsedOld, k2);
  const s2 = serializeItem(keyed2);
  const p2 = parseLaneBody(s2);
  ok("parsed item + key round-trip 稳定", serializeItem(p2.nodes[0].item) === s2);
  ok("parsed item getItemKey 取回同一 token", getItemKey(p2.nodes[0].item) === k2);

  // 无 key 的既有内容 serialize 字节不变（零回归）
  ok("无 key 旧 item serialize 字节不变", serializeItem(parsedOld) === old);

  // 替换 key（不新增重复行）
  const replaced = withItemKey(keyed, "ik-xyz");
  const s3 = serializeItem(replaced);
  ok("withItemKey 替换 key（不重复）", (s3.match(/dsh-meta item-key:/g) || []).length === 1 && s3.includes("dsh-meta item-key: ik-xyz"));

  // duplicate byte-identical items 各自带不同 key（migration 后不同 identity）
  const dupA = withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "dup" }), k1);
  const dupB = withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "session-abcdefgh", comment: "dup" }), k2);
  const parsedDup = parseLaneBody(serializeItem(dupA) + "\n" + serializeItem(dupB));
  const keys = parsedDup.nodes.filter((n) => n.type === "item").map((n) => getItemKey(n.item));
  ok("byte-identical items 各自独立 key（不撞 key）", keys.length === 2 && keys[0] !== keys[1] && keys[0] === k1 && keys[1] === k2);
}

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
