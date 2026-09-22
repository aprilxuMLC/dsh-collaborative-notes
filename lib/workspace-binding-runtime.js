// Workspace binding runtime: logical Agent Notes operations and the
// dsh-notes-owned workspace -> Notes-location binding.
//
// This module deliberately keeps the public surface logical.  The current
// holder and the physical Notes root are resolved from host execution context;
// neither is accepted from model arguments or Note content.
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  BEGIN_LINE,
  END_LINE,
  KIND_SOURCE_AWARE,
  KIND_SOURCE_INDEPENDENT,
  hasSubstantiveAuthoredContent,
  inspectItemKey,
  isValidGeneratedItemKey,
  makeItem,
  newItemKey,
  parseLaneBody,
  serializeLaneBody,
  withItemKey,
} from "./structured-item.js";
import { resolveItemByKey } from "./reference-binding.js";
import { executeSourceReentry } from "./reentry-routes.js";

export const BINDING_DOMAIN_SPEC = {
  name: "dsh_collab_notes",
  version: 1,
  layout: "single",
  tables: {
    workspace_bindings: {
      // The rc.2 storage-domain contract calls valueSchema.parse() when it
      // reopens a durable record.  Keeping this tiny compatible validator
      // local avoids making the plugin's bundle depend on an unavailable
      // build-time package; the host still owns durability and validation.
      valueSchema: {
        parse(value) {
          if (!value || typeof value !== "object" || typeof value.path !== "string" || value.path.length === 0) {
            throw new Error("invalid Notes binding");
          }
          return { path: value.path };
        },
        safeParse(value) {
          try { return { success: true, data: BINDING_DOMAIN_SPEC.tables.workspace_bindings.valueSchema.parse(value) }; }
          catch (error) { return { success: false, error }; }
        },
      },
    },
  },
};

export class NotesOperationError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "NotesOperationError";
    this.code = code;
    Object.assign(this, details);
  }
}

const LANE_KEYS = new Set([
  "conversation_todo",
  "deferred_work",
  "knowledge_candidate",
  "lesson_candidate",
]);

function sessionsOf(ctx) {
  return ctx.get?.("sessions");
}

function sessionForId(ctx, sessionId) {
  const session = sessionsOf(ctx)?.get?.(sessionId);
  if (!session?.header?.cwd) throw new NotesOperationError("NOTES_HOLDER_UNAVAILABLE", "current Notes holder is unavailable");
  return session;
}

function sessionFromExec(ctx, exec) {
  const agent = exec?.agent;
  if (!agent) throw new NotesOperationError("NOTES_HOLDER_UNAVAILABLE", "current Notes holder is unavailable");
  const session = agent.session ?? sessionsOf(ctx)?.get?.(agent.id);
  if (!session?.header?.cwd) throw new NotesOperationError("NOTES_HOLDER_UNAVAILABLE", "current Notes holder is unavailable");
  const sessionId = session.id ?? agent.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new NotesOperationError("NOTES_HOLDER_UNAVAILABLE", "current Notes holder is unavailable");
  }
  return { session, sessionId };
}

function workspacePath(workspace) {
  const path = workspace?.path ?? workspace?.cwd;
  if (typeof path !== "string" || path.length === 0) {
    throw new NotesOperationError("NOTES_WORKSPACE_UNAVAILABLE", "current workspace is unavailable");
  }
  return resolve(path);
}

function workspaceId(workspace) {
  if (typeof workspace?.id !== "string" || workspace.id.length === 0) {
    throw new NotesOperationError("NOTES_WORKSPACE_UNAVAILABLE", "current workspace identity is unavailable");
  }
  return workspace.id;
}

async function lstatIfPresent(path) {
  return lstat(path).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
}

async function canonicalExistingDirectory(path, code) {
  const info = await lstatIfPresent(path);
  if (!info) throw new NotesOperationError(code, "selected Notes location does not exist");
  if (info.isSymbolicLink() || !info.isDirectory()) throw new NotesOperationError(code, "selected Notes location is not a directory");
  return realpath(path);
}

