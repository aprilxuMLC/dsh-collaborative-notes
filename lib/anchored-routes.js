// dsh-collab-notes — host anchored routes（validate + prepare）
//
// browser-free host 侧端点（挂载于 /notes-api/anchored/*）：
//   POST /notes-api/anchored/validate
//     body: { candidate }   （client bounded capture evidence）
//     → attached live session: one bounded scan of a fresh public event snapshot;
//       cold session: existing ctx.sessionQuery.readSession(sessionId) fallback
//     → buildSnapshotFromEvents → reconstruct proposal → validateAnchoredProposal
//     → 200 { ok: true, validated } | 200 { ok: false, reason, code }
//   POST /notes-api/anchored/prepare
//     body: { candidate, lane, comment }
//     → 同上 validate + buildAnchoredItem + serializeItem
//     → 200 { ok: true, block }（block = 单个 source-aware item 的完整
//       block 文本；client 追加到其当前已加载的 lane body 后走既有 whole-lane
//       PUT If-Match——与既有 Notes 编辑保存同一条持久化路径）
//     → 200 { ok: false, reason, code }
//
// sessionQuery 不可用 / readSession 失败 → fail-closed truthful error
// （不伪造 host-authoritative 校验，不降级）。不新增 durable state / API /
// signature / proof object。

import { buildSnapshotFromEvents, validateAnchoredProposal, buildAnchoredItem } from "./anchored-capture.js";
import { nodeKeyIdentity, proposalFromCaptureEvidence } from "./selection-bridge.js";
import { serializeItem } from "./structured-item.js";
import { liveSessionEvents } from "./live-session-events.js";

const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const LAYER_KEYS = new Set(["conversation_todo", "deferred_work", "knowledge_candidate", "lesson_candidate"]);

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

/**
 * Read the smallest authoritative live event set needed by one capture.
 *
 * This is intentionally a single in-place scan over the public live event
 * snapshot.  It retains only renderer-identified source events (or legacy
 * proposal eventSeq targets) and then reuses the existing snapshot builder and
 * validator.  No browser extent/text is treated as authority here.
 */
