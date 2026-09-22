// dsh-collab-notes client half.
//
// Interaction: 📝 button in the conversation header utilities slot → a fixed
// right-side panel with layer tabs → textarea → Save
// (PUT /notes-api/<sessionId>/<layerKey>).
//
// Storage/API/display decoupled (0003 structure upgrade v1): the client never
// hardcodes the layer list as identity. It fetches the resolved mapping from
// /notes-api/meta ({ layers: [{ key, displayId, label, policy, target,
// action }] }) and renders tabs from it; all API calls use the semantic
// layer KEY (conversation_todo, deferred_work, ...). A fallback table keeps
// the panel usable offline (identical to the server defaults).
//
// Concurrency (optimistic, conflict-visible):
//   - Save sends If-Match (the baseline mtime from GET's X-Notes-Mtime);
//     if the file changed since load (agent append / another panel), the
//     server answers 409 + latest content → panel offers three choices:
//     load latest (discard local) / overwrite anyway (retry with new
//     baseline) / cancel (keep editing).
//   - dirty tracking: a late load response never overwrites what the user
//     typed; switching tabs / closing / refreshing with unsaved edits asks
//     for confirmation.
//   - Save results are bound to a request sequence so a stale PUT response
//     cannot touch the new tab's state; the footer shows last-modified time.
//
// Bundle contract: react and @deepseek-ai/* are runtime externals; DSH Web
// loads client bundles as classic scripts, so this file must keep its own
// top-level scope (IIFE).

// Capture facade（captureBrowserSelection / validateCandidate /
// saveAnchoredCapture / appendCaptureBlock）：**静态 import → tsdown 单 entry
// 内联进 client.js**。DSH Web 只伺服单一 plugin client bundle，因此
// capture facade 不使用第二个运行时 bundle。经典
// script 虽不能带静态 import 语句，但构建期内联后产物无任何 import，loader
// 照常执行；capture 逻辑与 host 共用同一 lib 源码（无 dual truth）。
import {
  captureBrowserSelection,
  validateCandidate,
  saveAnchoredCapture,
  appendCaptureBlock,
} from "../lib/capture-facade.js";
import {
  BEGIN_LINE,
  getItemKey,
  hasSubstantiveAuthoredContent,
  makeItem,
  newItemKey,
  parseLaneBody,
  serializeItem,
  withItemKey,
} from "../lib/structured-item.js";
import { chooseNotesDirectory } from "../lib/notes-picker.js";
import { LOCALE_NS, en, zh } from "./locales.js";
import { notesFetch } from "../lib/notes-transport.js";