async function knownNotesData(root) {
  // This is intentionally a fixed-layout probe, not a filesystem-wide scan.
  for (const lane of LANE_KEYS) {
    const lanePath = join(root, lane);
    const laneInfo = await lstatIfPresent(lanePath);
    if (!laneInfo) continue;
    if (laneInfo.isSymbolicLink() || !laneInfo.isDirectory()) continue;
    const entries = await readdir(lanePath, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".md"))) return true;
  }
  const carry = await lstatIfPresent(join(root, ".carry-over"));
  if (carry?.isDirectory()) {
    const entries = await readdir(join(root, ".carry-over"), { withFileTypes: true });
    if (entries.some((entry) => entry.isFile())) return true;
  }
  return false;
}

async function validateReservedLayout(root) {
  for (const lane of LANE_KEYS) {
    const lanePath = join(root, lane);
    const laneInfo = await lstatIfPresent(lanePath);
    if (!laneInfo) continue;
    if (laneInfo.isSymbolicLink() || !laneInfo.isDirectory()) {
      throw new NotesOperationError("NOTES_LOCATION_INVALID", "selected Notes location contains an invalid lane entry");
    }
    const entries = await readdir(lanePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".md")) continue;
      const entryInfo = await lstatIfPresent(join(lanePath, entry.name));
      if (entryInfo?.isSymbolicLink() || !entryInfo?.isFile()) {
        throw new NotesOperationError("NOTES_LOCATION_INVALID", "selected Notes location contains an invalid Markdown entry");
      }
    }
  }
  const carryPath = join(root, ".carry-over");
  const carryInfo = await lstatIfPresent(carryPath);
  if (carryInfo && (carryInfo.isSymbolicLink() || !carryInfo.isDirectory())) {
    throw new NotesOperationError("NOTES_LOCATION_INVALID", "selected Notes location contains an invalid carry-over entry");
  }
  if (carryInfo) {
    const entries = await readdir(carryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      const entryInfo = await lstatIfPresent(join(carryPath, entry.name));
      if (entryInfo?.isSymbolicLink() || !entryInfo?.isFile()) {
        throw new NotesOperationError("NOTES_LOCATION_INVALID", "selected Notes location contains an invalid carry-over marker");
      }
    }
  }
}

function withLock(map, key, fn) {
  const prior = map.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const queued = prior.then(() => gate);
  map.set(key, queued);
  return prior.catch(() => {}).then(fn).finally(() => {
    release();
    if (map.get(key) === queued) map.delete(key);
  });
}

function logicalFailure(error) {
  if (error instanceof NotesOperationError) return error;
  const code = error?.code;
  const known = new Set(["FS_STALE_VERSION", "FS_NOT_OBSERVED", "FS_NOT_FOUND", "FS_NOT_DIRECTORY", "FS_NOT_REGULAR_FILE", "FS_NOT_TEXT", "FS_TOO_LARGE", "FS_PERMISSION_DENIED", "FS_SANDBOX_DENIED", "FS_IO_ERROR", "FS_EDIT_NOT_FOUND", "FS_AMBIGUOUS_EDIT", "FS_ABORTED", "EACCES", "EPERM", "EIO", "ENOSPC", "ENOTDIR"]);
  if (known.has(code)) return new NotesOperationError(code, code);
  return new NotesOperationError("NOTES_OPERATION_FAILED", "Notes operation failed");
}

function noPhysicalPath(value) {
  if (typeof value === "string") return value.replace(/(?:[A-Za-z]:)?(?:\\|\/)[^\s]*/g, "[path-redacted]");
  return value;
}

function operationParameters(kind) {
  const base = {
    type: "object",
    properties: { lane: { type: "string", enum: [...LANE_KEYS] } },
    required: ["lane"],
    additionalProperties: false,
  };
  if (kind === "write") {
    base.properties.content = { type: "string" };
    base.required.push("content");
  }
  if (kind === "edit") {
    base.properties.itemKey = { type: "string" };
    base.properties.content = { type: "string" };
    base.properties.expectedVersion = { type: "string" };
    base.required.push("itemKey", "content", "expectedVersion");
  }
  if (kind === "source-reentry") {
    base.properties.itemKey = { type: "string" };
    base.properties.contextWindow = { type: "integer" };
    base.required.push("itemKey");
  }
  return base;
}

