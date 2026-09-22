// dsh-collab-notes — host re-entry route（/notes-api/reentry）
//
// read-only exact source re-entry for persisted source-aware items。
// body: { currentSessionId, locator, noteRef, expectedSnapshot?, consent, contextWindow? }
//   locator = item.sourcePayload（client 从 persisted lane 解析的 Source Anchor；
//   noteRef = { holderSessionId, laneKey, itemKey? }（指向当前 holder lane 中的
//   durable Note；itemKey 缺失时仅允许唯一 locator 匹配的旧 Note）；
//   expectedSnapshot = client transport only（从不作为 historical-S authority）；
//   其携带的 sessionId 即历史 source session）。
//   currentSessionId = 面板/调用上下文的当前 session（**信息性**：仅用于响应
//   sameSession 标签与日志；host 无 request→session 可信 seam，不能据此证明
//   请求确属该会话——见下 authority）。
//   consent: 必须 === "per-request"（每请求显式用户授权标记；UI 的 ↪ 点击 / 跨
//   会话确认即该次显式动作；每请求显式授权 + bounded target = 本
//   locator；不建 standing/global 授权）。
//
// authority 边界（不建新 Notes ACL/permission 子系统）：notes adapter 没有把 request 绑定到当前
// browser conversation/session 的可信 seam——因此 **同 session 与跨 session 的
// dereference 一律要求 consent:"per-request"**（无法证明 same-session 的请求按
// cross-session 语义处理；伪造 currentSessionId 不能豁免）。sameSession 仅是请求
// 体推导出的信息性标签，不是授权证明。
// read/re-entry 不授予 mutation/closure/deletion/execution/formalization/
// responsibility takeover；本 route 无任何写路径（L）。
//
// 状态（truthful 区分，按已建立的 Source authority 与当前请求范围处理）：
//   ok:true, status:"exact"          —— 可读可重建（+ render hints + bounded context）
//   ok:false status:"unavailable"    —— sessionQuery 不可用 / readSession 失败 /
//                                      event 缺失（保留 provenance；不 search/rebind）
//   ok:false status:"incompatible"   —— durable Note identity / locator / projection
//                                      basis 不可解释或 extent 越界（不用当前
//                                      projection 重解旧 offsets）
//   ok:false status:"unauthorized"   —— 跨 session 无 per-request consent
import {
  validateLocatorShape,
  resolveExactLocus,
  snapshotFromEvents,
  eventProjections,
} from "./source-reentry.js";
import { resolveItemByKey } from "./reference-binding.js";
import { KIND_SOURCE_AWARE, getItemKey, parseLaneBody } from "./structured-item.js";
import { liveSessionEvents } from "./live-session-events.js";
import { isValidMessageIdentity } from "./source-locator.js";

const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const MAX_CONTEXT_WINDOW = 10;
const DEFAULT_CONTEXT_WINDOW = 2;
const MAX_EVENT_TEXT = 2000;
const LAYER_KEYS = new Set(["conversation_todo", "deferred_work", "knowledge_candidate", "lesson_candidate"]);

function canonicalData(value) {
  if (Array.isArray(value)) return value.map(canonicalData);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalData(value[key])]));
  }
  return value;
}

function sameLocator(a, b) {
  return JSON.stringify(canonicalData(a)) === JSON.stringify(canonicalData(b));
}

/**
 * Read the persisted source-aware Note through the existing Notes lane reader.
 * The request's expectedSnapshot is deliberately not consulted here: the
 * durable lane item is the only historical-S authority.
 */
