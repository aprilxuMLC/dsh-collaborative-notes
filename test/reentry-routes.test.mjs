// Source behavior regression / Notes behavior regression re-entry route tests（host handler，mock ctx.sessionQuery + 无 fs）
// J 跨 session 无授权不解引用；K 授权 bounded 跨 session read（每请求、无 standing）；
// L read-only 无 mutation；同 session exact；status unavailable/incompatible；
// read-time bounded surrounding context。
import { handleReentryRoute } from "../lib/reentry-routes.js";
import { makeItem, serializeItem, withItemKey } from "../lib/structured-item.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const SID_A = "session-wo4-a0001";
const SID_B = "session-wo4-b0002";

function fakeReq(body, method = "POST") {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  const req = { method, resume() {} };
  req[Symbol.asyncIterator] = async function* () { if (buf.length) yield buf; };
  return req;
}
function fakeRes() {
  const out = { status: null, body: "" };
  return {
    out,
    writeHead(s) { out.status = s; return this; },
    end(b) { out.body = b || ""; },
  };
}
function urlFor(p) { return new URL(p, "http://x"); }

function makeCtx(over = {}) {
  const eventsA = [
    { seq: 7, type: "user/message", time: 1, data: { id: "a-msg-7", content: [{ type: "text", text: "SOURCE-A" }], source: { kind: "user" } } },
    { seq: 17, type: "assistant/message", time: 2, data: { message: { content: [{ type: "text", text: "ASSIST-B" }] } } },
  ];
  const eventsB = [
    { seq: 5, type: "user/message", time: 1, data: { id: "b-msg-5", content: [{ type: "text", text: "OTHER-B" }], source: { kind: "user" } } },
  ];
  const reads = { count: 0, event: 0, note: 0 };
  const durableBodies = {
    [SID_A]: () => serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID_A, snapshot: "SOURCE-A", sourcePayload: locA }), "ik-a")),
    [SID_B]: () => serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID_B, snapshot: "OTHER-B", sourcePayload: locB }), "ik-b")),
  };
  const sessionQuery = {
    async readSession(sid) {
      reads.count++;
      if (sid === SID_A) return { session: { id: sid }, events: eventsA };
      if (sid === SID_B) return { session: { id: sid }, events: eventsB };
      throw new Error("session not found: " + sid);
    },
    async readEvent({ sessionId, seq, before, after }) {
      reads.event++;
      const pool = sessionId === SID_A ? eventsA : eventsB;
      const idx = pool.findIndex((e) => e.seq === seq);
      if (idx < 0) throw new Error("no event " + seq);
      const start = Math.max(0, idx - (before ?? 0));
      const end = Math.min(pool.length - 1, idx + (after ?? 0));
      return { startSeq: start, endSeq: end, events: pool.slice(start, end + 1) };
    },
    async readLane(holderSessionId, laneKey) {
      reads.note++;
      if (laneKey !== "conversation_todo") throw new Error("unexpected lane");
      return durableBodies[holderSessionId]?.() ?? "";
    },
  };
  // L: ctx 无 fs —— route 若碰 fs/writer 会直接失败；同时给一个 write spy 断言零写。
  const writes = [];
  const sqOverride = Object.prototype.hasOwnProperty.call(over, "sessionQuery") ? over.sessionQuery : sessionQuery;
  return {
    get(name) { return name === "sessionQuery" ? sqOverride : undefined; },
    logger: { info() {}, error() {} },
    fs: { withLock: async () => { writes.push("withLock"); }, resolve() {}, stat() {} },
    writes,
    reads,
    readLane: over.readLane || sessionQuery.readLane,
    ...over,
  };
}

const locA = { sessionId: SID_A, projectionVersion: 1, segments: [{ eventSeq: 7, start: 0, end: 8 }] };
const locB = { sessionId: SID_B, projectionVersion: 1, segments: [{ eventSeq: 5, start: 0, end: 7 }] };

