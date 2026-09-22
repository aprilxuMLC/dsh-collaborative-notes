// dsh-collab-notes — host-side anchored-capture commit engine (browser-free)
//
// Responsibilities:
//   A. authoritative proposal validation——host 从权威 session events 构造
//      snapshotNodes，用 locator-only reconstruction（source-locator resolveLocator）
//      独立校验 client 提交的 proposal，拒绝任何不可重建 / 降级 / 篡改；
//   B. structured-item 序列化——把 host-validated accepted source selection
//      编码为 source-aware item（snapshot + comment + sourcePayload locator）；
//   C. whole-lane append——parseLaneBody → push 新 item node → serializeLaneBody，
//      保持 distinct captures 与 capture order（不 dedupe / merge / replace-last）；
//   D. failure invariants——校验失败 / 序列化失败 / 无 positive source 一律 truthful
//      failure，不产生看似成功的 anchored item；不静默截断 snapshot；不降级成
//      source-independent。
//
// 本模块 browser-free（无 DOM / Selection）；真实 Range→proposal 在 browser
// capture facade（client）执行；host 本模块做 authoritative validation + 持久化
// 编排的纯逻辑部分。eventSource / lane body 由调用方注入（测试可 mock）。
//
// 不引入 durable proposal state / 新 lifecycle taxonomy / semantic pruning /
// global item ID / transaction subsystem。

import { KIND_SOURCE_AWARE, makeItem, newItemKey, parseLaneBody, serializeLaneBody, withItemKey } from "./structured-item.js";
import {
  PROJECTION_VERSION,
  SUPPORTED_PROJECTION_VERSIONS,
  projectVisibleText,
  resolveLocator,
  buildLocator,
  buildMessageIdentity,
  isValidLocator,
} from "./source-locator.js";

const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

/** 简单码点计数（与 projection 单位一致）。 */
const cps = (s) => [...(s ?? "")].length;

/**
 * 从 session events（session.history 形态）构造 snapshotNodes。
 * 事件形态（真实 rc.2）：
 *   user/message     → data.id（messageId）+ data.content（text blocks）+ data.source?.kind
 *   assistant/message→ data.message.content（text blocks），nodeKey kind assistant-step
 *                     以 turn/step 表达。
 *
 * **assistant identity 规则（适用于长会话）**：
 *   优先使用事件自带的**真实 host turn/step**（data.turn / data.step——host
 *   session.history 在长会话返回**有界窗口**，窗口起点 ≠ 会话起点；assistant/message
 *   与 assistant/chunk 的 data.turn/step 都是 renderer 的全局轮次，是权威身份）。
 *   其次用 opts.annotateAssistant 回调（若提供且返回合法 turn/step）。
 *   仅当 opts.allowAsmIndexFallback === true 时（**测试 fixture / 已确立等价
 *   的兼容路径**）回退窗口内 asmIndex 编号；真实 host 路径（capture/reentry/
 *   validate）不得回退——缺权威 turn/step 时跳过该事件（truthful：无权威身份
 *   不 guess/rebind，由上层如实 reject/unresolved）。
 *
 * @param {Array<object>} events  [{ event: { seq, type, data } }]（session.history.value.events）
 * @param {object} [opts]  { annotateAssistant?: (seq) => { turn, step },
 *                           allowAsmIndexFallback?: boolean }
 * @returns {Array<object>} snapshotNodes
 */
export function buildSnapshotFromEvents(events, opts = {}) {
  if (!Array.isArray(events)) throw new Error("anchored-capture: events must be an array");
  const nodes = [];
  let asmIndex = 0;
  for (const { event: e } of events) {
    if (!e || typeof e.seq !== "number") continue;
    if (e.type === "user/message") {
      const d = e.data || {};
      const content = d.content;
      if (!Array.isArray(content)) continue;
      nodes.push({
        kind: "user",
        messageId: d.id,
        seq: e.seq,
        content,
        source: d.source?.kind,
      });
    } else if (e.type === "assistant/message") {
      const d = e.data || {};
      const content = d.message?.content;
      if (!Array.isArray(content)) continue;
      asmIndex += 1;
      const dTurn = d.turn;
      const dStep = d.step;
      let turn = null;
      let step = null;
      if (Number.isSafeInteger(dTurn) && Number.isSafeInteger(dStep) && dTurn >= 0 && dStep >= 0) {
        turn = dTurn; step = dStep; // 真实 host 全局 turn/step（权威）
      } else if (typeof opts.annotateAssistant === "function") {
        const ann = opts.annotateAssistant(e.seq);
        if (ann && Number.isSafeInteger(ann.turn) && Number.isSafeInteger(ann.step)) {
          turn = ann.turn; step = ann.step;
        }
      } else if (opts.allowAsmIndexFallback === true) {
        turn = asmIndex; step = 1; // 仅测试 fixture / 已确立等价的兼容路径
      }
      if (turn === null || step === null) continue; // 无权威身份 → truthful skip
      nodes.push({
        kind: "assistant",
        messageId: d.message?.id,
        turn,
        step,
        seq: e.seq,
        content,
      });
    }
    // tool/system/inject 等 event 不在本 host engine 的 positive-source snapshot
    // 范围（projection 仅 text blocks；非 text → truthful reject 由调用方处理）。
  }
  return nodes;
}

