// Workspace binding focused local tests.  These tests use a tiny fake host
// surface to exercise authority and sequencing without touching a real DSH
// home or a production runtime.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { tmpdir } from "node:os";
import { allocateFreshItemKey, createWorkspaceBindingRuntime, BINDING_DOMAIN_SPEC, NotesOperationError, isAbsoluteNotesPath } from "../lib/workspace-binding-runtime.js";
import { chooseNotesDirectory } from "../lib/notes-picker.js";
import { evaluateExactDerivation } from "../lib/carry-merge.js";
import { KIND_SOURCE_AWARE, KIND_SOURCE_INDEPENDENT, makeItem, parseLaneBody, serializeItem, withItemKey } from "../lib/structured-item.js";

const SID_A = "session-workspace-binding-a-0001";
const SID_B = "session-workspace-binding-b-0001";
const LANE = "conversation_todo";

function makeDomain() {
  const records = new Map();
  const table = {
    get: (key) => records.get(key),
    async put(key, value) { records.set(key, { ...value }); },
  };
  return { records, open: async (spec) => { assert.equal(spec.name, BINDING_DOMAIN_SPEC.name); return { table: () => table }; } };
}

function makeFs(root, events, observations) {
  const versions = new Map();
  const resolveTarget = async (file) => ({ targetKey: file, displayPath: file });
  const statTarget = async (target) => {
    const item = versions.get(target.targetKey);
    return item ? { version: item.version, size: Buffer.byteLength(item.content) } : undefined;
  };
  return {
    async resolve(file) { return resolveTarget(file); },
    async stat(target) { return statTarget(target); },
    async readText(target) {
      const item = versions.get(target.targetKey);
      if (!item) { const error = new Error("missing"); error.code = "ENOENT"; throw error; }
      return item.content;
    },
    async writeText(target, content, expected) {
      const beforeWrite = this._beforeWrite;
      if (beforeWrite) await beforeWrite(target, content, expected);
      const current = versions.get(target.targetKey);
      if (expected?.kind === "createIfAbsent" && current) { const e = new Error("unseen"); e.code = "FS_NOT_OBSERVED"; throw e; }
      if (expected?.kind === "replaceIfVersion" && (!current || current.version !== expected.version)) { const e = new Error("stale"); e.code = "FS_STALE_VERSION"; throw e; }
      const next = { version: String(Number(current?.version ?? 0) + 1), content };
      versions.set(target.targetKey, next);
      return { version: next.version };
    },
    async editText(target, edit, expected) {
      const current = versions.get(target.targetKey);
      if (!current || (expected && expected.version !== current.version)) { const e = new Error("stale"); e.code = "FS_STALE_VERSION"; throw e; }
      if (!current.content.includes(edit.oldString)) { const e = new Error("not found"); e.code = "FS_NOT_FOUND"; throw e; }
      const content = edit.replaceAll ? current.content.split(edit.oldString).join(edit.newString) : current.content.replace(edit.oldString, edit.newString);
      const next = { version: String(Number(current.version) + 1), content };
      versions.set(target.targetKey, next);
      return { version: next.version };
    },
    async withLock(_key, fn) { return fn(); },
    _versions: versions,
    _events: events,
    _observations: observations,
    _beforeWrite: null,
  };
}

