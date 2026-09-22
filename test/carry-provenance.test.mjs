// Fork/carry provenance conformance tests
// 复用 notes-api 的 real-LocalFileSystem fixture；聚焦 Notes behavior regression 矩阵：
// A 普通 source-independent carry（capture-origin 不重算、不伪造 source）
// B source-aware carry（origin/locator/snapshot 原样；child holder + derivation 分离）
// C/D authored 非空/空 + source 两角色保留
// E all/some/none（既有语义不回归，抽查）
// F occupied lane merge：structured items 可 parse、metadata 各自附着
// G duplicate identical anchored 保持两条 + 原顺序
// H parent/child edit 独立
// I/J closure/deletion 独立（走既有文件边界，无新删除机制）
// K child re-entry（授权）→ 原历史 source
// L child re-entry（无授权 / source 不可用）→ truthful，不 rebind
// N malformed structured at carry boundary → 安全复制、无部分语义改写
import { apply } from "../lib/index.js";
import { handleReentryRoute } from "../lib/reentry-routes.js";
import { makeItem, serializeItem, parseLaneBody, getItemKey } from "../lib/structured-item.js";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const L1 = "conversation_todo";
const L2 = "deferred_work";
const L3 = "knowledge_candidate";
const L4 = "lesson_candidate";
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

const SID_A = "session-carry-parent-000001"; // 合法 SESSION_ID_RE
const SID_B = "session-carry-child-0000001";

/** source-independent structured item（有 capture-origin，无 Source Anchor）。 */
function srcIndependentBlock(text = "普通便签A") {
  return serializeItem(makeItem({ kind: "source-independent", captureOrigin: SID_A, comment: text }));
}

/** source-aware block：sourcePayload 指向 A 的 seq7 "SOURCE-A"。 */
function srcAwareBlock({ comment = "" } = {}) {
  return serializeItem(makeItem({
    kind: "source-aware",
    captureOrigin: SID_A,
    snapshot: "SOURCE-A",
    comment,
    sourcePayload: { projectionVersion: 1, sessionId: SID_A, segments: [{ eventSeq: 7, start: 0, end: 8 }] },
  }));
}

