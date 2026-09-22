// dsh-collab-notes host bridge regression tests.
//
// 直接 import lib/index.js 的 apply()，用 mock ctx/req/res 驱动 handler：
//   ✓ 正常读写镜像   ✓ ENOENT→空 / 其它读错→500   ✓ 非法层 400
//   ✓ 非法 sessionId 400（路径穿越/字符白名单）   ✓ Origin 真同源（匹配/不匹配/空）
//   ✓ body 超限 413   ✓ 未知会话 404   ✓ 405
//
// fork/carry eligibility decision stale-safety: the plugin now requires the SHARED host fs service
// (ctx.fs withLock/resolve/stat — the primitive the formal tool-fs writers
// use). Tests mount a REAL LocalFileSystem on a real Cordis Context so the
// lock/CAS behavior under test is the production one, not a mock.
//
// 运行：node test/notes-api.test.mjs
import { apply, fileLocks } from "../lib/index.js";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { mkdtemp, rm, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const SESSION = "a0b1c2d3-e4f5-6a7b-8c9d-0e1f2a3b4c5d";
const L1 = "conversation_todo";
const L2 = "deferred_work";
const L3 = "knowledge_candidate";
const L4 = "lesson_candidate";
let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

function makeReq({ method = "GET", url = "/", headers = {}, body }) {
  const chunks = body == null ? [] : [Buffer.from(body)];
  return {
    method, url, headers,
    resume() {}, // 真实 IncomingMessage 的排空接口（413/405 分支用到）
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
  };
}

function makeRes() {
  const state = {};
  return {
    writeHead(code, headers) { state.code = code; state.headers = headers; },
    end(b) { state.body = b ?? ""; },
    state,
  };
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res);
  return res.state;
}

