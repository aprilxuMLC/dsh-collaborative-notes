// dsh-collab-notes — explicit selection → durable locator / visible-text projection
//
// Production adapter projection + durable source locator（host 侧纯逻辑）。
//
// The projection rejects invalid event content and unsupported block types with
// structured truthful failures, binds resolution to sessionId, and validates
// plain-data renderer hints.

import { projectVisibleMarkdown } from "./markdown-projection.js";

export const PROJECTION_VERSION = 1;
export const PROJECTION_VERSION_MARKDOWN = 2;
export const SUPPORTED_PROJECTION_VERSIONS = [PROJECTION_VERSION, PROJECTION_VERSION_MARKDOWN];

// Session-shaped identity is validated without inventing a new identity format.
const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

/**
 * The durable Source identity for newly captured Notes.  This intentionally
 * has no projection/version/coordinate fields: projection data is a capture
 * and attention concern, while the Host-preserved message id is the source
 * identity that survives dense event-sequence migration.
 */
export function buildMessageIdentity({ sessionId, messageId }) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new ProjectionError(`invalid sessionId shape "${sessionId}"`, "INVALID_SOURCE_IDENTITY");
  }
  if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > 512) {
    throw new ProjectionError("messageId must be a non-empty bounded string", "INVALID_SOURCE_IDENTITY");
  }
  return { sessionId, messageId };
}

export function isValidMessageIdentity(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 2 || keys[0] !== "messageId" || keys[1] !== "sessionId") return false;
  return typeof obj.sessionId === "string" && SESSION_ID_RE.test(obj.sessionId)
    && typeof obj.messageId === "string" && obj.messageId.length > 0 && obj.messageId.length <= 512;
}

/** Transitional Source payload gate: new identity or the legacy v2 locator. */
export function isValidSourcePayload(obj) {
  return isValidMessageIdentity(obj) || isValidLocator(obj);
}

/** Structured projection failure（truthful，不 fallback search）。 */
export class ProjectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProjectionError";
    this.code = code;
  }
}

/** 严格非负安全整数校验。 */
function assertNonNegInt(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new ProjectionError(`${name} must be a non-negative safe integer, got ${v}`, "INVALID_ARGUMENT");
  }
  return v;
}

/**
 * Versioned adapter projection：把 event content 投影为 canonical visible-text
 * string（code points）。
 * v2：text blocks 的 text 顺序拼接（block 间 "\n"）。DSH rc.2 的 reasoning
 * block 是独立于正文的 reasoning surface，因此不进入 visible-text 坐标；
 * capture 侧仍以 DOM-basis 对齐拒绝 reasoning surface 本身的选择。其它未
 * 证明的 block 类型继续拒绝，而不是推断 renderer 将其隐藏或设为不可选择。
 * 非法 content / text block 形状仍返回结构化错误。
 * @param {Array<object>} eventContent
 * @param {number} projectionVersion
 */
export function projectVisibleText(eventContent, projectionVersion = PROJECTION_VERSION) {
  if (projectionVersion === PROJECTION_VERSION_MARKDOWN) {
    return projectVisibleMarkdownContent(eventContent).text;
  }
  if (projectionVersion !== PROJECTION_VERSION) {
    throw new ProjectionError(`unsupported projection version ${projectionVersion}; supported: ${SUPPORTED_PROJECTION_VERSIONS.join(",")}`, "UNSUPPORTED_PROJECTION_VERSION");
  }
  if (!Array.isArray(eventContent)) {
    throw new ProjectionError("event content must be an array", "INVALID_EVENT_CONTENT");
  }
  // The adapter does not establish a universal renderer rule for
  // non-text assistant blocks. This local projection therefore has a deliberately
  // narrow proof boundary: text blocks are supported; any other block is rejected
  // rather than classified as hidden/unselectable or silently omitted.
  const texts = [];
  for (const block of eventContent) {
    if (!block || typeof block !== "object") {
      throw new ProjectionError("unsupported non-object content block", "UNSUPPORTED_CONTENT_BLOCK");
    }
    if (block.type !== "text") {
      throw new ProjectionError(`unsupported content block type ${String(block.type)}`, "UNSUPPORTED_CONTENT_BLOCK");
    }
    if (typeof block.text !== "string") throw new ProjectionError("text block missing text", "INVALID_EVENT_CONTENT");
    texts.push(block.text);
  }
  return texts.join("\n");
}