async function call(ctx, body) {
  const res = fakeRes();
  await handleReentryRoute(ctx, fakeReq(body), res, urlFor("/notes-api/reentry"), { readLane: ctx.readLane });
  return JSON.parse(res.out.body || "{}");
}

function makeLiveCtx({ events, locator, snapshot, itemKey = "ik-live" }) {
  const counts = { get: 0, events: 0, readSession: 0, readEvent: 0 };
  const session = {
    get events() {
      counts.events++;
      return events;
    },
  };
  const sessions = {
    async get(sessionId) {
      counts.get++;
      return sessionId === locator.sessionId ? session : undefined;
    },
  };
  const sessionQuery = {
    async readSession() { counts.readSession++; throw new Error("live path must not call readSession"); },
    async readEvent() { counts.readEvent++; throw new Error("live path must not call readEvent"); },
  };
  const readLane = async () => serializeItem(withItemKey(makeItem({
    kind: "source-aware",
    captureOrigin: locator.sessionId,
    snapshot,
    sourcePayload: locator,
  }), itemKey));
  const ctx = makeCtx({
    readLane,
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "sessionQuery") return sessionQuery;
      return undefined;
    },
  });
  return { ctx, counts, noteRef: { holderSessionId: locator.sessionId, laneKey: "conversation_todo", itemKey } };
}

