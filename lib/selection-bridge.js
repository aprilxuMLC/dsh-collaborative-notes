// dsh-collab-notes — selection bridge（internal adapter seam，非 official API）
//
// 把真实 browser Selection/Range → rendered node identity → event identity →
// projection-local code-point extent 的映射封装为可测试的 seam。
//
//   proposal 引擎 = `selectionToProposal`（本文件下方）：
//     browser selection gesture
//     → positively mapped exact source segments（ordered）
//     + effective source text
//     + selected-but-unresolved visible material（pre-commit disclosure，
//       不分类 chrome/source、不静默丢弃）
//   状态：**validated proposal boundary**——由 capture facade 与客户端
//   保存流调用；本文件仍是内部 adapter seam，不宣称自身是 official API。
//   `selectionToSegments` 是 legacy heuristic path（class/wrapper/
//   branch/button/timestamp 启发式），**仅 migration/testing 保留**；production
//   supported capture 不得静默走该启发式行为。legacy coverage remains for
//   compatibility and does not define supported capture semantics。
//
// 本 module 仍是 internal/adapter seam（依赖 `data-chat-anchor-key` 与 host
// buildSnapshot），不把私有 seam 声称 official supported API。
import { PROJECTION_VERSION, SUPPORTED_PROJECTION_VERSIONS, projectVisibleText, buildMessageIdentity } from "./source-locator.js";
//
// 边界声明：
//   - 本 module 是 **internal/adapter seam**，依赖 renderer 的 `data-chat-anchor-key`
//     输出与 host 的 `buildSnapshot()`；不把私有 seam 声称 official supported API。
//   - `data-chat-anchor-key` 格式：`<kind>:<id>`，kind ∈ {assistant-step, input-message, tool-call}。
//   - snapshot node 匹配：assistant-step → turn:step；input-message → messageId；
//     tool-call → callId。
//   - extent = 容器 textContent 的 Unicode code-point 偏移（TreeWalker 累计 +
//     Range 边界），与 source-locator projection 的坐标单位一致。
//   - 单 anchor 容器 → 1 segment；Range 跨多 anchor 容器 → ordered segments
//     （按 DOM 顺序，用户 source order）。

/** 从 Range 边界容器向上找最近 anchor 容器。 */
export function resolveAnchorElement(node, document) {
  if (!node) return undefined;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el) return undefined;
  return el.closest("[data-chat-anchor-key]") ?? undefined;
}

/**
 * 计算 Range 与单个 anchor 容器的交集 extent（code points）。
 * coordinate basis（R8）：与 projection 一致——每个 text content block 渲染为
 * 容器的直接子元素（renderer 协议假设，documented）；区段间 \n 仅在直接子
 * 元素之间（block 边界）插入 1 个，与 projection 的 block 间 "\n" 对齐。
 * 容器直接文本节点视为游离文本区段（单 block 直接文本渲染 / 同 block 碎片），
 * 不额外产生 \n。Element boundary（range start/end 为元素节点）按 child
 * offset 累计子树文本（R10）。
 * @returns {{startCP:number, endCP:number, totalCP:number}}
 */
const cpsOf = (str) => Array.from(str || "").length;

// The rc.2 Markdown renderer commonly places block elements inside a nested
// markdown wrapper.  Its DOM text stream has no separator text node between
// those blocks, while the v2 projection has one code-point newline at each
// block boundary.  Keep this classification structural: inline elements are
// not separated, and renderer wrappers are blocks only when their shape proves
// that they contain one table or code block.
const MARKDOWN_BLOCK_TAGS = new Set([
  "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "TABLE",
  "P", "PRE", "UL",
]);

function isMarkdownBlockElement(node) {
  if (!node || node.nodeType !== 1) return false;
  if (MARKDOWN_BLOCK_TAGS.has(node.tagName)) return true;
  if (node.tagName !== "DIV") return false;
  const elements = [...node.children];
  if (elements.length === 1 && elements[0].tagName === "TABLE") return true;
  // Yu() in the rc.2 Markdown primitive renders a fenced block as a
  // `div.md-code-block` with a banner sibling and a rendered-code sibling.
  // The banner is renderer chrome, but the code block itself is a projected
  // Markdown block and therefore needs the inter-block separator.
  return isMarkdownCodeBlock(node);
}

function isMarkdownCodeBlock(node) {
  if (!node || node.nodeType !== 1 || node.tagName !== "DIV") return false;
  if (!node.classList?.contains("md-code-block")) return false;
  const children = [...node.children];
  if (children.length !== 2) return false;
  const [banner, rendered] = children;
  return banner.tagName === "DIV" && rendered.tagName === "DIV" &&
    banner.querySelector("button") !== null;
}

function rendererSkipSubtrees(anchor) {
  const skipped = [];
  for (const block of anchor.querySelectorAll("div.md-code-block")) {
    if (block.closest("[data-chat-anchor-key]") !== anchor) continue;
    if (isMarkdownCodeBlock(block)) skipped.push(block.children[0]);
  }
  return skipped;
}

function needsNestedBlockBreak(previous, current) {
  return isMarkdownBlockElement(previous) && isMarkdownBlockElement(current);
}

/** 容器内子树文本累计（按 DOM 顺序），text 节点起点记录到 map。 */
function subtreeTextIndex(container, document, skipSubtree) {
  const starts = new Map();
  let total = 0;
  let text = "";
  const appendText = (node) => {
    starts.set(node, total);
    total += cpsOf(node.nodeValue);
    text += node.nodeValue;
  };
  const visit = (parent) => {
    let previousElement = null;
    const children = [...(parent.childNodes || [])];
    const previousSignificant = (index) => {
      for (let i = index - 1; i >= 0; i--) {
        const n = children[i];
        if (n.nodeType === 3 && !/\S/.test(n.nodeValue || "")) continue;
        return n;
      }
      return null;
    };
    const nextSignificant = (index) => {
      for (let i = index + 1; i < children.length; i++) {
        const n = children[i];
        if (n.nodeType === 3 && !/\S/.test(n.nodeValue || "")) continue;
        return n;
      }
      return null;
    };
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (skipSubtree?.(child)) continue;
      // The Markdown projector treats HR as an empty block.  rc.2 emits
      // whitespace text nodes on both sides of the rendered <hr>; retain one
      // structural block boundary between the surrounding visible blocks, but
      // do not count both renderer whitespace nodes as source text.
      const prev = previousSignificant(index);
      const next = nextSignificant(index);
      if (child.nodeType === 1 && child.tagName === "HR") continue;
      if (child.nodeType === 3 && !/\S/.test(child.nodeValue || "") &&
          (prev?.nodeType === 1 && prev.tagName === "HR" || next?.nodeType === 1 && next.tagName === "HR")) {
        continue;
      }
      const isElement = child.nodeType === 1;
      // The Markdown projection emits one newline between adjacent rendered
      // block elements, while the browser DOM text stream does not. Keep this
      // renderer-shape separator in the same index used by Range boundary
      // mapping; it is not normalization of the captured visible text.
      if (isElement && previousElement && needsNestedBlockBreak(previousElement, child)) {
        text += "\n";
        total += 1;
      }
      if (child.nodeType === 3) appendText(child);
      else if (isElement) visit(child);
      previousElement = isElement ? child : null;
    }
  };
  visit(container);
  return { starts, total, text };
}