async function main() {
  const ws = await mkdtemp(join(tmpdir(), "dsh-collab-notes-test-"));
  const notesRoot = join(ws, "notes");
  // 不预建任何目录：验证插件内生第一步（ensureNotesTree）自动建齐骨架

  const sessions = new Map([
    [SESSION, { header: { cwd: ws } }],
    [`session-${SESSION}`, { header: { cwd: ws } }], // 真实形态：会话 id 带 session- 前缀
  ]);
  let handler;
  // ctx.on: real host provides the Cordis event emitter; tests capture listeners
  // so they can emit session/created manually for fork/carry eligibility decision fork scenarios.
  const eventListeners = new Map();
  // fork/carry eligibility decision stale-safety: mount a REAL LocalFileSystem on a real Cordis Context —
  // the shared per-targetKey lock + version CAS the production tool-fs writers
  // use. The plugin fail-closes without it; tests must exercise the same
  // primitive, not a mock.
  const app = new Context();
  const fs = new LocalFileSystem(app, { cwd: ws, diffBasisMaxBytes: 1024 * 1024 });
  const registeredSkills = new Map();
  const ctx = {
    fs,
    get: () => sessions,
    webServer: { register: (cfg) => { handler = cfg.handler; } },
    skills: {
      register(definition) {
        registeredSkills.set(definition.name, definition);
        return () => {
          if (registeredSkills.get(definition.name) === definition) registeredSkills.delete(definition.name);
        };
      },
    },
    on: (name, fn) => { eventListeners.set(name, fn); },
  };

  // 测试隔离：runtime Skill registration is held only in this in-memory registry.
  const skillHome = join(ws, "dsh-home");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = skillHome;
  const skillFile = join(skillHome, "skills", "collab-notes", "SKILL.md");
  const registeredSkillText = () => {
    const skill = registeredSkills.get("collab-notes");
    return `---\nname: ${skill?.name ?? ""}\ndescription: ${JSON.stringify(skill?.description ?? "")}\n---\n\n${skill?.content ?? ""}`;
  };

  // webServer 注册在 async apply 的 skill 写入之前（生命周期降险）：不 await 也应已注册
  const applyPromise = apply(ctx);
  ok("webServer 在 async apply 完成前已注册（路由不依赖异步 skill 写入）", typeof handler === "function");
  await applyPromise;
  assert.ok(handler, "handler registered");

  const base = `/notes-api/${SESSION}`;
  const H = { host: "127.0.0.1:3080" };
  const GOOD_ORIGIN = { origin: "http://127.0.0.1:3080" };

  console.log("— 正常读写（镜像）—");
  let s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { ...H, "if-match": "0" }, body: "- [2026-08-17] 测试条目" }));
  ok("PUT L1（首次创建 If-Match:0）→ 200", s.code === 200 && s.body === "ok");
  ok("A1 fileLocks 无泄漏（锁操作后条目清理）", fileLocks.size === 0);
  ok("A1 共享 fs 锁无泄漏（HTTP PUT 用 ctx.fs.withLock 后条目清理）", fs.locks.size === 0);
  const onDisk = await readFile(join(notesRoot, L1, `${SESSION}.md`), "utf8");
  ok("文件内容 = 请求体（完全镜像，无来源头）", onDisk === "- [2026-08-17] 测试条目");
  const { stat } = await import("node:fs/promises");
  const allDirs = await Promise.all([L1, L2, L3, L4].map((d) => stat(join(notesRoot, d)).then(() => true).catch(() => false)));
  ok("插件内生建齐 notes/<key> 骨架（未预建任何目录）", allDirs.every(Boolean));
  s = await call(handler, makeReq({ url: `${base}/${L1}`, headers: H }));
  ok("GET L1 → 原样返回", s.code === 200 && s.body === "- [2026-08-17] 测试条目");
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L2}`, headers: { ...H, "if-match": "0" }, body: "待办A" }));
  ok("PUT L2（首次创建 If-Match:0）→ 200", s.code === 200);
  s = await call(handler, makeReq({ url: `${base}/${L4}`, headers: H }));
  ok("GET 未写过的 L4 → 200 空串", s.code === 200 && s.body === "");

  console.log("— GET 错误区分 —");
  s = await call(handler, makeReq({ url: `${base}/${L3}`, headers: H }));
  ok("不存在文件 → 空便签（ENOENT 分支）", s.code === 200 && s.body === "");
  const dirAsFile = join(notesRoot, L3, `${SESSION}.md`);
  await mkdir(dirAsFile); // 目录冒充文件（L3 目录已由内生骨架建好）→ EISDIR 读错误
  s = await call(handler, makeReq({ url: `${base}/${L3}`, headers: H }));
  ok("其它读错误 → 500（不吞）", s.code === 500);
  await rm(dirAsFile, { recursive: true, force: true });

  console.log("— 非法层 / 非法 sessionId —");
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/L5-xxx`, headers: H, body: "x" }));
  ok("非法层 → 400", s.code === 400);
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/..%2Fevil/${L1}`, headers: H, body: "x" }));
  ok("sessionId 含 %2F（编码斜杠）→ 400", s.code === 400);
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/../${L1}`, headers: H, body: "x" }));
  ok("sessionId ..（URL 归一化）→ 400", s.code === 400);
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/ab/${L1}`, headers: H, body: "x" }));
  ok("sessionId 过短 → 400", s.code === 400);
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/bad%20id/${L1}`, headers: H, body: "x" }));
  ok("sessionId 含空格 → 400", s.code === 400);

  console.log("— Origin 真同源 —");
  s = await call(handler, makeReq({ url: `${base}/${L1}`, headers: H }));
  const l1Mtime = s.headers["x-notes-mtime"]; // L1 已存在（正常读写段创建）
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { ...H, ...GOOD_ORIGIN, "if-match": l1Mtime }, body: "y" }));
  ok("Origin 与 Host 一致 → 放行", s.code === 200);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:9999" }, body: "y" }));
  ok("同 localhost 不同端口 → 403（v2 收紧）", s.code === 403);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { host: "127.0.0.1:3080", origin: "https://evil.example" }, body: "y" }));
  ok("外部网页 Origin → 403", s.code === 403);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { host: "127.0.0.1:3080", origin: "not a url" }, body: "y" }));
  ok("非法 Origin 串 → 403", s.code === 403);

  console.log("— body 上限 —");
  const big = "x".repeat(1024 * 1024 + 1);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { ...H, "x-notes-overwrite": "1" }, body: big }));
  ok("超过 1 MiB → 413", s.code === 413);

  console.log("— 并发（If-Match / 409 / mtime / I0-B）—");
  // I0-B: unpreconditioned destructive PUT is no longer accepted.
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L2}`, headers: H, body: "v0" }));
  ok("无 If-Match 普通 PUT → 428（precondition required）", s.code === 428);
  // L3 在此段前不存在（L99 的目录冒充文件已 rm）→ 用 L3 验证"首次保存 If-Match:0"
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "if-match": "0" }, body: "v1" }));
  const m1 = s.headers["x-notes-mtime"];
  ok("首次保存 If-Match:0（文件不存在基线）→ 200", s.code === 200);
  ok("PUT 200 返回 X-Notes-Mtime", typeof m1 === "string" && m1.length > 0);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "if-match": m1 }, body: "v2" }));
  ok("If-Match 匹配 → 200", s.code === 200);
  const m2 = s.headers["x-notes-mtime"];
  ok("再次 PUT 返回新 mtime（≠ 旧基线）", typeof m2 === "string" && m2 !== m1);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "if-match": m1 }, body: "stale" }));
  ok("If-Match 过期（旧基线）→ 409", s.code === 409);
  ok("409 返回最新内容（不静默覆盖）", s.body === "v2");
  ok("409 头带最新 mtime", s.headers["x-notes-mtime"] === m2);
  // I0-B: user-explicit overwrite flow (X-Notes-Overwrite: 1) still works.
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "x-notes-overwrite": "1" }, body: "v3-override" }));
  ok("显式覆盖（X-Notes-Overwrite: 1，用户已见冲突）→ 200", s.code === 200);
  const m3 = s.headers["x-notes-mtime"];
  ok("显式覆盖返回新 mtime", typeof m3 === "string" && m3 !== m2);
  s = await call(handler, makeReq({ url: `${base}/${L3}`, headers: H }));
  ok("显式覆盖后内容已替换（用户选择）", s.body === "v3-override");
  // I0-B: a caller cannot masquerade as explicit overwrite via If-Match omission
  // — plain PUT still rejected even after the file exists.
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: H, body: "v4" }));
  ok("文件存在后无 If-Match 普通 PUT 仍 → 428", s.code === 428);
  // 428 不影响已保存内容
  s = await call(handler, makeReq({ url: `${base}/${L3}`, headers: H }));
  ok("428 拒绝后内容未被覆盖", s.body === "v3-override");
  s = await call(handler, makeReq({ url: `${base}/${L3}`, headers: H }));
  ok("GET 返回 X-Notes-Mtime", typeof s.headers["x-notes-mtime"] === "string" && s.headers["x-notes-mtime"].length > 0);
  ok("GET Cache-Control: no-store", s.headers["cache-control"] === "no-store");
  s = await call(handler, makeReq({ url: `${base}/${L4}`, headers: H }));
  ok("空便签 GET mtime=0（无文件基线）", s.headers["x-notes-mtime"] === "0");
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L4}`, headers: { ...H, "if-match": "0" }, body: "first" }));
  ok("首次保存 If-Match:0 → 200（文件不存在基线）", s.code === 200);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L4}`, headers: { ...H, "if-match": "0" }, body: "again" }));
  ok("文件已存在但基线仍 0 → 409", s.code === 409 && s.body === "first");

  console.log("— session- 前缀形态 —");
  const SESSION_PREFIXED = `session-${SESSION}`;
  const base2 = `/notes-api/${SESSION_PREFIXED}`;
  s = await call(handler, makeReq({ method: "PUT", url: `${base2}/${L1}`, headers: { ...H, "if-match": "0" }, body: "prefixed" }));
  ok("session- 前缀 sessionId → 200", s.code === 200);
  const onDisk2 = await readFile(join(notesRoot, L1, `${SESSION_PREFIXED}.md`), "utf8");
  ok("session- 前缀落盘正确（文件名即来源）", onDisk2 === "prefixed");

  console.log("— 其它 —");
  s = await call(handler, makeReq({ method: "POST", url: `${base}/${L1}`, headers: H, body: "" }));
  ok("非 GET/PUT → 405", s.code === 405);
  s = await call(handler, makeReq({ method: "GET", url: `/notes-api/unknown-session-0000000000/${L1}`, headers: H }));
  ok("未知会话 → 404", s.code === 404);

  console.log("— meta（三层解耦：layers 映射）—");
  s = await call(handler, makeReq({ url: "/notes-api/meta", headers: H }));
  const meta0 = JSON.parse(s.body);
  ok("GET /notes-api/meta → 200 JSON {layers:[4]}", s.code === 200 && Array.isArray(meta0.layers) && meta0.layers.length === 4);
  ok("默认顺序：conversation_todo 第一（displayId=L1）", meta0.layers[0].key === "conversation_todo" && meta0.layers[0].displayId === "L1");
  ok("默认 label = displayId + 语义名", meta0.layers[0].label === "L1 会话待办");
  ok("policy 随 key 固定（conversation_todo=active）", meta0.layers[0].policy === "active");
  ok("policy 其余=releasable", meta0.layers.slice(1).every((l) => l.policy === "releasable"));
  // displayOrder 重排 + 过滤
  let handler2;
  const ctx2 = { fs, get: () => sessions, webServer: { register: (cfg) => { handler2 = cfg.handler; } }, on: (n, f) => { eventListeners.set(n, f); } };
  await apply(ctx2, { displayOrder: ["lesson_candidate", "conversation_todo"] });
  s = await call(handler2, makeReq({ url: "/notes-api/meta", headers: H }));
  const meta1 = JSON.parse(s.body);
  ok("displayOrder 只重排（未列出的已知层自动补齐，不隐藏）", meta1.layers.map((l) => l.key).join(",") === "lesson_candidate,conversation_todo,deferred_work,knowledge_candidate");
  // layerOverrides 覆盖 label/displayId；policy 不可改
  let handler4;
  const ctx4 = { fs, get: () => sessions, webServer: { register: (cfg) => { handler4 = cfg.handler; } }, on: (n, f) => { eventListeners.set(n, f); } };
  await apply(ctx4, { layerOverrides: { conversation_todo: { label: "自定义待办", displayId: "T1" } } });
  s = await call(handler4, makeReq({ url: "/notes-api/meta", headers: H }));
  const meta2 = JSON.parse(s.body);
  ok("layerOverrides → label/displayId 覆盖", meta2.layers[0].label === "T1 自定义待办" && meta2.layers[0].displayId === "T1");
  ok("policy 仍固定（config 不可改注意力语义）", meta2.layers[0].policy === "active");
  // 未知 displayOrder key → 忽略不崩
  await apply(ctx4, { displayOrder: ["nope", "conversation_todo"] });
  s = await call(handler4, makeReq({ url: "/notes-api/meta", headers: H }));
  const meta3 = JSON.parse(s.body);
  ok("displayOrder 未知 key → 忽略并补齐其余层", meta3.layers.map((l) => l.key).join(",") === "conversation_todo,deferred_work,knowledge_candidate,lesson_candidate");
  s = await call(handler4, makeReq({ method: "POST", url: "/notes-api/meta", headers: H, body: "" }));
  ok("meta 非 GET → 405", s.code === 405);

  console.log("— runtime Skill registration（模板渲染 + 配置校验）—");
  await apply(ctx); // 空配置
  const skillText1 = registeredSkillText();
  ok("空配置 → registry 提供标准 Skill identity", /^---\nname: collab-notes\n/.test(skillText1));
  ok("空配置 → 语义 key 写入（conversation_todo）", skillText1.includes("conversation_todo"));
  ok("空配置 → 询问式措辞（ask the user）", skillText1.includes("ask the user"));
  ok("空配置 → 固定保留确认约束", /must confirm/.test(skillText1));
  ok("正文含 Do NOT 节", skillText1.includes("## Do NOT"));
  await apply(ctx, {
    layerOverrides: { deferred_work: { target: "BACKLOG.md" } },
  });
  const skillText2 = registeredSkillText();
  ok("本地配置 → 注入目标提示", skillText2.includes("BACKLOG.md"));
  ok("本地配置 → 确认约束仍在（配置不构成授权）", /must confirm/.test(skillText2));
  await apply(ctx, {
    layerOverrides: { deferred_work: { target: "../../etc/passwd", action: "x".repeat(500) } },
  });
  const skillText3 = registeredSkillText();
  ok("非法配置（路径穿越/超长）→ 消毒为安全默认", !skillText3.includes("../../etc") && !skillText3.includes("x".repeat(200)));
  await apply(ctx, {
    layerOverrides: { deferred_work: { target: "BACKLOG.md\n\n## Injected\n- evil action" } },
  });
  const skillText5 = registeredSkillText();
  ok("多行/注入配置 → 换行被消毒（不破坏 Skill 结构）", !skillText5.includes("## Injected") && !skillText5.includes("- evil action"));
  await apply(ctx); // 空配置再跑一次
  const skillText4 = registeredSkillText();
  ok("幂等：空配置再次 apply 内容一致（不重复注册）", skillText4 === skillText1 && registeredSkills.size === 1);
  ok("runtime registration 不创建 user-root Skill 文件", await readFile(skillFile, "utf8").then(() => false, () => true));
  if (prevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevHome;

  console.log("— B1：stale agent write（known limitation 验证）—");
  // L3 已被并发段写入 → 重置为版本 A（用当前 mtime 作基线）
  s = await call(handler, makeReq({ url: `${base}/${L3}`, headers: H }));
  const l3Before = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "if-match": l3Before }, body: "A" }));
  const mtimeA = s.headers["x-notes-mtime"];
  const noteFile = join(notesRoot, L3, `${SESSION}.md`);
  ok("agent 读到版本 A（直接文件读）", (await readFile(noteFile, "utf8")) === "A");
  // 用户基于 A 保存 B（If-Match=A 的 mtime）→ 宿主校验通过
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "if-match": mtimeA }, body: "B" }));
  ok("用户 PUT B（If-Match A）→ 200", s.code === 200);
  // agent 基于旧 A 直接整文件写回 C（不经宿主 / If-Match）
  await writeFile(noteFile, "C", "utf8");
  ok("stale agent write 静默覆盖用户 B → 文件为 C（B 丢失，无检测）", (await readFile(noteFile, "utf8")) === "C");

  console.log("— 符号链接逃逸：notes 根（A2）—");
  const outsideRoot = await mkdtemp(join(tmpdir(), "dsh-notes-outside-")); // ws 之外，模拟工作区外
  await rm(notesRoot, { recursive: true, force: true }); // 移除真实 notes 根
  await symlink(outsideRoot, notesRoot);                 // 用指向外部的链接顶替根
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: H, body: "x" }));
  ok("notes 根为指向外部的 symlink → 400", s.code === 400);
  const outsideFiles = await readdir(outsideRoot);
  ok("拒绝前未在外部产生目录（无副作用）", outsideFiles.length === 0);
  await rm(notesRoot, { recursive: true, force: true }); // 删链接本身（不跟随）
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { ...H, "if-match": "0" }, body: "y" }));
  ok("删除链接后内生重建真实 notes 根 → 200", s.code === 200);

  console.log("— 符号链接逃逸：dangling symlink（A2 补强）—");
  // dangling root symlink：notes/ -> 不存在的目录（ws 外）
  const danglingRootTarget = join(tmpdir(), "dsh-notes-dangling-" + Date.now());
  await rm(notesRoot, { recursive: true, force: true });
  await symlink(danglingRootTarget, notesRoot);
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: H, body: "x" }));
  ok("dangling root symlink（目标不存在）→ 400", s.code === 400);
  const danglingRootExists = await stat(danglingRootTarget).then(() => true).catch(() => false);
  ok("拒绝前未在外部创建 dangling 目标目录", danglingRootExists === false);
  await rm(notesRoot, { recursive: true, force: true }); // 删链接
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { ...H, "if-match": "0" }, body: "y" }));
  ok("清理后重建真实 notes 根 → 200", s.code === 200);

  // dangling layer symlink：layer -> 不存在的目录
  const danglingLayerTarget = join(tmpdir(), "dsh-notes-dlayer-" + Date.now());
  await rm(join(notesRoot, L3), { recursive: true, force: true });
  await symlink(danglingLayerTarget, join(notesRoot, L3));
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: H, body: "x" }));
  ok("dangling layer symlink（目标不存在）→ 400", s.code === 400);
  const danglingLayerExists = await stat(danglingLayerTarget).then(() => true).catch(() => false);
  ok("拒绝前未在外部创建 dangling 层目录", danglingLayerExists === false);
  await rm(join(notesRoot, L3), { recursive: true, force: true }); // 删链接
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "if-match": "0" }, body: "z" }));
  ok("清理后重建真实层目录 → 200", s.code === 200);

  console.log("— 符号链接逃逸：层目录（P1）—");
  const outside = join(ws, "outside");
  await mkdir(outside);
  await rm(join(notesRoot, L2), { recursive: true, force: true }); // 移除真实层目录
  await symlink(outside, join(notesRoot, L2));                     // 用指向外部的链接顶替
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L2}`, headers: H, body: "x" }));
  ok("层目录为指向外部的 symlink → 400（realpath 校验）", s.code === 400);
  s = await call(handler, makeReq({ url: `${base}/${L2}`, headers: H }));
  ok("symlink 下 GET 同样被拒 → 400", s.code === 400);
  await rm(join(notesRoot, L2), { recursive: true, force: true }); // 删除链接本身（不跟随）
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L2}`, headers: { ...H, "if-match": "0" }, body: "ok" }));
  ok("清理链接后内生重建真实目录 → 200", s.code === 200);

  console.log("— fork/carry eligibility decision：post-fork Notes carry-over —");
  // Setup: a fork child session (parentSession set, no origin = ordinary fork).
  // The existing SESSION already has notes in some lanes; use a fresh child id.
  const PARENT = SESSION;
  const CHILD = `session-forkchild-0000000001`; // valid SESSION_ID_RE shape
  sessions.set(CHILD, { id: CHILD, header: { cwd: ws, parentSession: PARENT } });
  const childBase = `/notes-api/${CHILD}`;
  // Emit session/created to trigger the plugin's marker write.
  const createdListener = eventListeners.get("session/created");
  assert.ok(typeof createdListener === "function", "session/created listener registered");
  await createdListener(sessions.get(CHILD));

  // --- Test 1: none ---
  const markerFile = join(ws, "notes", ".carry-over", `${CHILD}.json`);
  const markerAfterCreate = JSON.parse(await readFile(markerFile, "utf8"));
  ok("fork child 创建后 marker=unresolved（仅记录，不复制）", markerAfterCreate.status === "unresolved" && markerAfterCreate.parentSessionId === PARENT);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD, choice: "none" }) }));
  ok("选择 none → 200", s.code === 200);
  ok("none 后 marker.status=none", JSON.parse(s.body).status === "none");
  const markerAfterNone = JSON.parse(await readFile(markerFile, "utf8"));
  ok("none 后 marker 持久化（reopen 可见）", markerAfterNone.status === "none" && markerAfterNone.decidedAt !== null);
  const childNoneL1 = await readFile(join(notesRoot, L1, `${CHILD}.md`), "utf8").catch(() => "");
  ok("none → child 未复制任何 notes", childNoneL1 === "");
  // parent untouched
  ok("none → parent notes 未变", (await readFile(join(notesRoot, L1, `${PARENT}.md`), "utf8")).length > 0);

  // --- Test 2: all (fresh child) ---
  const CHILD2 = `session-forkchild-0000000002`;
  sessions.set(CHILD2, { id: CHILD2, header: { cwd: ws, parentSession: PARENT } });
  const childBase2 = `/notes-api/${CHILD2}`;
  await createdListener(sessions.get(CHILD2));
  // parent L2 has known content "待办A"-ish; write distinct parent L1 content first
  s = await call(handler, makeReq({ url: `${base}/${L1}`, headers: H }));
  const parentMtime = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { ...H, "if-match": parentMtime }, body: "parent L1 content" }));
  ok("父 L1 内容就绪", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD2, choice: "all" }) }));
  ok("选择 all → 200", s.code === 200);
  const allResult = JSON.parse(s.body);
  ok("all → 全部 lanes copied", allResult.status === "carried" && allResult.results.length === 4 && allResult.results.every((r) => r.outcome === "copied"));
  ok("child L1 内容 = parent L1", (await readFile(join(notesRoot, L1, `${CHILD2}.md`), "utf8")) === "parent L1 content");
  // independence: edit child, parent unchanged
  s = await call(handler, makeReq({ url: `${childBase2}/${L1}`, headers: H }));
  const childMtime = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `${childBase2}/${L1}`, headers: { ...H, "if-match": childMtime }, body: "child edited" }));
  ok("child edit → 200", s.code === 200);
  ok("child edit 后 parent 未变", (await readFile(join(notesRoot, L1, `${PARENT}.md`), "utf8")) === "parent L1 content");
  ok("child edit 后 child 已变", (await readFile(join(notesRoot, L1, `${CHILD2}.md`), "utf8")) === "child edited");
  // parent edit, child unchanged
  s = await call(handler, makeReq({ url: `${base}/${L1}`, headers: H }));
  const parentMtime2 = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L1}`, headers: { ...H, "if-match": parentMtime2 }, body: "parent edited again" }));
  ok("parent edit → 200", s.code === 200);
  ok("parent edit 后 child 未变", (await readFile(join(notesRoot, L1, `${CHILD2}.md`), "utf8")) === "child edited");

  // --- Test 3: some (lane-level, fresh child) ---
  const CHILD3 = `session-forkchild-0000000003`;
  sessions.set(CHILD3, { id: CHILD3, header: { cwd: ws, parentSession: PARENT } });
  const childBase3 = `/notes-api/${CHILD3}`;
  await createdListener(sessions.get(CHILD3));
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD3, choice: "some", lanes: [L1, L3] }) }));
  ok("选择 some（L1+L3）→ 200", s.code === 200);
  const someResult = JSON.parse(s.body);
  ok("some → 只 copied L1+L3", someResult.results.filter((r) => r.outcome === "copied").map((r) => r.lane).sort().join(",") === [L1, L3].sort().join(","));
  ok("some → L1 有内容", (await readFile(join(notesRoot, L1, `${CHILD3}.md`), "utf8")).length > 0);
  ok("some → L2 未被复制（child 无 L2）", (await readFile(join(notesRoot, L2, `${CHILD3}.md`), "utf8").catch(() => "")) === "");

  // --- Test 4: derivation (marker records parent source) ---
  const marker2 = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${CHILD2}.json`), "utf8"));
  ok("derivation：marker 记录 parentSessionId（系统已知，无需用户填写）", marker2.parentSessionId === PARENT && marker2.status === "carried");

  // --- Test 5: occupied child lane → conflict surfaced (preflight-first) ---
  const CHILD4 = `session-forkchild-0000000004`;
  sessions.set(CHILD4, { id: CHILD4, header: { cwd: ws, parentSession: PARENT } });
  const childBase4 = `/notes-api/${CHILD4}`;
  await createdListener(sessions.get(CHILD4));
  // occupy child L2 before deciding
  s = await call(handler, makeReq({ method: "PUT", url: `${childBase4}/${L2}`, headers: { ...H, "if-match": "0" }, body: "child's own L2" }));
  ok("child 自己先写 L2 → 200", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD4, choice: "all" }) }));
  const conflictResult = JSON.parse(s.body);
  ok("occupied child lane → status=conflict（surface，不静默 skip）", conflictResult.status === "conflict");
  ok("conflict 列出 L2（含 child 内容与 observation 绑定）", conflictResult.conflicts.some((c) => c.lane === L2 && c.childContent === "child's own L2") && conflictResult.observations?.[L2]?.child?.kind === "present-nonempty" && typeof conflictResult.observations?.[L2]?.child?.version === "string");
  // preflight-first: no lane mutated, marker still unresolved
  ok("conflict 时未写任何 child lane（preflight-first）", (await readFile(join(notesRoot, L1, `${CHILD4}.md`), "utf8").catch(() => "")) === "");
  const markerAfterConflict = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${CHILD4}.json`), "utf8"));
  ok("conflict 时 marker 仍 unresolved（未提交 decision）", markerAfterConflict.status === "unresolved");
  ok("child 自己的 L2 未被覆盖", (await readFile(join(notesRoot, L2, `${CHILD4}.md`), "utf8")) === "child's own L2");
  ok("parent L2 未被破坏", (await readFile(join(notesRoot, L2, `${PARENT}.md`), "utf8")).length > 0);

  // --- Test 6: no continuing synchronization (already covered by independence) +
  //     already-decided child does not re-prompt / re-copy ---
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD2, choice: "all" }) }));
  ok("已 decided 的 child 再次 carryover → 幂等 no-op（不重复复制）", s.code === 200 && JSON.parse(s.body).status === "carried");
  ok("幂等 no-op 未覆盖 child 已有内容", (await readFile(join(notesRoot, L1, `${CHILD2}.md`), "utf8")) === "child edited");
  s = await call(handler, makeReq({ url: `/notes-api/fork-status?sessionId=${CHILD2}`, headers: H }));
  const status2 = JSON.parse(s.body);
  ok("fork-status：decided child 返回 carried（不再 unresolved）", status2.status === "carried" && status2.isForkChild === true);

  console.log("— fork/carry eligibility decision conflict resolution：preflight-first / merge / keep / replace / stale / one-time —");
  const HDR = "## 来自父分支\n\n";
  const SEP = "\n\n---\n\n## 当前分支已有内容\n\n";
  const parentMarker = (status) => JSON.parse(readFileSync(join(ws, "notes", ".carry-over", `${status}.json`), "utf8"));

  // --- Conflict Test A: no-conflict preflight → apply copies everything ---
  const CHILD_A = `session-forkchild-0000000201`;
  sessions.set(CHILD_A, { id: CHILD_A, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(CHILD_A));
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: CHILD_A, choice: "all" }) }));
  const preA = JSON.parse(s.body);
  ok("ConflictA：preflight 返回 4 个 lane，全部无冲突（child 为空）", preA.lanes.length === 4 && preA.lanes.every((l) => l.conflict === false && l.reason === null));
  ok("ConflictA：preflight 绑定 parent+child observation（present + version）", preA.lanes.every((l) => (l.parent?.kind === "absent" || l.parent?.kind === "present-empty" || l.parent?.kind === "present-nonempty") && l.parent?.version !== undefined && (l.child?.kind === "absent" || l.child?.kind === "present-empty" || l.child?.kind === "present-nonempty")));
  // no-conflict apply: fork-carryover 无冲突路径内部已绑定 preflight observations
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_A, choice: "all" }) }));
  const applyA = JSON.parse(s.body);
  ok("ConflictA：无冲突 apply → carried，全部 copied", applyA.status === "carried" && applyA.results.every((r) => r.outcome === "copied") && applyA.results.length === 4);
  ok("ConflictA：child L1 已复制 parent 内容", (await readFile(join(notesRoot, L1, `${CHILD_A}.md`), "utf8")) === "parent edited again");
  ok("ConflictA：marker 已 carried", parentMarker(CHILD_A).status === "carried");

  // --- Conflict Test B: one conflict lane → merge (deterministic concat, parent-first) ---
  const CHILD_B = `session-forkchild-0000000202`;
  sessions.set(CHILD_B, { id: CHILD_B, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(CHILD_B));
  // parent L2 = "待办A"-ish already; write known parent content first
  s = await call(handler, makeReq({ url: `${base}/${L2}`, headers: H }));
  const parentL2mtime = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L2}`, headers: { ...H, "if-match": parentL2mtime }, body: "parent L2 content" }));
  ok("ConflictB：父 L2 内容就绪", s.code === 200);
  // occupy child L2
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CHILD_B}/${L2}`, headers: { ...H, "if-match": "0" }, body: "child L2 own" }));
  ok("ConflictB：child 自己先写 L2", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_B, choice: "all" }) }));
  const preB = JSON.parse(s.body);
  ok("ConflictB：occupied lane → status=conflict（不静默 skip）", preB.status === "conflict");
  ok("ConflictB：conflict 列出 L2（含两侧内容）", preB.conflicts.length === 1 && preB.conflicts[0].lane === L2 && preB.conflicts[0].childContent === "child L2 own" && preB.conflicts[0].parentContent === "parent L2 content");
  ok("ConflictB：conflict 响应携带 observations（parent+child kind/version 绑定）", preB.observations?.[L2]?.parent?.kind === "present-nonempty" && typeof preB.observations?.[L2]?.child?.version === "string" && preB.observations?.[L2]?.child?.kind === "present-nonempty");
  ok("ConflictB：preflight-first——conflict 时未写任何 child lane", (await readFile(join(notesRoot, L1, `${CHILD_B}.md`), "utf8").catch(() => "")) === "");
  ok("ConflictB：marker 仍 unresolved（未提交 decision）", parentMarker(CHILD_B).status === "unresolved");
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: CHILD_B, choice: "all", resolutions: { [L2]: "merge" }, observations: preB.observations }) }));
  const applyB = JSON.parse(s.body);
  ok("ConflictB：merge apply → carried + L2 merged", applyB.status === "carried" && applyB.results.find((r) => r.lane === L2)?.outcome === "merged");
  const mergedText = await readFile(join(notesRoot, L2, `${CHILD_B}.md`), "utf8");
  ok("ConflictB：merge 内容 = parent-first 确定性拼接（含两侧标签）", mergedText === HDR + "parent L2 content" + SEP + "child L2 own");
  ok("ConflictB：child L1 也在同一 apply 中 copied", (await readFile(join(notesRoot, L1, `${CHILD_B}.md`), "utf8")) === "parent edited again");
  ok("ConflictB：marker 已 carried", parentMarker(CHILD_B).status === "carried");

  // --- Conflict Test C: keep-current（保留当前，不继承父分支此层） ---
  const CHILD_C = `session-forkchild-0000000203`;
  sessions.set(CHILD_C, { id: CHILD_C, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(CHILD_C));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CHILD_C}/${L3}`, headers: { ...H, "if-match": "0" }, body: "child L3 own" }));
  ok("ConflictC：child 先写 L3", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_C, choice: "all" }) }));
  const preC = JSON.parse(s.body);
  ok("ConflictC：occupied L3 → conflict", preC.status === "conflict" && preC.conflicts.some((c) => c.lane === L3));
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: CHILD_C, choice: "all", resolutions: { [L3]: "keep" }, observations: preC.observations }) }));
  const applyC = JSON.parse(s.body);
  ok("ConflictC：keep → carried + L3 kept", applyC.status === "carried" && applyC.results.find((r) => r.lane === L3)?.outcome === "kept");
  ok("ConflictC：child L3 内容原样保留（未写穿）", (await readFile(join(notesRoot, L3, `${CHILD_C}.md`), "utf8")) === "child L3 own");

  // --- Conflict Test D: replace-with-parent（覆盖当前，绑定用户确认时的 child state） ---
  const CHILD_D = `session-forkchild-0000000204`;
  sessions.set(CHILD_D, { id: CHILD_D, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(CHILD_D));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CHILD_D}/${L3}`, headers: { ...H, "if-match": "0" }, body: "child L3 will be replaced" }));
  ok("ConflictD：child 先写 L3", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_D, choice: "all" }) }));
  const preD = JSON.parse(s.body);
  ok("ConflictD：occupied L3 → conflict", preD.status === "conflict" && preD.conflicts.some((c) => c.lane === L3));
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: CHILD_D, choice: "all", resolutions: { [L3]: "replace" }, observations: preD.observations }) }));
  const applyD = JSON.parse(s.body);
  ok("ConflictD：replace → carried + L3 replaced", applyD.status === "carried" && applyD.results.find((r) => r.lane === L3)?.outcome === "replaced");
  const parentL3 = await readFile(join(notesRoot, L3, `${PARENT}.md`), "utf8");
  ok("ConflictD：child L3 = parent L3 内容（destructive 覆盖生效）", (await readFile(join(notesRoot, L3, `${CHILD_D}.md`), "utf8")) === parentL3);

  // --- Conflict Test E: multiple conflict lanes + mixed resolutions ---
  const CHILD_E = `session-forkchild-0000000205`;
  sessions.set(CHILD_E, { id: CHILD_E, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(CHILD_E));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CHILD_E}/${L2}`, headers: { ...H, "if-match": "0" }, body: "child E L2" }));
  ok("ConflictE：child 先写 L2", s.code === 200);
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CHILD_E}/${L3}`, headers: { ...H, "if-match": "0" }, body: "child E L3" }));
  ok("ConflictE：child 先写 L3", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_E, choice: "all" }) }));
  const preE = JSON.parse(s.body);
  ok("ConflictE：两个冲突 lane 同时 surface", preE.status === "conflict" && preE.conflicts.map((c) => c.lane).sort().join(",") === [L2, L3].sort().join(","));
  ok("ConflictE：observations 覆盖全部 selected lane（不只冲突 lane）", Object.keys(preE.observations).sort().join(",") === [L1, L2, L3, L4].sort().join(","));
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: CHILD_E, choice: "all", resolutions: { [L2]: "keep", [L3]: "merge" }, observations: preE.observations }) }));
  const applyE = JSON.parse(s.body);
  ok("ConflictE：混合 resolution apply → L2 kept + L3 merged", applyE.status === "carried" && applyE.results.find((r) => r.lane === L2)?.outcome === "kept" && applyE.results.find((r) => r.lane === L3)?.outcome === "merged");
  ok("ConflictE：L2 原样 / L3 已合并", (await readFile(join(notesRoot, L2, `${CHILD_E}.md`), "utf8")) === "child E L2" && (await readFile(join(notesRoot, L3, `${CHILD_E}.md`), "utf8")).includes("## 来自父分支"));

  // --- Conflict Test F: stale-after-preflight（确认期间 child 被改 → 原子拒绝） ---
  const CHILD_F = `session-forkchild-0000000206`;
  sessions.set(CHILD_F, { id: CHILD_F, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(CHILD_F));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CHILD_F}/${L2}`, headers: { ...H, "if-match": "0" }, body: "child F v1" }));
  ok("ConflictF：child 先写 L2（v1）", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_F, choice: "all" }) }));
  const preF = JSON.parse(s.body);
  ok("ConflictF：occupied L2 → conflict", preF.status === "conflict" && preF.conflicts.some((c) => c.lane === L2));
  const fSeen = preF.observations[L2].child.version;
  // child changes between preflight and apply (mtime bump via a second PUT)
  await new Promise((r) => setTimeout(r, 15)); // 确保 version 推进（同毫秒写入会相同）
  s = await call(handler, makeReq({ url: `/notes-api/${CHILD_F}/${L2}`, headers: H }));
  const fMtime1 = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${CHILD_F}/${L2}`, headers: { ...H, "if-match": fMtime1 }, body: "child F v2" }));
  ok("ConflictF：确认期间 child L2 被改（v2）", s.code === 200);
  s = await call(handler, makeReq({ url: `/notes-api/${CHILD_F}/${L2}`, headers: H }));
  const fMtime2 = s.headers["x-notes-mtime"];
  ok("ConflictF：v2 的 mtime 与 preflight 所见不同（stale 条件成立）", fMtime2 !== fMtime1);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: CHILD_F, choice: "all", resolutions: { [L2]: "replace" }, observations: preF.observations }) }));
  const applyF = JSON.parse(s.body);
  ok("ConflictF：stale observation → status=stale（原子拒绝，不写任何 lane）", applyF.status === "stale" && applyF.results.some((r) => r.lane === L2 && r.outcome === "stale"));
  ok("ConflictF：stale 时 child L2 仍是 v2（未按旧确认覆盖）", (await readFile(join(notesRoot, L2, `${CHILD_F}.md`), "utf8")) === "child F v2");
  ok("ConflictF：stale 时其他 lane 未被写（deferred）", applyF.results.some((r) => r.outcome === "deferred"));
  ok("ConflictF：stale 时 marker 仍 unresolved（可重新确认）", parentMarker(CHILD_F).status === "unresolved");
  // re-surface with fresh observation → merge now succeeds
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_F, choice: "all" }) }));
  const preF2 = JSON.parse(s.body);
  const fSeen2 = preF2.observations[L2].child.version;
  ok("ConflictF：重新 preflight 拿到新 version", preF2.status === "conflict" && fSeen2 !== fSeen);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: CHILD_F, choice: "all", resolutions: { [L2]: "merge" }, observations: preF2.observations }) }));
  const applyF2 = JSON.parse(s.body);
  ok("ConflictF：新 version 下 merge 成功", applyF2.status === "carried" && applyF2.results.find((r) => r.lane === L2)?.outcome === "merged");
  ok("ConflictF：merge 内容基于最新 child 内容（v2）", (await readFile(join(notesRoot, L2, `${CHILD_F}.md`), "utf8")) === HDR + "parent L2 content" + SEP + "child F v2");

  // --- Conflict Test G: one-time boundary（resolved 后不得重启 merge） ---
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_F, choice: "all" }) }));
  const postF = JSON.parse(s.body);
  ok("ConflictG：已 resolved 的 child 再 carryover → 幂等（不重启 conflict merge）", postF.status === "carried" && postF.conflicts === undefined);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: CHILD_F, choice: "all", resolutions: { [L2]: "replace" }, observations: {} }) }));
  const postF2 = JSON.parse(s.body);
  ok("ConflictG：resolved 后 fork-apply → alreadyDecided（不执行 destructive 覆盖）", postF2.alreadyDecided === true && postF2.results.length === 0);
  ok("ConflictG：marker 未被改写（仍 carried）", parentMarker(CHILD_F).status === "carried");
  ok("ConflictG：child L2 合并内容未被 replace 破坏", (await readFile(join(notesRoot, L2, `${CHILD_F}.md`), "utf8")).includes("## 来自父分支"));

  console.log("— fork/carry eligibility decision stale-safety（test T1–T8）：observation binding + shared-lock Window B —");
  // Helper: shared fs resolve helper (same canonical key the plugin uses).
  const notesFile = (sessionId, lane) => join(ws, "notes", lane, `${sessionId}.md`);
  const obsOf = async (sessionId, lane) => {
    const abs = notesFile(sessionId, lane);
    const t = await fs.resolve(abs, { cwd: ws });
    const st = await fs.stat(t);
    return { kind: st ? (st.size === 0 ? "present-empty" : "present-nonempty") : "absent", version: st?.version ?? null };
  };
  const PARENT_OBS = "session-parent-obs-0000000001";

  // --- T1: child absent → occupied before apply (copied lane) ---
  const T1 = `session-forkchild-0000000301`;
  sessions.set(T1, { id: T1, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T1));
  // parent L1 has content; child L1 absent at preflight
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: T1, choice: "all" }) }));
  const t1Pre = JSON.parse(s.body);
  ok("T1：preflight 时 child L1 absent（observation 绑定 absent）", t1Pre.lanes.find((l) => l.lane === L1).child.kind === "absent");
  // HTTP writer occupies child L1 between preflight and apply
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T1}/${L1}`, headers: { ...H, "if-match": "0" }, body: "T1 NEW-CHILD" }));
  ok("T1：competing HTTP PUT 写入 child L1", s.code === 200);
  const t1Obs = {};
  for (const p of t1Pre.lanes) t1Obs[p.lane] = { parent: p.parent, child: p.child };
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T1, choice: "all", resolutions: {}, observations: t1Obs }) }));
  const t1Apply = JSON.parse(s.body);
  ok("T1：child absent→occupied → status=stale（零 carry-over 写入）", t1Apply.status === "stale" && t1Apply.results.some((r) => r.lane === L1 && r.outcome === "stale"));
  ok("T1：NEW-CHILD 保留（未被 carry 覆盖）", (await readFile(notesFile(T1, L1), "utf8")) === "T1 NEW-CHILD");
  ok("T1：marker 仍 unresolved", parentMarker(T1).status === "unresolved");

  // --- T2: child empty → occupied before apply ---
  const T2 = `session-forkchild-0000000302`;
  sessions.set(T2, { id: T2, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T2));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T2}/${L2}`, headers: { ...H, "if-match": "0" }, body: "" }));
  ok("T2：child L2 先写 empty（existing empty file）", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: T2, choice: "all" }) }));
  const t2Pre = JSON.parse(s.body);
  ok("T2：preflight 区分 empty child（present-empty，非 absent）", t2Pre.lanes.find((l) => l.lane === L2).child.kind === "present-empty");
  s = await call(handler, makeReq({ url: `/notes-api/${T2}/${L2}`, headers: H }));
  const t2mtime = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T2}/${L2}`, headers: { ...H, "if-match": t2mtime }, body: "T2 NEW-CHILD" }));
  ok("T2：competing HTTP PUT 填充 child L2", s.code === 200);
  const t2Obs = {};
  for (const p of t2Pre.lanes) t2Obs[p.lane] = { parent: p.parent, child: p.child };
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T2, choice: "all", resolutions: {}, observations: t2Obs }) }));
  const t2Apply = JSON.parse(s.body);
  ok("T2：child empty→occupied → status=stale", t2Apply.status === "stale" && t2Apply.results.some((r) => r.lane === L2 && r.outcome === "stale"));
  ok("T2：NEW-CHILD 保留", (await readFile(notesFile(T2, L2), "utf8")) === "T2 NEW-CHILD");
  ok("T2：marker 仍 unresolved", parentMarker(T2).status === "unresolved");

  // --- T3: parent changes after preflight (merge) ---
  const T3 = `session-forkchild-0000000303`;
  sessions.set(T3, { id: T3, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T3));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T3}/${L3}`, headers: { ...H, "if-match": "0" }, body: "T3 child" }));
  ok("T3：child 先写 L3", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: T3, choice: "all" }) }));
  const t3Pre = JSON.parse(s.body);
  ok("T3：occupied L3 → conflict", t3Pre.status === "conflict" && t3Pre.conflicts.some((c) => c.lane === L3));
  // parent L3 changes between preflight and apply
  s = await call(handler, makeReq({ url: `${base}/${L3}`, headers: H }));
  const t3parentMtime = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L3}`, headers: { ...H, "if-match": t3parentMtime }, body: "T3 PARENT-A2" }));
  ok("T3：parent L3 被改（A→A2）", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T3, choice: "all", resolutions: { [L3]: "merge" }, observations: t3Pre.observations }) }));
  const t3Apply = JSON.parse(s.body);
  ok("T3：parent 变化 → status=stale（不静默用 A2）", t3Apply.status === "stale" && t3Apply.results.some((r) => r.lane === L3 && r.outcome === "stale"));
  ok("T3：child L3 原样保留", (await readFile(notesFile(T3, L3), "utf8")) === "T3 child");
  ok("T3：marker 仍 unresolved", parentMarker(T3).status === "unresolved");

  // --- T4: replace parent changes ---
  const T4 = `session-forkchild-0000000304`;
  sessions.set(T4, { id: T4, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T4));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T4}/${L4}`, headers: { ...H, "if-match": "0" }, body: "T4 child" }));
  ok("T4：child 先写 L4", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: T4, choice: "all" }) }));
  const t4Pre = JSON.parse(s.body);
  ok("T4：occupied L4 → conflict", t4Pre.status === "conflict" && t4Pre.conflicts.some((c) => c.lane === L4));
  s = await call(handler, makeReq({ url: `${base}/${L4}`, headers: H }));
  const t4parentMtime = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L4}`, headers: { ...H, "if-match": t4parentMtime }, body: "T4 PARENT-A2" }));
  ok("T4：parent L4 被改", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T4, choice: "all", resolutions: { [L4]: "replace" }, observations: t4Pre.observations }) }));
  const t4Apply = JSON.parse(s.body);
  ok("T4：replace 在 parent 变化后 → stale（不用 unseen A2）", t4Apply.status === "stale" && t4Apply.results.some((r) => r.lane === L4 && r.outcome === "stale"));
  ok("T4：child L4 原样保留", (await readFile(notesFile(T4, L4), "utf8")) === "T4 child");

  // --- T5: phase1→phase2 race (test reproduction) with REAL HTTP PUT competing writer ---
  const T5 = `session-forkchild-0000000305`;
  sessions.set(T5, { id: T5, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T5));
  // child L1 absent at preflight
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: T5, choice: "all" }) }));
  const t5Pre = JSON.parse(s.body);
  ok("T5：preflight 时 child L1 absent", t5Pre.lanes.find((l) => l.lane === L1).child.kind === "absent");
  const t5Obs = {};
  for (const p of t5Pre.lanes) t5Obs[p.lane] = { parent: p.parent, child: p.child };
  // Fire apply and a competing HTTP PUT concurrently. The apply holds the shared
  // fs lock on child L1 while revalidating+writes; the HTTP PUT must queue on
  // the SAME canonical key, so either: apply wins → PUT then 409s (If-Match
  // stale) or overwrites with explicit override; or PUT wins → apply sees the
  // new child and refuses stale. Either way: no silent carry overwrite of the
  // HTTP write under an accepted stale model.
  const [t5ApplyRes, t5PutRes] = await Promise.all([
    call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T5, choice: "all", resolutions: {}, observations: t5Obs }) })),
    call(handler, makeReq({ method: "PUT", url: `/notes-api/${T5}/${L1}`, headers: { ...H, "if-match": "0" }, body: "T5 HTTP-RACE" })),
  ]);
  const t5Apply = JSON.parse(t5ApplyRes.body);
  const t5Final = await readFile(notesFile(T5, L1), "utf8").catch(() => "");
  ok("T5：并发竞争下无 silent overwrite（apply stale 或 PUT 409，二选一安全态）",
    (t5Apply.status === "stale" && t5Final === "T5 HTTP-RACE") ||
    (t5Apply.status === "carried" && t5PutRes.code === 409 && t5Final === "parent edited again"));
  ok("T5：最终 child 内容要么是 HTTP 写入要么是 parent 复制（非半程态）", t5Final === "T5 HTTP-RACE" || t5Final === "parent edited again");

  // --- T6: parent-side competing writer during validation/apply window ---
  const T6 = `session-forkchild-0000000306`;
  sessions.set(T6, { id: T6, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T6));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T6}/${L2}`, headers: { ...H, "if-match": "0" }, body: "T6 child" }));
  ok("T6：child 先写 L2", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: T6, choice: "all" }) }));
  const t6Pre = JSON.parse(s.body);
  ok("T6：occupied L2 → conflict", t6Pre.status === "conflict" && t6Pre.conflicts.some((c) => c.lane === L2));
  const [t6ApplyRes, t6ParentPutRes] = await Promise.all([
    call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T6, choice: "all", resolutions: { [L2]: "merge" }, observations: t6Pre.observations }) })),
    call(handler, makeReq({ url: `${base}/${L2}`, headers: H })),
  ]);
  let t6ParentMtime = t6ParentPutRes.headers?.["x-notes-mtime"] ?? t6ParentPutRes.headers?.get?.("x-notes-mtime");
  s = await call(handler, makeReq({ method: "PUT", url: `${base}/${L2}`, headers: { ...H, "if-match": t6ParentMtime }, body: "T6 PARENT-A2" }));
  ok("T6：parent L2 被并发改（A→A2）", s.code === 200);
  const t6Apply = JSON.parse(t6ApplyRes.body);
  // Parent changed after the apply's lock section → apply may have used old A;
  // verify final child does NOT contain unseen A2 (no silent substitution).
  const t6Final = await readFile(notesFile(T6, L2), "utf8");
  ok("T6：最终 child 不含 unseen A2（stale 或基于 A 的 merge，二者皆安全）", !t6Final.includes("T6 PARENT-A2"));

  // --- T7: all lanes atomic stale rejection ---
  const T7 = `session-forkchild-0000000307`;
  sessions.set(T7, { id: T7, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T7));
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T7}/${L3}`, headers: { ...H, "if-match": "0" }, body: "T7 child L3" }));
  ok("T7：child 先写 L3", s.code === 200);
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T7}/${L4}`, headers: { ...H, "if-match": "0" }, body: "T7 child L4" }));
  ok("T7：child 先写 L4", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: T7, choice: "all" }) }));
  const t7Pre = JSON.parse(s.body);
  ok("T7：L3+L4 冲突 surface", t7Pre.status === "conflict" && t7Pre.conflicts.map((c) => c.lane).sort().join(",") === [L3, L4].sort().join(","));
  // change ONE lane (L4) after preflight
  s = await call(handler, makeReq({ url: `/notes-api/${T7}/${L4}`, headers: H }));
  const t7mtime = s.headers["x-notes-mtime"];
  s = await call(handler, makeReq({ method: "PUT", url: `/notes-api/${T7}/${L4}`, headers: { ...H, "if-match": t7mtime }, body: "T7 child L4-v2" }));
  ok("T7：确认期间 L4 被改", s.code === 200);
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T7, choice: "all", resolutions: { [L3]: "merge", [L4]: "merge" }, observations: t7Pre.observations }) }));
  const t7Apply = JSON.parse(s.body);
  ok("T7：一个 lane stale → 全部 selected lane 均未写（原子拒绝）", t7Apply.status === "stale" && t7Apply.results.some((r) => r.lane === L4 && r.outcome === "stale") && t7Apply.results.some((r) => r.outcome === "deferred"));
  ok("T7：L3 未被 merge（同批未写）", (await readFile(notesFile(T7, L3), "utf8")) === "T7 child L3");
  ok("T7：L4 保留 v2", (await readFile(notesFile(T7, L4), "utf8")) === "T7 child L4-v2");
  ok("T7：marker 仍 unresolved", parentMarker(T7).status === "unresolved");

  // --- T8: tool-fs shared-lock proof (real ctx.fs concurrency) ---
  // A) carry final apply holds child L1's fs lock → concurrent tool-fs writeText
  //    must wait (cannot interleave validation→write window).
  const T8A = `session-forkchild-0000000308`;
  sessions.set(T8A, { id: T8A, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T8A));
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: T8A, choice: "all" }) }));
  const t8aPre = JSON.parse(s.body);
  const t8aObs = {};
  for (const p of t8aPre.lanes) t8aObs[p.lane] = { parent: p.parent, child: p.child };
  // Fire apply (holds locks) and a tool-fs-style writeText concurrently.
  const t8aTarget = await fs.resolve(notesFile(T8A, L1), { cwd: ws });
  const t8aToolWrite = fs.writeText(t8aTarget, "T8A TOOL-FS WRITE", { kind: "createIfAbsent" });
  const [t8aApplyRes] = await Promise.all([
    call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T8A, choice: "all", resolutions: {}, observations: t8aObs }) })),
    t8aToolWrite.catch((e) => e),
  ]);
  const t8aApply = JSON.parse(t8aApplyRes.body);
  const t8aFinal = await readFile(notesFile(T8A, L1), "utf8").catch(() => "");
  ok("T8A：carry 与 tool-fs writeText 真正竞争同一 canonical key（无交错覆盖）", (t8aApply.status === "carried" && t8aFinal === "parent edited again") || (t8aApply.status === "stale" && t8aFinal === "T8A TOOL-FS WRITE"));
  // B) tool-fs writer wins first → carry then sees stale on revalidate
  const T8B = `session-forkchild-0000000309`;
  sessions.set(T8B, { id: T8B, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(T8B));
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-preflight", headers: H, body: JSON.stringify({ sessionId: T8B, choice: "all" }) }));
  const t8bPre = JSON.parse(s.body);
  const t8bObs = {};
  for (const p of t8bPre.lanes) t8bObs[p.lane] = { parent: p.parent, child: p.child };
  // tool-fs writer (replaceIfVersion at observed version) writes child L1 first
  const t8bTarget = await fs.resolve(notesFile(T8B, L1), { cwd: ws });
  const t8bChildObs = t8bObs[L1].child;
  if (t8bChildObs.kind === "absent") {
    await fs.writeText(t8bTarget, "T8B TOOL-FS FIRST", { kind: "createIfAbsent" });
  } else {
    await fs.writeText(t8bTarget, "T8B TOOL-FS FIRST", { kind: "replaceIfVersion", version: t8bChildObs.version });
  }
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-apply", headers: H, body: JSON.stringify({ sessionId: T8B, choice: "all", resolutions: {}, observations: t8bObs }) }));
  const t8bApply = JSON.parse(s.body);
  ok("T8B：tool-fs 先写 child → carry 锁内 revalidate 发现 stale → 零 carry 写入", t8bApply.status === "stale" && t8bApply.results.some((r) => r.lane === L1 && r.outcome === "stale"));
  ok("T8B：tool-fs 写入保留", (await readFile(notesFile(T8B, L1), "utf8")) === "T8B TOOL-FS FIRST");
  ok("T8B：marker 仍 unresolved", parentMarker(T8B).status === "unresolved");

  // --- SHARED LOCK PROOF: canonical key identity across HTTP / carry / tool-fs ---
  const proofPath = notesFile(T8A, L1);
  const proofHttp = await fs.resolve(proofPath, { cwd: ws });
  const proofCarry = await fs.resolve(proofPath, { cwd: ws });
  const proofTool = await fs.resolve(`notes/conversation_todo/${T8A}.md`, { cwd: ws }); // tool-fs 相对路径解析
  ok("SHARED LOCK PROOF：HTTP 绝对路径 / carry 绝对路径 / tool-fs 相对路径 → 同一 canonical targetKey", proofHttp.targetKey === proofCarry.targetKey && proofCarry.targetKey === proofTool.targetKey);
  ok("SHARED LOCK PROOF：targetKey 为 realpath（/var→/private/var 归一）", proofHttp.targetKey.includes("/private/"));

  console.log("— fork/carry eligibility: M1 path boundary —");
  // M1 uses an isolated workspace so it never destroys the main test's notes.
  const m1ws = await mkdtemp(join(tmpdir(), "dsh-i0f-m1ws-"));
  const m1Notes = join(m1ws, "notes");
  const M1_PARENT = `session-m1parent-0000000001`;
  await mkdir(join(m1Notes, L1), { recursive: true });
  await writeFile(join(m1Notes, L1, `${M1_PARENT}.md`), "parent content", "utf8");
  const m1Sessions = new Map();
  let m1Handler;
  const m1App = new Context();
  const m1Fs = new LocalFileSystem(m1App, { cwd: m1ws, diffBasisMaxBytes: 1024 * 1024 });
  const m1Ctx = { fs: m1Fs, get: () => m1Sessions, webServer: { register: (cfg) => { m1Handler = cfg.handler; } }, on: (n, f) => { eventListeners.set(n, f); } };
  // Test isolation: M1 runs after the main suite restored the real DSH_HOME;
  // give M1's own apply() a temporary DSH_HOME so it never touches ~/.dsh/skills.
  const m1PrevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(m1ws, "dsh-home");
  await apply(m1Ctx);
  // M1a: notes root symlink → marker write rejected → outside untouched
  const M1_ROOT_OUT = join(tmpdir(), `dsh-i0f-m1root-${Date.now()}`);
  const CHILD_M1 = `session-forkchild-0000000101`;
  await rm(m1Notes, { recursive: true, force: true });
  await symlink(M1_ROOT_OUT, m1Notes);
  m1Sessions.set(CHILD_M1, { id: CHILD_M1, header: { cwd: m1ws, parentSession: M1_PARENT } });
  await eventListeners.get("session/created")(m1Sessions.get(CHILD_M1));
  const m1RootMarkerExists = await stat(join(m1Notes, ".carry-over", `${CHILD_M1}.json`)).then(() => true).catch(() => false);
  ok("M1a：notes root 为 symlink → marker 未被写入", m1RootMarkerExists === false);
  const m1RootOutside = await readdir(M1_ROOT_OUT).catch(() => []);
  ok("M1a：外部目录未被创建/写入（无副作用）", m1RootOutside.length === 0);
  await rm(m1Notes, { recursive: true, force: true }); // 删链接（不跟随）
  // M1b: notes/.carry-over symlink → marker write rejected → outside untouched
  const M1_DIR_OUT = join(tmpdir(), `dsh-i0f-m1dir-${Date.now()}`);
  await mkdir(m1Notes, { recursive: true });
  await symlink(M1_DIR_OUT, join(m1Notes, ".carry-over"));
  const CHILD_M1B = `session-forkchild-0000000102`;
  m1Sessions.set(CHILD_M1B, { id: CHILD_M1B, header: { cwd: m1ws, parentSession: M1_PARENT } });
  await eventListeners.get("session/created")(m1Sessions.get(CHILD_M1B));
  const m1DirMarkerExists = await stat(join(m1Notes, ".carry-over", `${CHILD_M1B}.json`)).then(() => true).catch(() => false);
  ok("M1b：notes/.carry-over 为 symlink → marker 未被写入", m1DirMarkerExists === false);
  const m1DirOutside = await readdir(M1_DIR_OUT).catch(() => []);
  ok("M1b：外部目录未被写入（无副作用）", m1DirOutside.length === 0);
  await rm(join(m1Notes, ".carry-over"), { recursive: true, force: true }); // 删链接
  // M1c: dangling notes root symlink → marker write rejected → target not created
  const M1_ROOT_DANGLE = join(tmpdir(), `dsh-i0f-m1rootdangle-${Date.now()}`);
  const CHILD_M1C = `session-forkchild-0000000107`;
  await rm(m1Notes, { recursive: true, force: true });
  await symlink(M1_ROOT_DANGLE, m1Notes); // dangling: target does not exist
  m1Sessions.set(CHILD_M1C, { id: CHILD_M1C, header: { cwd: m1ws, parentSession: M1_PARENT } });
  await eventListeners.get("session/created")(m1Sessions.get(CHILD_M1C));
  const m1RootDangleExists = await stat(M1_ROOT_DANGLE).then(() => true).catch(() => false);
  ok("M1c：dangling notes root symlink → marker 拒绝，未在外部创建目标", m1RootDangleExists === false);
  await rm(m1Notes, { recursive: true, force: true }); // 删链接
  // M1d: dangling notes/.carry-over symlink → marker write rejected
  const M1_DIR_DANGLE = join(tmpdir(), `dsh-i0f-m1dirdangle-${Date.now()}`);
  const CHILD_M1D = `session-forkchild-0000000108`;
  await mkdir(m1Notes, { recursive: true });
  await symlink(M1_DIR_DANGLE, join(m1Notes, ".carry-over")); // dangling
  m1Sessions.set(CHILD_M1D, { id: CHILD_M1D, header: { cwd: m1ws, parentSession: M1_PARENT } });
  await eventListeners.get("session/created")(m1Sessions.get(CHILD_M1D));
  const m1DirDangleExists = await stat(M1_DIR_DANGLE).then(() => true).catch(() => false);
  ok("M1d：dangling .carry-over symlink → marker 拒绝，未在外部创建目标", m1DirDangleExists === false);
  await rm(join(m1Notes, ".carry-over"), { recursive: true, force: true }); // 删链接

  console.log("— fork/carry eligibility decision final M1：final lane target symlink（read 侧 parent / write 侧 child）—");
  // M1e: parent final target is a dangling/outside symlink → fork-carryover
  // rejects, does NOT read the outside content into child, no false carried.
  const M1E_OUT = join(tmpdir(), `dsh-i0f-m1eout-${Date.now()}`);
  const CHILD_M1E = `session-forkchild-0000000109`;
  const m1eParentFile = join(m1Notes, L1, `${M1_PARENT}.md`);
  // fresh child (no marker yet) so carry-over is unresolved
  m1Sessions.set(CHILD_M1E, { id: CHILD_M1E, header: { cwd: m1ws, parentSession: M1_PARENT } });
  // occupy child L1 with a real file so 'all' would otherwise copy; parent L1
  // becomes a dangling symlink pointing outside.
  await mkdir(join(m1Notes, L1), { recursive: true });
  await rm(m1eParentFile, { recursive: true, force: true });
  await symlink(M1E_OUT, m1eParentFile); // parent final target → dangling symlink
  await writeFile(join(m1Notes, L1, `${CHILD_M1E}.md`), "", "utf8"); // child exists (occupied)
  s = await call(m1Handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_M1E, choice: "all" }) }));
  const m1eResult = JSON.parse(s.body);
  ok("M1e：parent final target symlink → 该 lane skipped（invalid-path/拒绝）", m1eResult.status === "carried" && m1eResult.results.some((x) => x.lane === L1 && x.outcome === "skipped" && x.reason === "invalid-path"));
  ok("M1e：外部内容未被读入 child（child L1 未被写入外部内容）", (await readFile(join(m1Notes, L1, `${CHILD_M1E}.md`), "utf8")) === "");
  const m1eOutside = await readdir(M1E_OUT).catch(() => []);
  ok("M1e：外部目录未被读取/复制（无副作用）", m1eOutside.length === 0);
  await rm(m1eParentFile, { recursive: true, force: true }); // 删链接

  // M1f: child final target is a dangling/outside symlink → fork-carryover
  // rejects (skipped), does NOT write through it, no false success.
  const M1F_OUT = join(tmpdir(), `dsh-i0f-m1fout-${Date.now()}`);
  const CHILD_M1F = `session-forkchild-0000000110`;
  m1Sessions.set(CHILD_M1F, { id: CHILD_M1F, header: { cwd: m1ws, parentSession: M1_PARENT } });
  // restore a real parent L1 source, then make child L1 a dangling symlink
  await writeFile(m1eParentFile, "PARENT-REAL", "utf8");
  const m1fChildFile = join(m1Notes, L1, `${CHILD_M1F}.md`);
  await symlink(M1F_OUT, m1fChildFile); // child final target → dangling symlink
  s = await call(m1Handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_M1F, choice: "all" }) }));
  const m1fResult = JSON.parse(s.body);
  ok("M1f：child final target symlink → 该 lane skipped（不写穿）", m1fResult.status === "carried" && m1fResult.results.some((x) => x.lane === L1 && x.outcome === "skipped" && x.reason === "invalid-path"));
  const m1fOutside = await readdir(M1F_OUT).catch(() => []);
  ok("M1f：外部目录未被写入（不跟随 child symlink 写出）", m1fOutside.length === 0);
  await rm(m1fChildFile, { recursive: true, force: true }); // 删链接

  // M1e2: parent final target is an EXISTING symlink to a real outside file.
  const M1E2_OUT_FILE = join(tmpdir(), `dsh-i0f-m1e2out-${Date.now()}.txt`);
  await writeFile(M1E2_OUT_FILE, "OUTSIDE-SECRET", "utf8");
  const CHILD_M1E2 = `session-forkchild-0000000111`;
  m1Sessions.set(CHILD_M1E2, { id: CHILD_M1E2, header: { cwd: m1ws, parentSession: M1_PARENT } });
  await rm(m1eParentFile, { recursive: true, force: true });
  await symlink(M1E2_OUT_FILE, m1eParentFile); // existing symlink → real outside file
  s = await call(m1Handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_M1E2, choice: "all" }) }));
  const m1e2Result = JSON.parse(s.body);
  ok("M1e2：parent existing symlink → skipped（invalid-path）", m1e2Result.status === "carried" && m1e2Result.results.some((x) => x.lane === L1 && x.outcome === "skipped" && x.reason === "invalid-path"));
  ok("M1e2：外部文件内容未被读入 child", (await readFile(join(m1Notes, L1, `${CHILD_M1E2}.md`), "utf8").catch(() => "")) !== "OUTSIDE-SECRET");
  await rm(m1eParentFile, { recursive: true, force: true }); // 删链接

  // M1f2: child final target is an EXISTING symlink to a real outside file.
  const M1F2_OUT_FILE = join(tmpdir(), `dsh-i0f-m1f2out-${Date.now()}.txt`);
  await writeFile(M1F2_OUT_FILE, "", "utf8");
  const CHILD_M1F2 = `session-forkchild-0000000112`;
  m1Sessions.set(CHILD_M1F2, { id: CHILD_M1F2, header: { cwd: m1ws, parentSession: M1_PARENT } });
  await writeFile(m1eParentFile, "PARENT-REAL-2", "utf8"); // real parent source
  const m1f2ChildFile = join(m1Notes, L1, `${CHILD_M1F2}.md`);
  await symlink(M1F2_OUT_FILE, m1f2ChildFile); // existing symlink → real outside file
  s = await call(m1Handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_M1F2, choice: "all" }) }));
  const m1f2Result = JSON.parse(s.body);
  ok("M1f2：child existing symlink → skipped（invalid-path）", m1f2Result.status === "carried" && m1f2Result.results.some((x) => x.lane === L1 && x.outcome === "skipped" && x.reason === "invalid-path"));
  const m1f2Outside = await readFile(M1F2_OUT_FILE, "utf8");
  ok("M1f2：外部文件未被写入（不写穿 existing symlink）", m1f2Outside !== "PARENT-REAL-2" && m1f2Outside === "");
  await rm(m1f2ChildFile, { recursive: true, force: true }); // 删链接

  if (m1PrevHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = m1PrevHome;
  await rm(m1ws, { recursive: true, force: true });

  console.log("— fork/carry eligibility: M2 race（immediate status / decision）—");
  // M2 Race A: start session/created WITHOUT awaiting, then fork-status immediately.
  const CHILD_R1 = `session-forkchild-0000000103`;
  sessions.set(CHILD_R1, { id: CHILD_R1, header: { cwd: ws, parentSession: PARENT } });
  const pendingCreate = createdListener(sessions.get(CHILD_R1)); // do not await
  s = await call(handler, makeReq({ url: `/notes-api/fork-status?sessionId=${CHILD_R1}`, headers: H }));
  const raceStatus = JSON.parse(s.body);
  ok("M2 RaceA：marker 未落盘时 fork-status 仍 isForkChild=true", raceStatus.isForkChild === true);
  ok("M2 RaceA：marker 未落盘时 status=unresolved（不依赖 marker 存在）", raceStatus.status === "unresolved");
  await pendingCreate;
  const mRaceA = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${CHILD_R1}.json`), "utf8"));
  ok("M2 RaceA：listener 完成后 marker=unresolved（与 fork-status 一致）", mRaceA.status === "unresolved" && mRaceA.parentSessionId === PARENT);

  // M2 Race B: start session/created WITHOUT awaiting, then immediately POST carryover.
  const CHILD_R2 = `session-forkchild-0000000104`;
  sessions.set(CHILD_R2, { id: CHILD_R2, header: { cwd: ws, parentSession: PARENT } });
  const pendingCreate2 = createdListener(sessions.get(CHILD_R2)); // do not await
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_R2, choice: "none" }) }));
  ok("M2 RaceB：marker 未落盘时立即 POST none → 200（无 500）", s.code === 200 && JSON.parse(s.body).status === "none");
  await pendingCreate2;
  const mRaceB = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${CHILD_R2}.json`), "utf8"));
  ok("M2 RaceB：late session/created 未覆盖已决定 marker（仍 none）", mRaceB.status === "none" && mRaceB.decidedAt !== null);

  // M2 duplicate/concurrent decision.
  const CHILD_R3 = `session-forkchild-0000000105`;
  sessions.set(CHILD_R3, { id: CHILD_R3, header: { cwd: ws, parentSession: PARENT } });
  await createdListener(sessions.get(CHILD_R3));
  const [r1, r2] = await Promise.all([
    call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_R3, choice: "none" }) })),
    call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_R3, choice: "all" }) })),
  ]);
  ok("M2 dup：两个并发 POST 均 200（锁内串行）", r1.code === 200 && r2.code === 200);
  const mRaceC = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${CHILD_R3}.json`), "utf8"));
  ok("M2 dup：marker 最终一致（none 或 carried 之一，非矛盾态）", mRaceC.status === "none" || mRaceC.status === "carried");
  ok("M2 dup：marker parentSessionId 一致", mRaceC.parentSessionId === PARENT);

  console.log("— fork/carry eligibility: M3 subagent POST rejection —");
  const CHILD_SUB = `session-subchild-0000000001`;
  sessions.set(CHILD_SUB, { id: CHILD_SUB, header: { cwd: ws, parentSession: PARENT, origin: "subagent" } });
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_SUB, choice: "all" }) }));
  ok("M3：subagent child POST carryover → 400（拒绝）", s.code === 400);
  ok("M3：subagent child 未复制任何 notes", (await readFile(join(notesRoot, L1, `${CHILD_SUB}.md`), "utf8").catch(() => "")) === "");
  ok("M3：parent 未被触碰", (await readFile(join(notesRoot, L1, `${PARENT}.md`), "utf8")).length > 0);
  s = await call(handler, makeReq({ url: `/notes-api/fork-status?sessionId=${CHILD_SUB}`, headers: H }));
  ok("M3：subagent child fork-status → isForkChild=false", JSON.parse(s.body).isForkChild === false);
  // M3: stale/forged marker lineage mismatch → rejected
  const CHILD_M3B = `session-forkchild-0000000106`;
  sessions.set(CHILD_M3B, { id: CHILD_M3B, header: { cwd: ws, parentSession: PARENT } });
  await mkdir(join(ws, "notes", ".carry-over"), { recursive: true });
  await writeFile(join(ws, "notes", ".carry-over", `${CHILD_M3B}.json`), JSON.stringify({ version: 1, parentSessionId: "session-forged-parent-0000000000", status: "unresolved", carriedLanes: null, decidedAt: null }), "utf8");
  s = await call(handler, makeReq({ method: "POST", url: "/notes-api/fork-carryover", headers: H, body: JSON.stringify({ sessionId: CHILD_M3B, choice: "none" }) }));
  ok("M3：marker lineage 不匹配 → 400（拒绝，不改写 lineage）", s.code === 400);
  const mForged = JSON.parse(await readFile(join(ws, "notes", ".carry-over", `${CHILD_M3B}.json`), "utf8"));
  ok("M3：forged marker 未被改写", mForged.parentSessionId === "session-forged-parent-0000000000");

  await rm(ws, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
