// dsh-collab-notes — browser capture facade（client 侧薄层）
//
// 职责（用户批准的 host-validated 版本）：
//   client: real Selection → bounded capture evidence
//   host:   authoritative validation（validateAnchoredProposal / prepareAnchoredCommit）
//   client: display host-validated proposal + unresolved → explicit Save
//
// 本 facade 是最小的 browser 集成 seam：
//   - 不做 polished capture UI / source icon / quote folding / jump-highlight；
//   - 不引入 durable proposal state / 新 lifecycle taxonomy；
//   - client-computed proposal 单独不构成 anchored truth——必须经 host
//     validate 后才可展示为 validated、Save 后才可报成功。
//
// browser-only：import 链（selection-bridge / anchored-capture / structured-item /
// source-locator）全部 browser-safe；本文件会被 tsdown 内联进 client bundle。

import { selectionToCaptureEvidence } from "./selection-bridge.js";
import { PROJECTION_VERSION_MARKDOWN } from "./source-locator.js";
import { appendCaptureBlock } from "./capture-append.js";
import { notesFetch } from "./notes-transport.js";

export { appendCaptureBlock };

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
      if (v.nodeType) { if (!domPath) domPath = path || "(root)"; return null; }
      if (seen.has(v)) return undefined; // cycle guard
      seen.add(v);
      if (Array.isArray(v)) {
        const out = [];
        for (let i = 0; i < v.length; i++) {
          const c = clone(v[i], path ? path + "." + i : String(i));
          if (c !== undefined) out.push(c);
        }
        return out;
      }
      // 只拷贝可枚举自有属性；跳过 React fiber 之类内部键（它们常含 DOM/循环）
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
  return { value, domPath };
}


export async function captureBrowserSelection(sessionId, opts = {}) {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return { captureType: "rejected", reason: "no non-collapsed browser selection to capture" };
  }
  const range = sel.getRangeAt(0);
  const projectionVersion = opts.projectionVersion === undefined ? PROJECTION_VERSION_MARKDOWN : opts.projectionVersion;
  const evidence = selectionToCaptureEvidence(range, document, { projectionVersion });
  if (evidence.proposalType === "rejected") {
    return { captureType: "rejected", reason: evidence.reason, detail: evidence };
  }
  // Candidate contains only browser evidence.  It deliberately has no
  // eventSeq/effectiveSourceText/segments claim for the host to trust.
  return {
    captureType: "candidate",
    candidate: {
      sessionId,
      projectionVersion: evidence.projectionVersion,
      evidence: {
        sessionId,
        projectionVersion: evidence.projectionVersion,
        anchors: evidence.anchors,
      },
    },
  };
}

/**
 * 提交 candidate 给 host 做 authoritative validation。
 * @returns { ok: true, validated } | { ok: false, reason, code }
 */
export async function validateCandidate(candidate) {
  const res = await notesFetch("/notes-api/anchored/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(jsonSafe({ candidate }).value),
  });
  const json = await res.json().catch(() => null);
  if (res.ok && json?.ok) return { ok: true, validated: json.validated };
  return { ok: false, reason: json?.reason || `HTTP ${res.status}`, code: json?.code || "VALIDATE_HTTP_" + res.status };
}

/**
 * explicit Save：把 host-validated proposal 编码为单个 Notes behavior source-aware block，
 * 追加到调用方提供的当前 lane body，并走既有 whole-lane conflict-safe PUT。
 * host 的 /notes-api/anchored/prepare 返回 block（serializeItem）；调用方
 * （client 面板）负责把它 append 到自己已加载的 lane body（parseLaneBody →
 * push → serializeLaneBody 或简单 body 拼接），再 PUT If-Match。
 * @param {object} validated   host validate 返回的 validated
 * @param {object} opts        { sessionId, lane, comment }
 * @returns { ok: true, block, validated } | { ok: false, reason, code, httpStatus? }
 */
export async function saveAnchoredCapture(validated, { sessionId, lane, comment }) {
  const prep = await notesFetch("/notes-api/anchored/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(jsonSafe({
      candidate: {
        sessionId: validated.sessionId,
        projectionVersion: validated.projectionVersion,
        segments: validated.segments,
        effectiveSourceText: validated.effectiveSourceText,
        unresolved: validated.unresolved,
      },
      lane,
      comment: comment ?? "",
    }).value),
  });
  const prepJson = await prep.json().catch(() => null);
  if (!prep.ok || !prepJson?.ok) {
    return { ok: false, reason: prepJson?.reason || `prepare HTTP ${prep.status}`, code: prepJson?.code || "PREPARE_FAILED" };
  }
  return { ok: true, block: prepJson.block, validated: prepJson.validated };
}
