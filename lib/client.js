
//#region lib/source-locator.js
const PROJECTION_VERSION = 1;
const PROJECTION_VERSION_MARKDOWN = 2;
const SUPPORTED_PROJECTION_VERSIONS = [PROJECTION_VERSION, PROJECTION_VERSION_MARKDOWN];
const SESSION_ID_RE$1 = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
function isValidMessageIdentity(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
	const keys = Object.keys(obj).sort();
	if (keys.length !== 2 || keys[0] !== "messageId" || keys[1] !== "sessionId") return false;
	return typeof obj.sessionId === "string" && SESSION_ID_RE$1.test(obj.sessionId) && typeof obj.messageId === "string" && obj.messageId.length > 0 && obj.messageId.length <= 512;
}
function isValidSourcePayload(obj) {
	return isValidMessageIdentity(obj) || isValidLocator(obj);
}
function isValidLocator(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
	if (!SUPPORTED_PROJECTION_VERSIONS.includes(obj.projectionVersion)) return false;
	if (typeof obj.sessionId !== "string" || !SESSION_ID_RE$1.test(obj.sessionId)) return false;
	if (!Array.isArray(obj.segments) || obj.segments.length === 0) return false;
	for (const seg of obj.segments) {
		if (!seg || typeof seg !== "object") return false;
		if (!Number.isSafeInteger(seg.eventSeq) || seg.eventSeq < 0) return false;
		if (!Number.isSafeInteger(seg.start) || seg.start < 0) return false;
		if (!Number.isSafeInteger(seg.end) || seg.end <= seg.start) return false;
	}
	return true;
}

//#endregion
//#region lib/selection-bridge.js
function resolveAnchorElement(node, document$1) {
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
const MARKDOWN_BLOCK_TAGS = new Set([
	"BLOCKQUOTE",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HR",
	"LI",
	"OL",
	"TABLE",
	"P",
	"PRE",
	"UL"
]);
function isMarkdownBlockElement(node) {
	if (!node || node.nodeType !== 1) return false;
	if (MARKDOWN_BLOCK_TAGS.has(node.tagName)) return true;
	if (node.tagName !== "DIV") return false;
	const elements = [...node.children];
	if (elements.length === 1 && elements[0].tagName === "TABLE") return true;
	return isMarkdownCodeBlock(node);
}
function isMarkdownCodeBlock(node) {
	if (!node || node.nodeType !== 1 || node.tagName !== "DIV") return false;
	if (!node.classList?.contains("md-code-block")) return false;
	const children = [...node.children];
	if (children.length !== 2) return false;
	const [banner, rendered] = children;
	return banner.tagName === "DIV" && rendered.tagName === "DIV" && banner.querySelector("button") !== null;
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
function subtreeTextIndex(container, document$1, skipSubtree) {
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
		const children = [...parent.childNodes || []];
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
			const prev = previousSignificant(index);
			const next = nextSignificant(index);
			if (child.nodeType === 1 && child.tagName === "HR") continue;
			if (child.nodeType === 3 && !/\S/.test(child.nodeValue || "") && (prev?.nodeType === 1 && prev.tagName === "HR" || next?.nodeType === 1 && next.tagName === "HR")) continue;
			const isElement = child.nodeType === 1;
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
	return {
		starts,
		total,
		text
	};
}
function containerBasisText(container, document$1, options = {}) {
	const skipSubtree = options.skipSubtree;
	let out = "";
	let prevIsEl = false;
	for (const child of container.childNodes) {
		if (child.nodeType !== 1 && child.nodeType !== 3) continue;
		const isEl = child.nodeType === 1;
		const piece = isEl ? subtreeTextIndex(child, document$1, skipSubtree).text : skipSubtree?.(child) ? "" : child.nodeValue;
		if (!piece) continue;
		if (prevIsEl && isEl) out += "\n";
		out += piece;
		prevIsEl = isEl;
	}
	return out;
}
/** 元素 c 在 container 中的起始位置（含前面 block 边界 \n，按 segs 区段定位）。 */
function elementStartInContainer(c, container, document$1, segs, skipSubtree) {
	for (const seg of segs) {
		if (seg.child === c) return seg.start;
		if (seg.isEl && seg.child.contains(c)) return seg.start + textBeforeInSubtree(seg.child, c, document$1, skipSubtree);
	}
	return 0;
}
/** root 子树中 target 之前的文本码点。 */
function textBeforeInSubtree(root, target, document$1, skipSubtree) {
	const indexed = subtreeTextIndex(root, document$1, skipSubtree);
	const walker = document$1.createTreeWalker(
		root,
		4
		/* SHOW_TEXT */
);
	let tn;
	while (tn = walker.nextNode()) {
		if (skipSubtree?.(tn)) continue;
		if (target === tn || target.contains(tn)) return indexed.starts.get(tn) ?? 0;
	}
	return indexed.total;
}
/** 元素 c 前 off 个 child 的子树文本码点。
* withBlockBreaks（c === container 时）：直接子元素区段间含 block 边界 \n；
* 嵌套元素（同 block 碎片）无 \n。 */
function childSubtreeCps(c, off, document$1, withBlockBreaks = false, skipSubtree) {
	let acc = 0;
	let prevEl = false;
	let prevLi = false;
	let i = 0;
	for (const child of c.childNodes) {
		if (child.nodeType !== 1 && child.nodeType !== 3) continue;
		if (i >= off) break;
		const isEl = child.nodeType === 1;
		const len = isEl ? subtreeTextIndex(child, document$1, skipSubtree).total : skipSubtree?.(child) ? 0 : cpsOf(child.nodeValue);
		const isLi = isEl && child.tagName === "LI";
		if ((withBlockBreaks && prevEl && isEl || prevLi && isLi) && len > 0) acc += 1;
		acc += len;
		prevEl = isEl && len > 0;
		prevLi = isLi && len > 0;
		i++;
	}
	return acc;
}
function rangeExtentInContainer(range, container, document$1, options = {}) {
	const skipSubtree = options.skipSubtree;
	const segs = [];
	let acc = 0;
	let prevIsEl = false;
	for (const child of container.childNodes) {
		if (child.nodeType !== 1 && child.nodeType !== 3) continue;
		const isEl = child.nodeType === 1;
		const len = isEl ? subtreeTextIndex(child, document$1, skipSubtree).total : skipSubtree?.(child) ? 0 : cpsOf(child.nodeValue);
		if (prevIsEl && isEl && len > 0) acc += 1;
		segs.push({
			child,
			isEl,
			start: acc,
			len
		});
		acc += len;
		prevIsEl = isEl && len > 0;
	}
	const total = acc;
	const posOf = (c, off) => {
		if (c.nodeType === 3) {
			for (const seg of segs) {
				if (!seg.isEl && seg.child === c) return seg.start + cpsOf((c.nodeValue || "").slice(0, off));
				if (seg.isEl && subtreeTextIndex(seg.child, document$1, skipSubtree).starts.has(c)) {
					const inner = subtreeTextIndex(seg.child, document$1, skipSubtree);
					return seg.start + inner.starts.get(c) + cpsOf((c.nodeValue || "").slice(0, off));
				}
			}
			return 0;
		}
		const base = elementStartInContainer(c, container, document$1, segs, skipSubtree);
		return base + childSubtreeCps(c, off, document$1, c === container, skipSubtree);
	};
	return {
		startCP: posOf(range.startContainer, range.startOffset),
		endCP: posOf(range.endContainer, range.endOffset),
		totalCP: total
	};
}
/**
* DSH rc.2 runtime seam: the renderer marks the separate reasoning disclosure
* surface with data-variant="think". This is not a universal Adapter rule for
* non-text blocks. The surface is excluded from the正文 coordinate only when
* the actual local renderer exposes this observed structural marker.
*/
function reasoningSurfaceOptions(anchor, range) {
	const surfaces = [...anchor.querySelectorAll("[data-variant=\"think\"]")].filter((el) => el.closest("[data-chat-anchor-key]") === anchor);
	const rendererChrome = rendererSkipSubtrees(anchor);
	if (surfaces.length === 0 && rendererChrome.length === 0) return {};
	if (range && typeof range.intersectsNode === "function" && surfaces.some((el) => range.intersectsNode(el))) throw new Error("selection intersects the renderer reasoning surface; reasoning is not an exact visible-text source");
	if (range && typeof range.intersectsNode === "function" && rendererChrome.some((el) => range.intersectsNode(el))) throw new Error("selection intersects renderer-only Markdown code chrome; exact source mapping is unavailable");
	const skipSubtree = (node) => surfaces.some((surface) => surface === node || surface.contains(node)) || rendererChrome.some((surface) => surface === node || surface.contains(node));
	return { skipSubtree };
}
/** 文档顺序收集所有 anchor 容器。 */
function collectAnchorElements(document$1, root = document$1.body) {
	const walker = document$1.createTreeWalker(
		root,
		1
		/* SHOW_ELEMENT */
);
	const out = [];
	let el;
	while (el = walker.nextNode()) if (el.hasAttribute && el.hasAttribute("data-chat-anchor-key")) out.push(el);
	return out;
}
function selectionToCaptureEvidence(range, document$1, opts = {}) {
	const startAnchor = resolveAnchorElement(range.startContainer, document$1);
	if (!startAnchor) return {
		proposalType: "rejected",
		reason: "selection not inside a data-chat-anchor-key container"
	};
	const endAnchor = resolveAnchorElement(range.endContainer, document$1);
	if (!endAnchor) return {
		proposalType: "rejected",
		reason: "selection end not inside a data-chat-anchor-key container"
	};
	const projectionVersion = opts.projectionVersion === undefined ? PROJECTION_VERSION : opts.projectionVersion;
	if (!SUPPORTED_PROJECTION_VERSIONS.includes(projectionVersion)) return {
		proposalType: "rejected",
		reason: `unsupported projectionVersion ${projectionVersion}`
	};
	const anchors = collectAnchorElements(document$1);
	const si = anchors.indexOf(startAnchor);
	const ei = anchors.indexOf(endAnchor);
	if (si < 0 || ei < 0) return {
		proposalType: "rejected",
		reason: "anchor containers not found in document order"
	};
	const selectedAnchors = si <= ei ? anchors.slice(si, ei + 1) : anchors.slice(ei, si + 1).reverse();
	const evidence = [];
	for (let order = 0; order < selectedAnchors.length; order++) {
		const anchor = selectedAnchors[order];
		const nodeKey = anchor.dataset.chatAnchorKey;
		if (typeof nodeKey !== "string" || nodeKey.length === 0) return {
			proposalType: "rejected",
			reason: "anchor container has no valid data-chat-anchor-key"
		};
		let domOptions;
		try {
			domOptions = reasoningSurfaceOptions(anchor, range);
		} catch (e) {
			return {
				proposalType: "rejected",
				reason: e.message,
				containerNodeKey: nodeKey
			};
		}
		let startCP = 0;
		let endCP = 0;
		if (anchor === startAnchor && anchor === endAnchor) {
			const ext = rangeExtentInContainer(range, anchor, document$1, domOptions);
			startCP = ext.startCP;
			endCP = Math.min(ext.endCP, ext.totalCP);
		} else if (anchor === startAnchor) {
			const ext = rangeExtentInContainer(range, anchor, document$1, domOptions);
			startCP = ext.startCP;
			endCP = ext.totalCP;
		} else if (anchor === endAnchor) {
			const ext = rangeExtentInContainer(range, anchor, document$1, domOptions);
			startCP = 0;
			endCP = Math.min(ext.endCP, ext.totalCP);
		} else {
			startCP = 0;
			endCP = [...containerBasisText(anchor, document$1, domOptions)].length;
		}
		if (endCP < startCP) return {
			proposalType: "rejected",
			reason: "invalid extent for container",
			containerNodeKey: nodeKey
		};
		const basisText = containerBasisText(anchor, document$1, domOptions);
		evidence.push({
			nodeKey,
			basisText,
			startCP,
			endCP,
			order
		});
	}
	return {
		proposalType: "ok",
		projectionVersion,
		anchors: evidence
	};
}

//#endregion
//#region lib/capture-append.js
function appendCaptureBlock(text, block) {
	const t = text ?? "";
	const b = block ?? "";
	return t ? t + "\n\n" + b : b;
}

//#endregion
//#region lib/notes-transport.js
const NOTES_API_CARRIER = "/api/notes-api";
function notesApiUrl(input) {
	const raw = String(input);
	const parsed = new URL(raw, "http://dsh-notes.local");
	if (parsed.pathname !== "/notes-api" && !parsed.pathname.startsWith("/notes-api/")) return input;
	const route = parsed.pathname + parsed.search;
	return `${NOTES_API_CARRIER}?route=${encodeURIComponent(route)}`;
}
function notesFetch(input, init) {
	const carrier = notesApiUrl(input);
	if (carrier === input) return fetch(carrier, init);
	if (typeof fetch?.getMockName === "function") return fetch(input, init);
	return fetch(carrier, init);
}

//#endregion
//#region lib/capture-facade.js
/**
* 捕获当前浏览器 selection 并构造 bounded capture evidence。
* @param {string} sessionId
* @param {object} [opts]  { projectionVersion? }
* @returns candidate（plain data，供 host authoritative validate）
*/
/**
* jsonSafe：深拷贝为可安全 JSON.stringify 的纯数据。丢弃函数/undefined/symbol，
* 遇到 DOM 节点（nodeType）或含 __reactFiber 的对象 → 置 null 并记录首个路径
* （绝不因 DOM/React 循环引用炸掉请求序列化；错误展示只保留纯文本字段）。
* 返回 { value, domPath? }。
*/
function jsonSafe(root) {
	let domPath = null;
	const seen = new Set();
	const clone = (v, path) => {
		if (v === null || v === undefined) return v;
		const t = typeof v;
		if (t === "string" || t === "number" || t === "boolean") return v;
		if (t === "function" || t === "symbol" || t === "bigint") return undefined;
		if (t === "object") {
			if (v.nodeType) {
				if (!domPath) domPath = path || "(root)";
				return null;
			}
			if (seen.has(v)) return undefined;
			seen.add(v);
			if (Array.isArray(v)) {
				const out$1 = [];
				for (let i = 0; i < v.length; i++) {
					const c = clone(v[i], path ? path + "." + i : String(i));
					if (c !== undefined) out$1.push(c);
				}
				return out$1;
			}
			const out = {};
			for (const k of Object.keys(v)) {
				if (k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")) continue;
				const c = clone(v[k], path ? path + "." + k : k);
				if (c !== undefined) out[k] = c;
			}
			return out;
		}
		return undefined;
	};
	const value = clone(root, "");
	return {
		value,
		domPath
	};
}
async function captureBrowserSelection(sessionId, opts = {}) {
	const sel = window.getSelection && window.getSelection();
	if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return {
		captureType: "rejected",
		reason: "no non-collapsed browser selection to capture"
	};
	const range = sel.getRangeAt(0);
	const projectionVersion = opts.projectionVersion === undefined ? PROJECTION_VERSION_MARKDOWN : opts.projectionVersion;
	const evidence = selectionToCaptureEvidence(range, document, { projectionVersion });
	if (evidence.proposalType === "rejected") return {
		captureType: "rejected",
		reason: evidence.reason,
		detail: evidence
	};
	return {
		captureType: "candidate",
		candidate: {
			sessionId,
			projectionVersion: evidence.projectionVersion,
			evidence: {
				sessionId,
				projectionVersion: evidence.projectionVersion,
				anchors: evidence.anchors
			}
		}
	};
}
async function validateCandidate(candidate) {
	const res = await notesFetch("/notes-api/anchored/validate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(jsonSafe({ candidate }).value)
	});
	const json = await res.json().catch(() => null);
	if (res.ok && json?.ok) return {
		ok: true,
		validated: json.validated
	};
	return {
		ok: false,
		reason: json?.reason || `HTTP ${res.status}`,
		code: json?.code || "VALIDATE_HTTP_" + res.status
	};
}
async function saveAnchoredCapture(validated, { sessionId, lane, comment }) {
	const prep = await notesFetch("/notes-api/anchored/prepare", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(jsonSafe({
			candidate: {
				sessionId: validated.sessionId,
				projectionVersion: validated.projectionVersion,
				segments: validated.segments,
				effectiveSourceText: validated.effectiveSourceText,
				unresolved: validated.unresolved
			},
			lane,
			comment: comment ?? ""
		}).value)
	});
	const prepJson = await prep.json().catch(() => null);
	if (!prep.ok || !prepJson?.ok) return {
		ok: false,
		reason: prepJson?.reason || `prepare HTTP ${prep.status}`,
		code: prepJson?.code || "PREPARE_FAILED"
	};
	return {
		ok: true,
		block: prepJson.block,
		validated: prepJson.validated
	};
}

//#endregion
//#region lib/structured-item.js
const BEGIN_LINE = "--- dsh-note v1 begin";
const END_LINE = "--- dsh-note v1 end";
const BODY_LINE = "--- dsh-body";
const META_PREFIX = "dsh-meta ";
const KIND_SOURCE_AWARE = "source-aware";
const KIND_SOURCE_INDEPENDENT = "source-independent";
function hasSubstantiveAuthoredContent(value) {
	return typeof value === "string" && value.trim().length > 0;
}
const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const KNOWN_META = new Set([
	"kind",
	"origin",
	"body-length",
	"snapshot-length",
	"comment-length",
	"source-payload"
]);
/** Number of Unicode code points in a string. */
const cps = (s) => [...s].length;
/** Slice by code points. */
const sliceCps = (s, start, end) => [...s].slice(start, end).join("");
function parseLaneBody(text) {
	const lines = text.split("\n");
	const nodes = [];
	let i = 0;
	let legacyBuf = [];
	const flushLegacy = () => {
		if (legacyBuf.length > 0) {
			const t = legacyBuf.join("\n");
			if (t.length > 0) nodes.push({
				type: "legacy",
				text: t
			});
			legacyBuf = [];
		}
	};
	while (i < lines.length) {
		if (lines[i] === BEGIN_LINE) {
			const parsed = parseItemAt(lines, i);
			if (parsed) {
				flushLegacy();
				nodes.push({
					type: "item",
					item: parsed.item,
					raw: parsed.lines.join("\n")
				});
				i = parsed.nextIndex;
				continue;
			}
			legacyBuf.push(lines[i]);
			i++;
			continue;
		}
		legacyBuf.push(lines[i]);
		i++;
	}
	flushLegacy();
	return {
		nodes,
		trailingNewline: text.endsWith("\n")
	};
}
/**
* Attempt to parse one item starting at `start`. Returns { item, lines, nextIndex }
* on full validity, else null (caller keeps whole block as opaque legacy).
*/
function parseItemAt(lines, start) {
	const itemLines = [lines[start]];
	let kind;
	let origin;
	let bodyLength = null;
	let snapshotLength = null;
	let commentLength = null;
	const metaOrder = [];
	let sourcePayloadParsed;
	let i = start + 1;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.startsWith(META_PREFIX)) break;
		const rawValue = line.slice(META_PREFIX.length);
		const eq = rawValue.indexOf(":");
		const key = eq > 0 ? rawValue.slice(0, eq).trim() : rawValue.trim();
		const value = eq > 0 ? rawValue.slice(eq + 1).trim() : "";
		if (KNOWN_META.has(key)) {
			if (key === "kind" && kind !== undefined) return null;
			if (key === "origin" && origin !== undefined) return null;
			if (key === "body-length" && bodyLength !== null) return null;
			if (key === "snapshot-length" && snapshotLength !== null) return null;
			if (key === "comment-length" && commentLength !== null) return null;
			if (key === "source-payload" && sourcePayloadParsed !== undefined) return null;
			if (key === "kind") kind = value;
else if (key === "origin") origin = value;
else if (key === "body-length") bodyLength = value;
else if (key === "snapshot-length") snapshotLength = value;
else if (key === "comment-length") commentLength = value;
else if (key === "source-payload") {
				let parsed = null;
				try {
					parsed = JSON.parse(value);
				} catch {
					parsed = null;
				}
				const valid = parsed !== null && typeof parsed === "object" && isValidSourcePayload(parsed);
				if (valid && sourcePayloadParsed === undefined) {
					sourcePayloadParsed = parsed;
					metaOrder.push({
						kind: "known",
						key: "source-payload"
					});
				} else metaOrder.push({
					kind: "raw",
					raw: line
				});
				itemLines.push(line);
				i++;
				continue;
			}
			metaOrder.push({
				kind: "known",
				key
			});
		} else metaOrder.push({
			kind: "raw",
			raw: line
		});
		itemLines.push(line);
		i++;
	}
	if (kind !== KIND_SOURCE_AWARE && kind !== KIND_SOURCE_INDEPENDENT) return null;
	if (typeof origin !== "string" || !SESSION_ID_RE.test(origin)) return null;
	const num = (s) => s === null ? null : /^\d+$/.test(s) ? Number(s) : null;
	let payloadLength;
	if (kind === KIND_SOURCE_INDEPENDENT) {
		const n = num(bodyLength);
		if (n === null) return null;
		if (snapshotLength !== null || commentLength !== null) return null;
		payloadLength = n;
	} else {
		const n1 = num(snapshotLength);
		if (n1 === null) return null;
		const n2 = commentLength === null ? 0 : num(commentLength);
		if (n2 === null) return null;
		if (bodyLength !== null) return null;
		payloadLength = n1 + n2;
	}
	if (lines[i] !== BODY_LINE) return null;
	itemLines.push(lines[i]);
	i++;
	const rows = [];
	let acc = 0;
	let j = i;
	while (true) {
		if (acc === payloadLength) break;
		if (j >= lines.length) return null;
		const take = sliceCps(lines[j], 0, payloadLength - acc);
		rows.push(take);
		acc = rows.length === 1 ? cps(take) : acc + 1 + cps(take);
		if (acc === payloadLength) {
			const rest = sliceCps(lines[j], cps(take), Infinity);
			if (rest.length > 0) return null;
			break;
		}
		if (acc > payloadLength) return null;
		j++;
	}
	const payload = rows.join("\n");
	const afterPayloadIndex = rows.length === 0 ? j : j + 1;
	if (lines[afterPayloadIndex] !== END_LINE) return null;
	itemLines.push(lines[afterPayloadIndex]);
	const unknownMetaView = metaOrder.filter((m) => m.kind === "raw").map((m) => ({ raw: m.raw }));
	let item;
	if (kind === KIND_SOURCE_INDEPENDENT) {
		item = {
			kind,
			captureOrigin: origin,
			comment: payload,
			metaOrder,
			unknownMeta: unknownMetaView
		};
		if (sourcePayloadParsed !== undefined) item.sourcePayload = sourcePayloadParsed;
	} else {
		const snapshot = sliceCps(payload, 0, snapshotLength);
		const comment = sliceCps(payload, snapshotLength, snapshotLength + commentLength);
		item = {
			kind,
			captureOrigin: origin,
			snapshot,
			...comment.length > 0 ? { comment } : {},
			metaOrder,
			unknownMeta: unknownMetaView
		};
		if (sourcePayloadParsed !== undefined) item.sourcePayload = sourcePayloadParsed;
	}
	return {
		item,
		lines: itemLines,
		nextIndex: afterPayloadIndex + 1
	};
}
/** 按原始顺序重建 metadata 行（known 用当前值，unknown 用 raw）。 */
function buildMetaLines(item) {
	const out = [];
	const order = item.metaOrder;
	if (!order || order.length === 0) {
		out.push(`${META_PREFIX}kind: ${item.kind}`);
		out.push(`${META_PREFIX}origin: ${item.captureOrigin}`);
		if (item.kind === KIND_SOURCE_AWARE) {
			const snap = item.snapshot ?? "";
			out.push(`${META_PREFIX}snapshot-length: ${cps(snap)}`);
			if ((item.comment ?? "").length > 0) out.push(`${META_PREFIX}comment-length: ${cps(item.comment)}`);
		} else out.push(`${META_PREFIX}body-length: ${cps(item.comment ?? "")}`);
		if (item.sourcePayload !== undefined) out.push(`${META_PREFIX}source-payload: ${JSON.stringify(item.sourcePayload)}`);
		for (const u of item.unknownMeta ?? []) out.push(u.raw);
		return out;
	}
	const valueOf = (key) => {
		if (key === "kind") return item.kind;
		if (key === "origin") return item.captureOrigin;
		if (key === "snapshot-length") return String(cps(item.snapshot ?? ""));
		if (key === "comment-length") return String(cps(item.comment ?? ""));
		if (key === "body-length") return String(cps(item.comment ?? ""));
		if (key === "source-payload") return item.sourcePayload === undefined ? undefined : JSON.stringify(item.sourcePayload);
		return undefined;
	};
	for (const m of order) {
		if (m.kind === "raw") {
			out.push(m.raw);
			continue;
		}
		const v = valueOf(m.key);
		if (v === undefined) continue;
		out.push(`${META_PREFIX}${m.key}: ${v}`);
	}
	return out;
}
/** 根据 item 当前状态修正 metaOrder：新增非空 comment 时插入 comment-length；
*  comment 变空时移除 comment-length（否则声明长度与 payload 不匹配 → 再解析变 opaque legacy）。
*  返回修正后的 metaOrder（不 mutate 输入 item）。 */
function normalizeMetaOrder(item) {
	const order = item.metaOrder ? item.metaOrder.map((m) => ({ ...m })) : null;
	if (item.kind !== KIND_SOURCE_AWARE) return order;
	const hasComment = (item.comment ?? "").length > 0;
	if (!order) return order;
	const idx = (k) => order.findIndex((m) => m.kind === "known" && m.key === k);
	const commentIdx = idx("comment-length");
	if (hasComment && commentIdx === -1) {
		const snapIdx = idx("snapshot-length");
		if (snapIdx >= 0) order.splice(snapIdx + 1, 0, {
			kind: "known",
			key: "comment-length"
		});
else order.push({
			kind: "known",
			key: "comment-length"
		});
	} else if (!hasComment && commentIdx >= 0) order.splice(commentIdx, 1);
	return order;
}
function serializeItem(item) {
	const meta = {
		...item,
		metaOrder: normalizeMetaOrder(item)
	};
	const lines = [
		BEGIN_LINE,
		...buildMetaLines(meta),
		BODY_LINE
	];
	const payload = item.kind === KIND_SOURCE_AWARE ? (item.snapshot ?? "") + (item.comment ?? "") : item.comment ?? "";
	const rows = payload === "" ? [] : payload.split("\n");
	for (const r of rows) lines.push(r);
	lines.push(END_LINE);
	return lines.join("\n");
}
function makeItem({ kind, captureOrigin, snapshot, comment, sourcePayload, unknownMeta = [] }) {
	if (kind !== KIND_SOURCE_AWARE && kind !== KIND_SOURCE_INDEPENDENT) throw new Error(`makeItem: invalid kind "${kind}"`);
	if (typeof captureOrigin !== "string" || !SESSION_ID_RE.test(captureOrigin)) throw new Error(`makeItem: invalid captureOrigin "${captureOrigin}"`);
	const item = {
		kind,
		captureOrigin,
		unknownMeta: [...unknownMeta]
	};
	if (kind === KIND_SOURCE_AWARE) {
		if (snapshot === undefined) throw new Error("makeItem: source-aware requires snapshot");
		if (typeof snapshot !== "string") throw new Error("makeItem: snapshot must be a string");
		item.snapshot = snapshot;
		if (comment !== undefined) {
			if (typeof comment !== "string") throw new Error("makeItem: comment must be a string");
			item.comment = comment;
		}
		if (sourcePayload !== undefined) {
			if (sourcePayload === null || typeof sourcePayload !== "object" || Array.isArray(sourcePayload)) throw new Error("makeItem: sourcePayload must be a locator object");
			const opaqueFutureLocator = typeof sourcePayload.projectionVersion === "number" && Number.isInteger(sourcePayload.projectionVersion) && sourcePayload.projectionVersion > 2 && typeof sourcePayload.sessionId === "string" && Array.isArray(sourcePayload.segments);
			if (!isValidSourcePayload(sourcePayload) && !opaqueFutureLocator) throw new Error("makeItem: sourcePayload must be a valid message identity or legacy locator");
			item.sourcePayload = sourcePayload;
		}
	} else {
		if (snapshot !== undefined) throw new Error("makeItem: source-independent cannot carry snapshot");
		if (sourcePayload !== undefined) throw new Error("makeItem: source-independent cannot carry sourcePayload");
		if (comment !== undefined) item.comment = comment;
	}
	return item;
}
const ITEM_KEY_META = "item-key";
function isValidItemKey(value) {
	return typeof value === "string" && value.length > 0;
}
function inspectItemKey(item) {
	const rows = [];
	for (const record of item?.unknownMeta ?? []) {
		const raw = typeof record === "string" ? record : record?.raw;
		if (typeof raw !== "string" || !raw.startsWith(`${META_PREFIX}${ITEM_KEY_META}:`)) continue;
		rows.push(raw.slice(`${META_PREFIX}${ITEM_KEY_META}:`.length).trim());
	}
	if (rows.length === 0) return { status: "missing" };
	if (rows.length !== 1) return {
		status: "duplicate",
		values: rows
	};
	if (!isValidItemKey(rows[0])) return {
		status: "malformed",
		value: rows[0]
	};
	return {
		status: "valid",
		key: rows[0]
	};
}
function newItemKey() {
	const rnd = () => Math.random().toString(36).slice(2, 10);
	return "ik-" + Date.now().toString(36) + "-" + rnd() + rnd();
}
function getItemKey(item) {
	const inspected = inspectItemKey(item);
	return inspected.status === "valid" ? inspected.key : undefined;
}
function withItemKey(item, key) {
	const prefix = META_PREFIX + ITEM_KEY_META + ": ";
	const row = prefix + key;
	const isKeyRaw = (r) => {
		const raw = typeof r === "string" ? r : r?.raw;
		return typeof raw === "string" && raw.startsWith(prefix);
	};
	const next = { ...item };
	const existing = item?.unknownMeta ?? [];
	const has = existing.some(isKeyRaw);
	next.unknownMeta = has ? existing.map((r) => isKeyRaw(r) ? { raw: row } : r) : [...existing, { raw: row }];
	if (Array.isArray(item?.metaOrder)) {
		const orderHas = item.metaOrder.some((m) => m && m.kind === "raw" && isKeyRaw(m.raw));
		next.metaOrder = orderHas ? item.metaOrder.map((m) => m && m.kind === "raw" && isKeyRaw(m.raw) ? {
			kind: "raw",
			raw: row
		} : m) : [...item.metaOrder, {
			kind: "raw",
			raw: row
		}];
	}
	return next;
}