async function readDurableHistoricalSnapshot(options, noteRef, locator) {
  if (!options || typeof options.readLane !== "function") {
    return { ok: false, status: "unavailable", code: "NOTE_READER_UNAVAILABLE", reason: "host durable Notes reader unavailable; refusing historical exact re-entry" };
  }
  if (!noteRef || typeof noteRef !== "object" || Array.isArray(noteRef)) {
    return { ok: false, status: "incompatible", code: "NOTE_IDENTITY_REQUIRED", reason: "durable Note identity required (holderSessionId + laneKey; itemKey when available)" };
  }
  const holderSessionId = noteRef.holderSessionId;
  const laneKey = noteRef.laneKey;
  const requestedItemKey = noteRef.itemKey;
  if (typeof holderSessionId !== "string" || !SESSION_ID_RE.test(holderSessionId) || typeof laneKey !== "string" || !LAYER_KEYS.has(laneKey)) {
    return { ok: false, status: "incompatible", code: "NOTE_IDENTITY_INVALID", reason: "durable Note identity has invalid holderSessionId or laneKey" };
  }
  if (requestedItemKey !== undefined && (typeof requestedItemKey !== "string" || requestedItemKey.length === 0)) {
    return { ok: false, status: "incompatible", code: "NOTE_IDENTITY_INVALID", reason: "durable Note itemKey must be a non-empty string when supplied" };
  }
  let laneBody;
  try {
    laneBody = await options.readLane(holderSessionId, laneKey);
  } catch (error) {
    return { ok: false, status: "unavailable", code: "NOTE_READ_FAILED", reason: `durable Note read failed: ${error?.message ?? error}` };
  }
  const parsed = parseLaneBody(String(laneBody ?? ""));
  let item;
  if (requestedItemKey !== undefined) {
    const found = resolveItemByKey(laneBody, requestedItemKey);
    if (!found.ok) {
      return { ok: false, status: "incompatible", code: found.code === "AMBIGUOUS" ? "NOTE_IDENTITY_AMBIGUOUS" : "NOTE_NOT_FOUND", reason: found.reason };
    }
    item = found.item;
  } else {
    // Legacy source-aware items without an item key remain readable only by
    // unique exact locator identity; duplicate candidates fail closed.
    const matches = parsed.nodes.filter((node) => node.type === "item" && node.item?.kind === KIND_SOURCE_AWARE && sameLocator(node.item.sourcePayload, locator));
    if (matches.length === 0) return { ok: false, status: "incompatible", code: "NOTE_NOT_FOUND", reason: "no durable source-aware Note matches the requested locator" };
    if (matches.length > 1) return { ok: false, status: "incompatible", code: "NOTE_IDENTITY_AMBIGUOUS", reason: "multiple durable source-aware Notes match the requested locator; refusing first-match re-entry" };
    item = matches[0].item;
  }
  if (!item || item.kind !== KIND_SOURCE_AWARE) {
    return { ok: false, status: "incompatible", code: "NOTE_NOT_ANCHORED", reason: "durable Note identity does not resolve to a source-aware Note" };
  }
  if (!sameLocator(item.sourcePayload, locator)) {
    return { ok: false, status: "incompatible", code: "NOTE_IDENTITY_MISMATCH", reason: "durable Note identity resolves to a different Source Anchor; refusing re-entry" };
  }
  if (typeof item.snapshot !== "string" || item.snapshot === "") {
    return { ok: false, status: "incompatible", code: "NOTE_HISTORICAL_S_MISSING", reason: "durable source-aware Note has no persisted historical selected snapshot S" };
  }
  return { ok: true, snapshot: item.snapshot, itemKey: getItemKey(item) };
}

/**
 * Read the exact source-aware Note selected by the trusted current holder.
 * Unlike the browser route, Agent re-entry receives no caller-supplied
 * locator or consent marker: the current holder's lane and exact itemKey are
 * the only durable identity inputs.  The returned locator is still validated
 * before any authoritative source dereference.
 */
