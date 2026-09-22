// dsh-collab-notes — structured Note item representation
// Source-aware / source-independent self-contained item blocks inside lane Markdown.
//
// The format is length-delimited in Unicode code points. It preserves empty and
// trailing-newline payloads, metadata order, opaque metadata, and sourcePayload.
//
// Encoding grammar (v1.1):
//   --- dsh-note v1 begin
//   dsh-meta kind: source-independent | source-aware
//   dsh-meta origin: <sessionId>
//   [source-independent] dsh-meta body-length: <N>
//   [source-aware]      dsh-meta snapshot-length: <N1>
//   [source-aware]      dsh-meta comment-length: <N2>   ; optional
//   [dsh-meta <unknown>: ...]*                          ; opaque ordered verbatim
//   --- dsh-body
//   <payload rows: payload.split("\n") — exactly N / N1+N2 code points total>
//   --- dsh-note v1 end
//
// Length unit: Unicode code points. Payload is a row sequence; each row is one
// line in the file; join("\n") must equal the declared code-point count, so
// empty payload → zero rows, trailing newline → trailing blank row, consecutive
// trailing blank lines → that many blank rows. Malformed/invalid candidate →
// whole block kept as one opaque raw legacy node (never a partial valid item).

import { isValidSourcePayload, SUPPORTED_PROJECTION_VERSIONS } from "./source-locator.js";

export const BEGIN_LINE = "--- dsh-note v1 begin";
export const END_LINE = "--- dsh-note v1 end";
export const BODY_LINE = "--- dsh-body";
export const META_PREFIX = "dsh-meta ";
export const REPRESENTATION_VERSION = 1;

export const KIND_SOURCE_AWARE = "source-aware";
export const KIND_SOURCE_INDEPENDENT = "source-independent";

/** Ordinary source-independent authored content must be substantive. */
export function hasSubstantiveAuthoredContent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Session-shaped identity is validated without inventing a new identity format.
const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

const KNOWN_META = new Set(["kind", "origin", "body-length", "snapshot-length", "comment-length", "source-payload"]);

/** Number of Unicode code points in a string. */
const cps = (s) => [...s].length;
/** Slice by code points. */
const sliceCps = (s, start, end) => [...s].slice(start, end).join("");

/**
 * Parse a lane Markdown body into an ordered node list.
 * Nodes: { type: "legacy", text } | { type: "item", item, raw }
 * Malformed structured candidates stay as one opaque raw legacy node.
 */