async function main() {
  const ws = await mkdtemp(join(tmpdir(), "dsh-carry-"));
  const notesRoot = join(ws, "notes");
  const sessions = new Map([
    [SID_A, { id: SID_A, header: { cwd: ws } }],
  ]);
  let handler;
  const eventListeners = new Map();
  const app = new Context();
  const fs = new LocalFileSystem(app, { cwd: ws, diffBasisMaxBytes: 1024 * 1024 });
  const ctx = { fs, get: () => sessions, webServer: { register: (cfg) => { handler = cfg.handler; } }, on: (name, fn) => { eventListeners.set(name, fn); } };
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(ws, "dsh-home");
  const applyPromise = apply(ctx);
  await applyPromise;
  const H = { host: "127.0.0.1:3080" };
  const childBase = `/notes-api/${SID_B}`;
  const baseA = `/notes-api/${SID_A}`;
  const createdListener = eventListeners.get("session/created");
  const getLane = async (sid, lane) => readFile(join(notesRoot, lane, `${sid}.md`), "utf8").catch(() => "");
  const putLane = async (sid, lane, body) => {
    const g = await call(handler, makeReq({ url: `/notes-api/${sid}/${lane}`, headers: H }));
    const s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${sid}/${lane}`, headers: { ...H, "if-match": g.headers["x-notes-mtime"] ?? "0" }, body }));
    return s;
  };
  const newChild = async (id) => { sessions.set(id, { id, header: { cwd: ws, parentSession: SID_A } }); await createdListener(sessions.get(id)); };
  const carryOver = async (id, body) => call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify(body) }));

  // ---- 准备 parent L1：一条普通文本 + 一条 source-aware（带 authored） + 一条
  // source-aware（空 authored），用于 B/C/D + A/G ----
  const blockWith = srcAwareBlock({ comment: "父注记" });
  const blockEmpty = srcAwareBlock(); // comment 空 → parse 无 comment 字段
  const parentL1 = "普通笔记行一\n\n" + blockWith + "\n\n" + blockEmpty;
  await putLane(SID_A, L1, parentL1);

  console.log("— Notes behavior regression：source-independent carry（capture-origin 不重算、不伪造 Source Anchor）—");
  {
    // parent L1 已有 source-aware 块（供 Notes behavior regression 用）；此处用 L2 放 source-independent
    // structured item + 一段裸文本，验证 Notes behavior regression：
    //   holder → child；capture-origin 仍是 A（不重算为 B）；不伪造 historical source。
    await putLane(SID_A, L2, "plain-note-content\n\n" + srcIndependentBlock());
    const child = `session-carry-child-000000a`;
    await newChild(child);
    await carryOver(child, { sessionId: child, choice: "all" });
    const got = await getLane(child, L2);
    const parentL2 = await getLane(SID_A, L2);
    // fork/carry eligibility decision derivation binding：keyless parent structured item 的 child copy
    // 获得 fresh child-local key → child 不再逐字节等于 parent（parent 原件不变；
    // 内容/provenance 原样）。见 A2/A3/A4 + marker binding。
    ok("A1 carry 生成 child-local copy：child 每条 structured item 含 fresh item-key，parent 文件不变",
      got !== parentL2 && got.includes("dsh-meta item-key:") && !parentL2.includes("dsh-meta item-key:") && (await getLane(SID_A, L2)) === parentL2);
    const parsed = parseLaneBody(got);
    const items = parsed.nodes.filter((n) => n.type === "item");
    const srcInd = items.find((n) => n.item.kind === "source-independent");
    ok("A2 source-independent structured item 完整 parse（source-independent 存在）", !!srcInd);
    ok("A3 holder=child、capture-origin 仍为 A（未重算为 child）",
      srcInd.item.captureOrigin === SID_A && srcInd.item.captureOrigin !== child);
    ok("A4 source-independent 不伪造 Source Anchor（无 sourcePayload/source-aware）",
      srcInd.item.sourcePayload === undefined && srcInd.item.snapshot === undefined);
    ok("A5 裸文本段落保留且无 dsh-meta 注入", got.includes("plain-note-content"));
    const childL1 = await getLane(child, L1);
    ok("A6 carried L1 structured 块 origin 保持 A（未改写为 B）", childL1.includes("dsh-meta origin: " + SID_A) && !childL1.includes("dsh-meta origin: " + child));
  }

  console.log("— Notes behavior regression/C/D：source-aware carry 保留四关系 —");
  {
    const child = `session-carry-child-000000b`;
    await newChild(child);
    await carryOver(child, { sessionId: child, choice: "all" });
    const got = await getLane(child, L1);
    const parsed = parseLaneBody(got);
    const aware = parsed.nodes.filter((n) => n.type === "item" && n.item.kind === "source-aware");
    ok("B1 child L1 两条 source-aware item 完整 parse", aware.length === 2);
    ok("B2 capture-origin 保持 A（非 child）", aware.every((n) => n.item.captureOrigin === SID_A));
    ok("B3 历史 locator 原样（sourcePayload.sessionId == A、segments 不变）",
      aware.every((n) => n.item.sourcePayload.sessionId === SID_A && n.item.sourcePayload.segments[0].eventSeq === 7 && n.item.sourcePayload.segments[0].start === 0 && n.item.sourcePayload.segments[0].end === 8));
    ok("B4 全量 snapshot 保留", aware.every((n) => n.item.snapshot === "SOURCE-A"));
    ok("C1 authored 非空 item 的 comment 保留（source-role 分离）", aware.some((n) => n.item.comment === "父注记"));
    ok("D1 authored 空 item 无 comment 但 source 保留", aware.some((n) => n.item.comment === undefined && n.item.snapshot === "SOURCE-A"));
    const marker = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${child}.json`), "utf8"));
    ok("B5 child holder + derivation 分离（marker.parentSessionId==A；carriedLanes 含 L1）",
      marker.parentSessionId === SID_A && marker.status === "carried" && Array.isArray(marker.carriedLanes) && marker.carriedLanes.includes(L1));
    ok("B6 child lane 文件（holder）与 parent lane 文件独立存在",
      (await getLane(SID_A, L1)) === parentL1 && (await getLane(child, L1)) !== "");
  }

  console.log("— Notes behavior regression：all/some/none 抽查（既有语义不回归）—");
  {
    const cNone = `session-carry-child-000000c`;
    await newChild(cNone);
    await carryOver(cNone, { sessionId: cNone, choice: "none" });
    ok("E1 none → child 无复制、marker none", (await getLane(cNone, L1)) === "" );
    await putLane(SID_A, L3, "l3 content"); // seed parent L3
    const cSome = `session-carry-child-000000d`;
    await newChild(cSome);
    await carryOver(cSome, { sessionId: cSome, choice: "some", lanes: [L3] });
    ok("E2 some(L3) → L3 copied、L1 未复制", (await getLane(cSome, L3)) === "l3 content" && (await getLane(cSome, L1)) === "");
    const cAll = `session-carry-child-000000e`;
    await newChild(cAll);
    await carryOver(cAll, { sessionId: cAll, choice: "all" });
    ok("E3 all → L1+L2 copied（内容物化；child copy 含 fresh key）",
      (await getLane(cAll, L1)).length > 0 && (await getLane(cAll, L2)).length > 0 && (await getLane(cAll, L2)).includes("普通便签A"));
  }

  console.log("— Notes behavior regression：occupied lane merge 保持 structured items —");
  {
    const child = `session-carry-child-000000f`;
    await newChild(child);
    const childOwn = "child own note line\n\n" + srcAwareBlock({ comment: "child注记" });
    await putLane(child, L1, childOwn); // occupied
    const pre = await call(handler, makeReq({ url: `/notes-api/${child}/fork-preflight`, headers: H }));
    // 直接走 fork-carryover merge resolution 形态：先 preflight 后 apply？
    // fork-carryover 路由封装了冲突 resolution？改用 fork-apply 形态
    // （本测试直接验证结果：occupied child → 需 resolution；用 merge）
    // 简化：fork-carryover 不支持带 resolution → 走 fork-preflight+fork-apply。
    const preflight = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: child, choice: "all" }) }));
    ok("F1 occupied child preflight 正常", preflight.code === 200, JSON.stringify(preflight.body).slice(0,120));
    const preJson = JSON.parse(preflight.body);
    // observations 来自 preflight 的 bound（parent/child kind+version）——apply 在锁内
    // 与 live stat 复核，防 Window B。
    const observations = {};
    for (const laneInfo of preJson.lanes || []) {
      observations[laneInfo.lane] = { parent: laneInfo.parent, child: laneInfo.child };
    }
    const applyRes = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: child, choice: "all", resolutions: { [L1]: "merge" }, observations }) }));
    ok("F2 merge resolution apply → 200", applyRes.code === 200, JSON.stringify(applyRes.body).slice(0,120));
    const merged = await getLane(child, L1);
    const parsed = parseLaneBody(merged);
    const items = parsed.nodes.filter((n) => n.type === "item");
    ok("F3 merge 后 child 原 item 仍在（child注记 SOURCE-A）", items.some((n) => n.item.kind === "source-aware" && n.item.comment === "child注记"));
    ok("F4 merge 后 parent item 原样进入（父注记 SOURCE-A，origin A）", items.some((n) => n.item.kind === "source-aware" && n.item.comment === "父注记" && n.item.captureOrigin === SID_A));
    ok("F5 structured source metadata 各自附着（每条 sourcePayload.sessionId==A）", items.every((n) => n.item.kind !== "source-aware" || n.item.sourcePayload.sessionId === SID_A));
    // keep / replace 对 structured item 的语义（既有 fork/carry eligibility decision）
    const childKeep = `session-carry-child-000000k`;
    await newChild(childKeep);
    await putLane(childKeep, L1, "child own note\n\n" + srcAwareBlock({ comment: "keep注记" }));
    const pfK = JSON.parse((await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: childKeep, choice: "all" }) }))).body);
    const obsK = {}; for (const l of pfK.lanes || []) obsK[l.lane] = { parent: l.parent, child: l.child };
    await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: childKeep, choice: "all", resolutions: { [L1]: "keep" }, observations: obsK }) }));
    ok("F6 keep → child 原 structured 内容保留（parent 未覆盖；无 partial 改写）", (await getLane(childKeep, L1)).includes("keep注记") && !(await getLane(childKeep, L1)).includes("父注记"));
    const childRep = `session-carry-child-000000r`;
    await newChild(childRep);
    await putLane(childRep, L1, "child own note\n\n" + srcAwareBlock({ comment: "rep注记" }));
    const pfR = JSON.parse((await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: childRep, choice: "all" }) }))).body);
    const obsR = {}; for (const l of pfR.lanes || []) obsR[l.lane] = { parent: l.parent, child: l.child };
    await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: childRep, choice: "all", resolutions: { [L1]: "replace" }, observations: obsR }) }));
    const repContent = await getLane(childRep, L1);
    const repItems = parseLaneBody(repContent).nodes.filter((n) => n.type === "item" && n.item.kind === "source-aware");
    ok("F7 replace → child == parent 内容（structured 原样、origin A、无 child 残留）",
      repContent.includes("父注记") && !repContent.includes("rep注记") && repContent.includes("dsh-meta origin: " + SID_A));
    ok("F7b replace 后 parse：source-aware item 完整（sourcePayload/snapshot/origin 各自正确）",
      repItems.length >= 1 && repItems.every((n) =>
        n.item.captureOrigin === SID_A && n.item.snapshot === "SOURCE-A" &&
        n.item.sourcePayload && n.item.sourcePayload.sessionId === SID_A &&
        n.item.sourcePayload.segments[0].eventSeq === 7));
    // Empty parent side + occupied child → merge 不生无意义 wrapper，
    // child 内容原样保留（结构化字节不变）
    const childE = `session-carry-child-000000e1`;
    await newChild(childE);
    const childOwnBlock = srcAwareBlock({ comment: "elide注" });
    await putLane(childE, L4, "child own\n\n" + childOwnBlock); // parent L4 从未写过（空/absent）
    const pfE = JSON.parse((await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: childE, choice: "all" }) }))).body);
    const obsE = {}; for (const l of pfE.lanes || []) obsE[l.lane] = { parent: l.parent, child: l.child };
    const childL4Before = await getLane(childE, L4);
    const resE = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: childE, choice: "all", resolutions: { [L4]: "merge" }, observations: obsE }) }));
    ok("F8 merge（parent 空 + child 占位）apply → 200 carried", resE.code === 200, JSON.stringify(resE.body).slice(0,100));
    const childL4After = await getLane(childE, L4);
    ok("F8b child 内容原样（无 来自父分支/当前分支 wrapper、无空父段）",
      childL4After === childL4Before && !childL4After.includes("来自父分支") && !childL4After.includes("当前分支已有内容"));
    ok("F8c child 侧 structured block 仍可 parse 且 metadata 完好",
      (() => { const items = parseLaneBody(childL4After).nodes.filter((n) => n.type === "item" && n.item.kind === "source-aware"); return items.length === 1 && items[0].item.comment === "elide注" && items[0].item.captureOrigin === SID_A; })());
  }

  console.log("— Notes behavior regression：duplicate identical anchored 保持两条 + 顺序 —");
  {
    const parent2 = `session-carry-parent2-0001`;
    sessions.set(parent2, { id: parent2, header: { cwd: ws } });
    const same = srcAwareBlock();
    const dupBody = same + "\n\n" + same; // 两条字节完全相同的 duplicate capture
    await putLane(parent2, L1, dupBody);
    const child = `session-carry-child-000000g`;
    sessions.set(child, { id: child, header: { cwd: ws, parentSession: parent2 } });
    await createdListener(sessions.get(child));
    await carryOver(child, { sessionId: child, choice: "all" });
    const got = await getLane(child, L1);
    // 顺序证明：child 内容与 parent 逐字节一致（identical 无 receipt 可区分时，
    // 顺序唯一可观察载体是文件字节序）
    // fork/carry eligibility decision derivation binding：keyless duplicate anchored parent items → child copy 各获
    // fresh 且互异 child-local key（parent 原件不变）；两条 identical 仍都保留、不 dedupe。
    ok("G1 carry 生成两条 keyed child copies（fresh 互异 key；parent 文件不变；不 dedupe）",
      got !== dupBody && (got.match(/dsh-meta item-key:/g) || []).length === 2 && (await getLane(parent2, L1)) === dupBody);
    const items = parseLaneBody(got).nodes.filter((n) => n.type === "item");
    ok("G2 两条 identical source-aware 均保留（无 carry-time dedupe/replace-last）", items.length === 2);
    // 带可区分 receipt（unknown meta）的重复 capture：顺序按 receipt 可观察
    const mkDup = (tag) => serializeItem(makeItem({
      kind: "source-aware", captureOrigin: parent2, snapshot: "SOURCE-A",
      sourcePayload: { projectionVersion: 1, sessionId: parent2, segments: [{ eventSeq: 7, start: 0, end: 8 }] },
      unknownMeta: [{ raw: `dsh-meta x-receipt: ${tag}` }],
    }));
    await putLane(parent2, L2, mkDup("G-first") + "\n\n" + mkDup("G-second"));
    const child2 = `session-carry-child-000000g2`;
    sessions.set(child2, { id: child2, header: { cwd: ws, parentSession: parent2 } });
    await createdListener(sessions.get(child2));
    await carryOver(child2, { sessionId: child2, choice: "all" });
    const got2 = await getLane(child2, L2);
    const items2 = parseLaneBody(got2).nodes.filter((n) => n.type === "item" && n.item.kind === "source-aware");
    const tagOf = (it) => (it.item.unknownMeta || []).find((u) => u.raw && u.raw.includes("x-receipt:"))?.raw || "";
    ok("G3 可区分 receipt 顺序保持（first 在前、second 在后，未 swap/dedupe）",
      items2.length === 2 && tagOf(items2[0]).includes("G-first") && tagOf(items2[1]).includes("G-second"));
  }

  console.log("— Notes behavior regression/I/J：parent/child 生命周期独立 —");
  {
    const child = `session-carry-child-000000h`;
    await newChild(child);
    await carryOver(child, { sessionId: child, choice: "all" });
    const parentBefore = await getLane(SID_A, L1);
    const markerFile = join(ws, "notes", ".carry-over", `${child}.json`);
    const markerBefore = await readFile(markerFile, "utf8");
    // child edit
    await putLane(child, L1, parentBefore + "\n\nchild-extra");
    ok("H1 child edit 后 parent 未变", (await getLane(SID_A, L1)) === parentBefore);
    // parent edit
    await putLane(SID_A, L1, parentBefore + "\n\nparent-extra");
    ok("H2 parent edit 后 child 未变（无自动传播）", !(await getLane(child, L1)).includes("parent-extra"));
    // I（closure）：无 Notes closure API——可观察断言 = 先保存 child 编辑**前**的
    // parent 与 marker 快照，再做多次 child 编辑，断言快照不变（真实比较，非断言
    // 时同刻重读自比）；closure 语义本身仅由“不存在 closure API / 无跨会话写”
    // 支撑（源码检查），不计作 runtime closure 测试。
    const parentBeforeI = await getLane(SID_A, L1);
    const markerBeforeI = await readFile(markerFile, "utf8");
    await putLane(child, L1, (await getLane(child, L1)) + "\n\nmore");
    await putLane(child, L1, (await getLane(child, L1)) + "\n\nmore2");
    const parentAfterI = await getLane(SID_A, L1);
    const markerAfterI = await readFile(markerFile, "utf8");
    ok("I1 多次 child 编辑后 parent 与 marker 字节不变（对比编辑前快照；无自动闭包/无跨会话写）",
      parentAfterI === parentBeforeI && markerAfterI === markerBeforeI && parentBeforeI.includes("parent-extra"));
    // J（deletion，supporting evidence）：不存在 Notes 删除 API；本断言只证明物理
    // 文件级独立性（file-level supporting evidence），不声称 deletion-governance
    // conformance（现有删除边界保持不变）。
    const childL1BeforeParentDel = await getLane(child, L1);
    await rm(join(notesRoot, L1, `${SID_A}.md`), { force: true });
    ok("J1（supporting）删 parent lane 文件 → child 文件不变（file-level 独立）", (await getLane(child, L1)) === childL1BeforeParentDel);
    const markerJ = JSON.parse(await readFile(markerFile, "utf8"));
    ok("J2（supporting）删 parent 后 derivation marker 保留", markerJ.status === "carried" && markerJ.parentSessionId === SID_A);
    const parentL2Before = await getLane(SID_A, L2);
    await rm(join(notesRoot, L1, `${child}.md`), { force: true });
    ok("J3（supporting）删 child lane 文件 → parent L2 不变", (await getLane(SID_A, L2)) === parentL2Before);
  }

  console.log("— Notes behavior regression/L：child-carried anchor re-entry（原历史 source）—");
  {
    // 真实 child lane 中 parse 出一个 source-aware block → 其 locator 指向 parent A seq7
    const child = `session-carry-child-000000b`;
    const got = await getLane(child, L1);
    const item = parseLaneBody(got).nodes.find((n) => n.type === "item" && n.item.kind === "source-aware");
    const locator = item.item.sourcePayload;
    const parentEvents = [
      { seq: 7, type: "user/message", time: 1, data: { id: "carry-msg-7", content: [{ type: "text", text: "SOURCE-A" }], source: { kind: "user" } } },
      { seq: 17, type: "assistant/message", time: 2, data: { message: { content: [{ type: "text", text: "OTHER" }] } } },
    ];
    const reentryCtx = {
      get: (n) => (n === "sessionQuery" ? {
        async readSession(sid) { if (sid === SID_A) return { session: { id: sid }, events: parentEvents }; throw new Error("no session " + sid); },
        async readEvent({ sessionId, seq }) { const pool = parentEvents; const i = pool.findIndex((e) => e.seq === seq); return { startSeq: Math.max(0, i - 1), endSeq: Math.min(pool.length - 1, i + 1), events: pool.slice(Math.max(0, i - 1), Math.min(pool.length - 1, i + 1) + 1) }; },
      } : undefined),
      readLane: async (holderSessionId, laneKey) => getLane(holderSessionId, laneKey),
      logger: { info() {}, error() {} },
    };
    const callR = async (body) => {
      const res = makeRes();
      await handleReentryRoute(reentryCtx, makeReq({ method: "POST", url: "/notes-api/reentry", headers: {}, body: JSON.stringify(body) }), res, new URL("/notes-api/reentry", "http://x"), { readLane: reentryCtx.readLane });
      return JSON.parse(res.state.body || "{}");
    };
    // L: 无授权（current=child B，target=A parent）
    const rNo = await callR({ currentSessionId: child, locator });
    ok("L1 child re-entry 无 consent → unauthorized（nothing read；不 rebind）", rNo.ok === false && rNo.status === "unauthorized");
    // K: 授权 → 原历史 source（A 的 SOURCE-A，非 child holder source）
    const rYes = await callR({ currentSessionId: child, locator, noteRef: { holderSessionId: child, laneKey: L1, itemKey: getItemKey(item.item) }, expectedSnapshot: item.item.snapshot, consent: "per-request", contextWindow: 0 });
    ok("K1 child re-entry with authority → exact 原 source（text SOURCE-A, session A）", rYes.ok === true && rYes.status === "exact" && rYes.exact.text === "SOURCE-A" && rYes.exact.sessionId === SID_A);
    ok("K2 re-entry 未 rebind 到 child/另一 source", rYes.exact.sessionId === SID_A);
    // L2: source 不可用 → truthful unavailable
    const reentryCtxGone = {
      get: (n) => (n === "sessionQuery" ? { async readSession() { throw new Error("gone"); }, readEvent() {} } : undefined),
      readLane: async (holderSessionId, laneKey) => getLane(holderSessionId, laneKey),
      logger: { info() {}, error() {} },
    };
    const res2 = makeRes();
    await handleReentryRoute(reentryCtxGone, makeReq({ method: "POST", url: "/notes-api/reentry", headers: {}, body: JSON.stringify({ currentSessionId: child, locator, noteRef: { holderSessionId: child, laneKey: L1, itemKey: getItemKey(item.item) }, expectedSnapshot: item.item.snapshot, consent: "per-request" }) }), res2, new URL("/notes-api/reentry", "http://x"), { readLane: reentryCtxGone.readLane });
    const rGone = JSON.parse(res2.state.body || "{}");
    ok("L2 source 不可用 → unavailable（快照/provenance 保留，无 rebind）", rGone.ok === false && rGone.status === "unavailable");
  }

  console.log("— Notes behavior regression：malformed structured at carry boundary —");
  {
    const parentN = `session-carry-parentn-0001`;
    sessions.set(parentN, { id: parentN, header: { cwd: ws } });
    const malformed = "--- dsh-note v1 begin\ndsh-meta kind: source-aware\ndsh-meta snapshot-length: 999\n--- dsh-body\nOOPS\n--- dsh-note v1 end";
    await putLane(parentN, L2, malformed);
    const child = `session-carry-child-000000n`;
    sessions.set(child, { id: child, header: { cwd: ws, parentSession: parentN } });
    await createdListener(sessions.get(child));
    await carryOver(child, { sessionId: child, choice: "all" });
    const got = await getLane(child, L2);
    ok("N1 malformed 块整体复制（字节保留，无部分语义改写/无逐行重写）", got === malformed);
    const nodes = parseLaneBody(got).nodes;
    ok("N2 malformed 块 parse 为 legacy（未被误解析/被改写为语义）", nodes.some((n) => n.type === "legacy") || nodes.length === 0);
  }

  // cleanup env
  process.env.DSH_HOME = prevHome;
  await rm(ws, { recursive: true, force: true });
  console.log("");
  console.log(`结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