async function readDurableCurrentNote(options, currentSessionId, lane, itemKey) {
  if (!options || typeof options.readLane !== "function") {
    return { ok: false, status: "unavailable", code: "NOTE_READER_UNAVAILABLE", reason: "host durable Notes reader unavailable; refusing historical exact re-entry" };
  }
  let laneBody;
  try {
    laneBody = await options.readLane(currentSessionId, lane);
  } catch {
    return { ok: false, status: "unavailable", code: "NOTE_READ_FAILED", reason: "durable Note read failed; refusing historical exact re-entry" };
  }
  const found = resolveItemByKey(String(laneBody ?? ""), itemKey);
  if (!found.ok) {
    return {
      ok: false,
      status: "incompatible",
      code: found.code === "AMBIGUOUS" ? "NOTE_IDENTITY_AMBIGUOUS" : "NOTE_NOT_FOUND",
      reason: "current-holder Note itemKey could not be resolved; refusing re-entry",
    };
  }
  const item = found.item;
  if (!item || item.kind !== KIND_SOURCE_AWARE) {
    return { ok: false, status: "incompatible", code: "NOTE_NOT_ANCHORED", reason: "current-holder Note is not source-aware; refusing re-entry" };
  }
  if (typeof item.snapshot !== "string" || item.snapshot === "") {
    return { ok: false, status: "incompatible", code: "NOTE_HISTORICAL_S_MISSING", reason: "current-holder source-aware Note has no persisted historical selected snapshot S" };
  }
  const shape = validateLocatorShape(item.sourcePayload);
  if (!shape.ok) return { ok: false, status: "incompatible", code: shape.code, reason: shape.reason };
  return { ok: true, itemKey: getItemKey(item), snapshot: item.snapshot, locator: shape.locator };
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume?.();
      return { tooLarge: true };
    }
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks).toString("utf8") };
}

/** 提取 event 的可见文本块（compact，供 task-appropriate context）。 */
function eventTextOf(e) {
  const d = e?.data;
  const content = Array.isArray(d?.message?.content) ? d.message.content : Array.isArray(d?.content) ? d.content : null;
  if (!content) return "";
  const t = content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("");
  return t.length > MAX_EVENT_TEXT ? t.slice(0, MAX_EVENT_TEXT) : t;
}

function compactEvent(e) {
  return {
    seq: e?.seq,
    type: e?.type,
    time: e?.time,
    text: eventTextOf(e),
  };
}

function roleOfEvent(e) {
  const type = typeof e?.type === "string" ? e.type : "";
  if (type.startsWith("user/")) return "user";
  if (type.startsWith("assistant/")) return "assistant";
  if (type.startsWith("tool/")) return "tool";
  return "event";
}

function boundedContext(events) {
  return (Array.isArray(events) ? events : []).map((entry) => {
    const event = entry?.event && typeof entry.event === "object" ? entry.event : entry;
    return { role: roleOfEvent(event), text: eventTextOf(event) };
  });
}

/**
 * Acquire only the authoritative live source events and bounded raw neighbors
 * needed by one re-entry request.  The live event snapshot is scanned once in place;
 * no full-session clone/projection is built.  Retained events are references
 * from the public frozen snapshot and live only for this request.
 */
