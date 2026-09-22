// Return the authoritative live Session event snapshot across DSH host APIs.
// DSH 0.1.1 exposes the snapshot as `events`; current hosts expose the same
// logical snapshot through `snapshotEvents()`. Keep this seam internal so
// Notes does not grow a new public API or change Source semantics.
export function liveSessionEvents(session) {
  if (typeof session?.snapshotEvents === "function") return session.snapshotEvents();
  return session?.events;
}