/**
 * 构造 host 侧 eventSource：给定 snapshotNodes（须已绑定 sessionId），返回
 *   (sessionId, eventSeq) => content | undefined
 * 供 resolveLocator 使用。**session identity binding**：snapshotNodes 记录其来源
 * sessionId；请求的 sessionId 与 snapshot 的 session 不一致 → 返回 undefined
 * （resolveLocator → EVENT_NOT_FOUND → truthful reject）。防止"A 会话 locator +
 * B 会话 snapshot（seq 相同）"错误通过校验。
 * @param {Array<object>} snapshotNodes
 * @param {string} snapshotSessionId   snapshot 所属 session
 * @returns {(sessionId:string, eventSeq:number) => Array<object>|undefined}
 */
export function snapshotEventSource(snapshotNodes, snapshotSessionId) {
  const bySeq = new Map((snapshotNodes || []).map((n) => [n.seq, n.content]));
  return (sessionId, eventSeq) => (sessionId === snapshotSessionId ? bySeq.get(eventSeq) : undefined);
}

/**
 * A. Authoritative proposal validation。
 * 输入：client 提交的 candidate proposal（plain data）：
 *   { sessionId, projectionVersion, segments:[{eventSeq,start,end}],
 *     effectiveSourceText, unresolved?:[{eventSeq:number|null, startCP:number, ...}],
 *     nodeKeys? }
 * 校验（host 权威，不信任 client 的 self-claim）：
 *   1. shape / sessionId / projectionVersion 合法；
 *   2. segments 非空且能 buildLocator；
 *   3. locator-only reconstruction（resolveLocator + host snapshotNodes eventSource）
 *      == candidate.effectiveSourceText（证明 client 展示的 effective 与 host 权威
 *      source projection 一致——拒绝篡改 / 伪造 / 版本漂移）；
 *   4. unresolved 不得把本可 exact map 的已知 source 藏进 omission（identity-based，
 *      不做文本扫描）：对每个带 eventSeq + startCP 的 unresolved 条目，用 host 权威
 *      snapshot 计算该 event 的 projection 长度（projectVisibleText(event content,
 *      projectionVersion) 的 code-point 长度）；startCP < 该投影长度 → 条目起点落在
 *      可 exact map 的投影区间内却未映射 → UNRESOLVED_INSIDE_PROJECTION truthful
 *      reject（防降级企图）。判定只用坐标 identity（eventSeq + startCP 对照该 event
 *      的投影长度），**不匹配 unresolved 文本与投影子串**——文本扫描是启发式，会误拒
 *      合法 proposal（chrome 文本恰在 source 中 / duplicate 文本 / 短子串）。无
 *      eventSeq / 无 startCP 的条目（no-source-identity，无 source 归属可降级）不参与
 *      此判定；其真实性由 Save 前 unresolved omission 可见性 + explicit Save 承担。
 * @param {object} candidate
 * @param {Array<object>} snapshotNodes   host 权威 snapshot
 * @param {string} snapshotSessionId      snapshot 所属 session（identity binding）
 * @returns {{ ok: true, validated: {...} } | { ok: false, reason: string, code: string }}
 */
