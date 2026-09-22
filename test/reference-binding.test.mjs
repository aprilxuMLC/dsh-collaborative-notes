// behavior regression reference binding core tests（node，纯逻辑，无 UI/HTTP）
// 覆盖 reference projection 的：Projection（source-independent / anchored / comment-free
// anchored / full snapshot / exact Source Anchor retained / itemKey 不进 model content）、
// Binding（multi-Note all-or-nothing / 无 silent drop / no-selection 空集）、
// Latest-at-submit（unchanged / edited same identity / deleted / unresolved）、
// 结构：same Note 多视图同 identity、distinct identical Notes 保持两个 target。
import {
  normalizeTarget,
  resolveItemByKey,
  buildNoteProjection,
  resolveBinding,
  renderReferenceText,
  notesReferenceSource,
  REFERENCE_FORM,
} from "../lib/reference-binding.js";
import { makeItem, serializeItem, withItemKey, newItemKey, getItemKey, parseLaneBody } from "../lib/structured-item.js";

let passed = 0, failed = 0;
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}

const SID = "session-p4e2-holder-0001";
const k1 = "ik-p4e2-0001", k2 = "ik-p4e2-0002", k3 = "ik-p4e2-0003", kDel = "ik-p4e2-del";

function sourceIndependent(text, key = newItemKey()) {
  return serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SID, comment: text }), key));
}
function anchored(text, snapshot, locator, key = newItemKey()) {
  return serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID, snapshot, comment: text, sourcePayload: locator }), key));
}
function anchoredCommentFree(snapshot, locator, key = newItemKey()) {
  return serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SID, snapshot, sourcePayload: locator }), key));
}
const loc = { projectionVersion: 2, sessionId: "session-src-0001", segments: [{ eventSeq: 41, start: 3, end: 23 }] };
const currentLoc = { sessionId: "session-src-0001", messageId: "msg-current-1" };

console.log("== normalizeTarget ==");
ok("合法 target 通过", normalizeTarget({ laneKey: "conversation_todo", itemKey: k1 }).ok === true);
ok("缺 itemKey → BAD_TARGET", normalizeTarget({ laneKey: "conversation_todo" }).ok === false);
ok("空对象 → BAD_TARGET", normalizeTarget(null).ok === false);

console.log("== resolveItemByKey（exact identity，不做首匹配/content rebind）==");
{
  const body = [sourceIndependent("A", k1), sourceIndependent("B", k2)].join("\n\n");
  const r = resolveItemByKey(body, k2);
  ok("按 itemKey 定位第二条 Note", r.ok === true && r.item && r.item.comment === "B", JSON.stringify(r.ok ? { comment: r.item.comment } : r));
  const r1 = resolveItemByKey(body, k1);
  ok("定位第一条 Note", r1.ok === true && r1.item.comment === "A");
  // 相同 content、不同 itemKey → 必须按 identity 区分（不 content rebind）
  const bodyDup = [sourceIndependent("SAME", k1), sourceIndependent("SAME", k2)].join("\n\n");
  const rd = resolveItemByKey(bodyDup, k2);
  ok("identical-content distinct Notes：按 itemKey 定位到 k2（不是首匹配）", rd.ok === true && getItemKey(rd.item) === k2);
  const rd1 = resolveItemByKey(bodyDup, k1);
  ok("identical-content：k1 也独立可定位", rd1.ok === true && getItemKey(rd1.item) === k1);
  ok("deleted/missing itemKey → UNRESOLVED", resolveItemByKey(body, kDel).ok === false);
  ok("keyless body（无结构 Note）→ UNRESOLVED", resolveItemByKey("plain legacy text", k1).ok === false);
  // Duplicate-key behavior regression：同 lane 重复 itemKey → AMBIGUOUS（绝不 first-match rebind）
  const bodyDupKey = [sourceIndependent("A1", k1), sourceIndependent("A2", k1)].join("\n\n");
  const dup = resolveItemByKey(bodyDupKey, k1);
  ok("重复 itemKey → AMBIGUOUS（拒绝 first-match）", dup.ok === false && dup.code === "AMBIGUOUS", JSON.stringify(dup));
  const bodyDupKeyWithOther = [sourceIndependent("A1", k1), sourceIndependent("B", k2), sourceIndependent("A2", k1)].join("\n\n");
  const dup2 = resolveItemByKey(bodyDupKeyWithOther, k1);
  ok("重复 itemKey（被其它 key 隔开）→ 仍 AMBIGUOUS", dup2.ok === false && dup2.code === "AMBIGUOUS");
  const single2 = resolveItemByKey(bodyDupKeyWithOther, k2);
  ok("同 body 中唯一 key 仍可精确定位", single2.ok === true && getItemKey(single2.item) === k2);
}