/**
 * 容器 basis 文本：与 rangeExtentInContainer 同一坐标（直接子元素区段子树文本 +
 * 元素区段间 1 个 "\n" + 游离文本节点），供 selectedText 与 projection 对齐（R8）。
 */
export function containerBasisText(container, document, options = {}) {
  const skipSubtree = options.skipSubtree;
  let out = "";
  let prevIsEl = false;
  for (const child of container.childNodes) {
    if (child.nodeType !== 1 && child.nodeType !== 3) continue;
    const isEl = child.nodeType === 1;
    const piece = isEl
      ? subtreeTextIndex(child, document, skipSubtree).text
      : (skipSubtree?.(child) ? "" : child.nodeValue);
    // A skipped or empty renderer-only child is not a visible block and must
    // not manufacture a separator before the next selectable block.
    if (!piece) continue;
    if (prevIsEl && isEl) out += "\n";
    out += piece;
    prevIsEl = isEl;
  }
  return out;
}

/** 元素 c 在 container 中的起始位置（含前面 block 边界 \n，按 segs 区段定位）。 */
function elementStartInContainer(c, container, document, segs, skipSubtree) {
  for (const seg of segs) {
    if (seg.child === c) return seg.start;
    if (seg.isEl && seg.child.contains(c)) {
      // c 在 seg.child 子树内：累计 seg 内 c 之前的文本（同 block，无 \n）
      return seg.start + textBeforeInSubtree(seg.child, c, document, skipSubtree);
    }
  }
  return 0;
}

/** root 子树中 target 之前的文本码点。 */
function textBeforeInSubtree(root, target, document, skipSubtree) {
  const indexed = subtreeTextIndex(root, document, skipSubtree);
  const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */);
  let tn;
  while ((tn = walker.nextNode())) {
    if (skipSubtree?.(tn)) continue;
    if (target === tn || target.contains(tn)) return indexed.starts.get(tn) ?? 0;
  }
  return indexed.total;
}

/** 元素 c 前 off 个 child 的子树文本码点。
 * withBlockBreaks（c === container 时）：直接子元素区段间含 block 边界 \n；
 * 嵌套元素（同 block 碎片）无 \n。 */
function childSubtreeCps(c, off, document, withBlockBreaks = false, skipSubtree) {
  let acc = 0;
  let prevEl = false;
  let prevLi = false;
  let i = 0;
  for (const child of c.childNodes) {
    if (child.nodeType !== 1 && child.nodeType !== 3) continue;
    if (i >= off) break;
    const isEl = child.nodeType === 1;
    const len = isEl ? subtreeTextIndex(child, document, skipSubtree).total : (skipSubtree?.(child) ? 0 : cpsOf(child.nodeValue));
    const isLi = isEl && child.tagName === "LI";
    if (((withBlockBreaks && prevEl && isEl) || (prevLi && isLi)) && len > 0) acc += 1;
    acc += len;
    prevEl = isEl && len > 0;
    prevLi = isLi && len > 0;
    i++;
  }
  return acc;
}

export function rangeExtentInContainer(range, container, document, options = {}) {
  const skipSubtree = options.skipSubtree;
  const segs = []; // { child, isEl, start, len }
  let acc = 0;
  let prevIsEl = false;
  for (const child of container.childNodes) {
    if (child.nodeType !== 1 && child.nodeType !== 3) continue;
    const isEl = child.nodeType === 1;
    const len = isEl ? subtreeTextIndex(child, document, skipSubtree).total : (skipSubtree?.(child) ? 0 : cpsOf(child.nodeValue));
    if (prevIsEl && isEl && len > 0) acc += 1; // block 边界 \n（元素区段之间）
    segs.push({ child, isEl, start: acc, len });
    acc += len;
    prevIsEl = isEl && len > 0;
  }
  const total = acc;

  const posOf = (c, off) => {
    if (c.nodeType === 3) {
      for (const seg of segs) {
        if (!seg.isEl && seg.child === c) return seg.start + cpsOf((c.nodeValue || "").slice(0, off));
        if (seg.isEl && subtreeTextIndex(seg.child, document, skipSubtree).starts.has(c)) {
          const inner = subtreeTextIndex(seg.child, document, skipSubtree);
          return seg.start + inner.starts.get(c) + cpsOf((c.nodeValue || "").slice(0, off));
        }
      }
      return 0;
    }
    // Element boundary（嵌套路径）：off 是该元素自身的 child index。
    // 1) 定位 c 在 container 中的真实 DOM 路径 → 累计 c 起始（含前面 block 边界 \n）
    // 2) 加 c 内部前 off 个 child 的子树文本（同 block 碎片，无 \n）
    const base = elementStartInContainer(c, container, document, segs, skipSubtree);
    return base + childSubtreeCps(c, off, document, c === container, skipSubtree);
  };
  return {
    startCP: posOf(range.startContainer, range.startOffset),
    endCP: posOf(range.endContainer, range.endOffset),
    totalCP: total,
  };
}

/**
 * DSH rc.2 runtime seam: the renderer marks the separate reasoning disclosure
 * surface with data-variant="think". This is not a universal Adapter rule for
 * non-text blocks. The surface is excluded from the正文 coordinate only when
 * the actual local renderer exposes this observed structural marker.
 */