function outputDefinition() {
  const noteProperties = {
    addressable: { type: "boolean" },
    itemKey: { type: "string" },
    kind: { type: "string" },
    authored: { type: "string" },
    sourceSnapshot: { type: "string" },
    carriedFromSession: { type: "string" },
    reason: { type: "string" },
  };
  return {
    schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        lane: { type: "string" },
        itemKey: { type: "string" },
        version: { type: "string" },
        notes: {
          type: "array",
          items: { type: "object", properties: noteProperties, additionalProperties: false },
        },
      },
      required: ["status", "lane"],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
}

function sourceReentryOutputDefinition() {
  return {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        status: { type: "string" },
        code: { type: "string" },
        reason: { type: "string" },
        selectedText: { type: "string" },
        sourceMessage: { type: "string" },
        surroundingContext: {
          type: "array",
          items: {
            type: "object",
            properties: { role: { type: "string" }, text: { type: "string" } },
            required: ["role", "text"],
            additionalProperties: false,
          },
        },
        contextWindow: { type: "integer" },
      },
      required: ["status"],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
}

// Bounded holder-local key allocation.  The generator is injectable only so
// the collision bound is directly testable; production uses newItemKey().
export function allocateFreshItemKey(existingKeys, generator = newItemKey, maxAttempts = 16) {
  const keys = existingKeys instanceof Set ? existingKeys : new Set(existingKeys ?? []);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = generator();
    if (isValidGeneratedItemKey(key) && !keys.has(key)) return key;
  }
  throw new NotesOperationError("NOTES_ITEM_KEY_UNAVAILABLE", "could not allocate a unique Note key");
}

