// dsh-collab-notes — reference binding core（browser-free pure logic）
//
// 职责：把"current-holder 选中的 whole structured Notes"在 submit 时解析为
// current-content minimal reference projection，并构造 model-facing reference
// 文本与 plugin source 元数据。只做 resolve/projection/rendering 纯逻辑——
// 不读文件（lane body 由调用方提供）、不发请求、不写状态。
//
// Contract：
//   - 选中/引用单位 = whole Note item（不是 Search 片段/快照/预览）；itemKey 仅内部定位；
//   - submit 时 exact re-resolve：用当前 holder 当前 lane 当前内容（latest-at-submit）；
//   - all-or-nothing：任一 target deleted/missing/unresolved → 整体 truthful failure
//     （不静默 drop、不 subset、不 rebind）；
//   - projection：
//       source-independent           → authored content
//       anchored (+ comment)         → authored + full persisted snapshot + exact Source Anchor
//       comment-free anchored        → full persisted snapshot + exact Source Anchor
//     snapshot = persisted full accepted selected-text（capture-time 的 source excerpt，
//     不是 UI preview、不是周边 context）；exact Source Anchor = authoritative source
//     + exact locator（re-entry 依赖，intentionally retained）。
//   - 不把 holder-local itemKey / Pin / viewDir / Search / selection state /
//     capture bookkeeping 放进 model-facing content 或 source metadata（D6）；
//   - reference 文本独立于 user-authored prose；直接 user 文本由调用方原样保留。
//
// Design notes：
//   1. module 边界 = resolve/projection/render 纯函数 + target 规范；
//      文件读取/锁、pre-step 注入、pending 状态、HTTP、client tray 都在调用方
//      （host listener / client），便于 node 单测与分层验证；
//   2. source metadata 只用 kind:"plugin" + plugin:"dsh-collab-notes" + form:
//      "notes-reference" + noteCount —— 复用既有 plugin 注入分类（rc.2 client =
//      generic inject），不新增 host message role/event type；client renderer 按
//      form 识别 Notes 卡（当前 substrate 无 Notes 专用卡 → 窄
//      renderer 需求；不新 schema）；
//   3. render 文本 wrapper = implementation discretion：本项目用简洁
//      "Referenced Notes" 头部 + 每条 Note 内容，
//      Notes 正文与 Source excerpt 清晰分区，不含 itemKey/locator 之外的簿记；
//   4. Note 内 locator（sourcePayload）必须原样进入 projection（exact Source
//      Anchor 可恢复 = re-entry 前提），但只作为 reference data 呈现，不自动触
//      re-entry（只保证 recoverable reference data）。
import { parseLaneBody, inspectItemKey, KIND_SOURCE_AWARE, KIND_SOURCE_INDEPENDENT } from "./structured-item.js";

const NOTES_REFERENCE_FORM = "notes-reference";
const NOTES_REFERENCE_VERSION = 1;

/**
 * 解析一个 target 定义（规范化入参）。
 * @param {{laneKey:string, itemKey:string}} t
 * @returns {{ok:true, laneKey:string, itemKey:string} | {ok:false, code:string, reason:string}}
 */
export function normalizeTarget(t) {
  if (!t || typeof t !== "object") return { ok: false, code: "BAD_TARGET", reason: "target must be an object" };
  const laneKey = typeof t.laneKey === "string" ? t.laneKey : "";
  const itemKey = typeof t.itemKey === "string" ? t.itemKey : "";
  if (!laneKey) return { ok: false, code: "BAD_TARGET", reason: "target missing laneKey" };
  if (!itemKey) return { ok: false, code: "BAD_TARGET", reason: "target missing itemKey" };
  return { ok: true, laneKey, itemKey };
}

/**
 * 在一条 lane body 里按 holder-local itemKey 定位 whole structured Note。
 * exact identity：绝不按内容/位置/首匹配 rebind；找不到 → truthful UNRESOLVED；
 * 同 lane 出现重复 itemKey（数据异常/手改/合并产物）→ truthful AMBIGUOUS（绝不
 * first-match——会把用户选择错误绑到另一条 Note）。
 * @param {string} laneBody  lane 当前 Markdown 文本
 * @param {string} itemKey   holder-local item key（structured item unknown-meta row）
 * @returns {{ok:true, item:object, nodeIndex:number} | {ok:false, code:string, reason:string}}
 */