/** Number of Unicode code points. */
const cps = (s) => [...s].length;

/**
 * projection v2（markdown-aware）：每个 text block 经 projectVisibleMarkdown
 * 投影；block 间连接（前 block visible 尾无 \n 时补 1 个 "\n"）。
 * 返回 { text, sourceOffsets }。sourceOffsets 的数组下标是 accepted visible
 * projection 的码点坐标，值是对应 source-bearing text-content stream 中的
 * 码点偏移；renderer-only reasoning block 不进入该 stream。它不是 locator
 * 的第二套坐标，也不代表被排除的 reasoning 原始文本偏移。
 */
export function projectVisibleMarkdownContent(eventContent) {
  if (!Array.isArray(eventContent)) {
    throw new ProjectionError("event content must be an array", "INVALID_EVENT_CONTENT");
  }
  const visibleAll = [];
  const offsetAll = [];
  let globalBase = 0;
  for (const block of eventContent) {
    if (!block || typeof block !== "object") {
      throw new ProjectionError("unsupported non-object content block", "UNSUPPORTED_CONTENT_BLOCK");
    }
    // Runtime-bounded DSH rc.2 observation: reasoning is rendered in a separate
    // Think surface, not in the assistant text projection. Do not assign it text
    // offsets; selectionToProposal still requires DOM-basis prefix alignment, so
    // a selection in that surface fails closed. This is not a universal Adapter
    // claim. Other non-text blocks remain unclassified and reject.
    if (block.type === "reasoning") continue;
    if (block.type !== "text") {
      throw new ProjectionError(`unsupported content block type ${String(block.type)}`, "UNSUPPORTED_CONTENT_BLOCK");
    }
    if (typeof block.text !== "string") throw new ProjectionError("text block missing text", "INVALID_EVENT_CONTENT");
    const r = projectVisibleMarkdown(block.text);
    // 前 block visible 尾无 \n 且当前 block 非空 → 补 1 个 \n 分隔（看累积尾，非当前尾）
    if (visibleAll.length > 0 && r.visibleText.length > 0 && visibleAll[visibleAll.length - 1] !== "\n") {
      visibleAll.push("\n");
      offsetAll.push(globalBase + [...block.text].length);
    }
    // visibleText is a JS string, but sourceOffsets are code-point indexed.
    // Iterate the same code-point sequence used by the markdown projector;
    // string indexing would split astral characters into surrogate halves.
    const visibleChars = [...r.visibleText];
    for (let i = 0; i < visibleChars.length; i++) {
      visibleAll.push(visibleChars[i]);
      offsetAll.push(globalBase + r.sourceOffsets[i]);
    }
    globalBase += [...block.text].length + 1;
  }
  return { text: visibleAll.join(""), sourceOffsets: offsetAll };
}

/**
 * 构造 durable locator（plain-data）。
 * @param {object} input
 * @param {string} input.sessionId  — session-shaped identity
 * @param {Array<{eventSeq:number, start:number, end:number}>} input.segments
 * @param {number} [input.projectionVersion]
 * @param {*} [input.rendererHint]  — JSON-safe primitive/record only
 */
export function buildLocator({ sessionId, segments, projectionVersion = PROJECTION_VERSION, rendererHint }) {
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(projectionVersion)) {
    throw new ProjectionError(`unsupported projection version ${projectionVersion}`, "UNSUPPORTED_PROJECTION_VERSION");
  }
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new ProjectionError(`invalid sessionId shape "${sessionId}"`, "INVALID_LOCATOR");
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new ProjectionError("segments required (non-empty)", "INVALID_LOCATOR");
  }
  const out = { projectionVersion, sessionId, segments: [] };
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") throw new ProjectionError("invalid segment", "INVALID_LOCATOR");
    const eventSeq = assertNonNegInt(seg.eventSeq, "eventSeq");
    const start = assertNonNegInt(seg.start, "start");
    const end = assertNonNegInt(seg.end, "end");
    if (end <= start) throw new ProjectionError("extent [start,end) invalid (must be non-empty)", "INVALID_LOCATOR");
    out.segments.push({ eventSeq, start, end });
  }
  if (rendererHint !== undefined) {
    assertJsonSafe(rendererHint, "rendererHint");
    out.rendererHint = rendererHint;
  }
  return out;
}