function makeCtx(root, domain, fs, tools) {
  const sessions = new Map([
    [SID_A, { id: SID_A, header: { cwd: root } }],
    [SID_B, { id: SID_B, header: { cwd: root } }],
  ]);
  const workspace = { id: "workspace-workspace-binding", path: root };
  return {
    get: (key) => key === "sessions" ? sessions : undefined,
    storageDomain: domain,
    workspaceRegistry: { resolveByPath: async () => workspace },
    fs,
    tools: { register(def) { tools.push(def); return () => {}; } },
    async waterfall(name, target, exec, fallback) {
      const current = await fs.stat(target);
      const observed = exec.agent.observed?.get(target.targetKey);
      if (name === "fs/write-intent") {
        if (!observed) { const e = new Error("not observed"); e.code = "FS_NOT_OBSERVED"; throw e; }
        if (!current) {
          if (observed.kind !== "absent") { const e = new Error("stale"); e.code = "FS_STALE_VERSION"; throw e; }
          return { kind: "createIfAbsent" };
        }
        if (observed.kind !== "present" || observed.version !== current.version) { const e = new Error("stale"); e.code = "FS_STALE_VERSION"; throw e; }
        return { kind: "replaceIfVersion", version: observed.version };
      }
      if (!current || !observed) { const e = new Error("not observed"); e.code = "FS_NOT_OBSERVED"; throw e; }
      if (observed.kind !== "present" || observed.version !== current.version) { const e = new Error("stale"); e.code = "FS_STALE_VERSION"; throw e; }
      return { kind: "replaceIfVersion", version: observed.version };
    },
    emit(name, target, observation, exec) {
      fs._events.push({ name, targetKey: target.targetKey, observation, actor: exec?.agent });
      exec.agent.observed ??= new Map();
      exec.agent.observed.set(target.targetKey, observation);
    },
  };
}