export function validateAnchoredProposal(candidate, snapshotNodes, snapshotSessionId) {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "proposal required", code: "INVALID_PROPOSAL" };
  }
  const { sessionId, projectionVersion, segments, effectiveSourceText } = candidate;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return { ok: false, reason: `invalid sessionId shape "${sessionId}"`, code: "INVALID_SESSION" };
  }
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(projectionVersion)) {
    return { ok: false, reason: `unsupported projectionVersion ${projectionVersion}`, code: "UNSUPPORTED_PROJECTION" };
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, reason: "no positively mapped source segments; nothing to anchor", code: "NO_POSITIVE_SOURCE" };
  }
  if (typeof effectiveSourceText !== "string") {
    return { ok: false, reason: "effectiveSourceText required", code: "INVALID_PROPOSAL" };
  }
  // 2: locator 可构建
  let locator;
  try {
    locator = buildLocator({ sessionId, segments, projectionVersion });
  } catch (e) {
    return { ok: false, reason: `invalid locator: ${e.message}`, code: "INVALID_LOCATOR" };
  }
  // 3: host authoritative reconstruction 必须等于 client effective。
  // session identity binding：snapshot 必须来自 candidate.sessionId 同一会话；
  // 否则 eventSource 对不匹配 session 返回 undefined → resolveLocator 抛
  // EVENT_NOT_FOUND → truthful reject（防跨 session seq 碰撞误通过）。
  if (typeof snapshotSessionId !== "string" || snapshotSessionId !== sessionId) {
    return {
      ok: false,
      reason: `snapshot session (${snapshotSessionId}) != candidate session (${sessionId}); refusing cross-session proposal`,
      code: "SESSION_MISMATCH",
    };
  }
  const eventSource = snapshotEventSource(snapshotNodes, snapshotSessionId);
  let reconstructed;
  try {
    reconstructed = resolveLocator(locator, eventSource);
  } catch (e) {
    return { ok: false, reason: `host cannot reconstruct proposal from authoritative session: ${e.message}`, code: "RECONSTRUCT_FAILED" };
  }
  if (reconstructed.text !== effectiveSourceText) {
    return {
      ok: false,
      reason: "host reconstruction != candidate effectiveSourceText (proposal not authoritative)",
      code: "EFFECTIVE_MISMATCH",
      detail: { host: reconstructed.text.slice(0, 60), candidate: effectiveSourceText.slice(0, 60) },
    };
  }
  // Durable identity is the single authoritative source message.  The
  // current capture surface is one ordinary readable message; retaining
  // event-local extents here is only a transient reconstruction aid.  A
  // selection spanning distinct messages cannot be represented by the new
  // narrow durable identity without inventing a new product schema, so fail
  // closed instead of choosing one message.
  const sourceNodes = locator.segments.map((segment) => (snapshotNodes || []).find((node) => node?.seq === segment.eventSeq));
  const messageIds = [...new Set(sourceNodes.map((node) => node?.messageId).filter((id) => typeof id === "string" && id.length > 0))];
  if (sourceNodes.some((node) => !node || typeof node.messageId !== "string" || node.messageId.length === 0)) {
    return { ok: false, reason: "authoritative source message has no stable Message.id", code: "SOURCE_MESSAGE_ID_UNAVAILABLE" };
  }
  if (messageIds.length !== 1) {
    return { ok: false, reason: "selection spans more than one source message; durable Source identity is one sessionId + messageId", code: "MULTI_MESSAGE_SOURCE_UNSUPPORTED" };
  }
  let sourceIdentity;
  try {
    sourceIdentity = buildMessageIdentity({ sessionId, messageId: messageIds[0] });
  } catch (e) {
    return { ok: false, reason: e.message, code: e.code || "INVALID_SOURCE_IDENTITY" };
  }
  // 4: unresolved 不得**落在某已知 source event 的投影内**（identity 校验，非文本扫描）。
  //   after-projection unresolved 的 basis 坐标 startCP ≥ 该事件投影长度（projLen，
  //   即 projection 之后的 basis 部分）。若某 unresolved 项带 eventSeq 且其 startCP
  //   < 该事件投影长度 → 它位于可 exact map 的投影区间内却未映射 → 降级企图
  //   → truthful reject。此判定基于坐标 identity（该事件投影长度），不做文本搜索。
  //   不做 projectedText.includes(unresolved.text)：那会重新引入文本启发式并误拒
  //   合法 proposal（chrome 文本恰在 source 中 / duplicate 文本 / 短子串）。真正
  //   无法证明"unresolved 非 source"的情形保持 unresolved——unresolved
  //   omission 必须在 Save 前可见，真实性由用户可见性 + explicit Save 负责，不是
  //   host 事后文本扫描。
  const unresolved = Array.isArray(candidate.unresolved) ? candidate.unresolved : [];
  const projLenByEvent = new Map();
  for (const n of snapshotNodes) {
    if (!n || !Array.isArray(n.content)) continue;
    try {
      projLenByEvent.set(n.seq, [...projectVisibleText(n.content, projectionVersion)].length);
    } catch { /* 该 event 投影失败：不参与 identity 判定 */ }
  }
  for (const u of unresolved) {
    if (!u || typeof u !== "object") continue;
    if (u.eventSeq === undefined || u.eventSeq === null) continue; // no-source-identity 条目（无 source 归属，无从降级）
    if (!Number.isSafeInteger(u.startCP)) continue; // 无坐标 → 不判定
    const projLen = projLenByEvent.get(u.eventSeq);
    if (projLen !== undefined && u.startCP < projLen) {
      return {
        ok: false,
        reason: `unresolved entry for event ${u.eventSeq} starts at basis ${u.startCP} inside its projection length ${projLen}; refusing downgrade of exactly-mappable source to unresolved`,
        code: "UNRESOLVED_INSIDE_PROJECTION",
      };
    }
  }
  return {
    ok: true,
    validated: {
      sessionId,
      projectionVersion,
      segments: locator.segments,
      effectiveSourceText: reconstructed.text,
      sourcePayload: sourceIdentity,
      unresolved,
    },
  };
}