/** 校验值为 JSON-safe（无 undefined 字段 / 函数 / 循环引用）。 */
function assertJsonSafe(value, name) {
  if (value === null || value === undefined) return;
  const t = typeof value;
  if (t === "string" || t === "boolean") return;
  if (t === "number") {
    if (Number.isFinite(value)) return;
    throw new ProjectionError(`${name} must be JSON-safe (finite number required)`, "INVALID_LOCATOR");
  }
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new ProjectionError(`${name} must be JSON-safe (no functions/symbols)`, "INVALID_LOCATOR");
  }
  if (t === "object") {
    // 必须是 plain data（plain object / plain array / JSON primitive），
    // 拒绝 DOM-like / class 实例 / 循环 / undefined 字段（R6 收紧）
    if (!isJsonPlain(value)) {
      throw new ProjectionError(`${name} must be JSON-safe plain data (no DOM/class instances, circular refs, or undefined fields)`, "INVALID_LOCATOR");
    }
    return;
  }
  throw new ProjectionError(`${name} must be JSON-safe`, "INVALID_LOCATOR");
}

/** 递归校验 JSON-plain data（plain object/array + JSON primitive；拒绝 undefined 字段 / 函数 / symbol / DOM 与 class 实例 / 循环引用）。 */
function isJsonPlain(v, seen = new Set()) {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v);
  if (t === "function" || t === "symbol" || t === "bigint" || t === "undefined") return false;
  if (t !== "object") return false;
  if (seen.has(v)) return false; // 循环引用
  seen.add(v);
  const proto = Object.getPrototypeOf(v);
  if (Array.isArray(v)) {
    if (proto !== Array.prototype) return false;
    for (const item of v) if (!isJsonPlain(item, seen)) return false;
    return true;
  }
  if (proto !== Object.prototype && proto !== null) return false; // DOM/class 实例
  for (const k of Object.keys(v)) {
    if (v[k] === undefined) return false;
    if (!isJsonPlain(v[k], seen)) return false;
  }
  return true;
}

/** Serialize locator（plain-data JSON，round-trip）。 */
export function serializeLocator(locator) {
  assertJsonSafe(locator, "locator");
  return JSON.stringify(locator);
}

/**
 * 校验一个对象是否符合当前 projection version 的 locator schema。
 * 供 Notes behavior source-payload 持久化前验证（R5）。
 * @returns {boolean}
 */
export function isValidLocator(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(obj.projectionVersion)) return false;
  if (typeof obj.sessionId !== "string" || !SESSION_ID_RE.test(obj.sessionId)) return false;
  if (!Array.isArray(obj.segments) || obj.segments.length === 0) return false;
  for (const seg of obj.segments) {
    if (!seg || typeof seg !== "object") return false;
    if (!Number.isSafeInteger(seg.eventSeq) || seg.eventSeq < 0) return false;
    if (!Number.isSafeInteger(seg.start) || seg.start < 0) return false;
    if (!Number.isSafeInteger(seg.end) || seg.end <= seg.start) return false;
  }
  return true;
}

/** Parse locator（严格：无效 → throw，不宽松重解释）。 */
export function parseLocator(json) {
  let obj;
  try { obj = JSON.parse(json); } catch { throw new ProjectionError("locator is not valid JSON", "INVALID_LOCATOR"); }
  if (!isValidLocator(obj)) {
    if (obj && typeof obj.projectionVersion === "number" && !SUPPORTED_PROJECTION_VERSIONS.includes(obj.projectionVersion)) {
      throw new ProjectionError(`unsupported projection version ${obj.projectionVersion}`, "UNSUPPORTED_PROJECTION_VERSION");
    }
    throw new ProjectionError("locator shape invalid", "INVALID_LOCATOR");
  }
  return buildLocator(obj);
}

