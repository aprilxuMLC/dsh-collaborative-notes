// Focused implementation-layer tests for the browser-free Agent operation.
// No Agent/model request is made; the fake host supplies trusted exec.agent
// context and authoritative sessionQuery data.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceBindingRuntime, BINDING_DOMAIN_SPEC } from "../lib/workspace-binding-runtime.js";
import { KIND_SOURCE_AWARE, makeItem, serializeItem, withItemKey } from "../lib/structured-item.js";

const SID_A = "session-reentry-a0001";
const SID_B = "session-reentry-b0002";
const LANE = "conversation_todo";
const SOURCE = "Thursday at 10:00; owner Maya; risk API review";
const SELECTED = "Thursday at 10:00";
const LOCATOR_A = { sessionId: SID_A, projectionVersion: 1, segments: [{ eventSeq: 7, start: 0, end: 17 }] };
const LOCATOR_B = { sessionId: SID_B, projectionVersion: 1, segments: [{ eventSeq: 5, start: 0, end: 5 }] };

function makeDomain() {
  const records = new Map();
  const table = { get: (key) => records.get(key), async put(key, value) { records.set(key, { ...value }); } };
  return { records, open: async (spec) => { assert.equal(spec.name, BINDING_DOMAIN_SPEC.name); return { table: () => table }; } };
}

function makeFs() {
  const versions = new Map();
  return {
    async resolve(file) { return { targetKey: file, displayPath: file }; },
    async stat(target) { const value = versions.get(target.targetKey); return value && { version: value.version, size: value.content.length }; },
    async readText(target) { return versions.get(target.targetKey)?.content ?? ""; },
    async withLock(_key, fn) { return fn(); },
    seed(file, content) { versions.set(file, { version: "1", content }); },
    snapshot(file) { return versions.get(file)?.content; },
  };
}