export function resolveItemByKey(laneBody, itemKey) {
  if (typeof itemKey !== "string" || !itemKey) {
    return { ok: false, code: "UNRESOLVED", reason: "empty itemKey" };
  }
  const parsed = parseLaneBody(String(laneBody ?? ""));
  const matches = [];
  let invalidTarget = false;
  parsed.nodes.forEach((node, i) => {
    if (node.type !== "item" || !node.item) return;
    const info = inspectItemKey(node.item);
    if (info.status === "valid" && info.key === itemKey) matches.push({ item: node.item, nodeIndex: i });
    else if (info.status !== "valid" && (info.values ?? [info.value]).includes(itemKey)) invalidTarget = true;
  });
  if (matches.length === 0) {
    return { ok: false, code: invalidTarget ? "NOT_ADDRESSABLE" : "UNRESOLVED", reason: invalidTarget ? `itemKey ${itemKey} is not canonically addressable` : `no structured Note with itemKey ${itemKey} in current lane` };
  }
  if (matches.length > 1) {
    return { ok: false, code: "AMBIGUOUS", reason: `itemKey ${itemKey} is duplicated ${matches.length} times in current lane; refusing first-match rebind` };
  }
  return { ok: true, item: matches[0].item, nodeIndex: matches[0].nodeIndex };
}

/**
 * 构造单条 whole Note 的 minimal projection（model-facing data，无簿记）。
 * @param {object} item parsed structured item
 * @returns {{ok:true, projection:{type:string, authored?:string, snapshot?:string, locator?:object}}
 *          | {ok:false, code:string, reason:string}}
 */
export function buildNoteProjection(item) {
  if (!item || typeof item !== "object") return { ok: false, code: "NO_ITEM", reason: "item required" };
  if (item.kind === KIND_SOURCE_INDEPENDENT) {
    const authored = typeof item.comment === "string" ? item.comment : "";
    return { ok: true, projection: { type: "source-independent", authored } };
  }
  if (item.kind === KIND_SOURCE_AWARE) {
    const snapshot = typeof item.snapshot === "string" ? item.snapshot : "";
    const authored = typeof item.comment === "string" ? item.comment : "";
    const locator = item.sourcePayload && typeof item.sourcePayload === "object" ? item.sourcePayload : undefined;
    if (snapshot === "") {
      return { ok: false, code: "NO_SNAPSHOT", reason: "anchored Note carries no persisted snapshot" };
    }
    if (locator === undefined) {
      // anchored Note 必有 sourcePayload（makeItem 构造强约束）；缺失 = 数据异常
      return { ok: false, code: "NO_LOCATOR", reason: "anchored Note carries no exact Source Anchor" };
    }
    if (authored === "") {
      // comment-free anchored：snapshot + locator
      return { ok: true, projection: { type: "comment-free-anchored", snapshot, locator } };
    }
    return { ok: true, projection: { type: "anchored", authored, snapshot, locator } };
  }
  return { ok: false, code: "UNSUPPORTED_KIND", reason: `unsupported item kind ${String(item && item.kind)}` };
}

/**
 * all-or-nothing resolve：对 laneBodies（laneKey → current body）与 targets 列表，
 * 每个 target 精确解析 whole Note + 构造 projection。任一失败 → {ok:false,
 * failures:[...]}；全部成功 → {ok:true, notes:[{ordinal, laneKey, projection}]}。
 * 不 mutate 输入；绝不部分成功。
 * @param {Record<string,string>} laneBodies
 * @param {Array<{laneKey:string, itemKey:string}>} targets
 */