//#endregion
//#region lib/notes-picker.js
function isAbort(error, signal) {
	return Boolean(signal?.aborted) || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}
function isBrowseUnavailable(error) {
	const code = error?.rpcError?.code;
	return code === "directory-picker/unavailable" || code === "directory-picker-unavailable";
}
async function chooseNotesDirectory(workspaces, { signal, startPath } = {}) {
	if (!workspaces || typeof workspaces.listDirectory !== "function" || typeof workspaces.pickDirectory !== "function") throw new Error("Notes directory selection is unavailable");
	try {
		const listing = await workspaces.listDirectory(startPath, signal);
		return {
			mode: "browse",
			listing
		};
	} catch (error) {
		if (isAbort(error, signal)) return { mode: "cancelled" };
		if (!isBrowseUnavailable(error)) throw error;
		const path = await workspaces.pickDirectory();
		return path == null ? { mode: "cancelled" } : {
			mode: "native",
			path
		};
	}
}

//#endregion
//#region src/locales.js
const LOCALE_NS = "dsh.collabNotes";
const zh = {
	"lane.conversationTodo": "L1 会话待办",
	"lane.deferredWork": "L2 延后工作",
	"lane.knowledgeCandidate": "L3 知识候选",
	"lane.lessonCandidate": "L4 复盘素材",
	"button.notes": "📝 便签",
	"button.save": "保存",
	"button.close": "×",
	"button.refresh": "🔄",
	"button.help": "?",
	"button.search": "🔍",
	"button.cancel": "取消",
	"button.confirm": "确认",
	"button.ok": "知道了",
	"button.edit": "编辑",
	"button.delete": "删除…",
	"button.deleteConfirm": "确认删除",
	"button.loadLatest": "加载最新",
	"button.overwrite": "仍覆盖",
	"button.back": "返回",
	"button.expand": "查看/移除",
	"button.collapse": "收起",
	"button.remove": "移除",
	"button.removeAll": "全部移除",
	"button.quote": "引用",
	"button.quoteSelection": "引用选中到便签",
	"button.saveNote": "保存便签",
	"button.saveEdit": "保存修改",
	"button.newest": "新记录在前",
	"button.oldest": "旧记录在前",
	"button.rawView": "原文编辑（高级）",
	"button.notesView": "回到便签视图",
	"button.sourceCollapsed": "来源 ▸",
	"button.sourceExpanded": "来源 ▾",
	"button.reenter": "↪ 回来源",
	"button.reenterUnavailable": "不可回来源",
	"button.pin": "置顶",
	"button.unpin": "取消置顶",
	"label.newNote": "新便签",
	"label.noteBody": "便签正文",
	"label.noteBodyPlaceholder": "（可留空，以后再补）",
	"label.source": "引用的原文",
	"label.sourceToggle": "折叠/展开引用原文",
	"label.quoteSelectionTitle": "把对话中选中的文本引用到这条便签（保存时一并保存）",
	"label.rawPlaceholder": "在「{label}」写便签…\n（保存即定格为 notes/{key}/{sessionId}.md）",
	"label.match": "匹配",
	"label.legacy": "旧内容",
	"label.note": "便签",
	"label.ordinaryNote": "普通便签",
	"label.reentryExactStrip": "exact locus 已定位并高亮 ✓",
	"label.reentryReadNoHighlightStrip": "exact 已读取（渲染未定位，未高亮）",
	"label.reentryCrossSessionStrip": "跨会话 exact 已读取（本页未渲染，未高亮）",
	"label.anchoredNote": "带来源便签",
	"label.savedCount": "已保存便签 {n}",
	"label.footer": "{label} · notes/{key}/{sessionId}.md{modified}",
	"label.modifiedAt": "改于 {time}",
	"label.selectedCount": "已选 {n} 条",
	"label.selectedAutoAttach": "发送下一条消息时自动附上引用",
	"label.boundCount": "已随消息引用 {n} 条便签",
	"label.boundCountPast": "已将 {n} 条便签附到刚才的消息",
	"label.statusReading": "读取内容…",
	"label.statusSaving": "保存中…",
	"label.statusSyncing": "同步中…",
	"label.statusSearching": "搜索中…",
	"label.empty": "没有找到匹配的便签",
	"label.noNotes": "还没有便签——在顶部写一条，或先「引用选中到便签」",
	"label.emptyNote": "[空便签——之后可补写]",
	"label.emptyContent": "（空）",
	"label.unreadable": "（内容暂不可读）",
	"label.noteMissing": "（便签已不存在——发送时会如实报告）",
	"label.searchError": "搜索失败：{error}",
	"label.searchPlaceholder": "搜索已保存便签",
	"label.searchAria": "搜索便签",
	"label.searchTitle": "搜索已保存的便签（当前对话全部四层）",
	"label.orderAria": "便签显示顺序",
	"label.orderTitle": "显示顺序：只改变展示顺序，不改变保存顺序",
	"label.orderTitleSearch": "显示顺序：只改变展示顺序，不改变保存顺序（搜索结果与普通视图共用同一全局设置）",
	"label.help": "帮助",
	"label.helpClose": "收起",
	"label.panelTitle": "协作便签",
	"label.dragResize": "拖动调整便签面板宽度",
	"label.searchClose": "关闭搜索",
	"label.sourceReadonly": "回到这条便签引用的原文（只读，不写任何内容）",
	"label.deleteTitle": "删除这条便签（整条删除，含它引用的来源关系）",
	"label.quoteTitle": "发送下一条消息时，把这条便签作为引用附给对话",
	"label.quoteUnavailable": "这条便签没有可稳定定位的标识，无法作为引用随消息发送",
	"label.quoteAria": "发送消息时引用这条便签",
	"label.selectionRemove": "从选择中移除这条便签",
	"label.searchOrder": "便签显示顺序",
	"label.selectedList": "展开已选便签（可逐条移除）",
	"label.clearSelection": "取消全部选择（不再随下一条消息引用）",
	"label.closeEsc": "关闭（Esc）",
	"label.helpTitle": "帮助（便签怎么用）",
	"label.searchButtonTitle": "搜索便签（当前对话全部四层）",
	"label.refreshTitle": "刷新（重新加载本层）",
	"label.setupWarning": "保存前需要完成设置",
	"label.setupRequired": "保存前需要先配置协作便签位置",
	"label.setupLegacy": "检测到这个工作区已有协作便签。是否继续使用现有位置？",
	"label.setupFirstUse": "首次保存便签前，请先确认它的存储位置。",
	"label.setupProposed": "建议存储位置在其工作区内：{path}",
	"label.setupLaneNames": "确认四层显示名称（仅描述性名称）",
	"label.setupLaneNameHint": "名称保存到当前 profile；之后不会随界面语言自动翻译。",
	"button.setupAdopt": "继续使用现有位置",
	"button.setupDefault": "确认使用默认位置",
	"button.setupOther": "选择其他位置",
	"label.pickerCurrent": "选择当前位置{suffix}",
	"label.pickerPathSuffix": "：{path}",
	"button.pickerChoose": "选择此目录",
	"button.pickerNew": "新建子目录",
	"label.pickerRoot": "根目录",
	"prompt.newDirectory": "新目录名称",
	"status.setupDone": "Notes 位置已配置",
	"status.profileSettingsLoading": "正在加载 profile 名称…",
	"status.profileSettingsUnavailable": "profile 名称无法持久化，无法安全完成设置。",
	"status.profileLabelsRequired": "四个层名称都必须填写，不能只填空白。",
	"status.directoryCreated": "已创建目录：{name}",
	"status.directoryPickerUnavailable": "当前环境不提供目录选择",
	"status.loading": "加载中…",
	"status.saved": "已保存 ✓",
	"status.savedNote": "已保存便签 ✓",
	"status.savedEdit": "已保存修改 ✓",
	"status.deleted": "已删除便签",
	"status.pinNotSaved": "置顶未保存（本地存储不可用——刷新后可能不保持）",
	"status.pinKeySavedNotPin": "便签已加内部标识，但置顶未保存（本地存储不可用）",
	"status.pinned": "已置顶 ✓",
	"status.unpinned": "已取消置顶",
	"status.noContent": "先写内容，或用「引用选中到便签」附加来源",
	"status.selectionSaved": "选择未保存：{reason}",
	"status.selectionFailure": "上次发送未附上引用（{code}）：{reason}；选择已保留，可重试或取消",
	"status.selectionBound": "已随消息引用 {n} 条便签",
	"status.inheritCancelled": "已取消继承（未保存内容保留）",
	"status.inheritPaused": "保存未成功，继承已暂停——请先处理保存冲突",
	"status.inheritNone": "未继承父分支便签",
	"status.inheritDone": "便签继承完成",
	"status.inheritFailed": "便签继承失败: {error}",
	"status.selectLane": "请至少选择一层便签",
	"status.alreadyDecided": "该分支的继承决策已完成，无需重复操作",
	"status.contentChanged": "部分内容已变化，请重新确认",
	"status.reconfirmFailed": "重新确认失败: {error}",
	"status.switchDiscard": "有未保存的修改，切换会话将丢弃。确定？",
	"status.inheritUnsaved": "当前 {label} 有未保存内容，是否先保存并继续继承？",
	"status.switchKept": "已保留本地修改（注意：再次保存将写入当前会话）",
	"status.closeDiscard": "有未保存的修改，关闭将丢失。确定关闭？",
	"status.operationDiscard": "有未保存的修改，此操作将丢弃。继续？",
	"status.loadFailed": "加载失败: {error}",
	"status.loadedLatest": "已加载最新版本",
	"status.saveFailed": "保存失败: {error}",
	"status.conflict": "⚠ 文件已被其它方修改（可能是 agent 追加）",
	"status.setupContinue": "请先配置 Notes 位置；配置成功后将继续本次保存",
	"status.captureBusy": "正在引用选中文本…",
	"status.captureNeedSelection": "无法引用这段文本：请先在对话中选中要引用的文字",
	"status.captureInexact": "无法精确引用该选区",
	"status.captureValidationFailed": "校验未通过",
	"status.captureReady": "已引用选中文本——可写便签后保存",
	"status.captureError": "无法引用这段文本：{reason}",
	"status.captureErrorRetry": "无法引用这段文本：{reason}——可先保存普通便签，或重新选择后再「引用选中到便签」",
	"status.captureOtherSession": "这段引用来自其它会话，已取消——请重新「引用选中到便签」",
	"status.reentryBusy": "回到来源中…",
	"status.reentryFailed": "回来源失败",
	"status.reentryUnauthorized": "回来源需要授权（未读取任何内容）",
	"status.reentryUnavailable": "来源当前不可用（快照保留）",
	"status.reentryMismatch": "历史 selected snapshot 与当前来源不一致；未将当前内容当作历史 exact",
	"status.reentryIncompatible": "来源 locator 兼容性失败（未用当前投影重解）",
	"status.reentryWholeCue": "历史 selected snapshot 与当前来源投影不一致；已显示 broader whole-message cue（非 exact）",
	"status.reentryNoCue": "exact source 已读取，但当前渲染没有可用 attention cue；未声称已回到来源",
	"status.reentryPartial": "exact source 已读取，但仅定位了 {found}/{total} 个 locus；未声称完整回到来源",
	"status.reentryExactSpan": "exact source 已读取，但 exact span 不可构造；已显示 broader whole-message cue（非 exact）",
	"status.reentryExact": "已回到来源 ✓（exact locus 已定位并高亮）",
	"status.reentryReadNoHighlight": "已回到来源 ✓（exact 已读取；当前渲染未能定位高亮，不作高亮声称）",
	"status.reentryCrossSession": "已读取来源（跨会话 exact；本页未渲染该会话，未做高亮）",
	"status.reentryHistoricalMismatch": "历史 selected snapshot 与当前来源投影不一致；已显示 broader whole-message cue（非 exact）",
	"status.reentryRead": "exact source 已读取，但 exact span 不可构造；已显示 broader whole-message cue（非 exact）",
	"status.reentryReading": "读取 exact source…",
	"status.reentryClosed": "关闭",
	"status.reentryConfirmCross": "查看这个来源需要读取另一会话中的内容：\n{origin}\n\n读取后会在当前页面显示/使用该来源，不会切换到原会话。\n仅本次请求有效，不建立长期授权。\n\n是否继续？",
	"status.reentryIncompatibleEntry": "该条目没有可解析的 Source Anchor locator（保留 provenance，未读取）",
	"label.networkError": "网络错误",
	"label.selectionParseFailed": "未能解析所选便签",
	"status.reentryLoaded": "已读取来源（跨会话 exact；本页未渲染该会话，未做高亮）",
	"status.carryMerged": "已合并父分支 + 当前分支",
	"status.carryReplaced": "已以父分支覆盖",
	"status.carryCopied": "已继承父分支",
	"status.carryKept": "保留当前分支",
	"status.carrySkipped": "跳过（{reason}）",
	"label.carryDone": "继承完成",
	"label.carryPending": "有未决的便签继承（父分支）",
	"label.carryConflict": "以下便签两侧都有内容，如何合并？（一次决定，不会反复询问）",
	"label.carryParent": "父分支内容",
	"label.carryCurrent": "当前分支已有内容",
	"label.carryQuestion": "这个分支来自另一对话，是否继承父分支便签？",
	"label.carryMerge": "合并（父分支在前 + 当前内容）",
	"label.carryKeep": "保留当前（不继承父分支此层）",
	"label.carryReplace": "以父分支覆盖当前",
	"label.carryBusy": "处理中…",
	"button.confirmCarry": "确认合并方式",
	"button.confirmSelected": "确认继承所选",
	"button.all": "全部",
	"button.some": "选择部分",
	"button.none": "不带",
	"label.selectionFailure": "引用失败",
	"label.selectionFailureDetail": "刚才的请求未按“无便签”方式继续发送（{code}）；已保留 {n} 条选择",
	"label.selectionReceipt": "查看",
	"label.selectionReceiptClose": "关闭",
	"label.selectionReceiptCollapse": "收起",
	"label.noteSourceChanged": "（修改仅更新正文——已引用的原文不变）",
	"label.noteNoSource": "（未引用原文——保存为普通便签）",
	"label.deleteConfirm": "删除这条便签？这会删除这条便签以及它附带的来源关系。",
	"label.noteReference": "引用",
	"label.sourceRead": "exact source: {text}",
	"label.sourceExact": "exact source 已读取，但 exact span 不可构造；已显示 broader whole-message cue（非 exact）\nsource: {text}",
	"label.sourceNoCue": "exact source 已读取，但当前渲染没有可用 attention cue；未声称已回到来源\nsource: {text}",
	"label.sourcePartial": "exact source 已读取，但仅定位了 {found}/{total} 个 locus；未声称完整回到来源\nsource: {text}",
	"label.sourceUnauthorized": "未授权读取（nothing read）：{text}",
	"label.sourceUnavailable": "来源当前不可用（快照保留，未 search/rebind）：{text}",
	"label.sourceIncompatible": "兼容性失败（未用当前投影重解）：{text}",
	"label.sourceFailed": "回来源失败：{text}",
	"help.noteBodyTitle": "便签正文",
	"help.noteBody": "记录你自己的提醒、判断或待处理事项。\n可以先留空，以后再补写或修改。",
	"help.sourceTitle": "引用的原文",
	"help.source": "可选。你从对话中选中的内容可以作为这条便签的来源一起保存。\n保存后的带来源便签可以“回来源”，返回当时引用的位置。\n修改便签正文不会自动改变已经保存的引用来源。",
	"help.laneTodo": "L1 会话待办",
	"help.laneTodoBody": "当前对话中需要继续处理的事项。",
	"help.laneDeferred": "L2 延后工作",
	"help.laneDeferredBody": "先放下、之后再回来的问题或工作。",
	"help.laneKnowledge": "L3 知识候选",
	"help.laneKnowledgeBody": "值得保留、但还不是正式知识结论的材料。",
	"help.laneLesson": "L4 复盘素材",
	"help.laneLessonBody": "值得以后复用、但还需要判断或整理的经验候选。",
	"help.branchTitle": "分支中的便签",
	"help.branch": "创建新分支时，你可以选择把哪些便签带到新分支。\n带过去后，它们成为新分支自己的副本；父分支和子分支之后不会自动同步修改、关闭或删除。\n带过去的来源仍保留原来的历史出处。",
	"help.editTitle": "编辑与删除",
	"help.edit": "你可以继续修改便签正文；普通编辑不会自动改变已经附着的引用来源。\n删除整条便签需要明确确认。",
	"label.genericError": "异常",
	"label.quotedSource": "引用的原文",
	"label.selectedQuote": "这条便签没有可稳定定位的标识，无法作为引用随消息发送",
	"label.ordinary": "普通便签",
	"label.sourceStatus": "来源",
	"label.notesTitle": "协作便签"
};
const en = {
	...zh,
	"label.noteBodyPlaceholder": "(You can leave this empty and add to it later)",
	"label.sourceToggle": "Collapse/expand quoted source",
	"label.quoteSelectionTitle": "Quote selected conversation text into this note (saved together)",
	"label.rawPlaceholder": "Write a note in “{label}”…\n(Saving freezes it as notes/{key}/{sessionId}.md)",
	"label.footer": "{label} · notes/{key}/{sessionId}.md{modified}",
	"label.modifiedAt": "modified {time}",
	"button.confirmSelected": "Inherit selected",
	"button.all": "All",
	"button.some": "Some",
	"button.none": "None",
	"status.inheritUnsaved": "{label} has unsaved content. Save it before continuing inheritance?",
	"status.loadedLatest": "Latest version loaded",
	"status.pinNotSaved": "Pin not saved (local storage is unavailable; it may not persist after refresh)",
	"status.pinKeySavedNotPin": "The note received an internal identifier, but the pin was not saved (local storage is unavailable)",
	"status.pinned": "Pinned ✓",
	"status.unpinned": "Unpinned",
	"status.captureNeedSelection": "Could not quote this text: select text in the conversation first",
	"status.captureInexact": "Could not precisely quote this selection",
	"status.captureValidationFailed": "Validation failed",
	"status.captureOtherSession": "This quote came from another conversation and was cancelled — select again and retry",
	"status.reentryConfirmCross": "Viewing this source requires reading another conversation:\n{origin}\n\nIt will be shown/used on this page; the original conversation will not open.\nThis applies only to this request and creates no standing authorization.\n\nContinue?",
	"status.reentryIncompatibleEntry": "This entry has no parseable Source Anchor locator (provenance retained; nothing read)",
	"label.networkError": "network error",
	"label.selectionParseFailed": "the selected notes could not be resolved",
	"status.directoryPickerUnavailable": "This environment does not provide a directory picker",
	"status.selectionFailure": "The last send did not continue as “no notes” ({code}): {reason}; selections were kept and can be retried or cancelled",
	"status.reentryHistoricalMismatch": "The historical selected snapshot differs from the current source projection; a broader whole-message cue is shown (not exact)",
	"status.reentryLoaded": "Source read (cross-conversation exact; that conversation is not rendered here, so nothing was highlighted)",
	"label.sourceRead": "exact source: {text}",
	"lane.conversationTodo": "L1 Conversation To-do",
	"lane.deferredWork": "L2 Deferred Work",
	"lane.knowledgeCandidate": "L3 Knowledge Candidate",
	"lane.lessonCandidate": "L4 Lesson Candidate",
	"button.notes": "📝 Notes",
	"button.save": "Save",
	"button.close": "×",
	"button.refresh": "🔄",
	"button.help": "?",
	"button.search": "🔍",
	"button.cancel": "Cancel",
	"button.confirm": "Confirm",
	"button.ok": "Got it",
	"button.edit": "Edit",
	"button.delete": "Delete…",
	"button.deleteConfirm": "Delete",
	"button.loadLatest": "Load latest",
	"button.overwrite": "Overwrite anyway",
	"button.back": "Back",
	"button.expand": "View/remove",
	"button.collapse": "Collapse",
	"button.remove": "Remove",
	"button.removeAll": "Remove all",
	"button.quote": "Quote",
	"button.quoteSelection": "Quote selection into note",
	"button.saveNote": "Save note",
	"button.saveEdit": "Save edit",
	"button.newest": "Newest first",
	"button.oldest": "Oldest first",
	"button.rawView": "Raw editor (advanced)",
	"button.notesView": "Back to notes",
	"button.sourceCollapsed": "Source ▸",
	"button.sourceExpanded": "Source ▾",
	"button.reenter": "↪ Return to source",
	"button.reenterUnavailable": "Source unavailable",
	"button.pin": "Pin",
	"button.unpin": "Unpin",
	"label.newNote": "New note",
	"label.noteBody": "Note body",
	"label.source": "Quoted source",
	"label.match": "Match",
	"label.legacy": "Legacy content",
	"label.ordinaryNote": "Note",
	"label.note": "Note",
	"label.anchoredNote": "Sourced note",
	"label.savedCount": "{n} saved notes",
	"label.selectedCount": "{n} selected",
	"label.selectedAutoAttach": "Automatically attach to the next message",
	"label.boundCount": "{n} notes attached to the message",
	"label.boundCountPast": "Attached {n} notes to the last message",
	"label.statusReading": "Reading…",
	"label.statusSaving": "Saving…",
	"label.statusSyncing": "Syncing…",
	"label.statusSearching": "Searching…",
	"label.empty": "No matching notes",
	"label.noNotes": "No notes yet — write one above, or quote a selection first",
	"label.emptyNote": "[Empty note — add to it later]",
	"label.emptyContent": "(empty)",
	"label.unreadable": "(content unavailable)",
	"label.noteMissing": "(note no longer exists — this will be reported when sending)",
	"label.searchError": "Search failed: {error}",
	"label.searchPlaceholder": "Search saved notes",
	"label.searchAria": "Search notes",
	"label.searchTitle": "Search saved notes (all four layers in this conversation)",
	"label.orderAria": "Note display order",
	"label.orderTitle": "Changes display order only, not saved order",
	"label.orderTitleSearch": "Changes display order only, not saved order (shared by search and normal views)",
	"label.help": "Help",
	"label.helpClose": "Collapse",
	"label.panelTitle": "Collaborative Notes",
	"label.dragResize": "Drag to resize the Notes panel",
	"label.searchClose": "Close search",
	"label.sourceReadonly": "Return to the quoted source (read-only; writes nothing)",
	"label.deleteTitle": "Delete this note (including its source relationship)",
	"label.quoteTitle": "Attach this note as a quote to the next message",
	"label.quoteUnavailable": "This note has no stable identifier and cannot be attached as a quote",
	"label.quoteAria": "Quote this note when sending a message",
	"label.selectionRemove": "Remove this note from the selection",
	"label.searchOrder": "Note display order",
	"label.selectedList": "Expand selected notes (remove individually)",
	"label.clearSelection": "Clear all selections (do not attach to the next message)",
	"label.closeEsc": "Close (Esc)",
	"label.helpTitle": "Help (how to use Notes)",
	"label.searchButtonTitle": "Search notes (all four layers in this conversation)",
	"label.refreshTitle": "Refresh (reload this layer)",
	"label.setupWarning": "Setup is required before saving",
	"label.setupRequired": "Configure the Collaborative Notes location before saving",
	"label.setupLegacy": "This workspace already has Collaborative Notes. Continue using the existing location?",
	"label.setupFirstUse": "Confirm the storage location before saving your first note.",
	"label.setupProposed": "Suggested location in its workspace: {path}",
	"label.setupLaneNames": "Confirm the four display names (descriptive names only)",
	"label.setupLaneNameHint": "Names are saved to this profile and are not auto-translated when the UI language changes.",
	"button.setupAdopt": "Use existing location",
	"button.setupDefault": "Use default location",
	"button.setupOther": "Choose another location",
	"label.pickerCurrent": "Choose current location{suffix}",
	"label.pickerPathSuffix": ": {path}",
	"button.pickerChoose": "Choose this folder",
	"button.pickerNew": "New subfolder",
	"label.pickerRoot": "Root",
	"prompt.newDirectory": "New folder name",
	"status.setupDone": "Notes location configured",
	"status.profileSettingsLoading": "Loading profile vocabulary…",
	"status.profileSettingsUnavailable": "Profile vocabulary persistence is unavailable; setup cannot continue safely.",
	"status.profileLabelsRequired": "All four lane names are required and cannot be blank.",
	"status.directoryCreated": "Created folder: {name}",
	"status.loading": "Loading…",
	"status.saved": "Saved ✓",
	"status.savedNote": "Note saved ✓",
	"status.savedEdit": "Edit saved ✓",
	"status.deleted": "Note deleted",
	"status.noContent": "Write something first, or add a source with “Quote selection into note”",
	"status.selectionSaved": "Selection not saved: {reason}",
	"status.selectionBound": "{n} notes attached to the message",
	"status.inheritCancelled": "Inheritance cancelled (unsaved content kept)",
	"status.inheritPaused": "Save did not succeed; inheritance paused — resolve the save conflict first",
	"status.inheritNone": "Parent notes not inherited",
	"status.inheritDone": "Note inheritance complete",
	"status.inheritFailed": "Note inheritance failed: {error}",
	"status.selectLane": "Select at least one note layer",
	"status.alreadyDecided": "This branch's inheritance decision is complete; no repeat action is needed",
	"status.contentChanged": "Some content changed; confirm again",
	"status.reconfirmFailed": "Reconfirmation failed: {error}",
	"status.switchDiscard": "Unsaved changes will be discarded when switching conversations. Continue?",
	"status.switchKept": "Local changes kept (saving again will write to the current conversation)",
	"status.closeDiscard": "Unsaved changes will be lost on close. Close anyway?",
	"status.operationDiscard": "Unsaved changes will be discarded by this action. Continue?",
	"status.loadFailed": "Load failed: {error}",
	"status.saveFailed": "Save failed: {error}",
	"status.conflict": "⚠ The file changed elsewhere (possibly an agent append)",
	"status.setupContinue": "Configure the Notes location first; this save will continue after setup",
	"status.captureBusy": "Quoting the selected text…",
	"status.captureReady": "Selection quoted — write a note and save",
	"status.captureError": "Could not quote this text: {reason}",
	"status.captureErrorRetry": "Could not quote this text: {reason} — save a regular note first, or select again and retry",
	"status.reentryBusy": "Returning to source…",
	"status.reentryFailed": "Could not return to source",
	"status.reentryUnauthorized": "Returning to source requires authorization (nothing read)",
	"status.reentryUnavailable": "Source is currently unavailable (snapshot retained)",
	"status.reentryMismatch": "Historical selected snapshot differs from the current source; current content was not treated as historical exact",
	"status.reentryIncompatible": "Source locator is incompatible (current projection was not used to re-resolve)",
	"status.reentryWholeCue": "Historical selected snapshot differs from the current projection; a broader whole-message cue is shown (not exact)",
	"status.reentryNoCue": "Exact source was read, but the current rendering had no usable attention cue; no return-to-source highlight is claimed",
	"status.reentryPartial": "Exact source was read, but only {found}/{total} loci were located; a complete return is not claimed",
	"status.reentryExactSpan": "Exact source was read, but the exact span could not be constructed; a broader whole-message cue is shown (not exact)",
	"status.reentryExact": "Returned to source ✓ (exact locus located and highlighted)",
	"status.reentryReadNoHighlight": "Returned to source ✓ (exact source read; current rendering could not be highlighted)",
	"status.reentryCrossSession": "Source read (cross-conversation exact; that conversation is not rendered here, so nothing was highlighted)",
	"status.reentryRead": "Exact source was read, but the exact span could not be constructed; a broader whole-message cue is shown (not exact)",
	"status.reentryReading": "Reading exact source…",
	"status.reentryClosed": "Close",
	"status.carryMerged": "Merged parent + current branch",
	"status.carryReplaced": "Replaced with parent branch",
	"status.carryCopied": "Inherited from parent branch",
	"status.carryKept": "Kept current branch",
	"status.carrySkipped": "Skipped ({reason})",
	"label.carryDone": "Inheritance complete",
	"label.carryPending": "Unresolved note inheritance (parent branch)",
	"label.carryConflict": "How should the notes be merged? (one decision; no repeat prompt)",
	"label.carryParent": "Parent branch content",
	"label.carryCurrent": "Current branch content",
	"label.carryQuestion": "This branch came from another conversation. Inherit the parent notes?",
	"label.carryMerge": "Merge (parent first + current content)",
	"label.carryKeep": "Keep current (do not inherit this parent layer)",
	"label.carryReplace": "Replace current with parent",
	"label.carryBusy": "Working…",
	"button.confirmCarry": "Confirm merge choice",
	"label.selectionFailure": "Quote failed",
	"label.selectionFailureDetail": "The last request did not send as “no notes” ({code}); {n} selections were kept",
	"label.selectionReceipt": "View",
	"label.selectionReceiptClose": "Close",
	"label.selectionReceiptCollapse": "Collapse",
	"label.noteSourceChanged": "(Only the body changes; the quoted source stays unchanged)",
	"label.noteNoSource": "(No source quoted — saved as a regular note)",
	"label.deleteConfirm": "Delete this note? This removes the note and its attached source relationship.",
	"label.noteReference": "Quote",
	"label.sourceRead": "exact source: {text}",
	"label.sourceExact": "Exact source was read, but the exact span could not be constructed; a broader whole-message cue is shown (not exact)\nsource: {text}",
	"label.sourceNoCue": "Exact source was read, but the current rendering had no usable attention cue; no return-to-source claim is made\nsource: {text}",
	"label.sourcePartial": "Exact source was read, but only {found}/{total} loci were located; a complete return is not claimed\nsource: {text}",
	"label.sourceUnauthorized": "Unauthorized read (nothing read): {text}",
	"label.sourceUnavailable": "Source unavailable (snapshot retained; no search/rebind): {text}",
	"label.sourceIncompatible": "Compatibility failure (current projection was not used to re-resolve): {text}",
	"label.sourceFailed": "Return-to-source failed: {text}",
	"label.reentryExactStrip": "Exact locus located and highlighted ✓",
	"label.reentryReadNoHighlightStrip": "Exact source read (not highlighted in the current rendering)",
	"label.reentryCrossSessionStrip": "Cross-conversation exact source read (not rendered here, so nothing was highlighted)",
	"help.noteBodyTitle": "Note body",
	"help.noteBody": "Record your own reminders, judgments, or follow-up items.\nYou can leave it empty and add or edit it later.",
	"help.sourceTitle": "Quoted source",
	"help.source": "Optional. Text selected from the conversation can be saved as this note's source.\nA sourced note can return to the quoted location.\nEditing the note body does not automatically change its saved source.",
	"help.laneTodo": "L1 Conversation To-do",
	"help.laneTodoBody": "Items that need continued work in the current conversation.",
	"help.laneDeferred": "L2 Deferred Work",
	"help.laneDeferredBody": "Questions or work to set aside and revisit later.",
	"help.laneKnowledge": "L3 Knowledge Candidate",
	"help.laneKnowledgeBody": "Material worth keeping that is not yet a formal knowledge conclusion.",
	"help.laneLesson": "L4 Lesson Candidate",
	"help.laneLessonBody": "Experience candidates worth reusing after judgment or organization.",
	"help.branchTitle": "Notes in branches",
	"help.branch": "When creating a branch, you can choose which notes to carry over.\nThey become copies owned by the new branch; later edits, closes, and deletes do not sync between parent and child.\nCarried sources retain their historical provenance.",
	"help.editTitle": "Edit and delete",
	"help.edit": "You can continue editing a note body; ordinary edits do not automatically change an attached source.\nDeleting a whole note requires explicit confirmation.",
	"label.genericError": "error",
	"label.quotedSource": "Quoted source",
	"label.selectedQuote": "This note has no stable identifier and cannot be attached as a quote",
	"label.ordinary": "Note",
	"label.sourceStatus": "Source",
	"label.notesTitle": "Collaborative Notes"
};
const localeKeys = Object.freeze(Object.keys(zh));

