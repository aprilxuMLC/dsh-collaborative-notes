// Source behavior regression / Notes behavior regression anchored routes tests（host handler，mock ctx.sessionQuery）
// 验证 validate/prepare HTTP 语义：authoritative validation、block 生成、
// sessionQuery 不可用 fail-closed、非法输入。
import { handleAnchoredRoute } from "../lib/anchored-routes.js";
import { Session } from "@deepseek-ai/dsh-session";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const SID = "session-wo3-0002";

// 构造最小 req/res
function fakeReq(body, method = "POST") {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  const req = { method, resume() {} };
  req[Symbol.asyncIterator] = async function* () { if (buf.length) yield buf; };
  return req;
}
function fakeRes() {
  const out = { status: null, headers: {}, body: "" };
  return {
    out,
    writeHead(s, h) { out.status = s; Object.assign(out.headers, h || {}); return this; },
    end(b) { out.body = b || ""; },
  };
}
function urlFor(path) { return new URL(path, "http://x"); }

// 真实 rc.2 sessionQuery.readSession 返回 corpus 存储形态的**扁平** event
// （{ seq, type, time, data }，非 session.history 的 { event: {...} } 包裹形态；
// The route must normalize the authoritative snapshot before it can be passed to
// buildSnapshotFromEvents——此 mock 用真实扁平形态做回归。
const EVENTS = [
  { seq: 7, type: "user/message", time: 1788350218000, data: { id: "63cb3cea-12f5-4d88-94d7-b37cdcda9e35", content: [{ type: "text", text: "SOURCE-A" }], source: { kind: "user" } } },
  { seq: 17, type: "assistant/message", time: 1788350219000, data: { message: { id: "assistant-message-17", content: [{ type: "text", text: "ASSISTANT-B" }] } } },
];

function makeCtx(over = {}) {
  const sessionQuery = Object.prototype.hasOwnProperty.call(over, "sessionQuery")
    ? over.sessionQuery
    : { async readSession() { return { events: EVENTS }; } };
  return {
    get(name) {
      if (name === "sessionQuery") return sessionQuery;
      if (name === "sessions") return over.sessions;
      return undefined;
    },
    logger: { error() {}, info() {} },
    ...over,
  };
}

const goodCandidate = {
  sessionId: SID,
  projectionVersion: 1,
  segments: [{ eventSeq: 7, start: 0, end: 8 }],
  effectiveSourceText: "SOURCE-A",
  unresolved: [{ text: "04:56", reason: "after-projection" }],
};

console.log("— Notes behavior regression anchored routes: validate —");
{
  const ctx = makeCtx();
  const res = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: goodCandidate }), res, urlFor("/notes-api/anchored/validate"));
  const json = JSON.parse(res.out.body);
  ok("V1 validate ok", res.out.status === 200 && json.ok === true, res.out.body.slice(0, 140));
  ok("V1 validated 含 sourcePayload + effective", json.ok && json.validated.effectiveSourceText === "SOURCE-A" && json.validated.sourcePayload.sessionId === SID);
  // 篡改 effective → host 校验拒绝
  const res2 = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: { ...goodCandidate, effectiveSourceText: "HACKED" } }), res2, urlFor("/notes-api/anchored/validate"));
  const j2 = JSON.parse(res2.out.body);
  ok("V2 篡改 effective → ok:false EFFECTIVE_MISMATCH", j2.ok === false && j2.code === "EFFECTIVE_MISMATCH", res2.out.body.slice(0, 120));
  // unresolved 落在投影内（identity：eventSeq + startCP < projLen）→ 拒绝
  const res3 = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: { ...goodCandidate, unresolved: [{ eventSeq: 7, text: "SOURCE-A", startCP: 0, endCP: 8, reason: "after-projection" }] } }), res3, urlFor("/notes-api/anchored/validate"));
  const j3 = JSON.parse(res3.out.body);
  ok("V3 unresolved 落在投影内 → ok:false UNRESOLVED_INSIDE_PROJECTION", j3.ok === false && j3.code === "UNRESOLVED_INSIDE_PROJECTION");
  // sessionQuery 不可用 → fail-closed
  const ctxNoSq = makeCtx({ sessionQuery: undefined });
  const res4 = fakeRes();
  await handleAnchoredRoute(ctxNoSq, fakeReq({ candidate: goodCandidate }), res4, urlFor("/notes-api/anchored/validate"));
  const j4 = JSON.parse(res4.out.body);
  ok("V4 sessionQuery 不可用 → fail-closed SESSION_QUERY_UNAVAILABLE", j4.ok === false && j4.code === "SESSION_QUERY_UNAVAILABLE", res4.out.body.slice(0, 130));
  // 非法 sessionId → 400
  const res5 = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: { ...goodCandidate, sessionId: "bad!" } }), res5, urlFor("/notes-api/anchored/validate"));
  ok("V5 非法 sessionId → 400", res5.out.status === 400, String(res5.out.status));
  // 非 POST → 405
  const res6 = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({}, "GET"), res6, urlFor("/notes-api/anchored/validate"));
  ok("V6 非 POST → 405", res6.out.status === 405);
}

