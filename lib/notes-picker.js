// Notes-owned transient directory-selection protocol.
// Capability detection is deliberately lazy: callers invoke this only after
// the user chooses "Choose another location".

function isAbort(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function isBrowseUnavailable(error) {
  const code = error?.rpcError?.code;
  return code === "directory-picker/unavailable" || code === "directory-picker-unavailable";
}

/**
 * Probe browse once and reuse a successful first listing.  Only the typed
 * public rpcError code may select the native fallback; other failures remain
 * real browse errors and local abort remains cancellation.
 */
export async function chooseNotesDirectory(workspaces, { signal, startPath } = {}) {
  if (!workspaces || typeof workspaces.listDirectory !== "function" || typeof workspaces.pickDirectory !== "function") {
    throw new Error("Notes directory selection is unavailable");
  }
  try {
    const listing = await workspaces.listDirectory(startPath, signal);
    return { mode: "browse", listing };
  } catch (error) {
    if (isAbort(error, signal)) return { mode: "cancelled" };
    if (!isBrowseUnavailable(error)) throw error;
    const path = await workspaces.pickDirectory();
    return path == null ? { mode: "cancelled" } : { mode: "native", path };
  }
}

export { isAbort, isBrowseUnavailable };
