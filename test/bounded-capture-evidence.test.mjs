// Focused regression coverage for the bounded browser-evidence transport.
// This test is intentionally host/client seam-level; it does not start DSH or
// exercise production deployment.
import { Window } from "happy-dom";
import { captureBrowserSelection } from "../lib/capture-facade.js";
import { nodeKeyToEvent } from "../lib/selection-bridge.js";
import { handleAnchoredRoute } from "../lib/anchored-routes.js";

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SID = "session-evidence-0001";
const USER_ID = "evidence-user-0001";
const USER_KEY = `13:input-message${USER_ID}`;
const ASSISTANT_KEY = "14:assistant-step2:1";

function fakeReq(body) {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  return {
    method: "POST",
    resume() {},
    [Symbol.asyncIterator]: async function* () { yield buf; },
  };
}

function fakeRes() {
  const out = { status: null, body: "" };
  return {
    out,
    writeHead(status) { out.status = status; },
    end(body) { out.body = body || ""; },
  };
}

function ctxFor(events, onRead = () => {}) {
  return {
    get(name) {
      if (name !== "sessionQuery") return undefined;
      return {
        async readSession(sessionId) {
          onRead(sessionId);
          return { events };
        },
      };
    },
  };
}

const events = [
  {
    seq: 7,
    type: "user/message",
    data: { id: USER_ID, content: [{ type: "text", text: "USER-SOURCE" }], source: { kind: "user" } },
  },
  {
    seq: 17,
    type: "assistant/message",
    data: { turn: 2, step: 1, message: { id: "evidence-assistant-0001", content: [{ type: "text", text: "ASSIST-SOURCE" }] } },
  },
];

console.log("— bounded capture evidence —");
{
  const w = new Window();
  w.document.body.innerHTML =
    `<div data-chat-anchor-key="${USER_KEY}">USER-SOURCE</div>` +
    `<div data-chat-anchor-key="${ASSISTANT_KEY}">ASSIST-SOURCE</div>`;
  const first = w.document.querySelector(`[data-chat-anchor-key="${USER_KEY}"]`).firstChild;
  const last = w.document.querySelector(`[data-chat-anchor-key="${ASSISTANT_KEY}"]`).firstChild;
  const range = w.document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.nodeValue.length);
  w.getSelection = () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range });
  globalThis.window = w;
  globalThis.document = w.document;
  let historyCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/session.history")) historyCalls++;
    throw new Error("capture must not fetch history");
  };

  const captured = await captureBrowserSelection(SID);
  ok("browser capture succeeds without history transport", captured.captureType === "candidate");
  ok("browser history call count is zero", historyCalls === 0, String(historyCalls));
  ok("evidence is ordered and selection-scoped", captured.candidate?.evidence?.anchors?.map((a) => a.order).join(",") === "0,1");
  ok("evidence carries full DOM basis", captured.candidate?.evidence?.anchors?.[0]?.basisText === "USER-SOURCE" && captured.candidate?.evidence?.anchors?.[1]?.basisText === "ASSIST-SOURCE");
  ok("browser does not send authoritative fields", !Object.prototype.hasOwnProperty.call(captured.candidate, "segments") && !Object.prototype.hasOwnProperty.call(captured.candidate, "effectiveSourceText") && !Object.prototype.hasOwnProperty.call(captured.candidate.evidence.anchors[0], "eventSeq"));

  let reads = 0;
  const res = fakeRes();
  await handleAnchoredRoute(ctxFor(events, () => { reads++; }), fakeReq({ candidate: captured.candidate }), res, new URL("http://x/notes-api/anchored/validate"));
  const body = JSON.parse(res.out.body);
  ok("cross-message validate fails closed", body.ok === false && body.code === "CAPTURE_EVIDENCE_REJECTED" && body.detail?.reason?.includes("one authoritative messageId"), res.out.body.slice(0, 180));
  ok("multi-event validate reads authority exactly once", reads === 1, String(reads));
  ok("host rejects multiple durable message identities", body.validated === undefined && body.detail?.reason?.includes("one authoritative messageId"));
}

console.log("— renderer identity and fail-closed authority —");
{
  const snapshot = [
    { kind: "user", messageId: USER_ID, seq: 7, content: [{ type: "text", text: "USER-SOURCE" }] },
    { kind: "assistant", turn: 2, step: 1, seq: 17, content: [{ type: "text", text: "ASSIST-SOURCE" }] },
    { kind: "tool", callId: "call-1", seq: 27, content: [{ type: "text", text: "TOOL-SOURCE" }] },
  ];
  ok("user renderer key resolves", nodeKeyToEvent(USER_KEY, snapshot).seq === 7);
  ok("assistant renderer key resolves", nodeKeyToEvent(ASSISTANT_KEY, snapshot).seq === 17);
  ok("tool renderer key resolves", nodeKeyToEvent("9:tool-callcall-1", snapshot).seq === 27);
  ok("malformed numeric length prefix rejects", nodeKeyToEvent("12:input-message" + USER_ID, snapshot).reason === "bad-node-key-length");
  ok("numeric prefixes are never event sequences", nodeKeyToEvent("13:input-messagemissing", snapshot).seq === undefined && nodeKeyToEvent("13:input-messagemissing", snapshot).seqs === undefined);
  ok("duplicate renderer identity rejects as ambiguous", Array.isArray(nodeKeyToEvent(USER_KEY, [...snapshot, { ...snapshot[0], seq: 8 }]).seqs));

  const tampered = {
    sessionId: SID,
    projectionVersion: 1,
    effectiveSourceText: "FORGED",
    evidence: {
      sessionId: SID,
      projectionVersion: 1,
      anchors: [{ nodeKey: USER_KEY, basisText: "USER-SOURCE", startCP: 0, endCP: 11, order: 0 }],
    },
  };
  const tamperedRes = fakeRes();
  await handleAnchoredRoute(ctxFor(events), fakeReq({ candidate: tampered }), tamperedRes, new URL("http://x/notes-api/anchored/validate"));
  const tamperedBody = JSON.parse(tamperedRes.out.body);
  ok("authority-bearing browser field is rejected", tamperedBody.ok === false && tamperedBody.code === "INVALID_CAPTURE_EVIDENCE");

  const mismatch = { ...tampered, effectiveSourceText: undefined, evidence: { ...tampered.evidence, sessionId: "session-other-0001" } };
  delete mismatch.effectiveSourceText;
  const mismatchRes = fakeRes();
  await handleAnchoredRoute(ctxFor(events), fakeReq({ candidate: mismatch }), mismatchRes, new URL("http://x/notes-api/anchored/validate"));
  ok("nested session mismatch fails closed", JSON.parse(mismatchRes.out.body).code === "INVALID_CAPTURE_EVIDENCE");

  const failureRes = fakeRes();
  await handleAnchoredRoute({ get: () => ({ async readSession() { throw new Error("gone"); } }) }, fakeReq({ candidate: { sessionId: SID, projectionVersion: 1, evidence: { sessionId: SID, projectionVersion: 1, anchors: [] } } }), failureRes, new URL("http://x/notes-api/anchored/validate"));
  ok("authority read failure fails closed", JSON.parse(failureRes.out.body).code === "SESSION_READ_FAILED");
}

console.log(`结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
