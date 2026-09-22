// dsh-collab-notes — Notes behavior host exact source re-entry engine（browser-free）
//
// Bounded source re-entry: preserve established Source identity, use accepted
// historical material as context, and report unavailable or ambiguous cues truthfully.
//   A. parse persisted historical Source Anchor（source-aware item 的 sourcePayload
//      locator）——不依赖 authored Note content（空/非空同路径）；
//   B. deterministic exact resolution：权威 authoritative snapshot（调用方提供
//      snapshotNodes）→ rebuild recorded projection basis/version → apply persisted
//      code-point extent(s) → exact locus。只用 locator + authoritative event source
//      （resolveLocator 同一语义），无 search / semantic / model / DOM 文本匹配；
//   C. 状态（truthful，不互相冒充）：
//        exact        可读可重建：返回 exact text + per-segment + render hints
//        unavailable  source 当前不可读/事件缺失（保留 provenance；snapshot 由调用方
//                     继续展示为 capture-time evidence；不 search/rebind）
//        incompatible locator/projection basis 不可解释（保留 provenance；不用当前
//                     projection 重解旧 offsets；不声称 exact）
//   D. render hints：per segment 给出 renderer 定位身份（user→messageId；
//      assistant→turn/step）；engine 不声称 highlight 发生（renderer 可用性/结果由
//      client 面如实报告）。
//   E. read-only：无写路径、不 mutate note/source metadata。

import {
  isValidLocator,
  isValidMessageIdentity,
  SUPPORTED_PROJECTION_VERSIONS,
  PROJECTION_VERSION_MARKDOWN,
  resolveLocator,
  projectVisibleText,
} from "./source-locator.js";
import { snapshotEventSource, buildSnapshotFromEvents } from "./anchored-capture.js";

const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

const cps = (s) => [...(s ?? "")].length;

/**
 * Locate the persisted selected snapshot inside one authoritative message
 * projection without assigning a historical occurrence.  Coordinates here
 * are only a current runtime cue; durable identity remains sessionId+messageId
 * and the persisted selected material remains S.
 */
function projectionMatches(projection, snapshot) {
  const visible = [...projection];
  const selected = [...snapshot];
  if (selected.length === 0 || selected.length > visible.length) return [];
  const matches = [];
  for (let start = 0; start <= visible.length - selected.length; start++) {
    let equal = true;
    for (let i = 0; i < selected.length; i++) {
      if (visible[start + i] !== selected[i]) {
        equal = false;
        break;
      }
    }
    if (equal) matches.push({ start, end: start + selected.length });
  }
  return matches;
}

/**
 * 从 source-aware item（structured-item parse 产物）提取历史 Source Anchor locator。
 * authored Note content（item.comment）不参与——空/非空不改变 anchor 提取（A/B）。
 * @param {object} item  parseLaneBody node.item（kind/origin/sourcePayload/snapshot）
 * @returns {{ ok: true, locator: object } | { ok: false, code: string, reason: string }}
 */
export function anchorFromItem(item) {
  if (!item || typeof item !== "object") {
    return { ok: false, code: "NO_ITEM", reason: "item required" };
  }
  if (item.kind !== "source-aware") {
    return { ok: false, code: "NO_SOURCE_ANCHOR", reason: "item is not source-aware; nothing to re-enter" };
  }
  const locator = item.sourcePayload;
  if (!locator || typeof locator !== "object") {
    return { ok: false, code: "NO_ANCHOR_LOCATOR", reason: "source-aware item carries no parseable source-payload locator" };
  }
  return validateLocatorShape(locator);
}

/**
 * 校验 locator shape（不读 source）。unsupported projectionVersion / shape 非法 →
 * incompatible 状态（truthful；不重新解释、不降级、不 search）。
 * @returns {{ ok: true, locator } | { ok: false, code, reason }}
 */
export function validateLocatorShape(locator) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return { ok: false, code: "INCOMPATIBLE_LOCATOR", reason: "locator not an object" };
  }
  if (isValidMessageIdentity(locator)) return { ok: true, locator };
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(locator.projectionVersion)) {
    return {
      ok: false,
      code: "INCOMPATIBLE_PROJECTION",
      reason: `projection basis/version ${locator.projectionVersion} is not interpretable here; refusing to reinterpret old offsets under the current projection`,
    };
  }
  if (!isValidLocator(locator)) {
    return { ok: false, code: "INCOMPATIBLE_LOCATOR", reason: "locator shape invalid under supported projection basis" };
  }
  return { ok: true, locator };
}

