// Final Skill registry registration: focused local validation.
//
// This test combines two kinds of evidence deliberately:
//   1. real host-bridge receipts for Skill registration and Note
//      read/create/edit/CAS behavior; and
//   2. a bounded contract audit of the generated Skill's operational guardrails.
//
// It does not pretend to execute an LLM/agent. Model-level behavior requiring
// a real agent session remains outside this deterministic validation.
import { apply } from "../lib/index.js";
import { operationParameters } from "../lib/workspace-binding-runtime.js";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SESSION = "skill-materialization-20260910";
const LANE = "conversation_todo";
const HOST = { host: "127.0.0.1:3215" };
let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function request({ method = "GET", url = "/", headers = {}, body } = {}) {
  const chunks = body == null ? [] : [Buffer.from(body, "utf8")];
  return {
    method,
    url,
    headers,
    resume() {},
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function response() {
  const state = { code: null, headers: {}, body: "" };
  return {
    state,
    writeHead(code, headers) {
      state.code = code;
      state.headers = headers || {};
    },
    end(body) {
      state.body = body ?? "";
    },
  };
}

async function call(handler, req) {
  const res = response();
  await handler(req, res);
  return res.state;
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "dsh-skill-materialization-"));
  const dshHome = join(workspace, "dsh-home");
  const skillFile = join(dshHome, "skills", "collab-notes", "SKILL.md");
  const sessionMap = new Map([[SESSION, { header: { cwd: workspace } }]]);
  const listeners = new Map();
  const registeredTools = [];
  const registeredSkills = new Map();
  const bindingRecords = new Map();
  let handler;
  const app = new Context();
  const fs = new LocalFileSystem(app, { cwd: workspace, diffBasisMaxBytes: 1024 * 1024 });
  const ctx = {
    fs,
    get: () => sessionMap,
    storageDomain: { open: async () => ({ table: () => ({
      get: (key) => bindingRecords.get(key),
      async put(key, value) { bindingRecords.set(key, value); },
    }) }) },
    workspaceRegistry: { resolveByPath: async (path) => ({ id: "skill-materialization-workspace", path }) },
    tools: { register: (definition) => { registeredTools.push(definition); return () => {}; } },
    skills: {
      register: (definition) => {
        registeredSkills.set(definition.name, definition);
        return () => {
          if (registeredSkills.get(definition.name) === definition) registeredSkills.delete(definition.name);
        };
      },
    },
    webServer: { register: (config) => { handler = config.handler; } },
    on: (name, fn) => { listeners.set(name, fn); },
  };
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;

  try {
    await apply(ctx);
    const registered = registeredSkills.get("collab-notes");
    const generated = `---\nname: ${registered?.name ?? ""}\ndescription: ${JSON.stringify(registered?.description ?? "")}\n---\n\n${registered?.content ?? ""}`;
    console.log(`SKILL_SHA256=${createHash("sha256").update(generated).digest("hex")}`);
    console.log("SKILL_REGISTRATION_RESULT=host apply registered the rendered collab-notes Skill in the isolated runtime registry");

    // Registration is observed through the actual host apply path. Actual DSH
    // discovery/load is validated separately against the rc.2 runtime registry.
    ok("host bridge registers the Notes surface", typeof handler === "function");
    ok("runtime registry has the expected Skill identity", registered?.name === "collab-notes" && registered?.source === "runtime");
    ok("runtime registry keeps the Skill description separate from its body", registered?.description?.length > 0 && !/^---\n/m.test(registered?.content ?? ""));
    ok("host apply does not create a user-root Skill file", await readFile(skillFile, "utf8").then(() => false, () => true));
    ok("generated Skill has valid name frontmatter", /^---\nname: collab-notes\n/.test(generated));
    ok("generated Skill quotes the description frontmatter", /^description: \"/m.test(generated));
    ok("generated Skill has no unresolved template placeholders", !/\{\{[^}]+\}\}/.test(generated));
    ok("generated Skill contains all four semantic lanes", [
      "conversation_todo", "deferred_work", "knowledge_candidate", "lesson_candidate",
    ].every((key) => generated.includes(key)));
    ok("generated Skill teaches the four logical Notes operations", [
      '`notes-read`: `{ "lane": "..." }`',
      '`notes-write`: `{ "lane": "...", "content": "..." }`',
      '`notes-edit`: `{ "lane": "...", "itemKey": "...", "content": "...", "expectedVersion": "..." }`',
      '`notes-source-reentry`: `{ "lane": "...", "itemKey": "..." }`',
    ].every((phrase) => generated.includes(phrase)));
    const readSchema = operationParameters("read");
    const writeSchema = operationParameters("write");
    const editSchema = operationParameters("edit");
    const sourceReentrySchema = operationParameters("source-reentry");
    const registeredByName = new Map(registeredTools.map((definition) => [definition.name, definition]));
    ok("host registers the four current logical Notes tools", ["notes-read", "notes-write", "notes-edit", "notes-source-reentry"].every((name) => registeredByName.has(name)));
    ok("generated Skill matches actual registered operation fields", JSON.stringify(registeredByName.get("notes-read")?.parameters) === JSON.stringify(readSchema) && JSON.stringify(registeredByName.get("notes-write")?.parameters) === JSON.stringify(writeSchema) && JSON.stringify(registeredByName.get("notes-edit")?.parameters) === JSON.stringify(editSchema) && JSON.stringify(registeredByName.get("notes-source-reentry")?.parameters) === JSON.stringify(sourceReentrySchema) && JSON.stringify(readSchema.required) === '["lane"]' && JSON.stringify(writeSchema.required) === '["lane","content"]' && JSON.stringify(editSchema.required) === '["lane","itemKey","content","expectedVersion"]' && JSON.stringify(sourceReentrySchema.required) === '["lane","itemKey"]' && !Object.hasOwn(editSchema.properties, "oldString") && !Object.hasOwn(editSchema.properties, "newString") && !Object.hasOwn(editSchema.properties, "replaceAll") && !Object.hasOwn(sourceReentrySchema.properties, "consent"));
    ok("generated Skill distinguishes itemKey from expectedVersion", /`itemKey` selects one exact Note/.test(generated) && /`expectedVersion` is the current ephemeral/.test(generated) && /not Note identity/.test(generated));
    ok("generated Skill preserves exact natural-language targeting", /exact internal key/.test(generated) && /If two Notes remain materially ambiguous/.test(generated) && /Do not ask the user for `itemKey`/.test(generated) && /Do not create a universal confirmation/.test(generated));
    ok("generated Skill describes bounded Source re-entry", /read-only operation for the current-holder\s+source-aware Note/.test(generated) && /contextWindow` is optional and controls the bounded local context returned by\s+the helper/.test(generated) && /persisted historical Source, which may\s+be in the current or another readable conversation/.test(generated) && /Do not provide consent/.test(generated));
    ok("generated Skill separates helper bounds from other authorized reads", /helper's window is not a limit/.test(generated) && /other normal, authorized\s+read capabilities/.test(generated) && /explicitly asks to inspect the\s+historical source or context/.test(generated));
    ok("generated Skill treats an explicit historical request as bounded authorization", /specific referenced Note/.test(generated) && /request itself is the bounded Notes authorization/.test(generated) && /Do not ask for a second Notes-specific\s+permission/.test(generated) && /separate host, workspace, or security policy/.test(generated));
    ok("generated Skill keeps historical Source failure truthful", /cannot read or verify the persisted Source/.test(generated) && /historical source failure does not authorize search or\s+rebind/.test(generated) && /rebind,\s+and any historical material remains separate from the original\s+provenance/.test(generated));
    ok("generated Skill prefers sufficient model-visible current context", /current model-visible context already contains sufficient task\s+content/.test(generated) && /do not reread history as a ritual/.test(generated) && /truncated, compacted,\s+uncertain/.test(generated));
    ok("generated Skill separates answer sufficiency from Source authority", /Content sufficient to answer a task is not by itself authoritative evidence/.test(generated) && /requires a claim about which conversation, round, or message/.test(generated) && /similar visible text, model\s+memory, current-conversation resemblance, or sourceSnapshot alone/.test(generated) && /persisted Source relationship and supported resolver first/.test(generated));
    ok("generated Skill reuses visible context after Source identity is established", /After authoritative Source identity is established/.test(generated) && /clearly\nthat same source exchange/.test(generated) && /use it directly rather than rereading the same\nhistory/.test(generated));
    ok("generated Skill does not auto-read historical source when unnecessary", /authored Note or persisted snapshot is sufficient/.test(generated) && /does not require the historical source/.test(generated) && /do not automatically read another\s+conversation merely because an Anchor exists/.test(generated));
    ok("generated Skill keeps historical reading separate from locator repair", /ordinary historical read may provide source-message contents/.test(generated) && /must not independently recompute the stored locator/.test(generated) && /infer a replacement\s+character range/.test(generated) && /override the Adapter\/Host exact-versus-broader receipt/.test(generated) && /not automatically the\nlocator coordinate basis/.test(generated));
    ok("generated Skill describes current-holder mechanical binding", /Host\/plugin mechanically binds the current holder/.test(generated) && /not arbitrary-target operations/.test(generated) && /Do not supply,\s+discover, or reconstruct a holder identity/.test(generated));
    ok("generated Skill permits explicit historical workspace material reads", /prohibition on filesystem discovery\/fallback applies to using physical Note\s+files as a substitute for current-holder Notes logical operations or mutations/.test(generated) && /explicitly asks to inspect historical Notes as workspace\s+material/.test(generated) && /ordinary read-only workspace search\/read may be used/.test(generated) && /do not change holder identity, authorize mutation, or create a Notes\s+cross-session logical API/.test(generated));
    ok("generated Skill has no obsolete physical addressing guidance", !/current-session-id|sessionId|notes\/<|notes\/conversation_todo\/|holder filename|physical Notes root/i.test(generated));
    ok("generated Skill keeps logical Notes discovery/fallback prohibition", /Do not choose a storage location/.test(generated) && /physical Note\s+files as a substitute for current-holder Notes logical operations or mutations/.test(generated) && /do not change holder identity, authorize mutation, or create a Notes\s+cross-session logical API/.test(generated));
    ok("generated Skill teaches setup-required behavior", generated.includes("NOTES_SETUP_REQUIRED") && generated.includes("one-time Notes setup") && /Ask the user to complete setup in\s+the Notes UI/.test(generated) && /`UNINITIALIZED` does not mean/.test(generated));
    ok("generated Skill keeps setup human/plugin-owned", generated.includes("Do not choose a storage location") && generated.includes("directory picker") && generated.includes("queued durable write"));
    ok("generated Skill teaches explicit user-led and Agent-assisted capture", /Capture is explicit and user-led/.test(generated) && /If the user explicitly asks the Agent to create a Note/.test(generated) && /Lane inference alone does not confer capture\s+authority/.test(generated));
    ok("generated Skill forbids silent capture and text-search rebind", /Do not silently turn ordinary conversation/.test(generated) && /Never use similarity or text search/.test(generated));
    ok("generated Skill keeps exact-source-first and non-exact outcomes", /persisted source and\s+locator relationship first/.test(generated) && /broader whole-message cue explicitly labeled non-exact/.test(generated));
    ok("generated Skill keeps cross-conversation access explicit and bounded", /Cross-conversation or cross-workspace retrieval must be explicit, bounded/.test(generated) && /one bounded retrieval does not create standing access/.test(generated) && /Reading or referencing does not\s+authorize editing/.test(generated));
    ok("generated Skill preserves read-before-write and stale retry", /perform `notes-read` immediately before `notes-edit`/.test(generated) && /FS_STALE_VERSION/.test(generated) && /Never blindly replay/.test(generated));
    ok("generated Skill teaches absent-lane and no unconditional create pre-read", /absent or empty lane/.test(generated) && /do not impose an\s+unconditional model-visible pre-read/.test(generated) && /creation is explicitly authorized/.test(generated));
    ok("generated Skill teaches source-aware edit preservation", /ordinary delegated edit of a source-aware Note/.test(generated) && /change only the\n\s*authored Note content/.test(generated) && /Do not recapture source/.test(generated) && /rewrite\nhistorical `S`/.test(generated));
    ok("generated Skill teaches authoritative success and localized refresh wording", /Only an authoritative successful `notes-write` or `notes-edit` result proves/.test(generated) && /first sentence uses an equivalent localized refresh prompt in the current\n\s*interaction language/.test(generated) && /In a Chinese interaction, use: \*\*已经更新，请刷新查看。\*\*/.test(generated) && /Do not claim that the currently\s+open panel has refreshed/.test(generated));
    ok("generated Skill distinguishes recording from endorsement and routing from dispatch", /recording it\ndoes not endorse/.test(generated) && /not a scheduler, dispatch queue/.test(generated) && /dispatch work from routing/.test(generated));
    ok("generated Skill keeps source context and carry independence", /task-appropriate surrounding context/.test(generated) && /child-local and independent/.test(generated) && /Fork\/carry routing is\nHost\/plugin responsibility/.test(generated));
    ok("generated Skill preserves L1 responsibility independence", /L1 is\nan optional shared representation; absence of an L1 Note does not remove or\ndischarge an existing conversational responsibility/.test(generated));
    ok("generated Skill preserves human/plugin UI creation", /A user may create or update a Note directly through the Notes UI without the\nAgent observing or entering that operation/.test(generated) && /Do not assume you have an Agent\nreceipt/.test(generated));
    ok("generated Skill preserves current-holder versus historical-source boundaries", /Current-holder binding selects which conversation\/session holder's local Note\nstate is current/.test(generated) && /does not rewrite capture origin, historical source\nidentity or locus/.test(generated) && /being current does\nnot make it a higher-authority instruction/.test(generated));
    ok("generated Skill preserves confirmation/deletion/closure boundary", generated.includes("must confirm") && generated.includes("explicit consent") && generated.includes("Closing a Note or task means"));
    ok("generated Skill treats UI receipt as narrower than agent evidence", /A UI result is evidence of the\s+UI outcome/.test(generated) && generated.includes("passing local test") && generated.includes("alone"));
    ok("generated Skill does not expose low-level implementation contracts", !/ACL|loader|DOM path|render-hint subsystem|storage-domain|temp-file/i.test(generated));
    ok("generated Skill does not expose an invented Notes-specific ACL/loader", !/ACL|loader|DOM path|render-hint subsystem/i.test(generated));
    // Exclude the dedicated prohibition section from affirmative guidance
    // checks. Its continuation lines intentionally contain the exact legacy
    // terms that the Skill forbids, and must not be mistaken for instructions.
    const affirmativeLines = generated.split("\n## Do NOT", 1)[0];
    ok("generated Skill has no affirmative obsolete edit inputs", !/notes-edit`[^\n]*(?:oldString|newString|replaceAll)/i.test(affirmativeLines) && !/(?:use|provide|supply|pass|target).*?(?:oldString|newString|replaceAll)/i.test(affirmativeLines));
    ok("generated Skill has no affirmative raw/path/search/rebind fallback", !/(?:use|mutate|target|fall back|fallback).*?(?:raw lane-body|direct file|physical path|text-search|content-index|hash targeting|source-locator|fuzzy|automatic rebind|automatic migration)/i.test(affirmativeLines));

    const base = `/notes-api/${SESSION}`;
    let state = await call(handler, request({
      method: "POST", url: `/notes-api/setup/${SESSION}`, headers: HOST,
      body: JSON.stringify({ action: "default" }),
    }));
    ok("actual host receipt: isolated Notes setup", state.code === 200 && JSON.parse(state.body).state === "INITIALIZED");

    state = await call(handler, request({ url: `${base}/${LANE}`, headers: HOST }));
    ok("actual host receipt: initial current-Note read", state.code === 200 && state.body === "");

    state = await call(handler, request({
      method: "PUT", url: `${base}/${LANE}`, headers: { ...HOST, "if-match": "0" }, body: "user-authored note",
    }));
    const firstVersion = state.headers["x-notes-mtime"];
    ok("actual host receipt: explicit create/save", state.code === 200 && Boolean(firstVersion));

    state = await call(handler, request({ url: `${base}/${LANE}`, headers: HOST }));
    ok("actual host receipt: read returns the saved Note", state.code === 200 && state.body === "user-authored note");

    state = await call(handler, request({
      method: "PUT", url: `${base}/${LANE}`, headers: { ...HOST, "if-match": firstVersion }, body: "user-authored note\nagent addition",
    }));
    const secondVersion = state.headers["x-notes-mtime"];
    ok("actual host receipt: observed edit succeeds", state.code === 200 && Boolean(secondVersion));

    state = await call(handler, request({
      method: "PUT", url: `${base}/${LANE}`, headers: { ...HOST, "if-match": firstVersion }, body: "stale overwrite",
    }));
    ok("actual host receipt: stale edit is rejected, not silently overwritten", state.code === 409 && state.body.includes("user-authored note"));

    // Deliberately do not simulate an agent, cross-session authority, fork, or
    // Source Anchor selection here: those are not honest zero-background tests.
    console.log("DEFERRED_AGENT_BEHAVIOR=LLM/session behavior, user-led browser capture, cross-session authority, fork/carry, and real runtime UI acceptance");
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(workspace, { recursive: true, force: true });
  }

  console.log(`RESULT=${passed} passed / ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
