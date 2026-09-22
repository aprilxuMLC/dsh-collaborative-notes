// dsh-collab-notes — carry merge composition（empty-side elision）
//
// occupied-lane merge 的序列化/presentation 最小修正：
//   parent side 语义为空 → 不再生成无意义的 "## 来自父分支" wrapper；
//   child side 语义为空 → 不再生成无意义的 "## 当前分支已有内容" wrapper；
//   一侧为空 → 保留有意义的一侧原内容（字节原样，structured 块不被触碰）；
//   两侧都空 → truthful empty（不制造 wrapper/内容）；
//   两侧都非空 → 既有确定性 wrapper 格式不变（parent-first chronology）。
// 不改变 all/some/none、merge/keep/replace、derivation、capture-origin、
// historical Source Anchor、stale/conflict integrity、structured parseability。
// 语义为空 = trim 后为空串（与既有 conflict 判定一致：childContent.trim()>0）。
//
// holder-local item identity + fork/carry eligibility derivation binding：carry 的
// child copy **不得字节原样复制 parent 的 holder-local item-key**——child 获得
// child-local representation，其 carried item 应携带**新的 child-local item-key**。
// 新 carry 一律经 carryRekeyWithKeys：有 key 的 item 换新，
// **keyless（pre-legacy keyless format）也 mint fresh key**（不再"保持原样字节"）；legacy/opaque 节点
// 字节不动。capture-origin/snapshot/comment/provenance/derivation/顺序均不变；这不
// 构成 recapture。

import { newItemKey, parseLaneBody, serializeLaneBody, withItemKey } from "./structured-item.js";
import { liveSessionEvents } from "./live-session-events.js";

const CARRY_CONFLICT_HEADER = "## 来自父分支\n\n";
const CARRY_CONFLICT_SEPARATOR = "\n\n---\n\n## 当前分支已有内容\n\n";
const isEmpty = (s) => (s ?? "").trim().length === 0;

/**
 * @param {string} parentContent  parent lane 原文（可为空）
 * @param {string} childContent   child lane 原文（可为空）
 * @returns {string} merge 结果文本
 */
export function composeCarryMerge(parentContent, childContent) {
  const p = parentContent ?? "";
  const c = childContent ?? "";
  const pEmpty = isEmpty(p);
  const cEmpty = isEmpty(c);
  if (!pEmpty && !cEmpty) {
    return CARRY_CONFLICT_HEADER + p + CARRY_CONFLICT_SEPARATOR + c;
  }
  if (pEmpty && cEmpty) return "";
  if (pEmpty) return c; // 保留 child 原字节（无 wrapper）
  return p;             // child 空 → 保留 parent 原字节（无 wrapper）
}

/**
 * fork/carry eligibility decision structured-merge normalization：
 *
 * merge 决策物化时，若 parent（已过滤+re-key）与 child 两侧都能安全表示为
 * **supported structured items**（parse 无 legacy/opaque 节点），则物化为一个普通
 * child-local lane：retained parent items 在前、current child items 在后（每侧内部序
 * 不变；deterministic preserve-both，不 dedupe/不 semantic merge/不推断 supersede）。
 * 任一含 legacy/opaque/non-normalizable → 保留既有 truthful preserve-both wrapper
 * （composeCarryMerge）作为 compatibility path。空侧 elision 语义不变。
 */
export function isFullyStructuredLane(text) {
  const parsed = parseLaneBody(String(text ?? ""));
  return parsed.nodes.every((n) => n.type === "item" && Boolean(n.item));
}

/** True when a lane contains a current message-identity Source that is
 * parent-anchored and therefore needs the authoritative parent event snapshot
 * for fork-cut comparison. Structural non-comparable material does not require
 * an event read. */
export function needsParentMessageEvents(laneText, parentSessionId) {
  const parsed = parseLaneBody(String(laneText ?? ""));
  return parsed.nodes.some((node) => {
    if (node.type !== "item" || !node.item) return false;
    const sp = node.item.sourcePayload;
    return Boolean(
      sp && typeof sp === "object" && sp.sessionId === parentSessionId &&
      (!Array.isArray(sp.segments) || sp.segments.length === 0) &&
      typeof sp.messageId === "string" && sp.messageId.length > 0
    );
  });
}

/** Acquire one authoritative parent event snapshot for all selected lanes that
 * need message-identity comparison. `null` means no read was required; an
 * array is reused by every lane filter. A missing/non-array authoritative
 * snapshot is also an operational failure. Exceptions intentionally propagate
 * so the caller can surface an explicit carry failure before any write. */
