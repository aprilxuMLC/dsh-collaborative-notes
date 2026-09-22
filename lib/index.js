// dsh-collab-notes host half: notes file read/write bridge.
//
// Storage/API/display are decoupled (0003 structure upgrade v1):
//   - System vocabulary: semantic layer keys (conversation_todo, deferred_work,
//     knowledge_candidate, lesson_candidate) are the ONLY identity used by
//     storage (notes/<key>/), the API layer parameter, config keys and the
//     skill template placeholders.
//   - Presentation vocabulary: display ids (L1/L2/L3/L4) are derived for
//     humans/agents only; code never depends on the number or ordering.
//   - Attention policy (active / releasable) is product semantics bound to
//     the fixed key table; config cannot override it (meta emits it as a
//     read-only projection).
//
// HTTP routes (prefix /notes-api):
//   GET /notes-api/meta
//       → { layers: [...] } — the resolved final display mapping:
//         { key, displayId, label, policy, target, action } per layer.
//         Clients render from this; they do not hardcode the layer list.
//   GET /notes-api/<sessionId>/<layer>   (layer = semantic key)
//       → contents of <cwd>/notes/<key>/<sessionId>.md (empty if absent)
//   PUT /notes-api/<sessionId>/<layer>
//       → write request body verbatim (note ⇄ file are exact mirrors; dirs
//         are created on demand). Optimistic concurrency: If-Match baseline
//         must match current mtime, otherwise 409 + latest content + mtime.
//
// Security:
//   - layer key whitelist + sessionId format whitelist + resolve boundary
//     check (defense in depth against path traversal);
//   - realpath check: notes root and layer dir must physically resolve inside
//     the session cwd (blocks symlink escape);
//   - Origin must match request Host exactly when present (empty Origin
//     allowed for same-page fetch / curl);
//   - PUT body capped at 1 MiB; GET treats only ENOENT as an empty note;
//   - request body drained on 413/405/409 (keep-alive hygiene);
//   - errors are logged, responses are generic 500.
import { readFile, writeFile, mkdir, rename, unlink, stat as statFile, realpath, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { handleAnchoredRoute } from "./anchored-routes.js";
import { handleReentryRoute } from "./reentry-routes.js";
import { carryRekeyWithKeys, composeCarryMerge, evaluateExactDerivation, filterParentLaneForFork, loadParentMessageEvents, mergeCarriedSides } from "./carry-merge.js";
import { createPendingStore, createPreStepBinding, confirmDurableBinding } from "./binding-wiring.js";
import { createWorkspaceBindingRuntime, NotesOperationError } from "./workspace-binding-runtime.js";

const SETTINGS_NAMESPACE = "dsh-collab-notes";

/** Fixed layer table (system vocabulary). config can override label/displayId/
 *  target/action and the display order, but NEVER the key, the policy or the
 *  physical directory (which equals the key). */
const LAYER_FIXED = {
  conversation_todo: {
    policy: "active",
    defaultLabel: "会话待办",
    defaultTarget: "",
    defaultAction: "",
  },
  deferred_work: {
    policy: "releasable",
    defaultLabel: "延后工作",
    defaultTarget: "a formal discussion/todo list (ask the user where)",
    defaultAction: "transcribe into structured entries",
  },
  knowledge_candidate: {
    policy: "releasable",
    defaultLabel: "知识候选",
    defaultTarget: "a knowledge-base document (ask the user where)",
    defaultAction: "complete and write up",
  },
  lesson_candidate: {
    policy: "releasable",
    defaultLabel: "复盘素材",
    defaultTarget: "a lessons-learned document (ask the user where)",
    defaultAction: "complete and write up",
  },
};

/** Default display order (presentation only; reorderable via config). */
const DEFAULT_ORDER = Object.keys(LAYER_FIXED);

/** Layer key whitelist (== the physical directory name). */
const LAYER_KEYS = new Set(Object.keys(LAYER_FIXED));

/** DSH 0.1.5 in-process fork cut: the Session object carries the exact
 * inherited prefix length. The persisted/wire `seedLength` is not a field on
 * the live Session header. */
function forkCutOf(session) {
  return Number.isSafeInteger(session?.inheritedEventCount) ? Number(session.inheritedEventCount) : null;
}

/** Mount config: presentation-layer overrides only. displayOrder reorders the
 *  tabs; layerOverrides customizes label/displayId/target/action per key.
 *  Unknown keys are warned and dropped; display ids must stay unique. */
export const Config = Schema.object({
  displayOrder: Schema.array(Schema.string()).default([]),
  layerOverrides: Schema.dict(
    Schema.object({
      label: Schema.string().default(""),
      displayId: Schema.string().default(""),
      target: Schema.string().default(""),
      action: Schema.string().default(""),
    })
  ).default({}),
});

/** Sanitize a config-supplied text before it is rendered into the skill or
 *  meta: drop control chars (incl. tab/newline/CR — they could break the
 *  Markdown structure or inject extra instructions), over-long values, and
 *  anything that looks like a path traversal or an absolute path. Config is a
 *  hint, not executable input. */
function sanitizeText(value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return "";
  if (text.length > 200) return "";
  if (/[\u0000-\u001f\u007f]/.test(text)) return "";
  if (text.includes("..") || /^[/\\]/.test(text) || /^[A-Za-z]:/.test(text)) return "";
  return text;
}

/** Merge the fixed layer table with profile vocabulary → final display mapping.
 *  displayOrder only REORDERS: known layers not listed are appended in default
 *  order (they are never hidden by omission — hiding is not supported).
 *  displayId defaults to L1/L2/... by final array order; an explicit displayId
 *  wins but must be unique. label is the descriptive profile vocabulary only;
 *  the resolved label remains the one composed title exposed to UI/meta. policy
 *  comes from the fixed table (never overridden). */
function resolveLayers(config = {}) {
  const overrides = config.layerOverrides ?? {};
  const configured = config.displayOrder ?? [];
  for (const key of configured) {
    if (!LAYER_FIXED[key]) console.warn(`[dsh-collab-notes] unknown layer key in displayOrder: ${key}`);
  }
  const order = [...new Set(configured.filter((k) => LAYER_FIXED[k]))]; // unknown dropped, dedup
  for (const key of DEFAULT_ORDER) {
    if (!order.includes(key)) order.push(key); // never hide layers by omission
  }
  const seenDisplayIds = new Set();
  const layers = [];
  for (const key of order) {
    const f = LAYER_FIXED[key];
    const ov = overrides[key] ?? {};
    let displayId = sanitizeText(ov.displayId) || `L${layers.length + 1}`;
    if (seenDisplayIds.has(displayId)) {
      console.warn(`[dsh-collab-notes] duplicate displayId ${displayId}; falling back to auto`);
      displayId = `L${layers.length + 1}`;
    }
    seenDisplayIds.add(displayId);
    const descriptiveLabel = sanitizeText(ov.label) || f.defaultLabel;
    layers.push({
      key,
      displayId,
      label: `${displayId} ${descriptiveLabel}`,
      policy: f.policy, // fixed: product semantics, not configurable
      target: sanitizeText(ov.target) || f.defaultTarget,
      action: sanitizeText(ov.action) || f.defaultAction,
    });
  }
  return layers;
}

/** Render the skill template: substitute per-layer display and consumption
 *  placeholders ({{<key>_display}}, {{<key>_action}}, {{<key>_target}}). */
function renderSkillTemplate(tpl, layers) {
  let out = tpl;
  for (const layer of layers) {
    out = out.split(`{{${layer.key}_display}}`).join(layer.label);
    out = out.split(`{{${layer.key}_action}}`).join(sanitizeText(layer.action || ""));
    out = out.split(`{{${layer.key}_target}}`).join(sanitizeText(layer.target || ""));
  }
  return out;
}

/** Skill frontmatter description — the ONLY trigger the model sees before
 *  loading the body. Flat prose with explicit trigger scenarios (Anthropic
 *  4-part formula). No display ids in the trigger vocabulary (they may be
 *  reordered); semantic layer keys are stable. */
const SKILL_DESCRIPTION =
  'Use when handling collaboration sticky notes (便签/笔记): the user asks to read, append, mark ✅, or consume notes, mentions the note lanes (conversation_todo, deferred_work, knowledge_candidate, lesson_candidate) or the 📝 panel. Also triggers when the user asks what is in their notes or wants notes turned into a formal list or knowledge or lessons-learned documents. Useful for the human-agent shared notes of the current conversation.';

/** Ensure the notes tree exists — the plugin's first self-contained step:
 *  create notes/ + one directory per semantic key on every access
 *  (idempotent; no external setup). */
async function ensureNotesTree(cwd) {
  await Promise.all(
    Object.keys(LAYER_FIXED).map((key) => mkdir(join(cwd, "notes", key), { recursive: true }))
  );
}

/** Legacy per-file mutex (pre-fork/carry eligibility decision stale-safety). Retained as an exported
 *  no-op-friendly helper for the A1 lock-cleanup regression test; the real
 *  writer-integrity lock is now the SHARED host fs per-targetKey lock
 *  (ctx.fs.withLock), which HTTP PUT and tool-fs both serialize on.
 *  `fileLocks` is exported for regression tests only (lock-entry cleanup). */
export const fileLocks = new Map();
async function withFileLock(file, fn) {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // 保存同一个 queued promise 引用：cleanup 用同一引用比较（此前两次
  // `prev.then(...)` 生成不同 Promise，比较永不相等 → Map 条目泄漏）
  const queued = prev.then(() => gate);
  fileLocks.set(file, queued);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(file) === queued) fileLocks.delete(file);
  }
}