export function parseLaneBody(text) {
  const lines = text.split("\n");
  const nodes = [];
  let i = 0;
  let legacyBuf = [];

  const flushLegacy = () => {
    if (legacyBuf.length > 0) {
      const t = legacyBuf.join("\n");
      if (t.length > 0) nodes.push({ type: "legacy", text: t });
      legacyBuf = [];
    }
  };

  while (i < lines.length) {
    if (lines[i] === BEGIN_LINE) {
      const parsed = parseItemAt(lines, i);
      if (parsed) {
        flushLegacy();
        nodes.push({ type: "item", item: parsed.item, raw: parsed.lines.join("\n") });
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
  return { nodes, trailingNewline: text.endsWith("\n") };
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
  const metaOrder = []; // 原始顺序：known（按 key 引用）+ raw unknown 行
  let sourcePayloadParsed; // source-payload 解析值（JSON object）
  let i = start + 1;

  // ---- metadata lines（保留原始顺序 known/unknown 交错）----
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith(META_PREFIX)) break;
    const rawValue = line.slice(META_PREFIX.length);
    const eq = rawValue.indexOf(":");
    const key = eq > 0 ? rawValue.slice(0, eq).trim() : rawValue.trim();
    const value = eq > 0 ? rawValue.slice(eq + 1).trim() : "";
    if (KNOWN_META.has(key)) {
      // duplicate reserved metadata → invalid
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
        // durable source payload：JSON.parse + locator schema 验证。
        // 当前 projection version 必须是合法 locator（R5）；future/unsupported
        // version 或 invalid → raw 保守保留（不按当前 projection 重解释，不使整块 malformed）。
        let parsed = null;
        try { parsed = JSON.parse(value); } catch { parsed = null; }
        const valid = parsed !== null && typeof parsed === "object" && isValidSourcePayload(parsed);
        if (valid && sourcePayloadParsed === undefined) {
          sourcePayloadParsed = parsed;
          metaOrder.push({ kind: "known", key: "source-payload" });
        } else {
          metaOrder.push({ kind: "raw", raw: line }); // invalid/future/duplicate → raw 保守
        }
        itemLines.push(line);
        i++;
        continue;
      }
      metaOrder.push({ kind: "known", key });
    } else {
      metaOrder.push({ kind: "raw", raw: line });
    }
    itemLines.push(line);
    i++;
  }

  // ---- validity ----
  if (kind !== KIND_SOURCE_AWARE && kind !== KIND_SOURCE_INDEPENDENT) return null;
  if (typeof origin !== "string" || !SESSION_ID_RE.test(origin)) return null;
  const num = (s) => (s === null ? null : /^\d+$/.test(s) ? Number(s) : null);
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

  // ---- body line ----
  if (lines[i] !== BODY_LINE) return null;
  itemLines.push(lines[i]);
  i++;

  // ---- payload rows: exact code-point accounting ----
  // payload = rows.join("\n"); rows.length - 1 = payload 中 \n 数。
  // 空 payload → 0 行；尾 \n → 结尾空行。
  const rows = [];
  let acc = 0; // join("\n") 累计码点
  let j = i;
  while (true) {
    if (acc === payloadLength) break;
    if (j >= lines.length) return null; // 行不足（payload 未完成）
    // 注意：不检查 END_LINE——length-delimited 下任何行都是内容（R1 collision-free）
    const take = sliceCps(lines[j], 0, payloadLength - acc);
    rows.push(take);
    acc = rows.length === 1 ? cps(take) : acc + 1 + cps(take);
    if (acc === payloadLength) {
      const rest = sliceCps(lines[j], cps(take), Infinity);
      if (rest.length > 0) return null; // payload 在行中结束且行有剩余
      break;
    }
    if (acc > payloadLength) return null; // 行间 \n 超出声明
    j++;
  }
  const payload = rows.join("\n");
  // 空 payload（0 行）时 j 未消费任何行 → 下一行即 END_LINE（j 指向 BODY_LINE 后第一行）；
  // 非空时 j 指向最后消费行 → 其下一行为 END_LINE。
  const afterPayloadIndex = rows.length === 0 ? j : j + 1;
  if (lines[afterPayloadIndex] !== END_LINE) return null;
  itemLines.push(lines[afterPayloadIndex]);

  // ---- semantic split ----
  const unknownMetaView = metaOrder.filter((m) => m.kind === "raw").map((m) => ({ raw: m.raw }));
  let item;
  if (kind === KIND_SOURCE_INDEPENDENT) {
    item = { kind, captureOrigin: origin, comment: payload, metaOrder, unknownMeta: unknownMetaView };
    if (sourcePayloadParsed !== undefined) item.sourcePayload = sourcePayloadParsed;
  } else {
    const snapshot = sliceCps(payload, 0, snapshotLength);
    const comment = sliceCps(payload, snapshotLength, snapshotLength + commentLength);
    item = {
      kind,
      captureOrigin: origin,
      snapshot,
      ...(comment.length > 0 ? { comment } : {}),
      metaOrder,
      unknownMeta: unknownMetaView,
    };
    if (sourcePayloadParsed !== undefined) item.sourcePayload = sourcePayloadParsed;
  }
  return { item, lines: itemLines, nextIndex: afterPayloadIndex + 1 };
}

/** 按原始顺序重建 metadata 行（known 用当前值，unknown 用 raw）。 */
function buildMetaLines(item) {
  const out = [];
  const order = item.metaOrder;
  if (!order || order.length === 0) {
    // 默认顺序（makeItem 产物）：kind, origin, 长度, unknownMeta
    out.push(`${META_PREFIX}kind: ${item.kind}`);
    out.push(`${META_PREFIX}origin: ${item.captureOrigin}`);
    if (item.kind === KIND_SOURCE_AWARE) {
      const snap = item.snapshot ?? "";
      out.push(`${META_PREFIX}snapshot-length: ${cps(snap)}`);
      if ((item.comment ?? "").length > 0) out.push(`${META_PREFIX}comment-length: ${cps(item.comment)}`);
    } else {
      out.push(`${META_PREFIX}body-length: ${cps(item.comment ?? "")}`);
    }
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
    if (m.kind === "raw") { out.push(m.raw); continue; }
    const v = valueOf(m.key);
    if (v === undefined) continue; // 该 known 字段在 item 中不再适用（防御）
    out.push(`${META_PREFIX}${m.key}: ${v}`);
  }
  return out;
}

/**
 * Serialize a node list back to lane Markdown preserving order, legacy text,
 * metadata row order, and payload exactly.
 */