console.log("— Notes behavior regression anchored routes: prepare —");
{
  const ctx = makeCtx();
  const res = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: goodCandidate, lane: "conversation_todo", comment: "test note" }), res, urlFor("/notes-api/anchored/prepare"));
  const json = JSON.parse(res.out.body);
  ok("P1 prepare ok → block 含 source-aware item", res.out.status === 200 && json.ok === true && typeof json.block === "string", (json.block || "").slice(0, 90));
  ok("P1 block 是 Notes behavior regression source-aware（含 kind/snapshot/source-payload meta）", typeof json.block === "string" && json.block.includes("dsh-meta kind: source-aware") && json.block.includes("source-payload") && json.block.includes("dsh-meta snapshot-length: 8"), (json.block || "").slice(0, 160));
  // 无效 lane → ok:false
  const res2 = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: goodCandidate, lane: "bogus", comment: "" }), res2, urlFor("/notes-api/anchored/prepare"));
  const j2 = JSON.parse(res2.out.body);
  ok("P2 非法 lane → ok:false INVALID_LANE", j2.ok === false && j2.code === "INVALID_LANE");
  // comment 空 → 合法（snapshot 保留）
  const res3 = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: goodCandidate, lane: "conversation_todo", comment: "" }), res3, urlFor("/notes-api/anchored/prepare"));
  const j3 = JSON.parse(res3.out.body);
  ok("Source behavior regression comment 空 → ok，block 无 comment-length", j3.ok === true && !j3.block.includes("comment-length"), (j3.block || "").slice(0, 120));
}