/** sessionId shape whitelist: UUID-like ids (optionally "session-" prefixed);
 *  rejects path characters (. / \ etc.) even if URL normalization tricks
 *  segment parsing. */
const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

// ---------------------------------------------------------------------------
// fork/carry eligibility decision: post-fork Notes carry-over — plugin-owned marker metadata.
// A forked child session (header.parentSession set, origin !== 'subagent')
// gets a small marker file under <cwd>/notes/.carry-over/<childId>.json.
// This is adapter/plugin internal bookkeeping: it is NOT a lane, does not
// appear on the user Notes surface, and is not part of the Core data model.
// Status transitions: unresolved (fork detected) → none | carried (user chose).
// ---------------------------------------------------------------------------

/** Marker filename for one child session. */
function carryOverMarkerFile(cwd, childSessionId, notesRootOverride = null) {
  const notesRoot = notesRootOverride ?? resolve(cwd, "notes");
  return resolve(notesRoot, ".carry-over", `${childSessionId}.json`);
}

/**
 * M1: physical-boundary validation shared with the protected Notes surface.
 * Rejects when `notes/` or any ancestor under cwd is a symlink (including
 * dangling — lstat does not follow) or when the notes root realpath escapes
 * the session cwd. Mirrors the route handler's A2 checks so marker bookkeeping
 * can never create/rewrite outside the workspace via a replaced symlink.
 * @returns the validated absolute notes root.
 * @throws Error("path escapes notes dir") on violation.
 */
async function assertNotesPathSafe(cwd, notesRootOverride = null) {
  const notesRoot = resolve(notesRootOverride ?? resolve(cwd, "notes"));
  const rootLstat = await lstat(notesRoot).catch((error) =>
    error?.code === "ENOENT" ? null : Promise.reject(error)
  );
  if (rootLstat?.isSymbolicLink()) throw new Error("path escapes notes dir");
  const realNotes = rootLstat ? await realpath(notesRoot) : null; // 非 symlink 时才 realpath
  // A custom workspace binding may intentionally live outside the workspace.
  // Its root was already validated and durably canonicalized by the binding;
  // the legacy path still retains the original workspace containment guard.
  if (realNotes && !notesRootOverride) {
    const realCwd = await realpath(cwd);
    if (!realNotes.startsWith(realCwd + sep)) throw new Error("path escapes notes dir");
  }
  return notesRoot;
}

/**
 * M1: validate one concrete target file stays under the notes root (and that
 * its parent directories AND the final target itself are not replaced symlinks).
 * Covers notes/, notes/.carry-over/, the marker file, and parent/child lane
 * files. An existing OR dangling final-target symlink is rejected so a
 * fork-carryover can never read an outside parent lane or write through an
 * outside child lane. A normal absent target (ENOENT) or regular file passes.
 */
async function assertTargetInsideNotes(cwd, target, notesRootOverride = null) {
  const notesRoot = await assertNotesPathSafe(cwd, notesRootOverride);
  const relative = resolve(cwd, target);
  if (!relative.startsWith(notesRoot + sep)) throw new Error("path escapes notes dir");
  // Walk each ancestor under notes/ and reject an existing symlink (incl.
  // dangling). mkdir(recursive) would otherwise follow a replaced link outward.
  let cursor = notesRoot;
  const rest = relative.slice(notesRoot.length).split(sep).filter(Boolean);
  for (const segment of rest.slice(0, -1)) {
    cursor = resolve(cursor, segment);
    const st = await lstat(cursor).catch((error) =>
      error?.code === "ENOENT" ? null : Promise.reject(error)
    );
    if (st?.isSymbolicLink()) throw new Error("path escapes notes dir");
  }
  // Final target itself: lstat (not stat — must not follow). An existing or
  // dangling symlink is rejected; a normal absent target or regular file is fine.
  const finalSt = await lstat(relative).catch((error) =>
    error?.code === "ENOENT" ? null : Promise.reject(error)
  );
  if (finalSt?.isSymbolicLink()) throw new Error("path escapes notes dir");
  return relative;
}

/** Read a child's carry-over marker; undefined when absent or malformed. */
async function readCarryOverMarker(cwd, childSessionId, notesRootOverride = null) {
  const file = await assertTargetInsideNotes(cwd, carryOverMarkerFile(cwd, childSessionId, notesRootOverride), notesRootOverride);
  try {
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.parentSessionId === "string") return parsed;
  } catch {
    /* absent or malformed → treat as no marker */
  }
  return undefined;
}

/** Atomically write a child's carry-over marker with an exclusive, unique
 * same-directory temporary file.  The temp path is intentionally not a
 * predictable sibling of the marker: `writeFile(..., { flag: "wx" })` cannot
 * follow a pre-existing symlink at that path. */
async function writeCarryOverMarker(cwd, childSessionId, marker, notesRootOverride = null) {
  const notesRoot = resolve(notesRootOverride ?? resolve(cwd, "notes"));
  const file = await assertTargetInsideNotes(cwd, carryOverMarkerFile(cwd, childSessionId, notesRootOverride), notesRootOverride);
  const carryDir = resolve(notesRoot, ".carry-over");
  await mkdir(carryDir, { recursive: true });
  await assertTargetInsideNotes(cwd, carryDir, notesRootOverride);
  const tmp = join(carryDir, `.${childSessionId}.${randomUUID()}.tmp`);
  let created = false;
  try {
    await assertTargetInsideNotes(cwd, tmp, notesRootOverride);
    await writeFile(tmp, JSON.stringify(marker, null, 2), { encoding: "utf8", flag: "wx" });
    created = true;
    await assertTargetInsideNotes(cwd, tmp, notesRootOverride);
    await rename(tmp, file);
    created = false;
    await assertTargetInsideNotes(cwd, file, notesRootOverride);
  } finally {
    if (created) await unlink(tmp).catch(() => {});
  }
}

/** True when a session header marks a subagent (origin === 'subagent'). */
function isSubagentSession(session) {
  return session?.header?.origin === "subagent";
}

/** Ordinary fork identity, decided from the LIVE session header alone — never
 *  from marker presence. A fork child has parentSession and is not a subagent.
 *  (apiproxy fork meta has no origin; subagent sessions carry origin:'subagent'.) */
function isOrdinaryForkChild(session) {
  const header = session?.header;
  if (!header?.parentSession || !SESSION_ID_RE.test(header.parentSession)) return false;
  if (isSubagentSession(session)) return false;
  return true;
}

/**
 * M2: process-local per-child critical section for marker + copy work. The
 * session/created listener, fork-status materialization, and fork-carryover all
 * funnel through this so a late unresolved initialization can never race a user
 * decision's tmp/rename, and a decision can never race a competing decision.
 * (No DB/transaction — a per-child promise chain is the whole lock.)
 */
const carryOverLocks = new Map();
async function withCarryOverLock(childSessionId, fn) {
  const prev = carryOverLocks.get(childSessionId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // 保存同一个 queued promise 引用：cleanup 用同一引用比较（与 fileLocks 相同的
  // 修复——此前 `prev.then(...)` 生成不同 Promise，比较永不相等 → Map 条目泄漏）
  const queued = prev.then(() => gate);
  carryOverLocks.set(childSessionId, queued);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (carryOverLocks.get(childSessionId) === queued) carryOverLocks.delete(childSessionId);
  }
}

/** PUT body cap (1 MiB; notes are text, far beyond enough). */
const MAX_BODY_BYTES = 1024 * 1024;

/** True same-origin check: a present Origin must equal the request Host
 *  (hostname + port). Empty Origin is allowed (same-page fetch / curl). */
function originAllowed(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Parse /notes-api/<sessionId>/<layer>. */
function parsePath(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "notes-api") return null;
  return { sessionId: parts[1], layer: parts[2] };
}

/** Host plugin declares the services it injects (cordis throws on undeclared access).
 *  "fs" is the shared stale-integrity primitive: the host filesystem service
 *  (fs-sandbox → LocalFileSystem) whose per-targetKey lock + version CAS the
 *  formal tool-fs writers already use. All Notes mutations funnel through it. */
export const inject = ["connection", "fs", "storageDomain", "workspaceRegistry", "tools", "settings", "skills"];