function reasoningSurfaceOptions(anchor, range) {
  const surfaces = [...anchor.querySelectorAll('[data-variant="think"]')]
    .filter((el) => el.closest("[data-chat-anchor-key]") === anchor);
  const rendererChrome = rendererSkipSubtrees(anchor);
  if (surfaces.length === 0 && rendererChrome.length === 0) return {};
  if (range && typeof range.intersectsNode === "function" && surfaces.some((el) => range.intersectsNode(el))) {
    throw new Error("selection intersects the renderer reasoning surface; reasoning is not an exact visible-text source");
  }
  if (range && typeof range.intersectsNode === "function" && rendererChrome.some((el) => range.intersectsNode(el))) {
    throw new Error("selection intersects renderer-only Markdown code chrome; exact source mapping is unavailable");
  }
  const skipSubtree = (node) => surfaces.some((surface) => surface === node || surface.contains(node)) ||
    rendererChrome.some((surface) => surface === node || surface.contains(node));
  return { skipSubtree };
}

/** safe 序列化（防御）：任何 fallback 都不得因 DOM/循环引用而炸掉 truthful reject。 */
function safeStr(v) {
  try { return JSON.stringify(v); } catch { return "<unserializable:" + (v && v.constructor ? v.constructor.name : typeof v) + ">"; }
}

/**
 * Parse the renderer identity without consulting an authoritative snapshot.
 * The returned identity is only a lookup request; it is never an event
 * sequence or source payload supplied by the browser.
 */
export function nodeKeyIdentity(nodeKey) {
  if (typeof nodeKey !== "string") return { reason: "bad-node-key" };
  const colon = nodeKey.indexOf(":");
  if (colon <= 0) return { reason: "bad-node-key" };
  const prefix = nodeKey.slice(0, colon);
  const rest = nodeKey.slice(colon + 1);
  // 真实 renderer key 形态（selection projection runtime observation）：
  //   `<anchorSeq>:assistant-step<turn>:<step>`（如 `14:assistant-step1:1`）
  //   `<anchorSeq>:input-message<uuid>`（如 `13:input-message63cb3cea-...`）
  //   `<anchorSeq>:tool-call<callId>`
  // 旧桥形态（source-anchor regression bridge）：`<kind>:<id>`（如 `assistant-step:3:5`、`user:m-9`）。
  // 统一解析：先识别 rest 中的 kind 前缀，再按 kind 提取 id。
  const kindMatch = /^(assistant-step|input-message|user|tool-call)/.exec(rest);
  // The numeric prefix is the renderer kind length, never an event sequence.
  // Validate it when present; accepting a malformed length would make a stale
  // renderer identity look valid while still leaving the prefix unauthoritative.
  if (/^\d+$/.test(prefix)) {
    if (!kindMatch || Number(prefix) !== kindMatch[1].length) return { reason: "bad-node-key-length" };
  } else if (kindMatch) {
    return { reason: "bad-node-key-prefix" };
  }
  const kind = kindMatch ? kindMatch[1] : prefix;
  const id = kindMatch ? rest.slice(kindMatch[1].length) : rest;
  if (kind === "assistant-step") {
    const m = String(id).match(/^(\d+):(\d+)$/);
    if (!m) return { reason: "bad-assistant-step-id" };
    return { kind, turn: +m[1], step: +m[2] };
  }
  if (kind === "input-message" || kind === "user" || kind === "tool-call") {
    return { kind, id };
  }
  return { kind, id };
}

export function nodeKeyToEvent(nodeKey, snapshotNodes) {
  const identity = nodeKeyIdentity(nodeKey);
  if (identity.reason) return identity;
  const { kind, id } = identity;
  if (kind === "assistant-step") {
    const t = identity.turn, s2 = identity.step;
    const cands = (snapshotNodes || []).filter((n) => n.kind === "assistant" && n.turn === t && n.step === s2);
    if (cands.length === 1) return { seq: cands[0].seq, messageId: cands[0].messageId };
    return cands.length > 1 ? { seqs: cands.map((c) => c.seq) } : { reason: "no-assistant-match" };
  }
  if (kind === "input-message" || kind === "user") {
    const cands = (snapshotNodes || []).filter((n) => (n.kind === "user" || n.kind === "input-message") && n.messageId === id);
    if (cands.length === 1) return { seq: cands[0].seq, messageId: cands[0].messageId };
    return cands.length > 1 ? { seqs: cands.map((c) => c.seq) } : { reason: "no-user-match" };
  }
  if (kind === "tool-call") {
    const cands = (snapshotNodes || []).filter((n) => (n.kind === "tool" || n.kind === "tool-call") && (n.callId === id || (n.data && n.data.callId === id)));
    if (cands.length === 1) return { seq: cands[0].seq };
    return cands.length > 1 ? { seqs: cands.map((c) => c.seq) } : { reason: "no-tool-match" };
  }
  return { reason: "unknown-kind" };
}

/** 文档顺序收集所有 anchor 容器。 */
function collectAnchorElements(document, root = document.body) {
  const walker = document.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
  const out = [];
  let el;
  while ((el = walker.nextNode())) {
    if (el.hasAttribute && el.hasAttribute("data-chat-anchor-key")) out.push(el);
  }
  return out;
}

/**
 * LEGACY / MIGRATION-ONLY —— 不是 production supported capture path。
 * 保留既有版本的 chrome 结构启发式（structuralTailNodes 等）行为，
 * 供既有测试与迁移期对照（legacy code may remain temporarily）。
 * Production-ready proposal boundary 请使用 `selectionToProposal`（positive-source
 * proposal，无 chrome heuristic、不静默丢未解析可见材料）；actual supported
 * capture path 尚未接入（见模块头状态声明）。
 */
