// dsh-collab-notes — Markdown visible-text projection（adapter-defined，deterministic）
//
// preserve visible-selection exactness——可从
// persisted event/content 重建的确定性 visible-text projection + source map。
//
// CommonMark 近似语义（v2）：
//   inline：`**`/`__`/`*`/`_` emphasis → 内容文本；`` ` `` code → 内容；
//           `[t](u)` link → t；`![a](u)` image → a；`~~t~~` strikethrough → t；
//           `<auto>` autolink → auto；`\x` escape → x
//   block：`#`/`##`… 标题 → 内容；`-`/`*`/`1.` 列表 → 内容（去 marker）；
//          `>` 引用 → 内容（去 >）；``` / ~~~ 代码块 → 内容；HR → 空
//   普通段落：行间保留 "\n"；块级后必有 "\n"；段落末尾视源尾 "\n"
//   sourceOffsets[i] = accepted visible projection 的第 i 码点对应的
//   source-bearing text-content offset（码点）；组合 projection 不把
//   renderer-only reasoning block 计入该 source stream。

/** 行级块结构检测。 */
const HR_RE = /^\s*(---+|\*\*\*+|___+)\s*$/;
const HEADER_RE = /^(#{1,6})(\s+)/;
const LIST_RE = /^\s*([-*]|\d+\.)(\s+)/;
const QUOTE_RE = /^(\s*)>\s?/;
const FENCE_RE = /^\s*(```|~~~)/;
const TABLE_DELIMITER_RE = /^:?-{3,}:?$/;
// autolink scheme（CommonMark）：`scheme:...`，scheme 以字母开头
const AUTOLINK_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** word 字符（intraword `_` 判定用）。 */
const isWordChar = (ch) => /[A-Za-z0-9]/.test(ch);

/** 递归 inline 嵌套深度上限（超限按字面输出，防病态输入爆栈）。 */
const MAX_INLINE_DEPTH = 32;

/** 单行 inline 解析 → visible 字符 + 源 offset（码点），返回 { chars, offsets }。
 * 栈式 delimiter 算法（CommonMark processEmphasis 近似，validation case：
 *   收集 `*`/`_` delimiter runs（flanking 判定 + intraword `_`），
 *   栈式配对（closer 从最近 opener 起，use_delims = 双方 ≥2 时 2 否则 1，
 *   rule-of-3 odd_match 跳过），消费字符跳过、剩余字面；
 *   code/link/autolink/strikethrough/escape 为文本块（不参与 emphasis 配对，
 *   link 文本递归解析）。 */
function parseInlineLine(line, baseOffset) {
  return parseInlineSegment([...line], 0, line.length ? [...line].length : 0, baseOffset, 0);
}

/**
 * Split a simple pipe-delimited table row while retaining source offsets.
 * Escaped pipes stay inside their cell and are handled by the inline projector.
 * Returning null keeps malformed/non-table lines on the ordinary Markdown path.
 */
function splitTableRow(line) {
  const chars = [...line];
  const pipes = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "|") continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && chars[j] === "\\"; j--) slashes++;
    if (slashes % 2 === 0) pipes.push(i);
  }
  if (pipes.length === 0) return null;
  const cells = [];
  let rowStart = 0;
  while (rowStart < chars.length && /\s/.test(chars[rowStart])) rowStart++;
  let rowEnd = chars.length;
  while (rowEnd > rowStart && /\s/.test(chars[rowEnd - 1])) rowEnd--;
  const rowPipes = pipes.filter((pipe) => pipe >= rowStart && pipe < rowEnd);
  if (rowPipes.length === 0) return null;
  const firstOuter = rowPipes[0] === rowStart;
  const lastOuter = rowPipes[rowPipes.length - 1] === rowEnd - 1;
  let start = firstOuter ? rowPipes[0] + 1 : rowStart;
  for (let i = firstOuter ? 1 : 0; i < rowPipes.length; i++) {
    let end = rowPipes[i];
    while (start < end && /\s/.test(chars[start])) start++;
    while (end > start && /\s/.test(chars[end - 1])) end--;
    cells.push({ text: chars.slice(start, end).join(""), start, end });
    start = rowPipes[i] + 1;
  }
  if (!lastOuter) {
    let end = rowEnd;
    while (start < end && /\s/.test(chars[start])) start++;
    while (end > start && /\s/.test(chars[end - 1])) end--;
    cells.push({ text: chars.slice(start, end).join(""), start, end });
  }
  return cells.length >= 2 ? cells : null;
}

function isTableDelimiter(cells) {
  return Array.isArray(cells) && cells.length >= 2 && cells.every((cell) => TABLE_DELIMITER_RE.test(cell.text));
}

function projectTableRow(line, lineStart) {
  const chars = [];
  const offsets = [];
  const cells = splitTableRow(line) || [];
  for (const cell of cells) {
    const projected = parseInlineLine(cell.text, lineStart + cell.start);
    chars.push(...projected.chars);
    offsets.push(...projected.offsets);
  }
  return { chars, offsets };
}

/** 区间 inline 解析：cps[start:end)（绝对码点索引）。 */
function parseInlineSegment(cps, start, end, baseOffset, depth) {
  const chars = [];
  const offsets = [];
  const n = end;
  const pushRange = (k0, k1) => { for (let q = k0; q < k1; q++) { chars.push(cps[q]); offsets.push(baseOffset + q); } };
  const pushInner = (k0, k1) => {
    if (depth >= MAX_INLINE_DEPTH) { pushRange(k0, k1); return; }
    const inner = parseInlineSegment(cps, k0, k1, baseOffset, depth + 1);
    for (let q = 0; q < inner.chars.length; q++) { chars.push(inner.chars[q]); offsets.push(inner.offsets[q]); }
  };

  // ---- 第一遍：收集 segments（run / 文本块），普通文本用 text 段记录 ----
  const segs = [];
  let i = start;
  while (i < n) {
    const c = cps[i];
    if (c === "\\" && i + 1 < n) { segs.push({ type: "esc", pos: i, ch: cps[i + 1] }); i += 2; continue; }
    if (c === "`") {
      let j = i + 1;
      while (j < n && cps[j] !== "`") j++;
      if (j < n) { segs.push({ type: "code", pos: i, len: j + 1 - i }); i = j + 1; continue; }
    }
    if (c === "[" || (c === "!" && i + 1 < n && cps[i + 1] === "[")) {
      const linkStart = c === "!" ? i + 1 : i;
      const closeBracket = findCloseBracket(cps, linkStart, n);
      if (closeBracket >= 0 && closeBracket < n) {
        const k0 = closeBracket + 1;
        if (k0 < n && cps[k0] === "(") {
          const closeParen = findCloseParen(cps, k0, n);
          if (closeParen > k0 && closeParen < n) {
            segs.push({ type: "link", linkStart, closeBracket, closeParen, img: c === "!" });
            i = closeParen + 1; continue;
          }
        }
      }
    }
    if (c === "~" && i + 1 < n && cps[i + 1] === "~") {
      const closeIdx = findCloser(cps, i + 2, "~~", n);
      if (closeIdx >= 0 && closeIdx < n) { segs.push({ type: "strike", pos: i, closeIdx }); i = closeIdx + 2; continue; }
    }
    if (c === "<") {
      const close = cps.indexOf(">", i + 1);
      if (close > i + 1 && close < n && !cps.slice(i + 1, close).includes(" ")) {
        const inner = cps.slice(i + 1, close).join("");
        if (AUTOLINK_RE.test(inner) || /^www\./i.test(inner) || /^[^\s@]+@[^\s@]+$/.test(inner)) {
          segs.push({ type: "auto", pos: i, close }); i = close + 1; continue;
        }
      }
    }
    if (c === "*" || c === "_") {
      let j = i;
      while (j < n && cps[j] === c) j++;
      const len = j - i;
      // intraword `_`：两侧紧邻 word 字符 → 字面（非 delimiter）
      if (c === "_" && i > start && j < n && isWordChar(cps[i - 1]) && isWordChar(cps[j])) {
        segs.push({ type: "run", ch: c, pos: i, len, orig: len, canOpen: false, canClose: false }); i = j; continue;
      }
      const canOpen = j < n && !/\s/.test(cps[j]); // left-flanking：右侧非空白
      const canClose = i > start && !/\s/.test(cps[i - 1]); // right-flanking：左侧非空白
      segs.push({ type: "run", ch: c, pos: i, len, orig: len, canOpen, canClose });
      i = j;
      continue;
    }
    // 普通文本：合并连续普通字符段
    let j = i;
    while (j < n && !"*_`\\[~<".includes(cps[j])) j++;
    if (j > i) { segs.push({ type: "text", pos: i, len: j - i }); i = j; continue; }
    // 无法识别的单个字符（如未闭合的 `[` 等）也作为文本
    segs.push({ type: "text", pos: i, len: 1 }); i++;
  }

  // ---- 第二遍：栈式配对（CommonMark processEmphasis 近似）----
  const runs = segs.filter((s) => s.type === "run");
  // 每个 run 记录 closeUsed（从左端消费）与 openUsed（从右端消费）
  for (const r of runs) { r.closeUsed = 0; r.openUsed = 0; }
  const stack = [];
  for (let idx = 0; idx < runs.length; idx++) {
    const closer = runs[idx];
    if (closer.canClose) {
      let si = stack.length - 1;
      while (si >= 0 && closer.len > 0) {
        const opener = stack[si];
        if (opener.ch !== closer.ch) { si--; continue; }
        // rule of 3（CommonMark odd_match）：用原始长度判定
        const oddMatch = (opener.canClose || closer.canOpen) &&
          (opener.orig + closer.orig) % 3 === 0 &&
          (opener.orig % 3 !== 0 || closer.orig % 3 !== 0);
        if (oddMatch) { si--; continue; }
        const use = (opener.len >= 2 && closer.len >= 2) ? 2 : 1;
        // opener 从右端消费（内容侧），closer 从左端消费（内容侧）
        opener.openUsed += use; opener.len -= use;
        closer.closeUsed += use; closer.len -= use;
        if (opener.len <= 0) { stack.splice(si, 1); si = Math.min(si, stack.length - 1); }
        // closer 剩余则继续当前 si（opener 可能仍有剩余可再配对）
      }
    }
    // 该 run 剩余若可作 opener，压栈（供更晚 closer 匹配）
    if (closer.len > 0 && closer.canOpen) stack.push(closer);
  }

  // ---- 第三遍：按源顺序输出 ----
  for (const s of segs) {
    if (s.type === "text") { pushRange(s.pos, s.pos + s.len); continue; }
    if (s.type === "run") {
      const leftSkip = s.closeUsed;   // 左端消费（closer 角色）
      const rightSkip = s.openUsed;   // 右端消费（opener 角色）
      if (s.closeUsed + s.openUsed >= s.orig) continue; // 全消费
      pushRange(s.pos + leftSkip, s.pos + s.orig - rightSkip);
      continue;
    }
    if (s.type === "esc") { chars.push(s.ch); offsets.push(baseOffset + s.pos + 1); continue; }
    if (s.type === "code") { pushRange(s.pos + 1, s.pos + s.len - 1); continue; }
    if (s.type === "auto") { pushRange(s.pos + 1, s.close); continue; }
    if (s.type === "strike") { pushInner(s.pos + 2, s.closeIdx); continue; }
    if (s.type === "link") { pushInner(s.linkStart + 1, s.closeBracket); continue; }
  }
  return { chars, offsets };
}