console.log("— Notes behavior regression anchored routes: public live-session fast path —");
{
  const live = Session.create("session-live-0002");
  live.append("user/message", { id: "m-live-1", content: [{ type: "text", text: "LIVE-SOURCE" }], source: { kind: "user" } }, { surfaceOp: "append" });
  live.append("assistant/message", { turn: 4, step: 2, message: { id: "m-live-assist", content: [{ type: "text", text: "LIVE-ASSIST" }] } }, { surfaceOp: "append" });
  let readSessionCalls = 0;
  let eventsAccesses = 0;
  let snapshotEventsCalls = 0;
  const liveView = new Proxy(live, {
    get(target, property, receiver) {
      if (property === "events") eventsAccesses++;
      if (property === "snapshotEvents") {
        const snapshotEvents = Reflect.get(target, property, receiver);
        if (typeof snapshotEvents === "function") return (...args) => { snapshotEventsCalls++; return snapshotEvents.apply(target, args); };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const publicSnapshotReads = () => eventsAccesses + snapshotEventsCalls;
  const ctx = makeCtx({
    sessions: { async get(id) { return id === live.id ? liveView : undefined; } },
    sessionQuery: { async readSession() { readSessionCalls++; return { events: EVENTS }; } },
  });
  const liveUser = {
    sessionId: live.id,
    projectionVersion: 1,
    evidence: {
      sessionId: live.id,
      projectionVersion: 1,
      anchors: [{ nodeKey: "13:input-messagem-live-1", basisText: "LIVE-SOURCE", startCP: 0, endCP: 11, order: 0 }],
    },
  };
  const res = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: liveUser }), res, urlFor("/notes-api/anchored/validate"));
  const json = JSON.parse(res.out.body);
  ok("L1 live evidence validates", json.ok === true && json.validated.effectiveSourceText === "LIVE-SOURCE", res.out.body.slice(0, 150));
  ok("L2 live validate does not call readSession", readSessionCalls === 0);
  ok("L3 live validate accesses one public event snapshot", publicSnapshotReads() === 1, String(publicSnapshotReads()));

  const assistant = {
    sessionId: live.id,
    projectionVersion: 1,
    evidence: {
      sessionId: live.id,
      projectionVersion: 1,
      anchors: [{ nodeKey: "14:assistant-step4:2", basisText: "LIVE-ASSIST", startCP: 0, endCP: 11, order: 0 }],
    },
  };
  const prep = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: assistant, lane: "conversation_todo", comment: "live" }), prep, urlFor("/notes-api/anchored/prepare"));
  const prepJson = JSON.parse(prep.out.body);
  ok("L4 live prepare validates and emits source-aware block", prepJson.ok === true && prepJson.block.includes("LIVE-ASSIST") && prepJson.block.includes("source-payload"));
  ok("L5 live prepare still does not call readSession", readSessionCalls === 0);
  ok("L6 each live request gets a fresh public event snapshot", publicSnapshotReads() === 2, String(publicSnapshotReads()));

  const multi = {
    sessionId: live.id,
    projectionVersion: 1,
    evidence: {
      sessionId: live.id,
      projectionVersion: 1,
      anchors: [
        { nodeKey: "14:assistant-step4:2", basisText: "LIVE-ASSIST", startCP: 0, endCP: 11, order: 0 },
        { nodeKey: "13:input-messagem-live-1", basisText: "LIVE-SOURCE", startCP: 0, endCP: 11, order: 1 },
      ],
    },
  };
  const multiRes = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: multi }), multiRes, urlFor("/notes-api/anchored/validate"));
  const multiJson = JSON.parse(multiRes.out.body);
  ok("L6a cross-message live capture fails closed", multiJson.ok === false && multiJson.code === "CAPTURE_EVIDENCE_REJECTED" && multiJson.detail?.reason?.includes("one authoritative messageId"), multiRes.out.body.slice(0, 140));

  // Normal rc.2 append invalidates Session.events. A new renderer identity
  // must resolve on the next request rather than against a cached first read.
  live.append("user/message", { id: "m-live-2", content: [{ type: "text", text: "APPENDED-LIVE" }], source: { kind: "user" } }, { surfaceOp: "append" });
  const appended = {
    sessionId: live.id,
    projectionVersion: 1,
    evidence: {
      sessionId: live.id,
      projectionVersion: 1,
      anchors: [{ nodeKey: "13:input-messagem-live-2", basisText: "APPENDED-LIVE", startCP: 0, endCP: 13, order: 0 }],
    },
  };
  const fresh = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: appended }), fresh, urlFor("/notes-api/anchored/validate"));
  const freshJson = JSON.parse(fresh.out.body);
  ok("L7 appended live event resolves after Session.append", freshJson.ok === true && freshJson.validated.effectiveSourceText === "APPENDED-LIVE", fresh.out.body.slice(0, 150));
  ok("L8 appended request remains readSession-free", readSessionCalls === 0 && publicSnapshotReads() === 4);

  // A stale renderer identity in an attached session must reject; it must not
  // silently fall back to a full readSession.
  const stale = { ...liveUser, evidence: { ...liveUser.evidence, anchors: [{ ...liveUser.evidence.anchors[0], nodeKey: "13:input-messageno-such-event" }] } };
  const staleRes = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: stale }), staleRes, urlFor("/notes-api/anchored/validate"));
  const staleJson = JSON.parse(staleRes.out.body);
  ok("L9 stale live identity rejects truthfully", staleJson.ok === false && staleJson.code === "CAPTURE_EVIDENCE_REJECTED");
  ok("L10 stale live identity does not fall back", readSessionCalls === 0 && publicSnapshotReads() === 5);

  const malformed = { ...liveUser, evidence: { ...liveUser.evidence, anchors: [{ ...liveUser.evidence.anchors[0], nodeKey: "13:input-message" }] } };
  const malformedRes = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: malformed }), malformedRes, urlFor("/notes-api/anchored/validate"));
  const malformedJson = JSON.parse(malformedRes.out.body);
  ok("L10a malformed live key rejects without fallback", malformedJson.ok === false && malformedJson.code === "CAPTURE_EVIDENCE_REJECTED" && readSessionCalls === 0 && publicSnapshotReads() === 6);

  const projectionMismatch = { ...liveUser, evidence: { ...liveUser.evidence, anchors: [{ ...liveUser.evidence.anchors[0], basisText: "NOT-LIVE-SOURCE" }] } };
  const projectionRes = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: projectionMismatch }), projectionRes, urlFor("/notes-api/anchored/validate"));
  const projectionJson = JSON.parse(projectionRes.out.body);
  ok("L10b projection mismatch rejects without fallback", projectionJson.ok === false && projectionJson.code === "CAPTURE_EVIDENCE_REJECTED" && readSessionCalls === 0 && publicSnapshotReads() === 7);

  const forgedExtent = { ...liveUser, evidence: { ...liveUser.evidence, anchors: [{ ...liveUser.evidence.anchors[0], endCP: 999 }] } };
  const forgedRes = fakeRes();
  await handleAnchoredRoute(ctx, fakeReq({ candidate: forgedExtent }), forgedRes, urlFor("/notes-api/anchored/validate"));
  const forgedJson = JSON.parse(forgedRes.out.body);
  ok("L10c forged extent rejects without fallback", forgedJson.ok === false && forgedJson.code === "CAPTURE_EVIDENCE_REJECTED" && readSessionCalls === 0 && publicSnapshotReads() === 8);

  let ambiguousReads = 0;
  let ambiguousEventsAccesses = 0;
  const ambiguousEvents = [
    { seq: 10, type: "user/message", data: { id: "duplicate-id", content: [{ type: "text", text: "ONE" }] } },
    { seq: 11, type: "user/message", data: { id: "duplicate-id", content: [{ type: "text", text: "TWO" }] } },
  ];
  const ambiguousSession = { get events() { ambiguousEventsAccesses++; return ambiguousEvents; } };
  const ambiguousCtx = makeCtx({
    sessions: { async get() { return ambiguousSession; } },
    sessionQuery: { async readSession() { ambiguousReads++; return { events: EVENTS }; } },
  });
  const ambiguousCandidate = {
    sessionId: SID,
    projectionVersion: 1,
    evidence: {
      sessionId: SID,
      projectionVersion: 1,
      anchors: [{ nodeKey: "13:input-messageduplicate-id", basisText: "ONE", startCP: 0, endCP: 3, order: 0 }],
    },
  };
  const ambiguousRes = fakeRes();
  await handleAnchoredRoute(ambiguousCtx, fakeReq({ candidate: ambiguousCandidate }), ambiguousRes, urlFor("/notes-api/anchored/validate"));
  const ambiguousJson = JSON.parse(ambiguousRes.out.body);
  ok("L10d duplicate live identity rejects fail-closed", ambiguousJson.ok === false && ambiguousJson.code === "LIVE_SOURCE_IDENTITY_AMBIGUOUS" && ambiguousReads === 0 && ambiguousEventsAccesses === 1);

  let coldReads = 0;
  const coldCtx = makeCtx({
    sessions: { async get() { return undefined; } },
    sessionQuery: { async readSession() { coldReads++; return { events: EVENTS }; } },
  });
  const coldRes = fakeRes();
  await handleAnchoredRoute(coldCtx, fakeReq({ candidate: goodCandidate }), coldRes, urlFor("/notes-api/anchored/validate"));
  const coldJson = JSON.parse(coldRes.out.body);
  ok("L11 cold session uses existing readSession fallback", coldJson.ok === true && coldReads === 1);

  let invalidLiveReads = 0;
  const invalidLiveCtx = makeCtx({
    sessions: { async get() { return { events: null }; } },
    sessionQuery: { async readSession() { invalidLiveReads++; return { events: EVENTS }; } },
  });
  const invalidLiveRes = fakeRes();
  await handleAnchoredRoute(invalidLiveCtx, fakeReq({ candidate: goodCandidate }), invalidLiveRes, urlFor("/notes-api/anchored/validate"));
  const invalidLiveJson = JSON.parse(invalidLiveRes.out.body);
  ok("L12 attached live session with invalid public events fails without fallback", invalidLiveJson.ok === false && invalidLiveJson.code === "LIVE_SESSION_EVENTS_INVALID" && invalidLiveReads === 0);
}

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