export function selectionToSegments(range, document, snapshotNodes, opts = {}) {
  const startAnchor = resolveAnchorElement(range.startContainer, document);
  if (!startAnchor) throw new Error("selection not inside a data-chat-anchor-key container");
  const endAnchor = resolveAnchorElement(range.endContainer, document);
  if (!endAnchor) throw new Error("selection end not inside a data-chat-anchor-key container");

  // projectionVersion（v2 = markdown visible projection；默认 v1）：
  // 决定 capture 阶段可投影性检查语义 + 返回给 buildLocator 的 version。
  const projectionVersion = opts.projectionVersion === undefined ? PROJECTION_VERSION : opts.projectionVersion;
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(projectionVersion)) {
    throw new Error(`capture refused: unsupported projectionVersion ${projectionVersion}`);
  }

  const anchors = collectAnchorElements(document);
  const si = anchors.indexOf(startAnchor);
  const ei = anchors.indexOf(endAnchor);
  if (si < 0 || ei < 0) throw new Error("anchor containers not found in document order");
  const selectedAnchors = si <= ei ? anchors.slice(si, ei + 1) : anchors.slice(ei, si + 1).reverse();

  const segments = [];
  const texts = [];
  const nodeKeys = [];
  // gesture → effective source selection（selection projection contract）：
  //   source-bearing container → 保留（exactly mappable 时）；
  //   deterministic renderer-only chrome container（turn-tail/turn-error 等，无 source 事件）
  //     → 机械排除，不产生 segment；
  //   source-bearing 但无法 exact 映射 / 分类不确定 → truthful reject。
  for (const anchor of selectedAnchors) {
    const nodeKey = anchor.dataset.chatAnchorKey;
    const ev = nodeKeyToEvent(nodeKey, snapshotNodes);
    if (ev.seq === undefined) {
      // 无 source event identity：若为 deterministic renderer-only chrome（如 turn-tail）→ 排除；
      // 否则（分类不确定）→ truthful reject。
      if (isRendererChrome(nodeKey)) continue; // 机械排除：不产生 segment / nodeKey
      throw new Error(`capture refused: container "${nodeKey}" has no source event identity and is not deterministic renderer-only chrome (${ev.reason ?? safeStr(ev)}); uncertain source/chrome classification -> reject`);
    }
    if (ev.seqs !== undefined) throw new Error(`ambiguous event identity for nodeKey "${nodeKey}"`);
    // Compatibility note: current host evidence does not prove a universal renderer treatment
    // for non-text blocks. projectVisibleText therefore rejects unclassified
    // content; capture must not turn an unproven hidden/unselectable assumption
    // into an exactness oracle.
    const snap = (snapshotNodes || []).find((n) => n.seq === ev.seq);
    let domOptions;
    try {
      domOptions = reasoningSurfaceOptions(anchor, range);
    } catch (e) {
      throw new Error(`capture refused: ${e.message}`);
    }
    // 该容器的 extent：首/末容器用 Range 边界，中间容器全文
    let startCP = 0;
    let endCP = 0;
    if (anchor === startAnchor && anchor === endAnchor) {
      const ext = rangeExtentInContainer(range, anchor, document, domOptions);
      startCP = ext.startCP;
      endCP = Math.min(ext.endCP, ext.totalCP);
    } else if (anchor === startAnchor) {
      const ext = rangeExtentInContainer(range, anchor, document, domOptions);
      startCP = ext.startCP;
      endCP = ext.totalCP;
    } else if (anchor === endAnchor) {
      const ext = rangeExtentInContainer(range, anchor, document, domOptions);
      startCP = 0;
      endCP = Math.min(ext.endCP, ext.totalCP);
    } else {
      startCP = 0;
      endCP = [...containerBasisText(anchor, document, domOptions)].length;
    }
    if (endCP < startCP) throw new Error("invalid extent for container");
    // DOM basis → projection 坐标系（validation case：
    // 确定性映射，非搜索/first-match。renderer 可能附加非 source 内容
    // （如 user 消息时间戳 `05:08`）——basis 必须「以当前 projection 开头」
    // （投影是 source content 的确定性函数），extent 裁剪到 projection 长度；
    // basis 前缀与 projection 不一致 → 无法确定映射 → 明确拒绝。
    const basisText = containerBasisText(anchor, document, domOptions);
    // Compatibility note: only the locally proven text-block projection is accepted;
    // unsupported non-text content remains a truthful rejection.
    let projected = null;
    if (snap && Array.isArray(snap.content)) {
      try {
        projected = projectVisibleText(snap.content, projectionVersion);
      } catch (e) {
        throw new Error(`capture refused: projection failed for event ${ev.seq}: ${e.message}`);
      }
    }
    if (projected !== null) {
      if (!basisText.startsWith(projected)) {
        // source-bearing 但 renderer 显示与 source projection 不一致（如 context-inject
        // 折叠显示）→ 无法 exact 映射 → truthful reject（不当作 chrome 丢弃）。
        throw new Error(`capture refused: DOM basis does not prefix-match projection v${projectionVersion} for event ${ev.seq} (source-bearing content but renderer display != source projection; DOM basis=${JSON.stringify(basisText.slice(0, 600))} projection=${JSON.stringify(projected.slice(0, 600))})`);
      }
      const projLen = [...projected].length;
      if (startCP >= projLen) {
        // 整段选择落在投影之后（如只选到时间戳等 renderer 附加）→ 无 source 贡献，排除
        continue;
      }
      if (endCP > projLen) {
        // 尾部 = basis[projLen:endCP]。排除判据（validation case：CSS class 名
        // 不足——source-bearing 内容可能使用同名 class；改为**结构性**正证）：
        //   source-bearing 子树 C = 投影文本节点（basis[0:projLen) 覆盖）的最低公共
        //   祖先内容包装元素。尾部文本节点 t：
        //     - t 在 C 内（含与投影共享节点的部分覆盖）→ 无法证明 t 位于 source-bearing
        //       子树之外 → truthful reject（不静默丢弃潜在 source-bearing 尾部）；
        //     - t 在 C 外 → 结构性位于 source-bearing 子树之外（renderer 在内容容器
        //       外附加的节点，如 userRow 的 actions 分支时间戳）→ 机械排除。
        //   不依赖 CSS class / local 名（非稳定 API）。
        const tailNodes = structuralTailNodes(anchor, document, projLen, endCP);
        if (tailNodes === null || tailNodes.some((n) => !n.isChrome)) {
          throw new Error(`capture refused: extent [${startCP},${endCP}) exceeds projection length ${projLen} for event ${ev.seq}; tail node(s) lie inside the source-bearing content subtree (or cannot be proven structurally outside it) -> cannot verify as renderer-only chrome; truthful reject`);
        }
        // 额外防护：尾部文本匹配任一 source 投影 → 即使结构上在内容子树外也 reject
        const tail = [...basisText].slice(projLen, endCP).join("");
        if (tailSourceLike(tail, snapshotNodes, projectionVersion)) {
          throw new Error(`capture refused: extent [${startCP},${endCP}) exceeds projection length ${projLen} for event ${ev.seq}; tail (${JSON.stringify(tail.slice(0, 40))}) matches a source projection -> cannot verify as renderer-only chrome; truthful reject`);
        }
        // 结构性正证满足（尾部全部位于 source-bearing 子树之外）→ 机械排除尾部
        endCP = projLen;
      }
    }
    nodeKeys.push(nodeKey);
    segments.push({ eventSeq: ev.seq, start: startCP, end: endCP });
    texts.push([...basisText].slice(startCP, endCP).join("")); // 码点切片（非 UTF-16）
  }
  if (segments.length === 0) {
    throw new Error("capture refused: gesture covers no source-bearing content (all spans were renderer-only chrome)");
  }
  return { segments, selectedText: texts.join(""), nodeKeys, projectionVersion };
}