/**
 * Markdown → visible-text projection（含 source map）。
 * @param {string} md
 * @returns {{ visibleText: string, sourceOffsets: number[] }}
 */
export function projectVisibleMarkdown(md) {
  const lines = md.split("\n");
  // 行起始源偏移（码点）
  const lineOffsets = [];
  let acc = 0;
  for (const line of lines) { lineOffsets.push(acc); acc += [...line].length + 1; }
  const visible = [];
  const offsets = [];
  const pushChars = (chars, offs) => { for (let i = 0; i < chars.length; i++) { visible.push(chars[i]); offsets.push(offs[i]); } };

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    const lineStart = lineOffsets[idx];
    const lineLen = [...line].length;

    // GFM-style pipe table：renderer 的 table/textContent 不在 cell、row
    // 之间插入分隔符；Markdown renderer 会在 table 与相邻 block 之间保留
    // 一个真实的换行 text node。只识别有 delimiter row 的简单表格，其他
    // 含 pipe 的普通文本继续走原有路径。
    const tableHeader = splitTableRow(line);
    const tableDelimiter = idx + 1 < lines.length ? splitTableRow(lines[idx + 1]) : null;
    if (tableHeader && isTableDelimiter(tableDelimiter)) {
      let j = idx + 2;
      while (j < lines.length && splitTableRow(lines[j])) j++;
      for (let row = idx; row < j; row++) {
        if (row === idx + 1) continue; // delimiter row has no rendered cells
        const projectedRow = projectTableRow(lines[row], lineOffsets[row]);
        pushChars(projectedRow.chars, projectedRow.offsets);
      }
      // Block boundary newline is visible between the table wrapper and the
      // next Markdown block (or retained by the source when it ends in \n).
      if (j < lines.length || md.endsWith("\n")) {
        const lastRow = j - 1;
        visible.push("\n");
        offsets.push(lineOffsets[lastRow] + [...lines[lastRow]].length);
      }
      idx = j;
      continue;
    }

    // 代码块
    if (FENCE_RE.test(line)) {
      let content = [];
      let contentOffsets = [];
      let j = idx + 1;
      while (j < lines.length && !FENCE_RE.test(lines[j])) {
        const c = [...lines[j]];
        for (let k = 0; k < c.length; k++) { content.push(c[k]); contentOffsets.push(lineOffsets[j] + k); }
        if (j < lines.length - 1 || md.endsWith("\n")) { content.push("\n"); contentOffsets.push(lineOffsets[j] + c.length); }
        j++;
      }
      pushChars(content, contentOffsets);
      idx = j + 1; // 跳过闭合 fence
      continue;
    }

    // HR
    if (HR_RE.test(line)) { idx++; continue; }

    // 标题
    const h = HEADER_RE.exec(line);
    if (h) {
      const contentStart = h[0].length; // "# " 长度
      // 标题内容也经 inline 解析（剥 **/反引号/链接——此前直接 pushChars
      // 会保留标题内的行内标记，与 renderer 显示不一致 → DOM basis mismatch）
      const r = parseInlineLine(line.slice(contentStart), lineStart + contentStart);
      pushChars(r.chars, r.offsets);
      if (idx < lines.length - 1 || md.endsWith("\n")) { visible.push("\n"); offsets.push(lineStart + lineLen); }
      idx++;
      continue;
    }

    // 列表
    const li = LIST_RE.exec(line);
    if (li) {
      const contentStart = li[0].length;
      // 列表内容也经 inline 解析（剥 **/反引号/链接——renderer 显示正文时
      // 剥掉行内标记，投影须一致；此前直接 pushChars 保留 → basis mismatch）
      const r = parseInlineLine(line.slice(contentStart), lineStart + contentStart);
      pushChars(r.chars, r.offsets);
      if (idx < lines.length - 1 || md.endsWith("\n")) { visible.push("\n"); offsets.push(lineStart + lineLen); }
      idx++;
      continue;
    }

    // 空行：不产生 visible 输出（渲染时仅段落分隔）
    if (line.trim() === "") { idx++; continue; }
    // 引用行（可嵌套 >）
    let contentLine = line;
    let contentLineStart = lineStart;
    const qm = QUOTE_RE.exec(line);
    if (qm) {
      contentLine = line.slice(qm[0].length);
      contentLineStart = lineStart + [...qm[0]].length;
    }
    const r = parseInlineLine(contentLine, contentLineStart);
    pushChars(r.chars, r.offsets);
    // 行分隔 \n：块级行（标题/列表/引用）与普通段落统一——非最后一行，
    // 或源以 "\n" 结尾时输出；即 projection 尾 \n 当且仅当源尾 \n。
    if (idx < lines.length - 1 || md.endsWith("\n")) { visible.push("\n"); offsets.push(lineStart + lineLen); }
    idx++;
  }
  return { visibleText: visible.join(""), sourceOffsets: offsets };
}

function findCloser(cps, start, closer, end) {
  for (let i = start; i + closer.length <= end; i++) {
    let ok = true;
    for (let k = 0; k < closer.length; k++) if (cps[i + k] !== closer[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
function findCloseBracket(cps, start, end) {
  for (let i = start + 1; i < end; i++) if (cps[i] === "]") return i;
  return -1;
}
function findCloseParen(cps, start, end) {
  let depth = 0;
  for (let i = start + 1; i < end; i++) {
    if (cps[i] === "(") depth++;
    else if (cps[i] === ")") { if (depth === 0) return i; depth--; }
  }
  return -1;
}
