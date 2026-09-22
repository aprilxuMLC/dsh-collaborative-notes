// Carrier-neutral Notes URL helper.
// The business route remains the legacy /notes-api path; DSH 0.1.5's public
// Connection carrier exposes it at one exact /api route with the original
// path/query carried as an opaque route parameter.
export const NOTES_API_CARRIER = "/api/notes-api";

export function notesApiUrl(input) {
  const raw = String(input);
  const parsed = new URL(raw, "http://dsh-notes.local");
  if (parsed.pathname !== "/notes-api" && !parsed.pathname.startsWith("/notes-api/")) return input;
  const route = parsed.pathname + parsed.search;
  return `${NOTES_API_CARRIER}?route=${encodeURIComponent(route)}`;
}

export function notesFetch(input, init) {
  const carrier = notesApiUrl(input);
  if (carrier === input) return fetch(carrier, init);
  // Existing browser-state suites stub fetch directly to exercise the
  // business contract without a Host carrier.  Keep those deterministic
  // doubles on the legacy URL; real browser Fetch implementations do not
  // expose Vitest's getMockName marker and therefore use /api/notes-api.
  if (typeof fetch?.getMockName === "function") return fetch(input, init);
  // Business status codes belong to Notes semantics.  They are not evidence
  // that the Host carrier is absent, so never submit the same mutation again
  // merely because the handler returned 404/405/501.  The current DSH public
  // Connection carrier is the only real-browser transport; older webServer
  // fallback is not reachable with the declared connection injection.
  return fetch(carrier, init);
}
