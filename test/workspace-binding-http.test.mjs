// Workspace binding host-route integration tests: the setup binding is exercised through
// the same HTTP surface used by the Notes client, with a real local fs service.
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { apply } from "../lib/index.js";

const SESSION = "session-workspace-binding-http-0001";
const LANE = "conversation_todo";

function request(method, url, body, headers = {}) {
  const bytes = body == null ? [] : [Buffer.from(String(body))];
  return {
    method,
    url,
    headers,
    resume() {},
    [Symbol.asyncIterator]: async function* () { for (const chunk of bytes) yield chunk; },
  };
}

function response() {
  const state = { code: 200, headers: {}, body: "" };
  return {
    writeHead(code, headers = {}) { state.code = code; state.headers = headers; },
    end(body) { state.body = body ?? ""; },
    state,
  };
}

async function call(handler, req) {
  const res = response();
  await handler(req, res);
  return res.state;
}

async function makeServer(root, workspaceId = "workspace-workspace-binding-http") {
  const records = new Map();
  const table = {
    get: (key) => records.get(key),
    async put(key, value) { records.set(key, { ...value }); },
  };
  const sessions = new Map([[SESSION, { id: SESSION, header: { cwd: root } }]]);
  const app = new Context();
  const fs = new LocalFileSystem(app, { cwd: root, diffBasisMaxBytes: 1024 * 1024 });
  let handler;
  const ctx = {
    fs,
    storageDomain: { open: async () => ({ table: () => table }) },
    workspaceRegistry: { resolveByPath: async () => ({ id: workspaceId, path: root }) },
    tools: { register: () => () => {} },
    get(name) { return name === "sessions" ? sessions : undefined; },
    webServer: { register: (config) => { handler = config.handler; } },
    on() {},
    logger: { info() {}, error() {} },
  };
  const oldCandidateBoot = process.env.DSH_CANDIDATE_BOOT;
  process.env.DSH_CANDIDATE_BOOT = "1";
  try { await apply(ctx); }
  finally {
    if (oldCandidateBoot === undefined) delete process.env.DSH_CANDIDATE_BOOT;
    else process.env.DSH_CANDIDATE_BOOT = oldCandidateBoot;
  }
  return { handler, records, root, sessions };
}