/** 判断 nodeKey 是否为 deterministic renderer-only chrome（无 source 事件的合成容器，如 turn-tail）。 */
export function isRendererChrome(nodeKey) {
  const rest = nodeKey.split(":").slice(1).join(":") || nodeKey;
  return /^(turn-tail|turn-error|turn-max-tokens)/.test(rest);
}

/**
 * 尾部文本是否可能为 source-bearing：若尾部出现在任一 snapshot 事件 content 的投影中，
 * 则无法确定其为 renderer-only chrome —— 调用方必须 reject（不静默丢弃）。
 * 检查：尾部作为连续子串出现在某事件 text content 的原始文本中（对 v1 投影即原文；
 * 对 v2 markdown 投影需在投影文本中，但保守起见也检查原文——若尾部是 markdown 可见
 * 文本则投影含它；若是标记残片则原文含它且可能 source）。
 */
function tailSourceLike(tail, snapshotNodes, projectionVersion) {
  if (!tail) return false;
  for (const n of snapshotNodes || []) {
    if (!n || !Array.isArray(n.content)) continue;
    for (const block of n.content) {
      if (!block || block.type !== "text" || typeof block.text !== "string") continue;
      const raw = block.text;
      if (raw.includes(tail)) return true;
      try {
        const p = projectVisibleText(n.content, projectionVersion);
        if (typeof p === "string" && p.includes(tail)) return true;
      } catch { /* 投影不可用时看原文 */ }
    }
  }
  return false;
}

// renderer-only chrome 的结构性正证（validation case：button 是分支级证据，
// 非节点级证明——button 存在只证明"分支里存在 renderer 控件"，不证明"分支内所有文本
// 都是 renderer-only chrome"；chrome 排除须下沉到**尾部文本节点级**，不依赖 class）：
//
//   真实 renderer 的 node-key 形态：
//     user 消息：`DIV[data-chat-anchor-key] > … > userRow[data-time-hover-root]`
//       ├─ userStack > bubble > _text      ← 全部 source 文本（内容分支，无 button）
//       └─ actions                        ← chrome 分支（MessageIconActions 渲染）：
//             ├─ SPAN.timeStart            ← 时间戳显示（文本匹配 `HH:MM` 时间格式）
//             └─ BUTTON[aria-label=复制]    ← 操作控件（无文本，svg icon）
//   结构性正证 t 为 renderer-only chrome ⟺
//     t 的祖先链存在 **行容器** `[data-time-hover-root]`，
//     行容器的含文本直接子分支**恰好 2 个**：内容分支（含全部投影文本）
//     与 chrome 分支（不含投影文本且含交互控件 <button>），
//     且 t 位于 chrome 分支内，
//     且 **t 的文本形态节点级可证为 renderer chrome**：
//        - t 在交互控件 <button> 内（操作标签），或
//        - t 匹配 renderer 时间戳显示格式（如 `04:56`）。
//   行容器含文本直接子 ≠ 2、第二分支无交互控件、t 在内容分支内 / 与投影共享节点 /
//   t 在 chrome 分支内但文本形态非 button 内亦非时间戳格式（可能承载未映射 source）→
//   无法证明 → truthful reject（调用方抛错）。"分支含 button"不是分支内任意文本
//   为 chrome 的正向证明。

/** 投影文本节点的公共行容器：含全部投影文本的最近 `[data-time-hover-root]` 祖先。 */
function rowContainerOf(textNodes, container) {
  if (!textNodes.length) return null;
  const inRow = (el) => el && el.hasAttribute && el.hasAttribute("data-time-hover-root");
  // 取第一个投影文本节点，向上找最近的 data-time-hover-root 行容器；
  // 要求该行容器包含全部投影文本（否则行判定不确定 → null）
  let el = textNodes[0].parentElement || container;
  while (el && el !== container.parentElement) {
    if (inRow(el)) return textNodes.every((tn) => el.contains(tn)) ? el : null;
    el = el.parentElement;
  }
  return null;
}

/** 元素子树是否含非空白文本。 */
function hasTextContent(el) {
  if (!el || el.nodeType !== 1) return false;
  const w = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let tn;
  while ((tn = w.nextNode())) if (tn.nodeValue.trim()) return true;
  return false;
}

/**
 * 行容器的已验证两分支定位：{ contentBranch, chromeBranch } | null。
 * contentBranch = 含全部投影文本的唯一含文本直接子；
 * chromeBranch = 另一个不含任何投影文本、且**含交互控件 `<button>`** 的含文本直接子
 *   （MessageIconActions 渲染的操作按钮——内容渲染路径（MessageText/markdown）
 *   不产生 button，button 是 renderer chrome 的确定性 DOM 特征，非 class/local 名）。
 * 行容器含文本直接子必须恰好 2 个；多出/缺失/不唯一/第二分支无交互控件 → null
 * （第二分支可能承载未映射 source → truthful reject）。
 */
function twoBranchOf(row, textNodes) {
  if (!row) return null;
  const branches = [...row.childNodes].filter((n) => n.nodeType === 1 && hasTextContent(n));
  if (branches.length !== 2) return null; // 非已验证两分支形态（多余行分支无法确认）→ reject
  const contentCands = branches.filter((b) => textNodes.every((tn) => b.contains(tn)));
  if (contentCands.length !== 1) return null; // 内容分支必须唯一
  const contentBranch = contentCands[0];
  // chrome 分支正证：另一含文本直接子 + 含交互控件 <button>
  // （MessageIconActions 操作按钮；source 内容渲染不产生 button）。
  // 仅"不含投影文本"不足以证明 chrome（第二分支可能承载未映射 source）。
  const chromeCands = branches.filter(
    (b) => b !== contentBranch && !textNodes.some((tn) => b.contains(tn)) && !!b.querySelector("button")
  );
  if (chromeCands.length !== 1) return null; // chrome 分支必须唯一且为正交互控件分支
  return { contentBranch, chromeBranch: chromeCands[0] };
}