/**
 * 节点身份 render hint：user/input-message → messageId；assistant → turn/step
 * （出现序，与 capture-side buildSnapshotFromEvents 同一规则）。
 */
function renderHintFor(snapshotNodes, eventSeq) {
  const node = (snapshotNodes || []).find((n) => n.seq === eventSeq);
  if (!node) return { eventSeq };
  if (node.kind === "user") return { eventSeq, messageId: node.messageId };
  if (node.kind === "assistant") return { eventSeq, turn: node.turn, step: node.step };
  return { eventSeq };
}

/**
 * Deterministic exact resolution：locator-only reconstruction over authoritative
 * snapshot（session identity bound：snapshotSessionId 必须 == locator.sessionId）。
 *
 * @param {object} locator
 * @param {Array<object>} snapshotNodes  buildSnapshotFromEvents 产物（权威 events）
 * @param {string} snapshotSessionId      snapshot 所属 session（identity binding）
 * @param {string} expectedSnapshot       persisted historical selected text S;
 *                                        current resolution must match it
 * @returns {{ ok: true, text, perSegment: [{eventSeq,start,end,text,hint}] } |
 *           { ok: false, code, reason } }
 *
 * 错误分类（truthful，不互斥也不重解）：
 *   EVENT_NOT_FOUND / EXTENT_INVALID 来自 resolveLocator 的 ProjectionError——
 *   调用方把 EVENT_NOT_FOUND 映射为 unavailable（source 不可用/事件缺失，保留
 *   provenance，不 rebind）；EXTENT_INVALID/INVALID/UNSUPPORTED 映射为
 *   incompatible（locator/basis 不可解释，不用当前投影重解）。
 */
export function resolveExactLocus(locator, snapshotNodes, snapshotSessionId, expectedSnapshot) {
  if (!locator || typeof locator !== "object" || typeof snapshotSessionId !== "string" || !SESSION_ID_RE.test(snapshotSessionId)) {
    return { ok: false, code: "REENTRY_INVALID_ARGUMENT", reason: "locator + bound snapshotSessionId required" };
  }
  if (typeof expectedSnapshot !== "string") {
    return { ok: false, code: "HISTORICAL_S_REQUIRED", reason: "persisted historical selected snapshot S is required; refusing to present current source as historical exact" };
  }
  if (snapshotSessionId !== locator.sessionId) {
    return {
      ok: false,
      code: "SESSION_MISMATCH",
      reason: `snapshot session (${snapshotSessionId}) != locator session (${locator.sessionId}); refusing cross-session-basis resolution`,
    };
  }
  if (isValidMessageIdentity(locator)) {
    const matches = (snapshotNodes || []).filter((node) => node && node.messageId === locator.messageId && Array.isArray(node.content));
    if (matches.length === 0) {
      return { ok: false, code: "REENTRY_EVENT_UNAVAILABLE", reason: `source message ${locator.messageId} is not available in the authoritative session` };
    }
    if (matches.length > 1) {
      return { ok: false, code: "REENTRY_SOURCE_IDENTITY_AMBIGUOUS", reason: `source message identity ${locator.messageId} is ambiguous in the authoritative session` };
    }
    const node = matches[0];
    let projection;
    try {
      projection = projectVisibleText(node.content, PROJECTION_VERSION_MARKDOWN);
    } catch (e) {
      // Identity is already authoritative.  An unprojectable current message
      // does not prove that historical S contradicts it, so retain Source
      // success and provide only a broader, non-exact cue.
      return {
        ok: true,
        text: expectedSnapshot,
        sourceMessage: "",
        projectionUnavailable: true,
        perSegment: [{
          eventSeq: node.seq,
          messageId: node.messageId,
          start: 0,
          end: 0,
          exactSpan: false,
          text: expectedSnapshot,
          hint: renderHintFor(snapshotNodes, node.seq),
        }],
        reason: String(e?.message ?? e),
      };
    }
    const matchesInProjection = projectionMatches(projection, expectedSnapshot);
    if (matchesInProjection.length > 0) {
      // Durable identity remains sessionId + messageId.  These exact offsets
      // are only current runtime cues inside that already-authorized message;
      // when S repeats, return every literal occurrence instead of choosing
      // one historical occurrence.
      const hint = renderHintFor(snapshotNodes, node.seq);
      return {
        ok: true,
        text: expectedSnapshot,
        sourceMessage: projection,
        matchCount: matchesInProjection.length,
        cueKind: "exact",
        perSegment: matchesInProjection.map((match) => ({
          eventSeq: node.seq,
          messageId: node.messageId,
          start: match.start,
          end: match.end,
          text: expectedSnapshot,
          hint,
        })),
      };
    }
    const perSegment = [{
      eventSeq: node.seq,
      messageId: node.messageId,
      start: 0,
      end: cps(projection),
      exactSpan: false,
      text: expectedSnapshot,
      hint: renderHintFor(snapshotNodes, node.seq),
    }];
    // A reliable projection exists and does not contain S.  This is the
    // narrow mechanical basis for a genuine historical-content contradiction.
    if (projection !== expectedSnapshot) {
      return {
        ok: false,
        code: "HISTORICAL_S_MISMATCH",
        reason: "current authoritative source message differs from historical selected snapshot S; refusing to present current content as historical exact",
        historicalSnapshot: expectedSnapshot,
        currentSourceText: projection,
        sourceMessage: projection,
        perSegment,
      };
    }
    return { ok: true, text: expectedSnapshot, sourceMessage: projection, perSegment };
  }
  const eventSource = snapshotEventSource(snapshotNodes, snapshotSessionId);
  let resolved;
  try {
    resolved = resolveLocator(locator, eventSource);
  } catch (e) {
    const code = e && (e.code || e.name);
    return {
      ok: false,
      code: code === "EVENT_NOT_FOUND" ? "REENTRY_EVENT_UNAVAILABLE" : code === "EXTENT_INVALID" ? "REENTRY_EXTENT_INCOMPATIBLE" : "REENTRY_RESOLVE_FAILED",
      reason: String(e?.message ?? e),
    };
  }
  if (!resolved || typeof resolved.text !== "string") {
    return { ok: false, code: "REENTRY_RESOLVE_FAILED", reason: "exact reconstruction returned nothing" };
  }
  // per-segment 文本：对每个 eventSeq 用同一权威投影重建并 slice（与 resolveLocator
  // 同一 basis；重复计算仅用于把每段文本/身份给到 renderer/调用方）。
  const perSegment = resolved.segments.map((seg) => {
    let segText = "";
    try {
      const content = eventSource(locator.sessionId, seg.eventSeq);
      const projected = content ? projectVisibleText(content, locator.projectionVersion) : "";
      segText = [...projected].slice(seg.start, seg.end).join("");
    } catch { segText = ""; }
    return { eventSeq: seg.eventSeq, start: seg.start, end: seg.end, text: segText, hint: renderHintFor(snapshotNodes, seg.eventSeq) };
  });
  if (resolved.text !== expectedSnapshot) {
    // Keep the authoritative locator and current projection available to the
    // browser UI as a grounded non-exact cue input.  The mismatch remains a
    // failed exact reconstruction: callers must not treat this result as an
    // exact source or rewrite the persisted historical S.
    return {
      ok: false,
      code: "HISTORICAL_S_MISMATCH",
      reason: "current authoritative source at the persisted locator differs from the historical selected snapshot S; refusing to present current source as historical exact",
      historicalSnapshot: expectedSnapshot,
      currentSourceText: resolved.text,
      perSegment,
    };
  }
  return { ok: true, text: resolved.text, perSegment };
}