async function jsonCall(server, req) {
  const state = await call(server.handler, req);
  return { state, body: JSON.parse(String(state.body || "{}")) };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-http-"));
  try {
    const server = await makeServer(root);
    const setupBefore = await jsonCall(server, request("GET", `/notes-api/setup/${SESSION}`));
    assert.deepEqual(setupBefore.body, { ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: join(root, "notes"), browseStartPath: root });
    const laneBefore = await jsonCall(server, request("GET", `/notes-api/${SESSION}/${LANE}`));
    assert.equal(laneBefore.state.code, 428);
    assert.equal(laneBefore.body.code, "NOTES_SETUP_REQUIRED");
    const uninitializedChild = "session-workspace-binding-http-uninitialized-child-0001";
    server.sessions.set(uninitializedChild, { id: uninitializedChild, header: { cwd: root, parentSession: SESSION } });
    const uninitializedFork = await jsonCall(server, request("GET", `/notes-api/fork-status?sessionId=${uninitializedChild}`));
    assert.equal(uninitializedFork.state.code, 428);
    assert.equal(uninitializedFork.body.code, "NOTES_SETUP_REQUIRED");
    assert.deepEqual(await readdir(root), []);

    // Host setup must enforce the action/path matrix, not only the UI's
    // currently generated combinations.
    const defaultWithPath = await jsonCall(server, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "default", path: join(root, "smuggled") })));
    assert.equal(defaultWithPath.state.code, 409);
    assert.equal(defaultWithPath.body.code, "NOTES_LOCATION_INVALID");
    const customWithoutPath = await jsonCall(server, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "custom" })));
    assert.equal(customWithoutPath.state.code, 409);
    assert.equal(customWithoutPath.body.code, "NOTES_LOCATION_INVALID");
    const adoptWithoutLegacy = await jsonCall(server, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "adopt" })));
    assert.equal(adoptWithoutLegacy.state.code, 409);
    assert.equal(adoptWithoutLegacy.body.code, "NOTES_LEGACY_ADOPTION_REQUIRED");

    // Setup must reject collisions in the fixed Notes layout before the
    // workspace binding is committed.  These cases must remain harmless to
    // any target outside the selected root.
    const invalidLayoutCases = [
      {
        name: "reserved lane symlink",
        async prepare(root) {
          const outside = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-outside-lane-"));
          const sentinel = join(outside, "sentinel.md");
          await writeFile(sentinel, "outside", "utf8");
          await symlink(outside, join(root, LANE), "dir");
          return { path: sentinel, content: "outside", cleanup: () => rm(outside, { recursive: true, force: true }) };
        },
      },
      {
        name: "reserved lane regular file",
        async prepare(root) {
          const lane = join(root, LANE);
          await writeFile(lane, "lane collision", "utf8");
          return { path: lane, content: "lane collision" };
        },
      },
      {
        name: "lane Markdown symlink",
        async prepare(root) {
          const lane = join(root, LANE);
          const outside = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-outside-markdown-"));
          const target = join(outside, "outside.md");
          await mkdir(lane);
          await writeFile(target, "outside", "utf8");
          await symlink(target, join(lane, "escape.md"));
          return { path: target, content: "outside", cleanup: () => rm(outside, { recursive: true, force: true }) };
        },
      },
      {
        name: "lane Markdown directory",
        async prepare(root) {
          await mkdir(join(root, LANE, "nested.md"), { recursive: true });
        },
      },
      {
        name: "carry-over marker symlink",
        async prepare(root) {
          const carry = join(root, ".carry-over");
          const outside = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-outside-marker-"));
          const target = join(outside, "outside.json");
          await mkdir(carry);
          await writeFile(target, "outside", "utf8");
          await symlink(target, join(carry, "session-child-0001.json"));
          return { path: target, content: "outside", cleanup: () => rm(outside, { recursive: true, force: true }) };
        },
      },
      {
        name: "carry-over marker directory",
        async prepare(root) {
          await mkdir(join(root, ".carry-over", "session-child-0002.json"), { recursive: true });
        },
      },
      {
        name: "carry-over regular file",
        async prepare(root) {
          const carry = join(root, ".carry-over");
          await writeFile(carry, "carry collision", "utf8");
          return { path: carry, content: "carry collision" };
        },
      },
    ];
    for (const [index, testCase] of invalidLayoutCases.entries()) {
      const invalidRoot = await mkdtemp(join(tmpdir(), `dsh-notes-workspace-binding-invalid-layout-${index}-`));
      const invalidWorkspace = await mkdtemp(join(tmpdir(), `dsh-notes-workspace-binding-invalid-workspace-${index}-`));
      let prepared;
      try {
        prepared = await testCase.prepare(invalidRoot);
        const invalidWorkspaceId = `workspace-workspace-binding-invalid-${index}`;
        const invalidServer = await makeServer(invalidWorkspace, invalidWorkspaceId);
        const attempt = await jsonCall(invalidServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "custom", path: invalidRoot })));
        assert.equal(attempt.state.code, 409, testCase.name);
        assert.equal(attempt.body.code, "NOTES_LOCATION_INVALID", testCase.name);
        assert.equal(invalidServer.records.has(invalidWorkspaceId), false, testCase.name);
        const status = await jsonCall(invalidServer, request("GET", `/notes-api/setup/${SESSION}`));
        assert.deepEqual(status.body, { ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: join(invalidWorkspace, "notes"), browseStartPath: invalidWorkspace }, testCase.name);
        if (prepared) assert.equal(await readFile(prepared.path, "utf8"), prepared.content, testCase.name);
      } finally {
        await prepared?.cleanup?.();
        await rm(invalidRoot, { recursive: true, force: true });
        await rm(invalidWorkspace, { recursive: true, force: true });
      }
    }

    // A valid binding must remain safe if the old predictable temp name is
    // introduced after setup. The marker writer must not follow it.
    const postBindingRoot = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-post-binding-tmp-root-"));
    const postBindingWorkspace = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-post-binding-workspace-"));
    const postBindingOutside = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-post-binding-outside-"));
    try {
      const childId = "session-workspace-binding-http-temp-child-0001";
      const outside = join(postBindingOutside, "sentinel.json");
      await writeFile(outside, "outside", "utf8");
      const postBindingServer = await makeServer(postBindingWorkspace, "workspace-workspace-binding-post-binding-tmp");
      const postBinding = await jsonCall(postBindingServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "custom", path: postBindingRoot })));
      assert.deepEqual(postBinding.body, { ok: true, state: "INITIALIZED", legacy: false });
      const carryDir = join(postBindingRoot, ".carry-over");
      const predictableTmp = join(carryDir, `${childId}.json.tmp`);
      await mkdir(carryDir, { recursive: true });
      await symlink(outside, predictableTmp);
      postBindingServer.sessions.set(childId, { id: childId, header: { cwd: postBindingWorkspace, parentSession: SESSION } });
      const forkStatus = await jsonCall(postBindingServer, request("GET", `/notes-api/fork-status?sessionId=${childId}`));
      assert.equal(forkStatus.state.code, 200);
      assert.equal(forkStatus.body.status, "unresolved");
      assert.equal(await readFile(outside, "utf8"), "outside");
      assert.equal((await lstat(predictableTmp)).isSymbolicLink(), true);
      assert.equal((await lstat(join(carryDir, `${childId}.json`))).isFile(), true);
    } finally {
      await rm(postBindingRoot, { recursive: true, force: true });
      await rm(postBindingWorkspace, { recursive: true, force: true });
      await rm(postBindingOutside, { recursive: true, force: true });
    }

    const bound = await jsonCall(server, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "default" })));
    assert.deepEqual(bound.body, { ok: true, state: "INITIALIZED", legacy: false });
    assert.equal(server.records.get("workspace-workspace-binding-http").path, join(root, "notes"));
    const stillInitialized = await jsonCall(server, request("GET", `/notes-api/setup/${SESSION}`));
    assert.deepEqual(stillInitialized.body, { ok: true, state: "INITIALIZED", legacy: false });

    const put = await call(server.handler, request("PUT", `/notes-api/${SESSION}/${LANE}`, "human note", { "if-match": "0" }));
    assert.equal(put.code, 200);
    assert.equal(await readFile(join(root, "notes", LANE, `${SESSION}.md`), "utf8"), "human note");

    const legacyRoot = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-legacy-http-"));
    try {
      await mkdir(join(legacyRoot, "notes", LANE), { recursive: true });
      const legacyFile = join(legacyRoot, "notes", LANE, `${SESSION}.md`);
      await writeFile(legacyFile, "legacy note", "utf8");
      const legacyServer = await makeServer(legacyRoot, "workspace-workspace-binding-legacy-http");
      const legacySetup = await jsonCall(legacyServer, request("GET", `/notes-api/setup/${SESSION}`));
      assert.deepEqual(legacySetup.body, { ok: true, state: "UNINITIALIZED", legacy: true, proposedPath: join(legacyRoot, "notes"), browseStartPath: join(legacyRoot, "notes") });
      const defaultAttempt = await jsonCall(legacyServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "default" })));
      assert.equal(defaultAttempt.state.code, 409);
      assert.equal(defaultAttempt.body.code, "NOTES_LEGACY_ADOPTION_REQUIRED");
      const alternate = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-legacy-alternate-http-"));
      try {
        const customAttempt = await jsonCall(legacyServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "custom", path: alternate })));
        assert.equal(customAttempt.state.code, 409);
        assert.equal(customAttempt.body.code, "NOTES_LEGACY_ADOPTION_REQUIRED");
      } finally {
        await rm(alternate, { recursive: true, force: true });
      }
    const adopted = await jsonCall(legacyServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "adopt" })));
    assert.deepEqual(adopted.body, { ok: true, state: "INITIALIZED", legacy: false });
    assert.equal(await readFile(legacyFile, "utf8"), "legacy note");
    } finally {
      await rm(legacyRoot, { recursive: true, force: true });
    }

    const disappearingRoot = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-disappearing-http-"));
    const disappearingWorkspace = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-disappearing-workspace-"));
    try {
      const disappearingServer = await makeServer(disappearingWorkspace, "workspace-workspace-binding-disappearing-http");
      const custom = await jsonCall(disappearingServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "custom", path: disappearingRoot })));
      assert.deepEqual(custom.body, { ok: true, state: "INITIALIZED", legacy: false });
      const childId = "session-workspace-binding-http-child-0001";
      disappearingServer.sessions.set(childId, { id: childId, header: { cwd: disappearingWorkspace, parentSession: SESSION } });
      await rm(disappearingRoot, { recursive: true, force: true });
      const missingGet = await jsonCall(disappearingServer, request("GET", `/notes-api/${SESSION}/${LANE}`));
      assert.equal(missingGet.state.code, 409);
      assert.equal(missingGet.body.code, "NOTES_CONFIGURED_ROOT_UNAVAILABLE");
      const missingPut = await jsonCall(disappearingServer, request("PUT", `/notes-api/${SESSION}/${LANE}`, JSON.stringify("must-not-recreate"), { "if-match": "0" }));
      assert.equal(missingPut.state.code, 409);
      assert.equal(missingPut.body.code, "NOTES_CONFIGURED_ROOT_UNAVAILABLE");
      const missingFork = await jsonCall(disappearingServer, request("GET", `/notes-api/fork-status?sessionId=${childId}`));
      assert.equal(missingFork.state.code, 409);
      assert.equal(missingFork.body.code, "NOTES_CONFIGURED_ROOT_UNAVAILABLE");
      assert.equal(await import("node:fs/promises").then(({ access }) => access(disappearingRoot).then(() => true, () => false)), false);
    } finally {
      await rm(disappearingRoot, { recursive: true, force: true });
      await rm(disappearingWorkspace, { recursive: true, force: true });
    }
    const unusableRoot = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-unusable-http-"));
    const unusableWorkspace = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-unusable-workspace-"));
    try {
      await chmod(unusableRoot, 0o555);
      const unusableServer = await makeServer(unusableWorkspace, "workspace-workspace-binding-unusable-http");
      const rejected = await jsonCall(unusableServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "custom", path: unusableRoot })));
      assert.equal(rejected.state.code, 409);
      assert.equal(rejected.body.code, "NOTES_LOCATION_UNUSABLE");
      assert.deepEqual((await jsonCall(unusableServer, request("GET", `/notes-api/setup/${SESSION}`))).body, { ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: join(unusableWorkspace, "notes"), browseStartPath: unusableWorkspace });
      assert.equal(unusableServer.records.has("workspace-workspace-binding-unusable-http"), false);
    } finally {
      await chmod(unusableRoot, 0o755);
      await rm(unusableRoot, { recursive: true, force: true });
      await rm(unusableWorkspace, { recursive: true, force: true });
    }

    const customRoot = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-custom-http-"));
    const customWorkspace = await mkdtemp(join(tmpdir(), "dsh-notes-workspace-binding-custom-workspace-"));
    try {
      const customServer = await makeServer(customWorkspace, "workspace-workspace-binding-custom-http");
      const customBinding = await jsonCall(customServer, request("POST", `/notes-api/setup/${SESSION}`, JSON.stringify({ action: "custom", path: customRoot })));
      assert.deepEqual(customBinding.body, { ok: true, state: "INITIALIZED", legacy: false });
      const customPut = await call(customServer.handler, request("PUT", `/notes-api/${SESSION}/${LANE}`, "custom parent", { "if-match": "0" }));
      assert.equal(customPut.code, 200);
      const secondHolder = "session-workspace-binding-http-holder-0002";
      customServer.sessions.set(secondHolder, { id: secondHolder, header: { cwd: customWorkspace } });
      const secondPut = await call(customServer.handler, request("PUT", `/notes-api/${secondHolder}/${LANE}`, "custom second holder", { "if-match": "0" }));
      assert.equal(secondPut.code, 200);
      assert.equal(await readFile(join(customRoot, LANE, `${SESSION}.md`), "utf8"), "custom parent");
      assert.equal(await readFile(join(customRoot, LANE, `${secondHolder}.md`), "utf8"), "custom second holder");
      const customChild = "session-workspace-binding-http-custom-child-0001";
      customServer.sessions.set(customChild, { id: customChild, header: { cwd: customWorkspace, parentSession: SESSION } });
      const customStatus = await jsonCall(customServer, request("GET", `/notes-api/fork-status?sessionId=${customChild}`));
      assert.equal(customStatus.state.code, 200);
      assert.equal(await readFile(join(customRoot, ".carry-over", `${customChild}.json`), "utf8").then(() => true), true);
      assert.equal(await import("node:fs/promises").then(({ access }) => access(join(customWorkspace, "notes")).then(() => true, () => false)), false);
      const customCarry = await jsonCall(customServer, request("POST", "/notes-api/fork-carryover", JSON.stringify({ sessionId: customChild, choice: "all" })));
      assert.equal(customCarry.state.code, 200);
      assert.equal(await readFile(join(customRoot, LANE, `${customChild}.md`), "utf8"), "custom parent");
    } finally {
      await rm(customRoot, { recursive: true, force: true });
      await rm(customWorkspace, { recursive: true, force: true });
    }
  console.log("workspace binding HTTP tests: PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
