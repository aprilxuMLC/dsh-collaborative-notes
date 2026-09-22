// fork/carry eligibility decision derivation binding — focused validation
// exact binding = marker v2 per-lane child item-keys；evaluateExactDerivation 是唯一
// derivation authority（不用 captureOrigin）。
import { apply } from "../lib/index.js";
import { evaluateExactDerivation, carryRekeyWithKeys } from "../lib/carry-merge.js";
import { makeItem, serializeItem, parseLaneBody, withItemKey, newItemKey, getItemKey } from "../lib/structured-item.js";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

const L1 = "conversation_todo";
const srcInd = (origin, comment) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: origin, comment }), newItemKey()));

async function main() {
  console.log("== Unit：evaluateExactDerivation（marker validation matrix）==");
  {
    const okMarker = { version: 2, parentSessionId: "P1", status: "carried", bindings: { [L1]: ["k-a"] } };
    ok("U1: 命中唯一 key → derived", evaluateExactDerivation({ headerParentSession: "P1", marker: okMarker, lane: L1, itemKey: "k-a" }).ok === true);
    ok("U2: 无 marker → 不 derived", evaluateExactDerivation({ headerParentSession: "P1", marker: null, lane: L1, itemKey: "k-a" }).ok === false);
    ok("U3: v1 marker（无 bindings）→ 不 derived", evaluateExactDerivation({ headerParentSession: "P1", marker: { version: 1, parentSessionId: "P1", status: "carried" }, lane: L1, itemKey: "k-a" }).reason === "version-or-shape-unsupported");
    ok("U4: status ≠ carried → 不 derived", evaluateExactDerivation({ headerParentSession: "P1", marker: { ...okMarker, status: "unresolved" }, lane: L1, itemKey: "k-a" }).reason === "status-not-carried");
    ok("U5: parentSessionId 不一致 → 不 derived", evaluateExactDerivation({ headerParentSession: "P9", marker: okMarker, lane: L1, itemKey: "k-a" }).reason === "parent-mismatch");
    ok("U6: lane 无 binding → 不 derived", evaluateExactDerivation({ headerParentSession: "P1", marker: okMarker, lane: "deferred_work", itemKey: "k-a" }).reason === "lane-unbound");
    ok("U7: key 不在 binding → 不 derived", evaluateExactDerivation({ headerParentSession: "P1", marker: okMarker, lane: L1, itemKey: "k-x" }).reason === "not-bound");
    ok("U8: binding 中 key 重复 → fail closed", evaluateExactDerivation({ headerParentSession: "P1", marker: { ...okMarker, bindings: { [L1]: ["k-a", "k-a"] } }, lane: L1, itemKey: "k-a" }).reason === "ambiguous-duplicate-key");
    ok("U9: 当前 lane 中同一 item-key 出现两次 → fail closed（不 claim exact derived）", evaluateExactDerivation({ headerParentSession: "P1", marker: okMarker, lane: L1, itemKey: "k-a", itemKeyOccurrences: 2 }).reason === "ambiguous-duplicate-in-lane");
  }

  console.log("== Unit：carryRekeyWithKeys（keyless → fresh key）==");
  {
    const keyless = serializeItem(makeItem({ kind: "source-independent", captureOrigin: "session-p4d-parent-000001", comment: "KL" }));
    const r = carryRekeyWithKeys(keyless);
    ok("K1: keyless item → child text 含 fresh key；keys 长度 1", r.keys.length === 1 && typeof r.keys[0] === "string" && r.text.includes("dsh-meta item-key:"));
    ok("K2: keys 都是 fresh（互异）", carryRekeyWithKeys([keyless, keyless].join("\n")).keys.length === 2);
  }

  console.log("== Integration（real apply，node runtime test）==");
  {
    const ws = await mkdtemp(join(tmpdir(), "dsh-dbind-"));
    const notesRoot = join(ws, "notes");
    const sessions = new Map();
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
    const getLane = async (sid) => readFile(join(notesRoot, L1, `${sid}.md`), "utf8").catch(() => "");
    const putLane = async (sid, body) => {
      const g = await call(handler, makeReq({ url: `/notes-api/${sid}/${L1}`, headers: H }));
      await call(handler, makeReq({ method: "PUT", url: `/notes-api/${sid}/${L1}`, headers: { ...H, "if-match": g.headers["x-notes-mtime"] ?? "0" }, body }));
    };
    const spawn = (id, parent, seedLength) => { sessions.set(id, { id, header: parent ? { cwd: ws, parentSession: parent, seedLength } : { cwd: ws } }); };
    const markChild = async (id) => { if (createdListener) await createdListener(sessions.get(id)); };
    const carryAll = async (id) => call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: id, choice: "all" }) }));
    const applyAll = async (id, resolutions, observations) => call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: id, choice: "all", resolutions, observations }) }));
    const markerOf = async (id) => JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${id}.json`), "utf8")).catch ? null : JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${id}.json`), "utf8"));
    const evalFor = (marker, sid, itemKey, parentHeader) => evaluateExactDerivation({ headerParentSession: parentHeader, marker, lane: L1, itemKey });
    const itemsWithKeys = async (sid) => parseLaneBody(await getLane(sid)).nodes.filter((n) => n.type === "item").map((n) => ({ comment: n.item.comment, key: getItemKey(n.item), origin: n.item.captureOrigin }));

    // ========== A→B→C + 场景 1/6 ==========
    const A = "session-db-parent-a-0001"; const B = "session-db-child-b-000001"; const C = "session-db-child-c-000001"; const CUT = 6;
    spawn(A);
    await putLane(A, [srcInd(A, "A-NOTE-1"), srcInd(A, "A-NOTE-2")].join("\n"));
    // A→B carry（copy）
    spawn(B, A, CUT); await markChild(B);
    const rB = bodyOf(await carryAll(B));
    ok("S1: A→B carry carried", rB.status === "carried");
    const markerB = await markerOf(B);
    ok("S2: markerB v2 + L1 binding 有 2 keys", markerB.version === 2 && markerB.parentSessionId === A && markerB.status === "carried" && (markerB.bindings[L1] || []).length === 2);
    // B→C carry（merge into structured C lane）
    spawn(C, B, CUT); await markChild(C);
    await putLane(C, [srcInd(C, "C-NATIVE")].join("\n"));
    const conflictC = bodyOf(await carryAll(C));
    ok("S3: B→C occupied → conflict", conflictC.status === "conflict");
    const rc = bodyOf(await applyAll(C, { [L1]: "merge" }, conflictC.observations));
    ok("S4: B→C merge applied", rc.status === "carried");
    const markerC = await markerOf(C);
    const cItems = await itemsWithKeys(C);
    ok("S5: C 中 carried item capture-origin 仍为 A（历史 capture 事实保留）", cItems.find((i) => i.comment === "A-NOTE-1").origin === A);
    ok("S6: C immediate derivation = B→C（markerC.parentSessionId === B；binding 只含本次 B-derived keys）", markerC.parentSessionId === B && markerC.status === "carried" && markerC.version === 2 && Array.isArray(markerC.bindings[L1]) && markerC.bindings[L1].length === 2);
    ok("S7: C 中 B-derived item 逐条 exact derived（经 C marker）", cItems.filter((i) => i.comment === "A-NOTE-1" || i.comment === "A-NOTE-2").every((i) => evalFor(markerC, C, i.key, B).ok === true));
    ok("S8: C-native item 不是 derived（key 不在 binding）", evalFor(markerC, C, cItems.find((i) => i.comment === "C-NATIVE").key, B).ok === false);
    ok("S9: 用 B 的 marker 判 C item → parent 不匹配（不做 A/B marker 混判）", evalFor(markerB, C, cItems.find((i) => i.comment === "A-NOTE-1").key, B).reason === "not-bound" || evalFor(markerB, C, cItems.find((i) => i.comment === "A-NOTE-1").key, B).ok === false);

    // ========== 场景 2：foreign-origin injection（whole-lane PUT，非本次 carry）==========
    await putLane(C, (await getLane(C)) + "\n" + srcInd("X-FOREIGN-SESSION", "FOREIGN-1"));
    const cItems2 = await itemsWithKeys(C);
    const foreign = cItems2.find((i) => i.comment === "FOREIGN-1");
    ok("S10: foreign-origin item（whole-lane PUT 写入，key 不在 C binding）→ NOT current-carry derived", foreign.origin === "X-FOREIGN-SESSION" && evalFor(markerC, C, foreign.key, B).ok === false && evalFor(markerC, C, foreign.key, B).reason === "not-bound");
    ok("S11: 插入 foreign 后原 derived item 仍 derived（binding 不受影响）", cItems2.filter((i) => i.comment === "A-NOTE-1" || i.comment === "A-NOTE-2").every((i) => evalFor(markerC, C, i.key, B).ok === true));

    // ========== 场景 3/4：真实 ordinary edit（整层 PUT，仅改 authored 内容、保 key）==========
    const derivedItem = cItems.find((i) => i.comment === "A-NOTE-1");
    const derivedOrig = (await getLane(C)).split("\n").find((l) => l.startsWith("dsh-meta item-key:") );
    const laneText = await getLane(C);
    const laneParsed = parseLaneBody(laneText);
    const targetIdx = laneParsed.nodes.findIndex((n) => n.type === "item" && n.item.comment === "A-NOTE-1");
    const editedItem = { ...laneParsed.nodes[targetIdx].item, comment: "A-NOTE-1-EDITED" };
    laneParsed.nodes[targetIdx] = { type: "item", item: editedItem };
    // 用与编辑器同构的 serialize 路径重建并整层 PUT（key 行保留）
    const { serializeLaneBody } = await import("../lib/structured-item.js");
    const editedLane = serializeLaneBody(laneParsed);
    await putLane(C, editedLane);
    const cItemsE = await itemsWithKeys(C);
    const edited = cItemsE.find((i) => i.comment === "A-NOTE-1-EDITED");
    ok("S12: 真实 ordinary edit（改 authored、保 key）→ derivation 仍成立", Boolean(edited) && edited.key === derivedItem.key && evalFor(markerC, C, edited.key, B).ok === true, JSON.stringify({ k0: derivedItem.key, k1: edited && edited.key, reason: edited ? evalFor(markerC, C, edited.key, B).reason : "missing" }));
    // 删除 bound key（raw PUT 换新文本只含无 key/换 key item）→ 不 fuzzy rebind
    await putLane(C, srcInd(C, "REPLACED-KEYED"));
    const after = await itemsWithKeys(C);
    ok("S13: bound key 被替换后 → 不 fuzzy rebind（新 key 不在 binding → not derived；无补猜）", after.every((i) => evalFor(markerC, C, i.key, B).ok === false));
    // parent（B）不受 C 影响
    const markerB2 = await markerOf(B);
    ok("S14: parent/child 独立（B marker 未被 C 编辑改动；await 真实断言）", markerB2.version === 2 && markerB2.status === "carried" && markerB2.parentSessionId === A);
  }
  console.log("== Integration 2：keyless parent → child fresh key 且进入 v2 binding ==");
  {
    const ws = await mkdtemp(join(tmpdir(), "dsh-dbind2-"));
    const notesRoot = join(ws, "notes");
    const sessions = new Map();
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
    const getLane = async (sid) => readFile(join(notesRoot, L1, `${sid}.md`), "utf8").catch(() => "");
    const putLane = async (sid, body) => {
      const g = await call(handler, makeReq({ url: `/notes-api/${sid}/${L1}`, headers: H }));
      await call(handler, makeReq({ method: "PUT", url: `/notes-api/${sid}/${L1}`, headers: { ...H, "if-match": g.headers["x-notes-mtime"] ?? "0" }, body }));
    };
    const PA = "session-db2-parent-a-0001"; const CB = "session-db2-child-b-000001"; const CUT2 = 6;
    sessions.set(PA, { id: PA, header: { cwd: ws } });
    const keylessParent = serializeItem(makeItem({ kind: "source-independent", captureOrigin: PA, comment: "KL-PARENT" })); // 无 key
    await putLane(PA, keylessParent);
    sessions.set(CB, { id: CB, header: { cwd: ws, parentSession: PA, seedLength: CUT2 } });
    if (createdListener) await createdListener(sessions.get(CB));
    const r = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CB, choice: "all" }) })));
    ok("K3: keyless parent carry（copy）成功", r.status === "carried");
    const marker = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${CB}.json`), "utf8"));
    const childText = await getLane(CB);
    const childItem = parseLaneBody(childText).nodes.find((n) => n.type === "item" && n.item.comment === "KL-PARENT").item;
    const parentText = await getLane(PA);
    ok("K4: parent 原件仍 keyless 不变", !parentText.includes("dsh-meta item-key:") && parentText.includes("KL-PARENT"));
    ok("K5: child copy 获 fresh key 且该 key 进入 v2 binding", typeof getItemKey(childItem) === "string" && marker.version === 2 && (marker.bindings[L1] || []).includes(getItemKey(childItem)), JSON.stringify(marker.bindings));
  }
  console.log("== Integration 3：fork-carryover（无冲突路径）stale guard 直接回归 ==");
  {
    const ws = await mkdtemp(join(tmpdir(), "dsh-dbind3-"));
    const notesRoot = join(ws, "notes");
    const sessions = new Map();
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
    const getLane = async (sid) => readFile(join(notesRoot, L1, `${sid}.md`), "utf8").catch(() => "");
    const PA3 = "session-db3-parent-a-0001"; const CB3 = "session-db3-child-b-000001"; const CUT3 = 6;
    sessions.set(PA3, { id: PA3, header: { cwd: ws } });
    await (async () => {
      const g = await call(handler, makeReq({ url: `/notes-api/${PA3}/${L1}`, headers: H }));
      await call(handler, makeReq({ method: "PUT", url: `/notes-api/${PA3}/${L1}`, headers: { ...H, "if-match": g.headers["x-notes-mtime"] ?? "0" }, body: srcInd(PA3, "S-PARENT-1") }));
    })();
    sessions.set(CB3, { id: CB3, header: { cwd: ws, parentSession: PA3, seedLength: CUT3 } });
    if (createdListener) await createdListener(sessions.get(CB3));
    // child lane 预置为空文件（present-empty）→ fs.stat 返回真实对象，第 2 次 stat 可 bump
    await (async () => {
      const g = await call(handler, makeReq({ url: `/notes-api/${CB3}/${L1}`, headers: H }));
      await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CB3}/${L1}`, headers: { ...H, "if-match": g.headers["x-notes-mtime"] ?? "0" }, body: "" }));
    })();
    const markerPath = join(ws, "notes", ".carry-over", `${CB3}.json`);
    const markerBefore = JSON.parse(await readFile(markerPath, "utf8"));
    // 确定性制造 preflight→apply 间 drift：把 child lane 的第 2 次 stat 版本 +1
    const origStat = fs.stat.bind(fs);
    let childLaneStat = 0;
    fs.stat = async (target) => {
      const st = await origStat(target);
      const key = String((target && target.targetKey) || "");
      // 只对 child **lane .md** 文件计数：preflight 第 1 次 stat（观察基线）→
      // apply Phase-1 第 2 次 stat（revalidation）时把 version +1 → 强制 stale。
      if (key.includes(CB3) && key.endsWith(`/${L1}/${CB3}.md`)) {
        childLaneStat++;
        if (childLaneStat === 2 && st) return { ...st, version: (st.version ?? 0) + 1 };
      }
      return st;
    };
    const r3 = bodyOf(await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CB3, choice: "all" }) })));
    fs.stat = origStat;
    ok("ST1: fork-carryover 返回 stale（无冲突路径 guard 生效）", r3.status === "stale", JSON.stringify(r3));
    const markerAfter = JSON.parse(await readFile(markerPath, "utf8"));
    ok("ST2: marker 仍 unresolved（不写 carried/v2/bindings）", markerAfter.status === "unresolved" && markerAfter.version === markerBefore.version && !("bindings" in markerAfter));
    ok("ST3: child lane 未被 carry 覆盖（仍为空文件，无 parent 内容物化）", (await getLane(CB3)) === "");
    ok("ST4: 无成功 derived binding（marker 无 bindings → evaluate 不 derived）",
      evaluateExactDerivation({ headerParentSession: PA3, marker: markerAfter, lane: L1, itemKey: "k" }).reason === "version-or-shape-unsupported" || evaluateExactDerivation({ headerParentSession: PA3, marker: markerAfter, lane: L1, itemKey: "k" }).ok === false);
  }
  console.log("\n结果：fork/carry eligibility decision derivation binding " + passed + " 通过 / " + failed + " 失败");
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