export function loadParentMessageEvents(laneTexts, { parentSessionId, parentSession = null } = {}) {
  const required = Array.isArray(laneTexts) && laneTexts.some((text) => needsParentMessageEvents(text, parentSessionId));
  if (!required) {
    return null;
  }
  if (!parentSession) throw new Error("authoritative parent Session unavailable");
  const events = liveSessionEvents(parentSession);
  if (!Array.isArray(events)) throw new Error("authoritative parent event snapshot unavailable");
  return events;
}
export function mergeCarriedSides(parentText, childText) {
  const p = parentText ?? "";
  const c = childText ?? "";
  const pEmpty = isEmpty(p);
  const cEmpty = isEmpty(c);
  if (pEmpty && cEmpty) return "";
  if (pEmpty) return c; // 父侧空（含全被资格过滤）→ child only（elision 不变）
  if (cEmpty) return p;
  if (isFullyStructuredLane(p) && isFullyStructuredLane(c)) {
    const pp = parseLaneBody(p);
    const cc = parseLaneBody(c);
    const nodes = [...pp.nodes, ...cc.nodes];
    return serializeLaneBody({ nodes, trailingNewline: cc.trailingNewline || pp.trailingNewline });
  }
  return composeCarryMerge(p, c);
}

/**
 * fork/carry eligibility decision derivation binding：
 * captureOrigin 不再承担 derivation identity。新 system-known carry 在 marker 里
 * 记录 exact per-lane child-local item-key binding；判定 current-carry derived 以
 * exact binding 为唯一 authority。
 */

/**
 * Carry re-key + keyless mint：对将被写进 child 的 parent lane
 * 文本，每条 supported structured item 都获得一个 **fresh child-local item-key**：
 *   - 已有 key → 换新 child-local key（既有 Notes behavior 行为）；
 *   - keyless（pre-legacy keyless format）→ 为 child representation **mint fresh key**（窄重开 Notes behavior
 *     carry 实现细节；parent 原件不变、非 recapture、非 global identity）。
 * legacy/opaque 节点字节不动。返回 { text, keys }（keys = 输出中按序的 child-local
 * keys，供 marker exact binding 使用）。
 * @param {string} laneText
 * @returns {{text:string, keys:string[]}}
 */
export function carryRekeyWithKeys(laneText) {
  const text = laneText ?? "";
  const parsed = parseLaneBody(text);
  const keys = [];
  let changed = false;
  const nodes = parsed.nodes.map((node) => {
    if (node.type !== "item" || !node.item) return node;
    const fresh = newItemKey();
    keys.push(fresh);
    changed = true;
    return { type: "item", item: withItemKey(node.item, fresh), raw: node.raw };
  });
  if (!changed) return { text, keys: [] }; // 全 legacy / 空 → 原字节
  parsed.nodes = nodes;
  return { text: serializeLaneBody(parsed), keys };
}

/**
 * Exact derivation authority：声称"当前 child-local item 是本次
 * immediate parent→child carry 的 derived representation"必须满足：
 *   live ordinary-fork child（调用方提供 header.parentSession）+ marker
 *   parentSessionId 一致 + supported marker version/shape + status==='carried' +
 *   当前 lane 存在 binding + 当前 itemKey 在该 lane binding 中**唯一命中**。
 * 任一项失败/ambiguous → 不得用 captureOrigin/order/text 补猜。
 * @param {object} o
 * @param {string} o.headerParentSession  live child header.parentSession
 * @param {object|null} o.marker          carry marker（含 bindings）
 * @param {string} o.lane                 当前 lane key
 * @param {string} o.itemKey              当前 item 的 child-local item-key
 * @param {number} [o.itemKeyOccurrences] 当前 itemKey 在当前 lane 中出现的次数
 *   （>1 = 同一 holder key 重复 → fail closed）
 * @returns {{ok:boolean, reason?:string}}
 */
