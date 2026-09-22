// Carry merge empty-side elision tests（纯函数 + structured 保留）
import { carryRekeyWithKeys, composeCarryMerge } from "../lib/carry-merge.js";
import { getItemKey, makeItem, newItemKey, serializeItem, parseLaneBody, withItemKey } from "../lib/structured-item.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const HEADER = "## 来自父分支\n\n";
const SEP = "\n\n---\n\n## 当前分支已有内容\n\n";
const SID = "session-merge-src-0001";

function srcAwareBlock(comment = "") {
  return serializeItem(makeItem({
    kind: "source-aware", captureOrigin: SID, snapshot: "SOURCE-A", comment,
    sourcePayload: { projectionVersion: 1, sessionId: SID, segments: [{ eventSeq: 7, start: 0, end: 8 }] },
  }));
}

console.log("— carry merge: empty-side elision —");
{
  ok("M1 两侧都非空 → 既有确定性 wrapper 格式不变（parent-first）",
    composeCarryMerge("P", "C") === HEADER + "P" + SEP + "C");
  ok("M2 parent 语义空 + child 非空 → 只保留 child（无 来自父分支/当前分支 wrapper）",
    composeCarryMerge("", "child-content") === "child-content");
  ok("M2b parent 纯空白（\\n 空格）同视为空", composeCarryMerge("  \n", "child-content") === "child-content");
  ok("M3 child 语义空 + parent 非空 → 只保留 parent（无 wrapper）",
    composeCarryMerge("parent-content", "") === "parent-content");
  ok("M4 两侧都空 → truthful empty（不制造 wrapper/内容）", composeCarryMerge("", "") === "");
  ok("M5 两侧都空（空白）→ empty", composeCarryMerge("\n  \n", "  \n") === "");
  ok("M6 非空侧含多行/结构化字节原样保留（child 侧 source-aware block）",
    composeCarryMerge("", srcAwareBlock("child注")) === srcAwareBlock("child注"));
  ok("M7 非空侧 structured block 可 parse（origin/sourcePayload/snapshot 完好）",
    (() => {
      const out = composeCarryMerge("", srcAwareBlock("child注"));
      const items = parseLaneBody(out).nodes.filter((n) => n.type === "item" && n.item.kind === "source-aware");
      return items.length === 1 && items[0].item.captureOrigin === SID && items[0].item.snapshot === "SOURCE-A" &&
        items[0].item.sourcePayload && items[0].item.sourcePayload.sessionId === SID && items[0].item.comment === "child注";
    })());
  ok("M8 parent 侧 structured 保留（child 空）",
    composeCarryMerge(srcAwareBlock("父注"), "") === srcAwareBlock("父注"));
}


console.log("— fork/carry eligibility decision: carry re-key + keyless mint（carryRekeyWithKeys：child 不复制 parent holder-local item-key；keyless 也 mint）—");
{
  // parent item 带 key → carryRekeyWithKeys 换新 child-local key；其余字节不变
  const kP = newItemKey();
  const parentItem = withItemKey(makeItem({ kind: "source-independent", captureOrigin: SID, comment: "carry-me" }), kP);
  const parentText = serializeItem(parentItem);
  const rekeyed = carryRekeyWithKeys(parentText);
  const childKey = getItemKey(parseLaneBody(rekeyed.text).nodes[0].item);
  ok("P1 child key 存在且 != parent key（不复制）；keys 按序返回", typeof childKey === "string" && childKey !== kP && rekeyed.keys.length === 1 && rekeyed.keys[0] === childKey);
  ok("P2 parent 文本不变（re-key 不 mutate 入参）", parentText.includes(`dsh-meta item-key: ${kP}`));
  // parent 无 key → fork/carry eligibility decision：mint fresh child-local key（不再字节原样）
  const keyless = serializeItem(makeItem({ kind: "source-independent", captureOrigin: SID, comment: "old" }));
  const minted = carryRekeyWithKeys(keyless);
  ok("Source behavior：keyless → mint fresh key（非字节原样）",
    minted.keys.length === 1 && minted.text !== keyless &&
    typeof getItemKey(parseLaneBody(minted.text).nodes[0].item) === "string");
  // multi item + legacy 混合：structured item（含 keyless）都换/mint fresh key，legacy 原样
  const legacy = "旧段落文字";
  const kB = newItemKey();
  const keyedB = serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SID, comment: "B" }), kB));
  const mixed = legacy + "\n\n" + keyless + "\n\n" + keyedB;
  const mixedRes = carryRekeyWithKeys(mixed);
  const nodes = parseLaneBody(mixedRes.text).nodes;
  ok("behavior regression legacy 原样保留", nodes[0].type === "legacy" && nodes[0].text.trim() === legacy);
  const items = nodes.filter((n) => n.type === "item");
  ok("P5 keyless item mint fresh key", typeof getItemKey(items.find((n) => n.item.comment === "old")?.item) === "string");
  ok("P6 keyed item 换新 key（不复制 parent key）",
    typeof getItemKey(items.find((n) => n.item.comment === "B")?.item) === "string" &&
    getItemKey(items.find((n) => n.item.comment === "B")?.item) !== kB);
  // carry 两侧都非空 merge：parent 侧 re-key 后 wrapper 格式不变
  const merged = composeCarryMerge(carryRekeyWithKeys(parentText).text, serializeItem(parentItem));
  ok("P7 merge 后 parent 侧 key != 原始 parent key（child 侧同内容但不同 holder）", merged.includes("## 来自父分支"));
}
console.log("");
console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