/**
 * 每 event 的权威投影文本（供 client 按位置做确定性 DOM/projection 映射——
 * 不用 seg.text 在 DOM 中 search/first-match）。
 * @returns {{ eventSeq: number, projection: string }[]}
 */
export function eventProjections(snapshotNodes, eventSeqs, projectionVersion = PROJECTION_VERSION_MARKDOWN) {
  const seen = new Set();
  const out = [];
  for (const seq of eventSeqs || []) {
    if (seen.has(seq)) continue;
    seen.add(seq);
    const node = (snapshotNodes || []).find((n) => n.seq === seq);
    if (!node || !Array.isArray(node.content)) continue;
    try {
      out.push({ eventSeq: seq, messageId: node.messageId, projection: projectVisibleText(node.content, projectionVersion) });
    } catch { /* 该 event 投影失败：跳过（client 将无法确定性映射 → truthful downgrade） */ }
  }
  return out;
}

/** snapshot 构造 helper：route 层把权威 readSession events（扁平/包裹均可）归一化喂入。 */
export function snapshotFromEvents(events) {
  return buildSnapshotFromEvents(normalizeReadEventsForSnapshot(events));
}

/** 扁平 event（{seq,type,time,data,…}）→ {event} 包裹（buildSnapshotFromEvents 契约）。 */
export function normalizeReadEventsForSnapshot(events) {
  return (events ?? []).map((item) =>
    item && typeof item === "object" && item.event && typeof item.event === "object"
      ? item
      : { event: item }
  );
}

/** cps 导出供 route/测试校验 snapshot-length 对齐。 */
export { cps };