export function evaluateExactDerivation({ headerParentSession, marker, lane, itemKey, itemKeyOccurrences }) {
  if (!marker || typeof marker !== "object") return { ok: false, reason: "marker-absent" };
  if (marker.version !== 2 || typeof marker.bindings !== "object" || marker.bindings === null || Array.isArray(marker.bindings)) {
    return { ok: false, reason: "version-or-shape-unsupported" };
  }
  if (marker.status !== "carried") return { ok: false, reason: "status-not-carried" };
  if (typeof marker.parentSessionId !== "string" || marker.parentSessionId === "" || marker.parentSessionId !== headerParentSession) {
    return { ok: false, reason: "parent-mismatch" };
  }
  const bound = marker.bindings[lane];
  if (!Array.isArray(bound)) return { ok: false, reason: "lane-unbound" };
  if (typeof itemKey !== "string" || itemKey === "") return { ok: false, reason: "item-key-absent" };
  const hits = bound.filter((k) => k === itemKey);
  if (hits.length === 0) return { ok: false, reason: "not-bound" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous-duplicate-key" };
  if (Number.isSafeInteger(itemKeyOccurrences) && itemKeyOccurrences > 1) {
    return { ok: false, reason: "ambiguous-duplicate-in-lane" };
  }
  return { ok: true };
}

/**
 * Notes behavior：fork carry 的源位资格过滤。
 *
 * 语义（supported carry eligibility matrix；由当前实现直接执行）：
 * **父会话共享历史**的思考保留——anchored Note 若其历史 Source Anchor 指向父会话
 * （sourcePayload.sessionId === parentSessionId），按**历史源位**（事件序）判定，与
 * capture 时间无关：
 *   全部 segment.eventSeq < seedLength（源位在共享前缀内，含 fork-turn 末尾）→ KEEP
 *   任一 segment.eventSeq >= seedLength（源位在 fork cut 之后）→ EXCLUDE
 *   straddle（跨 cut 源选择，含 cut 后内容）→ EXCLUDE WHOLE NOTE
 * Governing rule：仅**正向确立的 parent-post-fork source dependence** 触发排除；
 * 无可比 parent-history locator 不建立 post-fork 定位。因此以下类一律 KEEP（approved）：
 * source-independent、指向其它会话的 anchored、legacy/opaque、keyless、parent 锚定
 * 但 locator 不可排序（缺 eventSeq/非整数——schema 下不可出现，防御保留），以及
 * messageId 无法在权威 parent Session 中唯一解析的 Source。后者不得猜测，因此保留。
 * child Session 无 inheritedEventCount（非 rc.2 session.fork 产物）→ 返回原样
 * （reason: no-seed-length）。
 *
 * 机械事实（rc.2）：dsh-session 事件 seq === log 下标（get seq()=log.length；
 * seed 从 0 连续）；session.fork 的 child 以 parent events[0..cut) 为 seed，
 * live Session.inheritedEventCount = 共享前缀长度 = 首个被排除的 parent 事件下标。
 * 外部 session-log wire 才将同一事实编码为 header.seedLength。故 parent 锚定的
 * eventSeq < cut ⟺ 源位在共享前缀内——**精确、结构化、无需读父事件日志**。
 * 不 split Notes、不 trim Source Anchor/snapshot；无 unknown-eligibility 状态。
 *
 * @param {string} laneText parent lane 原文
 * @param {{parentSessionId:string, seedLength:number|null, parentSession?:object|null}} opts
 * @returns {{body:string, reason?:string, filtered:number, excluded:Array<{code:string}>}}
 */
export function filterParentLaneForFork(laneText, { parentSessionId, seedLength, parentSession = null, parentEvents = undefined }) {
  const text = laneText ?? "";
  if (!Number.isSafeInteger(seedLength) || seedLength < 0) {
    return { body: text, reason: "no-seed-length", filtered: 0, excluded: [] };
  }
  const parsed = parseLaneBody(text);
  const excluded = [];
  const kept = [];
  let filtered = 0;
  for (const node of parsed.nodes) {
    if (node.type === "legacy" || !node.item) { kept.push(node); continue; }
    const sp = node.item.sourcePayload;
    const parentAnchored = sp && typeof sp === "object" && sp.sessionId === parentSessionId;
    if (!parentAnchored) { kept.push(node); continue; }
    if (Array.isArray(sp.segments) && sp.segments.length > 0) {
      const allInt = sp.segments.every((sg) => sg && Number.isSafeInteger(sg.eventSeq) && sg.eventSeq >= 0);
      if (!allInt) { kept.push(node); continue; } // 不可排序 locator → 不改语义（保留）
      const inPrefix = sp.segments.every((sg) => sg.eventSeq < seedLength);
      if (inPrefix) { kept.push(node); continue; }
      const afterCut = sp.segments.every((sg) => sg.eventSeq >= seedLength);
      excluded.push({ code: afterCut ? "after-cut" : "straddle" });
      filtered++;
      continue;
    }
    if (typeof sp.messageId !== "string" || sp.messageId.length === 0 || !parentSession) {
      kept.push(node);
      continue;
    }
    const events = parentEvents === undefined ? liveSessionEvents(parentSession) : parentEvents;
    if (!Array.isArray(events)) { kept.push(node); continue; }
    const matches = events.flatMap((entry) => {
      const event = entry?.event ?? entry;
      if (!event || !Number.isSafeInteger(event.seq)) return [];
      const data = event.data ?? {};
      const messageId = event.type === "user/message" ? data.id
        : event.type === "assistant/message" ? data.message?.id
          : undefined;
      return messageId === sp.messageId ? [event.seq] : [];
    });
    if (matches.length !== 1) { kept.push(node); continue; } // missing/ambiguous → non-comparable
    if (matches[0] < seedLength) { kept.push(node); continue; }
    excluded.push({ code: "after-cut" });
    filtered++;
  }
  if (filtered === 0) return { body: text, filtered: 0, excluded: [] }; // 原字节（无改动）
  const out = kept.length === 0 ? "" : serializeLaneBody({ nodes: kept, trailingNewline: parsed.trailingNewline });
  return { body: out, filtered, excluded };
}
