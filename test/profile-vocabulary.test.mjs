// Host-side profile vocabulary and storage invariants.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { apply } from "../lib/index.js";

const SESSION = "a0b1c2d3-e4f5-6a7b-8c9d-0e1f2a3b4c5d";
const LANES = ["conversation_todo", "deferred_work", "knowledge_candidate", "lesson_candidate"];

function request(url) {
  return { method: "GET", url, headers: { host: "127.0.0.1:3080" }, resume() {}, async *[Symbol.asyncIterator]() {} };
}

function response() {
  const state = {};
  return { state, writeHead(code, headers) { state.code = code; state.headers = headers; }, end(body) { state.body = body ?? ""; } };
}

async function readMeta(handler) {
  const res = response();
  await handler(request("/notes-api/meta"), res);
  assert.equal(res.state.code, 200);
  return JSON.parse(res.state.body);
}

async function mount(ws, dshHome, config) {
  const app = new Context();
  const fs = new LocalFileSystem(app, { cwd: ws, diffBasisMaxBytes: 1024 * 1024 });
  const sessions = new Map([[SESSION, { header: { cwd: ws } }]]);
  let handler;
  const settings = {
    register(namespace, schema, options) {
      assert.equal(namespace, "dsh-collab-notes");
      assert.equal(typeof schema, "function");
      assert.equal(options.applies, "live");
      assert.deepEqual(options.base, config);
      return { get: () => config, watch() {} };
    },
  };
  const registeredSkills = new Map();
  const ctx = {
    fs,
    settings,
    get: (name) => name === "sessions" ? sessions : undefined,
    webServer: { register: (cfg) => { handler = cfg.handler; } },
    skills: {
      register(definition) {
        registeredSkills.set(definition.name, definition);
        return () => registeredSkills.delete(definition.name);
      },
    },
    on() {},
  };
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    await apply(ctx, config);
    const skill = registeredSkills.get("collab-notes");
    return { handler, skill: skill?.content ?? "" };
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-notes-vocab-"));
  try {
    const ws = join(root, "workspace");
    const dshHome = join(root, "dsh-home");
    const notes = join(ws, "notes");
    for (const key of LANES) {
      const dir = join(notes, key);
      await mkdir(dir, { recursive: true });
    }
    const existing = join(notes, "deferred_work", `${SESSION}.md`);
    await writeFile(existing, "existing note bytes\n", "utf8");
    const before = await readFile(existing, "utf8");
    const labels = {
      conversation_todo: "会话待办",
      deferred_work: "转BACKLOG",
      knowledge_candidate: "01知识摘录",
      lesson_candidate: "复盘素材",
    };
    const config = { displayOrder: [], layerOverrides: Object.fromEntries(Object.entries(labels).map(([key, label]) => [key, { label }])) };
    const mounted = await mount(ws, dshHome, config);
    const meta = await readMeta(mounted.handler);
    assert.deepEqual(meta.layers.map((layer) => layer.key), LANES);
    assert.deepEqual(meta.layers.map((layer) => layer.label), ["L1 会话待办", "L2 转BACKLOG", "L3 01知识摘录", "L4 复盘素材"]);
    for (const key of LANES) assert.ok(await stat(join(notes, key)));
    assert.equal(await readFile(existing, "utf8"), before);
    for (const title of meta.layers.map((layer) => layer.label)) assert.equal((mounted.skill.match(new RegExp(title, "g")) || []).length, 1);
    assert.equal(mounted.skill.includes("L1 · L1"), false);
    assert.equal(mounted.skill.includes("notes/会话待办"), false);
    console.log("✓ profile vocabulary composes literal labels once");
    console.log("✓ semantic lane folders and existing Note bytes remain unchanged");
    console.log("✓ Skill and /meta use the same effective titles");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