export function resolveBinding(laneBodies, targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, failures: [{ ordinal: 0, code: "NO_TARGETS", reason: "empty selection" }] };
  }
  const failures = [];
  const notes = [];
  targets.forEach((rawTarget, ordinal) => {
    const norm = normalizeTarget(rawTarget);
    if (!norm.ok) { failures.push({ ordinal, code: norm.code, reason: norm.reason }); return; }
    const body = laneBodies && typeof laneBodies === "object" ? laneBodies[norm.laneKey] : undefined;
    if (typeof body !== "string") {
      failures.push({ ordinal, laneKey: norm.laneKey, itemKey: norm.itemKey, code: "LANE_UNAVAILABLE", reason: `lane ${norm.laneKey} content unavailable` });
      return;
    }
    const found = resolveItemByKey(body, norm.itemKey);
    if (!found.ok) {
      failures.push({ ordinal, laneKey: norm.laneKey, itemKey: norm.itemKey, code: found.code, reason: found.reason });
      return;
    }
    const proj = buildNoteProjection(found.item);
    if (!proj.ok) {
      failures.push({ ordinal, laneKey: norm.laneKey, itemKey: norm.itemKey, code: proj.code, reason: proj.reason });
      return;
    }
    notes.push({ ordinal, laneKey: norm.laneKey, projection: proj.projection });
  });
  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, notes };
}

/**
 * 把 resolved notes 渲染成一条 model-facing reference 文本块。
 * 格式 = implementation discretion：
 *   简洁 "Referenced Notes" 头 + 每条 Note（authored / snapshot / locator 摘要）。
 * Notes 内容独立成块、不拼接进用户 prose；调用方保证该文本置于 direct user 之前。
 * @param {Array<{ordinal:number, laneKey:string, projection:object}>} notes
 * @returns {{ok:true, text:string} | {ok:false, code:string, reason:string}}
 */
export function renderReferenceText(notes) {
  if (!Array.isArray(notes) || notes.length === 0) {
    return { ok: false, code: "NO_NOTES", reason: "nothing to render" };
  }
  const blocks = [];
  blocks.push(`Referenced Notes (${notes.length})`);
  notes.forEach((n, index) => {
    const p = n.projection || {};
    const heading = `- Note ${index + 1}`;
    const lines = [heading];
    if (typeof p.authored === "string" && p.authored !== "") {
      lines.push("  Note content:");
      lines.push(p.authored.split("\n").map((l) => "    " + l).join("\n"));
    }
    if (p.type === "source-independent" && typeof p.carriedFromSession === "string" && p.carriedFromSession !== "") {
      lines.push(`  Carried from session: ${p.carriedFromSession}`);
    }
    if (p.type === "anchored" || p.type === "comment-free-anchored") {
      if (typeof p.snapshot === "string" && p.snapshot !== "") {
        lines.push("  Source selection:");
        lines.push(p.snapshot.split("\n").map((l) => "    " + l).join("\n"));
      }
      if (p.locator && typeof p.locator === "object") {
        // Current Source identity is {sessionId, messageId}; preserve the
        // historical locator rendering for legacy records without rewriting
        // or reinterpreting their event/extent coordinates.
        const anchor = typeof p.locator.messageId === "string" && p.locator.messageId.length > 0
          ? { sessionId: p.locator.sessionId, messageId: p.locator.messageId }
          : { sessionId: p.locator.sessionId, projectionVersion: p.locator.projectionVersion, segments: p.locator.segments };
        lines.push("  Source Anchor: " + JSON.stringify(anchor));
      }
    }
    blocks.push(lines.join("\n"));
  });
  return { ok: true, text: blocks.join("\n\n") };
}

/**
 * 注入消息的 plugin source metadata（kind plugin → client 归类
 * inject；Notes renderer 按 plugin+form 识别，不新增 role/event）。
 * @param {number} noteCount
 */
export function notesReferenceSource(noteCount) {
  return {
    kind: "plugin",
    plugin: "dsh-collab-notes",
    form: NOTES_REFERENCE_FORM,
    version: NOTES_REFERENCE_VERSION,
    noteCount,
  };
}

export const REFERENCE_FORM = NOTES_REFERENCE_FORM;