async function main() {
  // The test host is macOS, so exercise the same helper with both platform
  // path implementations.  The production call uses node:path for the
  // running host; this matrix prevents a separator-prefix regression from
  // rejecting Windows drive-qualified picker results.
  assert.equal(isAbsoluteNotesPath("C:\\workspace\\notes", win32), true);
  assert.equal(isAbsoluteNotesPath("C:\\workspace\\notes", posix), false);
  assert.equal(isAbsoluteNotesPath("C:\\Workspace With Space\\资料\\test1\\notes", win32), true);
  assert.equal(isAbsoluteNotesPath("/workspace/notes", posix), true);
  assert.equal(isAbsoluteNotesPath("notes", posix), false);

  let allocationCalls = 0;
  assert.equal(
    allocateFreshItemKey(new Set(["ik-existing"]), () => ["ik-existing", "ik-new"][allocationCalls++]),
    "ik-new",
  );
  assert.equal(allocationCalls, 2);
  assert.throws(
    () => allocateFreshItemKey(new Set(["ik-existing"]), () => "ik-existing"),
    (error) => error.code === "NOTES_ITEM_KEY_UNAVAILABLE",
  );

  let browseCalls = 0;
  let nativeCalls = 0;
  const browseListing = {
    path: "/selected",
    home: "/home/test-user",
    crumbs: [{ name: "Home", path: "/home/test-user", hidden: false }, { name: "selected", path: "/selected", hidden: false }],
    entries: [{ name: "child", path: "/selected/child", hidden: false }],
    truncated: false,
  };
  const picked = await chooseNotesDirectory({
    async listDirectory(path) { browseCalls++; assert.equal(path, "/selected"); return browseListing; },
    async pickDirectory() { nativeCalls++; return "/native"; },
  }, { startPath: "/selected" });
  assert.equal(picked.mode, "browse");
  assert.equal(picked.listing, browseListing);
  assert.equal(browseCalls, 1);
  assert.equal(nativeCalls, 0);
  const unavailable = new Error("typed unavailable");
  unavailable.rpcError = { code: "directory-picker/unavailable" };
  const native = await chooseNotesDirectory({
    async listDirectory() { throw unavailable; },
    async pickDirectory() { nativeCalls++; return "/native"; },
  });
  assert.equal(native.mode, "native");
  assert.equal(native.path, "/native");
  assert.equal(nativeCalls, 1);
  const cancelledNative = await chooseNotesDirectory({
    async listDirectory() { throw unavailable; },
    async pickDirectory() { nativeCalls++; return null; },
  });
  assert.deepEqual(cancelledNative, { mode: "cancelled" });
  assert.equal(nativeCalls, 2);
  const legacyUnavailable = new Error("legacy browse unavailable");
  legacyUnavailable.rpcError = { code: "directory-picker-unavailable" };
  const legacyNative = await chooseNotesDirectory({
    async listDirectory() { throw legacyUnavailable; },
    async pickDirectory() { return "/legacy-native"; },
  });
  assert.deepEqual(legacyNative, { mode: "native", path: "/legacy-native" });
  const browseFailure = new Error("real browse failure");
  browseFailure.rpcError = { code: "permission-denied" };
  await assert.rejects(() => chooseNotesDirectory({ async listDirectory() { throw browseFailure; }, async pickDirectory() { nativeCalls++; } }), /real browse failure/);
  assert.equal(nativeCalls, 2);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await chooseNotesDirectory({ async listDirectory() { throw new Error("aborted"); }, async pickDirectory() { nativeCalls++; } }, { signal: controller.signal });
  assert.equal(cancelled.mode, "cancelled");
  assert.equal(nativeCalls, 2);

  const root = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-"));
  const domain = makeDomain();
  const events = [];
  const fs = makeFs(root, events, []);
  const tools = [];
  const ctx = makeCtx(root, domain, fs, tools);
  const generatedKeys = ["ik-existing", "ik-existing", "ik-new"];
  const runtime = createWorkspaceBindingRuntime(ctx, { keyGenerator: () => generatedKeys.shift() ?? `ik-fallback-${Date.now()}` });
  assert.ok(runtime);
  runtime.registerTools();
  assert.deepEqual(tools.map((d) => d.name), ["notes-read", "notes-write", "notes-edit", "notes-source-reentry"]);
  const schemas = Object.fromEntries(tools.map((d) => [d.name, JSON.stringify(d.parameters).toLowerCase()]));
  assert.equal(schemas["notes-edit"].includes("oldstring"), false);
  assert.equal(schemas["notes-edit"].includes("replaceall"), false);
  assert.equal(schemas["notes-edit"].includes("itemkey"), true);
  assert.equal(schemas["notes-edit"].includes("expectedversion"), true);
  assert.equal(schemas["notes-source-reentry"].includes("contextwindow"), true);
  assert.equal(schemas["notes-source-reentry"].includes("consent"), false);
  const sourceReentry = tools.find((definition) => definition.name === "notes-source-reentry");
  assert.deepEqual(sourceReentry.parameters.properties.contextWindow, { type: "integer" });
  assert.deepEqual(sourceReentry.output.schema.properties.contextWindow, { type: "integer" });
  for (const definition of tools) {
    const schema = JSON.stringify(definition.parameters).toLowerCase();
    for (const forbidden of ["path", "workspace", "sessionid", "holder", "alternate"]) assert.equal(schema.includes(forbidden), false, `${definition.name} leaks ${forbidden}`);
  }

  assert.deepEqual(await runtime.setupState(SID_A), { state: "UNINITIALIZED", legacy: false, proposedPath: join(root, "notes"), browseStartPath: root });
  const rootBeforeSetup = await (await import("node:fs/promises")).readdir(root);
  const agentA = { id: SID_A, session: { id: SID_A, header: { cwd: root } } };
  const execA = { agent: agentA, signal: new AbortController().signal };
  await assert.rejects(() => tools[0].execute({ lane: LANE, path: "/forbidden" }, execA), (error) => error.code === "NOTES_INVALID_ARGUMENT");
  await assert.rejects(() => tools[2].execute({ lane: LANE, itemKey: "ik-missing", content: "x", expectedVersion: "0", oldString: "legacy" }, execA), (error) => error.code === "NOTES_INVALID_ARGUMENT");
  await assert.rejects(() => tools[1].execute({ lane: LANE }, execA), (error) => error.code === "NOTES_INVALID_ARGUMENT");
  await assert.rejects(() => tools[0].execute({ lane: LANE }, execA), (error) => error.code === "NOTES_SETUP_REQUIRED");
  assert.equal(domain.records.size, 0);
  assert.deepEqual(await (await import("node:fs/promises")).readdir(root), rootBeforeSetup);

  await runtime.bind(SID_A, "default");
  assert.deepEqual(await runtime.setupState(SID_A), { state: "INITIALIZED", legacy: false });
  assert.deepEqual(await (await import("node:fs/promises")).readdir(root), rootBeforeSetup);
  await mkdir(join(root, "notes", LANE), { recursive: true });
  const agentTool = tools.find((d) => d.name === "notes-write");
  const readTool = tools.find((d) => d.name === "notes-read");
  const editTool = tools.find((d) => d.name === "notes-edit");
  const currentFile = join(root, "notes", LANE, `${SID_A}.md`);
  for (const invalidContent of ["", " \t\n "]) {
    await assert.rejects(
      () => agentTool.execute({ lane: LANE, content: invalidContent }, execA),
      (error) => error.code === "NOTES_INVALID_ARGUMENT",
    );
    assert.equal(fs._versions.has(currentFile), false, "rejected empty create must not create a file/item");
  }
  const initial = await readTool.execute({ lane: LANE }, execA);
  assert.equal(initial.status, "absent");
  const writeResult = await agentTool.execute({ lane: LANE, content: "A" }, execA);
  assert.equal(writeResult.status, "created");
  assert.match(writeResult.itemKey, /^ik-/);
  assert.equal(events.at(-1).observation.kind, "present");
  assert.equal(events.at(-1).actor, agentA);
  const readResult = await readTool.execute({ lane: LANE }, execA);
  assert.equal(readResult.notes.length, 1);
  assert.deepEqual(readResult.notes[0], { addressable: true, itemKey: writeResult.itemKey, kind: KIND_SOURCE_INDEPENDENT, authored: "A" });
  assert.equal(events.at(-1).observation.kind, "present");
  const collisionCreate = await agentTool.execute({ lane: LANE, content: "collision retry" }, execA);
  assert.equal(collisionCreate.itemKey, "ik-new");
  const expectedVersion = (await readTool.execute({ lane: LANE }, execA)).version;
  const beforeRejectedEdits = fs._versions.get(currentFile);
  for (const invalidContent of ["", " \t\n "]) {
    await assert.rejects(
      () => editTool.execute({ lane: LANE, itemKey: writeResult.itemKey, content: invalidContent, expectedVersion }, execA),
      (error) => error.code === "NOTES_INVALID_ARGUMENT",
    );
    assert.deepEqual(fs._versions.get(currentFile), beforeRejectedEdits, "rejected source-independent edit must preserve the item/file");
  }
  const edited = await editTool.execute({ lane: LANE, itemKey: writeResult.itemKey, content: "B", expectedVersion }, execA);
  assert.equal(edited.status, "updated");
  assert.equal(edited.itemKey, writeResult.itemKey);
  const afterEdit = await readTool.execute({ lane: LANE }, execA);
  assert.equal(afterEdit.notes[0].authored, "B");
  assert.notEqual(afterEdit.version, expectedVersion);
  await assert.rejects(
    () => editTool.execute({ lane: LANE, itemKey: writeResult.itemKey, content: "stale", expectedVersion }, execA),
    (error) => error.code === "FS_STALE_VERSION",
  );
  const sourceItem = withItemKey(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID_A, snapshot: "SNAPSHOT", comment: "source authored", sourcePayload: { projectionVersion: 2, sessionId: SID_A, segments: [{ eventSeq: 1, start: 0, end: 8 }] } }), "ik-source");
  fs._versions.set(currentFile, { version: String(Number(afterEdit.version) + 1), content: [fs._versions.get(currentFile).content, serializeItem(sourceItem)].join("\n\n") });
  const sourceRead = await readTool.execute({ lane: LANE }, execA);
  assert.deepEqual(sourceRead.notes.at(-1), { addressable: true, itemKey: "ik-source", kind: KIND_SOURCE_AWARE, authored: "source authored", sourceSnapshot: "SNAPSHOT" });
  const sourceVersion = sourceRead.version;
  const sourceBody = fs._versions.get(currentFile).content;
  const sourceBeforeItem = parseLaneBody(sourceBody).nodes.find((node) => node.type === "item" && node.item.comment === "source authored").item;
  const sourceEmptyEdited = await editTool.execute({ lane: LANE, itemKey: "ik-source", content: "", expectedVersion: sourceVersion }, execA);
  assert.equal(sourceEmptyEdited.status, "updated");
  const sourceAfterEmpty = fs._versions.get(currentFile).content;
  const sourceAfterEmptyItem = parseLaneBody(sourceAfterEmpty).nodes.find((node) => node.type === "item" && node.item.sourcePayload)?.item;
  assert.equal(sourceAfterEmptyItem.comment ?? "", "");
  assert.equal(sourceAfterEmptyItem.snapshot, "SNAPSHOT");
  assert.deepEqual(sourceAfterEmptyItem.sourcePayload, sourceBeforeItem.sourcePayload);
  assert.equal(sourceAfterEmptyItem.captureOrigin, sourceBeforeItem.captureOrigin);
  assert.deepEqual(sourceAfterEmptyItem.unknownMeta, sourceBeforeItem.unknownMeta);
  assert.equal(sourceAfterEmptyItem.metaOrder.some((entry) => entry.kind === "known" && entry.key === "comment-length"), false);
  const sourceEdited = await editTool.execute({ lane: LANE, itemKey: "ik-source", content: "updated source authored", expectedVersion: sourceEmptyEdited.version }, execA);
  assert.equal(sourceEdited.status, "updated");
  const sourceAfter = fs._versions.get(currentFile).content;
  assert.equal(sourceAfter.includes("SNAPSHOT"), true);
  assert.equal(sourceAfter.includes("updated source authored"), true);
  assert.equal(sourceAfter.includes("source-payload"), true);
  assert.notEqual(sourceAfter, sourceBody);
  const sourceAfterItem = parseLaneBody(sourceAfter).nodes.find((node) => node.type === "item" && node.item.comment === "updated source authored").item;
  assert.deepEqual(sourceAfterItem.unknownMeta, sourceBeforeItem.unknownMeta);
  assert.deepEqual(sourceAfterItem.metaOrder, sourceBeforeItem.metaOrder);
  assert.equal(sourceAfterItem.captureOrigin, sourceBeforeItem.captureOrigin);
  assert.deepEqual(sourceAfterItem.sourcePayload, sourceBeforeItem.sourcePayload);
  fs._beforeWrite = () => {
    fs._versions.set(currentFile, { version: "race", content: "competing writer" });
    fs._beforeWrite = null;
  };
  await assert.rejects(() => agentTool.execute({ lane: LANE, content: "must not win" }, execA), (error) => error.code === "FS_STALE_VERSION");
  assert.equal(fs._versions.get(currentFile).content, "competing writer");

  fs._versions.set(currentFile, { version: "10", content: [
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "dup one" }), "ik-dup")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "dup two" }), "ik-dup")),
  ].join("\n\n") });
  const duplicateRead = await readTool.execute({ lane: LANE }, execA);
  assert.equal(duplicateRead.notes.every((note) => note.addressable === false), true);
  await assert.rejects(() => editTool.execute({ lane: LANE, itemKey: "ik-dup", content: "no", expectedVersion: duplicateRead.version }, execA), (error) => error.code === "NOTES_ITEM_AMBIGUOUS");

  fs._versions.set(currentFile, { version: "11", content: [
    "before legacy",
    "--- dsh-note v1 begin",
    "dsh-meta kind: source-independent",
    "dsh-meta origin: session-workspace-binding-a-0001",
    "dsh-meta body-length: 10",
    "--- dsh-body",
    "short",
    "--- dsh-note v1 end",
    "after legacy",
  ].join("\n") });
  const malformedRead = await readTool.execute({ lane: LANE }, execA);
  assert.deepEqual(malformedRead.notes, [
    { addressable: false, kind: "legacy", authored: "before legacy" },
    { addressable: false, kind: "opaque-structured", reason: "malformed structured candidate" },
    { addressable: false, kind: "legacy", authored: "after legacy" },
  ]);
  fs._versions.set(currentFile, { version: "12", content: "inline marker --- dsh-note v1 begin remains authored" });
  const inlineRead = await readTool.execute({ lane: LANE }, execA);
  assert.deepEqual(inlineRead.notes, [{ addressable: false, kind: "legacy", authored: "inline marker --- dsh-note v1 begin remains authored" }]);

  const agentB = { id: SID_B, session: { id: SID_B, header: { cwd: root } } };
  const execB = { agent: agentB, signal: new AbortController().signal };
  const missing = await readTool.execute({ lane: LANE }, execB);
  assert.deepEqual(missing, { status: "absent", lane: LANE, notes: [] });
  assert.equal(events.at(-1).observation.kind, "absent");
  assert.equal(events.at(-1).actor, agentB);
  const createdB = await agentTool.execute({ lane: LANE, content: "B" }, execB);
  assert.equal(createdB.status, "created");
  const bRead = await readTool.execute({ lane: LANE }, execB);
  assert.equal(bRead.notes[0].authored, "B");
  const logical = new NotesOperationError("FS_STALE_VERSION", "FS_STALE_VERSION", { displayPath: join(root, "notes", LANE, SID_A + ".md") });
  assert.equal(runtime.redact(logical.displayPath).includes(root), false);

  const legacyRoot = await mkdtemp(join(tmpdir(), "dsh-notes-legacy-"));
  const legacyDomain = makeDomain();
  const legacyFs = makeFs(legacyRoot, [], []);
  const legacyTools = [];
  const legacyCtx = makeCtx(legacyRoot, legacyDomain, legacyFs, legacyTools);
  await mkdir(join(legacyRoot, "notes", LANE), { recursive: true });
  await writeFile(join(legacyRoot, "notes", LANE, `${SID_A}.md`), "legacy", "utf8");
  const legacyRuntime = createWorkspaceBindingRuntime(legacyCtx);
  assert.deepEqual(await legacyRuntime.setupState(SID_A), { state: "UNINITIALIZED", legacy: true, proposedPath: join(legacyRoot, "notes"), browseStartPath: join(legacyRoot, "notes") });
  await assert.rejects(() => legacyRuntime.bind(SID_A, "default"), (error) => error.code === "NOTES_LEGACY_ADOPTION_REQUIRED");
  await assert.rejects(() => legacyRuntime.bind(SID_A, "adopt", join(legacyRoot, "notes")), (error) => error.code === "NOTES_LEGACY_ADOPTION_REQUIRED");
  await legacyRuntime.bind(SID_A, "adopt");
  assert.equal(await readFile(join(legacyRoot, "notes", LANE, `${SID_A}.md`), "utf8"), "legacy");
  await assert.rejects(() => legacyRuntime.bind(SID_A, "custom", join(legacyRoot, "other")), (error) => error.code === "NOTES_ALREADY_INITIALIZED");

  const occupiedRoot = await mkdtemp(join(tmpdir(), "dsh-notes-occupied-"));
  const occupiedDomain = makeDomain();
  const occupiedFs = makeFs(occupiedRoot, [], []);
  const occupiedTools = [];
  const occupiedRuntime = createWorkspaceBindingRuntime(makeCtx(occupiedRoot, occupiedDomain, occupiedFs, occupiedTools));
  const occupiedPath = join(occupiedRoot, "custom");
  await mkdir(join(occupiedPath, LANE), { recursive: true });
  const occupiedFile = join(occupiedPath, LANE, `${SID_A}.md`);
  await writeFile(occupiedFile, "unrelated data", "utf8");
  assert.deepEqual(await occupiedRuntime.setupState(SID_A), { state: "UNINITIALIZED", legacy: false, proposedPath: join(occupiedRoot, "notes"), browseStartPath: occupiedRoot });
  await assert.rejects(() => occupiedRuntime.bind(SID_A, "custom", occupiedPath), (error) => error.code === "NOTES_LOCATION_OCCUPIED");
  assert.equal(await readFile(occupiedFile, "utf8"), "unrelated data");
  assert.equal(occupiedDomain.records.size, 0);

  const carryMarker = { version: 2, parentSessionId: SID_B, status: "carried", bindings: { [LANE]: ["ik-carried", "ik-chain"] } };
  const markerFor = {
    "ik-carried": carryMarker,
    "ik-chain": carryMarker,
    "ik-legacy": { version: 1, parentSessionId: SID_B, status: "carried" },
    "ik-wrong-parent": { ...carryMarker, parentSessionId: "session-other-0001" },
    "ik-unresolved": { ...carryMarker, status: "unresolved" },
    "ik-unbound": { ...carryMarker, bindings: { [LANE]: ["another-key"] } },
  };
  const projectionTools = [];
  const projectionRuntime = createWorkspaceBindingRuntime({ ...ctx, tools: { register(definition) { projectionTools.push(definition); return () => {}; } } }, {
    resolveExactCarry: ({ itemKey, itemKeyOccurrences, lane }) => {
      const marker = markerFor[itemKey];
      const result = evaluateExactDerivation({
        headerParentSession: SID_B,
        marker,
        lane,
        itemKey,
        itemKeyOccurrences,
      });
      return result.ok ? SID_B : null;
    },
  });
  projectionRuntime.registerTools();
  const projectionRead = projectionTools.find((definition) => definition.name === "notes-read");
  const projectionBody = [
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "native" }), "ik-native")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "carried" }), "ik-carried")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: "foreign-origin", comment: "foreign" }), "ik-foreign")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "legacy" }), "ik-legacy")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "wrong parent" }), "ik-wrong-parent")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "unresolved" }), "ik-unresolved")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "unbound" }), "ik-unbound")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "chain" }), "ik-chain")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "duplicate one" }), "ik-duplicate")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: SID_A, comment: "duplicate two" }), "ik-duplicate")),
    serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID_A, snapshot: "S", comment: "anchored", sourcePayload: { projectionVersion: 2, sessionId: SID_A, segments: [{ eventSeq: 1, start: 0, end: 1 }] } }), "ik-anchored")),
  ].join("\n\n");
  fs._versions.set(currentFile, { version: "13", content: projectionBody });
  const projectionResult = await projectionRead.execute({ lane: LANE }, execA);
  const byKey = Object.fromEntries(projectionResult.notes.filter((note) => note.itemKey).map((note) => [note.itemKey, note]));
  assert.equal(byKey["ik-native"].carriedFromSession, undefined);
  assert.equal(byKey["ik-carried"].carriedFromSession, SID_B);
  assert.equal(byKey["ik-foreign"].carriedFromSession, undefined);
  assert.equal(byKey["ik-legacy"].carriedFromSession, undefined);
  assert.equal(byKey["ik-wrong-parent"].carriedFromSession, undefined);
  assert.equal(byKey["ik-unresolved"].carriedFromSession, undefined);
  assert.equal(byKey["ik-unbound"].carriedFromSession, undefined);
  assert.equal(byKey["ik-chain"].carriedFromSession, SID_B, "A→B→C exposes only immediate B");
  assert.equal(byKey["ik-anchored"].carriedFromSession, undefined);
  assert.equal(byKey["ik-duplicate"].addressable, false);
  assert.equal(byKey["ik-duplicate"].carriedFromSession, undefined);

  const outputSchema = projectionRead.output.schema.properties.notes.items.properties;
  assert.deepEqual(outputSchema.carriedFromSession, { type: "string" });

  await projectionRuntime.close?.();
  await rm(occupiedRoot, { recursive: true, force: true });
  await rm(legacyRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  console.log("workspace binding focused tests: PASS");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