(() => {

// Offline fallback (mirrors the server defaults; meta replaces it when loaded).
const FALLBACK_LAYERS = [
  { key: "conversation_todo", displayId: "L1", label: "L1 会话待办", policy: "active" },
  { key: "deferred_work", displayId: "L2", label: "L2 延后工作", policy: "releasable" },
  { key: "knowledge_candidate", displayId: "L3", label: "L3 知识候选", policy: "releasable" },
  { key: "lesson_candidate", displayId: "L4", label: "L4 复盘素材", policy: "releasable" },
];
const FALLBACK_LAYER_LOCALE_KEYS = {
  conversation_todo: "lane.conversationTodo",
  deferred_work: "lane.deferredWork",
  knowledge_candidate: "lane.knowledgeCandidate",
  lesson_candidate: "lane.lessonCandidate",
};
const PROFILE_SETTINGS_NAMESPACE = "dsh-collab-notes";
const LANE_KEYS = [
  "conversation_todo",
  "deferred_work",
  "knowledge_candidate",
  "lesson_candidate",
];
const PROFILE_LABEL_SUGGESTIONS = {
  zh: {
    conversation_todo: "会话待办",
    deferred_work: "延后工作",
    knowledge_candidate: "知识候选",
    lesson_candidate: "复盘素材",
  },
  en: {
    conversation_todo: "Conversation To-do",
    deferred_work: "Deferred Work",
    knowledge_candidate: "Knowledge Candidate",
    lesson_candidate: "Lesson Candidate",
  },
};

function activeLocaleOf(clientCtx) {
  return clientCtx.locale?.getLocale?.().active === "zh" ? "zh" : "en";
}

function profileLabelsFromSnapshot(snapshot, locale) {
  const configured = snapshot?.value?.layerOverrides;
  return Object.fromEntries(LANE_KEYS.map((key) => {
    const label = configured?.[key]?.label;
    return [key, typeof label === "string" && label.trim() !== ""
      ? label
      : PROFILE_LABEL_SUGGESTIONS[locale][key]];
  }));
}

function hasEstablishedProfileVocabulary(snapshot) {
  const configured = snapshot?.value?.layerOverrides;
  return LANE_KEYS.every((key) => {
    const label = configured?.[key]?.label;
    return typeof label === "string" && label.trim() !== "";
  });
}

// ---- Merge-wrapper marker 判定（与 carry-merge.js 同源语义）----
// 只有两侧 marker（"## 来自父分支" 与 "## 当前分支已有内容"）**同时**存在时，该 lane body
// 才是 occupied 双侧 fork/carry eligibility decision merge-wrapper lane（composeCarryMerge 在 parent/child 两侧都非空
// 时才同时写入两侧标题；仅单侧 marker 的 lane 是普通 lane）。普通列表与 Search **必须共用
// 同一判定**——Search 若用 OR 会把单 marker 的普通 lane 误判为 merge-wrapper，导致 viewDir
// 失效、Pin 分区关闭。
function isMergeWrapperBody(body) {
  const raw = String(body ?? "");
  return raw.includes("## 来自父分支") && raw.includes("## 当前分支已有内容");
}

// ---- holder-local Pin preference（browser-local only）----
// Pin state 是 human visual-attention / findability preference。存 browser
// localStorage，scope = same browser/profile +
// same conversation holder + lane；**绝不写进 lane body / Note content**（E6：Pin 不
// 进入 agent-facing Notes semantics）。keyed by (sessionId, laneKey, itemKey)。
const PIN_STORE_KEY = "dsh.collab-notes.pins.v1";
const PIN_STORE_VERSION = 1;

/** 获取可用的 localStorage（缺失/不可用 → null）。 */
function pinStorage() {
  try {
    const ls = window.localStorage;
    if (!ls || typeof ls.getItem !== "function" || typeof ls.setItem !== "function") return null;
    return ls;
  } catch (e) {
    return null; // 访问 localStorage 本身被拒（隐私模式/安全策略）
  }
}

/** 读当前 holder+lane 的 pin map（itemKey -> true）。任何异常/缺失 → 空 map（不 crash）。 */
function readPinMap(sessionId, laneKey) {
  try {
    const ls = pinStorage();
    if (!ls) return new Set();
    const raw = ls.getItem(PIN_STORE_KEY);
    if (!raw) return new Set();
    const root = JSON.parse(raw);
    const holder = root?.[PIN_STORE_VERSION]?.[sessionId]?.[laneKey];
    if (!holder || typeof holder !== "object") return new Set();
    return new Set(Object.keys(holder).filter((k) => holder[k] === true));
  } catch (e) {
    return new Set();
  }
}

/** 写 pin map。返回 true = 成功；false = 本地存储不可用/失败（调用方必须 truthful 处理，
 *  绝不把“写入被跳过”误报为成功）。 */
function writePinMap(sessionId, laneKey, keys) {
  const ls = pinStorage();
  if (!ls) return false; // 关键修正：storage 缺失时 optional chaining 曾跳过写入却返回 true
  try {
    const root = JSON.parse(ls.getItem(PIN_STORE_KEY) || "{}");
    const versioned = root[PIN_STORE_VERSION] ?? (root[PIN_STORE_VERSION] = {});
    const holder = versioned[sessionId] ?? (versioned[sessionId] = {});
    const laneMap = {};
    for (const k of keys) laneMap[k] = true;
    holder[laneKey] = laneMap;
    ls.setItem(PIN_STORE_KEY, JSON.stringify(root));
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Notes behavior: current-holder keyword search（pure helpers）----
// 搜索对象 = 一条 Note 的 user-visible material：authored comment + persisted Source
// snapshot（若存在）。source-independent / anchored / comment-free anchored 都能命中。
// **绝不**在 raw serialized bytes 或 machine metadata（item-key/captureOrigin/locator/
// eventSeq/framing/metaOrder）上做匹配——helper 只读 parse 出来的 comment/snapshot 字段，
// 结构性排除 machine data（E3/F/G/H）。
/** 归一化搜索词/文本：trim + lowercase（literal substring 匹配，可预期/可逆/可测）。 */
function normalizeSearchText(s) {
  return String(s ?? "").toLowerCase();
}

/**
 * 判断一条 parsed node（whole-Note unit）是否命中 query。
 * @param {object} node  parseLaneBody 产物节点（{type:'item',item} 或 legacy）
 * @param {string} q     归一化后的 query
 * @returns {boolean}
 * legacy：opaque unit 作为整体可搜其 text（E5：不拆分 legacy 找“里面某条”）。
 */
function noteMatchesQuery(node, q) {
  if (!node || !q) return false;
  if (node.type === "legacy") {
    return normalizeSearchText(node.text).includes(q);
  }
  const item = node.item || {};
  const haystack = [item.comment, item.snapshot];
  return haystack.some((v) => normalizeSearchText(v).includes(q));
}


// Notes behavior re-entry renderer helpers（browser 面；identity-first，不做 search）：
//   - 用 host 返回的 per-segment hint（user messageId / assistant turn:step）定位
//     data-chat-anchor-key 元素（durable renderer identity）；
//   - 校验元素正文 basis 以权威投影文本开头（DSH rc.2 的 data-variant="think"
//     reasoning surface 从 basis 排除；其它 renderer 内容仍须 prefix 对齐），再把
//     code-point [start,end) 映射为 DOM Range（Range 偏移是 UTF-16 单位，需 code
//     point → UTF-16 换算）；
//   - 临时高亮 exact extent；任何一步失败 → highlighted:false（不声称 highlight；
//     exact 文本读取不受影响）。
/** 扫描对象中第一个 DOM 节点（nodeType）的属性路径（诊断用，只读不 mutate）。 */
function domPathOf(root, prefix) {
  const walk = (v, path, depth) => {
    if (depth > 8 || v === null || v === undefined) return null;
    if (typeof v === "object") {
      if (v.nodeType) return path || "(root)";
      for (const k of Object.keys(v)) {
        const r = walk(v[k], path ? path + "." + k : k, depth + 1);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(root, prefix || "", 0);
}

function cpIndexToUtf16(data, cpLen) {
  return [...data].slice(0, cpLen).join("").length;
}

/** 精确 renderer identity 定位（不许部分匹配取第一个）：返回恰好 1 个候选才可用，
 *  否则（无/多个）→ 空（不 claim highlight）。 */
function anchorElementsFor(hint) {
  const all = [...document.querySelectorAll("[data-chat-anchor-key]")];
  let matched = [];
  if (hint && hint.messageId) {
    matched = all.filter((el) => {
      const k = el.getAttribute("data-chat-anchor-key") || "";
      const i = k.indexOf("input-message");
      return i >= 0 && k.slice(i + "input-message".length) === hint.messageId;
    });
  } else if (hint && hint.turn !== undefined && hint.step !== undefined) {
    matched = all.filter((el) => {
      const k = el.getAttribute("data-chat-anchor-key") || "";
      const m = /assistant-step(\d+):(\d+)/.exec(k);
      return !!m && Number(m[1]) === hint.turn && Number(m[2]) === hint.step;
    });
  }
  return matched.length === 1 ? matched : [];
}

/**
 * 确定性 DOM/projection 映射：以权威投影为锚，按**位置**（code-point 累积）映射
 * [cpStart, cpEnd)，不用 seg.text 在 DOM 中 search/indexOf/first-match。
 * 前提：过滤 rc.2 Think surface 后，元素正文 basis 以权威投影为前缀
 * （其它 renderer 附加物只能在投影之后）；
 * 前缀不一致/越界/跨节点失败 → null（truthful downgrade）。
 */
function rangeAtProjectionOffsets(el, projection, cpStart, cpEnd) {
  // DSH rc.2 runtime seam: reasoning is rendered as a separate Think surface
  // marked by data-variant="think". Keep re-entry coordinates consistent with
  // capture's observed renderer shape; this is not a universal non-text rule.
  const reasoningSurfaces = [...el.querySelectorAll('[data-variant="think"]')]
    .filter((surface) => surface.closest("[data-chat-anchor-key]") === el);
  const isReasoningNode = (node) => reasoningSurfaces.some((surface) => surface.contains(node));
  const indexed = [];
  const appendSubtree = (parent) => {
    let previousWasListItem = false;
    for (const child of parent.childNodes || []) {
      if (isReasoningNode(child)) continue;
      const isElement = child.nodeType === 1;
      const isListItem = isElement && child.tagName === "LI";
      // Markdown v2 has a newline between adjacent list items, but the DOM
      // has no text node for it. Keep it as a virtual coordinate only.
      if (previousWasListItem && isListItem) indexed.push({ virtual: true, length: 1 });
      if (child.nodeType === 3) indexed.push({ node: child, length: [...child.data].length });
      else if (isElement) appendSubtree(child);
      previousWasListItem = isListItem;
    }
  };
  appendSubtree(el);
  const basisCps = indexed.flatMap((part) => part.virtual ? ["\n"] : [...part.node.data]);
  if (cpEnd > basisCps.length) return null;
  if (basisCps.slice(0, cpEnd).join("") !== [...projection].slice(0, cpEnd).join("")) return null;
  const boundary = (cp, isStart) => {
    let acc = 0;
    for (let i = 0; i < indexed.length; i++) {
      const part = indexed[i];
      const next = acc + part.length;
      if (cp < next || (cp === next && isStart)) {
        if (part.virtual) {
          const following = indexed.slice(i + 1).find((candidate) => !candidate.virtual);
          return following ? { node: following.node, offset: 0 } : null;
        }
        return { node: part.node, offset: cpIndexToUtf16(part.node.data, cp - acc) };
      }
      if (cp === next && !isStart) {
        if (part.virtual) {
          const following = indexed.slice(i + 1).find((candidate) => !candidate.virtual);
          return following ? { node: following.node, offset: 0 } : null;
        }
        return { node: part.node, offset: cpIndexToUtf16(part.node.data, part.length) };
      }
      acc = next;
    }
    return null;
  };
  const start = boundary(cpStart, true);
  const end = boundary(cpEnd, false);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/**
 * 高亮 exact locus 的**所有** perSegment（确定性映射）。
 * @returns {{ highlighted: boolean, partial: boolean, wholeMessage: boolean,
 *             highlightedCount: number, wholeMessageCount: number, total: number,
 *             detail: string }}
 */
// Re-entry highlight 是 transient navigation feedback——成功后
// 数秒自然消失（非 durable selection/provenance/state）。生命周期用 module 级
// generation + timer 管理：
//   - hlEpochRef：每代高亮递增；新 re-entry 开始（locateAndHighlight）先清旧 mark
//     并推进 epoch → 旧 timer 到期时发现 epoch 已变 → 不清新 highlight（防 race）。
//   - 每次成功 highligh 后 schedule 一个 ~8s 的自动清理；removeDshMarks 会先取消
//     未到期 timer（幂等：手动清理/新 re-entry 都安全）。
let hlEpochRef = 0;
let hlClearTimer = null;
const defaultHighlightClearMs = 8000;
function highlightClearMs() {
  return typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS)
    ? window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS
    : defaultHighlightClearMs;
}
function cancelHighlightTimer() {
  if (hlClearTimer !== null) { clearTimeout(hlClearTimer); hlClearTimer = null; }
}
function removeDshMarks() {
  // 还原式清理：marks 只包裹原有 text nodes，逐个把 child nodes 放回原父节点。
  // 不以 textContent 重建节点，避免破坏 renderer 的 inline DOM/formatting。
  // splitText 会暂时改变 renderer-owned text-node topology；每个 mark 带有
  // ephemeral（不持久化、不对 renderer 暴露）restore record，清理时在 DOM
  // 仍是我们预期形态且文本未被外部改动时恢复原 node identity/topology。
  cancelHighlightTimer();
  const records = [];
  document.querySelectorAll("mark[data-dsh-reentry]").forEach((m) => {
    try {
      if (Array.isArray(m.__dshRestoreRecords)) records.push(...m.__dshRestoreRecords);
      if (m.parentNode) {
        while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
      }
    } catch { /* 还原尽力而为 */ }
    m.remove();
  });
  clearWholeMessageCues();
  const restored = new Set();
  for (const record of records) {
    if (!record || restored.has(record.originalNode)) continue;
    restored.add(record.originalNode);
    const { originalNode, originalData, parent, parts } = record;
    if (!originalNode || originalNode.nodeType !== 3 || !parent || !Array.isArray(parts) || parts.length === 0) continue;
    if (!parts.every((part) => part && part.nodeType === 3 && part.parentNode === parent)) continue;
    if (!parts.includes(originalNode)) continue;
    // A renderer mutation must not be overwritten by cleanup. Also require the
    // split pieces to remain adjacent before coalescing them.
    if (parts.some((part, i) => i > 0 && parts[i - 1].nextSibling !== part)) continue;
    if (parts.map((part) => part.data).join("") !== originalData) continue;
    const first = parts[0];
    if (originalNode !== first) parent.insertBefore(originalNode, first);
    originalNode.data = originalData;
    for (const part of parts) {
      if (part !== originalNode && part.parentNode === parent) part.remove();
    }
  }
}

// Matrix 52 row 11 minimum cue: when the source message is uniquely
// identified and renderable but an exact Range cannot be constructed, use a
// transient message-level outline. This is explicitly broader/non-exact
// feedback; it does not wrap or rewrite renderer-owned children.
const wholeMessageCueRecords = [];
function applyWholeMessageCue(el) {
  if (!el?.style) return false;
  if (wholeMessageCueRecords.some((r) => r.el === el)) return true;
  const original = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
  el.style.outline = "2px solid #d97706";
  el.style.outlineOffset = "2px";
  // Store the browser-normalized values; cleanup must compare what the
  // renderer actually sees, not the spelling used by the assignment above.
  const applied = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
  wholeMessageCueRecords.push({ el, original, applied });
  return true;
}
function clearWholeMessageCues() {
  for (const record of wholeMessageCueRecords.splice(0)) {
    const { el, original, applied } = record;
    if (!el?.style) continue;
    // Do not overwrite renderer changes made while the transient cue was
    // active. Restore only properties whose current value is still ours.
    if (el.style.outline === applied.outline) el.style.outline = original.outline;
    if (el.style.outlineOffset === applied.outlineOffset) el.style.outlineOffset = original.outlineOffset;
  }
}
function wrapRangeTextNodes(range) {
  // Narrow reversible cue: split/wrap only the text nodes intersecting the range.
  // In particular, do not call Range.deleteContents()/insertNode(), which can
  // flatten or move renderer-owned inline elements across a multi-node range.
  const start = range.startContainer;
  const end = range.endContainer;
  if (start?.nodeType !== 3 || end?.nodeType !== 3) return [];
  const root = range.commonAncestorContainer?.nodeType === 3
    ? range.commonAncestorContainer.parentElement
    : range.commonAncestorContainer;
  if (!root || typeof document.createTreeWalker !== "function") return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const startIndex = nodes.indexOf(start);
  const endIndex = nodes.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return [];
  const marks = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const textNode = nodes[i];
    const from = i === startIndex ? range.startOffset : 0;
    const to = i === endIndex ? range.endOffset : textNode.data.length;
    if (to <= from) continue;
    const originalData = textNode.data;
    const originalParent = textNode.parentNode;
    let selected = textNode;
    if (to < textNode.data.length) textNode.splitText(to);
    if (from > 0) selected = textNode.splitText(from);
    if (!selected.parentNode || !originalParent) continue;
    const expectedParts = 1 + (from > 0 ? 1 : 0) + (to < originalData.length ? 1 : 0);
    const parts = [];
    let part = textNode;
    while (part && parts.length < expectedParts) {
      parts.push(part);
      part = part.nextSibling;
    }
    if (parts.length !== expectedParts) continue;
    const mark = document.createElement("mark");
    mark.setAttribute("data-dsh-reentry", "1");
    mark.style.background = "#fde68a";
    mark.style.borderRadius = "2px";
    // Exact span uses background only; the broader message-level outline is
    // reserved for the explicit non-exact Row 11 fallback below.
    mark.__dshRestoreRecords = [{ originalNode: textNode, originalData, parent: originalParent, parts }];
    selected.parentNode.insertBefore(mark, selected);
    mark.appendChild(selected);
    marks.push(mark);
  }
  return marks;
}
function locateAndHighlight(exact) {
  // 单活动高亮：每次回来源先还原清理上一次的 dsh mark（避免多次 ↪ 累积；
  // 误加副作用，非原始设计——编辑行为保持局部）。
  try { removeDshMarks(); } catch { /* 清理尽力而为 */ }
  const gen = ++hlEpochRef;
  const projBySeq = {};
  for (const ev of exact?.events || []) projBySeq[ev.eventSeq] = ev.projection;
  const segments = exact?.perSegment || [];
  const jobs = [];
  const wholeMessageEls = [];
  for (const seg of segments) {
    const els = anchorElementsFor(seg.hint || {});
    // New durable Sources identify the exact message but intentionally carry
    // no durable character offsets.  A message-level outline is the truthful
    // attention cue; it must never be presented as an exact span.
    if (seg.exactSpan === false) {
      if (els.length > 0) wholeMessageEls.push(els[0]);
      continue;
    }
    const projection = projBySeq[seg.eventSeq];
    if (els.length === 0) continue;
    if (!projection) {
      wholeMessageEls.push(els[0]);
      continue;
    }
    const range = rangeAtProjectionOffsets(els[0], projection, seg.start, seg.end);
    if (!range) {
      wholeMessageEls.push(els[0]);
      continue;
    }
    jobs.push({ el: els[0], range, seg });
  }
  const total = segments.length;
  const marked = [];
  // 反向 apply：同一元素多处 segment 时先插后面的，避免偏移漂移
  for (let i = jobs.length - 1; i >= 0; i--) {
    const { range } = jobs[i];
    try {
      if (wrapRangeTextNodes(range).length > 0) marked.push(jobs[i].seg);
      else wholeMessageEls.push(jobs[i].el);
    } catch {
      // The source message is still known even if renderer operations throw;
      // preserve Row 11's broader/non-exact cue instead of silently reducing
      // this case to genuine no-cue.
      wholeMessageEls.push(jobs[i].el);
    }
  }
  const wholeMessageCount = [...new Set(wholeMessageEls)].filter(applyWholeMessageCue).length;
  // 导航 = scrollIntoView；exact span uses marks, while Row 11 fallback uses
  // a reversible message-level outline explicitly reported as broader/non-exact.
  // A message-wide outline is never presented as an exact selection。
  // 高亮；exact <mark> span 本身仍只表达 exact span。当前容器级 outline 仅用于
  // Row 11 的明确 broader/non-exact fallback，不冒充 exact extent。
  const seenEls = new Set();
  for (const { el } of [...jobs, ...wholeMessageEls.map((el) => ({ el }))]) {
    if (seenEls.has(el)) continue;
    seenEls.add(el);
    el.scrollIntoView({ block: "center" });
  }
  const count = marked.length;
  // Transient highlight：成功后自然消失；timer 带
  // generation 校验，旧代 timer 绝不清新 highlight（防 rapid repeat race）。
  if (count > 0 || wholeMessageCount > 0) {
    cancelHighlightTimer();
    hlClearTimer = setTimeout(() => {
      hlClearTimer = null;
      if (gen === hlEpochRef) {
        try { removeDshMarks(); } catch { /* 清理尽力而为 */ }
      }
    }, highlightClearMs());
  }
  return {
    highlighted: count > 0 && count === total,
    partial: count > 0 && count < total,
    wholeMessage: wholeMessageCount > 0,
    highlightedCount: count,
    wholeMessageCount,
    total,
    detail: `${count}/${total} segments highlighted`,
  };
}

// Row 9 serialization mismatch fallback: the authoritative source/event and
// locator remain known, but current projection text is not equal to historical
// S.  Apply the existing whole-message cue directly from authoritative render
// hints.  Never pass the degraded payload through locateAndHighlight(), since
// doing so could wrap a current range and make it look exact.
function locateAndApplyWholeMessageCue(cue) {
  try { removeDshMarks(); } catch { /* 清理尽力而为 */ }
  const gen = ++hlEpochRef;
  const els = [];
  for (const seg of cue?.perSegment || []) {
    const matches = anchorElementsFor(seg.hint || {});
    if (matches.length > 0) els.push(matches[0]);
  }
  const uniqueEls = [...new Set(els)];
  const wholeMessageCount = uniqueEls.filter(applyWholeMessageCue).length;
  for (const el of uniqueEls) el.scrollIntoView({ block: "center" });
  if (wholeMessageCount > 0) {
    cancelHighlightTimer();
    hlClearTimer = setTimeout(() => {
      hlClearTimer = null;
      if (gen === hlEpochRef) {
        try { removeDshMarks(); } catch { /* 清理尽力而为 */ }
      }
    }, highlightClearMs());
  }
  return {
    highlighted: false,
    partial: false,
    wholeMessage: wholeMessageCount > 0,
    highlightedCount: 0,
    wholeMessageCount,
    total: (cue?.perSegment || []).length,
    detail: `0/${(cue?.perSegment || []).length} segments exact-highlighted; ${wholeMessageCount} whole-message cue(s)`,
  };
}

/**
 * Notes behavior delete tidy（纯文本规整，不触碰文件其它部分）：把第 nodeIndex 条 item 的
 * block 从 lane body 移除后，只压缩该 block **紧邻**的多余空白分隔：
 *   1) 跨越删除点、长度 >= 3 的连续 "\n"（删除残留的双空行）折成恰好 2 个；
 *   2) 被删 block 位于文件开头（prefix 空）→ 去掉其遗留的前导空行；
 *   3) 被删 block 位于文件结尾（suffix 空或纯换行）→ 去掉其遗留的尾部空行
 *      （最多 2 个 "\n" = 恰好一行空行分隔）。
 * Notes 文件是精确文本状态——本函数只裁剪删除点相邻的空白，绝不改其它字节。
 */
function tidyAfterBlockRemoval(text, span) {
  const prefix = text.slice(0, span.start);
  const suffix = text.slice(span.end);
  let body = prefix + suffix;
  const p = prefix.length; // junction
  let i = p;
  while (i > 0 && body[i - 1] === "\n") i--;
  let j = p;
  while (j < body.length && body[j] === "\n") j++;
  if (j - i >= 3) body = body.slice(0, i) + "\n\n" + body.slice(j);
  if (prefix === "") {
    // 被删 block 之前无内容：任何前导空行都是与“不存在的前节点”之间的分隔残留
    body = body.replace(/^\n+/, "");
  } else if (suffix === "" || /^\n+$/.test(suffix)) {
    body = body.replace(/\n{1,2}$/, "");
  }
  return body;
}

function NotesController(React, clientCtx = {}) {
  const { createElement, useCallback, useEffect, useMemo, useRef, useState } = React;
  // The real slot renderer supplies the host-backed `t` seat. The zh fallback
  // exists only for the standalone client harnesses that mount this component
  // without the DSH locale plugin; it is not a second locale-selection path.
  const fallbackT = (key, params) => {
    const template = zh[key] ?? en[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
  };
  const hostT = clientCtx.locale?.bind?.(LOCALE_NS);
  const t = hostT || fallbackT;

  function NotesPanel({ sessionId, onClose, t: panelT = t }) {
    const profileSettings = useMemo(() => {
      try {
        return clientCtx.settingsScope?.bind?.({ namespace: PROFILE_SETTINGS_NAMESPACE }) ?? null;
      } catch {
        return null;
      }
    }, []);
    const initialProfileLocale = useMemo(() => activeLocaleOf(clientCtx), []);
    const [profileSettingsSnapshot, setProfileSettingsSnapshot] = useState(() =>
      profileSettings?.getSnapshot?.() ?? null
    );
    const profileLabelsInitializedRef = useRef(false);
    const [profileLabels, setProfileLabels] = useState({});
    const [profileLabelsBusy, setProfileLabelsBusy] = useState(false);
    const [layers, setLayers] = useState(() => FALLBACK_LAYERS.map((layer) => ({
      ...layer,
      label: panelT(FALLBACK_LAYER_LOCALE_KEYS[layer.key] || layer.label),
    }))); // resolved mapping from meta
    const [layerKey, setLayerKey] = useState(FALLBACK_LAYERS[0].key);
    // Synchronous mirror of the ACTIVE lane. Async callbacks (post-apply
    // refresh, saves, loads) read layerKeyRef.current to decide whether a
    // late response still belongs to the lane the user is currently viewing —
    // React state in an async closure is frozen at request time, so a plain
    // `layerKey` comparison would always pass and let a stale GET setText
    // into the wrong lane.
    const layerKeyRef = useRef(layerKey);
    layerKeyRef.current = layerKey;
    // Notes behavior: session 实时镜像（保存成功后的 setText 需防“保存中途切换 session”把旧
    // session 内容写进新 session 的编辑器——与 layerKeyRef 同一 guard 模式）。
    const sessionIdRef = useRef(sessionId);
    sessionIdRef.current = sessionId;
    const [text, setText] = useState("");
    const [status, setStatus] = useState("");
    // Workspace setup state is host-authoritative.  null means the endpoint is
    // unavailable in an older node-only harness, so existing regression
    // fixtures retain their prior behavior; an explicit state from rc.2 gates
    // all Notes reads/writes until the user configures the workspace.
    const [setup, setSetup] = useState(null);
    const [setupBusy, setSetupBusy] = useState(false);
    const [setupError, setSetupError] = useState(null);
    const [picker, setPicker] = useState(null);
    const pickerAbortRef = useRef(null);
    const pickerRequestRef = useRef(0);
    // First-use save continuation is ordinary component-local intent only;
    // it is never sent to the Agent or persisted as a pending-write record.
    const setupContinuationRef = useRef(null);
    const saveRef = useRef(null);
    const saveComposerRef = useRef(null);
    // Setup gate is rendered before the main panel style declarations below;
    // keep these small independent styles above the gate to avoid a temporal
    // dead-zone during the first UNINITIALIZED render.
    const setupPrimaryStyle = { fontSize: "12px", padding: "5px 10px", cursor: "pointer", background: "#2563eb", border: "1px solid #2563eb", borderRadius: "5px", color: "#fff" };
    const setupButtonStyle = { fontSize: "12px", padding: "5px 10px", cursor: "pointer", background: "#fff", border: "1px solid #d1d5db", borderRadius: "5px", color: "#374151" };
    const [mtime, setMtime] = useState("0");        // baseline mtime of loaded version
    const [dirty, setDirty] = useState(false);      // unsaved edits
    const [conflict, setConflict] = useState(null); // { latest, latestMtime } (409 pending)
    // fork/carry eligibility decision: post-fork carry-over pending state (unresolved / none / carried)
    const [carryOver, setCarryOver] = useState(null); // null | { parentSessionId, status, carriedLanes }
    const [carryBusy, setCarryBusy] = useState(false);
    const [carryPicking, setCarryPicking] = useState(false); // lane picker open (choice=some)
    const [carrySelected, setCarrySelected] = useState([]);  // lanes chosen for some
    // fork/carry eligibility decision conflict resolution: after preflight surfaced occupied lanes.
    const [carryConflict, setCarryConflict] = useState(null); // null | { choice, lanes, conflicts, observations }
    const [carryResolutions, setCarryResolutions] = useState({}); // lane -> "merge" | "keep" | "replace"
    // fork/carry eligibility decision post-apply: per-lane carry-over RESULT banner (top position; survives
    // lane switches / in-panel refresh; dismissed only by 知道了).
    const [carryResult, setCarryResult] = useState(null); // null | { laneLines: [{lane, label, text}], applied: string[] }
    // Notes behavior: anchored capture flow（host-validated proposal + unresolved disclosure +
    // explicit Save）。capture: null | { stage, validated, effective, unresolved, error }
    const [capture, setCapture] = useState(null);
    const [captureComment, setCaptureComment] = useState("");
    const [captureBusy, setCaptureBusy] = useState(false);
    // Notes behavior: re-entry 结果展示（transient）。reentry: null | { busy, kind, code?,
    //   text?, highlighted?, context? }
    const [reentry, setReentry] = useState(null);
    const saveSeq = useRef(0);
    // Note-primary 便签视图状态。默认 rawView=false（便签视图：
    // composer + 已保存 Note 列表）；rawView=true = 原文编辑（高级）区（旧的全层
    // textarea 编辑器原样保留）。composerText 是 composer/编辑模式 textarea；
    // editingIndex 指向 parseLaneBody(text).nodes 的下标（非 null = 编辑该条 item）；
    // editingSigRef 记录编辑起点的 block 指纹（serializeItem 结果——parse 的 raw
    // 不含 payload 行，不能作为字节定位锚；指纹防外部刷新后节点漂移错位）；
    // collapsedSource 只存卡片“来源”折叠的视图状态（不写存储）。
    const [rawView, setRawView] = useState(false);
    // 轻量 ? 帮助（纯视图状态；开关不触碰 Notes 状态/写路径）。
    const [helpOpen, setHelpOpen] = useState(false);
    const [composerText, setComposerText] = useState("");
    const [composerBusy, setComposerBusy] = useState(false);
    const [editingIndex, setEditingIndex] = useState(null);
    const editingSigRef = useRef(null);
    const [collapsedSource, setCollapsedSource] = useState({});
    // Notes 列表查看顺序——'newest' = 新记录在前
    // （默认）/ 'oldest' = 旧记录在前。纯展示层 preference：非持久化、不进存储、不改
    // lane body。NotesPanel 每次 remount 恢复默认 'newest'（panel 关闭重开即 remount，
    // 天然满足）；lane 切换不清除（当前选择跨 lane 保留）。
    const [viewDir, setViewDir] = useState("newest");
    // 卡片内联删除确认——confirmingDelete 指向正在询问“删除这条便签？”
    // 的 parsedBody 节点下标（null = 无进行中的删除确认）。替代旧的 window.confirm：
    // 确认/取消都发生在卡片内，不引入任何新删除语义（仍整条移除 + tidy + whole-lane
    // PUT If-Match；无 source-only delete / recapture / replacement / detach）。
    const [confirmingDelete, setConfirmingDelete] = useState(null);
    // Notes behavior note-primary: 自动附源失败（有选区但不可精确引用）时 composer 下方的浅
    // 提示（只提示、不弹错误框、不阻塞纯便签保存）。
    const [attachHint, setAttachHint] = useState(null);
    // Notes behavior: holder-local Pin（持久 human visual-attention / findability preference）。
    // 语义：Pin ≠ priority/urgency/L1/obligation/execution/formalization；不改 capture
    // chronology / provenance / Source Anchor / downstream。范围 = same browser/profile
    // + same conversation holder + lane；不跨 device/browser/account 同步（current implementation
    // Pin map 存 browser localStorage（NS
    // 'dsh.collab-notes.pins.v1'），keyed by (sessionId, laneKey, itemKey)——**绝不写进
    // lane body / Note content / agent-facing 数据**（E6 边界）。itemKey 是 structured
    // block 内的 opaque unknown-meta row（holder-local identity 锚，见
    // structured-item.js withItemKey；Pin 本身只活在 localStorage）。
    const [pinKeys, setPinKeys] = useState(() => new Set());
    // Notes behavior: current-holder keyword search（findability affordance）。
    // Search ≠ semantic retrieval / relevance ranking / durable reorder / Pin /
    // selection / cross-session authority。只搜 current holder × four lanes 的
    // **whole Note**（authored comment + persisted Source snapshot），绝不匹配
    // machine metadata（item-key/captureOrigin/locator/framing）。query 为纯视图
    // 状态：不改 lane/不写 Notes/Pin/不持久化。结果按 lane 分组；每个 lane 内
    // 置顶命中组在前、普通命中组在后，两 group 内部都遵循当前全局 Notes behavior viewDir
    // （Notes behavior adversarial-A/B：Pin truth 按 result lane 解析；Search 视图直接暴露同一个
    // 全局 newest/oldest 控件——复用 viewDir state，不引入 search 专属排序状态）。
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchBusy, setSearchBusy] = useState(false);
    const [searchResults, setSearchResults] = useState(null); // null | { query, lanes: [{key,label,nodes:[{node,physIndex}],forkMerge}] }
    // Notes behavior query generation token：只接受最新 query 的响应。
    const searchGenRef = useRef(0);
    // Notes behavior result-card 操作跳转：把某条跨-lane 命中 Note 的动作转发到它所属 lane。
    // 目标 = 该 lane 的活跃编辑器（whole-lane PUT / pin migration / inline 编辑删除都
    // 只活在 active lane machinery 上）——绝不能靠 visible result index 定位。
    // 定位锚 = itemKey（有）或 { laneKey, physIndex, sig }（keyless 且位置+指纹双确认，
    // Keyless duplicate Notes are not resolved by taking the first fingerprint match.
    const [jumpTarget, setJumpTarget] = useState(null); // null | { laneKey, itemKey?, sig?, physIndex?, action }
    const jumpSeqRef = useRef(0);
    // 自动附源 guard：同一个 panel 生命周期内，每个 session 只自动尝试一次
    // （打开面板即尝试；会话切换后再对新 session 尝试），避免重复发起捕获请求。
    const autoAttachedRef = useRef(new Set());

    const current = () => layers.find((l) => l.key === layerKey) ?? layers[0];
    const url = useCallback((key) => `/notes-api/${encodeURIComponent(sessionId)}/${key}`, [sessionId]);
    const setupUrl = `/notes-api/setup/${encodeURIComponent(sessionId)}`;

    const refreshMeta = useCallback(async () => {
      const response = await notesFetch("/notes-api/meta");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const meta = await response.json();
      const list = Array.isArray(meta?.layers) && meta.layers.length > 0 ? meta.layers : null;
      if (!list) return;
      setLayers(list);
      setLayerKey((prev) => (list.some((l) => l.key === prev) ? prev : list[0].key));
    }, []);

    // ---- Notes behavior: whole structured Note selection（current holder 内存态 + host
    // pending mirror）----
    // 语义：
    //   - selSet: Map `laneKey\u0000itemKey` -> {laneKey,itemKey}。同一 Note 经
    //     lane / Search / Pin / viewDir 多 UI 路径只占一个 entry（dedup 键 =
    //     holder+lane+itemKey）；可同时选跨 L1-L4 的 Note（cross-lane current-holder
    //     set）。纯内存视图态：不写 Note 文件 / Pin / localStorage；holder/session
    //     切换不携带（host pending 亦 per-session）。
    //   - gen（client-issued intent order）：selGenRef = 本地单调意图 generation，
    //     每次 mutation +1 随 versioned PUT 发出；selSyncedRef = 最近一次 host **接受**
    //     的 {gen,targets}（可见 selection == host accepted truth）。host 拒绝/网络失败
    //     → revert 可见态回 selSyncedRef（绝不出现 "UI 0 选中 + 隐藏 stale pending 会
    //     静默 bind" 的共存）。
    //   - 消费（成功清 tray / 失败保留 + truthful）经轮询 GET selection：
    //     lastBinding.generation === 本地 synced gen 才动作；**stale lastBinding
    //     （generation ≠ synced gen）一律忽略**（不作用于当前 selection）。绑定发生在
    //     用户主对话提交（panel 外）——本 header-utility slot 无 conversation
    //     subscribe seam 不可用，故用 cheap in-memory GET 轮询（仅 tray 非空时）。
    //   - 不可绑定的 Note（无 itemKey 的 keyless structured item / legacy 段）不给
    //     可勾选语义（无 stable key → 提交时无法 re-resolve → 宁不可选不 silent subset）。
    const [selSet, setSelSet] = useState(() => new Map());
    const selSetRef = useRef(selSet);
    selSetRef.current = selSet;
    const selGenRef = useRef(0); // client-issued monotonic intent generation
    const selSyncedRef = useRef({ gen: 0, targets: [] }); // last host-accepted write
    const selPendingRef = useRef(null); // latest desired targets awaiting sync (null = clean)
    const selSyncingRef = useRef(false); // single-flight sync engine
    const selSeqRef = useRef(0); // hydration/poll request sequence guard
    const [selHydrated, setSelHydrated] = useState(false); // mount GET selection done
    const [selTrayOpen, setSelTrayOpen] = useState(false);
    const [selBusy, setSelBusy] = useState(false);
    const [selError, setSelError] = useState(null); // truthful sync/binding failure line
    const [selPreview, setSelPreview] = useState(null); // {laneKey:{itemKey:{authored,exists}}} (tray review)
    const [selPreviewBusy, setSelPreviewBusy] = useState(false);
    // Notes behavior narrow UX：binding receipt（ephemeral，不写 Note/不建 durable registry）。
    // selReceipt = null | { kind:"success"|"failure", noteCount, targets?, code?, reason?, at }
    //   只由 authoritative binding success/failure（lastBinding 代 == synced gen）驱动；
    //   成功 receipt 数秒后降级为低强调单行（timer），失败 receipt 保留到用户处理
    //   （选择保留，可重试/取消——由 tray + selError 承载）。新 selection / session
    //   切换立即清 receipt（旧代结果不冒充新态）。
    const [selReceipt, setSelReceipt] = useState(null);
    const [selReceiptView, setSelReceiptView] = useState(false);
    const selReceiptTimerRef = useRef(null);
    const receiptProminentMs = () =>
      typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_RECEIPT_MS)
        ? window.__DSH_NOTES_RECEIPT_MS
        : 4000;
    const clearSelReceipt = () => {
      if (selReceiptTimerRef.current !== null) { clearTimeout(selReceiptTimerRef.current); selReceiptTimerRef.current = null; }
      setSelReceipt(null);
      setSelReceiptView(false);
    };
    const showSelReceipt = (r) => {
      if (selReceiptTimerRef.current !== null) { clearTimeout(selReceiptTimerRef.current); selReceiptTimerRef.current = null; }
      setSelReceipt(r);
      if (r.kind === "success") {
        // 数秒后降级为低强调单行（detail 见渲染：prominent 期显示 ✓ 行，之后剩
        // "已随消息引用 N 条便签" 弱化行）；timer 只负责降级，不凭空清 authority。
        selReceiptTimerRef.current = setTimeout(() => {
          selReceiptTimerRef.current = null;
          if (aliveRef.current && sessionIdRef.current === (selReceiptSessionRef.current ?? sessionIdRef.current)) {
            setSelReceipt((cur) => (cur && cur.kind === "success" ? { ...cur, degraded: true } : cur));
          }
        }, receiptProminentMs());
      }
    };
    // session 守卫：timer 到期降级只作用于 receipt 所属 session（切换后旧 receipt
    // 已被 clearSelReceipt 清掉，这里再兜一层防 in-flight timeout 写错 session）。
    const selReceiptSessionRef = useRef(sessionId);
    selReceiptSessionRef.current = sessionId;
    const aliveRef = useRef(true);
    useEffect(() => () => { aliveRef.current = false; if (selReceiptTimerRef.current !== null) clearTimeout(selReceiptTimerRef.current); }, []);
    const selUrl = `/notes-api/${encodeURIComponent(sessionId)}/selection`;
    const selKeyOf = (laneKey, itemKey) => `${laneKey}\u0000${itemKey}`;
    const selMapFromTargets = (targets) => {
      const m = new Map();
      (Array.isArray(targets) ? targets : []).forEach((t) => {
        if (t && typeof t.laneKey === "string" && typeof t.itemKey === "string" && t.itemKey !== "") {
          m.set(selKeyOf(t.laneKey, t.itemKey), { laneKey: t.laneKey, itemKey: t.itemKey });
        }
      });
      return m;
    };
    const targetsOfSelMap = (m) => [...m.values()];
    const sameTargets = (a, b) => {
      const ka = (Array.isArray(a) ? a : []).map((t) => selKeyOf(t.laneKey, t.itemKey)).sort().join(",");
      const kb = (Array.isArray(b) ? b : []).map((t) => selKeyOf(t.laneKey, t.itemKey)).sort().join(",");
      return ka === kb;
    };

    // Notes behavior reload rehydration（含未知窗口防护）：
    // panel open / session 切换时 GET host pending → 恢复可见 selection（同 running
    // runtime + browser reload）；runtime/plugin 重启 → host 内存即失 → GET 无 pending
    // → 空（不恢复；跨重启不恢复 ephemeral selection）。
    // **未知窗口不变式**：GET 读失败 ≠ 没有 pending（host pending 是
    // host 进程内状态，client 读失败不会清它；绑定只依赖 pending + pre-step，不依赖
    // 客户端 GET——真实隔离 host 实证：PUT 后零 GET 直接提交即绑定成功）。因此在读到
    // host truth 之前：不渲染任何"0 选中/无选择"声称（tray 需 selHydrated；checkbox
    // disabled）；GET 有界重试；仍失败 → 主动 clear（PUT []，stale-retry 收敛）并重试
    // 到成功——UI 进入可用态时 host pending 要么已被采纳显示、要么已被清空，绝不出现
    // "UI 0 选中 + 隐藏 stale pending 会静默 bind"。
    useEffect(() => {
      // Session isolation：session 切换立即清空 selection UI 态 + 标未 hydration
      // （旧 session 的 tray/preview/error/勾选绝不残留到新 session；refs 在下方
      // 同步重置）。真正的隔离由 NotesToggle 以 key={sessionId} remount 保证；本
      // effect 是第二道防线（prop 直改/未 remount 路径）。
      const seq = ++selSeqRef.current; // session-generation guard（hydration/pump/poll 共用 epoch）
      setSelSet(new Map());
      setSelHydrated(false);
      setSelTrayOpen(false);
      setSelPreview(null);
      setSelError(null);
      clearSelReceipt(); // 旧 session 的 binding receipt 绝不残留（generation/session 隔离）
      selGenRef.current = 0; // 每 session 重新从 host truth 起步（stale-retry 校正）
      selSyncedRef.current = { gen: 0, targets: [] };
      selPendingRef.current = null;
      let cancelled = false;
      const mySessionId = sessionId;
      const retryMs = typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_HYDRATE_RETRY_MS) ? window.__DSH_NOTES_HYDRATE_RETRY_MS : 700;
      const readSelection = async () => {
        try {
          const r = await notesFetch(selUrl);
          if (!r.ok) return undefined; // 非 2xx = endpoint 不可用/异常 → unknown
          const raw = await r.text().catch(() => "");
          try { return raw ? JSON.parse(raw) : { pending: null, lastBinding: null }; } catch { return undefined; }
        } catch { return undefined; } // network/read failure（undefined = unknown，≠ 空）
      };
      const clearWithRetry = async () => {
        // PUT []（client gen 单调 + stale 校正）；网络失败按 retryMs 退避重试直到
        // 成功或 panel 关闭——成功前不置 hydrated（不渲染任何选择 UI 声称）。
        let attempt = 0;
        while (!cancelled && aliveRef.current && seq === selSeqRef.current && sessionIdRef.current === mySessionId) {
          const gen = ++selGenRef.current;
          let j = null;
          try {
            const r = await notesFetch(selUrl, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ targets: [], generation: gen }),
            });
            const raw = await r.text().catch(() => "");
            try { j = raw ? JSON.parse(raw) : null; } catch { j = null; }
          } catch { j = null; }
          if (cancelled || !aliveRef.current) return;
          if (j && j.ok === true) { selSyncedRef.current = { gen: j.generation, targets: [] }; return; }
          if (j && j.ok === false && j.stale === true && Number.isSafeInteger(j.currentGeneration)) { selGenRef.current = j.currentGeneration; continue; }
          await new Promise((r) => setTimeout(r, retryMs * Math.min(attempt + 1, 3)));
          attempt++;
        }
      };
      (async () => {
        let j;
        for (let tryNo = 0; tryNo < 5; tryNo++) {
          if (cancelled || !aliveRef.current || seq !== selSeqRef.current || sessionIdRef.current !== mySessionId) return;
          j = await readSelection();
          if (j !== undefined) break; // 拿到 host 应答（pending 或空）
          if (tryNo < 4) await new Promise((r) => setTimeout(r, retryMs));
        }
        if (cancelled || !aliveRef.current || seq !== selSeqRef.current || sessionIdRef.current !== mySessionId) return;
        if (j !== undefined && j !== null) {
          const p = j.pending;
          if (p && Array.isArray(p.targets) && p.targets.length > 0 && Number.isSafeInteger(p.generation)) {
            setSelSet(selMapFromTargets(p.targets));
            selSyncedRef.current = { gen: p.generation, targets: p.targets };
            selGenRef.current = p.generation;
          } else {
            setSelSet(new Map());
            selSyncedRef.current = { gen: selSyncedRef.current.gen, targets: [] };
          }
          setSelHydrated(true);
          setSelError(null);
          return;
        }
        // GET 彻底失败（unknown，非空）→ 主动清 host pending（收敛后进空态；成功前
        // 不置 hydrated → 无任何"0 选中"声称）
        await clearWithRetry();
        if (cancelled || !aliveRef.current || seq !== selSeqRef.current || sessionIdRef.current !== mySessionId) return;
        setSelSet(new Map());
        setSelHydrated(true);
        setSelError(null);
      })();
      return () => { cancelled = true; };
    }, [sessionId, selUrl]);

    // Notes behavior sync engine：single-flight——每次可见 mutation 只把最新 desired targets
    // 记入 selPendingRef，由 pump 串行收敛到 host（intent order = client gen 单调；
    // 无并发 PUT → 无乱序覆盖）。host 接受 → selSyncedRef 推进；拒绝/stale/网络 →
    // revert 可见态回 host accepted truth + truthful error。
    const pumpSel = async () => {
      if (selSyncingRef.current) return;
      selSyncingRef.current = true;
      // Epoch + session guard——session 切换后旧 session 的
      // 在途 PUT 不得继续写新 session 状态。
      const epoch = selSeqRef.current;
      const mySid = sessionIdRef.current;
      try {
        while (selPendingRef.current !== null && aliveRef.current && epoch === selSeqRef.current && sessionIdRef.current === mySid) {
          const targets = selPendingRef.current;
          const gen = ++selGenRef.current;
          let j = null;
          let status = 0;
          try {
            const r = await notesFetch(selUrl, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ targets, generation: gen }),
            });
            status = r.status;
            const raw = await r.text().catch(() => "");
            try { j = raw ? JSON.parse(raw) : null; } catch { j = null; }
          } catch (e) {
            j = { ok: false, network: true, reason: String((e && e.message) || e) };
          }
          if (!aliveRef.current || epoch !== selSeqRef.current || sessionIdRef.current !== mySid) return;
          if (j && j.ok === true) {
            // host 接受（含 clear）→ 推进 synced truth
            selSyncedRef.current = { gen: j.generation, targets };
            if (selPendingRef.current !== null && sameTargets(selPendingRef.current, targets)) selPendingRef.current = null;
            setSelError(null);
            if (targets.length === 0) { setSelTrayOpen(false); setSelPreview(null); }
            continue;
          }
          if (j && j.ok === false && j.stale === true && Number.isSafeInteger(j.currentGeneration)) {
            // host lastGen 已超过本地计数器（reload 后重建 / 其它 writer）→ 采纳 host
            // currentGeneration，重试一次（意图 targets 不变，仅代校正）。
            selGenRef.current = j.currentGeneration;
            continue;
          }
          // host 未接受（400/405/网络）→ revert 可见态回 host accepted truth
          selPendingRef.current = null;
          if (aliveRef.current && epoch === selSeqRef.current && sessionIdRef.current === mySid) {
            setSelSet(selMapFromTargets(selSyncedRef.current.targets));
            const reason = (j && j.reason) || (j && j.network ? panelT("label.networkError") : `HTTP ${status}`);
            setSelError(panelT("status.selectionSaved", { reason: String(reason) }));
            setStatus(panelT("status.selectionSaved", { reason: String(reason) }));
          }
        }
      } finally {
        selSyncingRef.current = false;
      }
    };
    const applyLocal = (nextMap) => {
      if (!selHydrated || !aliveRef.current) return;
      const targets = targetsOfSelMap(nextMap);
      setSelSet(nextMap);
      // 新 selection（含清空）立即作废旧 receipt——旧代结果不得冒充当前 pending 状态
      if (targets.length > 0 || nextMap.size === 0) clearSelReceipt();
      selPendingRef.current = targets;
      pumpSel();
    };
    const toggleSelection = (laneKey, itemKey) => {
      const next = new Map(selSetRef.current);
      const k = selKeyOf(laneKey, itemKey);
      if (next.has(k)) next.delete(k); else next.set(k, { laneKey, itemKey });
      applyLocal(next);
    };
    const clearSelection = () => applyLocal(new Map());

    // Notes behavior 绑定结果消费（轮询；仅 tray 非空时起 timer——无选择不轮询）。
    // stale lastBinding（generation ≠ 本地 synced gen）忽略；仅当 host 已把我们的
    // selection 消费（lastBinding 结果代 == synced gen）才清 tray / 报 truthful failure。
    useEffect(() => {
      if (!selHydrated || selSetRef.current.size === 0) return;
      let cancelled = false;
      const tick = async () => {
        if (cancelled || !aliveRef.current) return;
        // Epoch + session guard（在途 tick 不得写新 session）
        const epoch = selSeqRef.current;
        const mySid = sessionIdRef.current;
        if (selSyncingRef.current || selPendingRef.current !== null) return; // 本地同步中不消费
        let j = null;
        try {
          const r = await notesFetch(selUrl);
          const raw = await r.text().catch(() => "");
          try { j = raw ? JSON.parse(raw) : null; } catch { j = null; }
        } catch { return; }
        if (cancelled || !aliveRef.current || !j || epoch !== selSeqRef.current || sessionIdRef.current !== mySid) return;
        const syncedGen = selSyncedRef.current.gen;
        const lb = j.lastBinding;
        if (lb && lb.generation === syncedGen) {
          if (lb.ok === true) {
            // 绑定成功：host 已清 pending → 清 tray（仅消费属于当前 selection 代的结果）。
            // Notes behavior receipt：在清空前捕获本次成功绑定的 targets（holder+lane+itemKey）
            // ——"查看"展示的是**本次真实绑定的 set**，不是新 selection/当前 lane 全量。
            const boundTargets = targetsOfSelMap(selSetRef.current);
            const noteCount = Number.isSafeInteger(lb.noteCount) ? lb.noteCount : boundTargets.length;
            selPendingRef.current = null;
            selSyncedRef.current = { gen: syncedGen, targets: [] };
            setSelSet(new Map());
            setSelTrayOpen(false);
            setSelPreview(null);
            setSelError(null);
            setStatus(panelT("status.selectionBound", { n: noteCount }));
            showSelReceipt({ kind: "success", noteCount, targets: boundTargets, degraded: false, at: Date.now() });
            return;
          }
          // 绑定失败（host 保留 pending）→ tray 保留 + truthful 文案；selection 不丢
          const fail = (Array.isArray(lb.failures) && lb.failures[0]) || {};
          const failReason = fail.reason || panelT("label.selectionParseFailed");
          setSelError(panelT("status.selectionFailure", { code: fail.code || "FAILED", reason: failReason }));
          showSelReceipt({ kind: "failure", noteCount: lb.noteCount ?? selSetRef.current.size, code: fail.code || "FAILED", reason: failReason, at: Date.now() });
          return;
        }
        // 无属于本代的 lastBinding：host pending 与本地 synced 是否一致（外部清空/
        // 重水合/其它 writer）→ 采纳 host truth（同步中不抢，交给 pump 收敛）
        const p = j.pending;
        const hostTargets = (p && Array.isArray(p.targets)) ? p.targets : [];
        if (!sameTargets(hostTargets, selSyncedRef.current.targets)) {
          if (p && Number.isSafeInteger(p.generation)) {
            setSelSet(selMapFromTargets(hostTargets));
            selSyncedRef.current = { gen: p.generation, targets: hostTargets };
            selGenRef.current = Math.max(selGenRef.current, p.generation);
          } else if (!p) {
            setSelSet(new Map());
            selSyncedRef.current = { gen: selSyncedRef.current.gen, targets: [] };
            setSelTrayOpen(false);
            setSelPreview(null);
          }
        }
      };
      const id = setInterval(tick, typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_SEL_POLL_MS) ? window.__DSH_NOTES_SEL_POLL_MS : 1500);
      return () => { cancelled = true; clearInterval(id); };
      // 依赖仅 selHydrated / size / selUrl：tick 读 ref（selSetRef/selSyncedRef），
      // 避免每 setSelSet 重建 interval。
    }, [selHydrated, selSet.size, selUrl]);

    // Notes behavior tray 展开 review：取涉事 lane 当前 body → itemKey → authored 摘要
    // （只读 GET，与 lane 载入同路径；只读不写）。缺失 itemKey（已删除）→ 如实标注。
    useEffect(() => {
      if (!selTrayOpen || selSet.size === 0) { setSelPreview(null); setSelPreviewBusy(false); return; }
      let cancelled = false;
      const lanesNeeded = [...new Set([...selSet.values()].map((t) => t.laneKey))];
      const epoch = selSeqRef.current;
      const mySid = sessionIdRef.current;
      setSelPreviewBusy(true);
      (async () => {
        const out = {};
        try {
          for (const lane of lanesNeeded) {
            const r = await notesFetch(url(lane));
            if (!r.ok) continue;
            const body = await r.text();
            const parsed = parseLaneBody(body);
            const map = {};
            parsed.nodes.forEach((node) => {
              if (node.type === "item" && node.item) {
                const ik = getItemKey(node.item) ?? "";
                if (ik !== "") map[ik] = { authored: String(node.item.comment ?? ""), exists: true };
              }
            });
            out[lane] = map;
          }
        } catch { /* 预览尽力而为；缺失按“无法预览”显示 */ }
        if (!cancelled && aliveRef.current && epoch === selSeqRef.current && sessionIdRef.current === mySid) { setSelPreview(out); setSelPreviewBusy(false); }
      })();
      return () => { cancelled = true; };
    }, [selTrayOpen, selSet, url]);

    // fork/carry eligibility decision: on open / session switch, check whether this session is a fork child
    // with an unresolved carry-over decision. Non-fork or decided sessions yield
    // null and show no banner.
    useEffect(() => {
      let cancelled = false;
      notesFetch(`/notes-api/fork-status?sessionId=${encodeURIComponent(sessionId)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((info) => {
          if (cancelled) return;
          if (info?.isForkChild && info?.status === "unresolved") {
            setCarryOver({ parentSessionId: info.parentSessionId, status: "unresolved", carriedLanes: null });
          } else {
            setCarryOver(null);
          }
        })
        .catch(() => { /* non-fork / network error → no banner */ });
      return () => { cancelled = true; };
    }, [sessionId]);

    // fork/carry eligibility decision: submit a carry-over decision (all / some / none).
    // Dirty-lane gate: if the selected lanes include the CURRENTLY displayed
    // lane and it has unsaved edits, the carry-over is PAUSED — the user must
    // first persist the draft via the normal Save flow. Only a successful Save
    // resumes the carry-over preflight; a 409/failed Save keeps it paused so
    // the existing save-conflict triage takes over. "取消" aborts the carry-over.
    // (Single active editor: at most one dirty lane this round.)
    const decideCarryOver = async (choice, lanes) => {
      if (carryBusy) return;
      if (choice === "some" && !carryPicking) {
        setCarryPicking(true);
        setCarrySelected(layers.map((l) => l.key));
        return;
      }
      if (choice === "some" && carrySelected.length === 0) {
        setStatus(panelT("status.selectLane"));
        return;
      }
      // Dirty-lane gate: only blocks when the selected set actually includes
      // the current lane. Applies to inherit decisions (all / some) only —
      // "不带" (none) inherits nothing, so unsaved edits are irrelevant there.
      // "选择部分" without this lane proceeds freely.
      if (choice !== "none") {
        const selectedLanes = choice === "all" ? layers.map((l) => l.key) : carrySelected;
        if (dirty && selectedLanes.includes(layerKey)) {
          const proceed = window.confirm(panelT("status.inheritUnsaved", { label: current().label }));
          if (!proceed) {
            setStatus(panelT("status.inheritCancelled"));
            return;
          }
          setCarryBusy(true);
          const saved = await doPut(text, mtime);
          setCarryBusy(false);
          if (!saved) {
            // Save failed or surfaced a 409 conflict: carry-over stays PAUSED,
            // the user handles the save conflict first (existing triage).
            setStatus(panelT("status.inheritPaused"));
            return;
          }
          // Save persisted → the draft is now a normal child observation; resume
          // the normal carry-over preflight below.
        }
      }
      setCarryBusy(true);
      const bodyLanes = choice === "some" ? carrySelected : null;
      notesFetch("/notes-api/fork-carryover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, choice, lanes: bodyLanes }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((result) => {
          if (result?.status === "conflict") {
            // Preflight-first: occupied lanes surfaced, NOTHING mutated yet.
            // Switch to the one-time conflict resolution UI. The bound
            // parent+child observations accompany the payload so the final
            // apply revalidates exactly what the user saw.
            setCarryConflict({ choice, lanes: bodyLanes, conflicts: result.conflicts, observations: result.observations });
            const res = {};
            result.conflicts.forEach((c) => { res[c.lane] = "merge"; });
            setCarryResolutions(res);
            return;
          }
          setCarryOver(null); // banner dismissed once decided
          setCarryPicking(false);
          if (result?.status === "carried") {
            showCarryResult(result.results || []);
          } else if (result?.status === "none") {
            setStatus(panelT("status.inheritNone"));
          } else {
            setStatus(panelT("status.inheritDone"));
          }
        })
        .catch((e) => setStatus(panelT("status.inheritFailed", { error: e.message })))
        .finally(() => setCarryBusy(false));
    };

    // fork/carry eligibility decision post-apply: show the per-lane RESULT banner (top position) and, when
    // the currently displayed lane was just written, re-fetch its content so the
    // editor never keeps stale pre-apply text. Respect in-progress unsaved edits.
    const showCarryResult = (results) => {
      const laneLines = [];
      const applied = [];
      results.forEach((r) => {
        const l = layers.find((x) => x.key === r.lane);
        const label = l?.label ?? r.lane;
        if (r.outcome === "merged") { laneLines.push({ lane: r.lane, label, text: panelT("status.carryMerged") }); applied.push(r.lane); }
        else if (r.outcome === "replaced") { laneLines.push({ lane: r.lane, label, text: panelT("status.carryReplaced") }); applied.push(r.lane); }
        else if (r.outcome === "copied") { laneLines.push({ lane: r.lane, label, text: panelT("status.carryCopied") }); applied.push(r.lane); }
        else if (r.outcome === "kept") { laneLines.push({ lane: r.lane, label, text: panelT("status.carryKept") }); }
        else if (r.outcome === "skipped") { laneLines.push({ lane: r.lane, label, text: panelT("status.carrySkipped", { reason: r.reason ?? panelT("label.genericError") }) }); }
      });
      setCarryResult({ laneLines, applied });
      setStatus("");
      if (applied.includes(layerKey) && !dirtyRef.current) {
        // Post-apply live refresh of the CURRENTLY displayed lane. Capture the
        // lane at request time; discard the response if the user switched to
        // another lane before it landed (stale GET must never setText into the
        // active lane). layerKeyRef.current is the LIVE lane — a state variable
        // in this async closure would be frozen at request time and defeat the
        // guard. The normal lane load re-reads authoritative content.
        const refreshLane = layerKey;
        saveSeq.current++; // invalidate in-flight saves
        setConflict(null);
        notesFetch(url(refreshLane))
          .then((r) => (r.ok ? r : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then(async (r) => {
            const body = await r.text();
            const mt = r.headers.get("x-notes-mtime") ?? "0";
            // Cross-lane guard: only apply when still on the refreshed lane AND
            // the user has not typed since (dirty protection unchanged).
            if (layerKeyRef.current === refreshLane && !dirtyRef.current) {
              setText(body);
              setMtime(mt);
              setDirty(false);
            }
          })
          .catch(() => { /* post-apply refresh is best-effort */ });
      }
    };

    // fork/carry eligibility decision: final apply of one-time conflict resolutions. Bound to the parent +
    // child observations the user saw (kind + version); the host revalidates
    // them under the shared fs locks (stale → re-surface).
    const applyCarryResolutions = () => {
      if (carryBusy || !carryConflict) return;
      setCarryBusy(true);
      notesFetch("/notes-api/fork-apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId,
          choice: carryConflict.choice,
          lanes: carryConflict.lanes,
          resolutions: carryResolutions,
          observations: carryConflict.observations,
        }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((result) => {
          if (result?.alreadyDecided) {
            setCarryConflict(null);
            setCarryOver(null);
            setStatus(panelT("status.alreadyDecided"));
            return;
          }
          const stale = (result.results || []).filter((r) => r.outcome === "stale");
          if (stale.length > 0) {
            // Content changed since the user saw it → re-surface the conflict
            // with fresh content (no destructive apply happened for those lanes).
            setStatus(panelT("status.contentChanged"));
            notesFetch("/notes-api/fork-carryover", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId, choice: carryConflict.choice, lanes: carryConflict.lanes }),
            })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
              .then((fresh) => {
                if (fresh?.status === "conflict") {
                  setCarryConflict({ choice: carryConflict.choice, lanes: carryConflict.lanes, conflicts: fresh.conflicts, observations: fresh.observations });
                  const res = {};
                  fresh.conflicts.forEach((c) => { res[c.lane] = "merge"; });
                  setCarryResolutions(res);
                } else {
                  // No conflicts anymore (someone cleaned the lane) → re-decide
                  decideCarryOver(carryConflict.choice, carryConflict.lanes);
                }
              })
              .catch((e) => setStatus(panelT("status.reconfirmFailed", { error: e.message })));
            return;
          }
          setCarryConflict(null);
          setCarryOver(null);
          // Post-apply: per-lane RESULT banner (top position) + real-time
          // content sync for the currently displayed lane.
          showCarryResult(result.results || []);
        })
        .catch((e) => setStatus(panelT("status.inheritFailed", { error: e.message })))
        .finally(() => setCarryBusy(false));
    };

    // Resolved display mapping from the host (semantic keys + display ids).
    // Failures fall back to the built-in table. A profile settings commit
    // refreshes this same mapping; locale changes alone do not.
    useEffect(() => {
      refreshMeta().catch(() => { /* fallback */ });
      return undefined;
    }, [refreshMeta]);

    useEffect(() => {
      if (!profileSettings?.subscribe) return undefined;
      const sync = () => {
        setProfileSettingsSnapshot(profileSettings.getSnapshot());
        refreshMeta().catch(() => { /* keep the last authoritative mapping */ });
      };
      sync();
      return profileSettings.subscribe(sync);
    }, [profileSettings, refreshMeta]);

    useEffect(() => {
      if (profileLabelsInitializedRef.current || !profileSettings) return;
      const snapshot = profileSettingsSnapshot ?? profileSettings.getSnapshot?.();
      if (snapshot?.status !== "ready") return;
      setProfileLabels(profileLabelsFromSnapshot(snapshot, initialProfileLocale));
      profileLabelsInitializedRef.current = true;
    }, [profileSettings, profileSettingsSnapshot, initialProfileLocale]);

        // Workspace setup: discover binding state without probing filesystem paths in
    // the browser.  Older fixture hosts return a non-JSON response and leave
    // setup null; rc.2's setup endpoint returns the authoritative two-state
    // binding view.
    useEffect(() => {
      let cancelled = false;
      notesFetch(setupUrl)
        .then(async (r) => {
          if (!r.ok) return null;
          const raw = await r.text();
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        })
        .then((info) => {
          if (!cancelled && (info?.state === "INITIALIZED" || info?.state === "UNINITIALIZED")) setSetup(info);
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }, [setupUrl]);

    // Mirror dirty into a ref so the load effect reads the latest value
    // without re-running on every keystroke.
    const dirtyRef = useRef(false);
    dirtyRef.current = dirty;
    // Last loaded session (for the switch-session unsaved-edits confirm)
    const lastSessionRef = useRef(sessionId);

    // Load current layer on open / tab switch / session switch
    useEffect(() => {
      let cancelled = false;
      const sessionChanged = lastSessionRef.current !== sessionId;
      lastSessionRef.current = sessionId;
      if (sessionChanged) {
        // Notes behavior: capture proposal 绑定原 session（capture.validated.sessionId）。
        // session 切换必须清除——否则 A 会话的 locator 可能被 Save 到 B 会话。
        setCapture(null);
        setCaptureComment("");
        setReentry(null);
        // Notes behavior: session 切换同时清 composer/编辑态（composer 是当前会话的草稿，
        // 不能跨会话残留到新 session 的 lane body）。
        setComposerText("");
        setEditingIndex(null);
        editingSigRef.current = null;
        setAttachHint(null);
        setConfirmingDelete(null);
        setupContinuationRef.current = null;
      }
      if (sessionChanged && dirtyRef.current) {
        // Host switched props.sessionId: never silently drop unsaved edits
        if (!window.confirm(panelT("status.switchDiscard"))) {
          setStatus(panelT("status.switchKept"));
          return; // keep dirty, do not load the new session
        }
        setDirty(false);
        dirtyRef.current = false;
      }
      setStatus(panelT("status.loading"));
      notesFetch(url(layerKey))
        .then((r) => (r.ok ? r : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(async (r) => {
          const body = await r.text();
          const mt = r.headers.get("x-notes-mtime") ?? "0";
          if (!cancelled && !dirtyRef.current) {
            setText(body);
            setMtime(mt);
            setConflict(null);
            setStatus("");
          }
        })
        .catch((e) => { if (!cancelled) setStatus(panelT("status.loadFailed", { error: e.message })); });
      return () => { cancelled = true; };
    }, [sessionId, layerKey]);

    // Notes behavior: 载入 holder-local Pin 状态。Pin map 只存 browser localStorage；渲染时
    // 只把「lane 中真实存在的 itemKey」视为 pinned（stale/删除的 key 不产生 ghost
    // pin、不 rebind 到别的 Note）。跨 session 隔离由 map 的 sessionId 层
    // 保证；fork/carry child 是不同 sessionId → 自动 unpinned。
    useEffect(() => {
      setPinKeys(readPinMap(sessionId, layerKey));
    }, [sessionId, layerKey, text]);

    // Notes behavior: 搜索执行。query 非空时对 four lanes 各发一次**只读 GET**（与普通 lane
    // 载入同路径，不碰 active lane 的 text/dirty/conflict 状态——搜索状态独立于编辑
    // 状态，E1/E6），parse 后按 whole-Note 过滤（noteMatchesQuery 只读 comment/snapshot/
    // legacy text，machine metadata 结构性排除）。结果按 lane 分组保序；组内顺序由
    // 渲染时按 Notes behavior viewDir 决定（这里只保留物理序 + forkMerge 标记）。空 query /
    // 关闭搜索 → 清空结果（恢复 normal view）。
    // Query-generation token：只接受“本次 query”的响应；迟到的旧响应
    // （先 A 后 B、A 晚到）被丢弃，绝不覆盖当前 query 结果。
    const runSearch = useCallback(async (q) => {
      const needle = normalizeSearchText(q);
      const gen = ++searchGenRef.current;
      if (!needle) { setSearchResults(null); return; }
      const mySession = sessionId;
      setSearchBusy(true);
      setSearchResults(null); // 旧 query 结果立即失效（避免陈旧卡片显示在“搜索中”下方）
      try {
        const laneRows = await Promise.all(layers.map(async (l) => {
          const r = await notesFetch(url(l.key));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = await r.text();
          const parsed = parseLaneBody(body);
          const forkMerge = isMergeWrapperBody(body);
          const matches = [];
          parsed.nodes.forEach((node, physIndex) => {
            if (noteMatchesQuery(node, needle)) matches.push({ node, physIndex });
          });
          return { key: l.key, label: l.label, displayId: l.displayId, forkMerge, nodes: matches };
        }));
        if (gen !== searchGenRef.current) return; // 已有更新的 query → 丢弃本响应
        if (sessionIdRef.current !== mySession) return; // 会话切换 → 丢弃
        setSearchResults({ query: q, lanes: laneRows });
      } catch (e) {
        if (gen !== searchGenRef.current) return;
        if (sessionIdRef.current === mySession) setSearchResults({ query: q, lanes: [], error: String(e?.message || e) });
      } finally {
        if (gen === searchGenRef.current && sessionIdRef.current === mySession) setSearchBusy(false);
      }
    }, [sessionId, layers, url]);

    // debounce + 自动执行（键入停止 ~300ms 后搜索；关闭/清空立即恢复 normal view）
      // Query changes immediately invalidate the old generation—even if an older response arrives
    // B 的 300ms debounce 窗口内（B 尚未真正启动 runSearch），A 也因 generation 已
    // 递增而被丢弃；同时清掉旧结果/重置 busy，避免陈旧卡片或陈旧“搜索中”显示。
    useEffect(() => {
      if (!searchOpen) {
        searchGenRef.current++;
        setSearchResults(null);
        setSearchQuery("");
        setSearchBusy(false);
        return;
      }
      const q = searchQuery.trim();
      searchGenRef.current++; // 立即失效上一 query 的在途响应（含 debounce 窗口期）
      setSearchResults(null); // 丢弃旧结果卡片
      setSearchBusy(false);   // 当前 query 尚无在途请求
      if (!q) return;
      setSearchBusy(true);    // debounce 窗口即显示“搜索中”（不显示旧卡片）
      const t = setTimeout(() => runSearch(q), 300);
      return () => clearTimeout(t);
    }, [searchQuery, searchOpen, runSearch]);



    // Close (with unsaved-edits confirm); stable ref for the Esc listener
    const handleClose = useCallback(() => {
      if (dirty && !window.confirm(panelT("status.closeDiscard"))) return;
      onClose();
    }, [dirty, onClose]);

    // Esc closes the panel (with confirm)
    useEffect(() => {
      const onKey = (e) => { if (e.key === "Escape") handleClose(); };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, [handleClose]);

    const confirmDiscard = () => !dirty || window.confirm(panelT("status.operationDiscard"));

    const saveProfileLabels = async () => {
      if (!profileSettings) return;
      const snapshot = profileSettings.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.writable !== true) {
        throw new Error(panelT("status.profileSettingsUnavailable"));
      }
      const userLayer = snapshot.user?.layerOverrides && typeof snapshot.user.layerOverrides === "object"
        ? snapshot.user.layerOverrides
        : {};
      const nextLayerOverrides = { ...userLayer };
      const nextLabels = Object.fromEntries(LANE_KEYS.map((key) => [key, String(profileLabels[key] ?? "").trim()]));
      if (!LANE_KEYS.every((key) => nextLabels[key] !== "")) {
        throw new Error(panelT("status.profileLabelsRequired"));
      }
      for (const key of LANE_KEYS) {
        const previous = nextLayerOverrides[key] && typeof nextLayerOverrides[key] === "object"
          ? nextLayerOverrides[key]
          : {};
        nextLayerOverrides[key] = {
          ...previous,
          label: nextLabels[key],
        };
      }
      setProfileLabelsBusy(true);
      try {
        // SettingsScope.set is the existing safe top-level field write. The
        // nested map is updated as one JSON value so target/action/displayId
        // siblings remain intact and revision fencing stays host-owned.
        await profileSettings.set("layerOverrides", nextLayerOverrides);
        await refreshMeta();
      } finally {
        setProfileLabelsBusy(false);
      }
    };

    // Notes owns the transient setup interaction. The selected path is sent
    // only to the host setup route; profile labels use the existing settings
    // seam and never enter a model-facing tool call.
    const commitSetup = async (action, path, force = false) => {
      if (setupBusy && !force) return false;
      setSetupBusy(true);
      setSetupError(null);
      try {
        if (profileNamingRequired) await saveProfileLabels();
        const payload = { action };
        if (path !== undefined) payload.path = path;
        const r = await notesFetch(setupUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const raw = await r.text();
        const result = raw ? JSON.parse(raw) : null;
        if (!r.ok || result?.ok !== true) throw new Error(result?.reason || result?.code || `HTTP ${r.status}`);
        setSetup({ state: "INITIALIZED", legacy: false });
        setPicker(null);
        setStatus(panelT("status.setupDone"));
        const continuation = setupContinuationRef.current;
        if (continuation && continuation.sessionId === sessionId && continuation.layerKey === layerKey) {
          setupContinuationRef.current = null;
          // Let the successful setup state render before re-entering the
          // normal save path. A failed/cancelled setup leaves the draft and
          // continuation untouched.
          setTimeout(() => {
            if (!aliveRef.current || sessionIdRef.current !== sessionId || layerKeyRef.current !== layerKey) return;
            const fn = continuation.kind === "composer" ? saveComposerRef.current : saveRef.current;
            fn?.();
          }, 0);
        }
        return true;
      } catch (error) {
        setSetupError(String(error?.message || error));
        return false;
      } finally {
        setSetupBusy(false);
      }
    };

    const abortPickerRequest = () => {
      pickerAbortRef.current?.abort();
      pickerAbortRef.current = null;
      pickerRequestRef.current++;
    };
    const beginPickerRequest = () => {
      abortPickerRequest();
      const controller = new AbortController();
      const request = { controller, seq: pickerRequestRef.current };
      pickerAbortRef.current = controller;
      return request;
    };
    const pickerRequestCurrent = (request) => pickerRequestRef.current === request.seq && pickerAbortRef.current === request.controller;
    useEffect(() => () => abortPickerRequest(), []);

    const chooseAnotherLocation = async () => {
      if (setupBusy) return;
      const uiWorkspace = clientCtx.uiWorkspace;
      if (!uiWorkspace) {
        setSetupError(panelT("status.directoryPickerUnavailable", {}));
        return;
      }
      setSetupBusy(true);
      setSetupError(null);
      let request;
      try {
        request = beginPickerRequest();
        const result = await chooseNotesDirectory(uiWorkspace, {
          signal: request.controller.signal,
          startPath: setup?.browseStartPath ?? setup?.proposedPath,
        });
        if (!pickerRequestCurrent(request)) return;
        if (result.mode === "cancelled") return;
        if (result.mode === "native") {
          await commitSetup("custom", result.path, true);
          return;
        }
        const listing = result.listing;
        const currentPath = listing?.path ?? listing?.currentPath ?? listing?.target?.displayPath ?? null;
        setPicker({ listing, currentPath });
      } catch (error) {
        if (!pickerRequestCurrent(request) || request.controller.signal.aborted || error?.name === "AbortError") return;
        setSetupError(String(error?.message || error));
      } finally {
        if (request && pickerRequestCurrent(request)) {
          pickerAbortRef.current = null;
          setSetupBusy(false);
        }
      }
    };

    const pickerEntries = picker ? (picker.listing?.entries ?? picker.listing?.children ?? picker.listing?.items ?? []) : [];
    const pickerCrumbs = picker ? (picker.listing?.crumbs ?? []) : [];
    const isDirectoryEntry = (entry) => Boolean(entry && typeof entry.path === "string" && entry.hidden !== true);
    const browseInto = async (entry) => {
      if (!picker || !clientCtx.uiWorkspace?.listDirectory || !isDirectoryEntry(entry)) return;
      const nextPath = entry?.path ?? entry?.target?.displayPath;
      if (!nextPath) return;
      setSetupBusy(true);
      setSetupError(null);
      const request = beginPickerRequest();
      try {
        const listing = await clientCtx.uiWorkspace.listDirectory(nextPath, request.controller.signal);
        if (!pickerRequestCurrent(request)) return;
        setPicker({ listing, currentPath: listing?.path ?? listing?.currentPath ?? nextPath });
      } catch (error) {
        if (!pickerRequestCurrent(request) || request.controller.signal.aborted || error?.name === "AbortError") return;
        setSetupError(String(error?.message || error));
      } finally {
        if (pickerRequestCurrent(request)) {
          pickerAbortRef.current = null;
          setSetupBusy(false);
        }
      }
    };

    const createPickerChild = async () => {
      if (!picker?.currentPath || !clientCtx.uiWorkspace?.createDirectory) return;
      const name = window.prompt(panelT("prompt.newDirectory"));
      if (!name) return;
      setSetupBusy(true);
      setSetupError(null);
      abortPickerRequest();
      try {
        const path = await clientCtx.uiWorkspace.createDirectory(picker.currentPath, name);
        const request = beginPickerRequest();
        const listing = await clientCtx.uiWorkspace.listDirectory(picker.currentPath, request.controller.signal);
        if (!pickerRequestCurrent(request)) return;
        setPicker({ listing, currentPath: listing?.path ?? picker.currentPath });
        setStatus(panelT("status.directoryCreated", { name: String(path).split(/[\\/]/).pop() }));
      } catch (error) {
        setSetupError(String(error?.message || error));
      } finally {
        abortPickerRequest();
        setSetupBusy(false);
      }
    };

    const profileSettingsReady = !profileSettings || profileSettingsSnapshot?.status === "ready";
    const profileVocabularyEstablished = Boolean(profileSettings) && profileSettingsReady
      && hasEstablishedProfileVocabulary(profileSettingsSnapshot);
    const profileNamingRequired = Boolean(profileSettings) && profileSettingsReady && !profileVocabularyEstablished;
    const profileLabelsReady = !profileSettings || (
      profileSettingsReady &&
      (profileVocabularyEstablished || (
        profileSettingsSnapshot.writable === true &&
        LANE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(profileLabels, key))
      ))
    );
    const profileNamesEl = profileNamingRequired
      ? createElement(
          "div",
          { style: { margin: "10px 0", padding: "8px", border: "1px solid #e5e7eb", borderRadius: "6px", background: "#fff" }, "data-notes-profile-labels": "1" },
          createElement("div", { style: { fontSize: "12px", fontWeight: 600, marginBottom: "3px" } }, panelT("label.setupLaneNames")),
          createElement("div", { style: { fontSize: "11px", color: "#6b7280", marginBottom: "6px" } }, panelT("label.setupLaneNameHint")),
          profileSettingsSnapshot?.status === "ready"
            ? LANE_KEYS.map((key) => {
                const fallback = FALLBACK_LAYERS.find((layer) => layer.key === key);
                return createElement(
                  "label",
                  { key, style: { display: "grid", gridTemplateColumns: "34px 1fr", alignItems: "center", gap: "5px", marginTop: "4px", fontSize: "11px" } },
                  createElement("span", null, fallback?.displayId ?? ""),
                  createElement("input", {
                    "data-notes-lane-name": key,
                    value: profileLabels[key] ?? "",
                    onChange: (event) => setProfileLabels((previous) => ({ ...previous, [key]: event.target.value })),
                    disabled: profileLabelsBusy || setupBusy,
                    style: { minWidth: 0, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: "4px" },
                  })
                );
              })
            : createElement("div", { style: { fontSize: "11px", color: "#6b7280" } }, panelT("status.profileSettingsLoading"))
        )
      : null;

    const setupGateEl = setup?.state === "UNINITIALIZED"
      ? createElement(
          "div",
          { style: { margin: "18px 10px", padding: "12px", border: "1px solid #c7d2fe", borderRadius: "8px", background: "#f5f7ff", color: "#374151", lineHeight: "1.5" }, "data-notes-setup": "1" },
          createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, color: "#374151", marginBottom: "6px" } },
            createElement("span", { "aria-hidden": "true", "data-notes-setup-warning": "1", title: panelT("label.setupWarning"), style: { color: "#b45309", fontSize: "15px", lineHeight: 1 } }, "⚠"),
            panelT("label.setupRequired")),
          setup.legacy
            ? createElement("div", { style: { marginBottom: "8px" } }, panelT("label.setupLegacy"))
            : createElement("div", { style: { marginBottom: "8px" } },
                panelT("label.setupFirstUse"),
                setup.proposedPath ? createElement("div", { style: { marginTop: "4px", fontFamily: "monospace", fontSize: "12px" }, "data-notes-proposed-path": "1" }, panelT("label.setupProposed", { path: setup.proposedPath })) : null),
          profileNamesEl,
          profileLabelsReady ? null : createElement("div", { style: { color: "#92400e", fontSize: "11px", marginBottom: "6px" } }, panelT("status.profileSettingsUnavailable")),
          setup.legacy
            ? createElement("button", { onClick: () => commitSetup("adopt"), disabled: setupBusy || !profileLabelsReady, style: { ...setupPrimaryStyle, marginRight: "6px" } }, panelT("button.setupAdopt"))
            : createElement("button", { onClick: () => commitSetup("default"), disabled: setupBusy || !profileLabelsReady, style: { ...setupPrimaryStyle, marginRight: "6px" } }, panelT("button.setupDefault")),
          !setup.legacy
            ? createElement("button", { onClick: chooseAnotherLocation, disabled: setupBusy || !profileLabelsReady, style: { ...setupButtonStyle, border: "1px solid #c7d2fe", color: "#4338ca" } }, panelT("button.setupOther"))
            : null,
          setupError ? createElement("div", { style: { color: "#b45309", marginTop: "7px", fontSize: "12px" } }, setupError) : null,
          !setup.legacy && picker
            ? createElement(
                "div",
                { style: { marginTop: "9px", padding: "8px", background: "#fff", border: "1px solid #dbeafe", borderRadius: "6px" }, "data-notes-picker": "1" },
                createElement("div", { style: { fontSize: "12px", fontWeight: 600, marginBottom: "5px" } }, panelT("label.pickerCurrent", { suffix: picker.currentPath ? panelT("label.pickerPathSuffix", { path: picker.currentPath }) : "" })),
                createElement("button", { onClick: () => commitSetup("custom", picker.currentPath), disabled: setupBusy || !profileLabelsReady || !picker.currentPath, style: { ...setupPrimaryStyle, marginRight: "5px" } }, panelT("button.pickerChoose")),
                createElement("button", { onClick: createPickerChild, disabled: setupBusy || !picker.currentPath, style: { ...setupButtonStyle, border: "1px solid #d1d5db", marginRight: "5px" } }, panelT("button.pickerNew")),
                createElement("button", { onClick: () => { abortPickerRequest(); setPicker(null); setSetupBusy(false); }, style: setupButtonStyle }, panelT("button.cancel")),
                pickerCrumbs.length > 0
                  ? createElement("div", { style: { marginTop: "6px", display: "flex", gap: "4px", flexWrap: "wrap" } },
                      pickerCrumbs.map((crumb, index) => isDirectoryEntry(crumb)
                        ? createElement("button", { key: crumb.path, onClick: () => browseInto(crumb), style: { ...setupButtonStyle, color: "#4f46e5" } }, index === 0 ? panelT("label.pickerRoot") : (crumb.name || crumb.path))
                        : null))
                  : null,
                createElement("div", { style: { marginTop: "6px", display: "flex", flexDirection: "column", gap: "3px" } },
                  pickerEntries.map((entry, index) => isDirectoryEntry(entry)
                    ? createElement("button", { key: entry.path ?? entry.target?.displayPath ?? index, onClick: () => browseInto(entry), style: { ...setupButtonStyle, textAlign: "left", color: "#1d4ed8" } }, `📁 ${entry.name ?? entry.path}`)
                    : null)
                )
              )
            : null
        )
      : null;

    // PUT save (with If-Match baseline); 409 → conflict triage.
    // overwrite=true sends the user-explicit conflict override header
    // (X-Notes-Overwrite: 1) — only used after the user saw the 409 conflict
    // and chose "overwrite anyway". Ordinary saves never set it.
    // @returns true on a successful persisted save; false on 409 (conflict
    // triage surfaced) or any failure — callers (e.g. carry-over dirty-lane
    // gate) must NOT proceed on false.
    const doPut = async (body, baseline, overwrite = false) => {
      const seq = ++saveSeq.current;
      setStatus(panelT("label.statusSaving"));
      try {
        const headers = { "content-type": "text/plain; charset=utf-8" };
        if (overwrite) headers["x-notes-overwrite"] = "1";
        else headers["if-match"] = baseline;
        const r = await notesFetch(url(layerKey), {
          method: "PUT",
          headers,
          body,
        });
        if (r.status === 409) {
          const latest = await r.text();
          const contentType = r.headers?.get?.("content-type") ?? "";
          if (contentType.toLowerCase().includes("application/json")) {
            let logical;
            try { logical = JSON.parse(latest); } catch { logical = null; }
            if (logical?.code) {
              if (seq === saveSeq.current) {
                setConflict(null);
                setStatus(logical.reason || logical.code);
              }
              return false;
            }
          }
          const latestMtime = r.headers.get("x-notes-mtime") ?? "0";
          if (seq === saveSeq.current) {
            setStatus(panelT("status.conflict"));
            setConflict({ latest, latestMtime });
          }
          return false;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const nm = r.headers.get("x-notes-mtime");
        if (seq === saveSeq.current) {
          if (nm) setMtime(nm); // refresh baseline so consecutive saves do not false-409
          setDirty(false);
          setStatus(panelT("status.saved"));
        }
        return true;
      } catch (e) {
        if (seq === saveSeq.current) setStatus(panelT("status.saveFailed", { error: e.message }));
        return false;
      }
    };

    const save = () => {
      if (setup?.state === "UNINITIALIZED") {
        setupContinuationRef.current = { kind: "raw", sessionId, layerKey };
        setStatus(panelT("status.setupContinue"));
        return;
      }
      if (!conflict) doPut(text, mtime);
    };
    saveRef.current = save;

    // Notes behavior/Notes behavior capture: 捕获当前 browser selection → host-validated proposal。
    // client-computed proposal 单独不构成 anchored truth——须 host validate。
    // auto=false（按钮「引用选中到便签」显式触发）：无选区/不可引用 → composer 下方
    // 浅提示（人话，如「无法引用这段文本：<原因前60字>」）；auto=true（打开面板/切
    // 会话自动附源）：无选区 → 静默纯便签模式；有选区但不可精确引用 → 同样浅提示 +
    // 重试建议，不弹错、不阻塞纯便签保存。
    // 成功 → 同一 proposal 展示（composer 的「引用的原文」区块）+ 状态文案。
    // 返回 true = proposal 已展示。失败只写浅提示（attachHint），不再设 stage error
    // 主导航框——便签视图的 error 展示收敛为 composer 下方通用小字。
    const runAttach = async ({ auto }) => {
      if (captureBusy) return false;
      const mySession = sessionId;
      setCaptureBusy(true);
      if (!auto) setStatus(panelT("status.captureBusy"));
      try {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          if (!auto) {
            setAttachHint(panelT("status.captureNeedSelection"));
            setStatus("");
          }
          return false;
        }
        const cap = await captureBrowserSelection(mySession);
        if (sessionIdRef.current !== mySession) return false; // 会话已切换 → 丢弃
        if (cap.captureType !== "candidate") {
          // Notes behavior 诊断修复：rejected 也落完整诊断到 console（不截断），UI 仍显示截断
          // 人话——用户/开发者可复制完整 reason + detail 定位（此前 rejected 不
          // console → 人无法自助诊断；见 real-LLM projection 调查）。
          try {
            console.error("[dsh-notes capture:rejected]", cap.reason, cap.detail ? JSON.stringify(cap.detail) : "");
          } catch { /* 诊断尽力而为 */ }
          const reason = String(cap.reason ?? panelT("status.captureInexact")).slice(0, 60);
          setAttachHint(
            auto
              ? panelT("status.captureErrorRetry", { reason })
              : panelT("status.captureError", { reason })
          );
          return false;
        }
        const v = await validateCandidate(cap.candidate);
        if (sessionIdRef.current !== mySession) return false; // 会话已切换 → 丢弃
        if (!v.ok) {
          try {
            console.error("[dsh-notes capture:validate-rejected]", v.reason, v.detail ? JSON.stringify(v.detail) : "");
          } catch { /* 诊断尽力而为 */ }
          const reason = String(v.reason ?? panelT("status.captureValidationFailed")).slice(0, 60);
          setAttachHint(
            auto
              ? panelT("status.captureErrorRetry", { reason })
              : panelT("status.captureError", { reason })
          );
          return false;
        }
        // host-validated proposal 展示（composer「引用的原文」只读预览）
        setAttachHint(null);
        setCapture({
          stage: "proposal",
          validated: v.validated,
          effective: v.validated.effectiveSourceText,
          unresolved: v.validated.unresolved || [],
        });
        setStatus(panelT("status.captureReady"));
        return true;
      } catch (e) {
        // 诊断：捕获失败时把栈打进 console，便于定位真实浏览器独有
        // 的异常（headless 不可复现）；用户侧只看到 composer 下方人话浅提示。
        console.error("[dsh-notes capture]", e);
        const reason = String((e && e.message) || e).slice(0, 60);
        if (!auto) setAttachHint(panelT("status.captureError", { reason }));
        return false;
      } finally {
        setCaptureBusy(false);
      }
    };

    const startCapture = () => { runAttach({ auto: false }); };

    // Notes behavior note-primary 自动附源：便签视图（非 rawView）下，打开面板 / 切到该会话
    // 时若存在非折叠 document selection，且当前无 capture/编辑态——自动执行一次
    // 正向 source proposal（复用 runAttach({ auto: true })）。ref guard 保证同一
    // panel 生命周期内每个 session 只尝试一次（避免打开面板即重复请求）；rawView /
    // 编辑态 / 已有 capture 下不自动附源。
    useEffect(() => {
      if (rawView) return;
      if (capture) return;
      if (captureBusy) return;
      if (editingIndex !== null) return;
      if (autoAttachedRef.current.has(sessionId)) return;
      autoAttachedRef.current.add(sessionId);
      runAttach({ auto: true });
      // eslint 不适用（无 lint）：deps 覆盖触发条件——rawView/capture/编辑态/会话
      // 变化都只会重新评估 guard，guard 已消费则不再发起请求。
    }, [sessionId, rawView, capture, captureBusy, editingIndex]);

    // Notes behavior explicit Save（内部流）：把 host-validated proposal 编码为 source-aware
    // block，追加到当前 lane body，走既有 whole-lane conflict-safe PUT。
    // Notes behavior：composer 保存 anchored 时以 commentOverride 传入 authored 文本
    // （captureComment 已无独立 UI——备注输入已收口进 composer 正文）；返回
    // boolean（true=已持久化保存成功），供 composer 判定后清空自身草稿。
    // 用户只面对 composer 的「保存便签」一个保存动作——本函数不是第二个 UI 入口。
    const saveCapture = async (commentOverride) => {
      if (!capture || capture.stage !== "proposal" || captureBusy) return false;
      // Notes behavior: Save 前校验 capture 仍绑定当前 session（防 session 切换后残留
      // proposal 被写入错误会话的 Notes）。session 切换 useEffect 已清除 capture，
      // 此处再加一道 Save 前守卫——命中即取消该 proposal（不可重试）。
      if (!capture.validated || capture.validated.sessionId !== sessionId) {
        setStatus(panelT("status.captureOtherSession"));
        setCapture(null);
        setCaptureComment("");
        setAttachHint(null);
        return false;
      }
      const comment = commentOverride !== undefined ? commentOverride : captureComment;
      setCaptureBusy(true);
      setStatus(panelT("label.statusSaving"));
      try {
        const r = await saveAnchoredCapture(capture.validated, {
          sessionId,
          lane: layerKey,
          comment,
        });
        if (!r.ok) {
          // host prepare 失败：技术 code 只出现在 footer status 小字；capture 保持
          // proposal 供「取消」或处理后再试（composer 草稿与引用预览不消失）。
          setStatus(panelT("status.saveFailed", { error: `${r.reason ?? "unknown"}${r.code ? ` (${r.code})` : ""}` }));
          return false;
        }
        // 追加 block 到当前 lane body → whole-lane PUT If-Match（复用 doPut）。
        // Notes behavior：为尚未携带 key 的 anchored block 补 holder-local item-key，复用
        // 既有 durable Note identity；旧/外部 block 若已有 key 则原样保留。
        const prepared = parseLaneBody(r.block);
        const preparedNode = prepared.nodes.find((node) => node.type === "item" && node.item?.kind === "source-aware");
        const block = preparedNode
          ? serializeItem(withItemKey(preparedNode.item, getItemKey(preparedNode.item) ?? newItemKey()))
          : r.block;
        // 保留原 text 的**所有字符**（含首尾空白/换行——Notes 文件是精确文本
        // 状态，不得 trim）；appendCaptureBlock 仅做安全 "\n\n" 分隔。
        const newBody = appendCaptureBlock(text, block);
        const ok = await doPut(newBody, mtime);
        if (ok) {
          setText(newBody);
          setCapture(null);
          setCaptureComment("");
          setStatus(panelT("status.saved"));
          return true;
        }
        // doPut 失败（409 等）→ 既有 conflict triage 处理，保持 capture 状态供重试
        return false;
      } catch (e) {
        console.error("[dsh-notes saveCapture]", e);
        const domPath = domPathOf(capture ? { validated: capture.validated, comment, lane: layerKey } : null, "");
        setStatus(panelT("status.saveFailed", { error: `${e.message}${domPath ? " (see console for details)" : ""}` }));
        return false;
      } finally {
        setCaptureBusy(false);
      }
    };

    // Notes behavior 内部 capture 重置：清 proposal 与独立备注输入（备注已收口进 composer 正文，
    // state 保留给内部默认值）。旧 disclosure 的「取消」按钮已移除——用户面的取消统一
    // 走 cancelComposer（其内部调用本函数，保证"取消后无残留 proposal"）。
    const cancelCapture = () => { setCapture(null); setCaptureComment(""); };

    // Notes behavior: 对一条 persisted source-aware item 发起 exact re-entry（read-only）。
    // locator = item.sourcePayload（persisted Source Anchor）。跨 session 目标需
    // 每请求显式确认（consent: per-request；host 不建 standing 授权）。结果按
    // status 分开展示，不混淆 exact / unavailable / incompatible / unauthorized。
    const reenterItem = async (item, index) => {
      if (reentry?.busy) return;
      const locator = item?.sourcePayload;
      if (!locator) {
        setReentry({ busy: false, kind: "incompatible", text: panelT("status.reentryIncompatibleEntry") });
        return;
      }
      const origin = item.captureOrigin || locator.sessionId;
      const cross = origin !== sessionId;
      if (cross && typeof window.confirm === "function") {
        // Notes behavior narrow UX（用户真实误解修正）：跨会话回来源 = 读取另一会话的 source
        // 并在**当前工作上下文**展示，**不会**因确认而切换到原会话页面。文案明确
        // 这一点，避免用户把"读取成功"误读成 navigation failure。same-session 路径
        // 无 confirm（仍为回来源 → 本会话内定位 + 高亮），不受本条影响。
        const ok = window.confirm(panelT("status.reentryConfirmCross", { origin }));
        if (!ok) return;
      }
      setReentry({ busy: true, kind: "loading", index });
      setStatus(panelT("status.reentryBusy"));
      try {
        const res = await notesFetch("/notes-api/reentry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // consent 恒为 per-request：host 无 request→session 可信 seam（Adapter
          // 不能证明 same-session——每次 dereference 都是显式 per-request
          // 用户动作（↪ 点击 / 跨会话确认），携带该标记；伪造 currentSessionId
          // 不能豁免。
          body: JSON.stringify({
            currentSessionId: sessionId,
            locator,
            noteRef: {
              holderSessionId: sessionId,
              laneKey: layerKey,
              ...(getItemKey(item) ? { itemKey: getItemKey(item) } : {}),
            },
            // UI transport only; host obtains historical S from durable Note.
            expectedSnapshot: item.snapshot,
            consent: "per-request",
            contextWindow: 2,
          }),
        });
        const json = await res.json().catch(() => null);
        if (!json) {
          setReentry({ busy: false, kind: "error", text: `HTTP ${res.status}` });
          setStatus(panelT("status.reentryFailed"));
          return;
        }
        if (!json.ok) {
          const kind = json.status === "unauthorized" ? "unauthorized" : json.status === "unavailable" ? "unavailable" : json.status === "incompatible" ? "incompatible" : "error";
          const historicalMismatch = json.code === "HISTORICAL_S_MISMATCH";
          if (historicalMismatch && json.sameSession && json.degradedCue?.kind === "whole-message") {
            const cue = locateAndApplyWholeMessageCue(json.degradedCue);
            const text = json.degradedCue.sourceMessage || json.currentSourceText || "";
            setReentry({
              busy: false,
              kind: "cue-whole",
              sameSession: true,
              text,
              historicalSnapshot: json.historicalSnapshot,
              currentSourceText: json.currentSourceText,
              highlighted: false,
              partial: false,
              wholeMessage: cue.wholeMessage,
              highlightedCount: cue.highlightedCount,
              wholeMessageCount: cue.wholeMessageCount,
              total: cue.total,
              detail: cue.detail,
            });
            setStatus(panelT("status.reentryHistoricalMismatch"));
            return;
          }
          setReentry({ busy: false, kind, code: json.code, text: json.reason || "", historicalSnapshot: json.historicalSnapshot, currentSourceText: json.currentSourceText });
          setStatus(kind === "unauthorized" ? panelT("status.reentryUnauthorized") : kind === "unavailable" ? panelT("status.reentryUnavailable") : historicalMismatch ? panelT("status.reentryMismatch") : kind === "incompatible" ? panelT("status.reentryIncompatible") : panelT("status.reentryFailed"));
          return;
        }
        if (json.sameSession) {
          const hl = locateAndHighlight(json.exact);
          if (hl.wholeMessage) {
            setReentry({
              busy: false, kind: "cue-whole", sameSession: true, text: json.exact.text,
              highlighted: false, partial: true, wholeMessage: true,
              highlightedCount: hl.highlightedCount, wholeMessageCount: hl.wholeMessageCount,
              total: hl.total, detail: hl.detail, context: json.context,
            });
            setStatus(panelT("status.reentryExactSpan"));
            return;
          }
          if (hl.highlightedCount === 0) {
            setReentry({
              busy: false, kind: "cue-unavailable", sameSession: true, text: json.exact.text,
              highlighted: false, partial: false, highlightedCount: 0, total: hl.total,
              detail: hl.detail, context: json.context,
            });
            setStatus(panelT("status.reentryNoCue"));
            return;
          }
          if (hl.partial) {
            // Partial cue is an explicit non-success transient outcome: exact
            // source was read, but the visible cue does not cover every locus.
            // This is UI feedback only, not a new durable lifecycle state.
            setReentry({
              busy: false, kind: "cue-partial", sameSession: true, text: json.exact.text,
              highlighted: false, partial: true, highlightedCount: hl.highlightedCount, total: hl.total,
              detail: hl.detail, context: json.context,
            });
            setStatus(panelT("status.reentryPartial", { found: hl.highlightedCount, total: hl.total }));
            return;
          }
          setReentry({
            busy: false, kind: "ok-exact", sameSession: true, text: json.exact.text,
            highlighted: hl.highlighted, partial: hl.partial,
            highlightedCount: hl.highlightedCount, total: hl.total, detail: hl.detail, context: json.context,
          });
          setStatus(hl.highlighted
            ? panelT("status.reentryExact")
            : panelT("status.reentryReadNoHighlight"));
        } else {
          setReentry({ busy: false, kind: "ok-exact", sameSession: false, text: json.exact.text, context: json.context });
          setStatus(panelT("status.reentryCrossSession"));
        }
      } catch (e) {
        setReentry({ busy: false, kind: "error", text: String(e?.message || e) });
        setStatus(panelT("status.reentryFailed"));
      }
    };

    // Notes behavior (Notes behavior): 当前 lane body 的 parse 结果（纯 parse，不改文本/元数据）。
    // 便签视图列表与 item 原位编辑都用它（legacy 段落 read-only 展示；item 卡片
    // 渲染 decoded 字段，不暴露 dsh-meta/source-payload 框架文本）。
    const parsedBody = useMemo(() => parseLaneBody(text), [text]);
    const itemCount = parsedBody.nodes.filter((n) => n.type === "item" && n.item).length;

    // ---- Notes behavior (view order / attention view)：纯展示层（render-only），view-only ----
    // “新/旧” = 当前 lane 中已有 Note 的**正向/反向展示**（不建时间模型）。物理旧→新
    // = composer 保存的 append 顺序（appendCaptureBlock 追加到 lane body 尾部）；“新
    // 记录在前” = 物理尾部在前。排序对象是 Note（authored + optional source）；Source
    // Anchor 存在与否/来源时间/event/locator **不参与**排序。view order ≠ durable
    // order：切换只改展示，绝不 rewrite/reorder lane Markdown、不改 provenance/
    // downstream；display order ≠ priority/execution/downstream processing。
    //
    // fork-merge 分组检测：lane 文本含 fork/carry eligibility decision 自有标记（lib/carry-merge.js
    // composeCarryMerge 在 parent/child 两侧都非空时写入的 “## 来自父分支” /
    // “## 当前分支已有内容” 标题，两侧全空/一侧空不生成 wrapper——见 carry-merge.js）。
    // 此类 lane 是 parent/child 分组文本：倒序会弄乱分组或伪造跨 branch 统一 chronology
    // → 该 lane **仅正序**（安全展示；不为此建新 model）。
    // 按 fork/carry eligibility decision 两侧 marker 同时出现精确检测，非启发式拆分 legacy。
    const laneHasForkMerge = isMergeWrapperBody(text);
    // 展示单元 = parsedBody.nodes 的**引用**（不复制节点）。倒序仅当 viewDir==='newest'
    // 且该 lane 无 fork-merge 分组。legacy 段作为 opaque unit 参与正/反向展示（不拆分）。
    // 每个单元携带物理 index physIndex（在 parsedBody.nodes 中的下标）：renderNoteCard
    // 的 key / collapsedSource / 编辑 / 删除全部仍以物理 index 锚定——倒序只改变视觉
    // 顺序，不改任何以物理 index 为锚的操作（编辑旧 Note 后位置不变；新保存 append 到
    // 物理尾部，在 newest-first 下显示于顶部）。
    const displayUnits = useMemo(() => {
      const units = parsedBody.nodes.map((node, i) => ({ node, physIndex: i }));
      return viewDir === "newest" && !laneHasForkMerge ? units.slice().reverse() : units;
    }, [parsedBody, viewDir, laneHasForkMerge]);

    const refresh = async () => {
      if (!confirmDiscard()) return;
      saveSeq.current++; // invalidate in-flight save (its response must not mutate state)
      setConflict(null);
      const targetKey = layerKey; // cross-tab guard: apply response only if still viewing it
      setStatus(panelT("status.loading"));
      try {
        const r = await notesFetch(url(targetKey));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.text();
        const mt = r.headers.get("x-notes-mtime") ?? "0";
        if (layerKey === targetKey && !dirtyRef.current) {
          setText(body);
          setMtime(mt);
          setDirty(false);
          setStatus("");
        }
      } catch (e) {
        if (layerKey === targetKey) setStatus(panelT("status.loadFailed", { error: e.message }));
      }
    };

    const switchLayer = (key) => {
      if (key === layerKey) return;
      if (!confirmDiscard()) return;
      saveSeq.current++; // invalidate in-flight save so old PUT results cannot leak in
      // Notes behavior lane-drift handling：lane 切换必须清除
      // capture——capture 的持久化目标是 Save 时的 lane；不清除则 L1 验证的
      // proposal 可能在切到 L2 后被 Save 到 L2（display A → persist 到另一
      // lane 的"状态漂移"）。与 session 切换清除同一模式：任何上下文切换都使
      // 已接受的 proposal 失效，需重新捕获。
      setCapture(null);
      setCaptureComment("");
      setReentry(null);
      // Notes behavior: lane 切换同时清 composer/编辑态（与 capture 清理一致——composer
      // 草稿是"当前上下文"的临时态，不跨 lane 保留）。
      setComposerText("");
      setEditingIndex(null);
      editingSigRef.current = null;
      setAttachHint(null);
      setConfirmingDelete(null);
      setText("");       // clear old layer content (avoid editing stale text pre-load)
      setMtime("0");
      setDirty(false);   // user confirmed discard → new layer load must not be blocked
      setConflict(null);
      setLayerKey(key);
    };

    // Conflict triage
    const loadLatest = () => {
      if (!conflict) return;
      setText(conflict.latest);
      setMtime(conflict.latestMtime);
      setDirty(false);
      setConflict(null);
      setStatus(panelT("status.loadedLatest"));
    };
    const forceSave = () => {
      if (!conflict) return;
      const baseline = conflict.latestMtime;
      setConflict(null);
      // I0-B: user explicitly chose "overwrite anyway" after seeing the 409
      // conflict → deliberate destructive overwrite via X-Notes-Overwrite: 1
      // (no If-Match precondition). Ordinary saves never take this path.
      doPut(text, baseline, true); // overwrite=true → explicit override header
    };

    // Notes behavior A2: 侧栏宽度（plugin-local 拖动 resize）。面板是插件自有的 fixed 覆盖层
    // （right:0 锚定）——拖动其左缘即可本地改宽，不改 DSH 共享 host layout、无新
    // host API/schema、无持久化宽度（关闭重开恢复默认 340）。min 280 / max 560
    // 保持主对话可用；无布局破坏。
    const [panelW, setPanelW] = useState(340);
    const panelWRef = useRef(340);
    panelWRef.current = panelW;
    const [resizing, setResizing] = useState(false);
    const resizeStartRef = useRef(null); // { startX, startW }
    const beginResize = (e) => {
      resizeStartRef.current = { startX: e.clientX, startW: panelWRef.current };
      setResizing(true);
      e.preventDefault();
    };
    useEffect(() => {
      if (!resizing) return;
      const move = (ev) => {
        const s = resizeStartRef.current;
        if (!s) return;
        const next = Math.min(560, Math.max(280, s.startW + (s.startX - ev.clientX)));
        setPanelW(Math.round(next));
      };
      const up = () => setResizing(false);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    }, [resizing]);

    const panelStyle = {
      position: "fixed", right: "0", top: "0", bottom: "0", width: `${panelW}px`,
      zIndex: 200, background: "#fff", borderLeft: "1px solid #ccc",
      boxShadow: "-4px 0 16px rgba(0,0,0,0.15)", display: "flex",
      flexDirection: "column", fontFamily: "system-ui, sans-serif", fontSize: "13px",
    };
    const resizeHandleStyle = {
      position: "absolute", left: "-4px", top: "0", bottom: "0", width: "8px",
      cursor: "ew-resize", zIndex: 210, touchAction: "none",
      ...(resizing ? { background: "rgba(99,102,241,0.18)" } : {}),
    };
    const btnStyle = {
      background: "none", border: "none", cursor: "pointer",
      padding: "4px 8px", fontSize: "13px", borderRadius: "6px",
    };

    // ================= Notes behavior (Notes behavior): coherent Note-primary UI =================
    // 便签视图（默认）：composer 卡片（新建 Note）+ 已保存 Notes 列表（parse 渲染，
    // Note-authored 为主、attached source 为辅助），旧的全层 textarea 编辑器收进
    // 默认折叠的“原文编辑（高级）”区。全部为 client 呈现层改造：不改 host/routes/
    // 存储语义；保存仍复用既有 whole-lane PUT If-Match（doPut / saveCapture）。
    // ------------------------------------------------------------------

    const composerTextareaStyle = {
      width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: "13px",
      lineHeight: "1.5", border: "1px solid #d1d5db", borderRadius: "6px",
      resize: "vertical", minHeight: "44px", fontFamily: "inherit", outline: "none",
      color: "#111827",
    };
    const srcToggleStyle = {
      fontSize: "11px", padding: "1px 6px", cursor: "pointer",
      background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: "4px",
      color: "#4338ca",
    };
    const primarySmallStyle = {
      fontSize: "12px", padding: "3px 10px", cursor: "pointer",
      background: "#2563eb", color: "#fff", border: "none", borderRadius: "6px",
    };
    // Notes behavior (Notes behavior r3)：便签正文 textarea placeholder——composer（新建）与卡片原位编辑
    // 共用同一文案（wireframe 5.1：正文可留空，以后再补写）。
    const noteBodyPlaceholder = panelT("label.noteBodyPlaceholder");

    // Notes behavior (Notes behavior r3) 单一创建流：取消 composer = 清正文草稿 + 清引用/attach 残留 +
    // 清删除确认。旧 Notes behavior 的"保存捕获"独立流已收口——取消后不得残留任何 proposal，
    // 避免把未保存的引用草稿带到下一次打开（"取消后无残留 proposal"）。
    const cancelComposer = () => {
      setComposerText("");
      setEditingIndex(null);
      editingSigRef.current = null;
      setAttachHint(null);
      cancelCapture(); // 清引用 proposal + 备注（取消后无残留 proposal）
      setConfirmingDelete(null);
    };

    // 卡片“来源”预览折叠 —— 仅视图状态（collapsedSource），不写存储、不发请求。
    const toggleSource = (i) => setCollapsedSource((prev) => ({ ...prev, [i]: !prev[i] }));

    // 把第 nodeIndex 条 parsed item node 的整块（含 payload 行）在 text 中的精确
    // 位置找出来。parseLaneBody 不暴露节点字节偏移，且 node.raw 刻意不含 payload
    // 行（raw 只覆盖 metadata 区）——不能拿 raw 当字节锚。这里用
    // serializeItem(parsedItem) 重放块文本（对合法 parse，序列化产物 == 原文该块
    // 的字节）做确定性行匹配：legacy 逐行推进；BEGIN_LINE 且与“下一个待消费 item
    // 的重建行”逐行相等 → 判定为该 item 块起点（duplicate 块也不串位）。
    // 返回 { start, end }（UTF-16 偏移）或 null（找不到——文本已变化）。
    const findItemSpan = (nodeIndex) => {
      const node = parsedBody.nodes[nodeIndex];
      if (!node || node.type !== "item") return null;
      const itemNodes = [];
      parsedBody.nodes.forEach((n, idx) => {
        if (n.type !== "item" || !n.item) return;
        const sig = serializeItem(n.item);
        itemNodes.push({ idx, lines: sig.split("\n"), len: sig.length });
      });
      const lines = text.split("\n");
      let offset = 0;
      let itemIdx = 0;
      let i = 0;
      while (i < lines.length) {
        if (lines[i] === BEGIN_LINE && itemIdx < itemNodes.length) {
          const cand = itemNodes[itemIdx];
          const n = cand.lines.length;
          let okMatch = i + n <= lines.length;
          if (okMatch) {
            for (let r = 0; r < n; r++) {
              if (lines[i + r] !== cand.lines[r]) { okMatch = false; break; }
            }
          }
          if (okMatch) {
            if (cand.idx === nodeIndex) return { start: offset, end: offset + cand.len };
            for (let r = 0; r < n; r++) offset += lines[i + r].length + 1;
            i += n;
            itemIdx++;
            continue;
          }
        }
        offset += lines[i].length + 1;
        i++;
      }
      return null;
    };

    // 把一条 item 放进 composer 编辑模式（composerText=其 authored；authored 空则
    // 留空 textarea，仍可保存为合法空 authored）。编辑起点存 block 指纹
    // （serializeItem(item)），保存时校验未漂移。
    const beginEdit = (node, nodeIndex) => {
      if (composerBusy || node.type !== "item" || !node.item) return;
      // 进入编辑态即退出其它上下文瞬态（删除确认/引用失败提示；引用 proposal 属
      // "新建"上下文，编辑另一条卡片不销毁它，但确认行与浅提示不应跨模式残留）。
      setConfirmingDelete(null);
      setAttachHint(null);
      setEditingIndex(nodeIndex);
      editingSigRef.current = serializeItem(node.item);
      setComposerText(node.item?.comment ?? "");
    };

    // composer 统一保存：编辑模式 / anchored 新建（capture proposal）/ 普通新建。
    // 全部走 whole-lane PUT If-Match（既有 mtime/doPut）；409 → 既有 conflict triage，
    // 不吞、不静默重试。成功返回前用 layerKeyRef/sessionIdRef 校验仍在原 lane/session
    // （防“保存中途切换”后把旧内容 setText 进新上下文——saveSeq 只保护 doPut 内部）。
    const saveComposer = async () => {
      if (composerBusy) return;
      setComposerBusy(true);
      try {
        if (setup?.state === "UNINITIALIZED") {
          setupContinuationRef.current = { kind: "composer", sessionId, layerKey };
          setStatus(panelT("status.setupContinue"));
          return;
        }
        // ---- 编辑模式：重建该条 block 并整层原位替换该块位置后 PUT ----
        if (editingIndex !== null) {
          const idx = editingIndex;
          const node = parsedBody.nodes[idx];
          if (!node || node.type !== "item" || !node.item || serializeItem(node.item) !== editingSigRef.current) {
            setStatus(panelT("status.contentChanged"));
            return;
          }
          const item = node.item;
          if (item.kind === "source-independent" && !hasSubstantiveAuthoredContent(composerText)) {
            setStatus(panelT("status.noContent"));
            return;
          }
          const opts = {
            kind: item.kind,
            captureOrigin: item.captureOrigin,
            comment: composerText,
            unknownMeta: item.unknownMeta,
          };
          // sourcePayload 与 snapshot 原样保留（不得改写 locator/snapshot）；
          // source-independent 不携带 snapshot/sourcePayload。
          if (item.kind === "source-aware") {
            opts.snapshot = item.snapshot ?? "";
            opts.sourcePayload = item.sourcePayload;
          }
          let block;
          try {
            block = serializeItem(makeItem(opts));
          } catch (e) {
            setStatus(panelT("status.saveFailed", { error: e.message }));
            return;
          }
          const span = findItemSpan(idx);
          if (!span) {
            setStatus(panelT("status.contentChanged"));
            return;
          }
          const newBody = text.slice(0, span.start) + block + text.slice(span.end);
          const myKey = layerKey;
          const mySession = sessionId;
          const ok = await doPut(newBody, mtime);
          if (!ok) return; // 409 → 既有 conflict triage（编辑态保留供处理冲突后重试）
          if (layerKeyRef.current !== myKey || sessionIdRef.current !== mySession) return; // stale
          setText(newBody);
          setComposerText("");
          setEditingIndex(null);
          editingSigRef.current = null;
          setAttachHint(null);
          setConfirmingDelete(null);
          setStatus(panelT("status.savedEdit"));
          return;
        }
        // ---- 新建模式（单一创建流：一条「保存便签」同时负责 anchored / 普通）----
        const cap = capture;
        if (cap && cap.stage === "proposal") {
          // anchored：composerText 作为 authored（可空）写入 captureComment，
          // 复用既有 saveCapture（host anchored prepare + append + whole-lane PUT）。
          // 用户只按过一次「保存便签」——内部 mechanics 不变，无第二个保存动作。
          setCaptureComment(composerText);
          const ok = await saveCapture(composerText);
          if (ok) {
            setComposerText("");
            setAttachHint(null);
            setConfirmingDelete(null);
            setStatus(panelT("status.savedNote"));
          }
          return;
        }
        if (!hasSubstantiveAuthoredContent(composerText)) {
          // 空便签守卫：authored 空 且 无 source → 不创建（保留既有拒绝提示语义；
          // both-empty 情形不新增产品语义——注释于 2026-09-04 Notes behavior/Notes behavior r3 重申）。
          setStatus(panelT("status.noContent"));
          return;
        }
        // source-independent：serializeItem(makeItem(...)) → append → whole-lane PUT。
        // Notes behavior：新保存 Note 在创建时 mint holder-local opaque item-key（unknown-meta
        // row，inert adapter bookkeeping）——让后续 UI 跨 reload/resume 可稳定引用该条。
        const block = serializeItem(withItemKey(makeItem({
          kind: "source-independent",
          captureOrigin: sessionId,
          comment: composerText,
        }), newItemKey()));
        const newBody = appendCaptureBlock(text, block);
        const myKey = layerKey;
        const mySession = sessionId;
        const ok = await doPut(newBody, mtime);
        if (!ok) return; // 409 → 既有 conflict triage（composer 草稿保留）
        if (layerKeyRef.current !== myKey || sessionIdRef.current !== mySession) return; // stale
        setText(newBody);
        setComposerText("");
        setAttachHint(null);
        setConfirmingDelete(null);
        setStatus(panelT("status.savedNote"));
      } finally {
        setComposerBusy(false);
      }
    };
    saveComposerRef.current = saveComposer;

    // Notes behavior (Notes behavior r3) 删除整条 note——卡片内联确认（替代 window.confirm）。只对 item
    // 卡片提供入口；legacy 段落保持只读（可在「原文编辑」改）。
    // 点 [删除…] → 该卡片内出现确认行（确认/取消都在卡片内）；确认后：findItemSpan
    // 定位该 block → 从当前 lane body 整块移除（tidyAfterBlockRemoval 顺带压缩
    // block 前后多余的空白分隔，保持文件整洁）→ 既有 whole-lane PUT If-Match
    // （doPut）→ setText + 状态「已删除便签」。取消/拒绝 → 不做任何写。删除的是
    // **整条 item**（含它的来源关系），无 source-only delete / recapture /
    // replacement / detach；不新增 trash/history。
    const requestDelete = (i) => {
      const node = parsedBody.nodes[i];
      if (!node || node.type !== "item" || !node.item) return;
      if (editingIndex !== null || composerBusy || captureBusy) return;
      setConfirmingDelete(i);
    };
    const cancelDelete = () => setConfirmingDelete(null);
    const confirmDelete = async (i) => {
      const node = parsedBody.nodes[i];
      if (!node || node.type !== "item" || !node.item) return;
      if (editingIndex !== null || composerBusy || captureBusy) return;
      const span = findItemSpan(i);
      if (!span) {
        setStatus(panelT("status.contentChanged"));
        setConfirmingDelete(null);
        return;
      }
      const newBody = tidyAfterBlockRemoval(text, span);
      const myKey = layerKey;
      const mySession = sessionId;
      const ok = await doPut(newBody, mtime);
      if (!ok) return; // 409 → 既有 conflict triage（确认行保留，冲突处理后重试）
      if (layerKeyRef.current !== myKey || sessionIdRef.current !== mySession) return; // stale
      setText(newBody);
      // Notes behavior: 删除整条 Note → itemKey 随该 item 消失；local Pin 条目变为 stale。
      // 不 prune 也绝不 rebind（渲染只认 lane 中真实存在的 key → 无 ghost pin）。
      setConfirmingDelete(null);
      setStatus(panelT("status.deleted"));
    };

    // ---- Notes behavior: 置顶 / 取消置顶（holder-local Pin preference）----
    // 目标 mental model：置顶 group 在列表顶部；普通便签在其下；两 group 内部都继续
    // 遵循当前 Notes behavior view direction（newest = 原 item sequence 反向 / oldest = 正向）。
    // Pin 只写 browser localStorage（readPinMap/writePinMap）；**绝不写 lane body**。
    // 对尚无 item-key 的旧 item（pre-legacy keyless format / agent 直写内容），第一次置顶先做 identity-
    // only migration（durable whole-lane PUT If-Match 给该 block 补一条 opaque
    // item-key row，不改 authored/source/provenance/order）——成功后才写 Pin map；
    // 两段各自 truthful（partial failure：key 写成功但 localStorage 失败 → key 保留
    // 无害、UI 如实报「置顶未保存」；key 写失败 → 不产生 pin entry）。
    const togglePin = async (i) => {
      const node = parsedBody.nodes[i];
      if (!node || node.type !== "item" || !node.item) return;
      if (editingIndex !== null || composerBusy || captureBusy || laneHasForkMerge) return;
      const myKey = layerKey;
      const mySession = sessionId;
      const persistPin = (nextKeys, alreadyKeyed) => {
        const okWrite = writePinMap(mySession, myKey, nextKeys);
        if (!okWrite) {
          setStatus(alreadyKeyed
            ? panelT("status.pinNotSaved")
            : panelT("status.pinKeySavedNotPin"));
          return false;
        }
        setPinKeys(nextKeys);
        return true;
      };
      // 1) 确保 item 有 holder-local item-key（旧 item 惰性 identity migration）
      let key = getItemKey(node.item);
      if (!key) {
        const newKey = newItemKey();
        const block = serializeItem(withItemKey(node.item, newKey));
        const span = findItemSpan(i);
        if (!span) {
          setStatus(panelT("status.contentChanged"));
          return;
        }
        const newBody = text.slice(0, span.start) + block + text.slice(span.end);
        const okPut = await doPut(newBody, mtime);
        if (!okPut) return; // 409 → 既有 conflict triage（不产生 pin entry）
        if (layerKeyRef.current !== myKey || sessionIdRef.current !== mySession) return;
        setText(newBody);
        key = newKey; // durable key 已落盘；local Pin 失败时 key 仍无害保留
      }
      // 2) 翻转 holder-local Pin map
      // Notes behavior adversarial-A：以「目标 lane（= layerKey，jump 后即 result lane）的持久化 pin
      // 集合」为基线，而不是 React closure 里的 pinKeys——跨 lane 搜索结果跳转执行
      // Pin/Unpin 时 lane 刚切换，pinKeys state 可能尚未提交到新 lane，用陈旧集合做
      // 基线会把别的 lane 的 key 写进目标 lane（跨 lane 污染）。读 storage = 单一
      // truth，Pin/Unpin 永远只翻转目标 lane 自己的 itemKey 集合。
      const next = new Set(readPinMap(mySession, myKey));
      const nowPinned = !next.has(key);
      if (nowPinned) next.add(key);
      else next.delete(key);
      const ok = persistPin(next, Boolean(key));
      if (ok) setStatus(nowPinned ? panelT("status.pinned") : panelT("status.unpinned"));
      // !ok → persistPin 已设 truthful 失败状态（不覆盖成成功）
    };

    // Notes behavior: result-card 操作跳转——编辑/删除/置顶（keyless migration）指向的 Note
    // 可能属于非 active lane；这里先把 active lane 切到目标 lane，加载后再定位到
      // physIndex 并执行动作。定位规则：
    //   - 有 itemKey：按 itemKey 唯一命中（重复 Note 各自不同 key → 不歧义）；
    //   - 无 itemKey：jumpTarget 携带 { physIndex, sig }，只接受“该物理位置仍是指纹
    //     相同的 item”——若位置漂移/内容已变，**明确失败**，绝不“指纹命中第一条”。
    // 绝不使用 visible result index 作持久 identity。跳转目标每轮只消费一次。
    useEffect(() => {
      if (!jumpTarget || jumpTarget.laneKey !== layerKey) return;
      if (text === "") return; // lane 尚未加载完（switchLayer 已清 text）
      const { itemKey, sig, physIndex, action } = jumpTarget;
      let found = -1;
      if (itemKey) {
        parsedBody.nodes.forEach((node, i) => {
          if (found >= 0) return;
          if (node.type !== "item" || !node.item) return;
          if (getItemKey(node.item) === itemKey) found = i;
        });
        if (found < 0) {
          setStatus(panelT("status.contentChanged"));
          setJumpTarget(null);
          return;
        }
      } else {
        // keyless：物理位置 + 指纹双确认；歧义/漂移 → 明确失败（不退回第一条）
        const node = parsedBody.nodes[physIndex];
        const okPos =
          node && node.type === "item" && node.item && sig && serializeItem(node.item) === sig;
        if (!okPos) {
          setStatus(panelT("status.contentChanged"));
          setJumpTarget(null);
          return;
        }
        found = physIndex;
      }
      const seq = ++jumpSeqRef.current;
      const node = parsedBody.nodes[found];
      if (action === "edit") beginEdit(node, found);
      else if (action === "delete") requestDelete(found);
      else if (action === "pin") togglePin(found);
      else if (action === "reentry") reenterItem(node.item, found);
      setJumpTarget(null);
      return () => { if (jumpSeqRef.current === seq) setJumpTarget(null); };
    }, [jumpTarget, layerKey, parsedBody, text]);

    // ---- 便签卡片渲染（authored 为主；来源为辅助；绝不呈现 raw 框架文本）----
    // Notes behavior note-primary 卡片：顶部 11px 灰字元信息行区分类型（source-aware →
    // 「带来源便签」/ source-independent → 「便签」）+ 当前 lane 短标（displayId，
    // 如 L1；只用现成字段，不引入新存储）；空 authored → 明确占位
    // [空便签——之后可补写]（仍显示引用的原文）；source-aware 卡片区块标题用用户
    // 语言「引用的原文」（替换旧 “Source · attached source”），折叠按钮
    // 「来源 ▾/▸」保留、内含只读 snapshot + [↪ 回来源]；操作行 [编辑] [删除…]
    // （删除走卡片内联确认——点 [删除…] 后该卡片内出现确认行，非 window.confirm）。
    const laneTag = (current()?.displayId ? " · " + current().displayId : "");
    const renderNoteCard = (node, i) => {
      if (node.type === "legacy") {
        return createElement(
          "div",
          { key: "legacy-" + i, style: { padding: "6px 10px", color: "#4b5563", fontSize: "13px", whiteSpace: "pre-wrap", lineHeight: "1.5", borderBottom: "1px dashed #e5e7eb" } },
          node.text
        );
      }
      const item = node.item || {};
      const authored = item.comment ?? "";
      const isAnchored = item.kind === "source-aware";
      const collapsed = Boolean(collapsedSource[i]);
      const isEditing = editingIndex === i;
      const askingDelete = confirmingDelete === i;
      const actionDisabled = editingIndex !== null || composerBusy || captureBusy;
      const cardBtnEditStyle = { fontSize: "11px", padding: "1px 10px", cursor: "pointer", background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: "4px", color: "#374151" };
      const cardBtnDeleteStyle = { fontSize: "11px", padding: "1px 10px", cursor: "pointer", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "4px", color: "#b91c1c" };
      return createElement(
        "div",
        { key: "note-" + i, style: { margin: "0 10px 8px", border: isEditing ? "1px solid #c7d2fe" : "1px solid #e5e7eb", borderRadius: "8px", padding: "6px 8px", background: isEditing ? "#faf9ff" : "#ffffff" } },
        // 卡片元信息行（11px 灰；区分 source-aware / source-independent 类型 + lane）
        createElement("div", { style: { fontSize: "11px", color: "#6b7280", marginBottom: "3px" } },
          (isAnchored ? panelT("label.anchoredNote") : panelT("label.note")) + laneTag),
        // 编辑行为：编辑在卡片**原位**展开（不回顶部框）；authored 为主文字
        isEditing
          ? createElement(
              "div",
              null,
              createElement("textarea", {
                value: composerText,
                onChange: (e) => { setComposerText(e.target.value); setStatus(""); },
                placeholder: noteBodyPlaceholder,
                style: { ...composerTextareaStyle, border: "1px solid #ddd6fe", borderRadius: "4px", padding: "4px 6px" },
              }),
              createElement(
                "div",
                { style: { display: "flex", gap: "6px", marginTop: "4px", alignItems: "center" } },
                createElement("button", { onClick: saveComposer, disabled: composerBusy || captureBusy, style: primarySmallStyle }, panelT("button.saveEdit")),
                createElement("button", { onClick: cancelComposer, disabled: composerBusy, style: { ...btnStyle, color: "#6b7280", fontSize: "12px" } }, panelT("button.cancel")),
                composerBusy ? createElement("span", { style: { color: "#888", fontSize: "11px" } }, panelT("label.statusSaving")) : null
              ),
              isAnchored ? createElement("div", { style: { fontSize: "11px", color: "#6d28d9", marginTop: "4px" } }, panelT("label.noteSourceChanged")) : null
            )
          : authored !== ""
            ? createElement("div", { style: { whiteSpace: "pre-wrap", fontSize: "14px", lineHeight: "1.5", color: "#111827" } }, authored)
            : createElement("div", { style: { color: "#9ca3af", fontStyle: "italic", fontSize: "12.5px" } }, panelT("label.emptyNote")),
        // 引用的原文（source-aware 卡片）辅助小框：snapshot 只读预览（可折叠，仅视图
        // 状态；不折叠也绝不呈现 raw 框架文本）
        isAnchored
          ? createElement(
              "div",
              { style: { marginTop: "5px", border: "1px solid #ddd6fe", borderRadius: "5px", background: "#faf5ff", padding: "3px 6px" } },
              createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#6d28d9" } },
                createElement("button", { onClick: () => toggleSource(i), style: srcToggleStyle, title: panelT("label.sourceToggle" ) }, collapsed ? panelT("button.sourceCollapsed") : panelT("button.sourceExpanded")),
                createElement("span", { style: { fontWeight: 600 } }, panelT("label.source")),
                createElement("span", { style: { flex: "1" } }),
                createElement(
                  "button",
                  { onClick: () => reenterItem(item, i), disabled: reentry?.busy || !item.sourcePayload, title: panelT("label.sourceReadonly"), style: { fontSize: "11px", padding: "1px 6px", cursor: "pointer", background: item.sourcePayload ? "#eef2ff" : "#eee", border: "1px solid #c7d2fe", borderRadius: "4px" } },
                  item.sourcePayload ? panelT("button.reenter") : panelT("button.reenterUnavailable")
                )
              ),
              collapsed
                ? null
                : createElement("div", { style: { whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", fontSize: "11px", color: "#4c1d95", maxHeight: "64px", overflow: "auto", marginTop: "2px" } },
                    String(item.snapshot ?? ""))
            )
          : null,
        // 底部区：编辑态不显示；否则 = 删除内联确认行（askingDelete）或 操作行
        isEditing
          ? null
          : askingDelete
            ? createElement(
                "div",
                { style: { borderTop: "1px dashed #fecaca", marginTop: "5px", paddingTop: "4px", fontSize: "12px", color: "#374151" }, "data-confirm-delete": "1" },
                createElement("div", null, panelT("label.deleteConfirm")),
                createElement(
                  "div",
                  { style: { display: "flex", gap: "6px", marginTop: "4px" } },
                  createElement("button", { onClick: () => confirmDelete(i), disabled: actionDisabled, style: { ...cardBtnDeleteStyle, background: "#dc2626", color: "#fff", borderColor: "#dc2626" } }, panelT("button.deleteConfirm")),
                  createElement("button", { onClick: cancelDelete, disabled: actionDisabled, style: { ...cardBtnEditStyle } }, panelT("button.cancel"))
                )
              )
            : createElement(
                "div",
                { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px", marginTop: "4px" } },
                // Notes behavior: whole-Note 勾选（发送下一条消息时把这条便签附上引用）。
                // 同一 Note 经 lane/Search/Pin/viewDir 多 UI 路径只占一个 entry——
                // checked 直接读 selSet（keyed holder+lane+itemKey），无 per-view 副本。
                // 无 itemKey 的 keyless item / legacy 段不可选（无 stable key → 提交时
                // 无法 re-resolve → 宁不可选不 silent subset）。
                (() => {
                  const ik = getItemKey(item) ?? "";
                  const selectable = ik !== "";
                  const selected = selectable && selSet.has(selKeyOf(layerKey, ik));
                  return createElement(
                    "label",
                    {
                      title: selectable
                        ? panelT("label.quoteTitle")
                        : panelT("label.quoteUnavailable"),
                      style: { display: "flex", alignItems: "center", gap: "3px", fontSize: "11px", color: selectable ? "#1e40af" : "#9ca3af", cursor: selectable && !selBusy && !actionDisabled && selHydrated ? "pointer" : "not-allowed", userSelect: "none" },
                    },
                    createElement("input", {
                      type: "checkbox",
                      checked: selected,
                      disabled: !selectable || selBusy || !selHydrated || actionDisabled,
                      onChange: () => toggleSelection(layerKey, ik),
                      "data-select": "1",
                      "aria-label": panelT("label.quoteAria"),
                      style: { cursor: "inherit", margin: "0" },
                    }),
                    panelT("button.quote")
                  );
                })(),
                createElement(
                  "div",
                  { style: { display: "flex", gap: "6px", alignItems: "center" } },
                  // Notes behavior: 置顶 / 取消置顶（holder-local Pin preference；纯 browser-local，
                  // 不写 lane）。fork-merge wrapper lane 隐藏（pin 会打乱 parent/child
                  // 分组——与 Notes behavior 的分组规则同构。无 alarm/priority 样式。
                  !laneHasForkMerge
                    ? createElement(
                        "button",
                        {
                          onClick: () => togglePin(i),
                          disabled: actionDisabled,
                          "data-pin": item ? (pinKeys.has(getItemKey(item) ?? "") ? "1" : "0") : "0",
                          style: { fontSize: "11px", padding: "1px 10px", cursor: "pointer", background: pinKeys.has(getItemKey(item) ?? "") ? "#fef9c3" : "#f3f4f6", border: "1px solid #e5e7eb", borderRadius: "4px", color: "#374151" },
                        },
                        pinKeys.has(getItemKey(item) ?? "") ? panelT("button.unpin") : panelT("button.pin")
                      )
                    : null,
                  createElement(
                    "button",
                    { onClick: () => beginEdit(node, i), disabled: actionDisabled, style: cardBtnEditStyle },
                    panelT("button.edit")
                  ),
                  createElement(
                    "button",
                    { onClick: () => requestDelete(i), disabled: actionDisabled, title: panelT("label.deleteTitle"), style: cardBtnDeleteStyle },
                    panelT("button.delete")
                  )
                )
              )
      );
    };

    // composer 卡片（新建 Note）——Notes behavior (Notes behavior r3) 单一创建流，自上而下：
    //   1. 标题「新便签」（右侧工具行小按钮「引用选中到便签」：手动触发 attach，
    //      自动附源没跑/选区变化时用；文案保持人话）；
    //   2. 区块「引用的原文」：仅存在 host-validated proposal（capture 状态）时显示
    //      ——只读引用文本预览 + 一行浅色小字「已附加来源 · 可回到原处」（不显示
    //      technical 词）；新建草稿阶段不提供「回来源」（引用尚未持久化——避免对
    //      未保存草稿做 re-entry 语义混淆；保存后卡片上的 ↪ 回来源保留）。无
    //      proposal 时不渲染空 source 盒（不得伪造空 Source Anchor）；
    //   3. 区块「便签正文」：textarea（placeholder「（可留空，以后再补）」）；用户已
    //      输入正文且未引用时，正文下方留轻提示「（未引用原文——保存为普通便签）」；
    //   4. 按钮行 [保存便签] [取消]。
    // 旧的 Notes behavior “拟保存的 source 捕获 / effective / unresolved / 备注（可选）/
    // 保存捕获” 独立 disclosure 已从便签视图移除（rawView 也不显示——那是全层
    // 编辑器，不是 capture 流）。内部 validate/prepare/append/whole-lane PUT 不变，
    // 用户只看到 composer 一个保存动作。「取消」清正文 + 清引用/attach 残留
    // （cancelComposer；取消后无残留 proposal）。引用失败的浅提示（attachHint）放
    // composer 下方，不阻塞纯便签保存。
    const attachBtnStyle = {
      fontSize: "12px", padding: "3px 10px", cursor: "pointer",
      background: "#eef2ff", border: "1px solid #c7d2fe",
      borderRadius: "6px", color: "#4338ca",
    };
    const composerCardEl = createElement(
      "div",
      { style: { margin: "6px 8px 12px", padding: "8px 10px", background: "#f1f5ff", border: "1px solid #cbd5f0", borderRadius: "8px", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }, "data-composer": "1" },
      createElement(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px", marginBottom: "5px" } },
        createElement("span", { style: { fontWeight: 700, fontSize: "13px", color: "#4f46e5", letterSpacing: "0.2px" } }, panelT("label.newNote")),
        createElement(
          "button",
          {
            onClick: startCapture,
            disabled: captureBusy,
            title: panelT("label.quoteSelectionTitle"),
            style: attachBtnStyle,
          },
          panelT("button.quoteSelection")
        )
      ),
      capture && capture.stage === "proposal" && editingIndex === null
        ? createElement(
            "div",
            { style: { border: "1px solid #ddd6fe", borderRadius: "5px", background: "#f5f3ff", padding: "5px 8px", marginBottom: "5px" } },
            createElement("div", { style: { fontSize: "11px", color: "#6d28d9", fontWeight: 600, marginBottom: "2px" } },
              panelT("label.source")),
            createElement("div", { style: { whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace", fontSize: "11px", color: "#4c1d95", maxHeight: "72px", overflow: "auto" } },
              String(capture.effective || "")),
          )
        : null,
      createElement("div", { style: { fontSize: "11px", color: "#6b7280", marginBottom: "2px" } }, panelT("label.noteBody")),
      createElement("textarea", {
        value: composerText,
        onChange: (e) => { setComposerText(e.target.value); setStatus(""); },
        placeholder: noteBodyPlaceholder,
        style: { ...composerTextareaStyle },
      }),
      // 轻提示：已输入正文但未引用原文 → 保存为普通便签（无空 source 盒）
      composerText.trim() !== "" && !(capture && capture.stage === "proposal")
        ? createElement("div", { style: { color: "#9ca3af", fontSize: "11px", marginTop: "3px" } },
            panelT("label.noteNoSource"))
        : null,
      createElement(
        "div",
        { style: { display: "flex", gap: "6px", marginTop: "6px", alignItems: "center" } },
        createElement("button", { onClick: saveComposer, disabled: composerBusy || captureBusy, style: primarySmallStyle }, panelT("button.saveNote")),
        createElement("button", { onClick: cancelComposer, disabled: composerBusy, style: { ...btnStyle, color: "#6b7280", fontSize: "12px" } }, panelT("button.cancel")),
        composerBusy ? createElement("span", { style: { color: "#888", fontSize: "11px" } }, panelT("label.statusSaving")) : null
      ),
      // 引用失败的浅提示（自动附源没精确匹配 / 手动引用失败）——在 composer 下方
      // 一行，人话小字；只提示、不阻塞纯便签保存、不做主导航 error 框
      attachHint
        ? createElement("div", { style: { color: "#92400e", fontSize: "11px", lineHeight: "1.4", marginTop: "4px" } }, attachHint)
        : null
    );

    // ---- Notes behavior: current-holder keyword search（findability view）----
    // 只读搜索 current holder × four lanes 的 whole Note；结果按 lane 分组、组内保留
    // Notes behavior view semantics（newest=反向/oldest=正向；fork-merge lane 恒正序）。每一条
    // result 都是完整 Note（可辨 lane），操作（编辑/删除/置顶/回来源）经 jumpTarget
    // 切到该 Note 所属 lane 并以稳定 identity 定位——绝不使用 visible result index。
    // 搜索状态独立：不改 lane/不写 Notes/Pin/不持久化 query；search ≠ Pin ≠ selection
    // （Notes behavior future selection 可跨 query/lane 存活——见 Notes behavior addendum constraint）。
    const jumpToNote = (row, action) => {
      if (row?.node?.type !== "item" || !row.node.item) return;
      // Before result actions, handle unsaved drafts—composer text / capture proposal /
      // 进行中的 inline edit draft 若存在，先明确确认；拒绝则不做任何跳转/替换（避免
      // beginEdit 直接覆盖 composerText/editingIndex 而无确认）。
      const hasDraft =
        composerBusy || captureBusy ||
        (composerText ?? "").trim() !== "" ||
        Boolean(capture && capture.stage === "proposal") ||
        editingIndex !== null;
      if (hasDraft && typeof window.confirm === "function") {
        const keep = window.confirm(panelT("status.operationDiscard"));
        if (!keep) return;
        cancelComposer(); // 用户已确认丢弃 → 清 composer/编辑态/引用 proposal
      } else if (hasDraft) {
        return; // 无 confirm 可用（异常环境）→ 保守不跳转
      }
      const itemKey = getItemKey(row.node.item) ?? undefined;
      // Keyless hits carry physIndex + sig; accept only when that physical position still matches.
      const jump = { laneKey: row.key, action };
      if (itemKey) jump.itemKey = itemKey;
      else { jump.physIndex = row.physIndex; jump.sig = serializeItem(row.node.item); }
      // 关闭搜索并切到目标 lane；active lane 相同则仅定位（text 已加载）。
      setSearchOpen(false);
      setSearchQuery("");
      setSearchResults(null);
      if (layerKey !== row.key) switchLayer(row.key);
      setJumpTarget(jump);
    };
    const searchRowEl = createElement(
      "div",
      { style: { display: "flex", gap: "6px", alignItems: "center", padding: "4px 10px 0", fontSize: "12px" } },
      // Notes behavior A1: Search 视觉区分——🔍 图标 + 明确的 placeholder + 与"新便签"composer
      // 不同的浅色底/边框（search ≠ create 一瞥可辨）。纯插件本地呈现：不加过滤器/
      // 标签/语义搜索/新查询态；搜索行为、清空、×Pin×Notes behavior 全不变。
      createElement(
        "span",
        { "aria-hidden": "true", style: { fontSize: "13px", color: "#64748b", lineHeight: "1", paddingLeft: "2px" } },
        "🔍"
      ),
      createElement("input", {
        type: "search",
        value: searchQuery,
        onChange: (e) => setSearchQuery(e.target.value),
        placeholder: panelT("label.searchPlaceholder"),
        "data-search-input": "1",
        "aria-label": panelT("label.searchAria"),
        title: panelT("label.searchTitle"),
        style: {
          flex: "1", minWidth: "0",
          border: "1px solid #cbd5e1", borderRadius: "6px",
          padding: "4px 8px", fontSize: "13px", outline: "none",
          background: "#f8fafc", color: "#334155",
        },
        onFocus: (e) => { e.target.style.borderColor = "#4f46e5"; e.target.style.boxShadow = "0 0 0 3px rgba(79,70,229,0.28)"; e.target.style.background = "#eef2ff"; },
        onBlur: (e) => { e.target.style.borderColor = "#cbd5e1"; e.target.style.boxShadow = "none"; e.target.style.background = "#f8fafc"; },
      }),
      // Notes behavior adversarial-B：Search 视图直接暴露**同一个**全局 Notes behavior newest/oldest 控件（复用
      // viewDir state，绝不建 searchViewDir / searchOrder）。仅在 query 非空（结果区
      // 显示）时出现，避免与空 query 时普通列表头部的 data-view-dir 重复。fork-merge
      // lane 无视 viewDir（恒 group-preserving 正序），但搜索跨 lane，其余普通 lane
      // 仍服从该全局控件，故不按 active lane 的 merge 态隐藏。
      searchQuery.trim() !== ""
        ? createElement(
            "select",
            {
              value: viewDir,
              onChange: (e) => setViewDir(e.target.value),
              "data-view-dir": "1",
              "aria-label": panelT("label.orderAria"),
              title: panelT("label.orderTitleSearch"),
              style: {
                fontSize: "11px", padding: "1px 4px", border: "1px solid #d1d5db",
                borderRadius: "4px", background: "#fff", color: "#374151",
                cursor: "pointer", letterSpacing: "0",
              },
            },
            createElement("option", { value: "newest" }, panelT("button.newest")),
            createElement("option", { value: "oldest" }, panelT("button.oldest"))
          )
        : null,
      createElement("button", { onClick: () => { setSearchOpen(false); setSearchQuery(""); setSearchResults(null); }, style: { ...btnStyle, color: "#6b7280", fontSize: "12px" } }, panelT("label.searchClose"))
    );
    // 渲染一条 whole-Note result（lane 标签 + authored/snapshot 摘要 + 操作跳转）。
    // legacy node = parser 已认定的一个 opaque whole unit（E5）：整体呈现、可整段命中、
    // 不拆分、无编辑/删除/置顶/回来源 操作（legacy 无 identity/语义，Notes behavior 同构）。
    const renderSearchRow = (row) => {
      if (row.node.type === "legacy") {
        return createElement(
          "div",
          { key: row.key + "-" + row.physIndex, style: { margin: "0 10px 6px", border: "1px dashed #d1d5db", borderRadius: "8px", padding: "5px 8px", background: "#fafafa" }, "data-search-result": "1" },
          createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "#6b7280", marginBottom: "2px" } },
            createElement("span", { style: { fontWeight: 600 } }, `${panelT("label.legacy")} · ${row.label}`),
            createElement("span", { style: { color: "#2563eb", fontWeight: 600 } }, panelT("label.match"))
          ),
          createElement("div", { style: { whiteSpace: "pre-wrap", fontSize: "12.5px", lineHeight: "1.5", color: "#4b5563" } }, String(row.node.text ?? ""))
        );
      }
      const item = row.node.item || {};
      const authored = item.comment ?? "";
      const anchored = item.kind === "source-aware";
      // /meta already supplies the composed displayId + descriptive label.
      // Keep the structural value intact instead of composing displayId twice.
      const laneLabel = row.label || row.displayId || row.key;
      const sig = serializeItem(row.node.item);
      return createElement(
        "div",
        { key: row.key + "-" + row.physIndex, style: { margin: "0 10px 6px", border: "1px solid #e5e7eb", borderRadius: "8px", padding: "5px 8px", background: "#fff" }, "data-search-result": "1" },
        createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "11px", color: "#6b7280", marginBottom: "2px" } },
          createElement("span", { style: { fontWeight: 600 } }, `${anchored ? panelT("label.anchoredNote") : panelT("label.note")} · ${laneLabel}`),
          createElement("span", { style: { color: "#2563eb", fontWeight: 600 } }, panelT("label.match"))
        ),
        authored !== ""
          ? createElement("div", { style: { whiteSpace: "pre-wrap", fontSize: "13px", lineHeight: "1.45", color: "#111827" } }, authored)
          : createElement("div", { style: { color: "#9ca3af", fontStyle: "italic", fontSize: "12.5px" } }, panelT("label.emptyNote")),
        anchored
          ? createElement("div", { style: { marginTop: "4px", border: "1px solid #ddd6fe", borderRadius: "5px", background: "#faf5ff", padding: "3px 6px", fontSize: "11px", color: "#4c1d95" } },
              createElement("div", { style: { fontWeight: 600, marginBottom: "1px" } }, panelT("label.source")),
              createElement("div", { style: { whiteSpace: "pre-wrap", maxHeight: "48px", overflow: "auto" } }, String(item.snapshot ?? "")))
          : null,
        createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px", marginTop: "4px" } },
          // Notes behavior: Search 视图同一 selection truth——checkbox 读全局 selSet（按 result
          // 所属 lane + itemKey；Notes behavior addendum：selection 跨 query/lane 存活），绝不
          // 新建 search 专属选择状态。
          (() => {
            const ik = getItemKey(row.node.item) ?? "";
            const selectable = ik !== "";
            const selected = selectable && selSet.has(selKeyOf(row.key, ik));
            return createElement(
              "label",
              {
                title: selectable ? panelT("label.quoteTitle") : panelT("label.quoteUnavailable"),
                style: { display: "flex", alignItems: "center", gap: "3px", fontSize: "11px", color: selectable ? "#1e40af" : "#9ca3af", cursor: selectable && !selBusy && selHydrated ? "pointer" : "not-allowed", userSelect: "none" },
              },
              createElement("input", {
                type: "checkbox",
                checked: selected,
                disabled: !selectable || selBusy || !selHydrated,
                onChange: () => toggleSelection(row.key, ik),
                "data-select": "1",
                "aria-label": panelT("label.quoteAria"),
                style: { cursor: "inherit", margin: "0" },
              }),
              panelT("button.quote")
            );
          })(),
          createElement(
            "div",
            { style: { display: "flex", gap: "6px", alignItems: "center" } },
            // Notes behavior adversarial-A：按钮态按 **result 所属 lane** 的持久化 pin 集合判定（row.pinned
            // 由 searchContentEl 按 lane 分组时解析）；跨 lane 结果不再借 active lane 的
            // pinKeys、也不再强制 layerKey === row.key 才显示 取消置顶。
            // Notes behavior validation case：merge-wrapper lane 的 Search result **不渲染** Pin 按钮
            // （Notes behavior merge-wrapper Pin affordance unavailable；点击会因 laneHasForkMerge 被
            // togglePin 直接忽略——可见但无效的按钮是误导性 UI）。
            !row.forkMerge
              ? createElement("button", { onClick: () => jumpToNote(row, "pin"), "data-pin": row.pinned ? "1" : "0", style: { ...btnStyle, fontSize: "11px", padding: "1px 8px", background: row.pinned ? "#fef9c3" : "#f3f4f6" } }, row.pinned ? panelT("button.unpin") : panelT("button.pin"))
              : null,
            createElement("button", { onClick: () => jumpToNote(row, "edit"), style: { ...btnStyle, fontSize: "11px", padding: "1px 8px" } }, panelT("button.edit")),
            createElement("button", { onClick: () => jumpToNote(row, "delete"), style: { ...btnStyle, fontSize: "11px", padding: "1px 8px", color: "#b91c1c" } }, panelT("button.delete")),
            anchored ? createElement("button", { onClick: () => jumpToNote(row, "reentry"), disabled: !item.sourcePayload, style: { ...btnStyle, fontSize: "11px", padding: "1px 8px", background: item.sourcePayload ? "#eef2ff" : "#eee" } }, item.sourcePayload ? panelT("button.reenter") : panelT("button.reenterUnavailable")) : null
          )
        )
      );
    };
    const searchLanesEl = searchResults?.lanes || [];
    const hasError = Boolean(searchResults?.error);
    // settled = 结果对应当前 query（避免 debounce 窗口内误显示 no-result）
    const settledNoResult = searchResults && !searchBusy && searchResults.query === searchQuery.trim() && !hasError;
    const searchContentEl = createElement(
      "div",
      { style: { flex: "1", minHeight: "0", overflowY: "auto", padding: "4px 0 8px", background: "#fff" } },
      hasError
        ? createElement("div", { style: { color: "#b91c1c", fontSize: "12px", padding: "8px 12px" } }, panelT("label.searchError", { error: searchResults.error }))
        : settledNoResult && searchLanesEl.every((l) => l.nodes.length === 0)
          ? createElement("div", { style: { color: "#9ca3af", fontSize: "13px", padding: "14px 12px" } }, panelT("label.empty"))
          : searchBusy && !searchResults
            ? createElement("div", { style: { color: "#9ca3af", fontSize: "13px", padding: "14px 12px" } }, panelT("label.statusSearching"))
            : searchLanesEl.map((lane) => {
                // 组内顺序先按当前**全局** Notes behavior viewDir 成型（newest=反向/oldest=正向；
                // fork-merge lane 恒正序、不做 pin 分区——与普通视图 limitation 同构，
                // 不伪造跨 branch chronology）。
                const ordered = lane.forkMerge ? lane.nodes : viewDir === "newest" ? lane.nodes.slice().reverse() : lane.nodes;
                if (ordered.length === 0) return null;
                // Notes behavior adversarial-A：跨 lane 搜索按「result lane」解析 Pin truth——读该 lane
                // 的持久化 pin map（browser localStorage，同 holder），绝不使用 active
                // lane 的 pinKeys；active lane 只是导航/呈现上下文，不改变任何 Note 的
                // pin 真值。结果 node 即该 lane 真实存在的 whole Note → stale key 不会
                // 产生 ghost pin。fork-merge lane 无 pin 支持 → 恒普通组。
                const pinSet = lane.forkMerge ? null : readPinMap(sessionId, lane.key);
                const pinnedRows = [];
                const normalRows = [];
                for (const row of ordered) {
                  const isItem = row.node?.type === "item" && Boolean(row.node.item);
                  const ik = isItem ? (getItemKey(row.node.item) ?? "") : "";
                  const pinned = Boolean(pinSet && ik !== "" && pinSet.has(ik));
                  const tagged = { ...row, key: lane.key, label: lane.label, displayId: lane.displayId, pinned, forkMerge: lane.forkMerge };
                  (pinned ? pinnedRows : normalRows).push(tagged);
                }
                const parts = [];
                if (pinnedRows.length > 0) {
                  parts.push(createElement("div",
                    { key: "pin-head", "data-search-pin-group": "pinned", style: { display: "flex", alignItems: "center", gap: "6px", margin: "2px 10px 2px", padding: "2px 0 4px", fontSize: "11px", fontWeight: 600, color: "#4f46e5", borderBottom: "1px dashed #c7d2fe" } },
                    panelT("button.pin")));
                  for (const row of pinnedRows) parts.push(renderSearchRow(row));
                  if (normalRows.length > 0) {
                    parts.push(createElement("div",
                      { key: "normal-head", "data-search-pin-group": "normal", style: { display: "flex", alignItems: "center", gap: "6px", margin: "4px 10px 2px", padding: "2px 0 4px", fontSize: "11px", fontWeight: 600, color: "#6b7280", borderBottom: "1px dashed #e5e7eb" } },
                      panelT("label.ordinaryNote")));
                  }
                }
                for (const row of normalRows) parts.push(renderSearchRow(row));
                return createElement("div", { key: lane.key, style: { marginBottom: "6px" } },
                  createElement("div", { style: { fontSize: "11px", fontWeight: 700, color: "#6b7280", padding: "4px 12px 2px", letterSpacing: "0.2px" } }, lane.label),
                  ...parts
                );
              })
    );

    // 已保存 Notes 列表：parseLaneBody(text).nodes——legacy 段落（read-only）+
    // item 卡片（authored 为主、source 辅助、编辑按钮、anchored 附 ↪ 回来源）。
    // Notes behavior：列表标题行（已保存便签 N）右侧加轻量 <select>（新记录在前/旧记录在前），
    // value=viewDir、onChange=setViewDir；只切换展示顺序，无任何写路径。fork-merge
    // 检测为真的 lane（laneHasForkMerge）隐藏 select——正序即该 lane 唯一安全展示
    // （此处直接说明 limitation；不为此建新 model）。
    const notesListHeaderEl = createElement(
      "div",
      { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px", margin: "6px 0", padding: "0 10px 6px", fontSize: "12px", borderBottom: "1px solid #e5e7eb" } },
      createElement(
        "span",
        { style: { fontWeight: 600, color: "#6b7280", letterSpacing: "0.2px" } },
        panelT("label.savedCount", { n: itemCount })
      ),
      laneHasForkMerge
        ? null
        : createElement(
            "select",
            {
              value: viewDir,
              onChange: (e) => setViewDir(e.target.value),
              "data-view-dir": "1",
              "aria-label": panelT("label.orderAria"),
              title: panelT("label.orderTitle"),
              style: {
                fontSize: "11px", padding: "1px 4px", border: "1px solid #d1d5db",
                borderRadius: "4px", background: "#fff", color: "#374151",
                cursor: "pointer", letterSpacing: "0",
              },
            },
            createElement("option", { value: "newest" }, panelT("button.newest")),
            createElement("option", { value: "oldest" }, panelT("button.oldest"))
          )
    );
    // Notes behavior: 列表内容分区——置顶 group 在前、普通 group 在后；两 group 内部都遵循当前
    // Notes behavior view direction（displayUnits 已含 view order，partition 不改变组内相对序）。
    // 仅当 lane 非 fork-merge 且存在 pin 时启用分区；无 pin → 与 Notes behavior 原状完全一致
    // （保持既有测试/视觉零回归）。legacy 段无 identity → 恒属普通 group
    // qualification：legacy Pin unsupported under current identity substrate）。
    const itemKeyOf = (node) => (node?.type === "item" && node.item ? getItemKey(node.item) ?? "" : "");
    const pinnedSet = laneHasForkMerge ? new Set() : pinKeys;
    const listCardEls = [];
    if (parsedBody.nodes.length === 0) {
      listCardEls.push(createElement("div", { key: "empty", style: { color: "#9ca3af", fontSize: "12px", padding: "4px 10px" } },
        panelT("label.noNotes")));
    } else {
      const viewUnits = displayUnits; // view-ordered（newest 反向 / oldest 正向）
      const pinnedUnits = viewUnits.filter(({ node }) => pinnedSet.has(itemKeyOf(node)));
      const normalUnits = viewUnits.filter(({ node }) => !pinnedSet.has(itemKeyOf(node)));
      if (pinnedUnits.length === 0) {
        for (const { node, physIndex } of normalUnits) listCardEls.push(renderNoteCard(node, physIndex));
      } else {
        // 置顶 group header（纯视觉；不写任何东西）
        listCardEls.push(
          createElement("div",
            { key: "pin-head", "data-pin-group": "pinned", style: { display: "flex", alignItems: "center", gap: "6px", margin: "2px 10px 2px", padding: "2px 0 4px", fontSize: "12px", fontWeight: 600, color: "#4f46e5", borderBottom: "1px dashed #c7d2fe" } },
            panelT("button.pin"))
        );
        for (const { node, physIndex } of pinnedUnits) listCardEls.push(renderNoteCard(node, physIndex));
        listCardEls.push(
          createElement("div",
            { key: "normal-head", "data-pin-group": "normal", style: { display: "flex", alignItems: "center", gap: "6px", margin: "6px 10px 2px", padding: "2px 0 4px", fontSize: "12px", fontWeight: 600, color: "#6b7280", borderBottom: "1px dashed #e5e7eb" } },
            panelT("label.ordinaryNote"))
        );
        for (const { node, physIndex } of normalUnits) listCardEls.push(renderNoteCard(node, physIndex));
      }
    }
    const notesListEl = createElement(
      "div",
      { style: { flex: "1", minHeight: "0", overflowY: "auto", padding: "2px 0 6px", borderTop: "1px solid #e5e7eb" }, "data-notes-list": "1" },
      notesListHeaderEl,
      ...listCardEls
    );

    // 旧的全层 textarea 编辑器（原文编辑视图；与原始语义完全一致：typing → dirty、
    // 保存走 header 保存按钮、409/status/footer 逻辑原样）。
    const rawEditorEl = createElement("textarea", {
      value: text,
      onChange: (e) => { setText(e.target.value); setDirty(true); setStatus(""); },
      placeholder: panelT("label.rawPlaceholder", { label: current().label, key: current().key, sessionId }),
      style: {
        flex: "1", border: "none", outline: "none", padding: "10px",
        resize: "none", fontFamily: "ui-monospace, monospace",
        fontSize: "13px", lineHeight: "1.5",
      },
    });

    // 便签视图（composer + 列表）与原文编辑视图切换；默认便签视图。
    const viewToggleRowEl = createElement(
      "div",
      { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 10px", borderTop: "1px solid #eee", background: "#fff", fontSize: "12px" } },
      rawView
        ? createElement("button", { onClick: () => setRawView(false), style: { ...btnStyle, color: "#2563eb", fontSize: "12px", padding: "2px 6px" } }, panelT("button.notesView"))
        : createElement("button", { onClick: () => setRawView(true), style: { ...btnStyle, color: "#6b7280", fontSize: "12px", padding: "2px 6px" } }, panelT("button.rawView"))
    );

    // ---- Notes behavior: compact 已选 N 条 tray ----
    // 规则：count=0 quiet（不渲染）；>0 compact 常显（跨 lane/Search/viewDir/Pin 不
    // 清）；展开 = 逐条 review（lane + authored 摘要）+ 逐条 remove；全部移除 = 全清
    // （versioned PUT []）。selError（同步失败 / 绑定 truthful failure）在 tray 内展示。
    // 若当前正在向 host 同步（selBusy）显示轻量“同步中…”。rawView（原文编辑）下
    // 同样常显——selection 属于当前 holder，与视图无关。
    const selCount = selSet.size;
    const trayEl =
      selHydrated && selCount > 0
        ? createElement(
            "div",
            { "data-sel-tray": "1", style: { borderTop: "1px solid #dbeafe", background: "#eff6ff", padding: "5px 10px 6px", fontSize: "12px" } },
            createElement(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
              createElement("span", { style: { fontWeight: 700, color: "#1e40af" } }, panelT("label.selectedCount", { n: selCount })),
              createElement(
                "span",
                { style: { color: "#3b82f6", fontSize: "11px" } },
                panelT("label.selectedAutoAttach")
              ),
              createElement("span", { style: { flex: "1" } }),
              selBusy ? createElement("span", { style: { color: "#94a3b8", fontSize: "11px" } }, panelT("label.statusSyncing")) : null,
              createElement(
                "button",
                {
                  onClick: () => setSelTrayOpen((v) => !v),
                  "data-sel-tray-toggle": "1",
                  title: selTrayOpen ? panelT("button.collapse") : panelT("label.selectedList"),
                  style: { ...btnStyle, fontSize: "11px", padding: "1px 6px", color: "#1e40af" },
                },
                selTrayOpen ? panelT("button.collapse") : panelT("button.expand")
              ),
              createElement(
                "button",
                {
                  onClick: clearSelection,
                  disabled: selBusy,
                  "data-sel-clear": "1",
                  title: panelT("label.clearSelection"),
                  style: { ...btnStyle, fontSize: "11px", padding: "1px 6px", color: "#b91c1c" },
                },
                panelT("button.removeAll")
              )
            ),
            selError
              ? createElement("div", { style: { color: "#b91c1c", fontSize: "11px", lineHeight: "1.4", marginTop: "3px", whiteSpace: "pre-wrap" } }, selError)
              : null,
            selTrayOpen
              ? createElement(
                  "div",
                  { "data-sel-tray-review": "1", style: { marginTop: "4px", borderTop: "1px dashed #bfdbfe", paddingTop: "4px", maxHeight: "150px", overflowY: "auto" } },
                  selPreviewBusy
                    ? createElement("div", { style: { color: "#94a3b8", fontSize: "11px" } }, panelT("label.statusReading"))
                    : [...selSet.values()].map((t) => {
                        const laneMeta = layers.find((l) => l.key === t.laneKey);
                        const laneName = laneMeta ? laneMeta.label : t.laneKey;
                        const laneLoaded = Boolean(selPreview && selPreview[t.laneKey]);
                        const entry = laneLoaded ? (selPreview[t.laneKey][t.itemKey] || null) : null;
                        const gone = laneLoaded && !entry;
                        return createElement(
                          "div",
                          { key: selKeyOf(t.laneKey, t.itemKey), "data-sel-tray-row": "1", style: { display: "flex", alignItems: "flex-start", gap: "6px", padding: "3px 0", borderBottom: "1px dashed #dbeafe" } },
                          createElement(
                            "div",
                            { style: { flex: "1", minWidth: "0", fontSize: "12px", color: "#334155", lineHeight: "1.4" } },
                            createElement("div", { style: { fontSize: "10.5px", color: "#64748b", fontWeight: 600 } }, laneName),
                            gone
                              ? createElement("div", { style: { color: "#b45309", fontSize: "11px" } }, panelT("label.noteMissing"))
                              : entry
                                ? createElement("div", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, entry.authored || panelT("label.emptyNote"))
                                : createElement("div", { style: { color: "#94a3b8", fontSize: "11px" } }, selPreviewBusy ? panelT("label.statusReading") : panelT("label.unreadable"))
                          ),
                          createElement(
                            "button",
                            {
                              onClick: () => toggleSelection(t.laneKey, t.itemKey),
                              disabled: selBusy,
                              "data-sel-remove": "1",
                              title: panelT("label.selectionRemove"),
                              style: { ...btnStyle, fontSize: "11px", padding: "0 6px", color: "#b91c1c" },
                            },
                            panelT("button.remove")
                          )
                        );
                      })
                )
              : null
          )
        : null;

    // Notes behavior narrow UX：binding receipt（只有 authoritative binding success/failure
    // 驱动；见 showSelReceipt/轮询消费）。成功 prominent 期：绿底 ✓ 行 + [查看]；
    // 降级后（~4s）：低强调单行"已随消息引用 N 条便签"。失败：红底 truthful 行
    // （选择保留，可重试/取消——不伪装成功发送）。[查看] 展开本次真实绑定 targets
    //（ephemeral：holder+lane+itemKey，success 时从 selSetRef 捕获；不 fuzz 重绑）。
    const selReceiptEl =
      selReceipt && sessionIdRef.current === selReceiptSessionRef.current
        ? createElement(
            "div",
            {
              "data-sel-receipt": selReceipt.kind,
              style: {
                margin: "0 10px 6px",
                padding: "6px 10px",
                borderRadius: "6px",
                fontSize: "12px",
                lineHeight: "1.5",
                border: selReceipt.kind === "success" ? "1px solid #bbf7d0" : "1px solid #fecaca",
                background: selReceipt.kind === "success" ? (selReceipt.degraded ? "#f0fdf4" : "#dcfce7") : "#fef2f2",
              },
            },
            selReceipt.kind === "success"
              ? createElement(
                  "div",
                  { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
                  selReceipt.degraded
                    ? null
                    : createElement("span", { style: { fontWeight: 700, color: "#166534" } }, "✓"),
                  createElement(
                    "span",
                    { style: selReceipt.degraded ? { color: "#3f6212", fontSize: "11.5px" } : { color: "#14532d", fontWeight: 600 } },
                    selReceipt.degraded
                      ? panelT("label.boundCount", { n: selReceipt.noteCount })
                      : panelT("label.boundCountPast", { n: selReceipt.noteCount })
                  ),
                  createElement("span", { style: { flex: "1" } }),
                  !selReceipt.degraded && Array.isArray(selReceipt.targets) && selReceipt.targets.length > 0
                    ? createElement(
                        "button",
                        {
                          onClick: () => setSelReceiptView((v) => !v),
                          "data-sel-receipt-view": "1",
                          style: { ...btnStyle, fontSize: "11px", padding: "1px 6px", color: "#166534" },
                        },
                        selReceiptView ? panelT("button.collapse") : panelT("label.selectionReceipt")
                      )
                    : null,
                  !selReceipt.degraded
                    ? createElement(
                        "button",
                        {
                          onClick: clearSelReceipt,
                          "data-sel-receipt-dismiss": "1",
                          style: { ...btnStyle, fontSize: "11px", padding: "1px 6px", color: "#94a3b8" },
                        },
                        panelT("label.selectionReceiptClose")
                      )
                    : null
                )
              : createElement(
                  "div",
                  { style: { color: "#7f1d1d" } },
                  createElement("div", { style: { fontWeight: 700 } }, panelT("label.selectionFailure")),
                  createElement("div", { style: { fontSize: "11.5px", marginTop: "2px", whiteSpace: "pre-wrap" } },
                    panelT("label.selectionFailureDetail", { code: selReceipt.code || "FAILED", n: selReceipt.noteCount })),
                  selReceipt.reason
                    ? createElement("div", { style: { fontSize: "11px", color: "#991b1b", marginTop: "2px" } }, String(selReceipt.reason).slice(0, 200))
                    : null
                ),
            selReceipt.kind === "success" && selReceiptView && Array.isArray(selReceipt.targets)
              ? createElement(
                  "div",
                  { "data-sel-receipt-list": "1", style: { marginTop: "4px", borderTop: "1px dashed #86efac", paddingTop: "4px", maxHeight: "120px", overflowY: "auto" } },
                  selReceipt.targets.map((t) => {
                    const laneMeta = layers.find((l) => l.key === t.laneKey);
                    return createElement(
                      "div",
                      { key: selKeyOf(t.laneKey, t.itemKey), style: { fontSize: "11px", color: "#14532d", padding: "1px 0" } },
                      `${laneMeta ? laneMeta.label : t.laneKey} · ${String(t.itemKey).slice(0, 18)}`
                    );
                  })
                )
              : null
          )
        : null;

    // Notes behavior: reentry 结果展示（与旧 anchored 底部区一致的 truthful 分 kind 文案）。
    const reentryStripEl =
      reentry && reentry.busy
        ? createElement("div", { style: { color: "#555", padding: "6px 10px", borderTop: "1px solid #eee", fontSize: "12px", background: "#fafafa" } }, panelT("status.reentryReading"))
        : reentry && !reentry.busy
          ? createElement(
              "div",
              { style: { padding: "6px 10px", borderTop: "1px solid #eee", fontSize: "12px", background: "#fafafa" } },
                reentry.kind === "ok-exact"
                  ? createElement("div", { style: { color: "#065f46", whiteSpace: "pre-wrap" } },
                      `${reentry.sameSession ? (reentry.highlighted ? panelT("label.reentryExactStrip") : panelT("label.reentryReadNoHighlightStrip")) : panelT("label.reentryCrossSessionStrip")}\nsource: ${String(reentry.text || "").slice(0, 400)}`)
                : reentry.kind === "cue-whole"
                  ? createElement("div", { style: { color: "#92400e", whiteSpace: "pre-wrap" } },
                      panelT("label.sourceExact", { text: String(reentry.text || "").slice(0, 400) }))
                : reentry.kind === "cue-unavailable"
                  ? createElement("div", { style: { color: "#92400e", whiteSpace: "pre-wrap" } },
                      panelT("label.sourceNoCue", { text: String(reentry.text || "").slice(0, 400) }))
                  : reentry.kind === "cue-partial"
                    ? createElement("div", { style: { color: "#92400e", whiteSpace: "pre-wrap" } },
                        panelT("label.sourcePartial", { found: reentry.highlightedCount, total: reentry.total, text: String(reentry.text || "").slice(0, 400) }))
                  : reentry.kind === "unauthorized"
                  ? createElement("div", { style: { color: "#92400e" } }, panelT("label.sourceUnauthorized", { text: String(reentry.text || "").slice(0, 200) }))
                  : reentry.kind === "unavailable"
                    ? createElement("div", { style: { color: "#92400e" } }, panelT("label.sourceUnavailable", { text: String(reentry.text || "").slice(0, 200) }))
                    : reentry.kind === "incompatible"
                      ? createElement("div", { style: { color: "#92400e" } }, panelT("label.sourceIncompatible", { text: String(reentry.text || "").slice(0, 200) }))
                      : createElement("div", { style: { color: "#b91c1c" } }, panelT("label.sourceFailed", { text: String(reentry.text || "").slice(0, 200) })),
              reentry.kind === "ok-exact"
                ? createElement(
                    "button",
                    { onClick: () => setReentry(null), style: { fontSize: "11px", marginTop: "2px", cursor: "pointer", border: "1px solid #ccc", borderRadius: "4px", background: "#fff" } },
                    panelT("status.reentryClosed")
                  )
                : null
            )
          : null;

    // Notes behavior: 帮助内容——只描述当前真实能力（便签正文 / 引用的原文 / L1-L4 / 分支 /
    // 编辑与删除）；不介绍 Pin / 排序 / selected-Notes reference 等未实现项。
    const helpSections = [
      { t: panelT("help.noteBodyTitle"), b: panelT("help.noteBody") },
      { t: panelT("help.sourceTitle"), b: panelT("help.source") },
      { t: panelT("help.laneTodo"), b: panelT("help.laneTodoBody") },
      { t: panelT("help.laneDeferred"), b: panelT("help.laneDeferredBody") },
      { t: panelT("help.laneKnowledge"), b: panelT("help.laneKnowledgeBody") },
      { t: panelT("help.laneLesson"), b: panelT("help.laneLessonBody") },
      { t: panelT("help.branchTitle"), b: panelT("help.branch") },
      { t: panelT("help.editTitle"), b: panelT("help.edit") },
    ];
    const helpPanelEl = createElement(
      "div",
      { style: { background: "#f8fafc", borderBottom: "1px solid #e5e7eb", padding: "8px 10px", fontSize: "12px", lineHeight: "1.6", maxHeight: "260px", overflowY: "auto" }, "data-help-panel": "1" },
      createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" } },
        createElement("span", { style: { fontWeight: 600, fontSize: "12.5px", color: "#374151" } }, panelT("label.help")),
        createElement("button", { onClick: () => setHelpOpen(false), style: { ...btnStyle, color: "#6b7280", fontSize: "11px", padding: "0 6px" } }, panelT("label.helpClose"))
      ),
      helpSections.map((sec) =>
        createElement("div", { key: sec.t, style: { margin: "4px 0" } },
          createElement("div", { style: { fontWeight: 600, color: "#4f46e5" } }, sec.t),
          createElement("div", { style: { color: "#374151", whiteSpace: "pre-wrap" } }, sec.b)
        )
      )
    );

    return createElement(
      "div",
      { style: panelStyle },
      // Notes behavior A2: 拖动左缘调宽（plugin-local；数据属性供测试）
      createElement("div", {
        "data-resize-handle": "1",
        title: panelT("label.dragResize"),
        onMouseDown: beginResize,
        style: resizeHandleStyle,
      }),
      // Header: title + refresh + save + close
      createElement(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderBottom: "1px solid #eee" } },
        createElement("span", { style: { fontWeight: 600, fontSize: "14px" } }, panelT("label.panelTitle")),
        createElement(
          "div",
          { style: { display: "flex", gap: "4px", alignItems: "center" } },
          createElement("button", { title: panelT("label.helpTitle"), "aria-label": panelT("label.helpTitle"), onClick: () => setHelpOpen((v) => !v), style: { ...btnStyle, color: "#6b7280", fontSize: "13px", padding: "0 7px", fontWeight: 600 } }, panelT("button.help")),
          createElement("button", { title: panelT("label.searchButtonTitle"), "aria-label": panelT("label.searchAria"), onClick: () => { setRawView(false); setHelpOpen(false); setSearchOpen((v) => !v); }, style: { ...btnStyle, color: searchOpen ? "#2563eb" : "#6b7280", fontSize: "13px", padding: "0 7px" } }, panelT("button.search")),
          createElement("button", { title: panelT("label.refreshTitle"), onClick: refresh, style: btnStyle }, panelT("button.refresh")),
          createElement("button", { onClick: save, style: { ...btnStyle, background: "#2563eb", color: "#fff" } }, panelT("button.save")),
          createElement("button", { title: panelT("label.closeEsc"), onClick: handleClose, style: btnStyle }, panelT("button.close"))
        )
      ),
      helpOpen ? helpPanelEl : null,
      // fork/carry eligibility decision post-apply RESULT banner (top position). Per-lane lines; survives
      // lane switches / in-panel refresh; dismissed only by 知道了.
      carryResult
        ? createElement(
            "div",
            { style: { padding: "8px 10px", borderBottom: "1px solid #bbf7d0", background: "#f0fdf4", fontSize: "12px", lineHeight: "1.6" } },
            createElement("div", { style: { fontWeight: 600, marginBottom: "4px" } }, panelT("label.carryDone")),
            carryResult.laneLines.map((line) =>
              createElement("div", { key: line.lane }, `${line.label}：${line.text}`)
            ),
            createElement(
              "button",
              {
                onClick: () => setCarryResult(null),
                style: { ...btnStyle, marginTop: "6px", background: "#16a34a", color: "#fff" },
              },
              panelT("button.ok")
            )
          )
        : null,
      // fork/carry eligibility decision: post-fork carry-over banner (top of panel, non-blocking).
      // Shown only while status === "unresolved"; dismissed on decision.
      carryOver
        ? createElement(
            "div",
            { style: { padding: "8px 10px", borderBottom: "1px solid #fde68a", background: "#fffbeb", fontSize: "12px", lineHeight: "1.5" } },
            carryConflict
              ? // One-time conflict resolution: per-lane merge / keep / replace.
                createElement(
                  "div",
                  null,
                  createElement("div", { style: { fontWeight: 600, marginBottom: "4px" } }, panelT("label.carryConflict")),
                  createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: "6px", margin: "4px 0" } },
                    carryConflict.conflicts.map((c) =>
                      createElement(
                        "div",
                        { key: c.lane, style: { border: "1px solid #fde68a", borderRadius: "4px", padding: "6px" } },
                        createElement("div", { style: { fontWeight: 600 } }, `${(layers.find((l) => l.key === c.lane) || {}).label || c.lane}`),
                        createElement(
                          "div",
                          { style: { display: "flex", flexDirection: "column", gap: "2px", margin: "4px 0" } },
                          ["merge", "keep", "replace"].map((opt) =>
                            createElement(
                              "label",
                              { key: opt, style: { display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" } },
                              createElement("input", {
                                type: "radio",
                                name: `carry-res-${c.lane}`,
                                checked: carryResolutions[c.lane] === opt,
                                onChange: () => setCarryResolutions((prev) => ({ ...prev, [c.lane]: opt })),
                              }),
                              opt === "merge" ? panelT("label.carryMerge") : opt === "keep" ? panelT("label.carryKeep") : panelT("label.carryReplace")
                            )
                          )
                        ),
                        createElement(
                          "div",
                          { style: { display: "flex", gap: "8px", marginTop: "2px", color: "#666" } },
                          createElement(
                            "details",
                            { style: { flex: "1" } },
                            createElement("summary", null, panelT("label.carryParent")),
                            createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "2px 0", maxHeight: "80px", overflow: "auto", background: "#fff", padding: "4px", borderRadius: "3px" } }, c.parentContent || panelT("label.emptyContent"))
                          ),
                          createElement(
                            "details",
                            { style: { flex: "1" } },
                            createElement("summary", null, panelT("label.carryCurrent")),
                            createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "2px 0", maxHeight: "80px", overflow: "auto", background: "#fff", padding: "4px", borderRadius: "3px" } }, c.childContent || panelT("label.emptyContent"))
                          )
                        )
                      )
                    )
                  ),
                  createElement(
                    "div",
                    { style: { display: "flex", gap: "4px", marginTop: "4px" } },
                    createElement("button", { onClick: applyCarryResolutions, disabled: carryBusy, style: { ...btnStyle, background: "#2563eb", color: "#fff" } }, carryBusy ? panelT("label.carryBusy") : panelT("button.confirmCarry")),
                    createElement("button", { onClick: () => { setCarryConflict(null); setCarryResolutions({}); }, disabled: carryBusy, style: btnStyle }, panelT("button.back"))
                  )
                )
              : carryPicking
              ? createElement(
                  "div",
                  null,
                  createElement("div", { style: { fontWeight: 600, marginBottom: "4px" } }, panelT("label.carryQuestion")),
                  createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: "2px", margin: "4px 0" } },
                    layers.map((l) =>
                      createElement(
                        "label",
                        { key: l.key, style: { display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" } },
                        createElement("input", {
                          type: "checkbox",
                          checked: carrySelected.includes(l.key),
                          onChange: (e) => {
                            const k = l.key;
                            setCarrySelected((prev) => (e.target.checked ? [...prev, k] : prev.filter((x) => x !== k)));
                          },
                        }),
                        l.label
                      )
                    )
                  ),
                  createElement(
                    "div",
                    { style: { display: "flex", gap: "4px" } },
                    createElement("button", { onClick: () => decideCarryOver("some", null), disabled: carryBusy, style: { ...btnStyle, background: "#2563eb", color: "#fff" } }, panelT("button.confirmSelected")),
                    createElement("button", { onClick: () => setCarryPicking(false), disabled: carryBusy, style: btnStyle }, panelT("button.back"))
                  )
                )
              : createElement(
                  "div",
                  null,
                  createElement("div", { style: { fontWeight: 600, marginBottom: "4px" } }, panelT("label.carryQuestion")),
                  createElement(
                    "div",
                    { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
                    createElement("button", { onClick: () => decideCarryOver("all", null), disabled: carryBusy, style: { ...btnStyle, background: "#2563eb", color: "#fff" } }, panelT("button.all")),
                    createElement("button", { onClick: () => decideCarryOver("some", null), disabled: carryBusy, style: btnStyle }, panelT("button.some")),
                    createElement("button", { onClick: () => decideCarryOver("none", null), disabled: carryBusy, style: btnStyle }, panelT("button.none"))
                  )
                )
          )
        : null,
      setupGateEl,
      // Layer tabs (from resolved mapping)
      createElement(
        "div",
        { style: { display: "flex", gap: "4px", padding: "6px 8px", borderBottom: "1px solid #eee", flexWrap: "wrap" } },
        layers.map((l) =>
          createElement(
            "button",
            {
              key: l.key,
              onClick: () => switchLayer(l.key),
              style: {
                ...btnStyle,
                background: l.key === layerKey ? "#e0e7ff" : "transparent",
                fontWeight: l.key === layerKey ? 600 : 400,
              },
            },
            l.label
          )
        )
      ),
      // Conflict banner (409 pending)
      conflict
        ? createElement(
            "div",
            { style: { display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center", padding: "6px 10px", background: "#fef2f2", borderBottom: "1px solid #fecaca", color: "#b91c1c", fontSize: "12px" } },
            createElement("span", { style: { width: "100%" } }, panelT("status.conflict")),
            createElement("button", { onClick: loadLatest, style: { ...btnStyle, background: "#2563eb", color: "#fff" } }, panelT("button.loadLatest")),
            createElement("button", { onClick: forceSave, style: { ...btnStyle, background: "#dc2626", color: "#fff" } }, panelT("button.overwrite")),
            createElement("button", { onClick: () => setConflict(null), style: btnStyle }, panelT("button.cancel"))
          )
        : null,
      // Notes behavior (Notes behavior): coherent Note-primary 内容区。默认便签视图（顶部 composer +
      // 已保存 Notes 列表 + 底部工具行照旧）；“原文编辑（高级）”为默认折叠的旧
      // 全层 textarea 编辑器（展开后原 textarea+保存/conflict/status/footer 语义
      // 与旧版完全一致）。reentry 结果 strip 保持可用的 truthful 展示。
      // Notes behavior：searchOpen 时在便签视图上方加搜索行；query 非空 → 显示跨-lane 搜索
      // 结果区（替代普通列表）；query 空 → 恢复 normal Notes view。
      rawView
        ? rawEditorEl
        : searchOpen
          ? createElement(
              "div",
              { style: { flex: "1", minHeight: "0", display: "flex", flexDirection: "column", background: "#fff" } },
              searchRowEl,
              searchQuery.trim() !== ""
                ? searchContentEl
                : createElement(
                    "div",
                    { style: { flex: "1", minHeight: "0", display: "flex", flexDirection: "column" } },
                    editingIndex === null ? composerCardEl : null,
                    notesListEl
                  )
            )
          : createElement(
              "div",
              { style: { flex: "1", minHeight: "0", display: "flex", flexDirection: "column", background: "#fff" } },
              editingIndex === null ? composerCardEl : null,
              notesListEl
            ),
      viewToggleRowEl,
      reentryStripEl,
      // Notes behavior narrow UX: binding receipt（authoritative success/failure；成功 tray 已
      // 清 → receipt 独立成条；失败时 tray 仍显示选择保留，receipt 给显式失败头）。
      selReceiptEl,
      // Notes behavior: 已选 tray（count>0 常显；位于底部工具行与 footer 之间）
      trayEl,
      // Footer: status + last-modified time
      createElement(
        "div",
        { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderTop: "1px solid #eee" } },
        createElement(
          "span",
          { style: { color: "#888", fontSize: "12px" } },
          status || panelT("label.footer", {
            label: current().label,
            key: current().key,
            sessionId,
            modified: mtime && mtime !== "0" ? ` · ${panelT("label.modifiedAt", { time: new Date(Number(mtime)).toLocaleTimeString() })}` : "",
          })
        )
      )
    );
  }

  // Must return the component function (the slot registrar expects a
  // component type; returning an element silently breaks the slot).
  return function NotesToggle(props) {
    const toggleT = props.t || t;
    const [open, setOpen] = useState(false);
    const [pendingCarry, setPendingCarry] = useState(false);
    // fork/carry eligibility decision: lightweight pending indicator — a small dot on the 📝 button while
    // this session has an unresolved carry-over decision. Not alarm-style; the
    // decision stays re-discoverable without interrupting the conversation.
    useEffect(() => {
      let cancelled = false;
      notesFetch(`/notes-api/fork-status?sessionId=${encodeURIComponent(props.sessionId)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((info) => { if (!cancelled) setPendingCarry(Boolean(info?.isForkChild && info?.status === "unresolved")); })
        .catch(() => {});
      return () => { cancelled = true; };
    }, [props.sessionId, open]); // re-check when the panel opens (decision may have resolved it)
    return createElement(
      React.Fragment,
      null,
      createElement(
        "div",
        { style: { position: "relative", display: "inline-block" } },
        createElement(
          "button",
          {
            title: toggleT("label.panelTitle"),
            onClick: () => setOpen((v) => !v),
            style: { background: "none", border: "none", cursor: "pointer", fontSize: "14px", color: "#374151", display: "inline-flex", alignItems: "center", gap: "3px" },
          },
          toggleT("button.notes")
        ),
        pendingCarry
          ? createElement("span", {
              title: toggleT("label.carryPending"),
              style: {
                position: "absolute", top: "0", right: "0", width: "6px", height: "6px",
                borderRadius: "50%", background: "#d97706",
              },
            })
          : null
      ),
      // Session isolation：key={sessionId} —— session 切换即 remount NotesPanel，
      // 保证 selection/tray/text 等全部 per-session 状态绝不跨 holder/session 携带
      // （外加 hydration effect 同步清空 + pump/poll/preview epoch+session guard 双保险）。
      open ? createElement(NotesPanel, { key: props.sessionId, sessionId: props.sessionId, onClose: () => setOpen(false), t: props.t || t }) : null
    );
  };
}

const inject = [
  "slots",
  "uiWorkspace",
  "locale",
  "settingsScope",
];

function apply(ctx, React) {
  if (!ctx.slots) return; // no slot system: skip silently
  if (ctx.locale?.register) {
    ctx.effect?.(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-collab-notes: dictionaries");
  }
  const Component = NotesController(React, ctx);
  // Header utilities slot; inject gives us the current session id
  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "dsh-collab-notes",
        order: 40,
        inject: (sessionId) => ({ sessionId }),
        locale: LOCALE_NS,
      },
      Component
    )
  );
}

// DSH Web loads client bundles as classic scripts: register a lazy factory
// via ModuleLoader (id must equal the package name).
window.__ModuleLoader__.load({
  id: "dsh-collab-notes",
  factory: (require) => {
    const React = require("react");
    return {
      apply: (ctx) => apply(ctx, React),
      inject,
    };
  },
});
})();