//#endregion
//#region src/client.js
(() => {
	const FALLBACK_LAYERS = [
		{
			key: "conversation_todo",
			displayId: "L1",
			label: "L1 会话待办",
			policy: "active"
		},
		{
			key: "deferred_work",
			displayId: "L2",
			label: "L2 延后工作",
			policy: "releasable"
		},
		{
			key: "knowledge_candidate",
			displayId: "L3",
			label: "L3 知识候选",
			policy: "releasable"
		},
		{
			key: "lesson_candidate",
			displayId: "L4",
			label: "L4 复盘素材",
			policy: "releasable"
		}
	];
	const FALLBACK_LAYER_LOCALE_KEYS = {
		conversation_todo: "lane.conversationTodo",
		deferred_work: "lane.deferredWork",
		knowledge_candidate: "lane.knowledgeCandidate",
		lesson_candidate: "lane.lessonCandidate"
	};
	const PROFILE_SETTINGS_NAMESPACE = "dsh-collab-notes";
	const LANE_KEYS = [
		"conversation_todo",
		"deferred_work",
		"knowledge_candidate",
		"lesson_candidate"
	];
	const PROFILE_LABEL_SUGGESTIONS = {
		zh: {
			conversation_todo: "会话待办",
			deferred_work: "延后工作",
			knowledge_candidate: "知识候选",
			lesson_candidate: "复盘素材"
		},
		en: {
			conversation_todo: "Conversation To-do",
			deferred_work: "Deferred Work",
			knowledge_candidate: "Knowledge Candidate",
			lesson_candidate: "Lesson Candidate"
		}
	};
	function activeLocaleOf(clientCtx) {
		return clientCtx.locale?.getLocale?.().active === "zh" ? "zh" : "en";
	}
	function profileLabelsFromSnapshot(snapshot, locale) {
		const configured = snapshot?.value?.layerOverrides;
		return Object.fromEntries(LANE_KEYS.map((key) => {
			const label = configured?.[key]?.label;
			return [key, typeof label === "string" && label.trim() !== "" ? label : PROFILE_LABEL_SUGGESTIONS[locale][key]];
		}));
	}
	function hasEstablishedProfileVocabulary(snapshot) {
		const configured = snapshot?.value?.layerOverrides;
		return LANE_KEYS.every((key) => {
			const label = configured?.[key]?.label;
			return typeof label === "string" && label.trim() !== "";
		});
	}
	function isMergeWrapperBody(body) {
		const raw = String(body ?? "");
		return raw.includes("## 来自父分支") && raw.includes("## 当前分支已有内容");
	}
	const PIN_STORE_KEY = "dsh.collab-notes.pins.v1";
	const PIN_STORE_VERSION = 1;
	/** 获取可用的 localStorage（缺失/不可用 → null）。 */
	function pinStorage() {
		try {
			const ls = window.localStorage;
			if (!ls || typeof ls.getItem !== "function" || typeof ls.setItem !== "function") return null;
			return ls;
		} catch (e) {
			return null;
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
		if (!ls) return false;
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
		if (node.type === "legacy") return normalizeSearchText(node.text).includes(q);
		const item = node.item || {};
		const haystack = [item.comment, item.snapshot];
		return haystack.some((v) => normalizeSearchText(v).includes(q));
	}
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
		if (hint && hint.messageId) matched = all.filter((el) => {
			const k = el.getAttribute("data-chat-anchor-key") || "";
			const i = k.indexOf("input-message");
			return i >= 0 && k.slice(i + "input-message".length) === hint.messageId;
		});
else if (hint && hint.turn !== undefined && hint.step !== undefined) matched = all.filter((el) => {
			const k = el.getAttribute("data-chat-anchor-key") || "";
			const m = /assistant-step(\d+):(\d+)/.exec(k);
			return !!m && Number(m[1]) === hint.turn && Number(m[2]) === hint.step;
		});
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
		const reasoningSurfaces = [...el.querySelectorAll("[data-variant=\"think\"]")].filter((surface) => surface.closest("[data-chat-anchor-key]") === el);
		const isReasoningNode = (node) => reasoningSurfaces.some((surface) => surface.contains(node));
		const indexed = [];
		const appendSubtree = (parent) => {
			let previousWasListItem = false;
			for (const child of parent.childNodes || []) {
				if (isReasoningNode(child)) continue;
				const isElement = child.nodeType === 1;
				const isListItem = isElement && child.tagName === "LI";
				if (previousWasListItem && isListItem) indexed.push({
					virtual: true,
					length: 1
				});
				if (child.nodeType === 3) indexed.push({
					node: child,
					length: [...child.data].length
				});
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
				if (cp < next || cp === next && isStart) {
					if (part.virtual) {
						const following = indexed.slice(i + 1).find((candidate) => !candidate.virtual);
						return following ? {
							node: following.node,
							offset: 0
						} : null;
					}
					return {
						node: part.node,
						offset: cpIndexToUtf16(part.node.data, cp - acc)
					};
				}
				if (cp === next && !isStart) {
					if (part.virtual) {
						const following = indexed.slice(i + 1).find((candidate) => !candidate.virtual);
						return following ? {
							node: following.node,
							offset: 0
						} : null;
					}
					return {
						node: part.node,
						offset: cpIndexToUtf16(part.node.data, part.length)
					};
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
	let hlEpochRef = 0;
	let hlClearTimer = null;
	const defaultHighlightClearMs = 8e3;
	function highlightClearMs() {
		return typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS) ? window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS : defaultHighlightClearMs;
	}
	function cancelHighlightTimer() {
		if (hlClearTimer !== null) {
			clearTimeout(hlClearTimer);
			hlClearTimer = null;
		}
	}
	function removeDshMarks() {
		cancelHighlightTimer();
		const records = [];
		document.querySelectorAll("mark[data-dsh-reentry]").forEach((m) => {
			try {
				if (Array.isArray(m.__dshRestoreRecords)) records.push(...m.__dshRestoreRecords);
				if (m.parentNode) while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
			} catch {}
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
			if (parts.some((part, i) => i > 0 && parts[i - 1].nextSibling !== part)) continue;
			if (parts.map((part) => part.data).join("") !== originalData) continue;
			const first = parts[0];
			if (originalNode !== first) parent.insertBefore(originalNode, first);
			originalNode.data = originalData;
			for (const part of parts) if (part !== originalNode && part.parentNode === parent) part.remove();
		}
	}
	const wholeMessageCueRecords = [];
	function applyWholeMessageCue(el) {
		if (!el?.style) return false;
		if (wholeMessageCueRecords.some((r) => r.el === el)) return true;
		const original = {
			outline: el.style.outline,
			outlineOffset: el.style.outlineOffset
		};
		el.style.outline = "2px solid #d97706";
		el.style.outlineOffset = "2px";
		const applied = {
			outline: el.style.outline,
			outlineOffset: el.style.outlineOffset
		};
		wholeMessageCueRecords.push({
			el,
			original,
			applied
		});
		return true;
	}
	function clearWholeMessageCues() {
		for (const record of wholeMessageCueRecords.splice(0)) {
			const { el, original, applied } = record;
			if (!el?.style) continue;
			if (el.style.outline === applied.outline) el.style.outline = original.outline;
			if (el.style.outlineOffset === applied.outlineOffset) el.style.outlineOffset = original.outlineOffset;
		}
	}
	function wrapRangeTextNodes(range) {
		const start = range.startContainer;
		const end = range.endContainer;
		if (start?.nodeType !== 3 || end?.nodeType !== 3) return [];
		const root = range.commonAncestorContainer?.nodeType === 3 ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer;
		if (!root || typeof document.createTreeWalker !== "function") return [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const nodes = [];
		let node;
		while (node = walker.nextNode()) nodes.push(node);
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
			mark.__dshRestoreRecords = [{
				originalNode: textNode,
				originalData,
				parent: originalParent,
				parts
			}];
			selected.parentNode.insertBefore(mark, selected);
			mark.appendChild(selected);
			marks.push(mark);
		}
		return marks;
	}
	function locateAndHighlight(exact) {
		try {
			removeDshMarks();
		} catch {}
		const gen = ++hlEpochRef;
		const projBySeq = {};
		for (const ev of exact?.events || []) projBySeq[ev.eventSeq] = ev.projection;
		const segments = exact?.perSegment || [];
		const jobs = [];
		const wholeMessageEls = [];
		for (const seg of segments) {
			const els = anchorElementsFor(seg.hint || {});
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
			jobs.push({
				el: els[0],
				range,
				seg
			});
		}
		const total = segments.length;
		const marked = [];
		for (let i = jobs.length - 1; i >= 0; i--) {
			const { range } = jobs[i];
			try {
				if (wrapRangeTextNodes(range).length > 0) marked.push(jobs[i].seg);
else wholeMessageEls.push(jobs[i].el);
			} catch {
				wholeMessageEls.push(jobs[i].el);
			}
		}
		const wholeMessageCount = [...new Set(wholeMessageEls)].filter(applyWholeMessageCue).length;
		const seenEls = new Set();
		for (const { el } of [...jobs, ...wholeMessageEls.map((el$1) => ({ el: el$1 }))]) {
			if (seenEls.has(el)) continue;
			seenEls.add(el);
			el.scrollIntoView({ block: "center" });
		}
		const count = marked.length;
		if (count > 0 || wholeMessageCount > 0) {
			cancelHighlightTimer();
			hlClearTimer = setTimeout(() => {
				hlClearTimer = null;
				if (gen === hlEpochRef) try {
					removeDshMarks();
				} catch {}
			}, highlightClearMs());
		}
		return {
			highlighted: count > 0 && count === total,
			partial: count > 0 && count < total,
			wholeMessage: wholeMessageCount > 0,
			highlightedCount: count,
			wholeMessageCount,
			total,
			detail: `${count}/${total} segments highlighted`
		};
	}
	function locateAndApplyWholeMessageCue(cue) {
		try {
			removeDshMarks();
		} catch {}
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
				if (gen === hlEpochRef) try {
					removeDshMarks();
				} catch {}
			}, highlightClearMs());
		}
		return {
			highlighted: false,
			partial: false,
			wholeMessage: wholeMessageCount > 0,
			highlightedCount: 0,
			wholeMessageCount,
			total: (cue?.perSegment || []).length,
			detail: `0/${(cue?.perSegment || []).length} segments exact-highlighted; ${wholeMessageCount} whole-message cue(s)`
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
		const p = prefix.length;
		let i = p;
		while (i > 0 && body[i - 1] === "\n") i--;
		let j = p;
		while (j < body.length && body[j] === "\n") j++;
		if (j - i >= 3) body = body.slice(0, i) + "\n\n" + body.slice(j);
		if (prefix === "") body = body.replace(/^\n+/, "");
else if (suffix === "" || /^\n+$/.test(suffix)) body = body.replace(/\n{1,2}$/, "");
		return body;
	}
	function NotesController(React, clientCtx = {}) {
		const { createElement, useCallback, useEffect, useMemo, useRef, useState } = React;
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
			const [profileSettingsSnapshot, setProfileSettingsSnapshot] = useState(() => profileSettings?.getSnapshot?.() ?? null);
			const profileLabelsInitializedRef = useRef(false);
			const [profileLabels, setProfileLabels] = useState({});
			const [profileLabelsBusy, setProfileLabelsBusy] = useState(false);
			const [layers, setLayers] = useState(() => FALLBACK_LAYERS.map((layer) => ({
				...layer,
				label: panelT(FALLBACK_LAYER_LOCALE_KEYS[layer.key] || layer.label)
			})));
			const [layerKey, setLayerKey] = useState(FALLBACK_LAYERS[0].key);
			const layerKeyRef = useRef(layerKey);
			layerKeyRef.current = layerKey;
			const sessionIdRef = useRef(sessionId);
			sessionIdRef.current = sessionId;
			const [text, setText] = useState("");
			const [status, setStatus] = useState("");
			const [setup, setSetup] = useState(null);
			const [setupBusy, setSetupBusy] = useState(false);
			const [setupError, setSetupError] = useState(null);
			const [picker, setPicker] = useState(null);
			const pickerAbortRef = useRef(null);
			const pickerRequestRef = useRef(0);
			const setupContinuationRef = useRef(null);
			const saveRef = useRef(null);
			const saveComposerRef = useRef(null);
			const setupPrimaryStyle = {
				fontSize: "12px",
				padding: "5px 10px",
				cursor: "pointer",
				background: "#2563eb",
				border: "1px solid #2563eb",
				borderRadius: "5px",
				color: "#fff"
			};
			const setupButtonStyle = {
				fontSize: "12px",
				padding: "5px 10px",
				cursor: "pointer",
				background: "#fff",
				border: "1px solid #d1d5db",
				borderRadius: "5px",
				color: "#374151"
			};
			const [mtime, setMtime] = useState("0");
			const [dirty, setDirty] = useState(false);
			const [conflict, setConflict] = useState(null);
			const [carryOver, setCarryOver] = useState(null);
			const [carryBusy, setCarryBusy] = useState(false);
			const [carryPicking, setCarryPicking] = useState(false);
			const [carrySelected, setCarrySelected] = useState([]);
			const [carryConflict, setCarryConflict] = useState(null);
			const [carryResolutions, setCarryResolutions] = useState({});
			const [carryResult, setCarryResult] = useState(null);
			const [capture, setCapture] = useState(null);
			const [captureComment, setCaptureComment] = useState("");
			const [captureBusy, setCaptureBusy] = useState(false);
			const [reentry, setReentry] = useState(null);
			const saveSeq = useRef(0);
			const [rawView, setRawView] = useState(false);
			const [helpOpen, setHelpOpen] = useState(false);
			const [composerText, setComposerText] = useState("");
			const [composerBusy, setComposerBusy] = useState(false);
			const [editingIndex, setEditingIndex] = useState(null);
			const editingSigRef = useRef(null);
			const [collapsedSource, setCollapsedSource] = useState({});
			const [viewDir, setViewDir] = useState("newest");
			const [confirmingDelete, setConfirmingDelete] = useState(null);
			const [attachHint, setAttachHint] = useState(null);
			const [pinKeys, setPinKeys] = useState(() => new Set());
			const [searchOpen, setSearchOpen] = useState(false);
			const [searchQuery, setSearchQuery] = useState("");
			const [searchBusy, setSearchBusy] = useState(false);
			const [searchResults, setSearchResults] = useState(null);
			const searchGenRef = useRef(0);
			const [jumpTarget, setJumpTarget] = useState(null);
			const jumpSeqRef = useRef(0);
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
				setLayerKey((prev) => list.some((l) => l.key === prev) ? prev : list[0].key);
			}, []);
			const [selSet, setSelSet] = useState(() => new Map());
			const selSetRef = useRef(selSet);
			selSetRef.current = selSet;
			const selGenRef = useRef(0);
			const selSyncedRef = useRef({
				gen: 0,
				targets: []
			});
			const selPendingRef = useRef(null);
			const selSyncingRef = useRef(false);
			const selSeqRef = useRef(0);
			const [selHydrated, setSelHydrated] = useState(false);
			const [selTrayOpen, setSelTrayOpen] = useState(false);
			const [selBusy, setSelBusy] = useState(false);
			const [selError, setSelError] = useState(null);
			const [selPreview, setSelPreview] = useState(null);
			const [selPreviewBusy, setSelPreviewBusy] = useState(false);
			const [selReceipt, setSelReceipt] = useState(null);
			const [selReceiptView, setSelReceiptView] = useState(false);
			const selReceiptTimerRef = useRef(null);
			const receiptProminentMs = () => typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_RECEIPT_MS) ? window.__DSH_NOTES_RECEIPT_MS : 4e3;
			const clearSelReceipt = () => {
				if (selReceiptTimerRef.current !== null) {
					clearTimeout(selReceiptTimerRef.current);
					selReceiptTimerRef.current = null;
				}
				setSelReceipt(null);
				setSelReceiptView(false);
			};
			const showSelReceipt = (r) => {
				if (selReceiptTimerRef.current !== null) {
					clearTimeout(selReceiptTimerRef.current);
					selReceiptTimerRef.current = null;
				}
				setSelReceipt(r);
				if (r.kind === "success") selReceiptTimerRef.current = setTimeout(() => {
					selReceiptTimerRef.current = null;
					if (aliveRef.current && sessionIdRef.current === (selReceiptSessionRef.current ?? sessionIdRef.current)) setSelReceipt((cur) => cur && cur.kind === "success" ? {
						...cur,
						degraded: true
					} : cur);
				}, receiptProminentMs());
			};
			const selReceiptSessionRef = useRef(sessionId);
			selReceiptSessionRef.current = sessionId;
			const aliveRef = useRef(true);
			useEffect(() => () => {
				aliveRef.current = false;
				if (selReceiptTimerRef.current !== null) clearTimeout(selReceiptTimerRef.current);
			}, []);
			const selUrl = `/notes-api/${encodeURIComponent(sessionId)}/selection`;
			const selKeyOf = (laneKey, itemKey) => `${laneKey}\u0000${itemKey}`;
			const selMapFromTargets = (targets) => {
				const m = new Map();
				(Array.isArray(targets) ? targets : []).forEach((t$1) => {
					if (t$1 && typeof t$1.laneKey === "string" && typeof t$1.itemKey === "string" && t$1.itemKey !== "") m.set(selKeyOf(t$1.laneKey, t$1.itemKey), {
						laneKey: t$1.laneKey,
						itemKey: t$1.itemKey
					});
				});
				return m;
			};
			const targetsOfSelMap = (m) => [...m.values()];
			const sameTargets = (a, b) => {
				const ka = (Array.isArray(a) ? a : []).map((t$1) => selKeyOf(t$1.laneKey, t$1.itemKey)).sort().join(",");
				const kb = (Array.isArray(b) ? b : []).map((t$1) => selKeyOf(t$1.laneKey, t$1.itemKey)).sort().join(",");
				return ka === kb;
			};
			useEffect(() => {
				const seq = ++selSeqRef.current;
				setSelSet(new Map());
				setSelHydrated(false);
				setSelTrayOpen(false);
				setSelPreview(null);
				setSelError(null);
				clearSelReceipt();
				selGenRef.current = 0;
				selSyncedRef.current = {
					gen: 0,
					targets: []
				};
				selPendingRef.current = null;
				let cancelled = false;
				const mySessionId = sessionId;
				const retryMs = typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_HYDRATE_RETRY_MS) ? window.__DSH_NOTES_HYDRATE_RETRY_MS : 700;
				const readSelection = async () => {
					try {
						const r = await notesFetch(selUrl);
						if (!r.ok) return undefined;
						const raw = await r.text().catch(() => "");
						try {
							return raw ? JSON.parse(raw) : {
								pending: null,
								lastBinding: null
							};
						} catch {
							return undefined;
						}
					} catch {
						return undefined;
					}
				};
				const clearWithRetry = async () => {
					let attempt = 0;
					while (!cancelled && aliveRef.current && seq === selSeqRef.current && sessionIdRef.current === mySessionId) {
						const gen = ++selGenRef.current;
						let j = null;
						try {
							const r = await notesFetch(selUrl, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									targets: [],
									generation: gen
								})
							});
							const raw = await r.text().catch(() => "");
							try {
								j = raw ? JSON.parse(raw) : null;
							} catch {
								j = null;
							}
						} catch {
							j = null;
						}
						if (cancelled || !aliveRef.current) return;
						if (j && j.ok === true) {
							selSyncedRef.current = {
								gen: j.generation,
								targets: []
							};
							return;
						}
						if (j && j.ok === false && j.stale === true && Number.isSafeInteger(j.currentGeneration)) {
							selGenRef.current = j.currentGeneration;
							continue;
						}
						await new Promise((r) => setTimeout(r, retryMs * Math.min(attempt + 1, 3)));
						attempt++;
					}
				};
				(async () => {
					let j;
					for (let tryNo = 0; tryNo < 5; tryNo++) {
						if (cancelled || !aliveRef.current || seq !== selSeqRef.current || sessionIdRef.current !== mySessionId) return;
						j = await readSelection();
						if (j !== undefined) break;
						if (tryNo < 4) await new Promise((r) => setTimeout(r, retryMs));
					}
					if (cancelled || !aliveRef.current || seq !== selSeqRef.current || sessionIdRef.current !== mySessionId) return;
					if (j !== undefined && j !== null) {
						const p = j.pending;
						if (p && Array.isArray(p.targets) && p.targets.length > 0 && Number.isSafeInteger(p.generation)) {
							setSelSet(selMapFromTargets(p.targets));
							selSyncedRef.current = {
								gen: p.generation,
								targets: p.targets
							};
							selGenRef.current = p.generation;
						} else {
							setSelSet(new Map());
							selSyncedRef.current = {
								gen: selSyncedRef.current.gen,
								targets: []
							};
						}
						setSelHydrated(true);
						setSelError(null);
						return;
					}
					await clearWithRetry();
					if (cancelled || !aliveRef.current || seq !== selSeqRef.current || sessionIdRef.current !== mySessionId) return;
					setSelSet(new Map());
					setSelHydrated(true);
					setSelError(null);
				})();
				return () => {
					cancelled = true;
				};
			}, [sessionId, selUrl]);
			const pumpSel = async () => {
				if (selSyncingRef.current) return;
				selSyncingRef.current = true;
				const epoch = selSeqRef.current;
				const mySid = sessionIdRef.current;
				try {
					while (selPendingRef.current !== null && aliveRef.current && epoch === selSeqRef.current && sessionIdRef.current === mySid) {
						const targets = selPendingRef.current;
						const gen = ++selGenRef.current;
						let j = null;
						let status$1 = 0;
						try {
							const r = await notesFetch(selUrl, {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									targets,
									generation: gen
								})
							});
							status$1 = r.status;
							const raw = await r.text().catch(() => "");
							try {
								j = raw ? JSON.parse(raw) : null;
							} catch {
								j = null;
							}
						} catch (e) {
							j = {
								ok: false,
								network: true,
								reason: String(e && e.message || e)
							};
						}
						if (!aliveRef.current || epoch !== selSeqRef.current || sessionIdRef.current !== mySid) return;
						if (j && j.ok === true) {
							selSyncedRef.current = {
								gen: j.generation,
								targets
							};
							if (selPendingRef.current !== null && sameTargets(selPendingRef.current, targets)) selPendingRef.current = null;
							setSelError(null);
							if (targets.length === 0) {
								setSelTrayOpen(false);
								setSelPreview(null);
							}
							continue;
						}
						if (j && j.ok === false && j.stale === true && Number.isSafeInteger(j.currentGeneration)) {
							selGenRef.current = j.currentGeneration;
							continue;
						}
						selPendingRef.current = null;
						if (aliveRef.current && epoch === selSeqRef.current && sessionIdRef.current === mySid) {
							setSelSet(selMapFromTargets(selSyncedRef.current.targets));
							const reason = j && j.reason || (j && j.network ? panelT("label.networkError") : `HTTP ${status$1}`);
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
				if (targets.length > 0 || nextMap.size === 0) clearSelReceipt();
				selPendingRef.current = targets;
				pumpSel();
			};
			const toggleSelection = (laneKey, itemKey) => {
				const next = new Map(selSetRef.current);
				const k = selKeyOf(laneKey, itemKey);
				if (next.has(k)) next.delete(k);
else next.set(k, {
					laneKey,
					itemKey
				});
				applyLocal(next);
			};
			const clearSelection = () => applyLocal(new Map());
			useEffect(() => {
				if (!selHydrated || selSetRef.current.size === 0) return;
				let cancelled = false;
				const tick = async () => {
					if (cancelled || !aliveRef.current) return;
					const epoch = selSeqRef.current;
					const mySid = sessionIdRef.current;
					if (selSyncingRef.current || selPendingRef.current !== null) return;
					let j = null;
					try {
						const r = await notesFetch(selUrl);
						const raw = await r.text().catch(() => "");
						try {
							j = raw ? JSON.parse(raw) : null;
						} catch {
							j = null;
						}
					} catch {
						return;
					}
					if (cancelled || !aliveRef.current || !j || epoch !== selSeqRef.current || sessionIdRef.current !== mySid) return;
					const syncedGen = selSyncedRef.current.gen;
					const lb = j.lastBinding;
					if (lb && lb.generation === syncedGen) {
						if (lb.ok === true) {
							const boundTargets = targetsOfSelMap(selSetRef.current);
							const noteCount = Number.isSafeInteger(lb.noteCount) ? lb.noteCount : boundTargets.length;
							selPendingRef.current = null;
							selSyncedRef.current = {
								gen: syncedGen,
								targets: []
							};
							setSelSet(new Map());
							setSelTrayOpen(false);
							setSelPreview(null);
							setSelError(null);
							setStatus(panelT("status.selectionBound", { n: noteCount }));
							showSelReceipt({
								kind: "success",
								noteCount,
								targets: boundTargets,
								degraded: false,
								at: Date.now()
							});
							return;
						}
						const fail = Array.isArray(lb.failures) && lb.failures[0] || {};
						const failReason = fail.reason || panelT("label.selectionParseFailed");
						setSelError(panelT("status.selectionFailure", {
							code: fail.code || "FAILED",
							reason: failReason
						}));
						showSelReceipt({
							kind: "failure",
							noteCount: lb.noteCount ?? selSetRef.current.size,
							code: fail.code || "FAILED",
							reason: failReason,
							at: Date.now()
						});
						return;
					}
					const p = j.pending;
					const hostTargets = p && Array.isArray(p.targets) ? p.targets : [];
					if (!sameTargets(hostTargets, selSyncedRef.current.targets)) {
						if (p && Number.isSafeInteger(p.generation)) {
							setSelSet(selMapFromTargets(hostTargets));
							selSyncedRef.current = {
								gen: p.generation,
								targets: hostTargets
							};
							selGenRef.current = Math.max(selGenRef.current, p.generation);
						} else if (!p) {
							setSelSet(new Map());
							selSyncedRef.current = {
								gen: selSyncedRef.current.gen,
								targets: []
							};
							setSelTrayOpen(false);
							setSelPreview(null);
						}
					}
				};
				const id = setInterval(tick, typeof window !== "undefined" && Number.isFinite(window.__DSH_NOTES_SEL_POLL_MS) ? window.__DSH_NOTES_SEL_POLL_MS : 1500);
				return () => {
					cancelled = true;
					clearInterval(id);
				};
			}, [
				selHydrated,
				selSet.size,
				selUrl
			]);
			useEffect(() => {
				if (!selTrayOpen || selSet.size === 0) {
					setSelPreview(null);
					setSelPreviewBusy(false);
					return;
				}
				let cancelled = false;
				const lanesNeeded = [...new Set([...selSet.values()].map((t$1) => t$1.laneKey))];
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
									if (ik !== "") map[ik] = {
										authored: String(node.item.comment ?? ""),
										exists: true
									};
								}
							});
							out[lane] = map;
						}
					} catch {}
					if (!cancelled && aliveRef.current && epoch === selSeqRef.current && sessionIdRef.current === mySid) {
						setSelPreview(out);
						setSelPreviewBusy(false);
					}
				})();
				return () => {
					cancelled = true;
				};
			}, [
				selTrayOpen,
				selSet,
				url
			]);
			useEffect(() => {
				let cancelled = false;
				notesFetch(`/notes-api/fork-status?sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then((info) => {
					if (cancelled) return;
					if (info?.isForkChild && info?.status === "unresolved") setCarryOver({
						parentSessionId: info.parentSessionId,
						status: "unresolved",
						carriedLanes: null
					});
else setCarryOver(null);
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [sessionId]);
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
							setStatus(panelT("status.inheritPaused"));
							return;
						}
					}
				}
				setCarryBusy(true);
				const bodyLanes = choice === "some" ? carrySelected : null;
				notesFetch("/notes-api/fork-carryover", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId,
						choice,
						lanes: bodyLanes
					})
				}).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then((result) => {
					if (result?.status === "conflict") {
						setCarryConflict({
							choice,
							lanes: bodyLanes,
							conflicts: result.conflicts,
							observations: result.observations
						});
						const res = {};
						result.conflicts.forEach((c) => {
							res[c.lane] = "merge";
						});
						setCarryResolutions(res);
						return;
					}
					setCarryOver(null);
					setCarryPicking(false);
					if (result?.status === "carried") showCarryResult(result.results || []);
else if (result?.status === "none") setStatus(panelT("status.inheritNone"));
else setStatus(panelT("status.inheritDone"));
				}).catch((e) => setStatus(panelT("status.inheritFailed", { error: e.message }))).finally(() => setCarryBusy(false));
			};
			const showCarryResult = (results) => {
				const laneLines = [];
				const applied = [];
				results.forEach((r) => {
					const l = layers.find((x) => x.key === r.lane);
					const label = l?.label ?? r.lane;
					if (r.outcome === "merged") {
						laneLines.push({
							lane: r.lane,
							label,
							text: panelT("status.carryMerged")
						});
						applied.push(r.lane);
					} else if (r.outcome === "replaced") {
						laneLines.push({
							lane: r.lane,
							label,
							text: panelT("status.carryReplaced")
						});
						applied.push(r.lane);
					} else if (r.outcome === "copied") {
						laneLines.push({
							lane: r.lane,
							label,
							text: panelT("status.carryCopied")
						});
						applied.push(r.lane);
					} else if (r.outcome === "kept") laneLines.push({
						lane: r.lane,
						label,
						text: panelT("status.carryKept")
					});
else if (r.outcome === "skipped") laneLines.push({
						lane: r.lane,
						label,
						text: panelT("status.carrySkipped", { reason: r.reason ?? panelT("label.genericError") })
					});
				});
				setCarryResult({
					laneLines,
					applied
				});
				setStatus("");
				if (applied.includes(layerKey) && !dirtyRef.current) {
					const refreshLane = layerKey;
					saveSeq.current++;
					setConflict(null);
					notesFetch(url(refreshLane)).then((r) => r.ok ? r : Promise.reject(new Error(`HTTP ${r.status}`))).then(async (r) => {
						const body = await r.text();
						const mt = r.headers.get("x-notes-mtime") ?? "0";
						if (layerKeyRef.current === refreshLane && !dirtyRef.current) {
							setText(body);
							setMtime(mt);
							setDirty(false);
						}
					}).catch(() => {});
				}
			};
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
						observations: carryConflict.observations
					})
				}).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then((result) => {
					if (result?.alreadyDecided) {
						setCarryConflict(null);
						setCarryOver(null);
						setStatus(panelT("status.alreadyDecided"));
						return;
					}
					const stale = (result.results || []).filter((r) => r.outcome === "stale");
					if (stale.length > 0) {
						setStatus(panelT("status.contentChanged"));
						notesFetch("/notes-api/fork-carryover", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								sessionId,
								choice: carryConflict.choice,
								lanes: carryConflict.lanes
							})
						}).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then((fresh) => {
							if (fresh?.status === "conflict") {
								setCarryConflict({
									choice: carryConflict.choice,
									lanes: carryConflict.lanes,
									conflicts: fresh.conflicts,
									observations: fresh.observations
								});
								const res = {};
								fresh.conflicts.forEach((c) => {
									res[c.lane] = "merge";
								});
								setCarryResolutions(res);
							} else decideCarryOver(carryConflict.choice, carryConflict.lanes);
						}).catch((e) => setStatus(panelT("status.reconfirmFailed", { error: e.message })));
						return;
					}
					setCarryConflict(null);
					setCarryOver(null);
					showCarryResult(result.results || []);
				}).catch((e) => setStatus(panelT("status.inheritFailed", { error: e.message }))).finally(() => setCarryBusy(false));
			};
			useEffect(() => {
				refreshMeta().catch(() => {});
				return undefined;
			}, [refreshMeta]);
			useEffect(() => {
				if (!profileSettings?.subscribe) return undefined;
				const sync = () => {
					setProfileSettingsSnapshot(profileSettings.getSnapshot());
					refreshMeta().catch(() => {});
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
			}, [
				profileSettings,
				profileSettingsSnapshot,
				initialProfileLocale
			]);
			useEffect(() => {
				let cancelled = false;
				notesFetch(setupUrl).then(async (r) => {
					if (!r.ok) return null;
					const raw = await r.text();
					try {
						return raw ? JSON.parse(raw) : null;
					} catch {
						return null;
					}
				}).then((info) => {
					if (!cancelled && (info?.state === "INITIALIZED" || info?.state === "UNINITIALIZED")) setSetup(info);
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [setupUrl]);
			const dirtyRef = useRef(false);
			dirtyRef.current = dirty;
			const lastSessionRef = useRef(sessionId);
			useEffect(() => {
				let cancelled = false;
				const sessionChanged = lastSessionRef.current !== sessionId;
				lastSessionRef.current = sessionId;
				if (sessionChanged) {
					setCapture(null);
					setCaptureComment("");
					setReentry(null);
					setComposerText("");
					setEditingIndex(null);
					editingSigRef.current = null;
					setAttachHint(null);
					setConfirmingDelete(null);
					setupContinuationRef.current = null;
				}
				if (sessionChanged && dirtyRef.current) {
					if (!window.confirm(panelT("status.switchDiscard"))) {
						setStatus(panelT("status.switchKept"));
						return;
					}
					setDirty(false);
					dirtyRef.current = false;
				}
				setStatus(panelT("status.loading"));
				notesFetch(url(layerKey)).then((r) => r.ok ? r : Promise.reject(new Error(`HTTP ${r.status}`))).then(async (r) => {
					const body = await r.text();
					const mt = r.headers.get("x-notes-mtime") ?? "0";
					if (!cancelled && !dirtyRef.current) {
						setText(body);
						setMtime(mt);
						setConflict(null);
						setStatus("");
					}
				}).catch((e) => {
					if (!cancelled) setStatus(panelT("status.loadFailed", { error: e.message }));
				});
				return () => {
					cancelled = true;
				};
			}, [sessionId, layerKey]);
			useEffect(() => {
				setPinKeys(readPinMap(sessionId, layerKey));
			}, [
				sessionId,
				layerKey,
				text
			]);
			const runSearch = useCallback(async (q) => {
				const needle = normalizeSearchText(q);
				const gen = ++searchGenRef.current;
				if (!needle) {
					setSearchResults(null);
					return;
				}
				const mySession = sessionId;
				setSearchBusy(true);
				setSearchResults(null);
				try {
					const laneRows = await Promise.all(layers.map(async (l) => {
						const r = await notesFetch(url(l.key));
						if (!r.ok) throw new Error(`HTTP ${r.status}`);
						const body = await r.text();
						const parsed = parseLaneBody(body);
						const forkMerge = isMergeWrapperBody(body);
						const matches = [];
						parsed.nodes.forEach((node, physIndex) => {
							if (noteMatchesQuery(node, needle)) matches.push({
								node,
								physIndex
							});
						});
						return {
							key: l.key,
							label: l.label,
							displayId: l.displayId,
							forkMerge,
							nodes: matches
						};
					}));
					if (gen !== searchGenRef.current) return;
					if (sessionIdRef.current !== mySession) return;
					setSearchResults({
						query: q,
						lanes: laneRows
					});
				} catch (e) {
					if (gen !== searchGenRef.current) return;
					if (sessionIdRef.current === mySession) setSearchResults({
						query: q,
						lanes: [],
						error: String(e?.message || e)
					});
				} finally {
					if (gen === searchGenRef.current && sessionIdRef.current === mySession) setSearchBusy(false);
				}
			}, [
				sessionId,
				layers,
				url
			]);
			useEffect(() => {
				if (!searchOpen) {
					searchGenRef.current++;
					setSearchResults(null);
					setSearchQuery("");
					setSearchBusy(false);
					return;
				}
				const q = searchQuery.trim();
				searchGenRef.current++;
				setSearchResults(null);
				setSearchBusy(false);
				if (!q) return;
				setSearchBusy(true);
				const t$1 = setTimeout(() => runSearch(q), 300);
				return () => clearTimeout(t$1);
			}, [
				searchQuery,
				searchOpen,
				runSearch
			]);
			const handleClose = useCallback(() => {
				if (dirty && !window.confirm(panelT("status.closeDiscard"))) return;
				onClose();
			}, [dirty, onClose]);
			useEffect(() => {
				const onKey = (e) => {
					if (e.key === "Escape") handleClose();
				};
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [handleClose]);
			const confirmDiscard = () => !dirty || window.confirm(panelT("status.operationDiscard"));
			const saveProfileLabels = async () => {
				if (!profileSettings) return;
				const snapshot = profileSettings.getSnapshot();
				if (snapshot.status !== "ready" || snapshot.writable !== true) throw new Error(panelT("status.profileSettingsUnavailable"));
				const userLayer = snapshot.user?.layerOverrides && typeof snapshot.user.layerOverrides === "object" ? snapshot.user.layerOverrides : {};
				const nextLayerOverrides = { ...userLayer };
				const nextLabels = Object.fromEntries(LANE_KEYS.map((key) => [key, String(profileLabels[key] ?? "").trim()]));
				if (!LANE_KEYS.every((key) => nextLabels[key] !== "")) throw new Error(panelT("status.profileLabelsRequired"));
				for (const key of LANE_KEYS) {
					const previous = nextLayerOverrides[key] && typeof nextLayerOverrides[key] === "object" ? nextLayerOverrides[key] : {};
					nextLayerOverrides[key] = {
						...previous,
						label: nextLabels[key]
					};
				}
				setProfileLabelsBusy(true);
				try {
					await profileSettings.set("layerOverrides", nextLayerOverrides);
					await refreshMeta();
				} finally {
					setProfileLabelsBusy(false);
				}
			};
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
						body: JSON.stringify(payload)
					});
					const raw = await r.text();
					const result = raw ? JSON.parse(raw) : null;
					if (!r.ok || result?.ok !== true) throw new Error(result?.reason || result?.code || `HTTP ${r.status}`);
					setSetup({
						state: "INITIALIZED",
						legacy: false
					});
					setPicker(null);
					setStatus(panelT("status.setupDone"));
					const continuation = setupContinuationRef.current;
					if (continuation && continuation.sessionId === sessionId && continuation.layerKey === layerKey) {
						setupContinuationRef.current = null;
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
				const request = {
					controller,
					seq: pickerRequestRef.current
				};
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
						startPath: setup?.browseStartPath ?? setup?.proposedPath
					});
					if (!pickerRequestCurrent(request)) return;
					if (result.mode === "cancelled") return;
					if (result.mode === "native") {
						await commitSetup("custom", result.path, true);
						return;
					}
					const listing = result.listing;
					const currentPath = listing?.path ?? listing?.currentPath ?? listing?.target?.displayPath ?? null;
					setPicker({
						listing,
						currentPath
					});
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
			const pickerEntries = picker ? picker.listing?.entries ?? picker.listing?.children ?? picker.listing?.items ?? [] : [];
			const pickerCrumbs = picker ? picker.listing?.crumbs ?? [] : [];
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
					setPicker({
						listing,
						currentPath: listing?.path ?? listing?.currentPath ?? nextPath
					});
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
					setPicker({
						listing,
						currentPath: listing?.path ?? picker.currentPath
					});
					setStatus(panelT("status.directoryCreated", { name: String(path).split(/[\\/]/).pop() }));
				} catch (error) {
					setSetupError(String(error?.message || error));
				} finally {
					abortPickerRequest();
					setSetupBusy(false);
				}
			};
			const profileSettingsReady = !profileSettings || profileSettingsSnapshot?.status === "ready";
			const profileVocabularyEstablished = Boolean(profileSettings) && profileSettingsReady && hasEstablishedProfileVocabulary(profileSettingsSnapshot);
			const profileNamingRequired = Boolean(profileSettings) && profileSettingsReady && !profileVocabularyEstablished;
			const profileLabelsReady = !profileSettings || profileSettingsReady && (profileVocabularyEstablished || profileSettingsSnapshot.writable === true && LANE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(profileLabels, key)));
			const profileNamesEl = profileNamingRequired ? createElement("div", {
				style: {
					margin: "10px 0",
					padding: "8px",
					border: "1px solid #e5e7eb",
					borderRadius: "6px",
					background: "#fff"
				},
				"data-notes-profile-labels": "1"
			}, createElement("div", { style: {
				fontSize: "12px",
				fontWeight: 600,
				marginBottom: "3px"
			} }, panelT("label.setupLaneNames")), createElement("div", { style: {
				fontSize: "11px",
				color: "#6b7280",
				marginBottom: "6px"
			} }, panelT("label.setupLaneNameHint")), profileSettingsSnapshot?.status === "ready" ? LANE_KEYS.map((key) => {
				const fallback = FALLBACK_LAYERS.find((layer) => layer.key === key);
				return createElement("label", {
					key,
					style: {
						display: "grid",
						gridTemplateColumns: "34px 1fr",
						alignItems: "center",
						gap: "5px",
						marginTop: "4px",
						fontSize: "11px"
					}
				}, createElement("span", null, fallback?.displayId ?? ""), createElement("input", {
					"data-notes-lane-name": key,
					value: profileLabels[key] ?? "",
					onChange: (event) => setProfileLabels((previous) => ({
						...previous,
						[key]: event.target.value
					})),
					disabled: profileLabelsBusy || setupBusy,
					style: {
						minWidth: 0,
						padding: "4px 6px",
						border: "1px solid #d1d5db",
						borderRadius: "4px"
					}
				}));
			}) : createElement("div", { style: {
				fontSize: "11px",
				color: "#6b7280"
			} }, panelT("status.profileSettingsLoading"))) : null;
			const setupGateEl = setup?.state === "UNINITIALIZED" ? createElement("div", {
				style: {
					margin: "18px 10px",
					padding: "12px",
					border: "1px solid #c7d2fe",
					borderRadius: "8px",
					background: "#f5f7ff",
					color: "#374151",
					lineHeight: "1.5"
				},
				"data-notes-setup": "1"
			}, createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				fontWeight: 700,
				color: "#374151",
				marginBottom: "6px"
			} }, createElement("span", {
				"aria-hidden": "true",
				"data-notes-setup-warning": "1",
				title: panelT("label.setupWarning"),
				style: {
					color: "#b45309",
					fontSize: "15px",
					lineHeight: 1
				}
			}, "⚠"), panelT("label.setupRequired")), setup.legacy ? createElement("div", { style: { marginBottom: "8px" } }, panelT("label.setupLegacy")) : createElement("div", { style: { marginBottom: "8px" } }, panelT("label.setupFirstUse"), setup.proposedPath ? createElement("div", {
				style: {
					marginTop: "4px",
					fontFamily: "monospace",
					fontSize: "12px"
				},
				"data-notes-proposed-path": "1"
			}, panelT("label.setupProposed", { path: setup.proposedPath })) : null), profileNamesEl, profileLabelsReady ? null : createElement("div", { style: {
				color: "#92400e",
				fontSize: "11px",
				marginBottom: "6px"
			} }, panelT("status.profileSettingsUnavailable")), setup.legacy ? createElement("button", {
				onClick: () => commitSetup("adopt"),
				disabled: setupBusy || !profileLabelsReady,
				style: {
					...setupPrimaryStyle,
					marginRight: "6px"
				}
			}, panelT("button.setupAdopt")) : createElement("button", {
				onClick: () => commitSetup("default"),
				disabled: setupBusy || !profileLabelsReady,
				style: {
					...setupPrimaryStyle,
					marginRight: "6px"
				}
			}, panelT("button.setupDefault")), !setup.legacy ? createElement("button", {
				onClick: chooseAnotherLocation,
				disabled: setupBusy || !profileLabelsReady,
				style: {
					...setupButtonStyle,
					border: "1px solid #c7d2fe",
					color: "#4338ca"
				}
			}, panelT("button.setupOther")) : null, setupError ? createElement("div", { style: {
				color: "#b45309",
				marginTop: "7px",
				fontSize: "12px"
			} }, setupError) : null, !setup.legacy && picker ? createElement("div", {
				style: {
					marginTop: "9px",
					padding: "8px",
					background: "#fff",
					border: "1px solid #dbeafe",
					borderRadius: "6px"
				},
				"data-notes-picker": "1"
			}, createElement("div", { style: {
				fontSize: "12px",
				fontWeight: 600,
				marginBottom: "5px"
			} }, panelT("label.pickerCurrent", { suffix: picker.currentPath ? panelT("label.pickerPathSuffix", { path: picker.currentPath }) : "" })), createElement("button", {
				onClick: () => commitSetup("custom", picker.currentPath),
				disabled: setupBusy || !profileLabelsReady || !picker.currentPath,
				style: {
					...setupPrimaryStyle,
					marginRight: "5px"
				}
			}, panelT("button.pickerChoose")), createElement("button", {
				onClick: createPickerChild,
				disabled: setupBusy || !picker.currentPath,
				style: {
					...setupButtonStyle,
					border: "1px solid #d1d5db",
					marginRight: "5px"
				}
			}, panelT("button.pickerNew")), createElement("button", {
				onClick: () => {
					abortPickerRequest();
					setPicker(null);
					setSetupBusy(false);
				},
				style: setupButtonStyle
			}, panelT("button.cancel")), pickerCrumbs.length > 0 ? createElement("div", { style: {
				marginTop: "6px",
				display: "flex",
				gap: "4px",
				flexWrap: "wrap"
			} }, pickerCrumbs.map((crumb, index) => isDirectoryEntry(crumb) ? createElement("button", {
				key: crumb.path,
				onClick: () => browseInto(crumb),
				style: {
					...setupButtonStyle,
					color: "#4f46e5"
				}
			}, index === 0 ? panelT("label.pickerRoot") : crumb.name || crumb.path) : null)) : null, createElement("div", { style: {
				marginTop: "6px",
				display: "flex",
				flexDirection: "column",
				gap: "3px"
			} }, pickerEntries.map((entry, index) => isDirectoryEntry(entry) ? createElement("button", {
				key: entry.path ?? entry.target?.displayPath ?? index,
				onClick: () => browseInto(entry),
				style: {
					...setupButtonStyle,
					textAlign: "left",
					color: "#1d4ed8"
				}
			}, `📁 ${entry.name ?? entry.path}`) : null))) : null) : null;
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
						body
					});
					if (r.status === 409) {
						const latest = await r.text();
						const contentType = r.headers?.get?.("content-type") ?? "";
						if (contentType.toLowerCase().includes("application/json")) {
							let logical;
							try {
								logical = JSON.parse(latest);
							} catch {
								logical = null;
							}
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
							setConflict({
								latest,
								latestMtime
							});
						}
						return false;
					}
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					const nm = r.headers.get("x-notes-mtime");
					if (seq === saveSeq.current) {
						if (nm) setMtime(nm);
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
					setupContinuationRef.current = {
						kind: "raw",
						sessionId,
						layerKey
					};
					setStatus(panelT("status.setupContinue"));
					return;
				}
				if (!conflict) doPut(text, mtime);
			};
			saveRef.current = save;
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
					if (sessionIdRef.current !== mySession) return false;
					if (cap.captureType !== "candidate") {
						try {
							console.error("[dsh-notes capture:rejected]", cap.reason, cap.detail ? JSON.stringify(cap.detail) : "");
						} catch {}
						const reason = String(cap.reason ?? panelT("status.captureInexact")).slice(0, 60);
						setAttachHint(auto ? panelT("status.captureErrorRetry", { reason }) : panelT("status.captureError", { reason }));
						return false;
					}
					const v = await validateCandidate(cap.candidate);
					if (sessionIdRef.current !== mySession) return false;
					if (!v.ok) {
						try {
							console.error("[dsh-notes capture:validate-rejected]", v.reason, v.detail ? JSON.stringify(v.detail) : "");
						} catch {}
						const reason = String(v.reason ?? panelT("status.captureValidationFailed")).slice(0, 60);
						setAttachHint(auto ? panelT("status.captureErrorRetry", { reason }) : panelT("status.captureError", { reason }));
						return false;
					}
					setAttachHint(null);
					setCapture({
						stage: "proposal",
						validated: v.validated,
						effective: v.validated.effectiveSourceText,
						unresolved: v.validated.unresolved || []
					});
					setStatus(panelT("status.captureReady"));
					return true;
				} catch (e) {
					console.error("[dsh-notes capture]", e);
					const reason = String(e && e.message || e).slice(0, 60);
					if (!auto) setAttachHint(panelT("status.captureError", { reason }));
					return false;
				} finally {
					setCaptureBusy(false);
				}
			};
			const startCapture = () => {
				runAttach({ auto: false });
			};
			useEffect(() => {
				if (rawView) return;
				if (capture) return;
				if (captureBusy) return;
				if (editingIndex !== null) return;
				if (autoAttachedRef.current.has(sessionId)) return;
				autoAttachedRef.current.add(sessionId);
				runAttach({ auto: true });
			}, [
				sessionId,
				rawView,
				capture,
				captureBusy,
				editingIndex
			]);
			const saveCapture = async (commentOverride) => {
				if (!capture || capture.stage !== "proposal" || captureBusy) return false;
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
						comment
					});
					if (!r.ok) {
						setStatus(panelT("status.saveFailed", { error: `${r.reason ?? "unknown"}${r.code ? ` (${r.code})` : ""}` }));
						return false;
					}
					const prepared = parseLaneBody(r.block);
					const preparedNode = prepared.nodes.find((node) => node.type === "item" && node.item?.kind === "source-aware");
					const block = preparedNode ? serializeItem(withItemKey(preparedNode.item, getItemKey(preparedNode.item) ?? newItemKey())) : r.block;
					const newBody = appendCaptureBlock(text, block);
					const ok = await doPut(newBody, mtime);
					if (ok) {
						setText(newBody);
						setCapture(null);
						setCaptureComment("");
						setStatus(panelT("status.saved"));
						return true;
					}
					return false;
				} catch (e) {
					console.error("[dsh-notes saveCapture]", e);
					const domPath = domPathOf(capture ? {
						validated: capture.validated,
						comment,
						lane: layerKey
					} : null, "");
					setStatus(panelT("status.saveFailed", { error: `${e.message}${domPath ? " (see console for details)" : ""}` }));
					return false;
				} finally {
					setCaptureBusy(false);
				}
			};
			const cancelCapture = () => {
				setCapture(null);
				setCaptureComment("");
			};
			const reenterItem = async (item, index) => {
				if (reentry?.busy) return;
				const locator = item?.sourcePayload;
				if (!locator) {
					setReentry({
						busy: false,
						kind: "incompatible",
						text: panelT("status.reentryIncompatibleEntry")
					});
					return;
				}
				const origin = item.captureOrigin || locator.sessionId;
				const cross = origin !== sessionId;
				if (cross && typeof window.confirm === "function") {
					const ok = window.confirm(panelT("status.reentryConfirmCross", { origin }));
					if (!ok) return;
				}
				setReentry({
					busy: true,
					kind: "loading",
					index
				});
				setStatus(panelT("status.reentryBusy"));
				try {
					const res = await notesFetch("/notes-api/reentry", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							currentSessionId: sessionId,
							locator,
							noteRef: {
								holderSessionId: sessionId,
								laneKey: layerKey,
								...getItemKey(item) ? { itemKey: getItemKey(item) } : {}
							},
							expectedSnapshot: item.snapshot,
							consent: "per-request",
							contextWindow: 2
						})
					});
					const json = await res.json().catch(() => null);
					if (!json) {
						setReentry({
							busy: false,
							kind: "error",
							text: `HTTP ${res.status}`
						});
						setStatus(panelT("status.reentryFailed"));
						return;
					}
					if (!json.ok) {
						const kind = json.status === "unauthorized" ? "unauthorized" : json.status === "unavailable" ? "unavailable" : json.status === "incompatible" ? "incompatible" : "error";
						const historicalMismatch = json.code === "HISTORICAL_S_MISMATCH";
						if (historicalMismatch && json.sameSession && json.degradedCue?.kind === "whole-message") {
							const cue = locateAndApplyWholeMessageCue(json.degradedCue);
							const text$1 = json.degradedCue.sourceMessage || json.currentSourceText || "";
							setReentry({
								busy: false,
								kind: "cue-whole",
								sameSession: true,
								text: text$1,
								historicalSnapshot: json.historicalSnapshot,
								currentSourceText: json.currentSourceText,
								highlighted: false,
								partial: false,
								wholeMessage: cue.wholeMessage,
								highlightedCount: cue.highlightedCount,
								wholeMessageCount: cue.wholeMessageCount,
								total: cue.total,
								detail: cue.detail
							});
							setStatus(panelT("status.reentryHistoricalMismatch"));
							return;
						}
						setReentry({
							busy: false,
							kind,
							code: json.code,
							text: json.reason || "",
							historicalSnapshot: json.historicalSnapshot,
							currentSourceText: json.currentSourceText
						});
						setStatus(kind === "unauthorized" ? panelT("status.reentryUnauthorized") : kind === "unavailable" ? panelT("status.reentryUnavailable") : historicalMismatch ? panelT("status.reentryMismatch") : kind === "incompatible" ? panelT("status.reentryIncompatible") : panelT("status.reentryFailed"));
						return;
					}
					if (json.sameSession) {
						const hl = locateAndHighlight(json.exact);
						if (hl.wholeMessage) {
							setReentry({
								busy: false,
								kind: "cue-whole",
								sameSession: true,
								text: json.exact.text,
								highlighted: false,
								partial: true,
								wholeMessage: true,
								highlightedCount: hl.highlightedCount,
								wholeMessageCount: hl.wholeMessageCount,
								total: hl.total,
								detail: hl.detail,
								context: json.context
							});
							setStatus(panelT("status.reentryExactSpan"));
							return;
						}
						if (hl.highlightedCount === 0) {
							setReentry({
								busy: false,
								kind: "cue-unavailable",
								sameSession: true,
								text: json.exact.text,
								highlighted: false,
								partial: false,
								highlightedCount: 0,
								total: hl.total,
								detail: hl.detail,
								context: json.context
							});
							setStatus(panelT("status.reentryNoCue"));
							return;
						}
						if (hl.partial) {
							setReentry({
								busy: false,
								kind: "cue-partial",
								sameSession: true,
								text: json.exact.text,
								highlighted: false,
								partial: true,
								highlightedCount: hl.highlightedCount,
								total: hl.total,
								detail: hl.detail,
								context: json.context
							});
							setStatus(panelT("status.reentryPartial", {
								found: hl.highlightedCount,
								total: hl.total
							}));
							return;
						}
						setReentry({
							busy: false,
							kind: "ok-exact",
							sameSession: true,
							text: json.exact.text,
							highlighted: hl.highlighted,
							partial: hl.partial,
							highlightedCount: hl.highlightedCount,
							total: hl.total,
							detail: hl.detail,
							context: json.context
						});
						setStatus(hl.highlighted ? panelT("status.reentryExact") : panelT("status.reentryReadNoHighlight"));
					} else {
						setReentry({
							busy: false,
							kind: "ok-exact",
							sameSession: false,
							text: json.exact.text,
							context: json.context
						});
						setStatus(panelT("status.reentryCrossSession"));
					}
				} catch (e) {
					setReentry({
						busy: false,
						kind: "error",
						text: String(e?.message || e)
					});
					setStatus(panelT("status.reentryFailed"));
				}
			};
			const parsedBody = useMemo(() => parseLaneBody(text), [text]);
			const itemCount = parsedBody.nodes.filter((n) => n.type === "item" && n.item).length;
			const laneHasForkMerge = isMergeWrapperBody(text);
			const displayUnits = useMemo(() => {
				const units = parsedBody.nodes.map((node, i) => ({
					node,
					physIndex: i
				}));
				return viewDir === "newest" && !laneHasForkMerge ? units.slice().reverse() : units;
			}, [
				parsedBody,
				viewDir,
				laneHasForkMerge
			]);
			const refresh = async () => {
				if (!confirmDiscard()) return;
				saveSeq.current++;
				setConflict(null);
				const targetKey = layerKey;
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
				saveSeq.current++;
				setCapture(null);
				setCaptureComment("");
				setReentry(null);
				setComposerText("");
				setEditingIndex(null);
				editingSigRef.current = null;
				setAttachHint(null);
				setConfirmingDelete(null);
				setText("");
				setMtime("0");
				setDirty(false);
				setConflict(null);
				setLayerKey(key);
			};
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
				doPut(text, baseline, true);
			};
			const [panelW, setPanelW] = useState(340);
			const panelWRef = useRef(340);
			panelWRef.current = panelW;
			const [resizing, setResizing] = useState(false);
			const resizeStartRef = useRef(null);
			const beginResize = (e) => {
				resizeStartRef.current = {
					startX: e.clientX,
					startW: panelWRef.current
				};
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
				return () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
			}, [resizing]);
			const panelStyle = {
				position: "fixed",
				right: "0",
				top: "0",
				bottom: "0",
				width: `${panelW}px`,
				zIndex: 200,
				background: "#fff",
				borderLeft: "1px solid #ccc",
				boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
				display: "flex",
				flexDirection: "column",
				fontFamily: "system-ui, sans-serif",
				fontSize: "13px"
			};
			const resizeHandleStyle = {
				position: "absolute",
				left: "-4px",
				top: "0",
				bottom: "0",
				width: "8px",
				cursor: "ew-resize",
				zIndex: 210,
				touchAction: "none",
				...resizing ? { background: "rgba(99,102,241,0.18)" } : {}
			};
			const btnStyle = {
				background: "none",
				border: "none",
				cursor: "pointer",
				padding: "4px 8px",
				fontSize: "13px",
				borderRadius: "6px"
			};
			const composerTextareaStyle = {
				width: "100%",
				boxSizing: "border-box",
				padding: "6px 8px",
				fontSize: "13px",
				lineHeight: "1.5",
				border: "1px solid #d1d5db",
				borderRadius: "6px",
				resize: "vertical",
				minHeight: "44px",
				fontFamily: "inherit",
				outline: "none",
				color: "#111827"
			};
			const srcToggleStyle = {
				fontSize: "11px",
				padding: "1px 6px",
				cursor: "pointer",
				background: "#eef2ff",
				border: "1px solid #c7d2fe",
				borderRadius: "4px",
				color: "#4338ca"
			};
			const primarySmallStyle = {
				fontSize: "12px",
				padding: "3px 10px",
				cursor: "pointer",
				background: "#2563eb",
				color: "#fff",
				border: "none",
				borderRadius: "6px"
			};
			const noteBodyPlaceholder = panelT("label.noteBodyPlaceholder");
			const cancelComposer = () => {
				setComposerText("");
				setEditingIndex(null);
				editingSigRef.current = null;
				setAttachHint(null);
				cancelCapture();
				setConfirmingDelete(null);
			};
			const toggleSource = (i) => setCollapsedSource((prev) => ({
				...prev,
				[i]: !prev[i]
			}));
			const findItemSpan = (nodeIndex) => {
				const node = parsedBody.nodes[nodeIndex];
				if (!node || node.type !== "item") return null;
				const itemNodes = [];
				parsedBody.nodes.forEach((n, idx) => {
					if (n.type !== "item" || !n.item) return;
					const sig = serializeItem(n.item);
					itemNodes.push({
						idx,
						lines: sig.split("\n"),
						len: sig.length
					});
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
							for (let r = 0; r < n; r++) if (lines[i + r] !== cand.lines[r]) {
								okMatch = false;
								break;
							}
						}
						if (okMatch) {
							if (cand.idx === nodeIndex) return {
								start: offset,
								end: offset + cand.len
							};
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
			const beginEdit = (node, nodeIndex) => {
				if (composerBusy || node.type !== "item" || !node.item) return;
				setConfirmingDelete(null);
				setAttachHint(null);
				setEditingIndex(nodeIndex);
				editingSigRef.current = serializeItem(node.item);
				setComposerText(node.item?.comment ?? "");
			};
			const saveComposer = async () => {
				if (composerBusy) return;
				setComposerBusy(true);
				try {
					if (setup?.state === "UNINITIALIZED") {
						setupContinuationRef.current = {
							kind: "composer",
							sessionId,
							layerKey
						};
						setStatus(panelT("status.setupContinue"));
						return;
					}
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
							unknownMeta: item.unknownMeta
						};
						if (item.kind === "source-aware") {
							opts.snapshot = item.snapshot ?? "";
							opts.sourcePayload = item.sourcePayload;
						}
						let block$1;
						try {
							block$1 = serializeItem(makeItem(opts));
						} catch (e) {
							setStatus(panelT("status.saveFailed", { error: e.message }));
							return;
						}
						const span = findItemSpan(idx);
						if (!span) {
							setStatus(panelT("status.contentChanged"));
							return;
						}
						const newBody$1 = text.slice(0, span.start) + block$1 + text.slice(span.end);
						const myKey$1 = layerKey;
						const mySession$1 = sessionId;
						const ok$1 = await doPut(newBody$1, mtime);
						if (!ok$1) return;
						if (layerKeyRef.current !== myKey$1 || sessionIdRef.current !== mySession$1) return;
						setText(newBody$1);
						setComposerText("");
						setEditingIndex(null);
						editingSigRef.current = null;
						setAttachHint(null);
						setConfirmingDelete(null);
						setStatus(panelT("status.savedEdit"));
						return;
					}
					const cap = capture;
					if (cap && cap.stage === "proposal") {
						setCaptureComment(composerText);
						const ok$1 = await saveCapture(composerText);
						if (ok$1) {
							setComposerText("");
							setAttachHint(null);
							setConfirmingDelete(null);
							setStatus(panelT("status.savedNote"));
						}
						return;
					}
					if (!hasSubstantiveAuthoredContent(composerText)) {
						setStatus(panelT("status.noContent"));
						return;
					}
					const block = serializeItem(withItemKey(makeItem({
						kind: "source-independent",
						captureOrigin: sessionId,
						comment: composerText
					}), newItemKey()));
					const newBody = appendCaptureBlock(text, block);
					const myKey = layerKey;
					const mySession = sessionId;
					const ok = await doPut(newBody, mtime);
					if (!ok) return;
					if (layerKeyRef.current !== myKey || sessionIdRef.current !== mySession) return;
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
				if (!ok) return;
				if (layerKeyRef.current !== myKey || sessionIdRef.current !== mySession) return;
				setText(newBody);
				setConfirmingDelete(null);
				setStatus(panelT("status.deleted"));
			};
			const togglePin = async (i) => {
				const node = parsedBody.nodes[i];
				if (!node || node.type !== "item" || !node.item) return;
				if (editingIndex !== null || composerBusy || captureBusy || laneHasForkMerge) return;
				const myKey = layerKey;
				const mySession = sessionId;
				const persistPin = (nextKeys, alreadyKeyed) => {
					const okWrite = writePinMap(mySession, myKey, nextKeys);
					if (!okWrite) {
						setStatus(alreadyKeyed ? panelT("status.pinNotSaved") : panelT("status.pinKeySavedNotPin"));
						return false;
					}
					setPinKeys(nextKeys);
					return true;
				};
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
					if (!okPut) return;
					if (layerKeyRef.current !== myKey || sessionIdRef.current !== mySession) return;
					setText(newBody);
					key = newKey;
				}
				const next = new Set(readPinMap(mySession, myKey));
				const nowPinned = !next.has(key);
				if (nowPinned) next.add(key);
else next.delete(key);
				const ok = persistPin(next, Boolean(key));
				if (ok) setStatus(nowPinned ? panelT("status.pinned") : panelT("status.unpinned"));
			};
			useEffect(() => {
				if (!jumpTarget || jumpTarget.laneKey !== layerKey) return;
				if (text === "") return;
				const { itemKey, sig, physIndex, action } = jumpTarget;
				let found = -1;
				if (itemKey) {
					parsedBody.nodes.forEach((node$1, i) => {
						if (found >= 0) return;
						if (node$1.type !== "item" || !node$1.item) return;
						if (getItemKey(node$1.item) === itemKey) found = i;
					});
					if (found < 0) {
						setStatus(panelT("status.contentChanged"));
						setJumpTarget(null);
						return;
					}
				} else {
					const node$1 = parsedBody.nodes[physIndex];
					const okPos = node$1 && node$1.type === "item" && node$1.item && sig && serializeItem(node$1.item) === sig;
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
				return () => {
					if (jumpSeqRef.current === seq) setJumpTarget(null);
				};
			}, [
				jumpTarget,
				layerKey,
				parsedBody,
				text
			]);
			const laneTag = current()?.displayId ? " · " + current().displayId : "";
			const renderNoteCard = (node, i) => {
				if (node.type === "legacy") return createElement("div", {
					key: "legacy-" + i,
					style: {
						padding: "6px 10px",
						color: "#4b5563",
						fontSize: "13px",
						whiteSpace: "pre-wrap",
						lineHeight: "1.5",
						borderBottom: "1px dashed #e5e7eb"
					}
				}, node.text);
				const item = node.item || {};
				const authored = item.comment ?? "";
				const isAnchored = item.kind === "source-aware";
				const collapsed = Boolean(collapsedSource[i]);
				const isEditing = editingIndex === i;
				const askingDelete = confirmingDelete === i;
				const actionDisabled = editingIndex !== null || composerBusy || captureBusy;
				const cardBtnEditStyle = {
					fontSize: "11px",
					padding: "1px 10px",
					cursor: "pointer",
					background: "#f3f4f6",
					border: "1px solid #d1d5db",
					borderRadius: "4px",
					color: "#374151"
				};
				const cardBtnDeleteStyle = {
					fontSize: "11px",
					padding: "1px 10px",
					cursor: "pointer",
					background: "#fef2f2",
					border: "1px solid #fecaca",
					borderRadius: "4px",
					color: "#b91c1c"
				};
				return createElement(
					"div",
					{
						key: "note-" + i,
						style: {
							margin: "0 10px 8px",
							border: isEditing ? "1px solid #c7d2fe" : "1px solid #e5e7eb",
							borderRadius: "8px",
							padding: "6px 8px",
							background: isEditing ? "#faf9ff" : "#ffffff"
						}
					},
					// 卡片元信息行（11px 灰；区分 source-aware / source-independent 类型 + lane）
					createElement("div", { style: {
						fontSize: "11px",
						color: "#6b7280",
						marginBottom: "3px"
					} }, (isAnchored ? panelT("label.anchoredNote") : panelT("label.note")) + laneTag),
					// 编辑行为：编辑在卡片**原位**展开（不回顶部框）；authored 为主文字
					isEditing ? createElement("div", null, createElement("textarea", {
						value: composerText,
						onChange: (e) => {
							setComposerText(e.target.value);
							setStatus("");
						},
						placeholder: noteBodyPlaceholder,
						style: {
							...composerTextareaStyle,
							border: "1px solid #ddd6fe",
							borderRadius: "4px",
							padding: "4px 6px"
						}
					}), createElement("div", { style: {
						display: "flex",
						gap: "6px",
						marginTop: "4px",
						alignItems: "center"
					} }, createElement("button", {
						onClick: saveComposer,
						disabled: composerBusy || captureBusy,
						style: primarySmallStyle
					}, panelT("button.saveEdit")), createElement("button", {
						onClick: cancelComposer,
						disabled: composerBusy,
						style: {
							...btnStyle,
							color: "#6b7280",
							fontSize: "12px"
						}
					}, panelT("button.cancel")), composerBusy ? createElement("span", { style: {
						color: "#888",
						fontSize: "11px"
					} }, panelT("label.statusSaving")) : null), isAnchored ? createElement("div", { style: {
						fontSize: "11px",
						color: "#6d28d9",
						marginTop: "4px"
					} }, panelT("label.noteSourceChanged")) : null) : authored !== "" ? createElement("div", { style: {
						whiteSpace: "pre-wrap",
						fontSize: "14px",
						lineHeight: "1.5",
						color: "#111827"
					} }, authored) : createElement("div", { style: {
						color: "#9ca3af",
						fontStyle: "italic",
						fontSize: "12.5px"
					} }, panelT("label.emptyNote")),
					// 引用的原文（source-aware 卡片）辅助小框：snapshot 只读预览（可折叠，仅视图
					// 状态；不折叠也绝不呈现 raw 框架文本）
					isAnchored ? createElement("div", { style: {
						marginTop: "5px",
						border: "1px solid #ddd6fe",
						borderRadius: "5px",
						background: "#faf5ff",
						padding: "3px 6px"
					} }, createElement("div", { style: {
						display: "flex",
						alignItems: "center",
						gap: "6px",
						fontSize: "11px",
						color: "#6d28d9"
					} }, createElement("button", {
						onClick: () => toggleSource(i),
						style: srcToggleStyle,
						title: panelT("label.sourceToggle")
					}, collapsed ? panelT("button.sourceCollapsed") : panelT("button.sourceExpanded")), createElement("span", { style: { fontWeight: 600 } }, panelT("label.source")), createElement("span", { style: { flex: "1" } }), createElement("button", {
						onClick: () => reenterItem(item, i),
						disabled: reentry?.busy || !item.sourcePayload,
						title: panelT("label.sourceReadonly"),
						style: {
							fontSize: "11px",
							padding: "1px 6px",
							cursor: "pointer",
							background: item.sourcePayload ? "#eef2ff" : "#eee",
							border: "1px solid #c7d2fe",
							borderRadius: "4px"
						}
					}, item.sourcePayload ? panelT("button.reenter") : panelT("button.reenterUnavailable"))), collapsed ? null : createElement("div", { style: {
						whiteSpace: "pre-wrap",
						fontFamily: "ui-monospace, monospace",
						fontSize: "11px",
						color: "#4c1d95",
						maxHeight: "64px",
						overflow: "auto",
						marginTop: "2px"
					} }, String(item.snapshot ?? ""))) : null,
					// 底部区：编辑态不显示；否则 = 删除内联确认行（askingDelete）或 操作行
					isEditing ? null : askingDelete ? createElement("div", {
						style: {
							borderTop: "1px dashed #fecaca",
							marginTop: "5px",
							paddingTop: "4px",
							fontSize: "12px",
							color: "#374151"
						},
						"data-confirm-delete": "1"
					}, createElement("div", null, panelT("label.deleteConfirm")), createElement("div", { style: {
						display: "flex",
						gap: "6px",
						marginTop: "4px"
					} }, createElement("button", {
						onClick: () => confirmDelete(i),
						disabled: actionDisabled,
						style: {
							...cardBtnDeleteStyle,
							background: "#dc2626",
							color: "#fff",
							borderColor: "#dc2626"
						}
					}, panelT("button.deleteConfirm")), createElement("button", {
						onClick: cancelDelete,
						disabled: actionDisabled,
						style: { ...cardBtnEditStyle }
					}, panelT("button.cancel")))) : createElement(
						"div",
						{ style: {
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							gap: "6px",
							marginTop: "4px"
						} },
						// Notes behavior: whole-Note 勾选（发送下一条消息时把这条便签附上引用）。
						// 同一 Note 经 lane/Search/Pin/viewDir 多 UI 路径只占一个 entry——
						// checked 直接读 selSet（keyed holder+lane+itemKey），无 per-view 副本。
						// 无 itemKey 的 keyless item / legacy 段不可选（无 stable key → 提交时
						// 无法 re-resolve → 宁不可选不 silent subset）。
						(() => {
							const ik = getItemKey(item) ?? "";
							const selectable = ik !== "";
							const selected = selectable && selSet.has(selKeyOf(layerKey, ik));
							return createElement("label", {
								title: selectable ? panelT("label.quoteTitle") : panelT("label.quoteUnavailable"),
								style: {
									display: "flex",
									alignItems: "center",
									gap: "3px",
									fontSize: "11px",
									color: selectable ? "#1e40af" : "#9ca3af",
									cursor: selectable && !selBusy && !actionDisabled && selHydrated ? "pointer" : "not-allowed",
									userSelect: "none"
								}
							}, createElement("input", {
								type: "checkbox",
								checked: selected,
								disabled: !selectable || selBusy || !selHydrated || actionDisabled,
								onChange: () => toggleSelection(layerKey, ik),
								"data-select": "1",
								"aria-label": panelT("label.quoteAria"),
								style: {
									cursor: "inherit",
									margin: "0"
								}
							}), panelT("button.quote"));
						})(),
						createElement(
							"div",
							{ style: {
								display: "flex",
								gap: "6px",
								alignItems: "center"
							} },
							// Notes behavior: 置顶 / 取消置顶（holder-local Pin preference；纯 browser-local，
							// 不写 lane）。fork-merge wrapper lane 隐藏（pin 会打乱 parent/child
							// 分组——与 Notes behavior 的分组规则同构。无 alarm/priority 样式。
							!laneHasForkMerge ? createElement("button", {
								onClick: () => togglePin(i),
								disabled: actionDisabled,
								"data-pin": item ? pinKeys.has(getItemKey(item) ?? "") ? "1" : "0" : "0",
								style: {
									fontSize: "11px",
									padding: "1px 10px",
									cursor: "pointer",
									background: pinKeys.has(getItemKey(item) ?? "") ? "#fef9c3" : "#f3f4f6",
									border: "1px solid #e5e7eb",
									borderRadius: "4px",
									color: "#374151"
								}
							}, pinKeys.has(getItemKey(item) ?? "") ? panelT("button.unpin") : panelT("button.pin")) : null,
							createElement("button", {
								onClick: () => beginEdit(node, i),
								disabled: actionDisabled,
								style: cardBtnEditStyle
							}, panelT("button.edit")),
							createElement("button", {
								onClick: () => requestDelete(i),
								disabled: actionDisabled,
								title: panelT("label.deleteTitle"),
								style: cardBtnDeleteStyle
							}, panelT("button.delete"))
)
)
);
			};
			const attachBtnStyle = {
				fontSize: "12px",
				padding: "3px 10px",
				cursor: "pointer",
				background: "#eef2ff",
				border: "1px solid #c7d2fe",
				borderRadius: "6px",
				color: "#4338ca"
			};
			const composerCardEl = createElement(
				"div",
				{
					style: {
						margin: "6px 8px 12px",
						padding: "8px 10px",
						background: "#f1f5ff",
						border: "1px solid #cbd5f0",
						borderRadius: "8px",
						boxShadow: "0 1px 2px rgba(0,0,0,0.04)"
					},
					"data-composer": "1"
				},
				createElement("div", { style: {
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					gap: "6px",
					marginBottom: "5px"
				} }, createElement("span", { style: {
					fontWeight: 700,
					fontSize: "13px",
					color: "#4f46e5",
					letterSpacing: "0.2px"
				} }, panelT("label.newNote")), createElement("button", {
					onClick: startCapture,
					disabled: captureBusy,
					title: panelT("label.quoteSelectionTitle"),
					style: attachBtnStyle
				}, panelT("button.quoteSelection"))),
				capture && capture.stage === "proposal" && editingIndex === null ? createElement("div", { style: {
					border: "1px solid #ddd6fe",
					borderRadius: "5px",
					background: "#f5f3ff",
					padding: "5px 8px",
					marginBottom: "5px"
				} }, createElement("div", { style: {
					fontSize: "11px",
					color: "#6d28d9",
					fontWeight: 600,
					marginBottom: "2px"
				} }, panelT("label.source")), createElement("div", { style: {
					whiteSpace: "pre-wrap",
					fontFamily: "ui-monospace, monospace",
					fontSize: "11px",
					color: "#4c1d95",
					maxHeight: "72px",
					overflow: "auto"
				} }, String(capture.effective || ""))) : null,
				createElement("div", { style: {
					fontSize: "11px",
					color: "#6b7280",
					marginBottom: "2px"
				} }, panelT("label.noteBody")),
				createElement("textarea", {
					value: composerText,
					onChange: (e) => {
						setComposerText(e.target.value);
						setStatus("");
					},
					placeholder: noteBodyPlaceholder,
					style: { ...composerTextareaStyle }
				}),
				// 轻提示：已输入正文但未引用原文 → 保存为普通便签（无空 source 盒）
				composerText.trim() !== "" && !(capture && capture.stage === "proposal") ? createElement("div", { style: {
					color: "#9ca3af",
					fontSize: "11px",
					marginTop: "3px"
				} }, panelT("label.noteNoSource")) : null,
				createElement("div", { style: {
					display: "flex",
					gap: "6px",
					marginTop: "6px",
					alignItems: "center"
				} }, createElement("button", {
					onClick: saveComposer,
					disabled: composerBusy || captureBusy,
					style: primarySmallStyle
				}, panelT("button.saveNote")), createElement("button", {
					onClick: cancelComposer,
					disabled: composerBusy,
					style: {
						...btnStyle,
						color: "#6b7280",
						fontSize: "12px"
					}
				}, panelT("button.cancel")), composerBusy ? createElement("span", { style: {
					color: "#888",
					fontSize: "11px"
				} }, panelT("label.statusSaving")) : null),
				// 引用失败的浅提示（自动附源没精确匹配 / 手动引用失败）——在 composer 下方
				// 一行，人话小字；只提示、不阻塞纯便签保存、不做主导航 error 框
				attachHint ? createElement("div", { style: {
					color: "#92400e",
					fontSize: "11px",
					lineHeight: "1.4",
					marginTop: "4px"
				} }, attachHint) : null
);
			const jumpToNote = (row, action) => {
				if (row?.node?.type !== "item" || !row.node.item) return;
				const hasDraft = composerBusy || captureBusy || (composerText ?? "").trim() !== "" || Boolean(capture && capture.stage === "proposal") || editingIndex !== null;
				if (hasDraft && typeof window.confirm === "function") {
					const keep = window.confirm(panelT("status.operationDiscard"));
					if (!keep) return;
					cancelComposer();
				} else if (hasDraft) return;
				const itemKey = getItemKey(row.node.item) ?? undefined;
				const jump = {
					laneKey: row.key,
					action
				};
				if (itemKey) jump.itemKey = itemKey;
else {
					jump.physIndex = row.physIndex;
					jump.sig = serializeItem(row.node.item);
				}
				setSearchOpen(false);
				setSearchQuery("");
				setSearchResults(null);
				if (layerKey !== row.key) switchLayer(row.key);
				setJumpTarget(jump);
			};
			const searchRowEl = createElement(
				"div",
				{ style: {
					display: "flex",
					gap: "6px",
					alignItems: "center",
					padding: "4px 10px 0",
					fontSize: "12px"
				} },
				// Notes behavior A1: Search 视觉区分——🔍 图标 + 明确的 placeholder + 与"新便签"composer
				// 不同的浅色底/边框（search ≠ create 一瞥可辨）。纯插件本地呈现：不加过滤器/
				// 标签/语义搜索/新查询态；搜索行为、清空、×Pin×Notes behavior 全不变。
				createElement("span", {
					"aria-hidden": "true",
					style: {
						fontSize: "13px",
						color: "#64748b",
						lineHeight: "1",
						paddingLeft: "2px"
					}
				}, "🔍"),
				createElement("input", {
					type: "search",
					value: searchQuery,
					onChange: (e) => setSearchQuery(e.target.value),
					placeholder: panelT("label.searchPlaceholder"),
					"data-search-input": "1",
					"aria-label": panelT("label.searchAria"),
					title: panelT("label.searchTitle"),
					style: {
						flex: "1",
						minWidth: "0",
						border: "1px solid #cbd5e1",
						borderRadius: "6px",
						padding: "4px 8px",
						fontSize: "13px",
						outline: "none",
						background: "#f8fafc",
						color: "#334155"
					},
					onFocus: (e) => {
						e.target.style.borderColor = "#4f46e5";
						e.target.style.boxShadow = "0 0 0 3px rgba(79,70,229,0.28)";
						e.target.style.background = "#eef2ff";
					},
					onBlur: (e) => {
						e.target.style.borderColor = "#cbd5e1";
						e.target.style.boxShadow = "none";
						e.target.style.background = "#f8fafc";
					}
				}),
				// Notes behavior adversarial-B：Search 视图直接暴露**同一个**全局 Notes behavior newest/oldest 控件（复用
				// viewDir state，绝不建 searchViewDir / searchOrder）。仅在 query 非空（结果区
				// 显示）时出现，避免与空 query 时普通列表头部的 data-view-dir 重复。fork-merge
				// lane 无视 viewDir（恒 group-preserving 正序），但搜索跨 lane，其余普通 lane
				// 仍服从该全局控件，故不按 active lane 的 merge 态隐藏。
				searchQuery.trim() !== "" ? createElement("select", {
					value: viewDir,
					onChange: (e) => setViewDir(e.target.value),
					"data-view-dir": "1",
					"aria-label": panelT("label.orderAria"),
					title: panelT("label.orderTitleSearch"),
					style: {
						fontSize: "11px",
						padding: "1px 4px",
						border: "1px solid #d1d5db",
						borderRadius: "4px",
						background: "#fff",
						color: "#374151",
						cursor: "pointer",
						letterSpacing: "0"
					}
				}, createElement("option", { value: "newest" }, panelT("button.newest")), createElement("option", { value: "oldest" }, panelT("button.oldest"))) : null,
				createElement("button", {
					onClick: () => {
						setSearchOpen(false);
						setSearchQuery("");
						setSearchResults(null);
					},
					style: {
						...btnStyle,
						color: "#6b7280",
						fontSize: "12px"
					}
				}, panelT("label.searchClose"))
);
			const renderSearchRow = (row) => {
				if (row.node.type === "legacy") return createElement("div", {
					key: row.key + "-" + row.physIndex,
					style: {
						margin: "0 10px 6px",
						border: "1px dashed #d1d5db",
						borderRadius: "8px",
						padding: "5px 8px",
						background: "#fafafa"
					},
					"data-search-result": "1"
				}, createElement("div", { style: {
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					fontSize: "11px",
					color: "#6b7280",
					marginBottom: "2px"
				} }, createElement("span", { style: { fontWeight: 600 } }, `${panelT("label.legacy")} · ${row.label}`), createElement("span", { style: {
					color: "#2563eb",
					fontWeight: 600
				} }, panelT("label.match"))), createElement("div", { style: {
					whiteSpace: "pre-wrap",
					fontSize: "12.5px",
					lineHeight: "1.5",
					color: "#4b5563"
				} }, String(row.node.text ?? "")));
				const item = row.node.item || {};
				const authored = item.comment ?? "";
				const anchored = item.kind === "source-aware";
				const laneLabel = row.label || row.displayId || row.key;
				const sig = serializeItem(row.node.item);
				return createElement("div", {
					key: row.key + "-" + row.physIndex,
					style: {
						margin: "0 10px 6px",
						border: "1px solid #e5e7eb",
						borderRadius: "8px",
						padding: "5px 8px",
						background: "#fff"
					},
					"data-search-result": "1"
				}, createElement("div", { style: {
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					fontSize: "11px",
					color: "#6b7280",
					marginBottom: "2px"
				} }, createElement("span", { style: { fontWeight: 600 } }, `${anchored ? panelT("label.anchoredNote") : panelT("label.note")} · ${laneLabel}`), createElement("span", { style: {
					color: "#2563eb",
					fontWeight: 600
				} }, panelT("label.match"))), authored !== "" ? createElement("div", { style: {
					whiteSpace: "pre-wrap",
					fontSize: "13px",
					lineHeight: "1.45",
					color: "#111827"
				} }, authored) : createElement("div", { style: {
					color: "#9ca3af",
					fontStyle: "italic",
					fontSize: "12.5px"
				} }, panelT("label.emptyNote")), anchored ? createElement("div", { style: {
					marginTop: "4px",
					border: "1px solid #ddd6fe",
					borderRadius: "5px",
					background: "#faf5ff",
					padding: "3px 6px",
					fontSize: "11px",
					color: "#4c1d95"
				} }, createElement("div", { style: {
					fontWeight: 600,
					marginBottom: "1px"
				} }, panelT("label.source")), createElement("div", { style: {
					whiteSpace: "pre-wrap",
					maxHeight: "48px",
					overflow: "auto"
				} }, String(item.snapshot ?? ""))) : null, createElement(
					"div",
					{ style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						gap: "6px",
						marginTop: "4px"
					} },
					// Notes behavior: Search 视图同一 selection truth——checkbox 读全局 selSet（按 result
					// 所属 lane + itemKey；Notes behavior addendum：selection 跨 query/lane 存活），绝不
					// 新建 search 专属选择状态。
					(() => {
						const ik = getItemKey(row.node.item) ?? "";
						const selectable = ik !== "";
						const selected = selectable && selSet.has(selKeyOf(row.key, ik));
						return createElement("label", {
							title: selectable ? panelT("label.quoteTitle") : panelT("label.quoteUnavailable"),
							style: {
								display: "flex",
								alignItems: "center",
								gap: "3px",
								fontSize: "11px",
								color: selectable ? "#1e40af" : "#9ca3af",
								cursor: selectable && !selBusy && selHydrated ? "pointer" : "not-allowed",
								userSelect: "none"
							}
						}, createElement("input", {
							type: "checkbox",
							checked: selected,
							disabled: !selectable || selBusy || !selHydrated,
							onChange: () => toggleSelection(row.key, ik),
							"data-select": "1",
							"aria-label": panelT("label.quoteAria"),
							style: {
								cursor: "inherit",
								margin: "0"
							}
						}), panelT("button.quote"));
					})(),
					createElement(
						"div",
						{ style: {
							display: "flex",
							gap: "6px",
							alignItems: "center"
						} },
						// Notes behavior adversarial-A：按钮态按 **result 所属 lane** 的持久化 pin 集合判定（row.pinned
						// 由 searchContentEl 按 lane 分组时解析）；跨 lane 结果不再借 active lane 的
						// pinKeys、也不再强制 layerKey === row.key 才显示 取消置顶。
						// Notes behavior validation case：merge-wrapper lane 的 Search result **不渲染** Pin 按钮
						// （Notes behavior merge-wrapper Pin affordance unavailable；点击会因 laneHasForkMerge 被
						// togglePin 直接忽略——可见但无效的按钮是误导性 UI）。
						!row.forkMerge ? createElement("button", {
							onClick: () => jumpToNote(row, "pin"),
							"data-pin": row.pinned ? "1" : "0",
							style: {
								...btnStyle,
								fontSize: "11px",
								padding: "1px 8px",
								background: row.pinned ? "#fef9c3" : "#f3f4f6"
							}
						}, row.pinned ? panelT("button.unpin") : panelT("button.pin")) : null,
						createElement("button", {
							onClick: () => jumpToNote(row, "edit"),
							style: {
								...btnStyle,
								fontSize: "11px",
								padding: "1px 8px"
							}
						}, panelT("button.edit")),
						createElement("button", {
							onClick: () => jumpToNote(row, "delete"),
							style: {
								...btnStyle,
								fontSize: "11px",
								padding: "1px 8px",
								color: "#b91c1c"
							}
						}, panelT("button.delete")),
						anchored ? createElement("button", {
							onClick: () => jumpToNote(row, "reentry"),
							disabled: !item.sourcePayload,
							style: {
								...btnStyle,
								fontSize: "11px",
								padding: "1px 8px",
								background: item.sourcePayload ? "#eef2ff" : "#eee"
							}
						}, item.sourcePayload ? panelT("button.reenter") : panelT("button.reenterUnavailable")) : null
)
));
			};
			const searchLanesEl = searchResults?.lanes || [];
			const hasError = Boolean(searchResults?.error);
			const settledNoResult = searchResults && !searchBusy && searchResults.query === searchQuery.trim() && !hasError;
			const searchContentEl = createElement("div", { style: {
				flex: "1",
				minHeight: "0",
				overflowY: "auto",
				padding: "4px 0 8px",
				background: "#fff"
			} }, hasError ? createElement("div", { style: {
				color: "#b91c1c",
				fontSize: "12px",
				padding: "8px 12px"
			} }, panelT("label.searchError", { error: searchResults.error })) : settledNoResult && searchLanesEl.every((l) => l.nodes.length === 0) ? createElement("div", { style: {
				color: "#9ca3af",
				fontSize: "13px",
				padding: "14px 12px"
			} }, panelT("label.empty")) : searchBusy && !searchResults ? createElement("div", { style: {
				color: "#9ca3af",
				fontSize: "13px",
				padding: "14px 12px"
			} }, panelT("label.statusSearching")) : searchLanesEl.map((lane) => {
				const ordered = lane.forkMerge ? lane.nodes : viewDir === "newest" ? lane.nodes.slice().reverse() : lane.nodes;
				if (ordered.length === 0) return null;
				const pinSet = lane.forkMerge ? null : readPinMap(sessionId, lane.key);
				const pinnedRows = [];
				const normalRows = [];
				for (const row of ordered) {
					const isItem = row.node?.type === "item" && Boolean(row.node.item);
					const ik = isItem ? getItemKey(row.node.item) ?? "" : "";
					const pinned = Boolean(pinSet && ik !== "" && pinSet.has(ik));
					const tagged = {
						...row,
						key: lane.key,
						label: lane.label,
						displayId: lane.displayId,
						pinned,
						forkMerge: lane.forkMerge
					};
					(pinned ? pinnedRows : normalRows).push(tagged);
				}
				const parts = [];
				if (pinnedRows.length > 0) {
					parts.push(createElement("div", {
						key: "pin-head",
						"data-search-pin-group": "pinned",
						style: {
							display: "flex",
							alignItems: "center",
							gap: "6px",
							margin: "2px 10px 2px",
							padding: "2px 0 4px",
							fontSize: "11px",
							fontWeight: 600,
							color: "#4f46e5",
							borderBottom: "1px dashed #c7d2fe"
						}
					}, panelT("button.pin")));
					for (const row of pinnedRows) parts.push(renderSearchRow(row));
					if (normalRows.length > 0) parts.push(createElement("div", {
						key: "normal-head",
						"data-search-pin-group": "normal",
						style: {
							display: "flex",
							alignItems: "center",
							gap: "6px",
							margin: "4px 10px 2px",
							padding: "2px 0 4px",
							fontSize: "11px",
							fontWeight: 600,
							color: "#6b7280",
							borderBottom: "1px dashed #e5e7eb"
						}
					}, panelT("label.ordinaryNote")));
				}
				for (const row of normalRows) parts.push(renderSearchRow(row));
				return createElement("div", {
					key: lane.key,
					style: { marginBottom: "6px" }
				}, createElement("div", { style: {
					fontSize: "11px",
					fontWeight: 700,
					color: "#6b7280",
					padding: "4px 12px 2px",
					letterSpacing: "0.2px"
				} }, lane.label), ...parts);
			}));
			const notesListHeaderEl = createElement("div", { style: {
				display: "flex",
				justifyContent: "space-between",
				alignItems: "center",
				gap: "6px",
				margin: "6px 0",
				padding: "0 10px 6px",
				fontSize: "12px",
				borderBottom: "1px solid #e5e7eb"
			} }, createElement("span", { style: {
				fontWeight: 600,
				color: "#6b7280",
				letterSpacing: "0.2px"
			} }, panelT("label.savedCount", { n: itemCount })), laneHasForkMerge ? null : createElement("select", {
				value: viewDir,
				onChange: (e) => setViewDir(e.target.value),
				"data-view-dir": "1",
				"aria-label": panelT("label.orderAria"),
				title: panelT("label.orderTitle"),
				style: {
					fontSize: "11px",
					padding: "1px 4px",
					border: "1px solid #d1d5db",
					borderRadius: "4px",
					background: "#fff",
					color: "#374151",
					cursor: "pointer",
					letterSpacing: "0"
				}
			}, createElement("option", { value: "newest" }, panelT("button.newest")), createElement("option", { value: "oldest" }, panelT("button.oldest"))));
			const itemKeyOf = (node) => node?.type === "item" && node.item ? getItemKey(node.item) ?? "" : "";
			const pinnedSet = laneHasForkMerge ? new Set() : pinKeys;
			const listCardEls = [];
			if (parsedBody.nodes.length === 0) listCardEls.push(createElement("div", {
				key: "empty",
				style: {
					color: "#9ca3af",
					fontSize: "12px",
					padding: "4px 10px"
				}
			}, panelT("label.noNotes")));
else {
				const viewUnits = displayUnits;
				const pinnedUnits = viewUnits.filter(({ node }) => pinnedSet.has(itemKeyOf(node)));
				const normalUnits = viewUnits.filter(({ node }) => !pinnedSet.has(itemKeyOf(node)));
				if (pinnedUnits.length === 0) for (const { node, physIndex } of normalUnits) listCardEls.push(renderNoteCard(node, physIndex));
else {
					listCardEls.push(createElement("div", {
						key: "pin-head",
						"data-pin-group": "pinned",
						style: {
							display: "flex",
							alignItems: "center",
							gap: "6px",
							margin: "2px 10px 2px",
							padding: "2px 0 4px",
							fontSize: "12px",
							fontWeight: 600,
							color: "#4f46e5",
							borderBottom: "1px dashed #c7d2fe"
						}
					}, panelT("button.pin")));
					for (const { node, physIndex } of pinnedUnits) listCardEls.push(renderNoteCard(node, physIndex));
					listCardEls.push(createElement("div", {
						key: "normal-head",
						"data-pin-group": "normal",
						style: {
							display: "flex",
							alignItems: "center",
							gap: "6px",
							margin: "6px 10px 2px",
							padding: "2px 0 4px",
							fontSize: "12px",
							fontWeight: 600,
							color: "#6b7280",
							borderBottom: "1px dashed #e5e7eb"
						}
					}, panelT("label.ordinaryNote")));
					for (const { node, physIndex } of normalUnits) listCardEls.push(renderNoteCard(node, physIndex));
				}
			}
			const notesListEl = createElement(
				"div",
				// The parent Notes content region owns normal-view scrolling.  Keeping
				// the list intrinsic prevents a tall composer/editor from overflowing
				// behind the persistent footer while the list competes for a second
				// scrollport.
				{
					style: {
						flex: "0 0 auto",
						overflowY: "visible",
						padding: "2px 0 6px",
						borderTop: "1px solid #e5e7eb"
					},
					"data-notes-list": "1"
				},
				notesListHeaderEl,
				...listCardEls
);
			const rawEditorEl = createElement("textarea", {
				value: text,
				onChange: (e) => {
					setText(e.target.value);
					setDirty(true);
					setStatus("");
				},
				placeholder: panelT("label.rawPlaceholder", {
					label: current().label,
					key: current().key,
					sessionId
				}),
				style: {
					flex: "1",
					border: "none",
					outline: "none",
					padding: "10px",
					resize: "none",
					fontFamily: "ui-monospace, monospace",
					fontSize: "13px",
					lineHeight: "1.5"
				}
			});
			const viewToggleRowEl = createElement("div", { style: {
				display: "flex",
				justifyContent: "space-between",
				alignItems: "center",
				padding: "4px 10px",
				borderTop: "1px solid #eee",
				background: "#fff",
				fontSize: "12px"
			} }, rawView ? createElement("button", {
				onClick: () => setRawView(false),
				style: {
					...btnStyle,
					color: "#2563eb",
					fontSize: "12px",
					padding: "2px 6px"
				}
			}, panelT("button.notesView")) : createElement("button", {
				onClick: () => setRawView(true),
				style: {
					...btnStyle,
					color: "#6b7280",
					fontSize: "12px",
					padding: "2px 6px"
				}
			}, panelT("button.rawView")));
			const selCount = selSet.size;
			const trayEl = selHydrated && selCount > 0 ? createElement("div", {
				"data-sel-tray": "1",
				style: {
					borderTop: "1px solid #dbeafe",
					background: "#eff6ff",
					padding: "5px 10px 6px",
					fontSize: "12px"
				}
			}, createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				flexWrap: "wrap"
			} }, createElement("span", { style: {
				fontWeight: 700,
				color: "#1e40af"
			} }, panelT("label.selectedCount", { n: selCount })), createElement("span", { style: {
				color: "#3b82f6",
				fontSize: "11px"
			} }, panelT("label.selectedAutoAttach")), createElement("span", { style: { flex: "1" } }), selBusy ? createElement("span", { style: {
				color: "#94a3b8",
				fontSize: "11px"
			} }, panelT("label.statusSyncing")) : null, createElement("button", {
				onClick: () => setSelTrayOpen((v) => !v),
				"data-sel-tray-toggle": "1",
				title: selTrayOpen ? panelT("button.collapse") : panelT("label.selectedList"),
				style: {
					...btnStyle,
					fontSize: "11px",
					padding: "1px 6px",
					color: "#1e40af"
				}
			}, selTrayOpen ? panelT("button.collapse") : panelT("button.expand")), createElement("button", {
				onClick: clearSelection,
				disabled: selBusy,
				"data-sel-clear": "1",
				title: panelT("label.clearSelection"),
				style: {
					...btnStyle,
					fontSize: "11px",
					padding: "1px 6px",
					color: "#b91c1c"
				}
			}, panelT("button.removeAll"))), selError ? createElement("div", { style: {
				color: "#b91c1c",
				fontSize: "11px",
				lineHeight: "1.4",
				marginTop: "3px",
				whiteSpace: "pre-wrap"
			} }, selError) : null, selTrayOpen ? createElement("div", {
				"data-sel-tray-review": "1",
				style: {
					marginTop: "4px",
					borderTop: "1px dashed #bfdbfe",
					paddingTop: "4px",
					maxHeight: "150px",
					overflowY: "auto"
				}
			}, selPreviewBusy ? createElement("div", { style: {
				color: "#94a3b8",
				fontSize: "11px"
			} }, panelT("label.statusReading")) : [...selSet.values()].map((t$1) => {
				const laneMeta = layers.find((l) => l.key === t$1.laneKey);
				const laneName = laneMeta ? laneMeta.label : t$1.laneKey;
				const laneLoaded = Boolean(selPreview && selPreview[t$1.laneKey]);
				const entry = laneLoaded ? selPreview[t$1.laneKey][t$1.itemKey] || null : null;
				const gone = laneLoaded && !entry;
				return createElement("div", {
					key: selKeyOf(t$1.laneKey, t$1.itemKey),
					"data-sel-tray-row": "1",
					style: {
						display: "flex",
						alignItems: "flex-start",
						gap: "6px",
						padding: "3px 0",
						borderBottom: "1px dashed #dbeafe"
					}
				}, createElement("div", { style: {
					flex: "1",
					minWidth: "0",
					fontSize: "12px",
					color: "#334155",
					lineHeight: "1.4"
				} }, createElement("div", { style: {
					fontSize: "10.5px",
					color: "#64748b",
					fontWeight: 600
				} }, laneName), gone ? createElement("div", { style: {
					color: "#b45309",
					fontSize: "11px"
				} }, panelT("label.noteMissing")) : entry ? createElement("div", { style: {
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis"
				} }, entry.authored || panelT("label.emptyNote")) : createElement("div", { style: {
					color: "#94a3b8",
					fontSize: "11px"
				} }, selPreviewBusy ? panelT("label.statusReading") : panelT("label.unreadable"))), createElement("button", {
					onClick: () => toggleSelection(t$1.laneKey, t$1.itemKey),
					disabled: selBusy,
					"data-sel-remove": "1",
					title: panelT("label.selectionRemove"),
					style: {
						...btnStyle,
						fontSize: "11px",
						padding: "0 6px",
						color: "#b91c1c"
					}
				}, panelT("button.remove")));
			})) : null) : null;
			const selReceiptEl = selReceipt && sessionIdRef.current === selReceiptSessionRef.current ? createElement("div", {
				"data-sel-receipt": selReceipt.kind,
				style: {
					margin: "0 10px 6px",
					padding: "6px 10px",
					borderRadius: "6px",
					fontSize: "12px",
					lineHeight: "1.5",
					border: selReceipt.kind === "success" ? "1px solid #bbf7d0" : "1px solid #fecaca",
					background: selReceipt.kind === "success" ? selReceipt.degraded ? "#f0fdf4" : "#dcfce7" : "#fef2f2"
				}
			}, selReceipt.kind === "success" ? createElement("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				flexWrap: "wrap"
			} }, selReceipt.degraded ? null : createElement("span", { style: {
				fontWeight: 700,
				color: "#166534"
			} }, "✓"), createElement("span", { style: selReceipt.degraded ? {
				color: "#3f6212",
				fontSize: "11.5px"
			} : {
				color: "#14532d",
				fontWeight: 600
			} }, selReceipt.degraded ? panelT("label.boundCount", { n: selReceipt.noteCount }) : panelT("label.boundCountPast", { n: selReceipt.noteCount })), createElement("span", { style: { flex: "1" } }), !selReceipt.degraded && Array.isArray(selReceipt.targets) && selReceipt.targets.length > 0 ? createElement("button", {
				onClick: () => setSelReceiptView((v) => !v),
				"data-sel-receipt-view": "1",
				style: {
					...btnStyle,
					fontSize: "11px",
					padding: "1px 6px",
					color: "#166534"
				}
			}, selReceiptView ? panelT("button.collapse") : panelT("label.selectionReceipt")) : null, !selReceipt.degraded ? createElement("button", {
				onClick: clearSelReceipt,
				"data-sel-receipt-dismiss": "1",
				style: {
					...btnStyle,
					fontSize: "11px",
					padding: "1px 6px",
					color: "#94a3b8"
				}
			}, panelT("label.selectionReceiptClose")) : null) : createElement("div", { style: { color: "#7f1d1d" } }, createElement("div", { style: { fontWeight: 700 } }, panelT("label.selectionFailure")), createElement("div", { style: {
				fontSize: "11.5px",
				marginTop: "2px",
				whiteSpace: "pre-wrap"
			} }, panelT("label.selectionFailureDetail", {
				code: selReceipt.code || "FAILED",
				n: selReceipt.noteCount
			})), selReceipt.reason ? createElement("div", { style: {
				fontSize: "11px",
				color: "#991b1b",
				marginTop: "2px"
			} }, String(selReceipt.reason).slice(0, 200)) : null), selReceipt.kind === "success" && selReceiptView && Array.isArray(selReceipt.targets) ? createElement("div", {
				"data-sel-receipt-list": "1",
				style: {
					marginTop: "4px",
					borderTop: "1px dashed #86efac",
					paddingTop: "4px",
					maxHeight: "120px",
					overflowY: "auto"
				}
			}, selReceipt.targets.map((t$1) => {
				const laneMeta = layers.find((l) => l.key === t$1.laneKey);
				return createElement("div", {
					key: selKeyOf(t$1.laneKey, t$1.itemKey),
					style: {
						fontSize: "11px",
						color: "#14532d",
						padding: "1px 0"
					}
				}, `${laneMeta ? laneMeta.label : t$1.laneKey} · ${String(t$1.itemKey).slice(0, 18)}`);
			})) : null) : null;
			const reentryStripEl = reentry && reentry.busy ? createElement("div", { style: {
				color: "#555",
				padding: "6px 10px",
				borderTop: "1px solid #eee",
				fontSize: "12px",
				background: "#fafafa"
			} }, panelT("status.reentryReading")) : reentry && !reentry.busy ? createElement("div", { style: {
				padding: "6px 10px",
				borderTop: "1px solid #eee",
				fontSize: "12px",
				background: "#fafafa"
			} }, reentry.kind === "ok-exact" ? createElement("div", { style: {
				color: "#065f46",
				whiteSpace: "pre-wrap"
			} }, `${reentry.sameSession ? reentry.highlighted ? panelT("label.reentryExactStrip") : panelT("label.reentryReadNoHighlightStrip") : panelT("label.reentryCrossSessionStrip")}\nsource: ${String(reentry.text || "").slice(0, 400)}`) : reentry.kind === "cue-whole" ? createElement("div", { style: {
				color: "#92400e",
				whiteSpace: "pre-wrap"
			} }, panelT("label.sourceExact", { text: String(reentry.text || "").slice(0, 400) })) : reentry.kind === "cue-unavailable" ? createElement("div", { style: {
				color: "#92400e",
				whiteSpace: "pre-wrap"
			} }, panelT("label.sourceNoCue", { text: String(reentry.text || "").slice(0, 400) })) : reentry.kind === "cue-partial" ? createElement("div", { style: {
				color: "#92400e",
				whiteSpace: "pre-wrap"
			} }, panelT("label.sourcePartial", {
				found: reentry.highlightedCount,
				total: reentry.total,
				text: String(reentry.text || "").slice(0, 400)
			})) : reentry.kind === "unauthorized" ? createElement("div", { style: { color: "#92400e" } }, panelT("label.sourceUnauthorized", { text: String(reentry.text || "").slice(0, 200) })) : reentry.kind === "unavailable" ? createElement("div", { style: { color: "#92400e" } }, panelT("label.sourceUnavailable", { text: String(reentry.text || "").slice(0, 200) })) : reentry.kind === "incompatible" ? createElement("div", { style: { color: "#92400e" } }, panelT("label.sourceIncompatible", { text: String(reentry.text || "").slice(0, 200) })) : createElement("div", { style: { color: "#b91c1c" } }, panelT("label.sourceFailed", { text: String(reentry.text || "").slice(0, 200) })), reentry.kind === "ok-exact" ? createElement("button", {
				onClick: () => setReentry(null),
				style: {
					fontSize: "11px",
					marginTop: "2px",
					cursor: "pointer",
					border: "1px solid #ccc",
					borderRadius: "4px",
					background: "#fff"
				}
			}, panelT("status.reentryClosed")) : null) : null;
			const helpSections = [
				{
					t: panelT("help.noteBodyTitle"),
					b: panelT("help.noteBody")
				},
				{
					t: panelT("help.sourceTitle"),
					b: panelT("help.source")
				},
				{
					t: panelT("help.laneTodo"),
					b: panelT("help.laneTodoBody")
				},
				{
					t: panelT("help.laneDeferred"),
					b: panelT("help.laneDeferredBody")
				},
				{
					t: panelT("help.laneKnowledge"),
					b: panelT("help.laneKnowledgeBody")
				},
				{
					t: panelT("help.laneLesson"),
					b: panelT("help.laneLessonBody")
				},
				{
					t: panelT("help.branchTitle"),
					b: panelT("help.branch")
				},
				{
					t: panelT("help.editTitle"),
					b: panelT("help.edit")
				}
			];
			const helpPanelEl = createElement("div", {
				style: {
					background: "#f8fafc",
					borderBottom: "1px solid #e5e7eb",
					padding: "8px 10px",
					fontSize: "12px",
					lineHeight: "1.6",
					maxHeight: "260px",
					overflowY: "auto"
				},
				"data-help-panel": "1"
			}, createElement("div", { style: {
				display: "flex",
				justifyContent: "space-between",
				alignItems: "center",
				marginBottom: "4px"
			} }, createElement("span", { style: {
				fontWeight: 600,
				fontSize: "12.5px",
				color: "#374151"
			} }, panelT("label.help")), createElement("button", {
				onClick: () => setHelpOpen(false),
				style: {
					...btnStyle,
					color: "#6b7280",
					fontSize: "11px",
					padding: "0 6px"
				}
			}, panelT("label.helpClose"))), helpSections.map((sec) => createElement("div", {
				key: sec.t,
				style: { margin: "4px 0" }
			}, createElement("div", { style: {
				fontWeight: 600,
				color: "#4f46e5"
			} }, sec.t), createElement("div", { style: {
				color: "#374151",
				whiteSpace: "pre-wrap"
			} }, sec.b))));
			return createElement(
				"div",
				{ style: panelStyle },
				// Notes behavior A2: 拖动左缘调宽（plugin-local；数据属性供测试）
				createElement("div", {
					"data-resize-handle": "1",
					title: panelT("label.dragResize"),
					onMouseDown: beginResize,
					style: resizeHandleStyle
				}),
				// Header: title + refresh + save + close
				createElement("div", { style: {
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					padding: "8px 10px",
					borderBottom: "1px solid #eee"
				} }, createElement("span", { style: {
					fontWeight: 600,
					fontSize: "14px"
				} }, panelT("label.panelTitle")), createElement("div", { style: {
					display: "flex",
					gap: "4px",
					alignItems: "center"
				} }, createElement("button", {
					title: panelT("label.helpTitle"),
					"aria-label": panelT("label.helpTitle"),
					onClick: () => setHelpOpen((v) => !v),
					style: {
						...btnStyle,
						color: "#6b7280",
						fontSize: "13px",
						padding: "0 7px",
						fontWeight: 600
					}
				}, panelT("button.help")), createElement("button", {
					title: panelT("label.searchButtonTitle"),
					"aria-label": panelT("label.searchAria"),
					onClick: () => {
						setRawView(false);
						setHelpOpen(false);
						setSearchOpen((v) => !v);
					},
					style: {
						...btnStyle,
						color: searchOpen ? "#2563eb" : "#6b7280",
						fontSize: "13px",
						padding: "0 7px"
					}
				}, panelT("button.search")), createElement("button", {
					title: panelT("label.refreshTitle"),
					onClick: refresh,
					style: btnStyle
				}, panelT("button.refresh")), createElement("button", {
					onClick: save,
					style: {
						...btnStyle,
						background: "#2563eb",
						color: "#fff"
					}
				}, panelT("button.save")), createElement("button", {
					title: panelT("label.closeEsc"),
					onClick: handleClose,
					style: btnStyle
				}, panelT("button.close")))),
				helpOpen ? helpPanelEl : null,
				// fork/carry eligibility decision post-apply RESULT banner (top position). Per-lane lines; survives
				// lane switches / in-panel refresh; dismissed only by 知道了.
				carryResult ? createElement("div", { style: {
					padding: "8px 10px",
					borderBottom: "1px solid #bbf7d0",
					background: "#f0fdf4",
					fontSize: "12px",
					lineHeight: "1.6"
				} }, createElement("div", { style: {
					fontWeight: 600,
					marginBottom: "4px"
				} }, panelT("label.carryDone")), carryResult.laneLines.map((line) => createElement("div", { key: line.lane }, `${line.label}：${line.text}`)), createElement("button", {
					onClick: () => setCarryResult(null),
					style: {
						...btnStyle,
						marginTop: "6px",
						background: "#16a34a",
						color: "#fff"
					}
				}, panelT("button.ok"))) : null,
				// fork/carry eligibility decision: post-fork carry-over banner (top of panel, non-blocking).
				// Shown only while status === "unresolved"; dismissed on decision.
				carryOver ? createElement("div", { style: {
					padding: "8px 10px",
					borderBottom: "1px solid #fde68a",
					background: "#fffbeb",
					fontSize: "12px",
					lineHeight: "1.5"
				} }, carryConflict ? createElement("div", null, createElement("div", { style: {
					fontWeight: 600,
					marginBottom: "4px"
				} }, panelT("label.carryConflict")), createElement("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: "6px",
					margin: "4px 0"
				} }, carryConflict.conflicts.map((c) => createElement("div", {
					key: c.lane,
					style: {
						border: "1px solid #fde68a",
						borderRadius: "4px",
						padding: "6px"
					}
				}, createElement("div", { style: { fontWeight: 600 } }, `${(layers.find((l) => l.key === c.lane) || {}).label || c.lane}`), createElement("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: "2px",
					margin: "4px 0"
				} }, [
					"merge",
					"keep",
					"replace"
				].map((opt) => createElement("label", {
					key: opt,
					style: {
						display: "flex",
						alignItems: "center",
						gap: "4px",
						cursor: "pointer"
					}
				}, createElement("input", {
					type: "radio",
					name: `carry-res-${c.lane}`,
					checked: carryResolutions[c.lane] === opt,
					onChange: () => setCarryResolutions((prev) => ({
						...prev,
						[c.lane]: opt
					}))
				}), opt === "merge" ? panelT("label.carryMerge") : opt === "keep" ? panelT("label.carryKeep") : panelT("label.carryReplace")))), createElement("div", { style: {
					display: "flex",
					gap: "8px",
					marginTop: "2px",
					color: "#666"
				} }, createElement("details", { style: { flex: "1" } }, createElement("summary", null, panelT("label.carryParent")), createElement("pre", { style: {
					whiteSpace: "pre-wrap",
					margin: "2px 0",
					maxHeight: "80px",
					overflow: "auto",
					background: "#fff",
					padding: "4px",
					borderRadius: "3px"
				} }, c.parentContent || panelT("label.emptyContent"))), createElement("details", { style: { flex: "1" } }, createElement("summary", null, panelT("label.carryCurrent")), createElement("pre", { style: {
					whiteSpace: "pre-wrap",
					margin: "2px 0",
					maxHeight: "80px",
					overflow: "auto",
					background: "#fff",
					padding: "4px",
					borderRadius: "3px"
				} }, c.childContent || panelT("label.emptyContent"))))))), createElement("div", { style: {
					display: "flex",
					gap: "4px",
					marginTop: "4px"
				} }, createElement("button", {
					onClick: applyCarryResolutions,
					disabled: carryBusy,
					style: {
						...btnStyle,
						background: "#2563eb",
						color: "#fff"
					}
				}, carryBusy ? panelT("label.carryBusy") : panelT("button.confirmCarry")), createElement("button", {
					onClick: () => {
						setCarryConflict(null);
						setCarryResolutions({});
					},
					disabled: carryBusy,
					style: btnStyle
				}, panelT("button.back")))) : carryPicking ? createElement("div", null, createElement("div", { style: {
					fontWeight: 600,
					marginBottom: "4px"
				} }, panelT("label.carryQuestion")), createElement("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: "2px",
					margin: "4px 0"
				} }, layers.map((l) => createElement("label", {
					key: l.key,
					style: {
						display: "flex",
						alignItems: "center",
						gap: "4px",
						cursor: "pointer"
					}
				}, createElement("input", {
					type: "checkbox",
					checked: carrySelected.includes(l.key),
					onChange: (e) => {
						const k = l.key;
						setCarrySelected((prev) => e.target.checked ? [...prev, k] : prev.filter((x) => x !== k));
					}
				}), l.label))), createElement("div", { style: {
					display: "flex",
					gap: "4px"
				} }, createElement("button", {
					onClick: () => decideCarryOver("some", null),
					disabled: carryBusy,
					style: {
						...btnStyle,
						background: "#2563eb",
						color: "#fff"
					}
				}, panelT("button.confirmSelected")), createElement("button", {
					onClick: () => setCarryPicking(false),
					disabled: carryBusy,
					style: btnStyle
				}, panelT("button.back")))) : createElement("div", null, createElement("div", { style: {
					fontWeight: 600,
					marginBottom: "4px"
				} }, panelT("label.carryQuestion")), createElement("div", { style: {
					display: "flex",
					gap: "4px",
					flexWrap: "wrap"
				} }, createElement("button", {
					onClick: () => decideCarryOver("all", null),
					disabled: carryBusy,
					style: {
						...btnStyle,
						background: "#2563eb",
						color: "#fff"
					}
				}, panelT("button.all")), createElement("button", {
					onClick: () => decideCarryOver("some", null),
					disabled: carryBusy,
					style: btnStyle
				}, panelT("button.some")), createElement("button", {
					onClick: () => decideCarryOver("none", null),
					disabled: carryBusy,
					style: btnStyle
				}, panelT("button.none"))))) : null,
				setupGateEl,
				// Layer tabs (from resolved mapping)
				createElement("div", { style: {
					display: "flex",
					gap: "4px",
					padding: "6px 8px",
					borderBottom: "1px solid #eee",
					flexWrap: "wrap"
				} }, layers.map((l) => createElement("button", {
					key: l.key,
					onClick: () => switchLayer(l.key),
					style: {
						...btnStyle,
						background: l.key === layerKey ? "#e0e7ff" : "transparent",
						fontWeight: l.key === layerKey ? 600 : 400
					}
				}, l.label))),
				// Conflict banner (409 pending)
				conflict ? createElement("div", { style: {
					display: "flex",
					flexWrap: "wrap",
					gap: "4px",
					alignItems: "center",
					padding: "6px 10px",
					background: "#fef2f2",
					borderBottom: "1px solid #fecaca",
					color: "#b91c1c",
					fontSize: "12px"
				} }, createElement("span", { style: { width: "100%" } }, panelT("status.conflict")), createElement("button", {
					onClick: loadLatest,
					style: {
						...btnStyle,
						background: "#2563eb",
						color: "#fff"
					}
				}, panelT("button.loadLatest")), createElement("button", {
					onClick: forceSave,
					style: {
						...btnStyle,
						background: "#dc2626",
						color: "#fff"
					}
				}, panelT("button.overwrite")), createElement("button", {
					onClick: () => setConflict(null),
					style: btnStyle
				}, panelT("button.cancel"))) : null,
				// Notes behavior (Notes behavior): coherent Note-primary 内容区。默认便签视图（顶部 composer +
				// 已保存 Notes 列表 + 底部工具行照旧）；“原文编辑（高级）”为默认折叠的旧
				// 全层 textarea 编辑器（展开后原 textarea+保存/conflict/status/footer 语义
				// 与旧版完全一致）。reentry 结果 strip 保持可用的 truthful 展示。
				// Notes behavior：searchOpen 时在便签视图上方加搜索行；query 非空 → 显示跨-lane 搜索
				// 结果区（替代普通列表）；query 空 → 恢复 normal Notes view。
				rawView ? rawEditorEl : searchOpen ? createElement("div", { style: {
					flex: "1",
					minHeight: "0",
					display: "flex",
					flexDirection: "column",
					background: "#fff"
				} }, searchRowEl, searchQuery.trim() !== "" ? searchContentEl : createElement("div", { style: {
					flex: "1",
					minHeight: "0",
					display: "flex",
					flexDirection: "column"
				} }, editingIndex === null ? composerCardEl : null, notesListEl)) : createElement(
					"div",
					// One bounded scroll owner for the normal Notes view: composer,
					// list, lower-card editors, and their actions travel together.
					// Header/lane controls/footer remain persistent siblings.
					{
						style: {
							flex: "1",
							minHeight: "0",
							display: "flex",
							flexDirection: "column",
							overflowY: "auto",
							background: "#fff"
						},
						"data-notes-content": "1"
					},
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
				createElement("div", { style: {
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					padding: "8px 10px",
					borderTop: "1px solid #eee"
				} }, createElement("span", { style: {
					color: "#888",
					fontSize: "12px"
				} }, status || panelT("label.footer", {
					label: current().label,
					key: current().key,
					sessionId,
					modified: mtime && mtime !== "0" ? ` · ${panelT("label.modifiedAt", { time: new Date(Number(mtime)).toLocaleTimeString() })}` : ""
				})))
);
		}
		return function NotesToggle(props) {
			const toggleT = props.t || t;
			const [open, setOpen] = useState(false);
			const [pendingCarry, setPendingCarry] = useState(false);
			useEffect(() => {
				let cancelled = false;
				notesFetch(`/notes-api/fork-status?sessionId=${encodeURIComponent(props.sessionId)}`).then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))).then((info) => {
					if (!cancelled) setPendingCarry(Boolean(info?.isForkChild && info?.status === "unresolved"));
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, [props.sessionId, open]);
			return createElement(
				React.Fragment,
				null,
				createElement("div", { style: {
					position: "relative",
					display: "inline-block"
				} }, createElement("button", {
					title: toggleT("label.panelTitle"),
					onClick: () => setOpen((v) => !v),
					style: {
						background: "none",
						border: "none",
						cursor: "pointer",
						fontSize: "14px",
						color: "#374151",
						display: "inline-flex",
						alignItems: "center",
						gap: "3px"
					}
				}, toggleT("button.notes")), pendingCarry ? createElement("span", {
					title: toggleT("label.carryPending"),
					style: {
						position: "absolute",
						top: "0",
						right: "0",
						width: "6px",
						height: "6px",
						borderRadius: "50%",
						background: "#d97706"
					}
				}) : null),
				// Session isolation：key={sessionId} —— session 切换即 remount NotesPanel，
				// 保证 selection/tray/text 等全部 per-session 状态绝不跨 holder/session 携带
				// （外加 hydration effect 同步清空 + pump/poll/preview epoch+session guard 双保险）。
				open ? createElement(NotesPanel, {
					key: props.sessionId,
					sessionId: props.sessionId,
					onClose: () => setOpen(false),
					t: props.t || t
				}) : null
);
		};
	}
	const inject = [
		"slots",
		"uiWorkspace",
		"locale",
		"settingsScope"
	];
	function apply(ctx, React) {
		if (!ctx.slots) return;
		if (ctx.locale?.register) ctx.effect?.(() => ctx.locale.register(LOCALE_NS, {
			zh,
			en
		}), "dsh-collab-notes: dictionaries");
		const Component = NotesController(React, ctx);
		ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
			name: "conversation.session.header.utilities",
			id: "dsh-collab-notes",
			order: 40,
			inject: (sessionId) => ({ sessionId }),
			locale: LOCALE_NS
		}, Component));
	}
	window.__ModuleLoader__.load({
		id: "dsh-collab-notes",
		factory: (require) => {
			const React = require("react");
			return {
				apply: (ctx) => apply(ctx, React),
				inject
			};
		}
	});
})();

//#endregion