async function liveCandidateSnapshot(ctx, sessionId, candidate, captureEvidence) {
  // DSH runtime contexts expose injected services through ctx.get().  The
  // direct property is supported by the focused test contexts, but the real
  // runtime throws when an un-injected property is inspected, so prefer the
  // accessor whenever it exists.
  let sessions;
  try {
    if (typeof ctx.get === "function") sessions = ctx.get("sessions");
    else sessions = ctx.sessions;
  } catch {
    sessions = undefined;
  }
  if (!sessions || typeof sessions.get !== "function") return { attached: false };

  let session;
  try {
    session = await sessions.get(sessionId);
  } catch (e) {
    return { attached: true, error: { ok: false, reason: `live session access failed: ${e?.message ?? e}`, code: "LIVE_SESSION_ACCESS_FAILED" } };
  }
  if (!session) return { attached: false };

  let events;
  try {
    // Fresh public snapshot on every request.  Do not cache this reference.
    events = liveSessionEvents(session);
  } catch (e) {
    return { attached: true, error: { ok: false, reason: `live session events access failed: ${e?.message ?? e}`, code: "LIVE_SESSION_EVENTS_FAILED" } };
  }
  if (!Array.isArray(events)) {
    return { attached: true, error: { ok: false, reason: "live session returned no public events array", code: "LIVE_SESSION_EVENTS_INVALID" } };
  }

  const identityRequests = new Map();
  const targetSeqs = new Set();
  if (captureEvidence && Array.isArray(captureEvidence.anchors)) {
    for (const anchor of captureEvidence.anchors) {
      const identity = nodeKeyIdentity(anchor?.nodeKey);
      if (identity.reason || identity.kind === "turn-tail" || identity.kind === "turn-error" || identity.kind === "turn-max-tokens") continue;
      let requestKey;
      if (identity.kind === "assistant-step") requestKey = `assistant-step\u0000${identity.turn}\u0000${identity.step}`;
      else if (identity.kind === "input-message" || identity.kind === "user") requestKey = `input-message\u0000${identity.id}`;
      else if (identity.kind === "tool-call") requestKey = `tool-call\u0000${identity.id}`;
      else continue;
      if (!identityRequests.has(requestKey)) identityRequests.set(requestKey, identity);
    }
  } else {
    // Compatibility path for the old host proposal shape.  The submitted
    // sequence is only a bounded selector for the live scan; effective text
    // and the resulting locator are still reconstructed from event content.
    for (const segment of candidate?.segments ?? []) {
      if (Number.isSafeInteger(segment?.eventSeq)) targetSeqs.add(segment.eventSeq);
    }
    for (const item of candidate?.unresolved ?? []) {
      if (Number.isSafeInteger(item?.eventSeq)) targetSeqs.add(item.eventSeq);
    }
  }

  const matched = [];
  const matchedSeqs = new Set();
  const identityMatches = new Map();
  const retain = (event, requestKey) => {
    if (requestKey) {
      const list = identityMatches.get(requestKey) ?? [];
      list.push(event);
      identityMatches.set(requestKey, list);
    }
    if (!matchedSeqs.has(event.seq)) {
      matchedSeqs.add(event.seq);
      matched.push({ event });
    }
  };

  // Do not spread, map, filter, clone, or build a full-session intermediate.
  for (const item of events) {
    const event = item?.event && typeof item.event === "object" ? item.event : item;
    if (!event || !Number.isSafeInteger(event.seq)) continue;
    const d = event.data || {};
    if (targetSeqs.has(event.seq)) {
      if (event.type === "user/message" && Array.isArray(d.content)) retain(event);
      else if (event.type === "assistant/message" && Array.isArray(d.message?.content) && Number.isSafeInteger(d.turn) && Number.isSafeInteger(d.step)) retain(event);
      continue;
    }
    if (event.type === "user/message" && Array.isArray(d.content) && typeof d.id === "string") {
      const key = `input-message\u0000${d.id}`;
      if (identityRequests.has(key)) retain(event, key);
      continue;
    }
    if (event.type === "assistant/message" && Array.isArray(d.message?.content) && Number.isSafeInteger(d.turn) && Number.isSafeInteger(d.step)) {
      const key = `assistant-step\u0000${d.turn}\u0000${d.step}`;
      if (identityRequests.has(key)) retain(event, key);
    }
    // tool/call is deliberately not retained: the existing authoritative
    // snapshot builder has no positive tool node, so claiming support here
    // would change the established product semantics.
  }

  for (const [requestKey, matches] of identityMatches) {
    if (matches.length > 1) {
      return {
        attached: true,
        error: {
          ok: false,
          reason: `live renderer identity is ambiguous (${requestKey}); refusing to choose an event`,
          code: "LIVE_SOURCE_IDENTITY_AMBIGUOUS",
        },
      };
    }
  }
  return { attached: true, snapshotNodes: buildSnapshotFromEvents(matched) };
}

/**
 * Host authoritative snapshot: attached live sessions use the bounded public
 * fast path; only an actually cold session uses the existing readSession path.
 */
async function authoritativeSnapshot(ctx, sessionId, candidate, captureEvidence) {
  const live = await liveCandidateSnapshot(ctx, sessionId, candidate, captureEvidence);
  if (live.attached) return live.error ?? { ok: true, snapshotNodes: live.snapshotNodes };

  const sq = ctx.get("sessionQuery");
  if (!sq || typeof sq.readSession !== "function") {
    return { ok: false, reason: "host sessionQuery service unavailable — cannot perform authoritative source read; refusing to validate (fail-closed)", code: "SESSION_QUERY_UNAVAILABLE" };
  }
  let read;
  try {
    read = await sq.readSession(sessionId);
  } catch (e) {
    return { ok: false, reason: `host readSession failed: ${e?.message ?? e}`, code: "SESSION_READ_FAILED" };
  }
  const events = read?.events;
  if (!Array.isArray(events)) {
    return { ok: false, reason: "host readSession returned no events array", code: "SESSION_READ_INVALID" };
  }
  return { ok: true, snapshotNodes: buildSnapshotFromEvents(normalizeReadEvents(events)) };
}