function event(seq, type, text, id) {
  return { seq, type, time: seq, data: type === "user/message"
    ? { id, content: [{ type: "text", text }], source: { kind: "user" } }
    : { message: { content: [{ type: "text", text }] }, turn: 1, step: 1 } };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "dsh-notes-source-reentry-agent-"));
  let foreignRoot;
  try {
    foreignRoot = await mkdtemp(join(tmpdir(), "dsh-notes-source-reentry-foreign-"));
    await mkdir(join(root, "notes", LANE), { recursive: true });
    const domain = makeDomain();
    const fs = makeFs();
    const definitions = [];
    let sessionReads = 0;
    const contextReads = [];
    const eventsA = [
      event(1, "user/message", "earlier context", "msg-1"),
      event(7, "user/message", SOURCE, "msg-7"),
      event(8, "assistant/message", "authoritative answer", "msg-8"),
      event(9, "user/message", "later context", "msg-9"),
    ];
    const eventsB = [event(5, "user/message", "OTHER", "msg-b")];
    const eventsC = [event(6, "user/message", "FOREIGN", "msg-c")];
    let liveEventsA = eventsA;
    let liveEventReads = 0;
    let foreignEventReads = 0;
    const sessions = new Map([
      [SID_A, { id: SID_A, header: { cwd: root }, get events() { liveEventReads++; return liveEventsA; } }],
      [SID_B, { id: SID_B, header: { cwd: root }, get events() { return eventsB; } }],
      ["session-reentry-c0003", { id: "session-reentry-c0003", header: { cwd: foreignRoot }, get events() { foreignEventReads++; return eventsC; } }],
    ]);
    const headers = [
      { id: SID_A, cwd: root, createdAt: 1 },
      { id: SID_B, cwd: root, createdAt: 2 },
      { id: "session-reentry-c0003", cwd: foreignRoot, createdAt: 3 },
    ];
    const sessionQuery = {
      async listSessions() { return headers.map((header) => ({ header: { ...header }, live: sessions.has(header.id), persisted: true })); },
      async readSession(sessionId) {
        sessionReads++;
        return { events: sessionId === SID_A ? eventsA : sessionId === SID_B ? eventsB : eventsC };
      },
      async readEvent({ sessionId, seq, before, after }) {
        contextReads.push({ sessionId, seq, before, after });
        const pool = sessionId === SID_A ? eventsA : eventsB;
        const index = pool.findIndex((candidate) => candidate.seq === seq);
        return { events: pool.slice(Math.max(0, index - before), index + after + 1) };
      },
    };
    const ctx = {
      get(name) { return name === "sessions" ? sessions : name === "sessionQuery" ? sessionQuery : undefined; },
      storageDomain: domain,
      workspaceRegistry: { resolveByPath: async (path) => path === foreignRoot ? ({ id: "workspace-foreign", path: foreignRoot }) : ({ id: "workspace-source-reentry", path: root }) },
      fs,
      tools: { register(definition) { definitions.push(definition); return () => {}; } },
      async waterfall(name, target, exec) {
        if (name !== "fs/read-intent") return undefined;
        return { kind: "read" };
      },
      emit(_name, target, observation, exec) {
        exec.agent.observed ??= new Map();
        exec.agent.observed.set(target.targetKey, observation);
      },
    };
    const runtime = createWorkspaceBindingRuntime(ctx);
    runtime.registerTools();
    await runtime.bind(SID_A, "default");
    const agent = { id: SID_A, session: sessions.get(SID_A), observed: new Map() };
    const exec = { agent, signal: new AbortController().signal };
    const tool = definitions.find((definition) => definition.name === "notes-source-reentry");
    assert.ok(tool, "Agent source-reentry tool is registered");
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["contextWindow", "itemKey", "lane"]);
    assert.deepEqual(tool.parameters.required, ["lane", "itemKey"]);
    for (const forbidden of ["path", "sessionId", "eventSeq", "range", "locator", "snapshot", "consent"]) {
      assert.equal(Object.hasOwn(tool.parameters.properties, forbidden), false, `${forbidden} is not a model input`);
    }

    const file = join(await realpath(root), "notes", LANE, `${SID_A}.md`);
    const itemA = withItemKey(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID_A, snapshot: SELECTED, sourcePayload: LOCATOR_A }), "ik-source-a");
    fs.seed(file, serializeItem(itemA));
    const before = fs.snapshot(file);
    const exact = await tool.execute({ lane: LANE, itemKey: "ik-source-a" }, exec);
    assert.equal(exact.ok, true);
    assert.equal(exact.status, "exact");
    assert.equal(exact.selectedText, SELECTED);
    assert.equal(exact.sourceMessage, SOURCE);
    assert.ok(exact.surroundingContext.some((entry) => entry.text === "authoritative answer"));
    assert.equal(exact.contextWindow, 2);
    assert.equal(sessionReads, 0, "attached Agent re-entry does not call readSession");
    assert.equal(contextReads.length, 0, "attached Agent re-entry does not call readEvent");
    assert.equal(liveEventReads, 1, "attached Agent re-entry reads one public live event snapshot");
    assert.equal(fs.snapshot(file), before, "exact re-entry is read-only");

    const identityLocator = { sessionId: SID_A, messageId: "msg-7" };
    fs.seed(file, serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID_A, snapshot: "Thursday at 10:00", sourcePayload: identityLocator }), "ik-source-identity-partial")));
    const identityBefore = fs.snapshot(file);
    const identityPartial = await tool.execute({ lane: LANE, itemKey: "ik-source-identity-partial", contextWindow: 0 }, exec);
    assert.equal(identityPartial.ok, true);
    assert.equal(identityPartial.status, "exact");
    assert.equal(identityPartial.selectedText, "Thursday at 10:00");
    assert.equal(identityPartial.sourceMessage, SOURCE);
    assert.equal(sessionReads, 0, "identity partial Agent re-entry remains on live bounded path");
    assert.equal(fs.snapshot(file), identityBefore, "identity partial Agent re-entry is read-only");
    fs.seed(file, serializeItem(itemA));

    const bounded = await tool.execute({ lane: LANE, itemKey: "ik-source-a", contextWindow: 99 }, exec);
    assert.equal(bounded.contextWindow, 10);
    assert.ok(bounded.surroundingContext.some((entry) => entry.text === "earlier context"));
    assert.equal(contextReads.length, 0);
    const contextCount = contextReads.length;
    const noContext = await tool.execute({ lane: LANE, itemKey: "ik-source-a", contextWindow: 0 }, exec);
    assert.equal(noContext.status, "exact");
    assert.equal(noContext.contextWindow, 0);
    assert.equal(contextReads.length, contextCount, "contextWindow 0 does not request surrounding events");

    // A carried Note remains in the current holder's lane while its persisted
    // Source Anchor points to the parent conversation.  Remove the parent
    // from the attached-session map so this exercises the existing cold
    // historical sessionQuery seam rather than a live-session shortcut.
    sessions.delete(SID_B);
    fs.seed(file, serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID_B, snapshot: "OTHER", sourcePayload: LOCATOR_B }), "ik-source-b")));
    const crossBeforeReads = sessionReads;
    const crossBefore = fs.snapshot(file);
    const cross = await tool.execute({ lane: LANE, itemKey: "ik-source-b" }, exec);
    assert.equal(cross.ok, true);
    assert.equal(cross.status, "exact");
    assert.equal(cross.selectedText, "OTHER");
    assert.equal(cross.sourceMessage, "OTHER");
    assert.ok(cross.surroundingContext.some((entry) => entry.text === "OTHER"));
    assert.equal(sessionReads, crossBeforeReads + 1, "foreign Source is read through sessionQuery exactly once");
    assert.equal(contextReads.at(-1).sessionId, SID_B, "bounded context targets persisted Source session");
    assert.equal(fs.snapshot(file), crossBefore, "cross-conversation re-entry is read-only");

    // A live Source in another registered workspace is rejected before the
    // public events getter is touched.
    const foreignKey = "ik-source-foreign";
    const foreignLocator = { sessionId: "session-reentry-c0003", projectionVersion: 1, segments: [{ eventSeq: 6, start: 0, end: 7 }] };
    fs.seed(file, serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: "session-reentry-c0003", snapshot: "FOREIGN", sourcePayload: foreignLocator }), foreignKey)));
    const foreignBeforeReads = sessionReads;
    const foreignBeforeEvents = foreignEventReads;
    const foreign = await tool.execute({ lane: LANE, itemKey: foreignKey }, exec);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.status, "unavailable");
    assert.equal(foreign.code, "SESSION_READ_FAILED");
    assert.equal(sessionReads, foreignBeforeReads, "attached foreign workspace is denied before readSession");
    assert.equal(foreignEventReads, foreignBeforeEvents, "attached foreign workspace is denied before events access");

    // The same denial applies when the foreign session is cold: metadata is
    // sufficient for the boundary check, and readSession remains untouched.
    sessions.delete("session-reentry-c0003");
    const coldForeign = await tool.execute({ lane: LANE, itemKey: foreignKey }, exec);
    assert.equal(coldForeign.ok, false);
    assert.equal(coldForeign.status, "unavailable");
    assert.equal(coldForeign.code, "SESSION_READ_FAILED");
    assert.equal(sessionReads, foreignBeforeReads, "cold foreign workspace is denied before readSession");

    // An unknown/imported source id fails closed before any content read.
    const unknownKey = "ik-source-unknown";
    const unknownLocator = { sessionId: "session-reentry-unknown", projectionVersion: 1, segments: [{ eventSeq: 1, start: 0, end: 1 }] };
    fs.seed(file, serializeItem(withItemKey(makeItem({ kind: KIND_SOURCE_AWARE, captureOrigin: SID_A, snapshot: "?", sourcePayload: unknownLocator }), unknownKey)));
    const unknown = await tool.execute({ lane: LANE, itemKey: unknownKey }, exec);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, "unavailable");
    assert.equal(sessionReads, foreignBeforeReads, "unknown source id does not trigger readSession");

    fs.seed(file, serializeItem(itemA));
    const mismatchEvents = eventsA.map((candidate) => candidate.seq === 7 ? event(7, "user/message", "Thursday at 11:00; owner Maya; risk API review", "msg-7") : candidate);
    liveEventsA = mismatchEvents;
    const mismatchBefore = fs.snapshot(file);
    const mismatch = await tool.execute({ lane: LANE, itemKey: "ik-source-a", contextWindow: 0 }, exec);
    assert.equal(mismatch.status, "incompatible");
    assert.equal(mismatch.code, "HISTORICAL_S_MISMATCH");
    assert.equal(fs.snapshot(file), mismatchBefore, "S mismatch does not repair or rewrite provenance");
    liveEventsA = eventsA;

    liveEventsA = null;
    const unavailable = await tool.execute({ lane: LANE, itemKey: "ik-source-a", contextWindow: 0 }, exec);
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.code, "LIVE_SESSION_EVENTS_INVALID");
    assert.equal(fs.snapshot(file), mismatchBefore);

    await assert.rejects(() => tool.execute({ lane: LANE, itemKey: "ik-source-a", consent: "per-request" }, exec), (error) => error.code === "NOTES_INVALID_ARGUMENT");
    await runtime.close();
    console.log("source-reentry Agent operation focused tests: PASS (schema, same-session live exact, cross-session persisted Source, mismatch, live unavailable, bounded, read-only)");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreignRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