console.log("== buildNoteProjection（按类型）==");
{
  const si = makeItem({ kind: "source-independent", captureOrigin: SID, comment: "请记得处理 X" });
  const p = buildNoteProjection(si);
  ok("source-independent → {type, authored}", p.ok === true && p.projection.type === "source-independent" && p.projection.authored === "请记得处理 X", JSON.stringify(p.projection));
  ok("source-independent 无 snapshot/locator 字段", p.ok === true && p.projection.snapshot === undefined && p.projection.locator === undefined);

  const aw = makeItem({ kind: "source-aware", captureOrigin: SID, snapshot: "定理：THEOREM-EXCERPT 成立。", comment: "请解释", sourcePayload: loc });
  const pa = buildNoteProjection(aw);
  ok("anchored+comment → {type:anchored, authored, snapshot, locator}", pa.ok === true && pa.projection.type === "anchored" && pa.projection.authored === "请解释" && pa.projection.snapshot === "定理：THEOREM-EXCERPT 成立。" && pa.projection.locator === loc, JSON.stringify(pa.projection));

  const cf = makeItem({ kind: "source-aware", captureOrigin: SID, snapshot: "SNIP", sourcePayload: loc });
  const pc = buildNoteProjection(cf);
  ok("comment-free anchored → {type:comment-free-anchored, snapshot, locator}（无 authored 字段）", pc.ok === true && pc.projection.type === "comment-free-anchored" && pc.projection.authored === undefined && pc.projection.snapshot === "SNIP", JSON.stringify(pc.projection));

  // snapshot = persisted FULL accepted selected-text（不是截断 preview）——引擎不截断
  const longSnap = "X".repeat(5000);
  const pl = buildNoteProjection(makeItem({ kind: "source-aware", captureOrigin: SID, snapshot: longSnap, sourcePayload: loc }));
  ok("full persisted snapshot 不被引擎截断（5000 chars intact）", pl.ok === true && pl.projection.snapshot.length === 5000);

  // 无 sourcePayload 的 anchored → NO_LOCATOR（数据异常，truthful）
  const bad = buildNoteProjection(makeItem({ kind: "source-aware", captureOrigin: SID, snapshot: "S" }));
  ok("anchored 无 locator → NO_LOCATOR", bad.ok === false && bad.code === "NO_LOCATOR");
}