export async function apply(ctx, config = {}) {
  let layers = resolveLayers(config);
  let skillRegistration = Promise.resolve();
  let disposeSkill = () => {};

  /** Register the current profile vocabulary without touching Notes data. */
  const registerSkill = (currentLayers) => {
    if (!ctx.skills?.register) return Promise.resolve();
    skillRegistration = skillRegistration.catch(() => {}).then(async () => {
      try {
        const template = await readFile(
          new URL("../skill/collab-notes.template.md", import.meta.url),
          "utf8"
        );
        const body = renderSkillTemplate(template, currentLayers);
        disposeSkill();
        disposeSkill = ctx.skills.register({
          name: "collab-notes",
          description: SKILL_DESCRIPTION,
          source: "runtime",
          content: body,
        });
      } catch (error) {
        console.error("[dsh-collab-notes] failed to register skill:", error);
      }
    });
    return skillRegistration;
  };

  // DSH rc.2's existing user-settings seam layers a persisted profile/user
  // section over this composition entry config. No Notes-specific persistence
  // is introduced: the section is the profile vocabulary carrier.
  if (ctx.settings?.register) {
    const profileSettings = ctx.settings.register(SETTINGS_NAMESPACE, Config, {
      base: config,
      applies: "live",
    });
    layers = resolveLayers(profileSettings.get());
    profileSettings.watch((next) => {
      layers = resolveLayers(next);
      return registerSkill(layers);
    });
  }
  // Workspace services are optional in the node-only regression harness;
  // rc.2 compositions provide them and therefore take the authoritative
  // workspace-bound path/tool behavior.
  //
  // This callback is the single projection seam for exact immediate-parent
  // carry provenance.  Marker parsing stays in this module's existing helper;
  // the projection layers never infer from captureOrigin, text, or ancestry.
  let workspaceRuntime;
  const resolveExactCarry = async ({ sessionId, lane, itemKey, itemKeyOccurrences }) => {
    const session = ctx.get("sessions")?.get?.(sessionId);
    if (!isOrdinaryForkChild(session)) return null;
    const cwd = session?.header?.cwd;
    if (!cwd) return null;
    try {
      const notesRootOverride = workspaceRuntime ? (await workspaceRuntime.rootForSession(sessionId)).notesRoot : null;
      const marker = await readCarryOverMarker(cwd, sessionId, notesRootOverride);
      const result = evaluateExactDerivation({
        headerParentSession: session.header.parentSession,
        marker,
        lane,
        itemKey,
        itemKeyOccurrences,
      });
      return result.ok ? session.header.parentSession : null;
    } catch {
      return null;
    }
  };
  workspaceRuntime = createWorkspaceBindingRuntime(ctx, { layers, resolveExactCarry });
  if (workspaceRuntime) workspaceRuntime.registerTools();

  // Carry markers and lane copies are Notes data too.  In a workspace-bound
  // composition they must follow the same workspace binding as the HTTP lane
  // surface; the legacy harness keeps its historical cwd/notes root.
  const boundNotesRoot = async (sessionId, cwd) =>
    workspaceRuntime ? (await workspaceRuntime.rootForSession(sessionId)).notesRoot : null;

  // fork/carry eligibility decision stale-safety: FAIL CLOSED if the host shared primitive is
  // unavailable. No silent fallback to plugin-private fileLocks + raw-write
  // stale model — that would re-open the Window B race (phase-1 revalidation
  // ≠ safe apply when a supported writer can still interleave).
  const fs = ctx.fs;
  if (!fs || typeof fs.withLock !== "function" || typeof fs.resolve !== "function" || typeof fs.stat !== "function") {
    throw new Error(
      "dsh-collab-notes: ctx.fs.withLock/resolve/stat unavailable — host primitive gap; " +
      "refusing to start (fail-closed, no raw-write fallback)"
    );
  }

  /** Read one durable lane through the same path, boundary checks, and shared
   * lock used by the Notes GET route and binding reader. Re-entry uses this
   * only to obtain the persisted Note identity and historical snapshot. */
  const readLaneBody = async (sessionId, cwd, laneKey) => {
    if (!LAYER_KEYS.has(laneKey)) throw new Error("invalid lane key");
    const notesRoot = workspaceRuntime ? (await workspaceRuntime.rootForSession(sessionId)).notesRoot : resolve(cwd, "notes");
    const file = resolve(notesRoot, laneKey, `${sessionId}.md`);
    if (workspaceRuntime) {
      if (!file.startsWith(resolve(notesRoot) + sep)) throw new NotesOperationError("NOTES_LOCATION_INVALID", "invalid Notes target");
    } else {
      await assertTargetInsideNotes(cwd, file);
    }
    const httpTarget = await fs.resolve(file, { cwd });
    let body = "";
    await fs.withLock(httpTarget.targetKey, async () => {
      try {
        body = await readFile(file, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        body = "";
      }
    });
    return body;
  };

  const readReentryLane = async (holderSessionId, laneKey) => {
    const sessions = ctx.get("sessions");
    const session = sessions?.get?.(holderSessionId);
    const cwd = session?.header?.cwd;
    if (!cwd) throw new Error("durable Note holder session not found");
    return readLaneBody(holderSessionId, cwd, laneKey);
  };

  const notesHttpHandler = async (req, res) => {
      try {
        if (!originAllowed(req.headers.origin, req.headers.host)) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("forbidden: origin not allowed");
          return;
        }
        const url = new URL(req.url ?? "/", "http://x");

        // Notes behavior: anchored capture validate/prepare（host-authoritative）。
        // 分派到 anchored-routes（attached live session 优先读 fresh public
        // events；cold session 才读 ctx.sessionQuery；不可用 → fail-closed
        // truthful error）。独立于既有 notes GET/PUT。
        if (url.pathname === "/notes-api/anchored/validate" || url.pathname === "/notes-api/anchored/prepare") {
          try {
            const handled = await handleAnchoredRoute(ctx, req, res, url);
            if (handled) return;
          } catch (error) {
            ctx.logger?.error?.("[dsh-collab-notes] anchored route error", error?.message ?? error);
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, reason: "anchored route internal error", code: "ANCHORED_INTERNAL" }));
            return;
          }
        }

        // Notes behavior: exact source re-entry（read-only；authority 见 reentry-routes）。
        if (url.pathname === "/notes-api/reentry") {
          try {
            const handled = await handleReentryRoute(ctx, req, res, url, { readLane: readReentryLane });
            if (handled) return;
          } catch (error) {
            ctx.logger?.error?.("[dsh-collab-notes] reentry route error", error?.message ?? error);
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, status: "internal", code: "REENTRY_INTERNAL", reason: String(error?.message ?? error) }));
            return;
          }
        }

        // Resolved display mapping (no file access, no session needed)
        if (url.pathname === "/notes-api/meta") {
          if (req.method !== "GET") {
            req.resume?.();
            res.writeHead(405);
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ layers }));
          return;
        }

        // Workspace setup: human-owned first-use binding.  The route exposes only
        // logical state; the selected physical path is accepted from the UI
        // setup action but never returned to Agent-facing operations.
        const setupMatch = url.pathname.match(/^\/notes-api\/setup\/([^/]+)$/);
        if (setupMatch) {
          if (!workspaceRuntime) {
            req.resume?.();
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_UNAVAILABLE" }));
            return;
          }
          const sessionId = decodeURIComponent(setupMatch[1]);
          if (!SESSION_ID_RE.test(sessionId)) {
            req.resume?.();
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "NOTES_INVALID_SESSION" }));
            return;
          }
          try {
            if (req.method === "GET") {
              const state = await workspaceRuntime.setupState(sessionId);
              res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ ok: true, ...state }));
              return;
            }
            if (req.method === "POST") {
              const chunks = [];
              for await (const chunk of req) {
                chunks.push(chunk);
                if (Buffer.concat(chunks).byteLength > 64 * 1024) {
                  req.resume?.();
                  res.writeHead(413, { "content-type": "application/json" });
                  res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_REQUEST_TOO_LARGE" }));
                  return;
                }
              }
              let payload;
              try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
              catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_BAD_JSON" })); return; }
              const action = String(payload?.action ?? "");
              if (!["default", "custom", "adopt"].includes(action)) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_BAD_ACTION" }));
                return;
              }
              const result = await workspaceRuntime.bind(sessionId, action, typeof payload?.path === "string" ? payload.path : undefined);
              res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ ok: true, ...result }));
              return;
            }
            req.resume?.();
            res.writeHead(405, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, code: "METHOD_NOT_ALLOWED" }));
            return;
          } catch (error) {
            const logical = workspaceRuntime.logicalFailure(error);
            res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, code: logical.code, reason: logical.message }));
            return;
          }
        }

        // fork/carry eligibility decision: carry-over status for one child session (plugin-owned marker +
        // live header). Lets the Notes UI show an unresolved pending banner and
        // distinguish unresolved / none / carried without a new data model.
        if (url.pathname === "/notes-api/fork-status") {
          if (req.method !== "GET") {
            req.resume?.();
            res.writeHead(405);
            res.end();
            return;
          }
          const sessionId = url.searchParams.get("sessionId") ?? "";
          if (!SESSION_ID_RE.test(sessionId)) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("bad session id");
            return;
          }
          const sessions = ctx.get("sessions");
          const session = sessions?.get?.(sessionId);
          const cwd = session?.header?.cwd;
          const isForkChild = isOrdinaryForkChild(session); // header-only, never marker-dependent
          // M2: serialize with any in-flight initialization/decision and
          // materialize an unresolved marker on first observation (best-effort;
          // never overwrite an already-decided marker).
          let marker;
          if (cwd && isForkChild) {
            let notesRootOverride;
            try {
              notesRootOverride = await boundNotesRoot(sessionId, cwd);
            } catch (error) {
              if (error?.code === "NOTES_SETUP_REQUIRED") {
                res.writeHead(428, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
                res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_REQUIRED", reason: "Collaborative Notes storage has not been configured for this workspace" }));
                return;
              }
              throw error;
            }
            marker = await withCarryOverLock(sessionId, async () => {
              const current = await readCarryOverMarker(cwd, sessionId, notesRootOverride);
              if (current) return current;
              await writeCarryOverMarker(cwd, sessionId, {
                version: 1,
                parentSessionId: session.header.parentSession,
                status: "unresolved",
                carriedLanes: null,
                decidedAt: null,
              }, notesRootOverride);
              return await readCarryOverMarker(cwd, sessionId, notesRootOverride);
            });
          }
          const parentSessionId = session?.header?.parentSession ?? marker?.parentSessionId ?? null;
          const status = marker?.status ?? (isForkChild ? "unresolved" : "none");
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({
            isForkChild,
            parentSessionId,
            status,
            carriedLanes: marker?.carriedLanes ?? null,
            decidedAt: marker?.decidedAt ?? null,
          }));
          return;
        }

        // fork/carry eligibility decision: user-authorized carry-over. choice ∈ all | some | none; lanes
        // required only for some. Copies selected parent lanes into child-local
        // files ONLY when the child target is absent (never blind-overwrites an
        // occupied child lane — occupied lanes are skipped and reported).
        // fork/carry eligibility decision conflict resolution: ONE-TIME lane-level preserve-both on
        // occupied child lanes during an unresolved carry-over. Preflight-first:
        // detection never mutates; the final apply carries explicit per-lane
        // resolutions bound to the child mtime the user actually saw.
        // Merge composition（empty-side elision）见 lib/carry-merge.js
        // composeCarryMerge——一侧语义为空时不生成无意义 wrapper；两格式/时序契约
        // 不变。
        /** Observe one notes target via the shared fs service: resolve its
         *  canonical targetKey + stat kind/version. Absent / empty / nonempty
         *  are distinguished (Notes semantics: GET treats absent and empty both
         *  as "" in the UI, but stale-binding must tell them apart — an
         *  absent→occupied change is T1, empty→occupied is T2). */
        async function observeNotesTarget(absPath, cwd) {
          const target = await fs.resolve(absPath, { cwd });
          const stat = await fs.stat(target);
          if (!stat) return { target, kind: "absent", version: null };
          return { target, kind: stat.size === 0 ? "present-empty" : "present-nonempty", version: stat.version };
        }
        /** kindOf(stat): absent | present-empty | present-nonempty. */
        function kindOf(stat) {
          if (!stat) return "absent";
          return stat.size === 0 ? "present-empty" : "present-nonempty";
        }
        /** Fail-closed observation match: an unbound lane (no observation token)
         *  or any kind/version drift is stale. */
        function observationMatches(obs, stat) {
          if (!obs) return false;
          const kind = kindOf(stat);
          if (kind === "absent") return obs.kind === "absent";
          return obs.kind === kind && obs.version === stat.version;
        }
        /** Acquire ALL keys in deterministic (sorted) order, then run fn once.
         *  Nested withLock on distinct keys is safe (each key has its own FIFO
         *  queue); the fixed sort order prevents deadlock across concurrent
         *  multi-key acquirers; the Set dedupes parent/child collisions. */
        async function withNoteLocks(keys, fn) {
          const ordered = [...keys].sort();
          const run = async (i) => {
            if (i >= ordered.length) return fn();
            return fs.withLock(ordered[i], () => run(i + 1));
          };
          return run(0);
        }
        /** Locked, non-mutating preflight of selected lanes. Each lane binds the
         *  parent + child observations the user is ABOUT to see (kind + version
         *  from the shared fs service). */
        async function carryPreflightLocked(cwd, sessionId, parentSessionId, selected, cutSeedLength = null, notesRootOverride = null, parentSession = null) {
          // Notes behavior：preview/conflict 载荷的 parentContent 与 apply 使用**同一**过滤——
          // 用户审阅的"父分支内容"即 merge/replace 将实际物化的内容（过滤后），
          // 不出现 preview 显示 post-cut Note、apply 却丢弃的不一致。
          const parentRoot = resolve(notesRootOverride ?? resolve(cwd, "notes"));
          const childRoot = parentRoot;
          const lanes = [];
          for (const lane of selected) {
            const parentFile = resolve(parentRoot, lane, `${parentSessionId}.md`);
            const childFile = resolve(childRoot, lane, `${sessionId}.md`);
            let parentObs = null;
            let childObs = null;
            let childContent = "";
            let parentContent = "";
            let reason = null;
            try {
              await assertTargetInsideNotes(cwd, childFile, notesRootOverride);
              await assertTargetInsideNotes(cwd, parentFile, notesRootOverride);
            } catch {
              reason = "invalid-path";
            }
            if (!reason) {
              try {
                parentObs = await observeNotesTarget(parentFile, cwd);
                parentContent = parentObs.kind === "absent" ? "" : await fs.readText(parentObs.target);
              } catch (error) {
                if (error?.code !== "ENOENT") reason = "parent-read-error";
              }
              try {
                childObs = await observeNotesTarget(childFile, cwd);
                childContent = childObs.kind === "absent" ? "" : await fs.readText(childObs.target);
              } catch (error) {
                if (error?.code !== "ENOENT") reason = "child-read-error";
              }
            }
            const childExists = childObs?.kind !== "absent";
            const conflict = childExists && childContent.trim().length > 0;
            lanes.push({
              lane,
              conflict,
              childExists,
              parent: { kind: parentObs?.kind ?? "absent", version: parentObs?.version ?? null },
              child: { kind: childObs?.kind ?? "absent", version: childObs?.version ?? null },
              childContent,
              parentContent,
              reason,
            });
          }
          let parentEvents = null;
          if (cutSeedLength !== null) {
            try {
              parentEvents = loadParentMessageEvents(lanes.map((lane) => lane.parentContent), { parentSessionId, parentSession });
            } catch (error) {
              throw new NotesOperationError("CARRY_EVENT_READ_FAILED", "authoritative parent event read failed");
            }
          }
          for (const lane of lanes) {
            if (cutSeedLength !== null) {
              lane.parentContent = filterParentLaneForFork(lane.parentContent, {
                parentSessionId,
                seedLength: cutSeedLength,
                parentSession,
                parentEvents,
              }).body;
            }
          }
          return lanes;
        }
        /**
         * Locked, mutating apply of one resolved carry-over.
         * WINDOW B CLOSURE: the final apply acquires the SHARED fs per-target
         * locks for ALL selected parent+child targets (deterministic order,
         * deduped), revalidates EVERY bound observation against the live stat,
         * and only then writes. While we hold the locks, the supported writers
         * (HTTP PUT and tool-fs writeText/editText) queue on the SAME canonical
         * keys — a competing write cannot interleave between validation and
         * mutation. Any drift → atomic refusal: zero lane writes, marker stays
         * unresolved, the caller reports stale.
         */
        async function carryApplyLocked(cwd, sessionId, parentSessionId, selected, resolutions, observations, cutSeedLength = null, notesRootOverride = null, parentSession = null) {
          // Notes behavior：child Session.inheritedEventCount = 父会话共享前缀长度
          // （rc.2 session.fork 写；dsh-session seq===log 下标）→ 对 parent 锚定的
          // anchored Note 按**历史源位**过滤（eventSeq < seedLength 保留；≥ 排除），
          // 与 capture 时间无关；child 无 seedLength（非 rc.2 fork 产物）→ 原样 carry。
          const parentRoot = resolve(notesRootOverride ?? resolve(cwd, "notes"));
          const childRoot = parentRoot;
          // Collect canonical targetKeys for every selected parent+child (dedupe).
          const keys = new Set();
          const laneTargets = {}; // lane -> { parent, child } resolved targets
          for (const lane of selected) {
            const parentFile = resolve(parentRoot, lane, `${parentSessionId}.md`);
            const childFile = resolve(childRoot, lane, `${sessionId}.md`);
            let invalid = false;
            try {
              await assertTargetInsideNotes(cwd, childFile, notesRootOverride);
              await assertTargetInsideNotes(cwd, parentFile, notesRootOverride);
            } catch {
              invalid = true;
            }
            if (invalid) { laneTargets[lane] = null; continue; }
            const [parentTarget, childTarget] = await Promise.all([
              fs.resolve(parentFile, { cwd }),
              fs.resolve(childFile, { cwd }),
            ]);
            laneTargets[lane] = { parent: parentTarget, child: childTarget };
            keys.add(parentTarget.targetKey);
            keys.add(childTarget.targetKey);
          }
          // One critical section over ALL relevant targets.
          return withNoteLocks(keys, async () => {
            // Phase 1 (read-only, under lock): revalidate ALL bound observations.
            const plan = [];
            for (const lane of selected) {
              const entry = { lane, parentContent: "", childContent: "", reason: null, stale: false, conflict: false };
              const targets = laneTargets[lane];
              if (!targets) { entry.reason = "invalid-path"; plan.push(entry); continue; }
              const bound = observations?.[lane];
              const parentStat = await fs.stat(targets.parent);
              const childStat = await fs.stat(targets.child);
              if (!observationMatches(bound?.parent, parentStat)) entry.stale = true;
              if (!observationMatches(bound?.child, childStat)) entry.stale = true;
              if (!entry.stale) {
                try {
                  entry.parentContent = parentStat ? await fs.readText(targets.parent) : "";
                  entry.childContent = childStat ? await fs.readText(targets.child) : "";
                } catch {
                  entry.reason = "read-error";
                }
              }
              if (!entry.stale) entry.conflict = entry.childContent.trim().length > 0;
              plan.push(entry);
            }
            const staleLanes = plan.filter((p) => p.stale);
            if (staleLanes.length > 0) {
              // Atomic refusal: nothing written; caller keeps marker unresolved.
              return plan.map((p) => p.stale ? { lane: p.lane, outcome: "stale" } : { lane: p.lane, outcome: "deferred" });
            }
            let parentEvents = null;
            if (cutSeedLength !== null) {
              try {
                parentEvents = loadParentMessageEvents(plan.map((entry) => entry.parentContent), { parentSessionId, parentSession });
              } catch (error) {
                throw new NotesOperationError("CARRY_EVENT_READ_FAILED", "authoritative parent event read failed");
              }
            }
            // Phase 2 (mutating, under the SAME locks): apply every lane.
            // fork/carry eligibility decision derivation binding：parent → child 的 copy/replace/merge 都经
            // carryRekeyWithKeys——child 是 child-local holder，carried item 的每条
            // supported structured item 获得新的 child-local key（有 key 换新；
            // keyless/pre-legacy keyless format 也 mint fresh key；legacy/opaque 节点字节不动），绝不把
            // holder-local identity 字节原样复制进 child。capture-origin/snapshot/
            // comment/provenance/order 全部不变。
            const results = [];
            for (const entry of plan) {
              const { lane, parentContent, childContent, reason } = entry;
              const childFile = resolve(childRoot, lane, `${sessionId}.md`);
              if (reason) { results.push({ lane, outcome: "skipped", reason }); continue; }
              const filterRes =
                cutSeedLength === null
                  ? null
                  : filterParentLaneForFork(parentContent, {
                    parentSessionId,
                    seedLength: cutSeedLength,
                    parentSession,
                    parentEvents,
                  });
              const parentForCarry = filterRes ? filterRes.body : parentContent;
              // fork/carry eligibility decision derivation binding：carry 的 child representation 对每条 supported
              // structured parent item 都获得 fresh child-local key（keyless 也 mint），
              // 并返回这些 keys 供 marker exact binding（copy/replace/merge 才 bind；
              // keep/eligibility-excluded/skip/stale 不 bind）。
              const rekeyed = carryRekeyWithKeys(parentForCarry);
              const childParent = rekeyed.text;
              const boundKeys = rekeyed.keys;
              const resolution = resolutions?.[lane];
              const eligExtra =
                filterRes && filterRes.filtered > 0
                  ? { eligibilityFiltered: filterRes.filtered, eligibilityCodes: filterRes.excluded.map((e) => e.code) }
                  : {};
              // no conflict → plain copy（bind 实际物化的 parent-derived items）
              if (!entry.conflict) {
                try {
                  await mkdir(resolve(childRoot, lane), { recursive: true });
                  await writeFile(childFile, childParent, "utf8");
                  results.push({ lane, outcome: "copied", ...eligExtra, boundKeys });
                } catch { results.push({ lane, outcome: "skipped", reason: "copy-failed" }); }
                continue;
              }
              // conflict lane → require explicit resolution
              if (resolution === "keep") {
                // parent 材料未进入 child → 该 lane binding 为空（keep）
                results.push({ lane, outcome: "kept", ...eligExtra, boundKeys: [] });
                continue;
              }
              if (resolution === "replace") {
                try {
                  await mkdir(resolve(childRoot, lane), { recursive: true });
                  await writeFile(childFile, childParent, "utf8");
                  results.push({ lane, outcome: "replaced", ...eligExtra, boundKeys });
                } catch { results.push({ lane, outcome: "skipped", reason: "copy-failed" }); }
                continue;
              }
              if (resolution === "merge") {
                try {
                  await mkdir(resolve(childRoot, lane), { recursive: true });
                  // 仅 parent 侧（从父 holder 进入 child 的部分）re-key + mint key；child
                  // 既有内容已是 child-local。fork/carry eligibility decision structured-merge normalization：
                  // 两侧都能安全表示为 supported structured items → flatten 成普通
                  // child-local lane（parent retained items 在前 + child items 在后）；
                  // 含 legacy/opaque → 保留既有 truthful preserve-both wrapper
                  // compatibility path（composeCarryMerge；空侧 elision 不变）。
                  await writeFile(childFile, mergeCarriedSides(childParent, childContent), "utf8");
                  // merge 只 bind parent 侧实际进入 child 的 structured items
                  results.push({ lane, outcome: "merged", ...eligExtra, boundKeys });
                } catch { results.push({ lane, outcome: "skipped", reason: "copy-failed" }); }
                continue;
              }
              // no resolution supplied for a conflict lane → skip (no silent overwrite)
              results.push({ lane, outcome: "skipped", reason: "no-resolution" });
            }
            return results;
          });
        }

        if (url.pathname === "/notes-api/fork-preflight") {
          if (req.method !== "POST") { req.resume?.(); res.writeHead(405); res.end(); return; }
          let payload;
          try { const chunks = []; for await (const chunk of req) chunks.push(chunk); payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { res.writeHead(400, { "content-type": "text/plain" }); res.end("bad json body"); return; }
          const sessionId = String(payload.sessionId ?? "");
          const choice = String(payload.choice ?? "");
          const lanes = Array.isArray(payload.lanes) ? payload.lanes.map(String) : [];
          if (!SESSION_ID_RE.test(sessionId)) { res.writeHead(400, { "content-type": "text/plain" }); res.end("bad session id"); return; }
          if (choice !== "all" && choice !== "some") { res.writeHead(400, { "content-type": "text/plain" }); res.end("choice must be all | some"); return; }
          if (choice === "some" && lanes.length === 0) { res.writeHead(400, { "content-type": "text/plain" }); res.end("choice some requires lanes"); return; }
          const sessions = ctx.get("sessions");
          const session = sessions?.get?.(sessionId);
          const cwd = session?.header?.cwd;
          const parentSessionId = session?.header?.parentSession;
          const parentSession = parentSessionId ? sessions?.get?.(parentSessionId) : null;
          if (!isOrdinaryForkChild(session) || !cwd) { res.writeHead(400, { "content-type": "text/plain" }); res.end("session is not an ordinary fork child"); return; }
          let notesRootOverride;
          try { notesRootOverride = await boundNotesRoot(sessionId, cwd); }
          catch (error) {
            if (error?.code === "NOTES_SETUP_REQUIRED") {
              res.writeHead(428, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_REQUIRED", reason: "Collaborative Notes storage has not been configured for this workspace" }));
              return;
            }
            throw error;
          }
          const selected = choice === "all" ? Object.keys(LAYER_FIXED) : lanes.filter((l) => LAYER_KEYS.has(l));
          const cutSeedLength = forkCutOf(session);
          const preview = await withCarryOverLock(sessionId, () => carryPreflightLocked(cwd, sessionId, parentSessionId, selected, cutSeedLength, notesRootOverride, parentSession));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ lanes: preview }));
          return;
        }

        if (url.pathname === "/notes-api/fork-apply") {
          if (req.method !== "POST") { req.resume?.(); res.writeHead(405); res.end(); return; }
          let payload;
          try { const chunks = []; for await (const chunk of req) chunks.push(chunk); payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { res.writeHead(400, { "content-type": "text/plain" }); res.end("bad json body"); return; }
          const sessionId = String(payload.sessionId ?? "");
          const choice = String(payload.choice ?? "");
          const lanes = Array.isArray(payload.lanes) ? payload.lanes.map(String) : [];
          const resolutions = payload.resolutions && typeof payload.resolutions === "object" ? payload.resolutions : {};
          const observations = payload.observations && typeof payload.observations === "object" ? payload.observations : {};
          if (!SESSION_ID_RE.test(sessionId)) { res.writeHead(400, { "content-type": "text/plain" }); res.end("bad session id"); return; }
          if (choice !== "all" && choice !== "some") { res.writeHead(400, { "content-type": "text/plain" }); res.end("choice must be all | some"); return; }
          if (choice === "some" && lanes.length === 0) { res.writeHead(400, { "content-type": "text/plain" }); res.end("choice some requires lanes"); return; }
          const sessions = ctx.get("sessions");
          const session = sessions?.get?.(sessionId);
          const cwd = session?.header?.cwd;
          const parentSessionId = session?.header?.parentSession;
          const parentSession = parentSessionId ? sessions?.get?.(parentSessionId) : null;
          if (!isOrdinaryForkChild(session) || !cwd) { res.writeHead(400, { "content-type": "text/plain" }); res.end("session is not an ordinary fork child"); return; }
          let notesRootOverride;
          try { notesRootOverride = await boundNotesRoot(sessionId, cwd); }
          catch (error) {
            if (error?.code === "NOTES_SETUP_REQUIRED") {
              res.writeHead(428, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_REQUIRED", reason: "Collaborative Notes storage has not been configured for this workspace" }));
              return;
            }
            throw error;
          }
          const selected = choice === "all" ? Object.keys(LAYER_FIXED) : lanes.filter((l) => LAYER_KEYS.has(l));
          const result = await withCarryOverLock(sessionId, async () => {
            const marker = (await readCarryOverMarker(cwd, sessionId, notesRootOverride)) ?? { version: 1, parentSessionId, status: "unresolved", carriedLanes: null, decidedAt: null };
            if (marker.parentSessionId !== parentSessionId) { res.writeHead(400, { "content-type": "text/plain" }); res.end("marker lineage mismatch"); return null; }
            if (marker.status !== "unresolved") { return { status: marker.status, results: [], alreadyDecided: true }; }
            const cutSeedLength = forkCutOf(session);
            const results = await carryApplyLocked(cwd, sessionId, parentSessionId, selected, resolutions, observations, cutSeedLength, notesRootOverride, parentSession);
            if (results.some((r) => r.outcome === "stale")) {
              // Atomic refusal: a bound observation changed since the user
              // confirmed → nothing written, marker stays unresolved so the UI
              // re-surfaces with the fresh state.
              return { status: "stale", results };
            }
            marker.status = "carried";
            marker.carriedLanes = selected.filter((l) => !results.some((r) => r.lane === l && r.outcome === "skipped"));
            marker.decidedAt = Date.now();
            const bindings = {};
            for (const r of results) {
              if (r.outcome === "copied" || r.outcome === "replaced" || r.outcome === "merged") {
                bindings[r.lane] = Array.isArray(r.boundKeys) ? r.boundKeys : [];
              }
            }
            marker.version = 2;
            marker.bindings = bindings;
            await writeCarryOverMarker(cwd, sessionId, marker, notesRootOverride);
            return { status: "carried", results };
          });
          if (result === null) return;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(result));
          return;
        }

        if (url.pathname === "/notes-api/fork-carryover") {
          if (req.method !== "POST") {
            req.resume?.();
            res.writeHead(405);
            res.end();
            return;
          }
          let payload;
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("bad json body");
            return;
          }
          const sessionId = String(payload.sessionId ?? "");
          const choice = String(payload.choice ?? "");
          const lanes = Array.isArray(payload.lanes) ? payload.lanes.map(String) : [];
          if (!SESSION_ID_RE.test(sessionId)) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("bad session id");
            return;
          }
          if (choice !== "all" && choice !== "some" && choice !== "none") {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("choice must be all | some | none");
            return;
          }
          if (choice === "some" && lanes.length === 0) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("choice some requires lanes");
            return;
          }
          const sessions = ctx.get("sessions");
          const session = sessions?.get?.(sessionId);
          const cwd = session?.header?.cwd;
          const parentSessionId = session?.header?.parentSession;
          const parentSession = parentSessionId ? sessions?.get?.(parentSessionId) : null;
          // M3: the POST itself must enforce ordinary-fork eligibility — a live
          // subagent child (origin:'subagent') must be rejected even though it
          // carries parentSession. Ordinary fork carry-over ≠ subagent lineage.
          if (!isOrdinaryForkChild(session) || !cwd) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("session is not an ordinary fork child");
            return;
          }
          let notesRootOverride;
          try { notesRootOverride = await boundNotesRoot(sessionId, cwd); }
          catch (error) {
            if (error?.code === "NOTES_SETUP_REQUIRED") {
              res.writeHead(428, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_REQUIRED", reason: "Collaborative Notes storage has not been configured for this workspace" }));
              return;
            }
            throw error;
          }
          // M2: everything below (marker re-read, copy, final decision) runs in
          // one per-child critical section so a late session/created
          // initialization or a competing decision cannot race our tmp/rename.
          const result = await withCarryOverLock(sessionId, async () => {
            const marker = (await readCarryOverMarker(cwd, sessionId, notesRootOverride)) ?? {
              version: 1,
              parentSessionId,
              status: "unresolved",
              carriedLanes: null,
              decidedAt: null,
            };
            // M3: never let a stale/forged marker rewrite lineage.
            if (marker.parentSessionId !== parentSessionId) {
              res.writeHead(400, { "content-type": "text/plain" });
              res.end("marker lineage mismatch");
              return null;
            }
            if (marker.status !== "unresolved") {
              // Already decided; idempotent no-op (do not re-copy).
              return { status: marker.status, carriedLanes: marker.carriedLanes, skipped: [] };
            }
            if (choice === "none") {
              marker.status = "none";
              marker.carriedLanes = null;
              marker.decidedAt = Date.now();
              await writeCarryOverMarker(cwd, sessionId, marker, notesRootOverride);
              return { status: "none", carriedLanes: null, skipped: [] };
            }
            const selected = choice === "all" ? Object.keys(LAYER_FIXED) : lanes.filter((l) => LAYER_KEYS.has(l));
            const cutSeedLength = forkCutOf(session);
            // Preflight-first: if any selected lane has an occupied child with
            // substantive content, DO NOT mutate anything — return conflicts so
            // the UI can collect one-time resolutions (then call fork-apply).
            // The bound parent+child observations accompany the conflict payload
            // so the final apply revalidates exactly what the user saw.
            const preflight = await carryPreflightLocked(cwd, sessionId, parentSessionId, selected, cutSeedLength, notesRootOverride, parentSession);
            const observations = {};
            for (const p of preflight) observations[p.lane] = { parent: p.parent, child: p.child };
            const conflicts = preflight.filter((p) => p.conflict && !p.reason).map((p) => ({ lane: p.lane, childContent: p.childContent, parentContent: p.parentContent }));
            if (conflicts.length > 0) {
              return { status: "conflict", conflicts, observations };
            }
            const results = await carryApplyLocked(cwd, sessionId, parentSessionId, selected, {}, observations, cutSeedLength, notesRootOverride, parentSession);
            if (results.some((r) => r.outcome === "stale")) {
              // Atomic refusal（与 fork-apply 同 guard）：bound observation 已漂移 →
              // 什么都没写、不写成功 binding、marker 保持 unresolved——绝不把 stale
              // 当成成功物化并写入 carried marker。
              return { status: "stale", results };
            }
            marker.status = "carried";
            marker.carriedLanes = selected.filter((l) => !results.some((r) => r.lane === l && r.outcome === "skipped"));
            marker.decidedAt = Date.now();
            const bindings = {};
            for (const r of results) {
              if (r.outcome === "copied" || r.outcome === "replaced" || r.outcome === "merged") {
                bindings[r.lane] = Array.isArray(r.boundKeys) ? r.boundKeys : [];
              }
            }
            marker.version = 2;
            marker.bindings = bindings;
            await writeCarryOverMarker(cwd, sessionId, marker, notesRootOverride);
            return { status: "carried", results };
          });
          if (result === null) return; // lineage-mismatch branch already responded
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(result));
          return;
        }

        // Notes behavior selection endpoints（/notes-api/<sessionId>/selection）：
        //   GET    → { pending: {generation, targets} | null, lastBinding: {...} | null }
        //   PUT    → body { targets: [{laneKey, itemKey}], generation? }（空 targets =
        //             clear）；非 durable session-scoped 内存
        //   DELETE → clear
        // 仅校验 shape/session 存在；selection 本身不写任何 Note 文件。
        if (/^\/notes-api\/[0-9A-Za-z][0-9A-Za-z-]{7,63}\/selection$/.test(url.pathname)) {
          const sessionId = url.pathname.split("/")[2];
          const sessions = ctx.get("sessions");
          const session = sessions?.get?.(sessionId);
          if (!session?.header?.cwd) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("session not found");
            return;
          }
          if (req.method === "GET") {
            const pending = pendingSelections.get(sessionId) ?? null;
            const binding = lastBinding.get(sessionId) ?? null;
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({
              pending: pending ? { generation: pending.generation, targets: pending.targets } : null,
              lastBinding: binding,
            }));
            return;
          }
          // 正常变更路径一律用 versioned PUT（client-issued
          // generation 表达用户意图序；空 targets = clear 同走 PUT）。**不做 DELETE
          // 路由**（DELETE 无法承载同等 revision 语义——current implementation 偏好单一 versioned
          // PUT）。GET 只读。
          if (req.method !== "PUT") {
            req.resume?.();
            res.writeHead(405, { "content-type": "text/plain" });
            res.end("method not allowed: use versioned PUT (targets: [] to clear)");
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("bad json body");
            return;
          }
          const targets = Array.isArray(payload?.targets) ? payload.targets : null;
          if (!targets) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("targets array required (use [] to clear)");
            return;
          }
          // shape 校验：laneKey ∈ LAYER_KEYS、itemKey 非空字符串
          for (const t of targets) {
            if (!t || typeof t !== "object" || typeof t.laneKey !== "string" || !LAYER_KEYS.has(t.laneKey) || typeof t.itemKey !== "string" || t.itemKey.length === 0) {
              res.writeHead(400, { "content-type": "text/plain" });
              res.end("invalid target: laneKey must be a layer key, itemKey a non-empty string");
              return;
            }
          }
          // generation = client-issued intent order：**必带**；无 gen → 400
          // （禁止 host 以网络到达序 auto "current+1" 冒充用户意图序）。
          if (!Number.isSafeInteger(payload?.generation)) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("generation required: client-issued monotonic intent revision");
            return;
          }
          const generation = payload.generation;
          const result = pendingSelections.set(sessionId, targets, generation);
          if (result.stale) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, stale: true, reason: result.reason, currentGeneration: pendingSelections.currentGeneration(sessionId) }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, generation, pending: targets.length > 0 ? { generation, targets } : null }));
          return;
        }

        const parsed = parsePath(url);
        if (!parsed || !LAYER_KEYS.has(parsed.layer)) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("bad path: expected /notes-api/<sessionId>/<layer>");
          return;
        }
        const { sessionId, layer } = parsed; // layer = semantic key
        if (!SESSION_ID_RE.test(sessionId)) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("bad session id");
          return;
        }
        const sessions = ctx.get("sessions");
        const session = sessions?.get?.(sessionId);
        const cwd = session?.header?.cwd;
        if (!cwd) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("session not found");
          return;
        }
        // Per-session isolation: <bound Notes root>/<key>/<sessionId>.md — the
        // filename is the provenance; contents mirror the note exactly.  In a
        // In a workspace-bound composition the root is selected by the durable workspace
        // binding.  Opening the panel or reading an uninitialized workspace
        // must not create the old notes tree.
        let notesRoot;
        try {
          // A missing default root is allowed only before its first local
          // materialization. A configured root that was later removed fails
          // closed in workspaceRuntime.rootForSession().
          notesRoot = workspaceRuntime
            ? (await workspaceRuntime.rootForSession(sessionId, { allowInitialMissing: true })).notesRoot
            : resolve(cwd, "notes");
        } catch (error) {
          if (error?.code === "NOTES_SETUP_REQUIRED") {
            res.writeHead(428, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, code: "NOTES_SETUP_REQUIRED", reason: "Collaborative Notes storage has not been configured for this workspace" }));
            return;
          }
          if (error?.code === "NOTES_CONFIGURED_ROOT_UNAVAILABLE") {
            res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: false, code: error.code, reason: error.message }));
            return;
          }
          throw error;
        }
        const rootLstat = await lstat(notesRoot).catch((error) =>
          error?.code === "ENOENT" ? null : Promise.reject(error)
        );
        if (rootLstat?.isSymbolicLink()) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("path escapes notes dir");
          return;
        }
        const realCwd = workspaceRuntime ? null : await realpath(cwd);
        const realNotes = rootLstat ? await realpath(notesRoot) : null; // 非 symlink 时才 realpath
        if (!workspaceRuntime && realNotes && !realNotes.startsWith(realCwd + sep)) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("path escapes notes dir");
          return;
        }
        // 层目录 lstat：拒绝已有 symlink（含 dangling），防 mkdir 沿链接创建
        const layerLstat = await lstat(resolve(notesRoot, layer)).catch((error) =>
          error?.code === "ENOENT" ? null : Promise.reject(error)
        );
        if (layerLstat?.isSymbolicLink()) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("path escapes notes dir");
          return;
        }
        if (!workspaceRuntime) await ensureNotesTree(cwd);
        else if (req.method === "PUT") {
          await mkdir(resolve(notesRoot, layer), { recursive: true });
          // Consume the one-time default-root materialization allowance before
          // precondition parsing or body handling can fail. A failed first PUT
          // must not leave a later request able to recreate a deleted root.
          workspaceRuntime?.markRootMaterialized?.((await workspaceRuntime.rootForSession(sessionId, { allowInitialMissing: true })).workspaceId);
        }
        const file = resolve(notesRoot, layer, `${sessionId}.md`); // dir == key
        if (!file.startsWith(notesRoot + sep)) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("path escapes notes dir");
          return;
        }
        // mkdir 后 layer 级 realpath 校验（TOCTOU 竞态防御：mkdir 后若被换 symlink，
        // 跟随检查暴露；此时可能已无外部副作用——mkdir 前的 lstat 已挡住既有链接）
        if (!workspaceRuntime || layerLstat || req.method === "PUT") {
          try {
            const realLayer = await realpath(resolve(notesRoot, layer));
            // base 在 mkdir 后重新取真实路径（首次创建时 mkdir 前的 realNotes 为 null）
            const baseNotes = await realpath(notesRoot);
            if (!realLayer.startsWith(baseNotes + sep)) {
              res.writeHead(400, { "content-type": "text/plain" });
              res.end("path escapes notes dir");
              return;
            }
          } catch (error) {
            throw error; // realpath failure (dir removed concurrently) → 500
          }
        }

        // fork/carry eligibility decision stale-safety: Notes GET/PUT now run under the SHARED
        // host fs per-target lock — the same canonical targetKey the formal
        // tool-fs writers (ctx.fs.writeText/editText) serialize on — instead of
        // the plugin-private fileLocks. Contract unchanged: X-Notes-Mtime /
        // If-Match / 428 / 409 / explicit overwrite behave exactly as before.
        // Must await: `return promise` rejections escape this try/catch.
        const httpTarget = await fs.resolve(file, { cwd });
        await fs.withLock(httpTarget.targetKey, async () => {
        if (req.method === "GET") {
          let body = "";
          let mtime = "0"; // absent-file baseline (empty note)
          try {
            const [content, stat] = await Promise.all([
              readFile(file, "utf8").catch((error) => {
                if (error?.code !== "ENOENT") throw error;
                return "";
              }),
              statFile(file).catch((error) =>
                error?.code === "ENOENT" ? null : Promise.reject(error)
              ),
            ]);
            body = content;
            if (stat) mtime = String(stat.mtimeMs);
          } catch (error) {
            throw error; // other read errors → 500
          }
          // X-Notes-Mtime: concurrency baseline (sent back as If-Match on save);
          // Cache-Control: no-store: never serve stale note content from cache.
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "x-notes-mtime": mtime,
          });
          res.end(body);
          return;
        }
        if (req.method === "PUT") {
          // I0-B: an ordinary destructive PUT without a version precondition is no
          // longer accepted. A protected save MUST carry If-Match (the baseline
          // mtime from GET's X-Notes-Mtime). A stale If-Match answers 409 with the
          // latest content + mtime; the client then offers load-latest / overwrite /
          // cancel. The ONLY deliberate no-precondition overwrite is the
          // user-explicit conflict override below (X-Notes-Overwrite: 1), which the
          // UI sends only after the user saw the 409 conflict and chose "overwrite
          // anyway". Plain callers cannot bypass the precondition by omitting the
          // header — an unpreconditioned PUT is rejected (428 Precondition Required).
          const ifMatch = req.headers["if-match"];
          const explicitOverwrite = req.headers["x-notes-overwrite"] === "1";
          if (ifMatch !== undefined) {
            const current = await statFile(file).catch((error) =>
              error?.code === "ENOENT" ? null : Promise.reject(error)
            );
            const currentMtime = current ? String(current.mtimeMs) : "0";
            if (String(ifMatch) !== currentMtime) {
              // 409: changed by someone else (agent append / another panel) —
              // return latest content + latest mtime; client offers three
              // choices (load latest / overwrite anyway / cancel).
              req.resume?.(); // drain request body (keep-alive hygiene)
              let latest = "";
              try {
                latest = await readFile(file, "utf8");
              } catch (error) {
                if (error?.code !== "ENOENT") throw error;
              }
              res.writeHead(409, {
                "content-type": "text/plain; charset=utf-8",
                "cache-control": "no-store",
                "x-notes-mtime": currentMtime,
              });
              res.end(latest);
              return;
            }
          } else if (!explicitOverwrite) {
            // I0-B: unpreconditioned destructive PUT is rejected. A caller that
            // wants to overwrite without a baseline must be a deliberate
            // user-explicit override (X-Notes-Overwrite: 1), not an ordinary save.
            req.resume?.(); // drain request body (keep-alive hygiene)
            res.writeHead(428, { "content-type": "text/plain" });
            res.end("precondition required: send If-Match (from X-Notes-Mtime) or X-Notes-Overwrite: 1 for a deliberate user-confirmed overwrite");
            return;
          }
          const chunks = [];
          let size = 0;
          let tooLarge = false;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              tooLarge = true;
              req.resume?.(); // drain remaining body (keep-alive hygiene)
              break;
            }
            chunks.push(chunk);
          }
          if (tooLarge) {
            res.writeHead(413, { "content-type": "text/plain" });
            res.end("payload too large");
            return;
          }
          // Write verbatim (exact mirror, no source header); atomic replace via
          // same-dir temp file + rename so an interrupted process never leaves
          // a half-written note.
          const body = Buffer.concat(chunks).toString("utf8");
          const tmp = `${file}.tmp`;
          await writeFile(tmp, body, "utf8");
          await rename(tmp, file);
          const st = await statFile(file); // return new mtime so the client updates its baseline
          workspaceRuntime?.markRootMaterialized?.((await workspaceRuntime.rootForSession(sessionId, { allowInitialMissing: true })).workspaceId);
          res.writeHead(200, { "content-type": "text/plain", "x-notes-mtime": String(st.mtimeMs) });
          res.end("ok");
          return;
        }
        req.resume?.(); // 405: drain request body before responding
        res.writeHead(405);
        res.end();
        }); // fs.withLock end
      } catch (error) {
        // Error hygiene: log details, respond generic 500 (no internals leaked).
        console.error("[dsh-collab-notes] /notes-api error:", error);
        if (error instanceof NotesOperationError) {
          const status = error.code === "NOTES_SETUP_REQUIRED" ? 428 : 409;
          res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: false, code: error.code, reason: error.message }));
          return;
        }
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      }
    };

  // DSH 0.1.5 public carrier: one exact Fetch route, with the existing
  // business path/query carried opaquely so all Notes/CAS semantics remain in
  // the already-tested handler above.  The declared injection is `connection`;
  // this plugin does not claim an older-host webServer fallback.  The guarded
  // plain-object branch exists only for browser-free unit fixtures, which pass
  // an own `webServer` property without going through Cordis injection.
  if (ctx.connection?.fetch?.register) {
    ctx.connection.fetch.register({
      path: "/api/notes-api",
      methods: ["GET", "POST", "PUT", "HEAD"],
      requestBody: "buffered",
      fetch: async (request) => {
        const carrierUrl = new URL(request.url);
        const route = carrierUrl.searchParams.get("route");
        if (!route || (route !== "/notes-api" && !route.startsWith("/notes-api/"))) {
          return new Response("not found", { status: 404 });
        }
        const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
        const headers = Object.fromEntries(request.headers.entries());
        if (!headers.host) headers.host = carrierUrl.host;
        const req = {
          method: request.method,
          url: route,
          headers,
          resume() {},
          [Symbol.asyncIterator]: async function* () { if (body.length > 0) yield Buffer.from(body, "utf8"); },
        };
        const responseState = { status: 200, headers: {}, body: "" };
        const res = {
          writeHead(status, responseHeaders = {}) { responseState.status = status; responseState.headers = responseHeaders; return this; },
          end(value) { responseState.body = value ?? ""; },
        };
        await notesHttpHandler(req, res);
        return new Response(responseState.body, { status: responseState.status, headers: responseState.headers });
      },
    });
  } else if (Object.prototype.hasOwnProperty.call(ctx, "webServer") && ctx.webServer?.register) {
    ctx.webServer.register({ kind: "prefix", path: "/notes-api", handler: notesHttpHandler });
  }

  // Notes behavior: current-holder selection → current-turn reference binding.
  // pendingSelections = ephemeral in-memory per-session pending targets
  // (session-scoped; NOT durable, never written to Note files/localStorage/DB).
  // client PUTs the user's selected targets here; on the next direct user
  // message the agent/pre-step listener resolves current Note content and
  // injects a plugin-originated reference user/message BEFORE that request.
  // lastBinding keeps the truthful outcome (ok / failures / noteCount) for the
  // client's selection-status query — success clears the tray, failure keeps it.
  const pendingSelections = createPendingStore();
  const lastBinding = new Map(); // sessionId -> { ok, noteCount?, failures?, at }

  /** laneReader：与 notes GET 同一安全路径（notesRoot 校验 + targetKey 锁）读当前
   *  lane body（absent = ""）。只读；调用方（binding-wiring）从不写。 */
  const laneReader = readLaneBody;

  ctx.on(
    "agent/pre-step",
    createPreStepBinding({
      store: pendingSelections,
      laneReader,
      cwdOf: (sessionId) => {
        const sessions = ctx.get("sessions");
        return sessions?.get?.(sessionId)?.header?.cwd;
      },
      onResult: (sessionId, r) => {
        lastBinding.set(sessionId, { ...r, at: Date.now() });
      },
      resolveCarry: ({ sessionId, laneKey, itemKey }) => resolveExactCarry({
        sessionId,
        lane: laneKey,
        itemKey,
        itemKeyOccurrences: 1,
      }),
    })
  );

  // Durable confirm：pending 只在 reference 真正 append 成 user/message 历史后
  // 清除（不在 pre-step listener 构造 decision 时清）。观测 session/event 中本
  // 插件 notes-reference user/message 的 append（seq 入 log = durable；jsonl 由
  // checkpoint-policy 在 llm 前 flush）。source metadata 匹配：
  //   source.kind==="plugin" && source.plugin==="dsh-collab-notes" &&
  //   source.form==="notes-reference"
  // append 前 abort/失败不会产生该事件 → pending 保留（无 silent clear）。
  // callbackArgs = [session, event]（dsh-session append 同步 emit，观察者实证）。
  // 配对确认：仅观测到 notes-reference append
  // 还不够——须等**同一 decision 的 CURRENT direct user 也 durable append** 才清
  // pending/报 ok。reference 与其 direct 由 agent-loop 逐条 append
  // （decision.messages 顺序），故配对 = reference append 后、同 turn 内出现下一条
  // source.kind==="user" 的 user/message。pairTracker 关联 binding generation：旧代
  // pair（迟到 reference）不得确认新一代 selection。本地 in-memory 配对 tracker
  // （非 durable registry）。
  const pairTracker = new Map(); // sessionId -> { state: "awaitingDirect", generation }
  ctx.on("session/event", (session, event) => {
    try {
      if (!event || event.type !== "user/message") return;
      const src = event.data && event.data.source;
      const sessionId = session && (session.id || (session.header && session.header.id));
      if (!sessionId) return;
      const isReference = src && src.kind === "plugin" && src.plugin === "dsh-collab-notes" && src.form === "notes-reference";
      const isDirectUser = src && src.kind === "user";
      const eventSeq = Number.isSafeInteger(event.seq) ? event.seq : null;
      const tracker = pairTracker.get(sessionId);
      if (isReference) {
        // reference append：仅当确有 injected pending（且带 generation）在等确认时
        // 标记等 direct——pair 绑定该 generation + reference 事件 seq（当前绑定规则）。
        // 事件序证据：注入时刻记录 injectSeq 基线（binding-wiring
        // markInjected 第三参），旧/重放 reference（seq ≤ 基线）**不 arm**；reference
        // 必须带**可验证整数 seq**（缺失 seq 无法证明是当前注入产物 → 不 arm，保持
        // pending）。若已 arm 的 tracker 属于**旧 generation**（新 generation 已注入、
        // 其真实 reference 到达）→ 允许当前 generation 的新 reference **替换**旧
        // tracker（否则合法的新绑定会卡死、旧 tracker 会让普通 direct 误判）。
        const p = pendingSelections.get(sessionId);
        const baseline = p && Number.isSafeInteger(p.injectSeq) ? p.injectSeq : -1;
        const reliableBaseline = p && p.injectReliable === true;
        // eligible 同时要求：injected pending + 可验证 generation + **可靠基线** +
        // 可验证整数 seq 且 seq > 基线（无可靠基线时旧/重放 reference 也可
        // seq > 任意小值 → 不得 arm，宁保持 pending）。
        const eligible =
          p && p.state === "injected" && Number.isSafeInteger(p.generation) &&
          reliableBaseline && eventSeq !== null && eventSeq > baseline;
        const armedForCurrent = tracker && tracker.state === "awaitingDirect" && tracker.generation === p?.generation;
        if (eligible && !armedForCurrent) {
          pairTracker.set(sessionId, { state: "awaitingDirect", generation: p.generation, refSeq: eventSeq });
        }
        return;
      }
      if (isDirectUser && tracker && tracker.state === "awaitingDirect") {
        // direct user append 到达 → 配对候选。confirmDurable 内部校验 pending 仍为
        // injected 且 generation 与 pair 一致（旧 pair 不能 confirm 新 selection）。
        const p = pendingSelections.get(sessionId);
        if (!p || p.state !== "injected" || p.generation !== tracker.generation) {
          // 配对代与新 pending 代不一致（新 selection 已来、旧 pair 迟到）→ 旧
          // tracker 死亡：删除 + 不确认；新 pending 若仍 injected 由它自己的后续
          // reference/direct 配对。
          pairTracker.delete(sessionId);
          ctx.logger?.info?.("[dsh-collab-notes] stale pair dropped (generation mismatch)", { sessionId, pairGen: tracker.generation, pendingGen: p?.generation });
          return;
        }
        // Notes behavior 序证据：direct 必须带**可验证整数 seq** 且出现在 arm 它的
        // reference **之后**（同 decision append 序：reference → direct；严格
        // 邻接同构）。缺失 seq 或 seq ≤ refSeq（旧/重放 direct）→ 保持 pending，
        // **不确认且不删除 tracker**（同 decision 的真实 direct（有 seq）仍可确认）。
        if (eventSeq === null || tracker.refSeq === null || eventSeq <= tracker.refSeq) {
          ctx.logger?.info?.("[dsh-collab-notes] direct not confirmable (missing seq or order violation)", { sessionId, directSeq: eventSeq, refSeq: tracker.refSeq });
          return;
        }
        pairTracker.delete(sessionId);
        const confirmed = confirmDurableBinding(
          {
            store: pendingSelections,
            onResult: (sid, r) => {
              lastBinding.set(sid, { ...r, at: Date.now() });
            },
          },
          sessionId
        );
        if (confirmed) {
          ctx.logger?.info?.("[dsh-collab-notes] reference + direct pair durably appended; selection cleared", { sessionId, generation: tracker.generation });
        }
        return;
      }
      // 其它 user/message（历史重放 / 无关轮）：不影响配对
    } catch (e) {
      ctx.logger?.error?.("[dsh-collab-notes] session/event binding confirm error", String((e && e.message) || e));
    }
  });

  // fork/carry eligibility decision: detect ordinary fork children and record an unresolved carry-over
  // marker. session/created is fire-and-forget, so we only record state here —
  // we never copy Notes and never block the fork. Copy happens later, only
  // after the user explicitly chooses all/some/none. The per-child lock keeps
  // this late initialization from racing a user decision: if a decision already
  // landed (none/carried), we MUST NOT overwrite it.
  ctx.on("session/created", async (session) => {
    try {
      if (!isOrdinaryForkChild(session)) return;
      const cwd = session.header.cwd;
      const childId = session.id;
      if (!cwd || !SESSION_ID_RE.test(childId)) return;
      let notesRootOverride;
      try { notesRootOverride = await boundNotesRoot(childId, cwd); }
      catch (error) {
        // An uninitialized workspace must not receive even a
        // carry-over marker: that is Notes-owned durable state and first-use
        // setup has not yet authorized a location.
        if (error?.code === "NOTES_SETUP_REQUIRED") return;
        throw error;
      }
      await withCarryOverLock(childId, async () => {
        const existing = await readCarryOverMarker(cwd, childId, notesRootOverride);
        if (existing) return; // already decided or already recorded — never overwrite a decision
        await writeCarryOverMarker(cwd, childId, {
          version: 1,
          parentSessionId: session.header.parentSession,
          status: "unresolved",
          carriedLanes: null,
          decidedAt: null,
        }, notesRootOverride);
      });
    } catch (error) {
      // Marker write is best-effort bookkeeping; never break session creation.
      console.error("[dsh-collab-notes] carry-over marker write failed:", error);
    }
  });

  // Agent skill: render the collaboration rules from the one authoritative
  // template into DSH rc.2's in-process registry. The runtime registration is
  // model-discoverable while this plugin is installed and is disposed with the
  // plugin context; no user-root Skill file is created or retained.
  await registerSkill(layers);
}