console.log("— Notes behavior regression reentry: same-session exact + context —");
{
  const ctx = makeCtx();
  const r = await call(ctx, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-a" }, expectedSnapshot: "SOURCE-A", consent: "per-request", contextWindow: 1 });
  ok("T1 same-session exact → ok status exact", r.ok === true && r.status === "exact" && r.sameSession === true);
  ok("T1 exact.text == SOURCE-A", r.exact.text === "SOURCE-A");
  ok("T1 perSegment hint messageId a-msg-7", r.exact.perSegment[0].hint.messageId === "a-msg-7");
  ok("T1 context 含 read-time 窗口（seq7 附近 events）", Array.isArray(r.context.perEvent) && r.context.perEvent.length === 1 && r.context.perEvent[0].events.some((e) => e.type === "assistant/message"));
  ok("T1 exact.events 含每 event 权威投影（SOURCE-A）", Array.isArray(r.exact.events) && r.exact.events.some((ev) => ev.eventSeq === 7 && ev.projection === "SOURCE-A"));
  ok("T1 cold/non-attached fallback retains readSession + readEvent", ctx.reads.count === 1 && ctx.reads.event === 1);
  ok("T1 无任何写（L：ctx.fs.withLock 未被调用）", ctx.writes.length === 0);
}

console.log("— Notes behavior regression reentry: J 无 per-request 授权（同/跨都不豁免）+ forged identity —");
{
  const ctx = makeCtx();
  // 跨 session、无 consent → 拒绝且不读
  const r = await call(ctx, { currentSessionId: SID_A, locator: locB });
  ok("J1 跨 session 无 consent → unauthorized PER_REQUEST_AUTHORIZATION_REQUIRED", r.ok === false && r.status === "unauthorized" && r.code === "PER_REQUEST_AUTHORIZATION_REQUIRED");
  ok("J1 reason 声明 nothing was read", /nothing was read/.test(r.reason));
  ok("J1 readSession 未被调用（无 dereference）", ctx.reads.count === 0);
  ok("J1 无写（L）", ctx.writes.length === 0);
  // FORGED：currentSessionId 自报 = 目标（企图伪装 same-session 绕过）→ 仍须 consent
  const rForged = await call(ctx, { currentSessionId: SID_B, locator: locB });
  ok("J2 forged currentSessionId=目标 无 consent → 仍 unauthorized（不能证明 same-session，不信任请求体）", rForged.ok === false && rForged.status === "unauthorized" && rForged.code === "PER_REQUEST_AUTHORIZATION_REQUIRED");
  ok("J2 forged 场景 readSession 未被调用", ctx.reads.count === 0);
  // 同 session、无 consent → 同样拒绝（host 无法证明会话绑定）
  const rSameNo = await call(ctx, { currentSessionId: SID_A, locator: locA });
  ok("J3 同 session 无 consent → 仍 unauthorized（无 request→session 可信 seam）", rSameNo.ok === false && rSameNo.status === "unauthorized");
  ok("J3 readSession 未被调用", ctx.reads.count === 0);
}

console.log("— Notes behavior regression reentry: K 授权 bounded 跨 session read（每请求）—");
{
  const ctx = makeCtx();
  const r = await call(ctx, { currentSessionId: SID_A, locator: locB, noteRef: { holderSessionId: SID_B, laneKey: "conversation_todo", itemKey: "ik-b" }, expectedSnapshot: "OTHER-B", consent: "per-request", contextWindow: 0 });
  ok("K1 consent per-request → exact（bounded 单 locator）", r.ok === true && r.status === "exact" && r.sameSession === false && r.exact.text === "OTHER-B");
  ok("K1 contextWindow 0 → 无 context 事件", r.context.perEvent.length === 0);
  // 无 standing：再次调用不带 consent 仍须授权
  const r2 = await call(ctx, { currentSessionId: SID_A, locator: locB });
  ok("K2 第二次无 consent → 仍 unauthorized（无 standing/global）", r2.ok === false && r2.status === "unauthorized");
}

console.log("— live fast path: public authority + bounded context —");
{
  const raw = [
    { seq: 0, type: "user/message", time: 0, data: { id: "m-0", content: [{ type: "text", text: "A" }], source: { kind: "user" } } },
    { seq: 1, type: "user/message", time: 1, data: { id: "m-1", content: [{ type: "text", text: "B" }], source: { kind: "user" } } },
    { seq: 2, type: "tool/result", time: 2, data: { content: [{ type: "text", text: "C" }] } },
    { seq: 3, type: "user/message", time: 3, data: { id: "m-3", content: [{ type: "text", text: "D" }], source: { kind: "user" } } },
    { seq: 4, type: "user/message", time: 4, data: { id: "m-4", content: [{ type: "text", text: "E" }], source: { kind: "user" } } },
  ];
  const publicEvents = new Proxy(raw, {
    get(target, property, receiver) {
      if (["map", "filter", "slice"].includes(property)) throw new Error(`full-array ${property} forbidden`);
      return Reflect.get(target, property, receiver);
    },
  });
  const multi = { sessionId: SID_A, projectionVersion: 1, segments: [
    { eventSeq: 1, start: 0, end: 1 },
    { eventSeq: 3, start: 0, end: 1 },
  ] };
  const live = makeLiveCtx({ events: publicEvents, locator: multi, snapshot: "BD" });
  const result = await call(live.ctx, { currentSessionId: SID_A, locator: multi, noteRef: live.noteRef, consent: "per-request", contextWindow: 2 });
  ok("L1 attached live multi-segment exact succeeds", result.ok === true && result.status === "exact" && result.exact.text === "BD");
  ok("L1 reads one public live event snapshot", live.counts.get === 1 && live.counts.events === 1);
  ok("L1 attached path readSession=0 and readEvent=0", live.counts.readSession === 0 && live.counts.readEvent === 0);
  ok("L1 nearby target windows preserve authoritative order", JSON.stringify(result.context.perEvent.map((entry) => entry.events.map((event) => event.seq))) === JSON.stringify([[0, 1, 2, 3], [1, 2, 3, 4]]));
  ok("L1 overlapping windows contain no duplicate event within a window", result.context.perEvent.every((entry) => new Set(entry.events.map((event) => event.seq)).size === entry.events.length));

  const noContext = makeLiveCtx({ events: publicEvents, locator: multi, snapshot: "BD" });
  const result0 = await call(noContext.ctx, { currentSessionId: SID_A, locator: multi, noteRef: noContext.noteRef, consent: "per-request", contextWindow: 0 });
  ok("L2 contextWindow 0 retains exact source and emits no context", result0.ok === true && result0.context.perEvent.length === 0 && noContext.counts.readEvent === 0);

  const edge = { sessionId: SID_A, projectionVersion: 1, segments: [
    { eventSeq: 0, start: 0, end: 1 },
    { eventSeq: 4, start: 0, end: 1 },
  ] };
  const edgeLive = makeLiveCtx({ events: publicEvents, locator: edge, snapshot: "AE" });
  const edgeResult = await call(edgeLive.ctx, { currentSessionId: SID_A, locator: edge, noteRef: edgeLive.noteRef, consent: "per-request", contextWindow: 2 });
  ok("L3 beginning/end boundaries clamp without widening", JSON.stringify(edgeResult.context.perEvent.map((entry) => entry.events.map((event) => event.seq))) === JSON.stringify([[0, 1, 2], [2, 3, 4]]));

  const many = Array.from({ length: 25 }, (_, seq) => ({ seq, type: "user/message", time: seq, data: { id: `mx-${seq}`, content: [{ type: "text", text: `E${seq}` }], source: { kind: "user" } } }));
  const maxLocator = { sessionId: SID_A, projectionVersion: 1, segments: [{ eventSeq: 12, start: 0, end: 3 }] };
  const maxLive = makeLiveCtx({ events: many, locator: maxLocator, snapshot: "E12" });
  const maxResult = await call(maxLive.ctx, { currentSessionId: SID_A, locator: maxLocator, noteRef: maxLive.noteRef, consent: "per-request", contextWindow: 999 });
  ok("L4 upper context bound remains 10", maxResult.contextWindow === 10 && maxResult.context.perEvent[0].events.length === 21 && maxResult.context.perEvent[0].startSeq === 2 && maxResult.context.perEvent[0].endSeq === 22);
}

console.log("— live fast path: fail-closed identity and historical S —");
{
  const eventB = { seq: 1, type: "user/message", time: 1, data: { id: "m-1", content: [{ type: "text", text: "B" }], source: { kind: "user" } } };
  const locator = { sessionId: SID_A, projectionVersion: 1, segments: [{ eventSeq: 1, start: 0, end: 1 }] };
  const duplicate = makeLiveCtx({ events: [eventB, { ...eventB }], locator, snapshot: "B" });
  const duplicateResult = await call(duplicate.ctx, { currentSessionId: SID_A, locator, noteRef: duplicate.noteRef, consent: "per-request", contextWindow: 2 });
  ok("L5 duplicate live event identity fails closed", duplicateResult.ok === false && duplicateResult.status === "incompatible" && duplicateResult.code === "LIVE_SOURCE_IDENTITY_AMBIGUOUS");
  ok("L5 ambiguity never falls back to SessionQuery", duplicate.counts.readSession === 0 && duplicate.counts.readEvent === 0);

  const missingLocator = { sessionId: SID_A, projectionVersion: 1, segments: [{ eventSeq: 9, start: 0, end: 1 }] };
  const missing = makeLiveCtx({ events: [eventB], locator: missingLocator, snapshot: "X" });
  const missingResult = await call(missing.ctx, { currentSessionId: SID_A, locator: missingLocator, noteRef: missing.noteRef, consent: "per-request", contextWindow: 2 });
  ok("L6 missing live source fails unavailable without rebind", missingResult.ok === false && missingResult.status === "unavailable" && missingResult.code === "REENTRY_EVENT_UNAVAILABLE" && /no search\/rebind/.test(missingResult.note));
  ok("L6 missing live source never falls back", missing.counts.readSession === 0 && missing.counts.readEvent === 0);

  const mismatch = makeLiveCtx({ events: [eventB], locator, snapshot: "X" });
  const mismatchResult = await call(mismatch.ctx, { currentSessionId: SID_A, locator, noteRef: mismatch.noteRef, consent: "per-request", contextWindow: 0 });
  ok("L7 historical S mismatch keeps broader cue semantics", mismatchResult.ok === false && mismatchResult.status === "incompatible" && mismatchResult.code === "HISTORICAL_S_MISMATCH" && mismatchResult.degradedCue?.exact === false && mismatchResult.currentSourceText === "B" && mismatchResult.historicalSnapshot === "X");

  const gated = makeLiveCtx({ events: [eventB], locator, snapshot: "B" });
  const gatedResult = await call(gated.ctx, { currentSessionId: SID_A, locator, noteRef: gated.noteRef, contextWindow: 2 });
  ok("L8 authorization gate precedes every live source read", gatedResult.status === "unauthorized" && gated.counts.get === 0 && gated.counts.events === 0 && gated.counts.readSession === 0 && gated.counts.readEvent === 0);
}

console.log("— live fast path: durable message identity —");
{
  const identity = { sessionId: SID_A, messageId: "m-moved" };
  const movedEvents = [
    { seq: 101, type: "user/message", time: 1, data: { id: "m-moved", content: [{ type: "text", text: "MOVED" }], source: { kind: "user" } } },
  ];
  const live = makeLiveCtx({ events: movedEvents, locator: identity, snapshot: "MOVED", itemKey: "ik-identity" });
  const result = await call(live.ctx, { currentSessionId: SID_A, locator: identity, noteRef: live.noteRef, consent: "per-request", contextWindow: 0 });
  ok("message identity re-entry survives eventSeq movement", result.ok === true && result.status === "exact" && result.exact.text === "MOVED" && result.exact.segments[0].eventSeq === 101);
  ok("message identity response carries identity and exact whole-message span", result.exact.messageId === "m-moved" && result.exact.segments[0].start === 0 && result.exact.segments[0].end === 5 && result.exact.segments[0].exactSpan === undefined && result.exact.perSegment[0].hint.messageId === "m-moved");
  ok("message identity live path avoids SessionQuery", live.counts.readSession === 0 && live.counts.readEvent === 0);

  const partialIdentity = { sessionId: SID_A, messageId: "m-partial" };
  const partialLive = makeLiveCtx({
    events: [{ seq: 102, type: "user/message", time: 1, data: { id: "m-partial", content: [{ type: "text", text: "prefix target suffix" }], source: { kind: "user" } } }],
    locator: partialIdentity,
    snapshot: "target",
    itemKey: "ik-partial",
  });
  const partialResult = await call(partialLive.ctx, { currentSessionId: SID_A, locator: partialIdentity, noteRef: partialLive.noteRef, consent: "per-request", contextWindow: 0 });
  ok("UI route partial S unique → exact current cue", partialResult.ok === true && partialResult.exact.text === "target" && partialResult.exact.perSegment.length === 1 && partialResult.exact.perSegment[0].exactSpan === undefined && partialResult.exact.perSegment[0].start === 7 && partialResult.exact.perSegment[0].end === 13);

  const duplicateIdentity = { sessionId: SID_A, messageId: "m-duplicate" };
  const duplicateLive = makeLiveCtx({
    events: [{ seq: 103, type: "user/message", time: 1, data: { id: "m-duplicate", content: [{ type: "text", text: "target / target" }], source: { kind: "user" } } }],
    locator: duplicateIdentity,
    snapshot: "target",
    itemKey: "ik-duplicate",
  });
  const duplicateResult = await call(duplicateLive.ctx, { currentSessionId: SID_A, locator: duplicateIdentity, noteRef: duplicateLive.noteRef, consent: "per-request", contextWindow: 0 });
  ok("UI route partial S duplicate → all exact current cues", duplicateResult.ok === true && duplicateResult.exact.perSegment.length === 2 && duplicateResult.exact.perSegment.every((part) => part.exactSpan === undefined) && duplicateResult.exact.perSegment[0].start === 0 && duplicateResult.exact.perSegment[0].end === 6 && duplicateResult.exact.perSegment[1].start === 9 && duplicateResult.exact.perSegment[1].end === 15);

  const unprojectableLive = makeLiveCtx({
    events: [{ seq: 104, type: "user/message", time: 1, data: { id: "m-unprojectable", content: [{ type: "image", url: "opaque" }], source: { kind: "user" } } }],
    locator: { sessionId: SID_A, messageId: "m-unprojectable" },
    snapshot: "target",
    itemKey: "ik-unprojectable",
  });
  const unprojectableResult = await call(unprojectableLive.ctx, { currentSessionId: SID_A, locator: { sessionId: SID_A, messageId: "m-unprojectable" }, noteRef: unprojectableLive.noteRef, consent: "per-request", contextWindow: 0 });
  ok("UI route projection cannot build narrow cue → source success without false mismatch", unprojectableResult.ok === true && unprojectableResult.exact.text === "target" && unprojectableResult.code === undefined);
}

console.log("— Notes behavior regression reentry: incompatible / unavailable truthful —");
{
  const ctx = makeCtx();
  const badProj = { ...locA, projectionVersion: 99 };
  const r1 = await call(ctx, { currentSessionId: SID_A, locator: badProj, consent: "per-request" });
  ok("I-route1 unsupported projection → incompatible INCOMPATIBLE_PROJECTION", r1.ok === false && r1.status === "incompatible" && r1.code === "INCOMPATIBLE_PROJECTION");
  const missing = { ...locA, segments: [{ eventSeq: 999, start: 0, end: 3 }] };
  const missingCtx = makeCtx({ readLane: async () => serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID_A, snapshot: "abc", sourcePayload: missing }), "ik-missing")) });
  const r2 = await call(missingCtx, { currentSessionId: SID_A, locator: missing, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-missing" }, expectedSnapshot: "abc", consent: "per-request" });
  ok("H-route1 event 缺失 → unavailable（no rebind note）", r2.ok === false && r2.status === "unavailable" && r2.code === "REENTRY_EVENT_UNAVAILABLE" && /no search\/rebind/.test(r2.note));
  // sessionQuery 不可用 → fail-closed unavailable
  const ctxNoSq = makeCtx({ sessionQuery: undefined });
  const r3 = await call(ctxNoSq, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-a" }, expectedSnapshot: "SOURCE-A", consent: "per-request" });
  ok("sq-route1 sessionQuery 不可用 → unavailable SESSION_QUERY_UNAVAILABLE", r3.ok === false && r3.status === "unavailable" && r3.code === "SESSION_QUERY_UNAVAILABLE");
  // readSession 失败 → unavailable
  const ctxThrow = makeCtx({});
  ctxThrow.get = (n) => (n === "sessionQuery" ? { async readSession() { throw new Error("boom"); }, readEvent() {} } : undefined);
  const r4 = await call(ctxThrow, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-a" }, expectedSnapshot: "SOURCE-A", consent: "per-request" });
  ok("sq-route2 readSession throw → unavailable SESSION_READ_FAILED", r4.ok === false && r4.status === "unavailable" && r4.code === "SESSION_READ_FAILED");
  const driftReads = { note: 0 };
  const driftCtx = makeCtx({ sessionQuery: {
    async readSession(sid) {
      return { session: { id: sid }, events: [{ seq: 7, type: "user/message", time: 1, data: { id: "a-msg-7", content: [{ type: "text", text: "SOURCE-Y" }], source: { kind: "user" } } }] };
    },
    async readEvent() { return { startSeq: 7, endSeq: 7, events: [] }; },
  }, readLane: async () => { driftReads.note++; return serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID_A, snapshot: "SOURCE-X", sourcePayload: locA }), "ik-a")); } });
  const drift = await call(driftCtx, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-a" }, expectedSnapshot: "SOURCE-Y", consent: "per-request", contextWindow: 0 });
  ok("S-binding route ignores caller Y and compares durable X to current Y", drift.ok === false && drift.status === "incompatible" && drift.code === "HISTORICAL_S_MISMATCH" && drift.currentSourceText === "SOURCE-Y" && drift.historicalSnapshot === "SOURCE-X" && driftReads.note === 1);
  ok("row9 mismatch keeps source identity and supplies only grounded non-exact cue inputs", drift.sameSession === true && drift.degradedCue?.kind === "whole-message" && drift.degradedCue?.exact === false && drift.degradedCue?.sessionId === SID_A && drift.degradedCue?.perSegment?.[0]?.text === "SOURCE-Y" && drift.degradedCue?.events?.some((ev) => ev.eventSeq === 7 && ev.projection === "SOURCE-Y") && drift.exact === undefined);
  const omitted = await call(ctx, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-a" }, consent: "per-request", contextWindow: 0 });
  ok("S-binding route omitted caller snapshot still uses durable S and succeeds when current X", omitted.ok === true && omitted.status === "exact" && omitted.exact.text === "SOURCE-A");
  const missingRef = await call(ctx, { currentSessionId: SID_A, locator: locA, consent: "per-request", contextWindow: 0 });
  ok("S-binding missing durable Note identity → NOTE_IDENTITY_REQUIRED", missingRef.ok === false && missingRef.status === "incompatible" && missingRef.code === "NOTE_IDENTITY_REQUIRED");
  const missingNote = await call(ctx, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "does-not-exist" }, consent: "per-request", contextWindow: 0 });
  ok("S-binding missing durable item → NOTE_NOT_FOUND", missingNote.ok === false && missingNote.status === "incompatible" && missingNote.code === "NOTE_NOT_FOUND");
  const identityCtx = makeCtx({ readLane: async () => serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID_B, snapshot: "OTHER-B", sourcePayload: locB }), "ik-a")) });
  const identityMismatch = await call(identityCtx, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-a" }, consent: "per-request", contextWindow: 0 });
  ok("S-binding durable item identity != requested anchor → NOTE_IDENTITY_MISMATCH", identityMismatch.ok === false && identityMismatch.status === "incompatible" && identityMismatch.code === "NOTE_IDENTITY_MISMATCH");
  const noSnapshotCtx = makeCtx({ readLane: async () => serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID_A, snapshot: "", sourcePayload: locA }), "ik-a")) });
  const noSnapshot = await call(noSnapshotCtx, { currentSessionId: SID_A, locator: locA, noteRef: { holderSessionId: SID_A, laneKey: "conversation_todo", itemKey: "ik-a" }, consent: "per-request", contextWindow: 0 });
  ok("S-binding durable anchored item without S → NOTE_HISTORICAL_S_MISSING", noSnapshot.ok === false && noSnapshot.status === "incompatible" && noSnapshot.code === "NOTE_HISTORICAL_S_MISSING");
}

console.log("— Notes behavior regression reentry: 路径/方法 —");
{
  const ctx = makeCtx();
  const res = fakeRes();
  const handled = await handleReentryRoute(ctx, fakeReq({}, "GET"), res, urlFor("/notes-api/reentry"));
  ok("P1 GET /notes-api/reentry → 405 + claimed", handled === true && res.out.status === 405);
  const res2 = fakeRes();
  const handled2 = await handleReentryRoute(ctx, fakeReq({}, "POST"), res2, urlFor("/notes-api/other"));
  ok("P2 其它路径 → false（未 claim）", handled2 === false);
  const r = await call(ctx, { currentSessionId: "bad!", locator: locA });
  ok("Source behavior regression 非法 currentSessionId → bad-request", r.ok === false && r.code === "INVALID_CURRENT_SESSION");
}

console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