console.log("== resolveBinding（all-or-nothing / multi-Note / 空集）==");
{
  const L1 = [sourceIndependent("A", k1), anchoredCommentFree("SNIP-A", loc, k2)].join("\n\n");
  const L3 = [sourceIndependent("C", k3)].join("\n\n");
  const bodies = { conversation_todo: L1, knowledge_candidate: L3 };
  const all = resolveBinding(bodies, [
    { laneKey: "conversation_todo", itemKey: k1 },
    { laneKey: "conversation_todo", itemKey: k2 },
    { laneKey: "knowledge_candidate", itemKey: k3 },
  ]);
  ok("3 targets 全 resolve → ok, notes=3", all.ok === true && all.notes.length === 3, JSON.stringify(all.ok ? all.notes.length : all.failures));
  ok("ordinal 保持选择序", all.ok === true && all.notes.map((n) => n.ordinal).join(",") === "0,1,2");
  ok("laneKey 各自正确", all.ok === true && all.notes.map((n) => n.laneKey).join(",") === "conversation_todo,conversation_todo,knowledge_candidate");
  ok("投影类型正确", all.ok === true && all.notes.map((n) => n.projection.type).join(",") === "source-independent,comment-free-anchored,source-independent");

  // 一个 deleted → 整体失败 + 失败项报告（不 silent drop、不 subset）
  const oneMissing = resolveBinding(bodies, [
    { laneKey: "conversation_todo", itemKey: k1 },
    { laneKey: "conversation_todo", itemKey: kDel },
  ]);
  ok("任一 deleted → ok:false + failures 含 UNRESOLVED", oneMissing.ok === false && oneMissing.failures.length === 1 && oneMissing.failures[0].code === "UNRESOLVED", JSON.stringify(oneMissing.failures));
  ok("失败时 notes 为空（无部分成功）", oneMissing.ok === false && oneMissing.notes === undefined);

  // Duplicate-key behavior regression：重复 key → all-or-nothing AMBIGUOUS（不 first-match、不 subset）
  const L1dup = [sourceIndependent("A1", k1), sourceIndependent("A2", k1)].join("\n\n");
  const dupSel = resolveBinding({ conversation_todo: L1dup }, [{ laneKey: "conversation_todo", itemKey: k1 }]);
  ok("重复 key target → ok:false + failures 含 AMBIGUOUS", dupSel.ok === false && dupSel.failures.length === 1 && dupSel.failures[0].code === "AMBIGUOUS", JSON.stringify(dupSel.failures));
  ok("重复 key 失败时 notes 为空（无部分成功）", dupSel.ok === false && dupSel.notes === undefined);
  // multi-target 中一个重复 key → 整体失败（all-or-nothing）
  const dupMixed = resolveBinding({ conversation_todo: L1dup }, [
    { laneKey: "conversation_todo", itemKey: k1 },
    { laneKey: "conversation_todo", itemKey: "k-unique-ok" },
  ].map((t) => t.itemKey === "k-unique-ok" ? { laneKey: "conversation_todo", itemKey: k2 } : t));
  ok("multi-target 含重复 key → 整体失败 + AMBIGUOUS（无 silent subset）", dupMixed.ok === false && dupMixed.failures.some((f) => f.code === "AMBIGUOUS") && dupMixed.notes === undefined, JSON.stringify(dupMixed.failures));

  // edited same identity：body 用同一 itemKey 但新内容 → 用当前（最新）内容
  const L1edited = [sourceIndependent("A-EDITED", k1)].join("\n\n");
  const edited = resolveBinding({ conversation_todo: L1edited }, [{ laneKey: "conversation_todo", itemKey: k1 }]);
  ok("edited same identity → 用当前最新内容（A-EDITED）", edited.ok === true && edited.notes[0].projection.authored === "A-EDITED");

  // lane 内容不可用 → truthful failure
  const noLane = resolveBinding({}, [{ laneKey: "conversation_todo", itemKey: k1 }]);
  ok("lane body 缺失 → LANE_UNAVAILABLE failure", noLane.ok === false && noLane.failures[0].code === "LANE_UNAVAILABLE");

  // 空选择 → NO_TARGETS failure（no-selection 不产生任何绑定）
  const emptySel = resolveBinding(bodies, []);
  ok("空选择 → NO_TARGETS（no-selection 路径不绑定）", emptySel.ok === false && emptySel.failures[0].code === "NO_TARGETS");
}