async function liveReentryMaterial(ctx, sessionId, targetSeqs, contextWindow, trustedSession, targetMessageIds = []) {
  let sessions;
  try {
    if (typeof ctx?.get === "function") sessions = ctx.get("sessions");
    else sessions = ctx?.sessions;
  } catch {
    sessions = undefined;
  }
  if (!sessions || typeof sessions.get !== "function") return { attached: false };

  let session = trustedSession;
  if (session === undefined) {
    try {
      session = await sessions.get(sessionId);
    } catch (error) {
      return { attached: true, error: agentFailure("unavailable", "LIVE_SESSION_ACCESS_FAILED", `live session access failed: ${error?.message ?? error}`) };
    }
  }
  if (!session) return { attached: false };

  let events;
  try {
    // Read the public getter exactly once.  The runtime invalidates its frozen
    // snapshot on append, so each request observes the current live log.
    events = liveSessionEvents(session);
  } catch (error) {
    return { attached: true, error: agentFailure("unavailable", "LIVE_SESSION_EVENTS_FAILED", `live session events access failed: ${error?.message ?? error}`) };
  }
  if (!Array.isArray(events)) {
    return { attached: true, error: agentFailure("unavailable", "LIVE_SESSION_EVENTS_INVALID", "live session returned no public events array") };
  }

  const requestedSeqs = [];
  const requested = new Set();
  for (const seq of targetSeqs ?? []) {
    if (!Number.isSafeInteger(seq) || requested.has(seq)) continue;
    requested.add(seq);
    requestedSeqs.push(seq);
  }
  const requestedMessageIds = new Set((targetMessageIds || []).filter((id) => typeof id === "string" && id.length > 0));

  const targetsInAuthorityOrder = [];
  const targetMatches = new Map();
  const retainedByIndex = new Map();
  const windows = new Map();
  const activeWindows = [];
  const preceding = [];
  let index = 0;

  // Do not spread/map/filter/slice the public events array.  The ring and each
  // active window are bounded by MAX_CONTEXT_WINDOW; overlapping windows share
  // one retainedByIndex entry rather than retaining duplicate event objects.
  for (const item of events) {
    const event = item?.event && typeof item.event === "object" ? item.event : item;
    if (!event || !Number.isSafeInteger(event.seq)) {
      index += 1;
      continue;
    }

    for (let i = activeWindows.length - 1; i >= 0; i -= 1) {
      const window = activeWindows[i];
      if (window.remaining <= 0) {
        activeWindows.splice(i, 1);
        continue;
      }
      retainedByIndex.set(index, event);
      window.indices.push(index);
      window.remaining -= 1;
      if (window.remaining === 0) activeWindows.splice(i, 1);
    }

    const eventMessageId = event.type === "user/message"
      ? event.data?.id
      : event.type === "assistant/message"
        ? event.data?.message?.id
        : undefined;
    const requestedByMessageId = typeof eventMessageId === "string" && requestedMessageIds.has(eventMessageId);
    if (requested.has(event.seq) || requestedByMessageId) {
      const targetKey = requestedByMessageId ? `message:${eventMessageId}` : `seq:${event.seq}`;
      const count = (targetMatches.get(targetKey) ?? 0) + 1;
      targetMatches.set(targetKey, count);
      if (count > 1) {
        return {
          attached: true,
          error: agentFailure("incompatible", "LIVE_SOURCE_IDENTITY_AMBIGUOUS", `live source identity ${eventMessageId || event.seq} is ambiguous; refusing to choose an event`),
        };
      }
      targetsInAuthorityOrder.push(event);
      retainedByIndex.set(index, event);
      if (contextWindow > 0) {
        const indices = preceding.map((entry) => entry.index);
        for (const entry of preceding) retainedByIndex.set(entry.index, entry.event);
        indices.push(index);
        const window = { seq: event.seq, indices, remaining: contextWindow };
        windows.set(event.seq, window);
        activeWindows.push(window);
      }
    }

    if (contextWindow > 0) {
      preceding.push({ index, event });
      if (preceding.length > contextWindow) preceding.shift();
    }
    index += 1;
  }

  const contextBySeq = new Map();
  for (const seq of requestedSeqs) {
    const window = windows.get(seq);
    if (!window) continue;
    const windowEvents = window.indices.map((eventIndex) => retainedByIndex.get(eventIndex)).filter(Boolean);
    contextBySeq.set(seq, {
      startSeq: windowEvents[0]?.seq,
      endSeq: windowEvents.at(-1)?.seq,
      events: windowEvents,
    });
  }
  return {
    attached: true,
    snapshotNodes: snapshotFromEvents(targetsInAuthorityOrder),
    contextBySeq,
  };
}

function agentFailure(status, code, reason) {
  return { ok: false, status, code, reason };
}

function sessionsFromContext(ctx) {
  try {
    return typeof ctx?.get === "function" ? ctx.get("sessions") : ctx?.sessions;
  } catch {
    return undefined;
  }
}