// renderer 时间戳显示格式（真实 user actions 非 button 文本：`04:56`；可含秒 `04:56:12`）。
// 这是 chrome 分支内可节点级证为 renderer chrome 文本的确定性形态之一。
const RENDERER_TIMESTAMP_RE = /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/;

/**
 * 节点级 chrome 文本正证：文本节点 t 位于 chrome 分支内，且其文本形态可证为
 * renderer chrome（而非"分支内任意文本"）：
 *   - t 位于某交互控件 <button> 内（操作控件标签——source 内容渲染不产生 button）；或
 *   - t 匹配 renderer 时间戳显示格式（真实 MessageIconActions 时间显示，如 `04:56`）。
 * 其余文本（如 branch 内任意裸 span 文本，可能是未映射 source）→ 非 chrome → reject。
 */
function isChromeLeafText(node, chromeBranch) {
  if (!node || node.nodeType !== 3) return false;
  // 1) button 内文本：控件操作标签
  let el = node.parentElement;
  while (el && el !== chromeBranch) {
    if (el.tagName === "BUTTON") return true;
    el = el.parentElement;
  }
  // 2) 非 button 文本：必须匹配 renderer 时间戳显示格式（确定性 chrome 文本形态）
  return RENDERER_TIMESTAMP_RE.test(node.nodeValue);
}

/**
 * 结构性尾部判定：返回 basis 坐标 [projLen, endCP) 覆盖的段（同 containerBasisText
 * 坐标：直接子元素区段子树文本 + 元素区段间 "\n"）。
 * 每段 isChrome = 该段文本节点**结构性正证**为 renderer-only chrome：
 *   段节点位于已验证两分支行容器（`[data-time-hover-root]`）的 chrome 分支内。
 * @returns {Array<{node: Text|null, isChrome: boolean, newline: boolean}> | null}
 *   无法定位投影文本节点 / 行容器 / 两分支形态 → null（调用方须 truthful reject）
 */