console.log("== renderReferenceText（reference→data、不含簿记）==");
{
  const si = resolveBinding({ conversation_todo: sourceIndependent("A", k1) }, [{ laneKey: "conversation_todo", itemKey: k1 }]);
  const t1 = renderReferenceText(si.notes);
  ok("source-independent 渲染：Referenced Notes 头 + Note content", t1.ok === true && t1.text.includes("Referenced Notes (1)") && t1.text.includes("A"));
  ok("渲染不含 itemKey（k1 不出现）", t1.ok === true && !t1.text.includes(k1) && !t1.text.includes("item-key"));
  ok("渲染不含 captureOrigin", t1.ok === true && !t1.text.includes(SID));

  const aw = resolveBinding({ conversation_todo: anchored("请解释", "定理：THEOREM 成立。", loc, k2) }, [{ laneKey: "conversation_todo", itemKey: k2 }]);
  const t2 = renderReferenceText(aw.notes);
  ok("anchored 渲染含 authored + Source selection + Source Anchor", t2.ok === true && t2.text.includes("请解释") && t2.text.includes("定理：THEOREM 成立。") && t2.text.includes("Source Anchor") && t2.text.includes("session-src-0001") && t2.text.includes('"eventSeq":41'));
  ok("anchored 渲染无机器簿记（无 Pin/viewDir/search 字样）", t2.ok === true && !/Pin|viewDir|search/i.test(t2.text));

  // Current Source identity：rendering must carry the exact persisted
  // {sessionId,messageId}; it must not derive or search an identity from S.
  const currentAnchored = resolveBinding(
    { conversation_todo: anchored("请解释 current", "FULL-CURRENT-S", currentLoc, k2) },
    [{ laneKey: "conversation_todo", itemKey: k2 }]
  );
  const currentText = renderReferenceText(currentAnchored.notes);
  ok("current anchored：authored + full S + sessionId + messageId", currentText.ok === true
    && currentText.text.includes("请解释 current")
    && currentText.text.includes("FULL-CURRENT-S")
    && currentText.text.includes('"sessionId":"session-src-0001"')
    && currentText.text.includes('"messageId":"msg-current-1"'));
  ok("current anchored：不退回 legacy projectionVersion/segments", currentText.ok === true
    && !currentText.text.includes("projectionVersion")
    && !currentText.text.includes("segments")
    && !currentText.text.includes("eventSeq"));

  const currentCommentFree = resolveBinding(
    { conversation_todo: anchoredCommentFree("FULL-COMMENT-FREE-S", currentLoc, k2) },
    [{ laneKey: "conversation_todo", itemKey: k2 }]
  );
  const currentCommentFreeText = renderReferenceText(currentCommentFree.notes);
  ok("current comment-free anchored：无 fabricated authored content", currentCommentFreeText.ok === true
    && !currentCommentFreeText.text.includes("Note content")
    && !currentCommentFreeText.text.includes("undefined"));
  ok("current comment-free anchored：full S + exact sessionId/messageId", currentCommentFreeText.ok === true
    && currentCommentFreeText.text.includes("FULL-COMMENT-FREE-S")
    && currentCommentFreeText.text.includes('"sessionId":"session-src-0001"')
    && currentCommentFreeText.text.includes('"messageId":"msg-current-1"'));

  const mixed = resolveBinding(
    { conversation_todo: [anchored("CURRENT-AUTHORED", "CURRENT-S", currentLoc, k1), sourceIndependent("PLAIN-NOTE", k2)].join("\n\n") },
    [{ laneKey: "conversation_todo", itemKey: k1 }, { laneKey: "conversation_todo", itemKey: k2 }]
  );
  const mixedText = renderReferenceText(mixed.notes);
  ok("current anchored + source-independent：各自独立渲染", mixedText.ok === true
    && mixedText.text.includes("CURRENT-AUTHORED")
    && mixedText.text.includes("CURRENT-S")
    && mixedText.text.includes("PLAIN-NOTE")
    && mixedText.text.includes('"messageId":"msg-current-1"'));

  // 多 Note 渲染（区分 Note 1 / Note 2）
  const multi = resolveBinding(
    { conversation_todo: [sourceIndependent("A", k1), sourceIndependent("B", k2)].join("\n\n") },
    [{ laneKey: "conversation_todo", itemKey: k1 }, { laneKey: "conversation_todo", itemKey: k2 }]
  );
  const t3 = renderReferenceText(multi.notes);
  ok("多 Note 渲染 Note 1 / Note 2（temporary ordinal，非身份）", t3.ok === true && t3.text.includes("- Note 1") && t3.text.includes("- Note 2"));
}

console.log("== notesReferenceSource / 无选区 ==");
{
  const src = notesReferenceSource(2);
  ok("plugin source：kind plugin + plugin dsh-collab-notes + form notes-reference", src.kind === "plugin" && src.plugin === "dsh-collab-notes" && src.form === REFERENCE_FORM && src.noteCount === 2);
  const src1 = notesReferenceSource(1);
  ok("noteCount 随绑定数（truthful：N 条即报 N）", src1.noteCount === 1);
}

console.log("\n结果：behavior regression reference-binding core " + passed + " 通过 / " + failed + " 失败");
process.exit(failed === 0 ? 0 : 1);