export function createWorkspaceBindingRuntime(ctx, { layers = [], keyGenerator = newItemKey, resolveExactCarry = null } = {}) {
  const enabled = Boolean(ctx.storageDomain?.open && ctx.workspaceRegistry?.resolveByPath);
  if (!enabled) return null;
  const bindingDomainPromise = ctx.storageDomain.open(BINDING_DOMAIN_SPEC);
  const bindingLocks = new Map();
  // A default location may legitimately be absent immediately after the
  // human's first binding choice.  This process-local allowance exists only
  // until the first successful materialization; it is never persisted and is
  // not restored after a restart.  An already-existing configured root has no
  // such allowance, so deleting it later fails closed instead of recreating it.
  const initialMaterialization = new Set();
  let bindingDomainClosed = false;
  let bindingDomainHandle;

  async function closeBindingDomain() {
    bindingDomainClosed = true;
    const handle = bindingDomainHandle ?? await bindingDomainPromise.catch(() => undefined);
    if (handle?.close) await handle.close();
  }

  bindingDomainPromise.then((handle) => {
    bindingDomainHandle = handle;
    if (bindingDomainClosed) return handle.close?.();
    return undefined;
  }).catch(() => undefined);
  // Domain handles are consumer-owned in rc.2.  Register the close operation
  // with the plugin fiber when the real host supplies Cordis effects.  The
  // small node-only regression harness does not have this seam and remains
  // intentionally dependency-light.
  if (typeof ctx.effect === "function") ctx.effect(() => closeBindingDomain, "dsh-collab-notes binding domain");

  async function domain() {
    try { return await bindingDomainPromise; }
    catch { throw new NotesOperationError("NOTES_BINDING_UNAVAILABLE", "Notes storage binding is unavailable"); }
  }

  async function contextForSession(sessionId) {
    const session = sessionForId(ctx, sessionId);
    const workspace = await ctx.workspaceRegistry.resolveByPath(session.header.cwd);
    if (!workspace) throw new NotesOperationError("NOTES_WORKSPACE_UNAVAILABLE", "current workspace is unavailable");
    const id = workspaceId(workspace);
    const table = (await domain()).table("workspace_bindings");
    const binding = table.get(id);
    return { session, sessionId, workspace, workspaceId: id, workspacePath: workspacePath(workspace), binding };
  }

  async function contextForExec(exec) {
    const { session, sessionId } = sessionFromExec(ctx, exec);
    return contextForSession(sessionId).then((resolved) => ({ ...resolved, session }));
  }

  async function nearestSafeBrowseStart(proposedPath, workspacePathValue) {
    const workspaceRoot = resolve(workspacePathValue);
    let candidate = resolve(proposedPath);
    while (candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${sep}`)) {
      const info = await lstatIfPresent(candidate);
      if (info?.isDirectory() && !info.isSymbolicLink()) {
        try {
          await validateReservedLayout(candidate);
          return candidate;
        } catch {
          // An existing but unsafe proposed target is not a browse root.
        }
      }
      if (candidate === workspaceRoot) break;
      candidate = resolve(candidate, "..");
    }
    return workspaceRoot;
  }

  async function setupState(sessionId) {
    const current = await contextForSession(sessionId);
    if (current.binding) return { state: "INITIALIZED", legacy: false };
    const legacyRoot = join(current.workspacePath, "notes");
    const legacyExists = await knownNotesData(legacyRoot);
    const browseStartPath = await nearestSafeBrowseStart(legacyRoot, current.workspacePath);
    return { state: "UNINITIALIZED", legacy: legacyExists, proposedPath: legacyRoot, browseStartPath };
  }

  async function validateLocation(current, selectedPath, { defaultChoice = false, adopt = false } = {}) {
    if (typeof selectedPath !== "string" || !selectedPath.startsWith(sep)) {
      throw new NotesOperationError("NOTES_LOCATION_INVALID", "selected Notes location is invalid");
    }
    const candidate = resolve(selectedPath);
    const legacyRoot = resolve(current.workspacePath, "notes");
    const isLegacy = candidate === legacyRoot && await knownNotesData(legacyRoot);
    const legacyCanonical = isLegacy ? await realpath(legacyRoot) : legacyRoot;
    if (isLegacy && !adopt) {
      throw new NotesOperationError("NOTES_LEGACY_ADOPTION_REQUIRED", "existing Notes require explicit adoption");
    }
    const info = await lstatIfPresent(candidate);
    let canonical = candidate;
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) throw new NotesOperationError("NOTES_LOCATION_INVALID", "selected Notes location is not a directory");
      canonical = await realpath(candidate);
    } else if (!defaultChoice) {
      throw new NotesOperationError("NOTES_LOCATION_INVALID", "selected Notes location does not exist");
    }
    await validateReservedLayout(canonical);
    if (await knownNotesData(canonical) && !(canonical === legacyCanonical && isLegacy && adopt)) {
      throw new NotesOperationError("NOTES_LOCATION_OCCUPIED", "selected location already contains Notes data");
    }
    // Check the nearest location that the first Notes write would need before
    // committing the binding. A not-yet-created default root is checked via
    // its existing workspace parent; later access loss is fail-closed below.
    try { await access(info ? canonical : resolve(candidate, ".."), fsConstants.W_OK); }
    catch { throw new NotesOperationError("NOTES_LOCATION_UNUSABLE", "selected Notes location is not writable"); }
    return canonical;
  }

  async function bind(sessionId, action, selectedPath) {
    const current = await contextForSession(sessionId);
    const table = (await domain()).table("workspace_bindings");
    return withLock(bindingLocks, current.workspaceId, async () => {
      const existing = table.get(current.workspaceId);
      if (existing) {
        if (action === "status") return { state: "INITIALIZED", legacy: false };
        throw new NotesOperationError("NOTES_ALREADY_INITIALIZED", "Notes storage is already configured");
      }
      if (!["default", "custom", "adopt"].includes(action)) {
        throw new NotesOperationError("NOTES_SETUP_BAD_ACTION", "unsupported Notes setup action");
      }
      const defaultChoice = action === "default";
      const adopt = action === "adopt";
      const legacyRoot = resolve(current.workspacePath, "notes");
      if (action === "default" && selectedPath !== undefined) {
        throw new NotesOperationError("NOTES_LOCATION_INVALID", "default setup does not accept a custom path");
      }
      if (action === "custom" && typeof selectedPath !== "string") {
        throw new NotesOperationError("NOTES_LOCATION_INVALID", "custom setup requires an explicit path");
      }
      if (action === "adopt" && (selectedPath !== undefined || !(await knownNotesData(legacyRoot)))) {
        throw new NotesOperationError("NOTES_LEGACY_ADOPTION_REQUIRED", "existing Notes require explicit adoption");
      }
      const target = action === "default" || action === "adopt" ? legacyRoot : selectedPath;
      const legacyData = await knownNotesData(legacyRoot);
      // Once same-workspace legacy Notes are recognized, the only legal
      // transition is explicit adoption of that exact location.  A custom
      // path must not become an accidental escape from the adoption gate.
      if (legacyData && (!adopt || resolve(target) !== legacyRoot)) {
        throw new NotesOperationError("NOTES_LEGACY_ADOPTION_REQUIRED", "existing Notes require explicit adoption");
      }
      const canonical = await validateLocation(current, target, { defaultChoice, adopt });
      await table.put(current.workspaceId, { path: canonical });
      if (defaultChoice && !(await lstatIfPresent(canonical))) initialMaterialization.add(current.workspaceId);
      return { state: "INITIALIZED", legacy: false };
    });
  }

  async function rootForSession(sessionId, { allowInitialMissing = false } = {}) {
    const current = await contextForSession(sessionId);
    if (!current.binding?.path) throw new NotesOperationError("NOTES_SETUP_REQUIRED", "Collaborative Notes storage has not been configured for this workspace");
    const rootInfo = await lstatIfPresent(current.binding.path);
    if (!rootInfo) {
      if (!(allowInitialMissing && initialMaterialization.has(current.workspaceId))) {
        throw new NotesOperationError("NOTES_CONFIGURED_ROOT_UNAVAILABLE", "configured Notes location is unavailable");
      }
    } else if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new NotesOperationError("NOTES_CONFIGURED_ROOT_UNAVAILABLE", "configured Notes location is unavailable");
    }
    return { ...current, notesRoot: current.binding.path };
  }

  async function targetFor(exec, lane, kind) {
    if (!LANE_KEYS.has(lane)) throw new NotesOperationError("NOTES_INVALID_LANE", "invalid Notes lane");
    const current = await contextForExec(exec);
    if (!current.binding?.path) throw new NotesOperationError("NOTES_SETUP_REQUIRED", "Collaborative Notes storage has not been configured for this workspace");
    current.notesRoot = current.binding.path;
    const rootInfo = await lstatIfPresent(current.notesRoot);
    if (!rootInfo) {
      if (!((kind === "read" || kind === "write") && initialMaterialization.has(current.workspaceId))) {
        throw new NotesOperationError("NOTES_CONFIGURED_ROOT_UNAVAILABLE", "configured Notes location is unavailable");
      }
      if (kind === "write") {
        await mkdir(current.notesRoot, { recursive: true });
        // The first physical materialization consumes the process-local
        // allowance immediately. A later deletion can never re-enter this
        // path and silently recreate the configured root.
        initialMaterialization.delete(current.workspaceId);
      }
    } else if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new NotesOperationError("NOTES_CONFIGURED_ROOT_UNAVAILABLE", "configured Notes location is unavailable");
    }
    const file = resolve(current.notesRoot, lane, `${current.sessionId}.md`);
    if (!file.startsWith(resolve(current.notesRoot) + sep)) throw new NotesOperationError("NOTES_LOCATION_INVALID", "invalid Notes target");
    const relativeTarget = relative(resolve(current.notesRoot), file);
    if (!relativeTarget || isAbsolute(relativeTarget) || relativeTarget.startsWith(`..${sep}`) || relativeTarget === "..") {
      throw new NotesOperationError("NOTES_LOCATION_INVALID", "invalid Notes target");
    }
    // LocalFileSystem.resolve follows filesystem links. Check every existing
    // component without following it before any lane creation or provider
    // resolution, then repeat after mkdir to close the ordinary TOCTOU window.
    async function assertNoSymlinkAncestors() {
      let cursor = resolve(current.notesRoot);
      for (const component of relativeTarget.split(sep)) {
        cursor = join(cursor, component);
        const info = await lstatIfPresent(cursor);
        if (info?.isSymbolicLink()) throw new NotesOperationError("NOTES_LOCATION_INVALID", "Notes target contains a symbolic link");
      }
    }
    await assertNoSymlinkAncestors();
    if (kind === "write") {
      await mkdir(join(current.notesRoot, lane), { recursive: true });
      await assertNoSymlinkAncestors();
    }
    const target = await ctx.fs.resolve(file, { cwd: current.session.header.cwd });
    // LocalFileSystem.resolve returns a canonical targetKey, so verify the
    // provider identity remains inside the bound root as well as the
    // no-symlink display-path walk above.  Keep a conservative string
    // fallback for the small host test double; a host without either
    // containment primitive fails closed instead of handing out a target.
    const boundRoot = await ctx.fs.resolve(current.notesRoot, { cwd: current.session.header.cwd });
    const contained = typeof ctx.fs.contains === "function"
      ? ctx.fs.contains(boundRoot, target)
      : typeof boundRoot?.targetKey === "string" && typeof target?.targetKey === "string"
        ? String(target.targetKey) === String(boundRoot.targetKey) || String(target.targetKey).startsWith(`${String(boundRoot.targetKey)}${sep}`)
        : false;
    if (!contained) throw new NotesOperationError("NOTES_LOCATION_INVALID", "Notes target is outside the bound location");
    return { current, file, target };
  }

  async function projectItem(node, addressable, reason, { lane, itemKeyOccurrences, sessionId } = {}) {
    if (node.type === "legacy") {
      // A malformed structured candidate is deliberately not surfaced as
      // authored content: its serialized framing is machine material, not a
      // Note body that the Agent should reason over.
      if (node.text.split("\n").some((line) => line === BEGIN_LINE)) {
        return { addressable: false, kind: "opaque-structured", reason: "malformed structured candidate" };
      }
      return { addressable: false, kind: "legacy", authored: node.text };
    }
    const item = node.item;
    const keyInfo = inspectItemKey(item);
    const projection = {
      addressable: addressable && keyInfo.status === "valid",
      kind: item.kind,
    };
    if (keyInfo.status === "valid") projection.itemKey = keyInfo.key;
    if (item.kind === KIND_SOURCE_AWARE) {
      projection.authored = typeof item.comment === "string" ? item.comment : "";
      projection.sourceSnapshot = typeof item.snapshot === "string" ? item.snapshot : "";
    } else if (item.kind === KIND_SOURCE_INDEPENDENT) {
      projection.authored = typeof item.comment === "string" ? item.comment : "";
      if (projection.addressable && typeof resolveExactCarry === "function") {
        try {
          const carriedFromSession = await resolveExactCarry({
            sessionId,
            lane,
            itemKey: keyInfo.key,
            itemKeyOccurrences,
            item,
          });
          if (typeof carriedFromSession === "string" && carriedFromSession.length > 0) {
            projection.carriedFromSession = carriedFromSession;
          }
        } catch {
          // Unknown/inaccessible derivation is deliberately omitted.
        }
      }
    }
    if (!projection.addressable) projection.reason = reason ?? (
      keyInfo.status === "missing" ? "item has no canonical item key" :
      keyInfo.status === "duplicate" ? "item has multiple item-key rows" :
      keyInfo.status === "malformed" ? "item-key is malformed" :
      "item-key is not unique in this lane"
    );
    return projection;
  }

  function projectLegacyNode(node) {
    const lines = node.text.split("\n");
    const projections = [];
    let plain = [];
    const flushPlain = () => {
      if (plain.length > 0) projections.push({ addressable: false, kind: "legacy", authored: plain.join("\n") });
      plain = [];
    };
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== BEGIN_LINE) {
        plain.push(lines[i]);
        continue;
      }
      flushPlain();
      i++;
      while (i < lines.length && lines[i] !== END_LINE) i++;
      projections.push({ addressable: false, kind: "opaque-structured", reason: "malformed structured candidate" });
    }
    flushPlain();
    return projections;
  }

  async function projectLane(body, lane, sessionId) {
    const parsed = parseLaneBody(body);
    const validKeys = new Map();
    for (const node of parsed.nodes) {
      if (node.type !== "item") continue;
      const keyInfo = inspectItemKey(node.item);
      if (keyInfo.status === "valid") validKeys.set(keyInfo.key, (validKeys.get(keyInfo.key) ?? 0) + 1);
    }
    const projected = await Promise.all(parsed.nodes.map((node) => {
      const keyInfo = node.type === "item" ? inspectItemKey(node.item) : null;
      const duplicate = keyInfo?.status === "valid" && validKeys.get(keyInfo.key) > 1;
      if (node.type === "legacy") return projectLegacyNode(node);
      return projectItem(node, !duplicate, duplicate ? "item-key is duplicated in this lane" : undefined, {
        lane,
        itemKeyOccurrences: keyInfo?.status === "valid" ? validKeys.get(keyInfo.key) : undefined,
        sessionId,
      });
    }));
    return projected.flat();
  }

  async function observeLane(fsTarget, exec) {
    const read = async () => {
      const before = await ctx.fs.stat(fsTarget, exec?.signal);
      if (!before) {
        ctx.emit?.("fs/observed", fsTarget, { kind: "absent" }, exec);
        return { body: "", observation: { kind: "absent" } };
      }
      const body = await ctx.fs.readText(fsTarget, exec?.signal);
      const observation = { kind: "present", version: before.version };
      ctx.emit?.("fs/observed", fsTarget, observation, exec);
      return { body, observation };
    };
    return typeof ctx.fs.withLock === "function" ? ctx.fs.withLock(fsTarget.targetKey, read) : read();
  }

  async function publishLane(fsTarget, body, exec) {
    // The preceding observation is placed on the host's existing observation
    // seam.  The provider then supplies the actual conditional mutation guard.
    const intent = await ctx.waterfall("fs/write-intent", fsTarget, exec, () => undefined);
    const outcome = await ctx.fs.writeText(fsTarget, body, intent, exec?.signal);
    ctx.emit?.("fs/observed", fsTarget, { kind: "present", version: outcome.version }, exec);
    return String(outcome.version);
  }

  function freshKey(existing) {
    return allocateFreshItemKey(existing, keyGenerator);
  }

  function exactItem(parsed, itemKey) {
    if (typeof itemKey !== "string" || itemKey.length === 0) {
      throw new NotesOperationError("NOTES_ITEM_UNRESOLVED", "item key is required");
    }
    const found = resolveItemByKey(serializeLaneBody(parsed), itemKey);
    if (!found.ok) {
      const code = found.code === "AMBIGUOUS" ? "NOTES_ITEM_AMBIGUOUS"
        : found.code === "NOT_ADDRESSABLE" ? "NOTES_ITEM_NOT_ADDRESSABLE" : "NOTES_ITEM_UNRESOLVED";
      throw new NotesOperationError(code, "Note item key could not be resolved");
    }
    return { node: parsed.nodes[found.nodeIndex], nodeIndex: found.nodeIndex };
  }

  function validateOperationArgs(kind, args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new NotesOperationError("NOTES_INVALID_ARGUMENT", "Notes operation arguments must be an object");
    }
    const fields = kind === "read" ? ["lane"]
      : kind === "write" ? ["lane", "content"]
        : kind === "edit" ? ["lane", "itemKey", "content", "expectedVersion"]
          : ["lane", "itemKey", "contextWindow"];
    for (const field of Object.keys(args)) {
      if (!fields.includes(field)) throw new NotesOperationError("NOTES_INVALID_ARGUMENT", `unsupported Notes argument: ${field}`);
    }
    if (typeof args.lane !== "string" || !LANE_KEYS.has(args.lane)) {
      throw new NotesOperationError("NOTES_INVALID_ARGUMENT", "lane is invalid");
    }
    for (const field of fields.slice(1).filter((field) => !(kind === "source-reentry" && field === "contextWindow" && args[field] === undefined))) {
      if (kind === "source-reentry" && field === "contextWindow") continue;
      if (typeof args[field] !== "string") throw new NotesOperationError("NOTES_INVALID_ARGUMENT", `${field} is required`);
    }
    return args;
  }

  async function executeOperation(kind, args, exec) {
    let target;
    try {
      validateOperationArgs(kind, args);
      if (kind === "write" && !hasSubstantiveAuthoredContent(args.content)) {
        throw new NotesOperationError("NOTES_INVALID_ARGUMENT", "content must contain substantive authored content");
      }
      target = await targetFor(exec, args.lane, kind);
    }
    catch (error) { throw logicalFailure(error); }
    const { current, target: fsTarget } = target;
    const signal = exec?.signal;
    try {
      if (kind === "source-reentry") {
        const observed = await observeLane(fsTarget, exec);
        const laneBody = observed.observation.kind === "absent" ? "" : observed.body;
        return executeSourceReentry(ctx, {
          readLane: async () => laneBody,
          currentWorkspaceId: current.workspaceId,
        }, {
          currentSessionId: current.sessionId,
          lane: args.lane,
          itemKey: args.itemKey,
          contextWindow: args.contextWindow,
        });
      }
      if (kind === "read") {
        const observed = await observeLane(fsTarget, exec);
        return observed.observation.kind === "absent"
          ? { status: "absent", lane: args.lane, notes: [] }
          : { status: "present", lane: args.lane, version: String(observed.observation.version), notes: await projectLane(observed.body, args.lane, current.sessionId) };
      }
      if (kind === "write") {
        if (typeof args?.content !== "string") throw new NotesOperationError("NOTES_INVALID_ARGUMENT", "content is required");
        const observed = await observeLane(fsTarget, exec);
        const parsed = parseLaneBody(observed.body);
        const existingKeys = new Set();
        for (const node of parsed.nodes) {
          const info = node.type === "item" ? inspectItemKey(node.item) : null;
          if (info?.status === "valid") existingKeys.add(info.key);
        }
        const item = withItemKey(makeItem({ kind: KIND_SOURCE_INDEPENDENT, captureOrigin: current.sessionId, comment: args.content }), freshKey(existingKeys));
        parsed.nodes.push({ type: "item", item });
        const version = await publishLane(fsTarget, serializeLaneBody(parsed), exec);
        return { status: "created", lane: args.lane, itemKey: inspectItemKey(item).key, version };
      }
      if (kind === "edit") {
        if (typeof args?.content !== "string" || typeof args?.itemKey !== "string" || typeof args?.expectedVersion !== "string") {
          throw new NotesOperationError("NOTES_INVALID_ARGUMENT", "itemKey, content, and expectedVersion are required");
        }
        const observed = await observeLane(fsTarget, exec);
        if (observed.observation.kind !== "present" || String(observed.observation.version) !== args.expectedVersion) {
          throw new NotesOperationError("FS_STALE_VERSION", "Notes lane changed; read it again before editing");
        }
        const parsed = parseLaneBody(observed.body);
        const found = exactItem(parsed, args.itemKey);
        const previous = found.node.item;
        if (previous.kind === KIND_SOURCE_INDEPENDENT && !hasSubstantiveAuthoredContent(args.content)) {
          throw new NotesOperationError("NOTES_INVALID_ARGUMENT", "content must contain substantive authored content");
        }
        const replacement = { ...previous, comment: args.content };
        parsed.nodes[found.nodeIndex] = { ...found.node, item: replacement };
        const version = await publishLane(fsTarget, serializeLaneBody(parsed), exec);
        return { status: "updated", lane: args.lane, itemKey: args.itemKey, version };
      }
      throw new NotesOperationError("NOTES_INVALID_ARGUMENT", "unsupported Notes operation");
    } catch (error) {
      throw logicalFailure(error);
    }
  }

  function registerTools() {
    if (!ctx.tools?.register) return [];
    const defs = [
      ["notes-read", "Read the current holder's logical Notes projection.", "read"],
      ["notes-write", "Create one canonical Note in the current holder's logical lane.", "write"],
      ["notes-edit", "Update exactly one keyed Note in the current holder's logical lane using its expected version.", "edit"],
      ["notes-source-reentry", "Read bounded exact source context for one current-holder source-aware Note, including a persisted Source in another readable conversation.", "source-reentry"],
    ].map(([name, description, kind]) => ({
      name,
      description,
      parameters: operationParameters(kind),
      output: kind === "source-reentry" ? sourceReentryOutputDefinition() : outputDefinition(),
      async execute(args, exec) { return executeOperation(kind, args, exec); },
    }));
    return defs.map((definition) => ctx.tools.register(definition));
  }

  return {
    enabled: true,
    setupState,
    bind,
    rootForSession,
    markRootMaterialized(workspaceId) { initialMaterialization.delete(workspaceId); },
    close: closeBindingDomain,
    contextForExec,
    registerTools,
    logicalFailure,
    redact: noPhysicalPath,
    layers,
  };
}

export { knownNotesData, operationParameters };