/**
 * B. 构造 Notes behavior source-aware anchored item。
 * @param {object} validated  validateAnchoredProposal 返回的 validated
 * @param {object} opts       { captureOrigin, comment? }
 * @returns item（makeItem 产物——含 snapshot/comment/sourcePayload/captureOrigin）
 * @throws 非法组合（由 makeItem 抛）
 *
 * 每条新 anchored Note 在构造时 mint 一条 holder-local opaque item-key
 * （unknown-meta raw row，inert adapter bookkeeping——不表达 pinned/priority/
 * execution/provenance/order；见 structured-item.js withItemKey）。prepare 路径
 * （host）与 prepareAnchoredCommit 共用本构造 → anchored 新保存天然带 key。
 */
export function buildAnchoredItem(validated, { captureOrigin, comment }) {
  if (!validated || validated.ok === false) {
    throw new Error("anchored-capture: buildAnchoredItem requires a validated proposal");
  }
  const v = validated.validated ?? validated;
  const item = makeItem({
    kind: KIND_SOURCE_AWARE,
    captureOrigin,
    snapshot: v.effectiveSourceText,
    comment: comment ?? "",
    sourcePayload: v.sourcePayload,
  });
  return withItemKey(item, newItemKey());
}

/**
 * C. 把一条 anchored item append 到 lane body（保序、distinct、legacy 共存）。
 * 逐条 append——同一 lane 多次 Save 各产生独立 item，不 dedupe / merge / replace。
 * @param {string} existingBody  当前 lane 全文（可为空）
 * @param {object} item          makeItem 产物
 * @returns {string} 新 lane 全文
 */
export function appendAnchoredItemToLane(existingBody, item) {
  const parsed = parseLaneBody(existingBody ?? "");
  parsed.nodes.push({ type: "item", item });
  return serializeLaneBody(parsed);
}

/**
 * D. commit 编排（纯逻辑，调用方提供 existingBody + persistence）。
 * 供 host route 使用：validation → item → append → 返回 { body, item, validated }；
 * 不在此做文件写（由调用方走 whole-lane conflict-safe writer）。
 * @param {object} candidate
 * @param {Array<object>} snapshotNodes
 * @param {object} opts { captureOrigin, comment, existingBody, snapshotSessionId }
 * @returns {{ ok: true, body, item, validated } | { ok: false, reason, code }}
 */
export function prepareAnchoredCommit(candidate, snapshotNodes, { captureOrigin, comment, existingBody, snapshotSessionId }) {
  const v = validateAnchoredProposal(candidate, snapshotNodes, snapshotSessionId);
  if (!v.ok) return v;
  let item;
  try {
    item = buildAnchoredItem(v, { captureOrigin, comment: comment ?? "" });
  } catch (e) {
    return { ok: false, reason: `item build failed: ${e.message}`, code: "ITEM_BUILD_FAILED" };
  }
  // 全量 snapshot 长度检查由调用方（writer 层）按 whole-lane 1 MiB 约束处理；
  // 此处不静默截断 snapshot。
  let body;
  try {
    body = appendAnchoredItemToLane(existingBody ?? "", item);
  } catch (e) {
    return { ok: false, reason: `lane append failed: ${e.message}`, code: "LANE_APPEND_FAILED" };
  }
  return { ok: true, body, item, validated: v.validated };
}

export { isValidLocator };