export function serializeLaneBody(parsed) {
  const parts = [];
  for (const node of parsed.nodes) {
    if (node.type === "legacy") { parts.push(node.text); continue; }
    parts.push(serializeItem(node.item));
  }
  let out = parts.join("\n");
  if (parsed.trailingNewline && !out.endsWith("\n")) out += "\n";
  return out;
}

/** 根据 item 当前状态修正 metaOrder：新增非空 comment 时插入 comment-length；
 *  comment 变空时移除 comment-length（否则声明长度与 payload 不匹配 → 再解析变 opaque legacy）。
 *  返回修正后的 metaOrder（不 mutate 输入 item）。 */
function normalizeMetaOrder(item) {
  const order = item.metaOrder ? item.metaOrder.map((m) => ({ ...m })) : null;
  if (item.kind !== KIND_SOURCE_AWARE) return order;
  const hasComment = (item.comment ?? "").length > 0;
  if (!order) return order; // makeItem 产物走默认顺序（已正确）
  const idx = (k) => order.findIndex((m) => m.kind === "known" && m.key === k);
  const commentIdx = idx("comment-length");
  if (hasComment && commentIdx === -1) {
    const snapIdx = idx("snapshot-length");
    if (snapIdx >= 0) order.splice(snapIdx + 1, 0, { kind: "known", key: "comment-length" });
    else order.push({ kind: "known", key: "comment-length" });
  } else if (!hasComment && commentIdx >= 0) {
    order.splice(commentIdx, 1);
  }
  return order;
}

/** Serialize one structured item back to its block text. */
export function serializeItem(item) {
  const meta = { ...item, metaOrder: normalizeMetaOrder(item) };
  const lines = [BEGIN_LINE, ...buildMetaLines(meta), BODY_LINE];
  // payload rows: payload === "" → 0 rows；否则 split("\n")
  const payload = item.kind === KIND_SOURCE_AWARE
    ? (item.snapshot ?? "") + (item.comment ?? "")
    : (item.comment ?? "");
  const rows = payload === "" ? [] : payload.split("\n");
  for (const r of rows) lines.push(r);
  lines.push(END_LINE);
  return lines.join("\n");
}

/** Build one structured item. Invalid combinations reject loudly (throw). */
export function makeItem({ kind, captureOrigin, snapshot, comment, sourcePayload, unknownMeta = [] }) {
  if (kind !== KIND_SOURCE_AWARE && kind !== KIND_SOURCE_INDEPENDENT) {
    throw new Error(`makeItem: invalid kind "${kind}"`);
  }
  if (typeof captureOrigin !== "string" || !SESSION_ID_RE.test(captureOrigin)) {
    throw new Error(`makeItem: invalid captureOrigin "${captureOrigin}"`);
  }
  const item = { kind, captureOrigin, unknownMeta: [...unknownMeta] };
  if (kind === KIND_SOURCE_AWARE) {
    if (snapshot === undefined) throw new Error("makeItem: source-aware requires snapshot");
    if (typeof snapshot !== "string") throw new Error("makeItem: snapshot must be a string");
    item.snapshot = snapshot;
    if (comment !== undefined) {
      if (typeof comment !== "string") throw new Error("makeItem: comment must be a string");
      item.comment = comment;
    }
    if (sourcePayload !== undefined) {
      // Source payload may be the new stable identity or a legacy locator.
      // Unsupported/invalid payloads are rejected at construction; parsing
      // keeps malformed/future rows opaque so old bytes are not reinterpreted.
      if (sourcePayload === null || typeof sourcePayload !== "object" || Array.isArray(sourcePayload)) {
        throw new Error("makeItem: sourcePayload must be a locator object");
      }
      const opaqueFutureLocator = typeof sourcePayload.projectionVersion === "number"
        && Number.isInteger(sourcePayload.projectionVersion)
        && sourcePayload.projectionVersion > 2
        && typeof sourcePayload.sessionId === "string"
        && Array.isArray(sourcePayload.segments);
      if (!isValidSourcePayload(sourcePayload) && !opaqueFutureLocator) {
        throw new Error("makeItem: sourcePayload must be a valid message identity or legacy locator");
      }
      item.sourcePayload = sourcePayload;
    }
  } else {
    if (snapshot !== undefined) throw new Error("makeItem: source-independent cannot carry snapshot");
    if (sourcePayload !== undefined) throw new Error("makeItem: source-independent cannot carry sourcePayload");
    if (comment !== undefined) item.comment = comment;
  }
  return item;
}

/** Convenience: raw unknown metadata record helper. */
export const unknownMeta = (raw) => ({ raw });