/**
 * readSession 返回 corpus 存储形态的**扁平** event（{ seq, type, time, data, ... }，
 * 经 snapshotSessionEvent clone），而 buildSnapshotFromEvents 的输入契约是
 * session.history 的**包裹**形态 [{ event: {...} }]：
 * 未归一化时 snapshotNodes 为空 → validateAnchoredProposal 全部
 * RECONSTRUCT_FAILED "event N not found"）。此处把扁平形态包裹为
 * { event }，已包裹的原样透传，两种生产方（sessionQuery.readSession /
 * session.history）都归一化到同一契约。
 */
function normalizeReadEvents(events) {
  return events.map((item) =>
    item && typeof item === "object" && item.event && typeof item.event === "object"
      ? item
      : { event: item }
  );
}

export async function handleAnchoredRoute(ctx, req, res, url) {
  if (url.pathname === "/notes-api/anchored/validate" || url.pathname === "/notes-api/anchored/prepare") {
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
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "invalid JSON body", code: "BAD_JSON" }));
      return true;
    }
    const candidate = payload.candidate;
    if (!candidate || typeof candidate !== "object" || typeof candidate.sessionId !== "string" || !SESSION_ID_RE.test(candidate.sessionId)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "candidate.sessionId required", code: "INVALID_CANDIDATE" }));
      return true;
    }
    // New capture requests carry bounded browser evidence only.  Resolve every
    // renderer candidate against the bounded authoritative event set, then run the
    // existing validator over the reconstructed proposal.  The old proposal
    // shape remains accepted for Save/compatibility tests; it uses the same
    // live scan when attached and the existing single readSession when cold.
    let captureEvidence;
    if (candidate.evidence !== undefined) {
      const evidence = candidate.evidence;
      const forbidden = ["segments", "effectiveSourceText", "unresolved", "nodeKeys"];
      if (!evidence || typeof evidence !== "object" || evidence.sessionId !== candidate.sessionId || evidence.projectionVersion !== candidate.projectionVersion || forbidden.some((key) => Object.prototype.hasOwnProperty.call(candidate, key))) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "invalid or authority-bearing capture evidence envelope", code: "INVALID_CAPTURE_EVIDENCE" }));
        return true;
      }
      captureEvidence = evidence;
    }
    const snap = await authoritativeSnapshot(ctx, candidate.sessionId, candidate, captureEvidence);
    if (!snap.ok) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snap));
      return true;
    }
    let proposal = candidate;
    if (captureEvidence !== undefined) {
      const evidence = captureEvidence;
      proposal = proposalFromCaptureEvidence(evidence, snap.snapshotNodes, {
        sessionId: candidate.sessionId,
        projectionVersion: candidate.projectionVersion,
      });
      if (proposal.proposalType === "rejected") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: proposal.reason, code: "CAPTURE_EVIDENCE_REJECTED", detail: proposal }));
        return true;
      }
      proposal = { ...proposal, sessionId: candidate.sessionId };
    }
    // snapshot 由 candidate.sessionId 的权威 readSession 产生 → snapshotSessionId
    // 绑定同会话；validateAnchoredProposal 内部再做 session identity binding 校验。
    const v = validateAnchoredProposal(proposal, snap.snapshotNodes, candidate.sessionId);
    if (!v.ok) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
      return true;
    }
    if (url.pathname === "/notes-api/anchored/validate") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, validated: v.validated }));
      return true;
    }
    // prepare：validate + item + 序列化单个 block（不读盘不写盘——client 负责
    // 追加到其已加载 lane body 并走 whole-lane PUT If-Match）
    const lane = payload.lane;
    if (typeof lane !== "string" || !LAYER_KEYS.has(lane)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: `invalid lane "${lane}"`, code: "INVALID_LANE" }));
      return true;
    }
    const comment = typeof payload.comment === "string" ? payload.comment : "";
    let item;
    try {
      item = buildAnchoredItem(v, { captureOrigin: candidate.sessionId, comment });
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: `item build failed: ${e.message}`, code: "ITEM_BUILD_FAILED" }));
      return true;
    }
    let block;
    try {
      block = serializeItem(item);
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: `block serialization failed: ${e.message}`, code: "BLOCK_SERIALIZE_FAILED" }));
      return true;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, block, validated: v.validated }));
    return true;
  }
  return false;
}