function sessionQueryFromContext(ctx) {
  try {
    return typeof ctx?.get === "function" ? ctx.get("sessionQuery") : ctx?.sessionQuery;
  } catch {
    return undefined;
  }
}

async function trustedTargetSession(ctx, sessionId) {
  const sessions = sessionsFromContext(ctx);
  if (sessions && typeof sessions.get === "function") {
    try {
      const live = await sessions.get(sessionId);
      if (live !== undefined && live !== null) return { state: "attached", session: live, header: live.header };
    } catch {
      return { state: "unavailable" };
    }
  }

  const sq = sessionQueryFromContext(ctx);
  if (!sq || typeof sq.listSessions !== "function") return { state: "unavailable" };
  try {
    const records = await sq.listSessions();
    const record = (Array.isArray(records) ? records : []).find((entry) => entry?.header?.id === sessionId);
    return record ? { state: "cold", header: record.header } : { state: "missing" };
  } catch {
    return { state: "unavailable" };
  }
}

async function workspaceIdForHeader(ctx, header) {
  const cwd = header?.cwd;
  const registry = ctx?.workspaceRegistry ?? (typeof ctx?.get === "function" ? ctx.get("workspaceRegistry") : undefined);
  if (typeof cwd !== "string" || cwd.length === 0 || !registry || typeof registry.resolveByPath !== "function") return undefined;
  try {
    const workspace = await registry.resolveByPath(cwd);
    return typeof workspace?.id === "string" && workspace.id.length > 0 ? workspace.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Authorize a cross-conversation dereference from trusted host state only.
 * Session metadata is read before content: attached headers come from the
 * live Session object, while cold headers come from sessionQuery.listSessions
 * (the DSH metadata-only corpus observation).  The caller workspace id is
 * resolved by the workspace binding runtime from the trusted current session and is never model
 * input.  A foreign or unresolvable target fails with the existing generic
 * historical-read failure surface before events/readSession are touched.
 */
async function authorizeTargetWorkspace(ctx, sourceSessionId, currentSessionId, currentWorkspaceId) {
  if (sourceSessionId === currentSessionId) return { ok: true, state: "same-session" };
  if (typeof currentWorkspaceId !== "string" || currentWorkspaceId.length === 0) {
    return agentFailure("unavailable", "SESSION_READ_FAILED", "authoritative historical Source is unavailable");
  }
  const target = await trustedTargetSession(ctx, sourceSessionId);
  if (target.state === "unavailable" || target.state === "missing") {
    return agentFailure("unavailable", "SESSION_READ_FAILED", "authoritative historical Source is unavailable");
  }
  const targetWorkspaceId = await workspaceIdForHeader(ctx, target.header);
  if (targetWorkspaceId !== currentWorkspaceId) {
    return agentFailure("unavailable", "SESSION_READ_FAILED", "authoritative historical Source is unavailable");
  }
  return { ok: true, state: target.state, session: target.session };
}

/**
 * Agent-facing Source re-entry.  This is deliberately browser-free and
 * read-only.  The current-holder Note supplies the persisted Source Anchor;
 * the Host may dereference that exact Source in the current or another
 * readable conversation.  The operation never accepts or returns physical
 * paths, raw locators, session/event IDs, or the HTTP route's consent marker.
 */
export async function executeSourceReentry(ctx, options, input) {
  const currentSessionId = input?.currentSessionId;
  const lane = input?.lane;
  const itemKey = input?.itemKey;
  const windowN = Number.isSafeInteger(input?.contextWindow) && input.contextWindow >= 0
    ? Math.min(input.contextWindow, MAX_CONTEXT_WINDOW)
    : DEFAULT_CONTEXT_WINDOW;
  const durable = await readDurableCurrentNote(options, currentSessionId, lane, itemKey);
  if (!durable.ok) return durable;

  const sourceSessionId = durable.locator.sessionId;
  const targetSeqs = isValidMessageIdentity(durable.locator) ? [] : [...new Set(durable.locator.segments.map((segment) => segment.eventSeq))];
  const targetMessageIds = isValidMessageIdentity(durable.locator) ? [durable.locator.messageId] : [];
  const authorization = await authorizeTargetWorkspace(ctx, sourceSessionId, currentSessionId, options?.currentWorkspaceId);
  if (!authorization.ok) return authorization;
  const live = await liveReentryMaterial(ctx, sourceSessionId, targetSeqs, windowN, authorization.session, targetMessageIds);
  if (live.attached && live.error) return live.error;

  let sq;
  let nodes;
  if (live.attached) {
    nodes = live.snapshotNodes;
  } else {
    sq = sessionQueryFromContext(ctx);
    if (!sq || typeof sq.readSession !== "function") {
      return agentFailure("unavailable", "SESSION_QUERY_UNAVAILABLE", "authoritative historical Source is unavailable");
    }
    let read;
    try {
      read = await sq.readSession(sourceSessionId);
    } catch {
      return agentFailure("unavailable", "SESSION_READ_FAILED", "authoritative historical Source read failed");
    }
    const events = read?.events;
    if (!Array.isArray(events)) return agentFailure("unavailable", "SESSION_READ_INVALID", "authoritative historical Source returned no readable events");
    nodes = snapshotFromEvents(events);
  }
  const resolved = resolveExactLocus(durable.locator, nodes, sourceSessionId, durable.snapshot);
  if (!resolved.ok) {
    if (resolved.code === "REENTRY_EVENT_UNAVAILABLE") return agentFailure("unavailable", resolved.code, "the anchored source event is not available in the authoritative historical Source");
    return agentFailure("incompatible", resolved.code, resolved.reason);
  }

  const sourceEvents = eventProjections(nodes, [...new Set(resolved.perSegment.map((part) => part.eventSeq))]);
  const sourceMessage = resolved.sourceMessage || sourceEvents.map((entry) => entry.projection).join("\n");
  const surroundingContext = [];
  if (windowN > 0 && live.attached) {
    for (const seq of [...new Set(resolved.perSegment.map((part) => part.eventSeq))]) {
      surroundingContext.push(...boundedContext(live.contextBySeq.get(seq)?.events ?? []));
    }
  } else if (windowN > 0 && typeof sq?.readEvent === "function") {
    for (const seq of [...new Set(resolved.perSegment.map((part) => part.eventSeq))]) {
      try {
        const window = await sq.readEvent({ sessionId: sourceSessionId, seq, before: windowN, after: windowN });
        const entries = Array.isArray(window?.events) ? window.events : [];
        surroundingContext.push(...boundedContext(entries));
      } catch {
        // Exact source success is independent of optional bounded context.
      }
    }
  }
  return {
    ok: true,
    status: "exact",
    selectedText: resolved.text,
    sourceMessage,
    surroundingContext,
    contextWindow: windowN,
  };
}

function send(res, obj) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

/**
 * @returns true if the path was claimed (response written), false to fall through.
 */
export async function handleReentryRoute(ctx, req, res, url, options = {}) {
  if (url.pathname !== "/notes-api/reentry") return false;
  if (req.method !== "POST") {
    req.resume?.();
    res.writeHead(405, { "content-type": "text/plain" });
    res.end();
    return true;
  }
  const rb = await readBody(req);
  if (rb.tooLarge) {
    res.writeHead(413, { "content-type": "text/plain" });
    res.end("payload too large");
    return true;
  }
  let payload;
  try { payload = JSON.parse(rb.body || "{}"); } catch {
    send(res, { ok: false, status: "bad-request", code: "BAD_JSON", reason: "invalid JSON body" });
    return true;
  }
  const currentSessionId = typeof payload.currentSessionId === "string" ? payload.currentSessionId : "";
  const locator = payload.locator;
  if (typeof currentSessionId !== "string" || !SESSION_ID_RE.test(currentSessionId)) {
    send(res, { ok: false, status: "bad-request", code: "INVALID_CURRENT_SESSION", reason: "currentSessionId required" });
    return true;
  }
  const shape = validateLocatorShape(locator);
  if (!shape.ok) {
    // incompatible：truthful compatibility failure；不重解；provenance 保留（无写）。
    send(res, { ok: false, status: "incompatible", code: shape.code, reason: shape.reason });
    return true;
  }
  const target = locator.sessionId;
  const windowN = Number.isSafeInteger(payload.contextWindow) && payload.contextWindow >= 0 ? Math.min(payload.contextWindow, MAX_CONTEXT_WINDOW) : DEFAULT_CONTEXT_WINDOW;

  // authority: do not trust a request body's self-reported currentSessionId:
  // The Notes adapter does not bind a request to the current browser conversation/
  // session 的可信 seam——因此 host **无法证明**请求确属 currentSessionId 所指会话。
  // 不能证明为 same-session 的请求一律按 cross-session 语义处理：**每次 dereference
  // 都必须携带显式 per-request 用户授权标记**（consent:"per-request"；UI 的 ↪ 点击
  // / 跨会话确认即该次显式授权动作）。伪造 currentSessionId = 目标不会绕过该检查。
  // currentSessionId 仅作信息性（响应 sameSession 标签 / 日志），不用于豁免授权。
  const sameSession = currentSessionId === target;
  if (payload.consent !== "per-request") {
    send(res, {
      ok: false,
      status: "unauthorized",
      code: "PER_REQUEST_AUTHORIZATION_REQUIRED",
      reason: "re-entry dereference requires explicit per-request user authorization (consent: \"per-request\"); the host cannot verify the request's session identity, so same- and cross-session dereferences alike require this marker; nothing was read",
    });
    return true;
  }
  ctx.logger?.info?.("[dsh-collab-notes] reentry per-request authorized", { claimedCurrent: currentSessionId, target, sameSession });

  const durable = await readDurableHistoricalSnapshot(options, payload.noteRef, locator);
  if (!durable.ok) {
    send(res, { ok: false, status: durable.status, code: durable.code, reason: durable.reason });
    return true;
  }

  // authoritative source read（read-only）: attached live sessions use the
  // public frozen events snapshot; only cold sessions use sessionQuery.
  const targetSeqs = isValidMessageIdentity(locator) ? [] : [...new Set(locator.segments.map((segment) => segment.eventSeq))];
  const targetMessageIds = isValidMessageIdentity(locator) ? [locator.messageId] : [];
  const live = await liveReentryMaterial(ctx, target, targetSeqs, windowN, undefined, targetMessageIds);
  if (live.attached && live.error) {
    send(res, live.error);
    return true;
  }

  let sq;
  let nodes;
  if (live.attached) {
    nodes = live.snapshotNodes;
  } else {
    sq = ctx.get("sessionQuery");
    if (!sq || typeof sq.readSession !== "function") {
      send(res, { ok: false, status: "unavailable", code: "SESSION_QUERY_UNAVAILABLE", reason: "host sessionQuery unavailable — cannot perform authoritative source read (fail-closed)" });
      return true;
    }
    let read;
    try {
      read = await sq.readSession(target);
    } catch (e) {
      send(res, { ok: false, status: "unavailable", code: "SESSION_READ_FAILED", reason: `authoritative session read failed: ${e?.message ?? e}` });
      return true;
    }
    const events = read?.events;
    if (!Array.isArray(events)) {
      send(res, { ok: false, status: "unavailable", code: "SESSION_READ_INVALID", reason: "authoritative session read returned no events array" });
      return true;
    }
    nodes = snapshotFromEvents(events);
  }
  const resolved = resolveExactLocus(locator, nodes, target, durable.snapshot);
  if (!resolved.ok) {
    if (resolved.code === "HISTORICAL_S_MISMATCH" && Array.isArray(resolved.perSegment) && resolved.perSegment.length > 0) {
      // The source identity/locus is still authoritative and readable, but
      // current projection text differs from historical S.  Expose only the
      // existing UI degraded-cue inputs; do not return an `exact` object, do
      // not search/rebind, and do not alter durable provenance.
      const eventSeqs = [...new Set(resolved.perSegment.map((part) => part.eventSeq))];
      const eventsProjection = eventProjections(nodes, eventSeqs);
      send(res, {
        ok: false,
        status: "incompatible",
        code: resolved.code,
        reason: resolved.reason,
        sameSession,
        historicalSnapshot: resolved.historicalSnapshot,
        currentSourceText: resolved.currentSourceText,
        degradedCue: {
          kind: "whole-message",
          exact: false,
          sessionId: target,
          ...(locator.projectionVersion === undefined ? {} : { projectionVersion: locator.projectionVersion }),
          perSegment: resolved.perSegment,
          events: eventsProjection,
          sourceMessage: eventsProjection.map((entry) => entry.projection).join("\n"),
        },
      });
      return true;
    }
    if (resolved.code === "REENTRY_EVENT_UNAVAILABLE") {
      send(res, { ok: false, status: "unavailable", code: resolved.code, reason: resolved.reason, note: "historical provenance retained; persisted snapshot remains visible as capture-time evidence; no search/rebind performed" });
    } else {
      send(res, { ok: false, status: "incompatible", code: resolved.code, reason: resolved.reason, historicalSnapshot: resolved.historicalSnapshot, currentSourceText: resolved.currentSourceText });
    }
    return true;
  }

  // exact + read-time bounded surrounding context（不预存 context packet）
  const perEvent = [];
  if (windowN > 0 && live.attached) {
    const distinct = [...new Set(resolved.perSegment.map((p) => p.eventSeq))];
    for (const seq of distinct) {
      const window = live.contextBySeq.get(seq);
      if (!window) continue;
      perEvent.push({
        seq,
        window: windowN,
        startSeq: window.startSeq,
        endSeq: window.endSeq,
        events: window.events.map(compactEvent),
      });
    }
  } else if (windowN > 0 && typeof sq?.readEvent === "function") {
    const distinct = [...new Set(resolved.perSegment.map((p) => p.eventSeq))];
    for (const seq of distinct) {
      try {
        const w = await sq.readEvent({ sessionId: target, seq, before: windowN, after: windowN });
      const list = Array.isArray(w?.events) ? w.events.map(compactEvent) : [];
        perEvent.push({ seq, window: windowN, startSeq: w?.startSeq, endSeq: w?.endSeq, events: list });
      } catch (e) {
        perEvent.push({ seq, window: windowN, error: String(e?.message ?? e).slice(0, 160) });
      }
    }
  }

  send(res, {
    ok: true,
    status: "exact",
    sameSession,
    contextWindow: windowN,
    exact: {
      sessionId: target,
      ...(locator.projectionVersion === undefined ? {} : { projectionVersion: locator.projectionVersion }),
      ...(isValidMessageIdentity(locator) ? { messageId: locator.messageId } : {}),
      segments: resolved.perSegment.map((p) => ({ eventSeq: p.eventSeq, start: p.start, end: p.end, ...(p.exactSpan === false ? { exactSpan: false } : {}) })),
      text: resolved.text,
      sourceMessage: resolved.sourceMessage,
      perSegment: resolved.perSegment,
      // 每 event 权威投影文本：client 按位置（code-point 累积）做确定性 DOM 映射，
      // 不用 seg.text 在 DOM 中 search/first-match。
      events: eventProjections(nodes, [...new Set(resolved.perSegment.map((p) => p.eventSeq))], locator.projectionVersion),
    },
    context: { perEvent },
  });
  return true;
}
