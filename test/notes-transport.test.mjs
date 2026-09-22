import assert from "node:assert/strict";
import { notesFetch, notesApiUrl } from "../lib/notes-transport.js";

const originalFetch = globalThis.fetch;
try {
  assert.equal(notesApiUrl("/notes-api/structured/conversation_todo").startsWith("/api/notes-api?route="), true);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 409, ok: false, json: async () => ({ code: "STALE_PRECONDITION" }) };
  };
  const stale = await notesFetch("/notes-api/structured/conversation_todo", { method: "PUT", body: "lane-body" });
  assert.equal(stale.status, 409, "business precondition status is preserved");
  assert.equal(calls.length, 1, "business 409 does not submit a legacy second request");
  assert.match(calls[0].url, /^\/api\/notes-api\?route=/);

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 404, ok: false, json: async () => ({ code: "NOTE_BUSINESS_NOT_FOUND" }) };
  };
  const business404 = await notesFetch("/notes-api/structured/conversation_todo", { method: "PUT", body: "lane-body" });
  assert.equal(business404.status, 404);
  assert.equal(calls.length, 1, "business 404 does not submit a legacy second request");
  console.log("notes transport carrier proof: PASS (single carrier submission; business 409/404 preserved)");
} finally {
  globalThis.fetch = originalFetch;
}