/**
 * Strict locator-only reconstruction：绑定 locator.sessionId，只用 locator +
 * authoritative event source 精确 slice [start,end) 并按序拼接。
 * 不做任何 search / 文本匹配 / 模型推断。
 * @param {object} locator
 * @param {(sessionId:string, eventSeq:number) => Array<object>|undefined} eventSource
 * @returns {{ text: string, segments: Array<{eventSeq,start,end}> }}
 * @throws 任一 event 缺失 / extent 越界 → truthful failure
 */
export function resolveLocator(locator, eventSource) {
  if (!locator || typeof locator !== "object") throw new ProjectionError("locator required", "INVALID_LOCATOR");
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(locator.projectionVersion)) {
    throw new ProjectionError(`unsupported projection version ${locator.projectionVersion}`, "UNSUPPORTED_PROJECTION_VERSION");
  }
  if (typeof locator.sessionId !== "string" || !SESSION_ID_RE.test(locator.sessionId)) {
    throw new ProjectionError("invalid locator sessionId", "INVALID_LOCATOR");
  }
  if (!Array.isArray(locator.segments) || locator.segments.length === 0) throw new ProjectionError("locator segments required (non-empty)", "INVALID_LOCATOR");
  const parts = [];
  for (const seg of locator.segments) {
    if (!Number.isSafeInteger(seg.eventSeq) || seg.eventSeq < 0) throw new ProjectionError("invalid segment eventSeq", "INVALID_LOCATOR");
    if (!Number.isSafeInteger(seg.start) || seg.start < 0 || !Number.isSafeInteger(seg.end) || seg.end <= seg.start) throw new ProjectionError("invalid segment extent (non-negative and non-empty required)", "INVALID_LOCATOR");
    const content = eventSource(locator.sessionId, seg.eventSeq);
    if (!content) throw new ProjectionError(`event ${seg.eventSeq} not found in session ${locator.sessionId}`, "EVENT_NOT_FOUND");
    const projected = projectVisibleText(content, locator.projectionVersion);
    const len = cps(projected);
    if (seg.end > len) throw new ProjectionError(`extent [${seg.start},${seg.end}) exceeds projection length ${len}`, "EXTENT_INVALID");
    parts.push([...projected].slice(seg.start, seg.end).join(""));
  }
  return { text: parts.join(""), segments: locator.segments };
}

/**
 * Capture-time consistency check。
 * @returns {boolean}
 */
export function locatorSlicesMatch(locator, eventSource, selectedVisibleText) {
  try {
    const resolved = resolveLocator(locator, eventSource);
    return resolved.text === selectedVisibleText;
  } catch {
    return false;
  }
}

/**
 * 单 event 内 anchor/focus 偏移归一为 ordered [start,end)。
 * 严格整数校验；跨 event 输入（带 anchorIndex/focusIndex）→ 明确拒绝
 * （跨 event ordered segments 由 selection-bridge 的 selectionToSegments 生成）。
 */
export function normalizeSelectionExtent(sel) {
  if (sel === null || typeof sel !== "object") throw new ProjectionError("selection required", "INVALID_SELECTION");
  if (sel.anchorIndex !== undefined || sel.focusIndex !== undefined) {
    throw new ProjectionError("cross-event normalization not supported here; use selectionToSegments", "CROSS_EVENT_UNSUPPORTED");
  }
  const { anchorOffset, focusOffset } = sel;
  if (!Number.isSafeInteger(anchorOffset) || !Number.isSafeInteger(focusOffset)) {
    throw new ProjectionError("anchor/focus offsets must be non-negative safe integers", "INVALID_SELECTION");
  }
  if (anchorOffset < 0 || focusOffset < 0) throw new ProjectionError("offsets must be non-negative", "INVALID_SELECTION");
  const start = Math.min(anchorOffset, focusOffset);
  const end = Math.max(anchorOffset, focusOffset);
  return { start, end };
}