function structuralTailNodes(container, document, projLen, endCP) {
  // 重建 basis 坐标 → 节点映射（与 containerBasisText 同坐标）
  const segments = []; // {start,end,node|null,isBoundaryNewline}
  let cursor = 0;
  let prevIsEl = false;
  for (const child of container.childNodes) {
    if (child.nodeType !== 1 && child.nodeType !== 3) continue;
    const isEl = child.nodeType === 1;
    if (prevIsEl && isEl) {
      segments.push({ start: cursor, end: cursor + 1, node: null, newline: true });
      cursor += 1;
    }
    if (isEl) {
      const walker = document.createTreeWalker(child, 4 /* SHOW_TEXT */);
      let tn;
      while ((tn = walker.nextNode())) {
        const len = cpsOf(tn.nodeValue);
        segments.push({ start: cursor, end: cursor + len, node: tn });
        cursor += len;
      }
    } else {
      const len = cpsOf(child.nodeValue);
      segments.push({ start: cursor, end: cursor + len, node: child });
      cursor += len;
    }
    prevIsEl = isEl;
  }
  // 投影文本节点 = 覆盖 [0, projLen) 的文本节点（source-bearing）
  const projTextNodes = segments
    .filter((s) => s.node !== null && s.start < projLen && s.end > 0)
    .map((s) => s.node);
  // 尾部段 = 覆盖 [projLen, endCP) 的段（含部分覆盖）
  const tailSegs = segments.filter((s) => s.end > projLen && s.start < endCP);
  if (tailSegs.length === 0) return null;
  if (projTextNodes.length === 0) return null; // 无投影文本可定位
  // 结构性正证基础：行容器 + 已验证两分支形态（renderer 确定性结构）
  const row = rowContainerOf(projTextNodes, container);
  if (!row) return null; // 无 data-time-hover-root 行 → 无法证明 chrome → reject
  const branches = twoBranchOf(row, projTextNodes);
  if (!branches) return null; // 非两分支形态（多余含文本行分支）→ 无法确认 → reject
  const chromeBranch = branches.chromeBranch;
  // 每个尾部段：chrome ⟺ 位于 chrome 分支内 **且** 节点级文本形态可证为 renderer
  // chrome（button 内操作标签 或 时间戳显示格式）。button 存在只证明分支含 renderer
  // 控件，不证明分支内任意文本是 chrome（validation case
  const projSet = new Set(projTextNodes);
  return tailSegs.map((seg) => {
    if (seg.node === null) return { node: null, newline: true, isChrome: false }; // \n 段无法归属 → 非正证
    if (projSet.has(seg.node)) return { node: seg.node, isChrome: false }; // 与投影共享节点（部分覆盖）→ 非正证
    if (!chromeBranch.contains(seg.node)) return { node: seg.node, isChrome: false }; // 不在 chrome 分支
    return { node: seg.node, isChrome: isChromeLeafText(seg.node, chromeBranch) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// selection projection production-ready proposal boundary —— positive-source proposal（2026-09-02）
// The host supplies the source-bearing structure for this supported proposal path.
// Unsupported selection remains outside this path; this module does not claim
// universal renderer support.
//
// 本路径**不**对选中但无法正向映射到 source projection 的可见材料做
// chrome/timestamp 分类，也不静默丢弃；而是把其作为 `selected-but-unresolved`
// 返回（commit 前 disclosure 数据）。不调用 legacy chrome 结构启发式。
//
// 输出语义（plain data，无 DOM 引用）：
//   proposalType: "ok" | "rejected"
//   ok:
//     segments             ordered exact source segments（仅 positively mapped）
//     effectiveSourceText  由 segments 重建的 effective source 文本
//     nodeKeys             映射到 segments 的容器 nodeKey（与 segments 对齐）
//     unresolved           选中但无正向 source 映射的可见材料：
//                            { nodeKey, eventSeq|null, text, startCP, endCP,
//                              reason: "after-projection" | "no-source-identity" }
//                          （known source identity 但无 projection → rejected，
//                            不出现 unresolved no-projection 类别）
//     projectionVersion
//     sourcePayload        （opts.sessionId 提供时）durable locator object
//                          （buildLocator 输出——Notes behavior makeItem.sourcePayload
//                           可直接消费；含 projectionVersion/sessionId/segments）
//   rejected（truthful reject，不产空 proposal / 不把已知 source-but-unmappable
//     降级为 unresolved omission）：
//     { proposalType:"rejected", reason, containerNodeKey?, detail?,
//       unresolved?（无 positive source 时的 disclosure 材料） }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Capture only the bounded browser evidence needed to reproduce the existing
 * selection mapping.  This function deliberately does not resolve renderer
 * identities or read session history; those are host-authoritative steps.
 *
 * The returned anchors retain the exact DOM basis and code-point extents that
 * selectionToProposal() previously computed before doing identity/projection
 * work.  `order` is explicit so the host cannot accidentally regroup a
 * multi-anchor selection.
 */
export function selectionToCaptureEvidence(range, document, opts = {}) {
  const startAnchor = resolveAnchorElement(range.startContainer, document);
  if (!startAnchor) return { proposalType: "rejected", reason: "selection not inside a data-chat-anchor-key container" };
  const endAnchor = resolveAnchorElement(range.endContainer, document);
  if (!endAnchor) return { proposalType: "rejected", reason: "selection end not inside a data-chat-anchor-key container" };

  const projectionVersion = opts.projectionVersion === undefined ? PROJECTION_VERSION : opts.projectionVersion;
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(projectionVersion)) {
    return { proposalType: "rejected", reason: `unsupported projectionVersion ${projectionVersion}` };
  }

  const anchors = collectAnchorElements(document);
  const si = anchors.indexOf(startAnchor);
  const ei = anchors.indexOf(endAnchor);
  if (si < 0 || ei < 0) return { proposalType: "rejected", reason: "anchor containers not found in document order" };
  // 反向选择：按 DOM 顺序归一（source order 保持；unresolved 顺序随所选容器顺序）
  const selectedAnchors = si <= ei ? anchors.slice(si, ei + 1) : anchors.slice(ei, si + 1).reverse();

  const evidence = [];
  for (let order = 0; order < selectedAnchors.length; order++) {
    const anchor = selectedAnchors[order];
    const nodeKey = anchor.dataset.chatAnchorKey;
    if (typeof nodeKey !== "string" || nodeKey.length === 0) {
      return { proposalType: "rejected", reason: "anchor container has no valid data-chat-anchor-key" };
    }
    let domOptions;
    try {
      domOptions = reasoningSurfaceOptions(anchor, range);
    } catch (e) {
      return { proposalType: "rejected", reason: e.message, containerNodeKey: nodeKey };
    }
    // 该容器 extent（同 selectionToSegments：首/末用 Range 边界，中间全文）
    let startCP = 0;
    let endCP = 0;
    if (anchor === startAnchor && anchor === endAnchor) {
      const ext = rangeExtentInContainer(range, anchor, document, domOptions);
      startCP = ext.startCP;
      endCP = Math.min(ext.endCP, ext.totalCP);
    } else if (anchor === startAnchor) {
      const ext = rangeExtentInContainer(range, anchor, document, domOptions);
      startCP = ext.startCP;
      endCP = ext.totalCP;
    } else if (anchor === endAnchor) {
      const ext = rangeExtentInContainer(range, anchor, document, domOptions);
      startCP = 0;
      endCP = Math.min(ext.endCP, ext.totalCP);
    } else {
      startCP = 0;
      endCP = [...containerBasisText(anchor, document, domOptions)].length;
    }
    if (endCP < startCP) return { proposalType: "rejected", reason: "invalid extent for container", containerNodeKey: nodeKey };
    const basisText = containerBasisText(anchor, document, domOptions);
    evidence.push({ nodeKey, basisText, startCP, endCP, order });
  }
  return { proposalType: "ok", projectionVersion, anchors: evidence };
}

/**
 * Reconstruct the existing positive-source proposal from browser evidence and
 * an authoritative host snapshot.  No browser-provided event sequence,
 * effective text, or durable locator is accepted; all of those are derived
 * below from the snapshot and the existing projection rules.
 */
export function proposalFromCaptureEvidence(captureEvidence, snapshotNodes, opts = {}) {
  const evidence = captureEvidence && typeof captureEvidence === "object" ? captureEvidence : {};
  const projectionVersion = opts.projectionVersion === undefined
    ? evidence.projectionVersion
    : opts.projectionVersion;
  if (!SUPPORTED_PROJECTION_VERSIONS.includes(projectionVersion)) {
    return { proposalType: "rejected", reason: `unsupported projectionVersion ${projectionVersion}` };
  }
  if (!Array.isArray(evidence.anchors) || evidence.anchors.length === 0) {
    return { proposalType: "rejected", reason: "capture evidence has no anchors" };
  }

  const segments = [];
  const texts = [];
  const nodeKeys = [];
  const unresolved = [];

  for (let index = 0; index < evidence.anchors.length; index++) {
    const item = evidence.anchors[index];
    const nodeKey = item?.nodeKey;
    if (item && (Object.prototype.hasOwnProperty.call(item, "eventSeq") || Object.prototype.hasOwnProperty.call(item, "seq"))) {
      return { proposalType: "rejected", reason: "capture evidence must not contain authoritative event identity", containerNodeKey: nodeKey };
    }
    if (typeof nodeKey !== "string" || nodeKey.length === 0 || typeof item?.basisText !== "string") {
      return { proposalType: "rejected", reason: "malformed capture evidence anchor", containerNodeKey: nodeKey };
    }
    if (item.order !== index) {
      return { proposalType: "rejected", reason: "capture evidence anchor order is invalid", containerNodeKey: nodeKey };
    }
    const { startCP, endCP } = item;
    if (!Number.isSafeInteger(startCP) || !Number.isSafeInteger(endCP) || startCP < 0 || endCP < startCP || endCP > cpsOf(item.basisText)) {
      return { proposalType: "rejected", reason: "invalid extent for capture evidence", containerNodeKey: nodeKey };
    }

    const ev = nodeKeyToEvent(nodeKey, snapshotNodes);
    if (ev.seqs !== undefined) {
      return { proposalType: "rejected", reason: `ambiguous event identity for nodeKey "${nodeKey}"`, containerNodeKey: nodeKey };
    }
    const basisText = item.basisText;

    if (ev.seq === undefined) {
      if (isRendererChrome(nodeKey)) {
        // renderer 合成容器（turn-tail / turn-error / turn-max-tokens 等，无 source
        // event identity）：无正向 source ownership/mapping 证据 → unresolved
        // （不猜 chrome、不静默丢弃）。C 类。
        const text = [...basisText].slice(startCP, endCP).join("");
        if (text) {
          unresolved.push({ nodeKey, eventSeq: null, text, startCP, endCP, reason: "no-source-identity" });
        }
        continue;
      }
      // data-chat-anchor-key 声明 source 容器 kind（input-message / assistant-step /
      // tool-call 等）但 snapshot 中无匹配 event：known source identity 且无法生成
      // exact projection → truthful reject（B 类；不 unresolved、不静默丢弃）。
      return {
        proposalType: "rejected",
        reason: `container "${nodeKey}" declares a source container kind but has no matching event in snapshot (${ev.reason ?? safeStr(ev)}); known source identity with no exact projection -> truthful reject`,
        containerNodeKey: nodeKey,
      };
    }

    const snap = (snapshotNodes || []).find((n) => n.seq === ev.seq);
    // known source identity → 必须有可投影 content 才能 exact map：
    // snapshot 缺失 / content 非数组 / 含非 text block / 投影失败 → truthful reject
    // （known source-bearing but not exactly mappable；不得降级为 unresolved omission）。
    if (!snap || !Array.isArray(snap.content) || snap.content.length === 0) {
      return {
        proposalType: "rejected",
        reason: `event ${ev.seq} has known source identity but no projectable content blocks (snapshot missing or content empty/not an array); cannot map exactly -> truthful reject`,
        containerNodeKey: nodeKey,
      };
    }
    // Compatibility note: unknown non-text blocks are not classified as hidden by
    // this adapter seam. v2 has one runtime-bounded exception for DSH rc.2's
    // separately rendered reasoning block; projectVisibleMarkdownContent omits
    // it from the visible text projection, and basis prefix alignment still
    // rejects a selection that is actually inside the reasoning surface.
    let projected;
    try {
      projected = projectVisibleText(snap.content, projectionVersion);
    } catch (e) {
      return { proposalType: "rejected", reason: `projection failed for event ${ev.seq}: ${e.message}`, containerNodeKey: nodeKey };
    }
    {
      // Markdown renderers do not expose terminal block-separator newlines in
      // the selectable DOM text, although the source projection retains them
      // for locator/re-entry semantics.  Compare against the renderer-visible
      // projection for this boundary check only; all mapped offsets and
      // persisted source data remain in the original projection coordinate
      // space.
      const rendererProjection = projected.replace(/\n+$/, "");
      if (!basisText.startsWith(rendererProjection)) {
        // 已知 source identity 但 renderer 显示 ≠ source projection（如 context-inject
        // 折叠显示）→ source-bearing but not exactly mappable → **truthful reject**。
        // 不得降级为 unresolved omission。
        return {
          proposalType: "rejected",
          reason: `DOM basis does not prefix-match projection v${projectionVersion} for event ${ev.seq} (known source-bearing content but renderer display != source projection; cannot map exactly)`,
          containerNodeKey: nodeKey,
          detail: { basisHead: basisText.slice(0, 600), projectionHead: projected.slice(0, 600), basisLen: basisText.length, projLen: projected.length },
        };
      }
      const projLen = [...rendererProjection].length;
      // 正向映射部分 = extent 与 [0, projLen) 的交集（若存在）
      const mappedStart = startCP;
      const mappedEnd = Math.min(endCP, projLen);
      if (mappedEnd > mappedStart) {
        nodeKeys.push(nodeKey);
        segments.push({ eventSeq: ev.seq, start: mappedStart, end: mappedEnd });
        texts.push([...basisText].slice(mappedStart, mappedEnd).join(""));
      }
      // 选中但超出 projection 的可见材料（时间戳/其它附加/未知 source 均不猜）：
      // [max(startCP, projLen), endCP) 有内容 → unresolved（reason: after-projection）
      const unresolvedStart = Math.max(startCP, projLen);
      if (endCP > unresolvedStart) {
        const text = [...basisText].slice(unresolvedStart, endCP).join("");
        if (text) {
          unresolved.push({ nodeKey, eventSeq: ev.seq, text, startCP: unresolvedStart, endCP, reason: "after-projection" });
        }
      }
    }
  }

  if (segments.length === 0) {
    // 无任何 positively mapped source span → 不产空 Source Anchor proposal。
    return {
      proposalType: "rejected",
      reason: "gesture covers no positively mapped source spans (no exact source segments); nothing to anchor",
      unresolved,
    };
  }
  const out = { proposalType: "ok", segments, effectiveSourceText: texts.join(""), nodeKeys, unresolved, projectionVersion };
  // opts.sessionId 提供时 → durable sourcePayload（locator），
  // 供 Notes behavior source-aware item 的 sourcePayload 持久化前直接消费；无效 sessionId → rejected
  // （不生成必然无法绑定 session 的 locator）。
  if (opts.sessionId !== undefined) {
    if (typeof opts.sessionId !== "string" || !/^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/.test(opts.sessionId)) {
      return { proposalType: "rejected", reason: `invalid sessionId shape "${opts.sessionId}"`, unresolved };
    }
    try {
      const ids = [...new Set(out.segments.map((segment) => snapshotNodes.find((node) => node?.seq === segment.eventSeq)?.messageId).filter((id) => typeof id === "string" && id.length > 0))];
      if (ids.length !== 1 || out.segments.some((segment) => typeof snapshotNodes.find((node) => node?.seq === segment.eventSeq)?.messageId !== "string")) {
        return { proposalType: "rejected", reason: "durable Source identity requires one authoritative messageId", unresolved };
      }
      out.sourcePayload = buildMessageIdentity({ sessionId: opts.sessionId, messageId: ids[0] });
    } catch (e) {
      return { proposalType: "rejected", reason: `sourcePayload identity build failed: ${e.message}`, unresolved };
    }
  }
  return out;
}

/**
 * Equivalence wrapper retained for the existing selection/proposal tests and
 * any callers that already have a snapshot.  The browser capture facade uses
 * selectionToCaptureEvidence() directly and defers this second phase to the
 * authoritative host.
 */
export function selectionToProposal(range, document, snapshotNodes, opts = {}) {
  const evidence = selectionToCaptureEvidence(range, document, opts);
  if (evidence.proposalType === "rejected") return evidence;
  return proposalFromCaptureEvidence(evidence, snapshotNodes, opts);
}