// Holder-local item key（opaque unknown-meta row）
//
// item-key 是 same-file self-contained adapter bookkeeping：以一条 opaque
// unknown-meta 行（`dsh-meta item-key: <token>`）存在 structured block 内。
// 选 unknown 而非 known 的理由：
//   1. 对 Notes behavior parser/serializer 零语义变更——unknown 行本就被字节级 round-trip
//      保留（既有多处测试覆盖），旧 lane（无 item-key）parse→serialize 字节不变；
//   2. 对 agent-facing Notes 模型保持 inert：parser 不解释该行，Notes 语义不因它
//      改变（E6 边界：pinned=true 语义绝不进 lane；item-key 只是 identity 锚）。
//   3. duplicate/validate/duplicate-known 规则完全不受影响。
// item-key 不代表 pinned/priority/execution/provenance/order——只回答“未来如何
// 再次指向当前 holder 中这条 item”。
export const ITEM_KEY_META = "item-key";

// Historical keys are opaque durable values: their only canonical invariant is
// that the normalized value is non-empty.  The stricter shape below is only a
// generator invariant for fresh keys; it must never invalidate old keys.
const GENERATED_ITEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidItemKey(value) {
  return typeof value === "string" && value.length > 0;
}

export function isValidGeneratedItemKey(value) {
  return typeof value === "string" && GENERATED_ITEM_KEY_RE.test(value);
}

/**
 * Inspect all canonical item-key rows on one parsed item.  The parser keeps
 * unknown metadata verbatim, so this must count rows instead of delegating to
 * a first-match getter.  The result is intentionally ephemeral: it is only
 * the addressability decision for the current lane observation.
 */
export function inspectItemKey(item) {
  const rows = [];
  for (const record of item?.unknownMeta ?? []) {
    const raw = typeof record === "string" ? record : record?.raw;
    if (typeof raw !== "string" || !raw.startsWith(`${META_PREFIX}${ITEM_KEY_META}:`)) continue;
    rows.push(raw.slice(`${META_PREFIX}${ITEM_KEY_META}:`.length).trim());
  }
  if (rows.length === 0) return { status: "missing" };
  if (rows.length !== 1) return { status: "duplicate", values: rows };
  if (!isValidItemKey(rows[0])) return { status: "malformed", value: rows[0] };
  return { status: "valid", key: rows[0] };
}

/** 生成一条 fresh holder-local item key（同 holder 内唯一即可；无 global 语义）。 */
export function newItemKey() {
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return "ik-" + Date.now().toString(36) + "-" + rnd() + rnd();
}

/**
 * 读 item 的 holder-local item key（unknown-meta raw 行 `dsh-meta item-key: <v>`）。
 * 返回 token 或 undefined。不解析内容、不赋予语义。
 */
export function getItemKey(item) {
  const inspected = inspectItemKey(item);
  return inspected.status === "valid" ? inspected.key : undefined;
}

/**
 * 返回一个带 itemKey 的新 item 对象（不 mutate 入参；缺失则新增一条 unknown-meta
 * raw 行，已存在则替换值）。其余字段/metaOrder/unknownMeta 原样保留。
 *
 * 注意两条序列化路径：
 *   - makeItem 产物无 metaOrder → serializeItem 走默认顺序，unknownMeta 直接落盘；
 *   - parse 产物带 metaOrder（raw 行逐条 verbatim）→ serializeItem 从 metaOrder 重建。
 * 因此这里必须同时维护 unknownMeta 与（若存在）metaOrder 的 raw 条目，否则 parsed
 * item 上新增的 key 行会被 serializer 丢掉。
 */
export function withItemKey(item, key) {
  const prefix = META_PREFIX + ITEM_KEY_META + ": ";
  const row = prefix + key;
  const isKeyRaw = (r) => {
    const raw = typeof r === "string" ? r : r?.raw;
    return typeof raw === "string" && raw.startsWith(prefix);
  };
  const next = { ...item };
  // unknownMeta 视图：替换第一条匹配或追加
  const existing = item?.unknownMeta ?? [];
  const has = existing.some(isKeyRaw);
  next.unknownMeta = has
    ? existing.map((r) => (isKeyRaw(r) ? { raw: row } : r))
    : [...existing, { raw: row }];
  // metaOrder（仅 parse 产物存在）：同步 raw 条目
  if (Array.isArray(item?.metaOrder)) {
    const orderHas = item.metaOrder.some((m) => m && m.kind === "raw" && isKeyRaw(m.raw));
    next.metaOrder = orderHas
      ? item.metaOrder.map((m) =>
          m && m.kind === "raw" && isKeyRaw(m.raw) ? { kind: "raw", raw: row } : m
        )
      : [...item.metaOrder, { kind: "raw", raw: row }];
  }
  return next;
}
