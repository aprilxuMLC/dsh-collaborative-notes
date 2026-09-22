// dsh-collab-notes client state-machine tests (vitest + happy-dom + testing-library).
//
// 直接加载构建产物 lib/client.js（IIFE + ModuleLoader），从 load 回调捕获
// factory，用假 ctx 触发 slots.register 拿到真实组件，用 @testing-library/react
// 渲染并驱动交互。fetch / confirm 全部可控 mock，覆盖：
//   慢 GET 返回前编辑不覆盖 / 刷新后再编辑不覆盖 / 保存中切页签不串层 /
//   保存中关闭不崩溃 / dirty 关闭与切页签的 confirm 拦截 / 保存带 If-Match 基线 /
//   保存成功基线更新 / 409 三选（加载最新 / 仍覆盖 / 取消）
//
// 运行：npm run test:client
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import React from "react";
import { getItemKey, makeItem, newItemKey, parseLaneBody, serializeItem, withItemKey } from "../lib/structured-item.js";
import { composeCarryMerge } from "../lib/carry-merge.js";
import { en, zh } from "../src/locales.js";

const SESSION = "session-test-0001-0001";
let loader;

// 加载构建产物：IIFE 执行时调用 window.__ModuleLoader__.load，捕获其回调
window.__ModuleLoader__ = { load: (cfg) => { loader = cfg; } };
await import("../lib/client.js");

/** 从 ModuleLoader factory 还原插件并拿到注册的组件（复制真实 apply 的注册路径）。 */
function mountPanel({ uiWorkspace, settingsScope, locale } = {}) {
  const { apply } = loader.factory((id) => {
    if (id === "react") return React;
    throw new Error(`unexpected require: ${id}`);
  });
  let registered = null;
  const ctx = {
    settingsScope,
    locale,
    slots: {
      inject: (_name, fn) => { registered = fn(); },
      register: (cfg, Component) => ({ cfg, Component }),
    },
  };
  apply(ctx, React);
  // Set after registration too: this mirrors a host that resolves injected
  // client services immediately after slot registration.
  if (uiWorkspace) ctx.uiWorkspace = uiWorkspace;
  return render(React.createElement(registered.Component, { sessionId: SESSION }));
}

function makeProfileSettingsScope({ locale = "en", layerOverrides = {}, writable = true } = {}) {
  let snapshot = {
    status: "ready",
    writable,
    value: { layerOverrides },
    user: { layerOverrides },
  };
  const listeners = new Set();
  const bound = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    set: vi.fn(async (field, value) => {
      snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value }, user: { ...snapshot.user, [field]: value } };
      listeners.forEach((listener) => listener());
    }),
  };
  const dictionary = locale === "zh" ? zh : en;
  const translate = (key, params) => {
    const template = dictionary[key] ?? key;
    return params ? template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match) : template;
  };
  return {
    bind: vi.fn(() => bound),
    bound,
    locale: { getLocale: () => ({ active: locale }), bind: vi.fn(() => translate) },
  };
}

function makeResponse(body, { status = 200, mtime = "1000", contentType = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => {
      const name = String(n).toLowerCase();
      if (name === "x-notes-mtime") return mtime;
      if (name === "content-type") return contentType;
      return null;
    } },
    text: async () => body,
  };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 默认 fetch：GET 立即返回空内容（mtime 1111），PUT 立即成功（mtime 2222）。 */
function installDefaultFetch() {
  const fn = vi.fn((_url, opts) => {
    if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
    return Promise.resolve(makeResponse("", { mtime: "1111" }));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const openPanel = async () => {
  fireEvent.click(screen.getByTitle("协作便签"));
  await waitFor(() => screen.getByRole("textbox"));
};
const type = (value) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });

// Notes behavior regression (behavior regression): 默认便签视图下唯一的 textbox 是 composer 的；操作“整层 lane body”的
// 既有测试须先打开“原文编辑（高级）”区（旧的全层 textarea 编辑器，语义照旧）再交互。
const openRawView = async () => {
  const toggle = screen.getByRole("button", { name: "原文编辑（高级）" });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByRole("button", { name: "原文编辑（高级）" })).toBeNull());
};

beforeEach(() => {
  vi.stubGlobal("confirm", vi.fn(() => true));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("便签面板状态机（v1.1 并发模型）", () => {
  it("首次英文设置提供四个描述性建议并按顶层 layerOverrides 写入", async () => {
    const profile = makeProfileSettingsScope({ locale: "en" });
    const setupPost = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (url === "/notes-api/meta") {
        return Promise.resolve({ ok: true, json: async () => ({ layers: [
          { key: "conversation_todo", displayId: "L1", label: "L1 Conversation To-do", policy: "active" },
          { key: "deferred_work", displayId: "L2", label: "L2 Deferred Work", policy: "releasable" },
          { key: "knowledge_candidate", displayId: "L3", label: "L3 Knowledge Candidate", policy: "releasable" },
          { key: "lesson_candidate", displayId: "L4", label: "L4 Lesson Candidate", policy: "releasable" },
        ] }) });
      }
      if (String(url).includes("/setup/") && opts?.method === "POST") {
        setupPost(opts);
        return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED" })));
      }
      if (String(url).includes("/setup/")) {
        return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes" })));
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ settingsScope: profile, locale: profile.locale });
    fireEvent.click(screen.getByTitle("Collaborative Notes"));
    await waitFor(() => expect(document.querySelectorAll("[data-notes-lane-name]").length).toBe(4));
    const expected = {
      conversation_todo: "Conversation To-do",
      deferred_work: "Deferred Work",
      knowledge_candidate: "Knowledge Candidate",
      lesson_candidate: "Lesson Candidate",
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(document.querySelector(`[data-notes-lane-name="${key}"]`).value).toBe(value);
    }
    fireEvent.change(document.querySelector('[data-notes-lane-name="deferred_work"]'), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Use default location" }));
    await waitFor(() => expect(screen.getByText("All four lane names are required and cannot be blank.")).toBeTruthy());
    expect(profile.bound.set).not.toHaveBeenCalled();
    expect(setupPost).not.toHaveBeenCalled();
    fireEvent.change(document.querySelector('[data-notes-lane-name="deferred_work"]'), { target: { value: expected.deferred_work } });
    fireEvent.click(screen.getByRole("button", { name: "Use default location" }));
    await waitFor(() => expect(profile.bound.set).toHaveBeenCalledWith("layerOverrides", expect.any(Object)));
    const saved = profile.bound.set.mock.calls[0][1];
    expect(Object.fromEntries(Object.entries(saved).map(([key, value]) => [key, value.label]))).toEqual(expected);
    expect(setupPost).toHaveBeenCalledTimes(1);
  });

  it("首次中文设置提供四个描述性建议", async () => {
    const profile = makeProfileSettingsScope({ locale: "zh" });
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (url === "/notes-api/meta") return Promise.resolve({ ok: true, json: async () => ({ layers: [] }) });
      if (String(url).includes("/setup/")) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ settingsScope: profile, locale: profile.locale });
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(document.querySelectorAll("[data-notes-lane-name]").length).toBe(4));
    expect(document.querySelector('[data-notes-lane-name="conversation_todo"]').value).toBe("会话待办");
    expect(document.querySelector('[data-notes-lane-name="deferred_work"]').value).toBe("延后工作");
    expect(document.querySelector('[data-notes-lane-name="knowledge_candidate"]').value).toBe("知识候选");
    expect(document.querySelector('[data-notes-lane-name="lesson_candidate"]').value).toBe("复盘素材");
  });

  it("已建立 profile + 第二个未初始化 workspace 不重新命名或改写 vocabulary", async () => {
    const profile = makeProfileSettingsScope({
      locale: "en",
      layerOverrides: {
        conversation_todo: { label: "会话待办" },
        deferred_work: { label: "转BACKLOG" },
        knowledge_candidate: { label: "01知识摘录" },
        lesson_candidate: { label: "复盘素材" },
      },
    });
    const setupPost = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (url === "/notes-api/meta") return Promise.resolve({ ok: true, json: async () => ({ layers: [] }) });
      if (String(url).includes("/setup/") && opts?.method === "POST") {
        setupPost(opts);
        return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      }
      if (String(url).includes("/setup/")) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace-b/notes" })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ settingsScope: profile, locale: profile.locale });
    fireEvent.click(screen.getByTitle("Collaborative Notes"));
    await waitFor(() => expect(screen.getByText("Confirm the storage location before saving your first note.")).toBeTruthy());
    expect(document.querySelectorAll("[data-notes-lane-name]").length).toBe(0);
    expect(screen.getByText("Suggested location in its workspace: /workspace-b/notes")).toBeTruthy();
    expect(profile.bound.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use default location" }));
    await waitFor(() => expect(setupPost).toHaveBeenCalledTimes(1));
    expect(profile.bound.set).not.toHaveBeenCalled();
    expect(profile.bound.getSnapshot().value.layerOverrides).toEqual({
      conversation_todo: { label: "会话待办" },
      deferred_work: { label: "转BACKLOG" },
      knowledge_candidate: { label: "01知识摘录" },
      lesson_candidate: { label: "复盘素材" },
    });
  });

  it("已建立 vocabulary + profile 不可写时仍可初始化第二 workspace", async () => {
    const profile = makeProfileSettingsScope({
      locale: "en",
      writable: false,
      layerOverrides: {
        conversation_todo: { label: "会话待办" },
        deferred_work: { label: "转BACKLOG" },
        knowledge_candidate: { label: "01知识摘录" },
        lesson_candidate: { label: "复盘素材" },
      },
    });
    const setupPost = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (url === "/notes-api/meta") return Promise.resolve({ ok: true, json: async () => ({ layers: [] }) });
      if (String(url).includes("/setup/") && opts?.method === "POST") {
        setupPost(opts);
        return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      }
      if (String(url).includes("/setup/")) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace-b/notes" })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ settingsScope: profile, locale: profile.locale });
    fireEvent.click(screen.getByTitle("Collaborative Notes"));
    await waitFor(() => expect(screen.getByText("Confirm the storage location before saving your first note.")).toBeTruthy());
    expect(document.querySelectorAll("[data-notes-lane-name]").length).toBe(0);
    const setupButton = screen.getByRole("button", { name: "Use default location" });
    expect(setupButton.disabled).toBe(false);
    fireEvent.click(setupButton);
    await waitFor(() => expect(setupPost).toHaveBeenCalledTimes(1));
    expect(JSON.parse(setupPost.mock.calls[0][0].body).action).toBe("default");
    expect(profile.bound.set).not.toHaveBeenCalled();
    expect(profile.bound.getSnapshot().value.layerOverrides).toEqual({
      conversation_todo: { label: "会话待办" },
      deferred_work: { label: "转BACKLOG" },
      knowledge_candidate: { label: "01知识摘录" },
      lesson_candidate: { label: "复盘素材" },
    });
  });

  it("已建立的 profile vocabulary 在 locale remount 后保持字面值", async () => {
    const profile = makeProfileSettingsScope({
      locale: "en",
      layerOverrides: {
        conversation_todo: { label: "会话待办" },
        deferred_work: { label: "转BACKLOG" },
        knowledge_candidate: { label: "01知识摘录" },
        lesson_candidate: { label: "复盘素材" },
      },
    });
    const meta = { layers: [
      { key: "conversation_todo", displayId: "L1", label: "L1 会话待办", policy: "active" },
      { key: "deferred_work", displayId: "L2", label: "L2 转BACKLOG", policy: "releasable" },
      { key: "knowledge_candidate", displayId: "L3", label: "L3 01知识摘录", policy: "releasable" },
      { key: "lesson_candidate", displayId: "L4", label: "L4 复盘素材", policy: "releasable" },
    ] };
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (url === "/notes-api/meta") return Promise.resolve({ ok: true, json: async () => meta });
      if (String(url).includes("/setup/")) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ settingsScope: profile, locale: profile.locale });
    fireEvent.click(screen.getByTitle("Collaborative Notes"));
    await waitFor(() => expect(screen.getByRole("button", { name: "L1 会话待办" })).toBeTruthy());
    cleanup();
    profile.locale.getLocale = () => ({ active: "zh" });
    mountPanel({ settingsScope: profile, locale: profile.locale });
    fireEvent.click(screen.getByTitle("Collaborative Notes"));
    await waitFor(() => expect(screen.getByRole("button", { name: "L1 会话待办" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "L1 Conversation To-do" })).toBeNull();
    expect(profile.bound.set).not.toHaveBeenCalled();
  });

  it("打开面板 → GET 加载当前层内容", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(makeResponse("已存内容", { mtime: "5555" }))));
    mountPanel();
    await openPanel();
    // Notes behavior regression: 整层内容在“原文编辑（高级）”区读（默认便签视图的 textbox 是 composer）
    await openRawView();
    expect(screen.getByRole("textbox").value).toBe("已存内容");
  });

  it("慢 GET 返回前用户输入 → 输入不被加载结果覆盖", async () => {
    const get = makeDeferred();
    vi.stubGlobal("fetch", vi.fn((_url, opts) => {
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return get.promise;
    }));
    mountPanel();
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByRole("textbox"));
    await openRawView();
    type("my input");
    get.resolve(makeResponse("server-old", { mtime: "1111" }));
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("my input"));
  });

  it("刷新发出后用户再输入 → 刷新结果不覆盖新输入", async () => {
    const refreshGet = makeDeferred();
    const fetchFn = vi.fn((_url, opts) => {
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      if (screen.queryByRole("textbox")) {
        // 面板已打开后（刷新场景）的 GET 挂起；首次打开立即返回
        return refreshGet.promise;
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 刷新目标 = 整层 textarea（原文编辑视图）
    fireEvent.click(screen.getByTitle("刷新（重新加载本层）"));
    type("after-refresh-edit");
    refreshGet.resolve(makeResponse("server-new", { mtime: "9999" }));
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("after-refresh-edit"));
  });

  it("dirty 时关闭 → confirm 拦截（拒绝则不关闭，同意则关闭）", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("fetch", installDefaultFetch());
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("draft");
    fireEvent.click(screen.getByTitle("关闭（Esc）"));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeTruthy(); // 仍打开

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByTitle("关闭（Esc）"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull()); // 已关闭
  });

  it("dirty 时切页签 → confirm 拦截；确认后加载新层", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(makeResponse("L2-content", { mtime: "3333" }))));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("draft");
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("textbox").value).toBe("draft"); // 未切换

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("L2-content"));
  });

  it("保存 PUT 带 If-Match = 加载基线 mtime", async () => {
    const fetchFn = installDefaultFetch();
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("hi");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    const put = fetchFn.mock.calls.find(([, o]) => o?.method === "PUT");
    expect(put[1].headers["if-match"]).toBe("1111"); // 与 GET 返回的 mtime 一致
  });

  it("保存成功 → 基线更新 + 清 dirty + 显示已保存", async () => {
    const fetchFn = installDefaultFetch();
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("hi");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText("已保存 ✓")).toBeTruthy());
    // 第二次保存应带新基线（2222）
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT").length).toBe(2));
    const put2 = fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT")[1];
    expect(put2[1].headers["if-match"]).toBe("2222");
  });

  it("409 → 加载最新：textarea 变为服务端最新内容", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, opts) => {
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("newest", { status: 409, mtime: "3333" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("mine");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => screen.getByRole("button", { name: "加载最新" }));
    fireEvent.click(screen.getByRole("button", { name: "加载最新" }));
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("newest"));
  });

  it("409 → 仍覆盖：第二次 PUT 走显式覆盖头（X-Notes-Overwrite）", async () => {
    const fetchFn = vi.fn((_url, opts) => {
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("newest", { status: 409, mtime: "3333" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("mine");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => screen.getByRole("button", { name: "仍覆盖" }));
    fireEvent.click(screen.getByRole("button", { name: "仍覆盖" }));
    await waitFor(() => expect(fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT").length).toBe(2));
    const put2 = fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT")[1];
    // I0-B: 用户显式"仍覆盖" → X-Notes-Overwrite: 1（deliberate overwrite），非普通 If-Match 重试
    expect(put2[1].headers["x-notes-overwrite"]).toBe("1");
    expect(put2[1].headers["if-match"]).toBeUndefined();
  });

  it("409 → 取消：保留本地编辑，不写文件", async () => {
    const fetchFn = vi.fn((_url, opts) => {
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("newest", { status: 409, mtime: "3333" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区（同时避免 composer 的“取消”歧义）
    type("mine");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("textbox").value).toBe("mine");
    expect(fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT").length).toBe(1); // 未重试
  });

  it("逻辑 409 → 显示位置不可用，不进入 CAS 冲突三选", async () => {
    const fetchFn = vi.fn((_url, opts) => {
      if (opts?.method === "PUT") {
        return Promise.resolve(makeResponse(JSON.stringify({
          ok: false,
          code: "NOTES_CONFIGURED_ROOT_UNAVAILABLE",
          reason: "configured Notes location is unavailable",
        }), { status: 409, contentType: "application/json; charset=utf-8" }));
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    await openRawView();
    type("location draft");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText("configured Notes location is unavailable")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "加载最新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "仍覆盖" })).toBeNull();
  });

  it("保存中切页签 → 旧 PUT 结果不串到新层（saveSeq 失效）", async () => {
    const put = makeDeferred();
    vi.stubGlobal("fetch", vi.fn((_url, opts) => {
      if (opts?.method === "PUT") return put.promise;
      return Promise.resolve(makeResponse("L2-content", { mtime: "4444" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("draft");
    fireEvent.click(screen.getByRole("button", { name: "保存" })); // PUT 挂起
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" })); // confirm=true 直接切
    put.resolve(makeResponse("ok", { mtime: "2222" }));
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("L2-content"));
    expect(screen.queryByText("已保存 ✓")).toBeNull(); // 旧 PUT 已失效
  });

  it("meta 标签覆盖：本地安装可个性化层名", async () => {
    vi.stubGlobal("fetch", vi.fn((input) => {
      if (input === "/notes-api/meta") {
        return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ layers: [
          { key: "conversation_todo", displayId: "L1", label: "L1 自定义待办", policy: "active" },
          { key: "deferred_work", displayId: "L2", label: "L2 延后工作", policy: "releasable" },
        ] }) });
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    expect(screen.getByRole("button", { name: "L1 自定义待办" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "L2 延后工作" })).toBeTruthy(); // 未覆盖的保持默认
  });

  it("Workspace setup 首次打开未初始化 → 显示位置门槛；确认默认位置才提交绑定", async () => {
    const fetchFn = vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes", browseStartPath: "/workspace" })));
      if (String(url).includes("/setup/") && opts?.method === "POST") return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText("保存前需要先配置协作便签位置")).toBeTruthy());
    expect(document.querySelector('[data-notes-setup-warning="1"]')).toBeTruthy();
    expect(screen.getByText("首次保存便签前，请先确认它的存储位置。")).toBeTruthy();
    expect(screen.getByText("建议存储位置在其工作区内：/workspace/notes")).toBeTruthy();
    expect(fetchFn.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认使用默认位置" }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([, opts]) => opts?.method === "POST" && JSON.parse(opts.body).action === "default")).toBe(true));
  });

  it("Workspace setup 选择其他位置 → 首次 browse 延迟发生且成功 listing 被复用", async () => {
    const listing = {
      path: "/home/test-user/notes-choice",
      home: "/home/test-user",
      crumbs: [{ name: "Home", path: "/home/test-user", hidden: false }],
      entries: [{ name: "child", path: "/home/test-user/notes-choice/child", hidden: false }],
      truncated: false,
    };
    let browseCalls = 0;
    const uiWorkspace = {
      async listDirectory(path) { browseCalls++; expect(path).toBe("/workspace"); return listing; },
      async pickDirectory() { throw new Error("native picker should not be used after browse success"); },
    };
    const fetchFn = vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes", browseStartPath: "/workspace" })));
      if (String(url).includes("/setup/") && opts?.method === "POST") return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel({ uiWorkspace });
    await openPanel();
    await waitFor(() => expect(screen.getByText("保存前需要先配置协作便签位置")).toBeTruthy());
    expect(browseCalls).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "选择其他位置" }));
    await waitFor(() => expect(screen.getByText(/选择当前位置：\/home\/test-user\/notes-choice/)).toBeTruthy());
    expect(browseCalls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "选择此目录" }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([, opts]) => opts?.method === "POST" && JSON.parse(opts.body).action === "custom" && JSON.parse(opts.body).path === listing.path)).toBe(true));
  });

  it("Workspace setup browse 使用真实 DirectoryEntry → 可导航子目录并隐藏 hidden 行", async () => {
    const rootListing = {
      path: "/home/test-user",
      home: "/home/test-user",
      crumbs: [{ name: "Home", path: "/home/test-user", hidden: false }],
      entries: [
        { name: "visible", path: "/home/test-user/visible", hidden: false },
        { name: ".hidden", path: "/home/test-user/.hidden", hidden: true },
      ],
      truncated: false,
    };
    const childListing = { ...rootListing, path: "/home/test-user/visible", entries: [], crumbs: [...rootListing.crumbs, { name: "visible", path: "/home/test-user/visible", hidden: false }] };
    const uiWorkspace = {
      async listDirectory(path) {
        return path === "/home/test-user/visible" ? childListing : rootListing;
      },
      async pickDirectory() { throw new Error("native picker should not be used"); },
    };
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes", browseStartPath: "/workspace" })));
      if (String(url).includes("/setup/") && opts?.method === "POST") return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ uiWorkspace });
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "选择其他位置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "📁 visible" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "📁 .hidden" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "📁 visible" }));
    await waitFor(() => expect(screen.getByText(/选择当前位置：\/home\/test-user\/visible/)).toBeTruthy());
  });

  it("Workspace setup browse 请求被组件卸载取消 → abort，不触发 native fallback", async () => {
    let pending;
    let signal;
    let nativeCalls = 0;
    const uiWorkspace = {
      listDirectory(_path, receivedSignal) {
        signal = receivedSignal;
        pending = makeDeferred();
        return pending.promise;
      },
      async pickDirectory() { nativeCalls++; return "/native"; },
    };
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes", browseStartPath: "/workspace" })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ uiWorkspace });
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "选择其他位置" }));
    await waitFor(() => expect(signal).toBeTruthy());
    fireEvent.click(screen.getByTitle("关闭（Esc）"));
    await waitFor(() => expect(signal.aborted).toBe(true));
    expect(nativeCalls).toBe(0);
    pending.resolve({ path: "/home/test-user", home: "/home/test-user", crumbs: [], entries: [], truncated: false });
  });

  it("Workspace setup browse 导航被新请求取代 → 旧 listing abort，当前请求继续", async () => {
    const rootListing = { path: "/home/test-user", home: "/home/test-user", crumbs: [{ name: "Home", path: "/home/test-user", hidden: false }], entries: [{ name: "visible", path: "/home/test-user/visible", hidden: false }], truncated: false };
    const child = makeDeferred();
    const home = makeDeferred();
    const signals = [];
    const uiWorkspace = {
      listDirectory(path, receivedSignal) {
        signals.push(receivedSignal);
        if (path === "/workspace") return Promise.resolve(rootListing);
        if (path === "/home/test-user/visible") return child.promise;
        return home.promise;
      },
      async pickDirectory() { throw new Error("native picker should not be used"); },
    };
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes", browseStartPath: "/workspace" })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ uiWorkspace });
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "选择其他位置" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "📁 visible" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "📁 visible" }));
    await waitFor(() => expect(signals.length).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "根目录" }));
    await waitFor(() => expect(signals.length).toBe(3));
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(false);
    home.resolve(rootListing);
    child.reject(new Error("stale browse failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("stale browse failure")).toBeNull();
  });

  it("Workspace setup browse 创建子目录 → createDirectory 后刷新当前 listing", async () => {
    const rootListing = {
      path: "/home/test-user",
      home: "/home/test-user",
      crumbs: [{ name: "Home", path: "/home/test-user", hidden: false }],
      entries: [{ name: "visible", path: "/home/test-user/visible", hidden: false }],
      truncated: false,
    };
    const refreshedListing = {
      ...rootListing,
      entries: [
        ...rootListing.entries,
        { name: "created", path: "/home/test-user/created", hidden: false },
      ],
    };
    let listCalls = 0;
    const createCalls = [];
    const uiWorkspace = {
      async listDirectory() {
        listCalls += 1;
        return listCalls === 1 ? rootListing : refreshedListing;
      },
      async createDirectory(path, name) {
        createCalls.push({ path, name });
        return "/home/test-user/created";
      },
      async pickDirectory() { throw new Error("native picker should not be used"); },
    };
    vi.stubGlobal("prompt", vi.fn(() => "created"));
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes", browseStartPath: "/workspace" })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel({ uiWorkspace });
    await openPanel();
    fireEvent.click(screen.getByRole("button", { name: "选择其他位置" }));
    await waitFor(() => expect(screen.getByText(/选择当前位置：\/home\/test-user/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /新建子目录|New folder/ }));
    await waitFor(() => expect(createCalls).toEqual([{ path: "/home/test-user", name: "created" }]));
    await waitFor(() => expect(screen.getByRole("button", { name: "📁 created" })).toBeTruthy());
    expect(listCalls).toBe(2);
  });

  it("Workspace setup 检测到 legacy Notes → 只显示显式采用，不暴露自定义位置", async () => {
    const fetchFn = vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: true })));
      if (String(url).includes("/setup/") && opts?.method === "POST") return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText("检测到这个工作区已有协作便签。是否继续使用现有位置？")).toBeTruthy());
    expect(screen.getByRole("button", { name: "继续使用现有位置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "选择其他位置" })).toBeNull();
  });

  it("Workspace legacy setup 关闭面板 → 不隐式采用、不提交 setup", async () => {
    const fetchFn = vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: true })));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByRole("button", { name: "继续使用现有位置" })).toBeTruthy());
    fireEvent.click(screen.getByTitle("关闭（Esc）"));
    expect(fetchFn.mock.calls.some(([, opts]) => opts?.method === "POST")).toBe(false);
  });

  it("Workspace setup 首次保存 → setup 成功后自动继续原 composer 写入", async () => {
    const fetchFn = vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false, proposedPath: "/workspace/notes", browseStartPath: "/workspace" })));
      if (String(url).includes("/setup/") && opts?.method === "POST") return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "INITIALIZED", legacy: false })));
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { status: 428, mtime: "0" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    type("首次保存草稿");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    fireEvent.click(screen.getByRole("button", { name: "确认使用默认位置" }));
    await waitFor(() => expect(fetchFn.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(true));
    expect(fetchFn.mock.calls.filter(([, opts]) => opts?.method === "PUT").at(-1)[1].body).toContain("首次保存草稿");
  });

  it("Workspace setup 失败 → 首次保存草稿保留且不发 PUT", async () => {
    const fetchFn = vi.fn((url, opts) => {
      if (String(url).includes("/setup/") && !opts?.method) return Promise.resolve(makeResponse(JSON.stringify({ ok: true, state: "UNINITIALIZED", legacy: false })));
      if (String(url).includes("/setup/") && opts?.method === "POST") return Promise.resolve(makeResponse(JSON.stringify({ ok: false, code: "NOTES_LOCATION_UNUSABLE", reason: "不可写" }), { status: 409 }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    type("失败时仍保留");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
  fireEvent.click(screen.getByRole("button", { name: "确认使用默认位置" }));
    await waitFor(() => expect(screen.getByText("不可写")).toBeTruthy());
    expect(fetchFn.mock.calls.some(([, opts]) => opts?.method === "PUT")).toBe(false);
    expect(screen.getByRole("textbox").value).toBe("失败时仍保留");
  });

  it("保存中关闭 → 卸载后 PUT 返回不崩溃、不残留状态", async () => {
    const put = makeDeferred();
    vi.stubGlobal("fetch", vi.fn((_url, opts) => {
      if (opts?.method === "PUT") return put.promise;
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("draft");
    fireEvent.click(screen.getByRole("button", { name: "保存" })); // PUT 挂起
    fireEvent.click(screen.getByTitle("关闭（Esc）")); // dirty → confirm=true → 关闭
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    put.resolve(makeResponse("ok", { mtime: "2222" })); // 卸载后返回——不应抛错
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("fork/carry eligibility decision：fork child 显示 carry-over 横幅；选择 none 后横幅消失", async () => {
    let carryoverCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        carryoverCalls++;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "none", carriedLanes: null, skipped: [] }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/这个分支来自另一对话/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "不带" }));
    await waitFor(() => expect(carryoverCalls).toBe(1));
    await waitFor(() => expect(screen.queryByText(/这个分支来自另一对话/)).toBeNull());
  });

  it("fork/carry eligibility decision：无冲突「全部」继承成功 → 顶部结果 banner 按 lane 展示已继承父分支", async () => {
    const getCalls = [];
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        // no conflicts: direct carried with per-lane copied results
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "carried",
          results: [
            { lane: "conversation_todo", outcome: "copied" },
            { lane: "deferred_work", outcome: "copied" },
          ],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      getCalls.push(u);
      return Promise.resolve(makeResponse("inherited content", { mtime: "7777" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层 editor 刷新断言需在原文编辑（高级）区
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(screen.getByText("继承完成")).toBeTruthy());
    expect(screen.getByText(/L1 会话待办：已继承父分支/)).toBeTruthy();
    expect(screen.getByText(/L2 延后工作：已继承父分支/)).toBeTruthy();
    // current lane editor refreshed with inherited content (no stale empty text)
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("inherited content"));
  });

  it("fork/carry eligibility decision：dirty lane 发起「全部」→ 先确认 → 先 Save 成功 → 再走 carry-over", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    let putCount = 0;
    let carryoverCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        carryoverCalls++;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "carried",
          results: [{ lane: "conversation_todo", outcome: "copied" }],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") {
        putCount++;
        return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    // make the current lane dirty
    type("draft text before inherit");
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    // gate: confirm shown with the dirty message
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(String(confirmMock.mock.calls[0][0])).toContain("有未保存内容");
    // confirm=true → Save first, then carry-over
    await waitFor(() => expect(putCount).toBe(1));
    await waitFor(() => expect(carryoverCalls).toBe(1));
    // editor refreshed + dirty cleared + result banner
    await waitFor(() => expect(screen.getByText("继承完成")).toBeTruthy());
  });

  it("fork/carry eligibility decision：dirty lane 发起「全部」→ 取消 → carry-over 不发起、草稿保留", async () => {
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmMock);
    let putCount = 0;
    let carryoverCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        carryoverCalls++;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "carried", results: [] }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") {
        putCount++;
        return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("draft text before inherit");
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // cancel → no save, no carry-over, banner still shown, draft kept
    await new Promise((r) => setTimeout(r, 30));
    expect(putCount).toBe(0);
    expect(carryoverCalls).toBe(0);
    expect(screen.getByRole("textbox").value).toBe("draft text before inherit");
    expect(screen.getByText(/这个分支来自另一对话/)).toBeTruthy();
  });

  it("fork/carry eligibility decision：dirty lane「全部」→ 确认后 Save 409 → carry-over 暂停、走现有保存冲突", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    let putCount = 0;
    let carryoverCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        carryoverCalls++;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "carried", results: [] }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") {
        putCount++;
        // save hits a real 409: someone else (e.g. carry-over already wrote the
        // file earlier, or another writer) changed it
        return Promise.resolve({
          ok: false,
          status: 409,
          text: async () => "latest server content",
          headers: { get: (n) => (String(n).toLowerCase() === "x-notes-mtime" ? "3333" : null) },
        });
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("draft text");
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    // confirm → Save attempted → 409 → carry-over stays PAUSED
    await waitFor(() => expect(putCount).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(carryoverCalls).toBe(0);
    // existing 409 conflict triage surfaced
    await waitFor(() => expect(screen.getByText(/文件已被其它方修改/)).toBeTruthy());
    expect(screen.getByRole("textbox").value).toBe("draft text"); // local draft kept
  });

  it("fork/carry eligibility decision：「选择部分」不含当前 dirty lane → 不弹确认、直接 carry-over", async () => {
    const confirmMock = vi.fn(() => false); // would abort if wrongly called
    vi.stubGlobal("confirm", confirmMock);
    let carryoverCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        carryoverCalls++;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "carried", results: [] }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    type("draft on L1"); // current lane = L1 (conversation_todo), dirty
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "选择部分" }));
    // pick ONLY L2 (deferred_work) — not the dirty L1
    await waitFor(() => expect(screen.queryAllByRole("checkbox").length).toBe(4), { timeout: 1000 });
    const l2Checkbox = screen.getByRole("checkbox", { name: "L2 延后工作" });
    fireEvent.click(l2Checkbox); // uncheck default-selected lanes, leaving L2
    const l1Checkbox = screen.getByRole("checkbox", { name: "L1 会话待办" });
    if (l1Checkbox.checked) fireEvent.click(l1Checkbox);
    fireEvent.click(screen.getByRole("button", { name: "确认继承所选" }));
    // no confirm prompt; carry-over fires directly
    await waitFor(() => expect(carryoverCalls).toBe(1));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("fork/carry eligibility decision：dirty lane 点「不带」→ 不被门控（none 不继承任何 lane，草稿无关）", async () => {
    const confirmMock = vi.fn(() => false); // would abort if wrongly called
    vi.stubGlobal("confirm", confirmMock);
    let carryoverCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        carryoverCalls++;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "none", carriedLanes: null, skipped: [] }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层编辑需在原文编辑（高级）区
    // dirty the current lane
    type("draft on L1");
    // open the picker first so carrySelected is non-empty residue (the bug
    // scenario: carrySelected contains the dirty lane)
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "选择部分" }));
    await waitFor(() => expect(screen.queryAllByRole("checkbox").length).toBe(4));
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    // now click 不带 while dirty + carrySelected residue exists
    fireEvent.click(screen.getByRole("button", { name: "不带" }));
    // none must NOT be gated: no confirm, carry-over fires directly
    await waitFor(() => expect(carryoverCalls).toBe(1));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox").value).toBe("draft on L1"); // draft preserved
  });

  it("fork/carry eligibility decision：无 fork 关系时无横幅", async () => {
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: false, status: "none" }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/这个分支来自另一对话/)).toBeNull();
    expect(screen.queryByTitle(/未决的便签继承/)).toBeNull();
  });

  it("fork/carry eligibility decision：occupied lane → preflight 返回 conflict → 冲突 UI（每 lane merge/keep/replace）→ 确认走 fork-apply（带 observations）", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      calls.push({ u, opts });
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        // preflight-first: occupied L1 surfaced as conflict, nothing mutated
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [{ lane: "conversation_todo", childContent: "child own content", parentContent: "parent content" }],
          observations: {
            conversation_todo: { parent: { kind: "present-nonempty", version: "P1" }, child: { kind: "present-nonempty", version: "C3333" } },
            deferred_work: { parent: { kind: "present-nonempty", version: "P2" }, child: { kind: "absent", version: null } },
          },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "carried",
          results: [{ lane: "conversation_todo", outcome: "merged" }],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/这个分支来自另一对话/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(screen.getByText(/以下便签两侧都有内容/)).toBeTruthy());
    // conflict UI shows both sides + per-lane radios (merge preselected)
    expect(screen.getByText("父分支内容")).toBeTruthy();
    expect(screen.getByText("当前分支已有内容")).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBe(3); // merge / keep / replace
    expect(radios[0].checked).toBe(true); // merge default
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    await waitFor(() => {
      const applyCall = calls.find((c) => c.u.includes("/fork-apply"));
      expect(applyCall).toBeTruthy();
      const body = JSON.parse(applyCall.opts.body);
      expect(body.resolutions.conversation_todo).toBe("merge");
      expect(body.observations.conversation_todo.child.version).toBe("C3333");
      expect(body.observations.deferred_work.child.kind).toBe("absent");
      expect(body.choice).toBe("all");
    });
    await waitFor(() => expect(screen.queryByText(/以下便签两侧都有内容/)).toBeNull());
  });

  it("fork/carry eligibility decision：apply 成功 → 顶部结果 banner 按 lane 展示（合并/继承）+ 当前 lane 内容实时刷新", async () => {
    let applyBody = null;
    const getCalls = [];
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [
            { lane: "conversation_todo", childContent: "child own content", parentContent: "parent content" },
            { lane: "deferred_work", childContent: "child d", parentContent: "parent d" },
          ],
          observations: {
            conversation_todo: { parent: { kind: "present-nonempty", version: "P1" }, child: { kind: "present-nonempty", version: "C3333" } },
            deferred_work: { parent: { kind: "present-nonempty", version: "P2" }, child: { kind: "present-nonempty", version: "C4444" } },
          },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        applyBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "carried",
          results: [
            { lane: "conversation_todo", outcome: "merged" },
            { lane: "deferred_work", outcome: "copied" },
          ],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      // GET: first loads return empty; post-apply refresh returns merged content
      getCalls.push(u);
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => screen.getByText(/以下便签两侧都有内容/));
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    // result banner appears at top with per-lane lines
    await waitFor(() => expect(screen.getByText("继承完成")).toBeTruthy());
    expect(screen.getByText(/L1 会话待办：已合并父分支 \+ 当前分支/)).toBeTruthy();
    expect(screen.getByText(/L2 延后工作：已继承父分支/)).toBeTruthy();
    // banner survives lane switch (no auto-dismiss)
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    await waitFor(() => expect(screen.getByText("继承完成")).toBeTruthy());
  });

  it("fork/carry eligibility decision：apply 成功后当前 lane 内容刷新为合并结果（不再显示旧内容）", async () => {
    const getCalls = [];
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [{ lane: "conversation_todo", childContent: "old child", parentContent: "parent content" }],
          observations: { conversation_todo: { parent: { kind: "present-nonempty", version: "P1" }, child: { kind: "present-nonempty", version: "C3333" } } },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "carried",
          results: [{ lane: "conversation_todo", outcome: "merged" }],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      getCalls.push(u);
      // post-apply refresh returns the MERGED content; earlier loads return old
      return Promise.resolve(makeResponse("## 来自父分支\n\nparent content\n\n---\n\n## 当前分支已有内容\n\nold child", { mtime: "9999" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层 editor 内容断言需在原文编辑（高级）区
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => screen.getByText(/以下便签两侧都有内容/));
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    // current lane editor must show merged content (not old child)
    await waitFor(() => expect(screen.getByRole("textbox").value).toContain("## 来自父分支"));
    expect(screen.getByRole("textbox").value).toContain("old child");
    // a refresh GET happened after apply (count > 1)
    expect(getCalls.length).toBeGreaterThan(1);
  });

  it("fork/carry eligibility decision：结果 banner 由「知道了」关闭（不会自动消失）", async () => {
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [{ lane: "conversation_todo", childContent: "child own content", parentContent: "parent content" }],
          observations: { conversation_todo: { parent: { kind: "present-nonempty", version: "P1" }, child: { kind: "present-nonempty", version: "C3333" } } },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "carried",
          results: [{ lane: "conversation_todo", outcome: "merged" }],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => screen.getByText(/以下便签两侧都有内容/));
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    await waitFor(() => expect(screen.getByText("继承完成")).toBeTruthy());
    // banner does not auto-dismiss after a short wait
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText("继承完成")).toBeTruthy();
    // 知道了 closes it
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(screen.queryByText("继承完成")).toBeNull());
  });

  it("fork/carry eligibility decision race：post-apply 刷新 GET 未返回前切 lane → 旧 lane response 不得覆盖当前 lane 编辑器", async () => {
    // Scenario: L2 (deferred_work) is the active lane → carry/apply merges L2 →
    // post-apply refresh GET for L2 is held (deferred) → user switches to L3
    // (knowledge_candidate) before the GET lands → then L2's GET resolves.
    // Assert: L3 stays active, its editor text is NOT overwritten by the L2
    // response, the result banner is still shown, and switching back to L2
    // loads the authoritative merged content via the normal lane load.
    const l2RefreshGet = makeDeferred(); // post-apply refresh GET for L2 (held)
    let l2Gets = 0;
    const getUrls = [];
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [{ lane: "deferred_work", childContent: "old L2", parentContent: "parent L2" }],
          observations: { deferred_work: { parent: { kind: "present-nonempty", version: "P2" }, child: { kind: "present-nonempty", version: "C2" } } },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "carried",
          results: [{ lane: "deferred_work", outcome: "merged" }],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      // GET: the FIRST /deferred_work/ GET is the initial L2 load (immediate);
      // the SECOND is the post-apply refresh — hold it until the test switches lanes.
      getUrls.push(u);
      if (u.includes("/deferred_work") && !u.includes("/fork-")) {
        l2Gets++;
        if (l2Gets === 2) return l2RefreshGet.promise; // post-apply refresh — held
        if (l2Gets === 1) return Promise.resolve(makeResponse("", { mtime: "1111" })); // initial L2 load
        return Promise.resolve(makeResponse("authoritative L2 after carry", { mtime: "9999" })); // later switch-back load
      }
      // normal lane loads (L3 switch) resolve immediately
      return Promise.resolve(makeResponse("L3 content", { mtime: "9999" }));
    }));
    mountPanel();
    await openPanel();
    await openRawView(); // Notes behavior regression: 整层 editor（placeholder/value 断言）需在原文编辑（高级）区
    // start on L2: switch there first and WAIT until it is genuinely active
    // (the carry-over buttons read the current layerKey state, so the switch
    // must be flushed before 全部 is clicked).
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    await waitFor(() => expect(screen.getByRole("textbox").getAttribute("placeholder")).toContain("L2"));
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => screen.getByText(/以下便签两侧都有内容/));
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    // post-apply refresh GET for L2 is now in flight (held); result banner shown
    await waitFor(() => expect(screen.getByText("继承完成")).toBeTruthy());
    await waitFor(() => expect(l2Gets).toBe(2));
    // switch to L3 while the L2 refresh is still pending
    fireEvent.click(screen.getByRole("button", { name: "L3 知识候选" }));
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("L3 content"));
    // now let the stale L2 refresh response land
    l2RefreshGet.resolve(makeResponse("stale L2 merged payload", { mtime: "8888" }));
    await new Promise((r) => setTimeout(r, 30));
    // L3 must still be active and its editor text untouched by the L2 response
    expect(screen.getByRole("textbox").value).toBe("L3 content");
    // result banner still shown (carry outcome not dropped by discarding refresh)
    expect(screen.getByText("继承完成")).toBeTruthy();
    // switching back to L2 loads the authoritative carry result via normal load
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe("authoritative L2 after carry"));
  });

  it("fork/carry eligibility decision：冲突 UI 选 keep → fork-apply resolutions=keep", async () => {
    let applyBody = null;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [{ lane: "deferred_work", childContent: "child d", parentContent: "parent d" }],
          observations: { deferred_work: { parent: { kind: "present-nonempty", version: "P4" }, child: { kind: "present-nonempty", version: "C4444" } } },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        applyBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "carried", results: [{ lane: "deferred_work", outcome: "kept" }] }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => screen.getByText(/以下便签两侧都有内容/));
    fireEvent.click(screen.getByRole("radio", { name: /保留当前/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    await waitFor(() => expect(applyBody?.resolutions?.deferred_work).toBe("keep"));
  });

  it("fork/carry eligibility decision：冲突 UI 选 replace → fork-apply resolutions=replace", async () => {
    let applyBody = null;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [{ lane: "deferred_work", childContent: "child d", parentContent: "parent d" }],
          observations: { deferred_work: { parent: { kind: "present-nonempty", version: "P5" }, child: { kind: "present-nonempty", version: "C5555" } } },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        applyBody = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "carried", results: [{ lane: "deferred_work", outcome: "replaced" }] }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => screen.getByText(/以下便签两侧都有内容/));
    fireEvent.click(screen.getByRole("radio", { name: /以父分支覆盖当前/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    await waitFor(() => expect(applyBody?.resolutions?.deferred_work).toBe("replace"));
  });

  it("fork/carry eligibility decision：fork-apply 返回 stale → 重新 preflight 拿到新 observations 并再次 surface（不静默丢弃）", async () => {
    let carryoverCount = 0;
    vi.stubGlobal("fetch", vi.fn((url, opts) => {
      const u = String(url);
      if (u.includes("/fork-status")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ isForkChild: true, status: "unresolved", parentSessionId: "session-parent-000000000000", carriedLanes: null }), headers: { get: () => null } });
      }
      if (u.includes("/fork-carryover")) {
        carryoverCount++;
        const fresh = carryoverCount >= 2;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "conflict",
          conflicts: [{ lane: "lesson_candidate", childContent: fresh ? "child new" : "child old", parentContent: "parent content" }],
          observations: { lesson_candidate: { parent: { kind: "present-nonempty", version: "P6" }, child: { kind: "present-nonempty", version: fresh ? "C6666" : "C5555" } } },
        }), headers: { get: () => null } });
      }
      if (u.includes("/fork-apply")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          status: "stale",
          results: [{ lane: "lesson_candidate", outcome: "stale" }, { lane: "conversation_todo", outcome: "deferred" }],
        }), headers: { get: () => null } });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => screen.getByText(/这个分支来自另一对话/));
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => screen.getByText(/以下便签两侧都有内容/));
    fireEvent.click(screen.getByRole("button", { name: "确认合并方式" }));
    // stale → second preflight (new observations), conflict UI re-surfaced
    await waitFor(() => expect(carryoverCount).toBe(2));
    await waitFor(() => expect(screen.getByText(/部分内容已变化，请重新确认/)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/以下便签两侧都有内容/)).toBeTruthy());
    const radios = screen.getAllByRole("radio");
    expect(radios[0].checked).toBe(true); // fresh merge default
  });

  it("Notes behavior regression: session 切换后正常加载新会话（capture 清除不破坏渲染）", async () => {
    // 验证：宿主切换 sessionId（session A → session B）后，面板重新加载 B 的
    // Notes；Notes behavior regression 的 capture 状态清除逻辑不破坏渲染，保存仍指向新 session。
    const SESSION_A = SESSION;
    const SESSION_B = "session-test-0002-0002";
    const urls = [];
    const fetchFn = vi.fn((u, opts) => {
      urls.push(String(u));
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const { apply } = loader.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
    let registered = null;
    const ctx = {
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION_A }));
    // 打开面板（📝）
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByRole("textbox"));
    // 切到 session B：宿主以新 sessionId 重挂载组件
    view.rerender(React.createElement(Component, { sessionId: SESSION_B }));
    await waitFor(() => expect(urls.some((u) => u.includes(SESSION_B))).toBe(true));
    // Notes behavior regression note-primary：捕获入口为 composer 上方文字按钮「引用选中到便签」（原 header
    // 🎯），切换会话后仍可用（capture 集成面保留）
    expect(screen.getByRole("button", { name: "引用选中到便签" })).toBeTruthy();
    cleanup();
  });

  it("Notes behavior regression: A 会话 capture proposal → 切到 B → proposal 被清除且不能 Save 到 B", async () => {
    const SESSION_A = SESSION;
    const SESSION_B = "session-test-0002-0002";
    // mock fetch：session.history（A 会话 events 含 source）+ anchored/validate（ok）
    // + anchored/prepare + notes GET/PUT（全 mock，走真实 URL 匹配）
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/api/session.history")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ type: "server-response", result: { ok: true, value: { events: [
            { event: { seq: 7, type: "user/message", data: { id: "cap-a-1111", content: [{ type: "text", text: "SOURCE-A" }], source: { kind: "user" } } } },
            { event: { seq: 17, type: "assistant/message", data: { message: { content: [{ type: "text", text: "ASSISTANT-B" }] } } } },
          ] } } }),
        });
      }
      if (url.includes("/notes-api/anchored/validate")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, validated: { sessionId: SESSION_A, projectionVersion: 2, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [], sourcePayload: { projectionVersion: 2, sessionId: SESSION_A, segments: [{ eventSeq: 7, start: 0, end: 8 }] } } }) });
      }
      if (url.includes("/notes-api/anchored/prepare")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, block: "--- dsh-note v1 begin\ndsh-meta kind: source-aware\ndsh-meta origin: session-test-0001-0001\ndsh-meta snapshot-length: 8\n--- dsh-body\nSOURCE-A\n--- dsh-note v1 end", validated: {} }) });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    // mock browser selection：注入真实 data-chat-anchor-key 容器（Range 在打开面板
    // 之后再挂到 getSelection——Notes behavior regression auto-attach 会在“打开面板时存在选区”的情况下
    // 自动出 proposal，需避免与显式点击双捕获）
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="13:input-messagecap-a-1111">SOURCE-A</div>';
    document.body.appendChild(host);
    const anchorEl = host.querySelector("[data-chat-anchor-key]");
    const range = document.createRange();
    range.setStart(anchorEl.firstChild, 0);
    range.setEnd(anchorEl.firstChild, 8);
    const stubSelectionOn = () => vi.stubGlobal("getSelection", vi.fn(() => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range })));
    const stubSelectionOff = () => vi.stubGlobal("getSelection", vi.fn(() => ({ rangeCount: 0, isCollapsed: true })));
    // 渲染 A 会话组件并打开面板
    const { apply } = loader.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
    let registered = null;
    const ctx = {
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION_A }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByRole("textbox"));
    // 打开面板后再给选区（避免 auto-attach 抢先），再点「引用选中到便签」
    stubSelectionOn();
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    // behavior regression/Notes behavior regression r3 单一创建流：proposal 展示为 composer 的「引用的原文」区块（旧
    // disclosure“拟保存的 source 捕获 / 保存捕获”已收口，不再作为独立 UI）
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    // behavior regression：草稿 composer 不显示静态 re-entry 声明（6.1/6.2），也无 回来源 按钮
    expect(screen.queryByText(/已附加来源/)).toBeNull();
    expect(screen.queryByText(/可回到原处/)).toBeNull();
    expect(screen.queryByRole("button", { name: /回来源/ })).toBeNull();
    expect(screen.getByRole("button", { name: "保存便签" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存捕获" })).toBeNull();
    // 切到 session B：先摘掉选区——否则 auto-attach（切会话后对新 session 自动尝试）
    // 会用残留选区向 B 发起捕获
    stubSelectionOff();
    view.rerender(React.createElement(Component, { sessionId: SESSION_B }));
    // capture proposal 应被清除（session 切换 useEffect）→ composer 不再有
    // 「引用的原文」区块、正文草稿为空（原安全语义：A 的 proposal 不能 Save 到 B）
    await waitFor(() => expect(screen.queryByText("引用的原文")).toBeNull(), { timeout: 3000 });
    expect(screen.getByRole("textbox").value).toBe("");
    // B 上的保存只能是普通便签（capture 已清除；若残留则 anchored PUT 会被宿主拒绝）
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "B 的便签" } });
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => {
      const put = fetchFn.mock.calls.find(([, o]) => o?.method === "PUT");
      expect(put).toBeTruthy();
      expect(String(put[1].body)).not.toContain("dsh-meta kind: source-aware");
    });
    host.remove();
    cleanup();
  });

  it("Notes behavior regression: L1 capture proposal → 切到 L2 tab → proposal 被清除且不能 Save 到 L2（lane-drift 修复）", async () => {
    // lane-drift 回归（test final focused recheck）：capture 的持久化目标是 Save
    // 时的 lane——切换 lane 必须清除 capture，否则 L1 验证的 proposal 可能被 Save
    // 到 L2（display A → persist 到另一 lane）。
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/api/session.history")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ type: "server-response", result: { ok: true, value: { events: [
            { event: { seq: 7, type: "user/message", data: { id: "cap-lane-2222", content: [{ type: "text", text: "SOURCE-A" }], source: { kind: "user" } } } },
          ] } } }),
        });
      }
      if (url.includes("/notes-api/anchored/validate")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, validated: { sessionId: SESSION, projectionVersion: 2, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [], sourcePayload: { projectionVersion: 2, sessionId: SESSION, segments: [{ eventSeq: 7, start: 0, end: 8 }] } } }) });
      }
      if (opts?.method === "PUT") {
        // 断言：切换 lane 后绝无捕获内容 PUT（本测试不应触发任何含 source-aware 的 PUT）
        const body = String(opts.body || "");
        if (body.includes("dsh-meta kind: source-aware")) throw new Error("capture block PUT after lane switch — lane-drift bug");
        return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="13:input-messagecap-lane-2222">SOURCE-A</div>';
    document.body.appendChild(host);
    const anchorEl = host.querySelector("[data-chat-anchor-key]");
    const range = document.createRange();
    range.setStart(anchorEl.firstChild, 0);
    range.setEnd(anchorEl.firstChild, 8);
    // Notes behavior regression auto-attach：打开面板时就存在选区会自动出 proposal——先把选区 stub 放到
    // 打开面板之后，再点「引用选中到便签」，保持“点击触发”的断言语义
    const stubSelectionOn = () => vi.stubGlobal("getSelection", vi.fn(() => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range })));
    const { apply } = loader.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
    let registered = null;
    const ctx = {
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByRole("textbox"));
    stubSelectionOn();
    // 默认 L1（会话待办）→ 触发 capture → composer「引用的原文」区块展示
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByRole("button", { name: "保存便签" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存捕获" })).toBeNull();
    // 切到 L2 tab（待讨论）
    fireEvent.click(screen.getByRole("button", { name: /L2 延后工作/ }));
    // lane 切换必须清除 capture → composer 不再有「引用的原文」区块、草稿为空
    await waitFor(() => expect(screen.queryByText("引用的原文")).toBeNull(), { timeout: 3000 });
    // L2 上保存只能是普通便签（fetch mock 遇 anchored PUT 直接 throw——若有残留
    // proposal 被 Save 到 L2，本测试立即失败：lane-drift 回归）
    await waitFor(() => expect(screen.getByText(/notes\/deferred_work\//)).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "L2 便签" } });
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => {
      const put = fetchFn.mock.calls.find(([, o]) => o?.method === "PUT");
      expect(put).toBeTruthy();
      expect(String(put[1].body)).not.toContain("dsh-meta kind: source-aware");
    });
    // 切回 L1：capture 不复活（需重新引用）、composer 草稿空
    fireEvent.click(screen.getByRole("button", { name: /L1 会话待办/ }));
    expect(screen.queryByText("引用的原文")).toBeNull();
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe(""));
    host.remove();
    cleanup();
  });

  it("Notes behavior regression: source-aware item → ↪ 回来源（same-session exact；无 cue 时不冒充成功）", async () => {
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 8",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":[{"eventSeq":7,"start":0,"end":8}]}`,
      "--- dsh-body",
      "SOURCE-A",
      "--- dsh-note v1 end",
    ].join("\n");
    let reentryBody = null;
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        const parsed = JSON.parse(opts.body);
        reentryBody = parsed;
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true, status: "exact", sameSession: true, contextWindow: 2,
            exact: {
              sessionId: parsed.locator.sessionId, projectionVersion: 1,
              segments: parsed.locator.segments, text: "SOURCE-A",
              perSegment: [{ eventSeq: 7, start: 0, end: 8, text: "SOURCE-A", hint: { eventSeq: 7, messageId: "m-7" } }],
            },
            context: { perEvent: [] },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
        const { apply } = loader.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
    let registered = null;
    const ctx = {
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    // Notes behavior regression: 旧底部“已保存 anchored 条目”区已并入 Note-primary 列表（标题改为“已保存便签”）
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    expect(screen.getByRole("button", { name: "↪ 回来源" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getAllByText(/没有可用 attention cue；未声称已回到来源/).length).toBeGreaterThan(0), { timeout: 3000 });
    // 请求形态：same-session 也携带 per-request consent；locator = persisted sourcePayload
    expect(reentryBody).toBeTruthy();
    expect(reentryBody.currentSessionId).toBe(SESSION);
    expect(reentryBody.locator.sessionId).toBe(SESSION);
    // consent 恒 per-request：host 无 request→session 可信 seam，每次 dereference
    // 都是显式 per-request 用户动作（伪造 currentSessionId 不能豁免——route 已测）
    expect(reentryBody.consent).toBe("per-request");
    // L：re-entry 不触发任何 PUT（无写）
    const puts = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/notes-api/") && c[1]?.method === "PUT");
    expect(puts.length).toBe(0);
    view.unmount();
    cleanup();
  });

  it("Notes behavior regression Row 11: message 可定位但 exact Range 失败 → broader whole-message cue（非 exact）", async () => {
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 8",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":[{"eventSeq":7,"start":0,"end":8}]}`,
      "--- dsh-body",
      "SOURCE-A",
      "--- dsh-note v1 end",
    ].join("\n");
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messagem-whole">SOURCE-A</div>';
    document.body.appendChild(host);
    const anchor = host.querySelector("[data-chat-anchor-key]");
    const originalOutline = anchor.style.outline;
    const originalOutlineOffset = anchor.style.outlineOffset;
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 60;
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true, status: "exact", sameSession: true, contextWindow: 2,
            exact: {
              sessionId: SESSION, projectionVersion: 1,
              segments: [{ eventSeq: 7, start: 0, end: 8 }], text: "SOURCE-A",
              // The source message is known, but this extent cannot become a
              // DOM Range; the client must use the row-11 broader cue.
              perSegment: [{ eventSeq: 7, start: 0, end: 99, text: "SOURCE-A", hint: { eventSeq: 7, messageId: "m-whole" } }],
              events: [{ eventSeq: 7, projection: "SOURCE-A" }],
            },
            context: { perEvent: [] },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_name, fn) => { registered = fn(); }, register: (cfg, Component) => ({ cfg, Component }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getAllByText(/broader whole-message cue（非 exact）/).length).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.queryByText(/没有可用 attention cue/)).toBeNull();
    expect(screen.queryByText(/已回到来源 ✓/)).toBeNull();
    expect(anchor.style.outline).not.toBe(originalOutline);
    expect(anchor.style.outlineOffset).toBe("2px");
    expect(anchor.querySelector("mark[data-dsh-reentry]")).toBeNull();
    expect(anchor.textContent).toBe("SOURCE-A");

    await waitFor(() => expect(anchor.style.outline).toBe(originalOutline), { timeout: 3000 });
    expect(anchor.style.outlineOffset).toBe(originalOutlineOffset);
    expect(anchor.textContent).toBe("SOURCE-A");
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    view.unmount();
    host.remove();
    cleanup();
  });

  it("Matrix 52 Row 9: historical S 与当前序列化投影不一致 → 仅显示 grounded broader cue", async () => {
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 8",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":[{"eventSeq":7,"start":0,"end":8}]}`,
      "--- dsh-body",
      "SOURCE-X",
      "--- dsh-note v1 end",
    ].join("\n");
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messagem-row9">SOURCE-Y</div>';
    document.body.appendChild(host);
    const anchor = host.querySelector("[data-chat-anchor-key]");
    const originalOutline = anchor.style.outline;
    const originalOutlineOffset = anchor.style.outlineOffset;
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 60;
    let reentryRequest = null;
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        reentryRequest = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: false,
            status: "incompatible",
            code: "HISTORICAL_S_MISMATCH",
            sameSession: true,
            historicalSnapshot: "SOURCE-X",
            currentSourceText: "SOURCE-Y",
            degradedCue: {
              kind: "whole-message",
              exact: false,
              sessionId: SESSION,
              projectionVersion: 1,
              perSegment: [{ eventSeq: 7, start: 0, end: 8, text: "SOURCE-Y", hint: { eventSeq: 7, messageId: "m-row9" } }],
              events: [{ eventSeq: 7, projection: "SOURCE-Y" }],
              sourceMessage: "SOURCE-Y",
            },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, Component) => ({ cfg, Component }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getByText(/历史 selected snapshot 与当前来源投影不一致；已显示 broader whole-message cue（非 exact）/)).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByText(/source: SOURCE-Y/)).toBeTruthy();
    expect(screen.queryByText(/已回到来源 ✓/)).toBeNull();
    expect(screen.queryByText(/exact locus 已定位并高亮/)).toBeNull();
    expect(reentryRequest?.consent).toBe("per-request");
    expect(reentryRequest?.locator?.sessionId).toBe(SESSION);
    expect(anchor.style.outline).not.toBe(originalOutline);
    expect(anchor.style.outline).toContain("#d97706");
    expect(anchor.style.outline).toContain("solid");
    expect(anchor.style.outline).toContain("2px");
    expect(anchor.style.outlineOffset).toBe("2px");
    expect(anchor.querySelector("mark[data-dsh-reentry]")).toBeNull();
    expect(anchor.textContent).toBe("SOURCE-Y");
    expect(fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT").length).toBe(0);

    await waitFor(() => expect(anchor.style.outline).toBe(originalOutline), { timeout: 3000 });
    expect(anchor.style.outlineOffset).toBe(originalOutlineOffset);
    expect(anchor.textContent).toBe("SOURCE-Y");
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    view.unmount();
    host.remove();
    cleanup();
  });

  it("Notes behavior regression: cross-session item → confirm 通过则 consent per-request（每请求）；拒绝则不读", async () => {
    const OTHER = "session-test-0002-0002";
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${OTHER}`,
      "dsh-meta snapshot-length: 7",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${OTHER}","segments":[{"eventSeq":5,"start":0,"end":7}]}`,
      "--- dsh-body",
      "OTHER-B",
      "--- dsh-note v1 end",
    ].join("\n");
    let reentryCalls = [];
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        const parsed = JSON.parse(opts.body);
        reentryCalls.push(parsed);
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, status: "exact", sameSession: false, contextWindow: 2, exact: { sessionId: parsed.locator.sessionId, projectionVersion: 1, segments: parsed.locator.segments, text: "OTHER-B", perSegment: [{ eventSeq: 5, start: 0, end: 7, text: "OTHER-B", hint: { eventSeq: 5, messageId: "m-5" } }] }, context: { perEvent: [] } }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    // 先拒绝：confirm false → 不调用 reentry
    vi.stubGlobal("confirm", vi.fn(() => false));
    vi.stubGlobal("fetch", fetchFn);
        const { apply } = loader.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
    let registered = null;
    const ctx = {
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    // Notes behavior regression: 旧底部“已保存 anchored 条目”区已并入 Note-primary 列表（标题改为“已保存便签”）
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(reentryCalls.length).toBe(0); // 拒绝 → 不读（J 客户端侧）
    // 再同意：consent per-request → exact
    vi.stubGlobal("confirm", vi.fn(() => true));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getByText(/跨会话 exact 已读取/)).toBeTruthy(), { timeout: 3000 });
    expect(reentryCalls.length).toBe(1);
    expect(reentryCalls[0].consent).toBe("per-request");
    expect(reentryCalls[0].currentSessionId).toBe(SESSION);
    expect(reentryCalls[0].locator.sessionId).toBe(OTHER);
    view.unmount();
    cleanup();
  });

  it("Notes behavior regression: unavailable / incompatible / unauthorized 响应 → truthful 展示（不误报 exact）", async () => {
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 8",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":[{"eventSeq":7,"start":0,"end":8}]}`,
      "--- dsh-body",
      "SOURCE-A",
      "--- dsh-note v1 end",
    ].join("\n");
    let mode = "unavailable";
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        const resp = mode === "unavailable"
          ? { ok: false, status: "unavailable", code: "REENTRY_EVENT_UNAVAILABLE", reason: "event gone" }
          : mode === "incompatible"
            ? { ok: false, status: "incompatible", code: "INCOMPATIBLE_PROJECTION", reason: "basis not interpretable" }
            : { ok: false, status: "unauthorized", code: "CROSS_SESSION_AUTHORIZATION_REQUIRED", reason: "nothing was read" };
        return Promise.resolve({ ok: true, status: 200, json: async () => resp });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("confirm", vi.fn(() => true));
        const { apply } = loader.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
    let registered = null;
    const ctx = {
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    // Notes behavior regression: 旧底部“已保存 anchored 条目”区已并入 Note-primary 列表（标题改为“已保存便签”）
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getByText(/来源当前不可用（快照保留，未 search\/rebind）/)).toBeTruthy(), { timeout: 3000 });
    mode = "incompatible";
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getAllByText(/兼容性失败（未用当前投影重解）/).length).toBeGreaterThan(0), { timeout: 3000 });
    mode = "unauthorized";
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getByText(/未授权读取（nothing read）/)).toBeTruthy(), { timeout: 3000 });
    // 不出现 exact 声称
    expect(screen.queryByText(/已回到来源 ✓/)).toBeNull();
    view.unmount();
    cleanup();
  });

  it("Notes behavior regression Row 9: Markdown 跨列表项 exact extent → 黄色背景高亮（不退化为整消息框）", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="51:assistant-step1:1"><div class="markdown"><ul>' +
      '<li>第一项用于测试列表边界。</li>' +
      '<li>服务层契约用于验证跨列表项的可见文本序列化。</li>' +
      '<li>第三项只是控制内容。</li>' +
      '</ul></div></div>';
    document.body.appendChild(host);
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 7",
      `dsh-meta source-payload: {"projectionVersion":2,"sessionId":"${SESSION}","segments":[{"eventSeq":51,"start":11,"end":18}]}`,
      "--- dsh-body",
      "。\n服务层契约",
      "--- dsh-note v1 end",
    ].join("\n");
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true, status: "exact", sameSession: true, contextWindow: 2,
            exact: {
              sessionId: SESSION, projectionVersion: 2,
              segments: [{ eventSeq: 51, start: 11, end: 18 }],
              text: "。\n服务层契约",
              perSegment: [{ eventSeq: 51, start: 11, end: 18, text: "。\n服务层契约", hint: { eventSeq: 51, turn: 1, step: 1 } }],
              events: [{ eventSeq: 51, projection: "第一项用于测试列表边界。\n服务层契约用于验证跨列表项的可见文本序列化。\n第三项只是控制内容。" }],
            },
            context: { perEvent: [] },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getByText(/已回到来源 ✓（exact locus 已定位并高亮）/)).toBeTruthy(), { timeout: 3000 });
    const anchor = host.querySelector("[data-chat-anchor-key]");
    const marks = anchor.querySelectorAll("mark[data-dsh-reentry]");
    expect(marks.length).toBe(2);
    expect([...marks].map((mark) => mark.textContent).join("")).toBe("。服务层契约");
    expect(anchor.style.outline || "").toBe("");
    expect(anchor.textContent).toContain("第一项用于测试列表边界。服务层契约用于验证");
    expect(fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT").length).toBe(0);
    view.unmount();
    host.remove();
    cleanup();
  });

  it("Notes behavior regression: 同一容器重复文本 → 高亮按 extent 位置（非 indexOf first-match）", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messageDUP-1">ABAB</div>';
    document.body.appendChild(host);
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 2",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":[{"eventSeq":7,"start":2,"end":4}]}`,
      "--- dsh-body",
      "AB",
      "--- dsh-note v1 end",
    ].join("\n");
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true, status: "exact", sameSession: true, contextWindow: 2,
            exact: {
              sessionId: SESSION, projectionVersion: 1, segments: [{ eventSeq: 7, start: 2, end: 4 }],
              text: "AB",
              perSegment: [{ eventSeq: 7, start: 2, end: 4, text: "AB", hint: { eventSeq: 7, messageId: "DUP-1" } }],
              events: [{ eventSeq: 7, projection: "ABAB" }],
            },
            context: { perEvent: [] },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    // Notes behavior regression: 旧底部“已保存 anchored 条目”区已并入 Note-primary 列表（标题改为“已保存便签”）
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getByText(/已回到来源 ✓（exact locus 已定位并高亮）/)).toBeTruthy(), { timeout: 3000 });
    // 确定性：<mark>AB</mark> 之前应剩 "AB"（高亮的是位置 2..4 的第二个 AB）
    const anchor = host.querySelector("[data-chat-anchor-key]");
    const mark = anchor.querySelector("mark");
    expect(mark).toBeTruthy();
    expect(mark.textContent).toBe("AB");
    expect(mark.previousSibling?.textContent).toBe("AB");
    // 回归（Notes behavior regression diagnostic 诊断）：容器不得有 message-wide outline/样式——用户可见
    // 高亮只能是 exact mark（mark 自身可有 1px 描边）
    expect(anchor.style.outline || "").toBe("");
    expect(anchor.style.outlineColor || "").toBe("");
    const inlineOutlined = [...anchor.querySelectorAll("*")].filter((n) => (n.style && n.style.outline && n.style.outline !== "none") || n.tagName === "MARK");
    expect(inlineOutlined.length).toBe(1); // 仅 mark 自身
    expect(inlineOutlined[0].tagName).toBe("MARK");
    // 单活动高亮（diagnostic）：再次 ↪ 回来源 → 旧 mark 被清、只留 1 个 mark
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(anchor.querySelectorAll("mark[data-dsh-reentry]").length).toBe(1), { timeout: 3000 });
    expect(anchor.querySelectorAll("mark").length).toBe(1);
    host.remove();
    view.unmount();
    cleanup();
  });

  it("Notes behavior regression: multi-segment 只映射到一段 → 报部分高亮（不报完整 exact 已高亮）", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messageM1">AAA</div>';
    document.body.appendChild(host);
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 5",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":[{"eventSeq":7,"start":0,"end":2},{"eventSeq":17,"start":0,"end":3}]}`,
      "--- dsh-body",
      "AABBB",
      "--- dsh-note v1 end",
    ].join("\n");
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true, status: "exact", sameSession: true, contextWindow: 2,
            exact: {
              sessionId: SESSION, projectionVersion: 1,
              segments: [{ eventSeq: 7, start: 0, end: 2 }, { eventSeq: 17, start: 0, end: 3 }],
              text: "AABBB",
              perSegment: [
                { eventSeq: 7, start: 0, end: 2, text: "AA", hint: { eventSeq: 7, messageId: "M1" } },
                { eventSeq: 17, start: 0, end: 3, text: "BBB", hint: { eventSeq: 17, messageId: "M2" } },
              ],
              events: [{ eventSeq: 7, projection: "AAA" }, { eventSeq: 17, projection: "BBB" }],
            },
            context: { perEvent: [] },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    // Notes behavior regression: 旧底部“已保存 anchored 条目”区已并入 Note-primary 列表（标题改为“已保存便签”）
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getAllByText(/仅定位了 1\/2 个 locus；未声称完整回到来源/).length).toBeGreaterThan(0), { timeout: 3000 });
    expect(screen.queryByText(/已回到来源（部分高亮/)).toBeNull();
    expect(screen.queryByText(/已回到来源 ✓（exact locus 已定位并高亮）/)).toBeNull();
    host.remove();
    view.unmount();
    cleanup();
  });

  // behavior regression narrow UX A：re-entry highlight transient lifecycle（~自动消失）+ generation
  // race（rapid repeat 不清新 highlight）。通过 window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS
  // 把自动清除窗口调短，用真实 setTimeout 驱动（不引入全局 fake timers）。
  function buildReentryFixture({ segments, events, perSegment }) {
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 8",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":${JSON.stringify(segments)}}`,
      "--- dsh-body",
      "SOURCE-A",
      "--- dsh-note v1 end",
    ].join("\n");
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true, status: "exact", sameSession: true, contextWindow: 2,
            exact: { sessionId: SESSION, projectionVersion: 1, segments, text: "SOURCE-A", perSegment, events },
            context: { perEvent: [] },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    return { view, fetchFn };
  }
  const singleSeg = {
    segments: [{ eventSeq: 7, start: 0, end: 8 }],
    events: [{ eventSeq: 7, projection: "SOURCE-A" }],
    perSegment: [{ eventSeq: 7, start: 0, end: 8, text: "SOURCE-A", hint: { eventSeq: 7, messageId: "m-7" } }],
  };
  const twoSeg = {
    segments: [{ eventSeq: 7, start: 0, end: 4 }, { eventSeq: 17, start: 0, end: 4 }],
    events: [{ eventSeq: 7, projection: "SOUR" }, { eventSeq: 17, projection: "CE-A" }],
    perSegment: [
      { eventSeq: 7, start: 0, end: 4, text: "SOUR", hint: { eventSeq: 7, messageId: "m-7" } },
      { eventSeq: 17, start: 0, end: 4, text: "CE-A", hint: { eventSeq: 17, messageId: "m-17" } },
    ],
  };

  it("behavior regression A: same-session highlight 数秒后自然消失（transient navigation feedback）", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messagem-7">SOURCE-A</div>';
    document.body.appendChild(host);
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 60;
    const { view } = buildReentryFixture(singleSeg);
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(host.querySelector("mark[data-dsh-reentry]")).toBeTruthy(), { timeout: 3000 });
    // 未到窗口期：mark 仍在
    expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(1);
    // 等自动清除（>60ms）
    await new Promise((r) => setTimeout(r, 200));
    expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(0);
    // DOM 无残留 highlight marker/class（文本已还原）
    expect(host.querySelectorAll("[data-dsh-reentry]").length).toBe(0);
    expect(host.textContent).toBe("SOURCE-A");
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    host.remove();
    view.unmount();
    cleanup();
  });

  it("behavior regression A: 再次 re-entry 立即清旧 mark（不等旧 timer）", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messagem-7">SOURCE-A</div>';
    document.body.appendChild(host);
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 5000; // 窗口很长，证明不是靠 timer 清的
    const { view } = buildReentryFixture(singleSeg);
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(1), { timeout: 3000 });
    // 立即第二次 ↪ → 旧 mark 被清、重新高亮（仍只 1 个）
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(1), { timeout: 3000 });
    expect(host.querySelectorAll("mark").length).toBe(1);
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    host.remove();
    view.unmount();
    cleanup();
  });

  it("behavior regression A: old timeout 不清 newer re-entry highlight（generation race）", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messagem-7">SOURCE-A</div><div data-chat-anchor-key="17:input-messagem-17">CE-A</div>';
    document.body.appendChild(host);
    // 第一次 ↪ 的自动清除窗口 150ms；第二次 ↪ 在 80ms 时发生（旧 timer 尚未到期）。
    // 关键断言：第二次 ↪ 后新 mark 必须活过旧 deadline（150ms）——证明旧 timer 被取消
    // /generation 防护生效；随后新 timer 到期自然消失。
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 150;
    const { view } = buildReentryFixture(twoSeg);
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2), { timeout: 3000 });
    // t≈0+ 第一次 highlight 就位。等 80ms 后第二次 ↪（旧 timer deadline=150 未到）。
    await new Promise((r) => setTimeout(r, 80));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2), { timeout: 3000 });
    // 累计 ~180ms > 旧 deadline 150：若旧 timer 未取消会在这清掉新 mark → 必须仍在。
    await new Promise((r) => setTimeout(r, 120));
    expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2);
    // 新 timer deadline ≈ 80+150=230ms；等超过它 → 自然消失（transient 闭环）。
    await new Promise((r) => setTimeout(r, 200));
    expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(0);
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    host.remove();
    view.unmount();
    cleanup();
  });

  it("behavior regression A: multi-segment marks 作为同一次 re-entry 一起清除（不残留单个）", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messagem-7">SOUR</div><div data-chat-anchor-key="17:input-messagem-17">CE-A</div>';
    document.body.appendChild(host);
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 250;
    const { view } = buildReentryFixture(twoSeg);
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2), { timeout: 3000 });
    // 未到窗口期：2 个 mark 都在
    expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2);
    await new Promise((r) => setTimeout(r, 400));
    expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(0);
    // 两个 mark 的原文都还原
    expect(host.querySelector("[data-chat-anchor-key='7:input-messagem-7']").textContent).toBe("SOUR");
    expect(host.querySelector("[data-chat-anchor-key='17:input-messagem-17']").textContent).toBe("CE-A");
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    host.remove();
    view.unmount();
    cleanup();
  });

  it("behavior regression A: known message identity duplicate S → all exact occurrences are highlighted", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messageidentity-duplicate">target / target</div>';
    document.body.appendChild(host);
    const { view } = buildReentryFixture({
      segments: [{ eventSeq: 7, start: 0, end: 6 }, { eventSeq: 7, start: 9, end: 15 }],
      events: [{ eventSeq: 7, projection: "target / target" }],
      perSegment: [
        { eventSeq: 7, start: 0, end: 6, text: "target", hint: { eventSeq: 7, messageId: "identity-duplicate" } },
        { eventSeq: 7, start: 9, end: 15, text: "target", hint: { eventSeq: 7, messageId: "identity-duplicate" } },
      ],
    });
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(host.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2), { timeout: 3000 });
    expect([...host.querySelectorAll("mark[data-dsh-reentry]")].map((mark) => mark.textContent)).toEqual(["target", "target"]);
    expect(host.style.outline || "").toBe("");
    host.remove();
    view.unmount();
    cleanup();
  });

  it("behavior regression B: cross-session consent 文案明确'不切换到原会话'（不误读为 navigation failure）", async () => {
    const OTHER = "session-test-0002-0002";
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${OTHER}`,
      "dsh-meta snapshot-length: 7",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${OTHER}","segments":[{"eventSeq":5,"start":0,"end":7}]}`,
      "--- dsh-body",
      "OTHER-B",
      "--- dsh-note v1 end",
    ].join("\n");
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ ok: true, status: "exact", sameSession: false, contextWindow: 2, exact: { sessionId: OTHER, projectionVersion: 1, segments: [{ eventSeq: 5, start: 0, end: 7 }], text: "OTHER-B", perSegment: [{ eventSeq: 5, start: 0, end: 7, text: "OTHER-B", hint: { eventSeq: 5, messageId: "m-5" } }] }, context: { perEvent: [] } }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    let confirmMsg = "";
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("confirm", vi.fn((msg) => { confirmMsg = msg; return true; }));
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByText(/已保存便签\s*1/));
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getByText(/跨会话 exact 已读取/)).toBeTruthy(), { timeout: 3000 });
    // 文案必须明确：另一会话 + 不切换到原会话 + 仅本次 + 不建长期授权
    expect(confirmMsg).toContain("另一会话");
    expect(confirmMsg).toContain(OTHER);
    expect(confirmMsg).toContain("不会切换到原会话");
    expect(confirmMsg).toContain("仅本次请求有效");
    expect(confirmMsg).toContain("不建立长期授权");
    view.unmount();
    cleanup();
  });
});

describe("Notes behavior regression (behavior regression): coherent Note-primary UI（便签视图）", () => {
  // 参考 SESSION_ID 形态：SESSION = "session-test-0001-0001"
  const PAYLOAD = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 0, end: 8 }] };
  const SNAP = "SOURCE-A";

  // 构造一条 source-aware block（comment 可空）；与 host anchored/prepare 的产物同构。
  const awareBlock = (comment, payload = PAYLOAD) =>
    serializeItem(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: SNAP, comment, sourcePayload: payload }));

  /** 注入浏览器 selection（data-chat-anchor-key 容器内选中 SNAP 文本）。 */
  const stubCaptureSelection = (messageId = "cap-w6") => {
    const host = document.createElement("div");
    host.innerHTML = `<div data-chat-anchor-key="13:input-message${messageId}">${SNAP}</div>`;
    document.body.appendChild(host);
    const el = host.querySelector("[data-chat-anchor-key]");
    const range = document.createRange();
    range.setStart(el.firstChild, 0);
    range.setEnd(el.firstChild, SNAP.length);
    vi.stubGlobal("getSelection", vi.fn(() => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range })));
    return () => host.remove();
  };

  /** capture 链路 + lane GET/PUT 的默认 mock。putBodies 收集 PUT body。 */
  const installCaptureFetch = ({ body = "", onPut } = {}) => {
    const putBodies = [];
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/api/session.history")) {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ type: "server-response", result: { ok: true, value: { events: [
            { event: { seq: 7, type: "user/message", data: { id: "cap-w6", content: [{ type: "text", text: SNAP }], source: { kind: "user" } } } },
          ] } } }),
        });
      }
      if (url.includes("/notes-api/anchored/validate")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          ok: true,
          validated: { sessionId: SESSION, projectionVersion: 2, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: SNAP, unresolved: [], sourcePayload: PAYLOAD },
        }) });
      }
      if (url.includes("/notes-api/anchored/prepare")) {
        const req = JSON.parse(opts.body);
        const block = awareBlock(req.comment ?? "");
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, block }) });
      }
      if (url.includes("/notes-api/reentry")) {
        const parsed = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          ok: true, status: "exact", sameSession: true, contextWindow: 2,
          exact: { sessionId: parsed.locator.sessionId, projectionVersion: 1, segments: parsed.locator.segments, text: SNAP, perSegment: [] },
          context: { perEvent: [] },
        }) });
      }
      if (opts?.method === "PUT") {
        putBodies.push(String(opts.body ?? ""));
        if (onPut) onPut(String(opts.body ?? ""));
        return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      }
      return Promise.resolve(makeResponse(body, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    return { fetchFn, putBodies };
  };

  const composerBox = () => document.querySelector("[data-composer]");
  // behavior regression/Notes behavior regression r3：正文 textarea placeholder 统一为「（可留空，以后再补）」（composer 与
  // 卡片原位编辑同一文案）
  const composerInput = () => screen.getByPlaceholderText(/可留空，以后再补/);
  const noteListEl = () => document.querySelector("[data-notes-list]");
  const typeComposer = (value) => fireEvent.change(composerInput(), { target: { value } });

  it("A: 「引用选中到便签」capture（proposal）→ composer 出现「引用的原文」区块（只读预览 + 提示）", async () => {
    installCaptureFetch();
    mountPanel();
    await openPanel();
    // Notes behavior regression：打开面板后再给选区（否则 auto-attach 会抢先出 proposal），再显式点击
    const removeHost = stubCaptureSelection();
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    // host 已校验 → proposal 只在 composer 内展示为「引用的原文」区块（单一创建流；
    // 旧 disclosure“拟保存的 source 捕获 / 保存捕获 / 备注 input”已移除）
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    expect(composerBox().textContent).toContain(SNAP); // 只读引用文本预览
    expect(composerBox().textContent).not.toContain("已附加来源"); // behavior regression 6.1：不显示静态 re-entry 声明
    expect(composerBox().textContent).not.toContain("可回到原处");
    expect(screen.getByRole("button", { name: "保存便签" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存捕获" })).toBeNull();
    expect(screen.queryByText(/拟保存的 source 捕获/)).toBeNull();
    expect(composerBox().textContent).not.toContain("attached source");
    removeHost();
  });

  it("B: authored 非空保存（anchored）→ 列表出现人类可读卡片（authored 为主 + 「引用的原文」区块）", async () => {
    const { putBodies } = installCaptureFetch();
    mountPanel();
    await openPanel();
    const removeHost = stubCaptureSelection();
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    typeComposer("你好，这是一条便签");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    // PUT body = 空 lane body + anchored block（authored 进 comment）
    const parsedPut = parseLaneBody(putBodies[0]);
    expect(parsedPut.nodes[0].type).toBe("item");
    expect(parsedPut.nodes[0].item.comment).toBe("你好，这是一条便签");
    expect(parsedPut.nodes[0].item.snapshot).toBe(SNAP);
    // 列表出现人类可读卡片：authored 为主文字、source-aware 卡片区块标题为
    // 「引用的原文」（替换旧 “Source · attached source”）
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    const listText = noteListEl().textContent;
    expect(listText).toContain("你好，这是一条便签");
    expect(listText).toContain(SNAP);
    expect(listText).toContain("引用的原文");
    expect(listText).not.toContain("Source · attached source");
    expect(listText).not.toContain("attached source");
    expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "↪ 回来源" })).toBeTruthy();
    removeHost();
  });

  it("C: authored 空保存（带 capture）合法 → 点编辑补 authored → sourcePayload/snapshot 未变（含 G）", async () => {
    const { putBodies } = installCaptureFetch();
    mountPanel();
    await openPanel();
    const removeHost = stubCaptureSelection();
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    // authored 留空直接保存（anchored，合法）
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const firstPut = putBodies[0];
    const firstItem = parseLaneBody(firstPut).nodes[0].item;
    expect(firstItem.snapshot).toBe(SNAP);
    expect(firstItem.comment ?? "").toBe("");
    expect(JSON.stringify(firstItem.sourcePayload)).toBe(JSON.stringify(PAYLOAD));
    // 空 authored → 明确占位可见（「引用的原文」区块与 ↪ 回来源仍在）
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.getByText("[空便签——之后可补写]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "↪ 回来源" })).toBeTruthy();
    // 编辑补 authored
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    typeComposer("补写的文字");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(putBodies.length).toBe(2), { timeout: 3000 });
    const editedItem = parseLaneBody(putBodies[1]).nodes[0].item;
    // G: 编辑 authored 不影响 snapshot；sourcePayload 原样保留
    expect(editedItem.snapshot).toBe(SNAP);
    expect(JSON.stringify(editedItem.sourcePayload)).toBe(JSON.stringify(PAYLOAD));
    expect(editedItem.comment).toBe("补写的文字");
    // 原位替换：编辑前 PUT 与编辑后 PUT 都只含同一条 item（raw 逐字符替换）
    expect(putBodies[1].includes("dsh-note v1 begin")).toBe(true);
    expect(putBodies[1]).not.toContain("dsh-note v1 begin\n--- dsh-note v1 begin");
    removeHost();
  });

  it("D: 普通 authored 编辑 → PUT body 中 source-payload/snapshot 行不变（对比保存前，带 legacy 前缀）", async () => {
    const legacyPrefix = "旧式段落\n\n";
    const original = legacyPrefix + awareBlock("旧评论");
    const { putBodies } = installCaptureFetch({ body: original });
    mountPanel();
    await openPanel();
    // 列表只渲染 decoded 卡片（legacy 段落 + item 卡片）
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(composerInput().value).toBe("旧评论");
    typeComposer("改写后的评论内容");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const putBody = putBodies[0];
    const putParsed = parseLaneBody(putBody);
    expect(putParsed.nodes[0].type).toBe("legacy");
    expect(putParsed.nodes[0].text).toBe("旧式段落\n"); // legacy 前缀字节保留（不含被替换的 item 块）
    const item = putParsed.nodes[1].item;
    expect(item.snapshot).toBe(SNAP);
    expect(item.comment).toBe("改写后的评论内容");
    expect(JSON.stringify(item.sourcePayload)).toBe(JSON.stringify(PAYLOAD));
    // 与保存前逐行对比：source-payload 行 / snapshot-length 行 / snapshot payload 文本不变
    const beforeRows = original.split("\n");
    const afterRows = putBody.split("\n");
    const rowOf = (rows, key) => rows.find((r) => r.startsWith(`dsh-meta ${key}:`));
    expect(rowOf(afterRows, "source-payload")).toBe(rowOf(beforeRows, "source-payload"));
    expect(rowOf(afterRows, "snapshot-length")).toBe(rowOf(beforeRows, "snapshot-length"));
    expect(rowOf(afterRows, "kind")).toBe(rowOf(beforeRows, "kind"));
    expect(rowOf(afterRows, "origin")).toBe(rowOf(beforeRows, "origin"));
  });

  it("E: composer 取消 → 清空草稿、不产生任何 item（无 PUT）", async () => {
    const fetchFn = installDefaultFetch();
    mountPanel();
    await openPanel();
    typeComposer("草稿内容（不应保存）");
    expect(composerInput().value).toBe("草稿内容（不应保存）");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(composerInput().value).toBe(""));
    expect(screen.queryByText(/已保存便签\s*1/)).toBeNull(); // 列表无新增
    const puts = fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT");
    expect(puts.length).toBe(0); // lane 无任何写
  });

  it("F: 切换 lane 清 composer（草稿不跨 lane 残留）", async () => {
    vi.stubGlobal("fetch", vi.fn((u, opts) => {
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    typeComposer("L1 草稿");
    expect(composerInput().value).toBe("L1 草稿");
    fireEvent.click(screen.getByRole("button", { name: /L2 延后工作/ }));
    // 等 L2 真正加载完（footer 显示 deferred_work 路径）再切回 L1
    await waitFor(() => expect(screen.getByText(/notes\/deferred_work\//)).toBeTruthy());
    // 切回 L1：composer 已清空（草稿不跨 lane 保留，与 capture 清理一致）
    fireEvent.click(screen.getByRole("button", { name: /L1 会话待办/ }));
    await waitFor(() => expect(composerInput().value).toBe(""));
  });

  it("H: 可读 exact 但无 visible cue → 不冒充成功且仍为 read-only", async () => {
    const body = awareBlock("带来源的便签");
    const { fetchFn } = installCaptureFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(screen.getAllByText(/没有可用 attention cue；未声称已回到来源/).length).toBeGreaterThan(0), { timeout: 3000 });
    const reentryCall = fetchFn.mock.calls.find(([u]) => String(u).includes("/notes-api/reentry"));
    expect(reentryCall).toBeTruthy();
    const parsed = JSON.parse(reentryCall[1].body);
    expect(parsed.currentSessionId).toBe(SESSION);
    expect(parsed.consent).toBe("per-request");
    expect(parsed.locator.sessionId).toBe(SESSION);
    expect(screen.queryByText(/已回到来源 ✓/)).toBeNull();
    const puts = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/notes-api/") && c[1]?.method === "PUT");
    expect(puts.length).toBe(0);
  });

  it("H2: exact cue 跨 inline renderer 节点时保持格式，清理可逆", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messageFMT-1"><div data-variant="think">Mock reasoning</div><div class="markdown"><strong>AB</strong><em>CD</em></div></div>';
    document.body.appendChild(host);
    const anchor = host.querySelector("[data-chat-anchor-key]");
    const originalHtml = anchor.innerHTML;
    const originalStrongText = anchor.querySelector("strong").firstChild;
    const originalEmText = anchor.querySelector("em").firstChild;
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 60;
    const payload = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 1, end: 3 }] };
    const body = serializeItem(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: "BC", comment: "格式回归", sourcePayload: payload }));
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        const parsed = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          ok: true, status: "exact", sameSession: true,
          exact: {
            sessionId: SESSION, projectionVersion: 1, segments: parsed.locator.segments,
            text: "BC", perSegment: [{ eventSeq: 7, start: 1, end: 3, text: "BC", hint: { eventSeq: 7, messageId: "FMT-1" } }],
            events: [{ eventSeq: 7, projection: "ABCD" }],
          }, context: { perEvent: [] },
        }) });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(body, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const view = mountPanel();
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(anchor.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2), { timeout: 3000 });
    expect(anchor.querySelector("strong mark")?.textContent).toBe("B");
    expect(anchor.querySelector("em mark")?.textContent).toBe("C");
    expect(anchor.querySelector("mark")?.style.outline || "").toBe("");
    expect(anchor.style.outline || "").toBe("");
    expect(anchor.textContent).toBe("Mock reasoningABCD");
    expect(anchor.querySelector("strong")?.textContent).toBe("AB");
    expect(anchor.querySelector("em")?.textContent).toBe("CD");

    // Let the production timer invoke the real cleanup; do not manually unwrap
    // marks, because that would bypass the implementation under test.
    await waitFor(() => expect(anchor.querySelectorAll("mark[data-dsh-reentry]").length).toBe(0), { timeout: 3000 });
    expect(anchor.innerHTML).toBe(originalHtml);
    expect(anchor.querySelector("strong").firstChild).toBe(originalStrongText);
    expect(anchor.querySelector("em").firstChild).toBe(originalEmText);
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    view.unmount();
    host.remove();
    cleanup();
  });

  it("H3: renderer 在 transient cue 期间改动文本时，cleanup 不覆盖外部改动", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messageFMT-2"><strong>AB</strong><em>CD</em></div>';
    document.body.appendChild(host);
    const anchor = host.querySelector("[data-chat-anchor-key]");
    window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS = 60;
    const payload = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 1, end: 3 }] };
    const body = serializeItem(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: "BC", comment: "mutation", sourcePayload: payload }));
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) return Promise.resolve({ ok: true, status: 200, json: async () => ({
        ok: true, status: "exact", sameSession: true,
        exact: { sessionId: SESSION, projectionVersion: 1, segments: payload.segments, text: "BC", perSegment: [{ eventSeq: 7, start: 1, end: 3, text: "BC", hint: { eventSeq: 7, messageId: "FMT-2" } }], events: [{ eventSeq: 7, projection: "ABCD" }] },
        context: { perEvent: [] },
      }) });
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(body, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const view = mountPanel();
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(anchor.querySelectorAll("mark[data-dsh-reentry]").length).toBe(2), { timeout: 3000 });
    anchor.querySelector("strong mark").textContent = "X";
    await waitFor(() => expect(anchor.querySelectorAll("mark[data-dsh-reentry]").length).toBe(0), { timeout: 3000 });
    expect(anchor.querySelector("strong").textContent).toBe("AX");
    expect(anchor.querySelector("em").textContent).toBe("CD");
    delete window.__DSH_NOTES_HIGHLIGHT_CLEAR_MS;
    view.unmount();
    host.remove();
    cleanup();
  });

  it("I: 折叠「引用的原文」预览（仅视图状态）→ 不产生任何 PUT", async () => {
    const { fetchFn } = installCaptureFetch({ body: awareBlock("带来源的便签") });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(noteListEl().textContent).toContain(SNAP); // 默认展开
    fireEvent.click(screen.getByRole("button", { name: "来源 ▾" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "来源 ▸" })).toBeTruthy());
    expect(noteListEl().textContent).not.toContain(SNAP); // 折叠后 preview 隐藏
    expect(noteListEl().textContent).toContain("引用的原文"); // 区块标题仍在（控制可再展开）
    // 折叠/列表渲染均无写请求
    await new Promise((r) => setTimeout(r, 20));
    const puts = fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT");
    expect(puts.length).toBe(0);
  });

  it("J: legacy 文本在便签视图以段落展示；“原文编辑”区仍可读/写", async () => {
    const body = "旧式自由文本第一行\n第二行内容\n";
    const { fetchFn } = installCaptureFetch({ body });
    mountPanel();
    await openPanel();
    // 便签视图：composer textbox 为空，legacy 以段落（非 textarea）展示
    expect(screen.getByRole("textbox").value).toBe("");
    expect(noteListEl().textContent).toContain("旧式自由文本第一行");
    expect(noteListEl().textContent).toContain("第二行内容");
    // 原文编辑区读：整层文本可读
    await openRawView();
    await waitFor(() => expect(screen.getByRole("textbox").value).toBe(body));
    // 原文编辑区写：整层改写后保存
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "改写后的整层内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const put = fetchFn.mock.calls.find(([, o]) => o?.method === "PUT");
      expect(put).toBeTruthy();
      expect(put[1].body).toBe("改写后的整层内容");
    });
  });

  it("K: 默认便签视图（卡片区）不出现 dsh-meta/source-payload/--- dsh-note 框架文本（原文区可有）", async () => {
    const { fetchFn } = installCaptureFetch({ body: awareBlock("带来源便签正文") });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    const listText = noteListEl().textContent;
    expect(listText).toContain("带来源便签正文");
    expect(listText).not.toContain("dsh-meta");
    expect(listText).not.toContain("source-payload");
    expect(listText).not.toContain("--- dsh-note");
    expect(listText).not.toContain("dsh-body");
    // 原文编辑区允许出现框架文本（raw 文本读/写语义不受影响）
    await openRawView();
    const rawValue = screen.getByRole("textbox").value;
    expect(rawValue).toContain("dsh-meta kind: source-aware");
    expect(rawValue).toContain("dsh-meta source-payload:");
    expect(rawValue).toContain("--- dsh-note v1 begin");
  });

  it("L: 自动附源——打开面板时已有选区（不点任何捕获）→ composer 自动出现「引用的原文」区块", async () => {
    const { fetchFn } = installCaptureFetch();
    mountPanel();
    const removeHost = stubCaptureSelection(); // 打开面板前给选区（auto-attach 场景）
    await openPanel();
    // 无需点击引用按钮：proposal + composer「引用的原文」区块自动出现
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    expect(composerBox().textContent).toContain(SNAP); // 只读引用文本预览
    // 状态文案面向用户（auto attach 成功）
    await waitFor(() => expect(screen.getByText("已引用选中文本——可写便签后保存")).toBeTruthy(), { timeout: 3000 });
    // auto-attach guard：只发起一次捕获请求（无重复）
    const histCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/api/session.history"));
    const validateCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/notes-api/anchored/validate"));
    expect(histCalls.length).toBe(0);
    expect(validateCalls.length).toBe(1);
    removeHost();
  });

  it("M: 无选区打开 → 不自动附源（静默纯便签模式），可保存 source-independent 便签", async () => {
    const { putBodies, fetchFn } = installCaptureFetch();
    mountPanel();
    await openPanel();
    // 无选区：无任何捕获请求、无 proposal / composer「引用的原文」区块（静默）
    const histCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/api/session.history"));
    const validateCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/notes-api/anchored/validate"));
    expect(histCalls.length).toBe(0);
    expect(validateCalls.length).toBe(0);
    expect(screen.queryByText("引用的原文")).toBeNull();
    expect(composerBox().textContent).not.toContain("引用的原文");
    // 纯便签保存（source-independent；不阻塞；正文输入后出现“普通便签”轻提示）
    typeComposer("纯便签内容");
    expect(composerBox().textContent).toContain("（未引用原文——保存为普通便签）");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const nodes = parseLaneBody(putBodies[0]).nodes;
    expect(nodes.length).toBe(1);
    expect(nodes[0].type).toBe("item");
    expect(nodes[0].item.kind).toBe("source-independent");
    expect(nodes[0].item.comment).toBe("纯便签内容");
    expect(putBodies[0]).not.toContain("dsh-meta kind: source-aware");
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
  });

  it("N: 删除整条便签——卡片内联确认：取消 → 无任何写；确认 → whole-lane PUT 只剩第二条（顺序/字节正确）", async () => {
    const first = awareBlock("第一条便签内容");
    const second = awareBlock("第二条便签内容");
    const { putBodies } = installCaptureFetch({ body: first + "\n\n" + second });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "删除…" }).length).toBe(2);
    // behavior regression（view order）：默认“新记录在前”下 DOM 首卡是物理**最末**条——删除必须按
    // 内容锚定物理第一条的卡片，不能假设 DOM 序 == 物理序（物理 index 锚的语义不变）。
    const firstNoteCard = () =>
      [...noteListEl().querySelectorAll(":scope > div")].slice(1).find((el) =>
        (el.textContent || "").includes("第一条便签内容"));
    // 点 [删除…] → 该卡片内出现确认行（非 window.confirm）
    fireEvent.click(within(firstNoteCard()).getByRole("button", { name: "删除…" }));
    const confirmBox = document.querySelector("[data-confirm-delete]");
    expect(confirmBox).toBeTruthy();
    expect(confirmBox.textContent).toContain("删除这条便签？这会删除这条便签以及它附带的来源关系。");
    // 取消：恢复操作行、无任何写、两条都在
    within(confirmBox).getByRole("button", { name: "取消" }).click();
    await waitFor(() => expect(document.querySelector("[data-confirm-delete]")).toBeNull());
    await new Promise((r) => setTimeout(r, 30));
    expect(putBodies.length).toBe(0);
    expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy();
    expect(screen.getByText("第一条便签内容")).toBeTruthy();
    // 确认：删除第一条 → PUT body 只剩第二条（字节精确、顺序不变）
    fireEvent.click(within(firstNoteCard()).getByRole("button", { name: "删除…" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    expect(putBodies[0]).toBe(second);
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.queryByText("第一条便签内容")).toBeNull();
    expect(screen.getByText("第二条便签内容")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("已删除便签")).toBeTruthy());
  });

  it("O: 空 authored + 引用的原文 卡片 → 明确占位 [空便签——之后可补写]，仍显示引用区块与 ↪ 回来源", async () => {
    const { fetchFn } = installCaptureFetch({ body: awareBlock("") });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.getByText("[空便签——之后可补写]")).toBeTruthy();
    expect(noteListEl().textContent).toContain("引用的原文"); // 区块标题用户语言
    expect(noteListEl().textContent).toContain(SNAP); // snapshot 只读预览仍在
    expect(screen.getByRole("button", { name: "↪ 回来源" })).toBeTruthy();
    // 仅视图渲染：无任何写
    const puts = fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT");
    expect(puts.length).toBe(0);
  });

  it("P: 卡片元信息行区分类型（带来源便签 / 便签 + lane 短标），且不含 dsh-meta/source-payload", async () => {
    const independent = serializeItem(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "纯文本便签" }));
    const { fetchFn } = installCaptureFetch({ body: awareBlock("带来源的正文") + "\n\n" + independent });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    // source-aware → 「带来源便签」；source-independent → 「便签」；均附当前 lane 短标 L1
    expect(screen.getByText("带来源便签 · L1")).toBeTruthy();
    expect(screen.getByText("便签 · L1")).toBeTruthy();
    // 元信息行 + authored 区不暴露框架文本（dsh-meta / source-payload / --- dsh-note）
    const listText = noteListEl().textContent;
    expect(listText).toContain("带来源的正文");
    expect(listText).toContain("纯文本便签");
    expect(listText).not.toContain("dsh-meta");
    expect(listText).not.toContain("source-payload");
    expect(listText).not.toContain("--- dsh-note");
    expect(listText).not.toContain("dsh-body");
    const puts = fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT");
    expect(puts.length).toBe(0);
  });

  it("Q: 自动附源 reject（有选区但不在对话消息容器内）→ composer 下方浅提示，不阻塞纯便签保存", async () => {
    const { putBodies, fetchFn } = installCaptureFetch();
    mountPanel();
    // 选区落在普通文本上（不在 data-chat-anchor-key 内 → 无法精确引用 → truthful reject）
    const host = document.createElement("div");
    host.textContent = "普通文本，不在对话消息内";
    document.body.appendChild(host);
    const range = document.createRange();
    range.setStart(host.firstChild, 0);
    range.setEnd(host.firstChild, 5);
    vi.stubGlobal("getSelection", vi.fn(() => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range })));
    await openPanel();
    // 浅提示出现（composer 卡片内）——人话“无法引用这段文本：…”，不弹错误框、
    // 不出现「引用的原文」区块
    await waitFor(() => expect(composerBox().textContent).toContain("无法引用这段文本："), { timeout: 3000 });
    expect(composerBox().textContent).toContain("可先保存普通便签");
    expect(screen.queryByText("引用的原文")).toBeNull();
    expect(screen.queryByText("捕获未成功")).toBeNull();
    expect(screen.queryByText(/拟保存的 source 捕获/)).toBeNull();
    // 无 host validate；浏览器证据在本地即可 fail-closed，不读全量历史
    const histCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/api/session.history"));
    const validateCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/notes-api/anchored/validate"));
    expect(histCalls.length).toBe(0);
    expect(validateCalls.length).toBe(0);
    // 纯便签保存不受阻塞；保存成功后浅提示被清掉
    typeComposer("先保存纯便签");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const nodes = parseLaneBody(putBodies[0]).nodes;
    expect(nodes[0].item.kind).toBe("source-independent");
    await waitFor(() => expect(composerBox().textContent).not.toContain("无法引用这段文本："), { timeout: 3000 });
    host.remove();
  });

  // ============ Notes behavior regression (behavior regression) focused：单一 Note 创建流 ============
  // source capture 与 Note creation 已收口成一条流——新增这些用例直接断言“只面对
  // 一次「保存便签」动作”的新单流信号。

  it("R1: 引用+正文 → 一次「保存便签」成功：单个 anchored item 落盘，无第二个保存动作", async () => {
    const { putBodies, fetchFn } = installCaptureFetch();
    mountPanel();
    await openPanel();
    const removeHost = stubCaptureSelection();
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    // 单一创建流：composer 里不存在第二个“保存捕获”动作
    expect(screen.queryByRole("button", { name: "保存捕获" })).toBeNull();
    typeComposer("带引用的正文");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const parsed = parseLaneBody(putBodies[0]);
    expect(parsed.nodes.length).toBe(1);
    const item = parsed.nodes[0].item;
    expect(item.kind).toBe("source-aware");
    expect(item.comment).toBe("带引用的正文");
    expect(item.snapshot).toBe(SNAP);
    expect(JSON.stringify(item.sourcePayload)).toBe(JSON.stringify(PAYLOAD));
    // 一次保存动作 → 无第二次写；proposal 已消费（composer 不再显示「引用的原文」、
    // 正文草稿已清）；host prepare 只发生一次
    await new Promise((r) => setTimeout(r, 30));
    expect(putBodies.length).toBe(1);
    const prepareCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/notes-api/anchored/prepare"));
    expect(prepareCalls.length).toBe(1);
    expect(composerBox().textContent).not.toContain("引用的原文");
    expect(composerInput().value).toBe("");
    removeHost();
  });

  it("R2: 引用+空正文 → 合法落盘（source-aware 空 authored → [空便签——之后可补写] 卡片）", async () => {
    const { putBodies } = installCaptureFetch();
    mountPanel();
    await openPanel();
    const removeHost = stubCaptureSelection();
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    // 正文留空直接保存（anchored + 空 authored 合法；不要求先写内容）
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const item = parseLaneBody(putBodies[0]).nodes[0].item;
    expect(item.kind).toBe("source-aware");
    expect(item.comment ?? "").toBe("");
    expect(item.snapshot).toBe(SNAP);
    expect(JSON.stringify(item.sourcePayload)).toBe(JSON.stringify(PAYLOAD));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.getByText("[空便签——之后可补写]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "↪ 回来源" })).toBeTruthy();
    removeHost();
  });

  it("R3: source 校验失败（validate ok:false）→ 整条不假成功：无 PUT、无 proposal 区块、composer 下方提示可见", async () => {
    const putBodies = [];
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/api/session.history")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ type: "server-response", result: { ok: true, value: { events: [
          { event: { seq: 7, type: "user/message", data: { id: "cap-reject", content: [{ type: "text", text: SNAP }], source: { kind: "user" } } } },
        ] } } }) });
      }
      if (url.includes("/notes-api/anchored/validate")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, code: "VALIDATE_STALE", reason: "会话事件已变化，无法精确引用" }) });
      }
      if (opts?.method === "PUT") { putBodies.push(String(opts.body ?? "")); return Promise.resolve(makeResponse("ok", { mtime: "2222" })); }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel();
    await openPanel();
    const removeHost = stubCaptureSelection("cap-reject");
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    // host 校验拒绝 → 整条不假成功：人话浅提示可见（「无法引用这段文本：原因」）、
    // 不出现「引用的原文」区块、未走到 prepare/PUT（无任何写）
    await waitFor(() => expect(composerBox().textContent).toContain("无法引用这段文本：会话事件已变化，无法精确引用"), { timeout: 3000 });
    expect(screen.queryByText("引用的原文")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(putBodies.length).toBe(0);
    const prepareCalls = fetchFn.mock.calls.filter(([u]) => String(u).includes("/notes-api/anchored/prepare"));
    expect(prepareCalls.length).toBe(0);
    removeHost();
  });

  it("R4: 保存取消 → 无创建；正文草稿与引用 proposal 一并清空（取消后无残留）", async () => {
    const { putBodies } = installCaptureFetch();
    mountPanel();
    await openPanel();
    const removeHost = stubCaptureSelection();
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    await waitFor(() => expect(screen.getByText("引用的原文")).toBeTruthy(), { timeout: 3000 });
    typeComposer("取消前的草稿");
    expect(composerInput().value).toBe("取消前的草稿");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    // 取消 = 清正文 + 清引用/attach 残留：无「引用的原文」区块、无浅提示、草稿空
    await waitFor(() => expect(composerInput().value).toBe(""));
    expect(screen.queryByText("引用的原文")).toBeNull();
    expect(screen.queryByText("已附加来源 · 可回到原处")).toBeNull();
    expect(composerBox().textContent).not.toContain("无法引用这段文本：");
    expect(putBodies.length).toBe(0); // 无任何创建
    removeHost();
  });

  it("R5: 编辑 anchored → authored 变；sourcePayload/snapshot/origin 行不变", async () => {
    const original = awareBlock("原评论内容");
    const { putBodies } = installCaptureFetch({ body: original });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(composerInput().value).toBe("原评论内容");
    typeComposer("改后的评论");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const beforeRows = original.split("\n");
    const afterRows = putBodies[0].split("\n");
    const rowOf = (rows, key) => rows.find((r) => r.startsWith(`dsh-meta ${key}:`));
    expect(rowOf(afterRows, "kind")).toBe(rowOf(beforeRows, "kind"));
    expect(rowOf(afterRows, "origin")).toBe(rowOf(beforeRows, "origin"));
    expect(rowOf(afterRows, "source-payload")).toBe(rowOf(beforeRows, "source-payload"));
    expect(rowOf(afterRows, "snapshot-length")).toBe(rowOf(beforeRows, "snapshot-length"));
    const item = parseLaneBody(putBodies[0]).nodes[0].item;
    expect(item.comment).toBe("改后的评论");
    expect(item.snapshot).toBe(SNAP);
    expect(JSON.stringify(item.sourcePayload)).toBe(JSON.stringify(PAYLOAD));
  });

  it("R5b: anchored 卡片编辑可清空 authored，并保留 Source/S/metadata", async () => {
    const original = serializeItem(withItemKey(makeItem({
      kind: "source-aware",
      captureOrigin: SESSION,
      snapshot: SNAP,
      comment: "原评论",
      sourcePayload: PAYLOAD,
      unknownMeta: [{ raw: "dsh-meta future: keep" }],
    }), "ik-aware-edit"));
    const { putBodies } = installCaptureFetch({ body: original });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    const before = parseLaneBody(original).nodes[0].item;
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    typeComposer("");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    const after = parseLaneBody(putBodies[0]).nodes[0].item;
    expect(after.comment ?? "").toBe("");
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.sourcePayload).toEqual(before.sourcePayload);
    expect(after.captureOrigin).toBe(before.captureOrigin);
    expect(after.unknownMeta).toEqual(before.unknownMeta);
    expect(after.metaOrder.filter((entry) => entry.kind !== "known" || entry.key !== "comment-length"))
      .toEqual(before.metaOrder.filter((entry) => entry.kind !== "known" || entry.key !== "comment-length"));
  });

  it("R5c: source-independent 卡片编辑拒绝空白 authored，且不写入", async () => {
    const original = serializeItem(withItemKey(makeItem({
      kind: "source-independent",
      captureOrigin: SESSION,
      comment: "普通便签",
    }), "ik-independent-edit"));
    const { putBodies } = installCaptureFetch({ body: original });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    for (const invalidContent of ["", " \t\n "]) {
      fireEvent.click(screen.getByRole("button", { name: "编辑" }));
      typeComposer(invalidContent);
      fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
      await waitFor(() => expect(screen.getByText(/先写内容/)).toBeTruthy());
      expect(putBodies.length).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      await waitFor(() => expect(screen.getByText("普通便签")).toBeTruthy());
    }
  });

  it("R6: 空正文 + 无引用 → 不创建（既有 both-empty 拒绝提示保留）", async () => {
    const fetchFn = installDefaultFetch();
    mountPanel();
    await openPanel();
    expect(composerInput().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(screen.getByText(/先写内容/)).toBeTruthy());
    typeComposer(" \t\n ");
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(screen.getByText(/先写内容/)).toBeTruthy());
    const puts = fetchFn.mock.calls.filter(([, o]) => o?.method === "PUT");
    expect(puts.length).toBe(0);
  });
});

describe("Notes behavior regression behavior regression sidebar polish / mental-model", () => {
  it("草稿 composer（带 source）无 回来源/静态声明；保存后卡片才有 回来源", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-chat-anchor-key="7:input-messagep4a-1">SOURCE-A</div>';
    document.body.appendChild(host);
    const ITEM_BLOCK = [
      "--- dsh-note v1 begin",
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${SESSION}`,
      "dsh-meta snapshot-length: 8",
      `dsh-meta source-payload: {"projectionVersion":1,"sessionId":"${SESSION}","segments":[{"eventSeq":7,"start":0,"end":8}]}`,
      "--- dsh-body",
      "SOURCE-A",
      "--- dsh-note v1 end",
    ].join("\n");
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/api/session.history")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ type: "server-response", result: { ok: true, value: { events: [{ event: { seq: 7, type: "user/message", data: { id: "p4a-1", content: [{ type: "text", text: "SOURCE-A" }], source: { kind: "user" } } } }] } } }) });
      if (url.includes("/notes-api/anchored/validate")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, validated: { sessionId: SESSION, projectionVersion: 1, segments: [{ eventSeq: 7, start: 0, end: 8 }], effectiveSourceText: "SOURCE-A", unresolved: [], sourcePayload: { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 0, end: 8 }] } } }) });
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(ITEM_BLOCK, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const anchorEl = host.querySelector("[data-chat-anchor-key]");
    const range = document.createRange(); range.setStart(anchorEl.firstChild, 0); range.setEnd(anchorEl.firstChild, 8);
    vi.stubGlobal("getSelection", vi.fn(() => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range })));
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    // header affordance 可发现（文字承载）
    const headerBtn = screen.getByTitle("协作便签");
    expect(headerBtn.textContent).toContain("便签");
    fireEvent.click(headerBtn);
    await waitFor(() => screen.getByText(/新便签/), { timeout: 3000 });
    // 工作区分离：composer 在 notes 列表之前
    const composerEl = document.querySelector("[data-composer]");
    const listEl = document.querySelector("[data-notes-list]");
    expect(composerEl).toBeTruthy();
    expect(listEl).toBeTruthy();
    expect(composerEl.compareDocumentPosition(listEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 手动 attach（auto 时序更稳）→ composer「引用的原文」；composer 区内无回来源/静态声明
    fireEvent.click(screen.getByRole("button", { name: "引用选中到便签" }));
    await waitFor(() => expect(screen.getAllByText("引用的原文").length).toBeGreaterThan(0), { timeout: 3000 });
    const composerEl2 = document.querySelector("[data-composer]");
    expect(composerEl2.textContent).not.toContain("已附加来源");
    expect(composerEl2.textContent).not.toContain("可回到原处");
    // 已保存卡片（同一 list 的 anchored item）才有 ↪ 回来源——限定在 notes list 内
    const listEl2 = document.querySelector("[data-notes-list]");
    expect(listEl2.querySelectorAll("button").length).toBeGreaterThan(0);
    expect([...listEl2.querySelectorAll("button")].some((b) => (b.textContent || "").includes("回来源"))).toBe(true);
    host.remove();
    view.unmount();
    cleanup();
  });
});

describe("Notes behavior regression behavior regression help / onboarding", () => {
  function mountComponent() {
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    return registered.Component;
  }
  it("? 帮助：开关显示/隐藏五类内容；打开关闭零写、不污染草稿/Notes 状态", async () => {
    let putCount = 0;
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (opts?.method === "PUT") { putCount++; return Promise.resolve(makeResponse("ok", { mtime: "2222" })); }
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const Component = mountComponent();
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    const headerBtn = screen.getByTitle("协作便签");
    fireEvent.click(headerBtn);
    await waitFor(() => screen.getByText(/新便签/), { timeout: 3000 });
    // 草稿输入一点内容，验证 help 开关不清草稿
    fireEvent.change(screen.getByPlaceholderText(/可留空/), { target: { value: "草稿保留" } });
    // open ?
    fireEvent.click(screen.getByRole("button", { name: /帮助（便签怎么用）/ }));
    expect(document.querySelector("[data-help-panel]")).toBeTruthy();
    const body = document.body.innerText;
    for (const t of ["便签正文", "引用的原文", "L1 会话待办", "L2 延后工作", "L3 知识候选", "L4 复盘素材", "分支中的便签", "编辑与删除"]) {
      expect(body).toContain(t);
    }
    // 不介绍未实现能力
    expect(body).not.toContain("Pin");
    // 关闭 → 面板消失；草稿仍在；零 PUT
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(document.querySelector("[data-help-panel]")).toBeNull();
    expect(screen.getByDisplayValue("草稿保留")).toBeTruthy();
    expect(putCount).toBe(0);
    view.unmount();
    cleanup();
  });
});

// ==================== Notes behavior regression behavior regression: Notes 查看顺序 / attention view ====================
// view-only：正序/倒序展示切换。产品语义（勿改）：
//   - “新/旧” = 当前 lane 中已有 Note 的**正向/反向展示**（不建时间模型）；物理旧→新
//     = composer append 顺序。
//   - 排序对象是 Note（authored + optional source）；Source Anchor 存在与否/来源时间/
//     event/locator 不参与排序。
//   - Edit 不是新 capture（编辑后位置不变）；view order ≠ durable order（纯展示，无
//     rewrite/reorder/provenance/downstream 变更）；display order ≠ priority/执行序。
//   - fork-merge 的 parent/child 分组（## 来自父分支 … --- … ## 当前分支已有内容）
//     不得被倒序弄乱或伪造跨 branch chronology → 检测为真的 lane 仅正序（select 隐藏）。
// 断言策略：直接读 [data-notes-list] 内卡片 div（跳过首行标题），按卡片 textContent
// 中 unique authored/legacy 片段的**相对 DOM 位置**断言顺序；所有切换/展示都不许产生
// PUT（putBodies 保持空）——展示层零写。
describe("Notes behavior regression behavior regression notes view order / attention view", () => {
  const PARENT = "session-parent-0002-0002";
  const PAYLOAD_C = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 0, end: 8 }] };
  const SNAP_C = "SOURCE-A"; // 8 cps，与既有 Notes behavior regression fixture 同构
  // 与 Notes behavior regression describe 同构的块构造器（该 describe 的闭包 helper 不可见，此处重建）。
  const plain = (comment, origin = SESSION) =>
    serializeItem(makeItem({ kind: "source-independent", captureOrigin: origin, comment }));
  const aware = (comment) =>
    serializeItem(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: SNAP_C, comment, sourcePayload: PAYLOAD_C }));

  /** lane GET/PUT mock（单 lane body 或按 layerKey 分 lane）。putBodies 收集 PUT。 */
  const installLaneFetch = ({ body = "", lanes, onPut } = {}) => {
    const putBodies = [];
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (opts?.method === "PUT") {
        putBodies.push(String(opts.body ?? ""));
        if (onPut) onPut(String(opts.body ?? ""));
        return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      }
      const key = decodeURIComponent(url.split("/").pop() || "");
      const laneBody = lanes ? lanes[key] ?? "" : body;
      return Promise.resolve(makeResponse(laneBody, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    return { fetchFn, putBodies };
  };

  const notesList = () => document.querySelector("[data-notes-list]");
  const viewDirSelect = () => document.querySelector("[data-view-dir]");
  // 卡片 = 列表容器中跳过标题行后的直系子 div（每条 item/legacy 一个展示单元）。
  const listCards = () => [...notesList().querySelectorAll(":scope > div")].slice(1);
  const cardIndexOf = (frag) => listCards().findIndex((el) => (el.textContent || "").includes(frag));
  /** 断言 fragments 在列表中的相对位置严格递增（即按给定顺序出现）。 */
  const expectCardOrder = (frags) => {
    const idxs = frags.map((f) => cardIndexOf(f));
    for (const i of idxs) expect(i).toBeGreaterThanOrEqual(0);
    for (let k = 1; k < idxs.length; k++) expect(idxs[k]).toBeGreaterThan(idxs[k - 1]);
  };
  const setDir = (value) => {
    fireEvent.change(viewDirSelect(), { target: { value } });
    expect(viewDirSelect().value).toBe(value);
  };
  const cardOf = (frag) => {
    const el = listCards().find((c) => (c.textContent || "").includes(frag));
    expect(el).toBeTruthy();
    return el;
  };
  const composerInput = () => screen.getByPlaceholderText(/可留空，以后再补/);

  const A1 = "AAA正文（最旧）";
  const B1 = "BBB正文（中间）";
  const C1 = "CCC正文（最新）";

  it("A: 三条 source-independent（文件序 A→B→C）→ 默认新在前 C B A；切旧在前 A B C（纯视图零写）", async () => {
    const body = [plain(A1), plain(B1), plain(C1)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    expect(viewDirSelect()).toBeTruthy();
    expect(viewDirSelect().value).toBe("newest"); // 默认新记录在前
    // newest-first（物理尾部在前）
    expectCardOrder([C1, B1, A1]);
    // 切旧在前 → 物理（文件）序
    setDir("oldest");
    expectCardOrder([A1, B1, C1]);
    // 切回新在前
    setDir("newest");
    expectCardOrder([C1, B1, A1]);
    // 纯展示切换：无任何写（不 rewrite/reorder lane Markdown）
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("B: anchored 与普通便签混合：展示顺序仅由文件序决定（与有无 anchor 无关）", async () => {
    // 文件序：aware(A) → plain(B) → aware(C)；anchor 存在与否不改变位置
    const body = [aware(A1), plain(B1), aware(C1)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    // 默认新在前：与 A 完全同构的倒序（anchor 不参与排序）
    expectCardOrder([C1, B1, A1]);
    setDir("oldest");
    expectCardOrder([A1, B1, C1]);
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("C: comment-free anchored（空 authored）是正常 item——倒序中占位卡也在位、不异常", async () => {
    // 文件序：plain(A) → anchored-空(中间) → plain(C)
    const body = [plain(A1), aware(""), plain(C1)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    const emptyPh = "[空便签——之后可补写]";
    // 新在前：C → 空 authored（中间物理位）→ A；占位卡在中间而非顶部/底部
    expectCardOrder([C1, emptyPh, A1]);
    setDir("oldest");
    expectCardOrder([A1, emptyPh, C1]);
    // 空 authored 卡仍渲染完整卡片结构（类型元信息 + 引用的原文 + 回来源按钮）
    expect(cardOf(emptyPh).textContent).toContain("带来源便签 · L1");
    expect(cardOf(emptyPh).textContent).toContain(SNAP_C);
    expect(within(cardOf(emptyPh)).getByRole("button", { name: "↪ 回来源" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("D: 编辑中间旧 Note（A→B→C，编辑 B）→ 保存后仍居中（Edit 不是新 capture，不跳到顶部）", async () => {
    const body = [plain(A1), plain(B1), plain(C1)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    // 默认新在前 C B A：B 的卡在中间——编辑必须按内容锚到 B 卡（物理 index 不变）
    expectCardOrder([C1, B1, A1]);
    fireEvent.click(within(cardOf(B1)).getByRole("button", { name: "编辑" }));
    expect(composerInput().value).toBe(B1); // 原位编辑：正文 = B 当前 authored
    const edited = "BBB正文（已编辑仍在中间）";
    fireEvent.change(composerInput(), { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    // 物理字节：原位替换 B → B'（A、C 与分隔原样；顺序 A B' C）
    const nodes = parseLaneBody(putBodies[0]).nodes;
    expect(nodes.map((n) => (n.type === "item" ? n.item.comment : null))).toEqual([A1, edited, C1]);
    // 展示仍 C B' A：B' 依旧居中——编辑不改变物理位置 → 任何视图下相对位置不变
    await waitFor(() => expectCardOrder([C1, edited, A1]));
    setDir("oldest");
    expectCardOrder([A1, edited, C1]);
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(1); // 仅编辑的 1 次写；视图切换零写
  });

  it("E: 新保存 append D → 新在前顶部出现 D、旧在前底部；物理字节 A B C D 不变", async () => {
    const body = [plain(A1), plain(B1), plain(C1)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    const D1 = "DDD正文（新保存）";
    fireEvent.change(composerInput(), { target: { value: D1 } });
    fireEvent.click(screen.getByRole("button", { name: "保存便签" }));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    // 保存 = appendCaptureBlock 追加尾部 → 物理 A B C D
    expect(parseLaneBody(putBodies[0]).nodes.map((n) => n.item.comment)).toEqual([A1, B1, C1, D1]);
    await waitFor(() => expect(screen.getByText(/已保存便签\s*4/)).toBeTruthy());
    // 新在前：新保存（append 物理尾部）显示于顶部
    expectCardOrder([D1, C1, B1, A1]);
    setDir("oldest");
    expectCardOrder([A1, B1, C1, D1]); // 旧在前：D 在底部
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(1); // 仅保存 1 次写
  });

  it("F: lane 切换保持选择：两 lane 各按自身文件序倒序；切走再切回选择保留", async () => {
    const l1 = [plain("A1"), plain("B1"), plain("C1")].join("\n\n");
    const l2 = [plain("A2"), plain("B2"), plain("C2")].join("\n\n");
    const { putBodies } = installLaneFetch({ lanes: { conversation_todo: l1, deferred_work: l2 } });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    // L1 默认新在前
    expectCardOrder(["C1", "B1", "A1"]);
    // 切 L2：选择（默认 newest）跨 lane 保留，且按 L2 自身文件序倒序
    fireEvent.click(screen.getByRole("button", { name: /L2 延后工作/ }));
    await waitFor(() => expect(screen.getByText(/notes\/deferred_work\//)).toBeTruthy());
    await waitFor(() => expect(viewDirSelect().value).toBe("newest"));
    await waitFor(() => expect(cardIndexOf("C2")).toBeGreaterThanOrEqual(0));
    expectCardOrder(["C2", "B2", "A2"]);
    // 切回 L1：仍 newest
    fireEvent.click(screen.getByRole("button", { name: /L1 会话待办/ }));
    await waitFor(() => expect(screen.getByText(/notes\/conversation_todo\//)).toBeTruthy());
    await waitFor(() => expect(cardIndexOf("C1")).toBeGreaterThanOrEqual(0));
    expectCardOrder(["C1", "B1", "A1"]);
    // 改为 oldest 再切 L2：选择保留为 oldest，L2 正序
    setDir("oldest");
    expectCardOrder(["A1", "B1", "C1"]);
    fireEvent.click(screen.getByRole("button", { name: /L2 延后工作/ }));
    await waitFor(() => expect(screen.getByText(/notes\/deferred_work\//)).toBeTruthy());
    await waitFor(() => expect(viewDirSelect().value).toBe("oldest"));
    await waitFor(() => expect(cardIndexOf("A2")).toBeGreaterThanOrEqual(0));
    expectCardOrder(["A2", "B2", "C2"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("G: remount（关闭面板重开）→ 恢复默认 新记录在前（非持久 preference）", async () => {
    const body = [plain(A1), plain(B1), plain(C1)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    setDir("oldest");
    expect(viewDirSelect().value).toBe("oldest");
    expectCardOrder([A1, B1, C1]);
    // 关闭 → NotesPanel 卸载（重开 = remount → 恢复默认 newest）
    fireEvent.click(screen.getByTitle("关闭（Esc）"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    // 重开
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByRole("textbox"));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    expect(viewDirSelect().value).toBe("newest"); // 恢复默认
    expectCardOrder([C1, B1, A1]);
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("H: legacy 段落 + items 共存：倒序不误拆 legacy、不丢内容、无 PUT（bytes 不变）", async () => {
    const legacy = "旧式段落说明\n第二行内容";
    const body = legacy + "\n\n" + [plain(A1), plain(B1)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    expect(listCards().length).toBe(3); // legacy 一段 + 2 items，无拆分、无丢失
    // legacy 是单个 opaque unit（同一卡内两行都在）
    const legacyCard = listCards().find((c) => (c.textContent || "").includes("旧式段落说明"));
    expect(legacyCard).toBeTruthy();
    expect(legacyCard.textContent).toContain("第二行内容");
    // 新在前：items 在前（物理尾部在前）、legacy 整段殿后（倒序整段移动，不拆行）
    expectCardOrder([B1, A1, "旧式段落说明"]);
    setDir("oldest");
    expectCardOrder(["旧式段落说明", A1, B1]);
    // 纯展示：零 PUT → lane 字节不变
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("I: 简单 fork carry 后 lane（carried items + legacy）→ 正/倒序均无破坏、parse round-trip 稳定", async () => {
    // carried items 的 capture-origin 是父会话（fork 继承语义），但展示仍按当前 lane
    // 文件位置（物理序）——排序不读来源/不建跨会话时间模型。
    const body = "（从父分支继承的便签）\n\n" + [plain("carried-A", PARENT), plain("carried-B", PARENT), plain("carried-C", PARENT)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    expect(parseLaneBody(body).nodes.map((n) => (n.type === "item" ? n.item.captureOrigin : null)))
      .toEqual([null, PARENT, PARENT, PARENT]); // carried 项保留父会话 origin（未被触碰）
    expectCardOrder(["carried-C", "carried-B", "carried-A", "（从父分支继承的便签）"]);
    setDir("oldest");
    expectCardOrder(["（从父分支继承的便签）", "carried-A", "carried-B", "carried-C"]);
    setDir("newest");
    expectCardOrder(["carried-C", "carried-B", "carried-A", "（从父分支继承的便签）"]);
    // 无任何写：carried lane 未被 reorder/rewrite
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("J: conflict-merge lane（## 来自父分支 … --- … ## 当前分支已有内容）→ select 隐藏、仅正序、标记 intact、无 PUT、无 chronology 伪造", async () => {
    // 与 host 实际落盘同构：composeCarryMerge 两侧非空产物（fork/carry eligibility decision 自有标记）。
    const parentContent = "父分支便签内容\n\n" + plain("父P1");
    const childContent = plain("子C1");
    const body = composeCarryMerge(parentContent, childContent);
    expect(body).toContain("## 来自父分支");
    expect(body).toContain("## 当前分支已有内容");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    // fork-merge lane：select 隐藏（正序即唯一安全展示，不提供倒序开关）
    expect(viewDirSelect()).toBeNull();
    // 展示顺序 = 物理顺序（parse node 序）：父分支标记 → 父内容 → 子分支标记 → 子内容
    expectCardOrder(["## 来自父分支", "父P1", "## 当前分支已有内容", "子C1"]);
    // 标记 intact（列表以 legacy 段落原样呈现，不丢不拆不改写）
    const listText = notesList().textContent;
    expect(listText).toContain("## 来自父分支");
    expect(listText).toContain("## 当前分支已有内容");
    expect(listText).toContain("父P1");
    expect(listText).toContain("子C1");
    // 无 chronology 伪造：即使内部默认 viewDir 为 newest，也绝不倒序（物理序恒等展示）
    expect(listCards().length).toBe(4);
    const phys = parseLaneBody(body).nodes;
    const physFrags = phys.map((n) =>
      n.type === "legacy"
        ? (n.text.includes("## 来自父分支") ? "## 来自父分支" : "## 当前分支已有内容")
        : String(n.item.comment ?? ""));
    expectCardOrder(physFrags); // DOM 序 == 物理 node 序（无任何反转）
    // 零写
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("J2: 只有一个 fork marker 不误判为完整 merge lane", async () => {
    // 只有一侧标题不是 composeCarryMerge 的完整双侧 merge wrapper；不要把
    // 普通/legacy 内容错误降级为仅正序。完整 wrapper 仍由 J 覆盖。
    const body = "## 来自父分支\n\n" + plain("单侧 marker 后的内容");
    const { putBodies } = installLaneFetch({ body });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(viewDirSelect()).toBeTruthy();
    expect(viewDirSelect().value).toBe("newest");
    setDir("oldest");
    expect(viewDirSelect().value).toBe("oldest");
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("K: empty / single lane → 排序控件存在但无卡片可排；双向切换不炸、零写", async () => {
    // empty lane：无 item → 空态提示；select 仍渲染（非 fork-merge）但无可排内容
    const e1 = installLaneFetch({ body: "" });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/还没有便签/)).toBeTruthy());
    expect(viewDirSelect()).toBeTruthy();
    expect(viewDirSelect().value).toBe("newest");
    // 空态没有 item 卡（无任何 编辑/删除…/回来源 动作按钮；空态提示 div 不是卡）
    expect(listCards().some((el) => (el.textContent || "").includes("编辑") || (el.textContent || "").includes("删除…"))).toBe(false);
    setDir("oldest"); // 空 lane 切换不炸
    expect(listCards().some((el) => (el.textContent || "").includes("编辑") || (el.textContent || "").includes("删除…"))).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(e1.putBodies.length).toBe(0);
    cleanup();

    // single lane：1 条 → 新/旧两向都恒等单卡（reverse([x]) === [x]），零写
    const e2 = installLaneFetch({ body: plain(A1) });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(viewDirSelect().value).toBe("newest");
    expectCardOrder([A1]);
    setDir("oldest");
    expectCardOrder([A1]);
    setDir("newest");
    expectCardOrder([A1]);
    await new Promise((r) => setTimeout(r, 20));
    expect(e2.putBodies.length).toBe(0);
  });

  it("L: 倒序（newest-first）下 ↪回来源 仍按物理 item 锚定（DOM 序 ≠ 物理序不误导 dereference）", async () => {
    // 物理序：item0（eventSeq 7 的 anchor）→ item1（eventSeq 33 的 anchor）。
    // 默认新在前 → DOM 序 [item1, item0]：物理首条渲染在**底部**。
    const P0 = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 0, end: 8 }] };
    const P1 = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 33, start: 2, end: 9 }] };
    const item0 = serializeItem(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: "SOURCE-A", comment: "物理首条-A", sourcePayload: P0 }));
    const item1 = serializeItem(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: "SOURCE-BB", comment: "物理次条-B", sourcePayload: P1 }));
    const body = [item0, item1].join("\n\n");
    let reentryBody = null;
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/notes-api/reentry")) {
        const parsed = JSON.parse(opts.body);
        reentryBody = parsed;
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            ok: true, status: "exact", sameSession: true, contextWindow: 2,
            exact: {
              sessionId: parsed.locator.sessionId, projectionVersion: parsed.locator.projectionVersion,
              segments: parsed.locator.segments, text: "SOURCE-A",
              perSegment: [{ eventSeq: 7, start: 0, end: 8, text: "SOURCE-A", hint: { eventSeq: 7, messageId: "m-7" } }],
            },
            context: { perEvent: [] },
          }),
        });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(body, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    const { apply } = loader.factory((id) => {
      if (id === "react") return React;
      throw new Error(`unexpected require: ${id}`);
    });
    let registered = null;
    const ctx = {
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    apply(ctx, React);
    const Component = registered.Component;
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    // 默认新在前：DOM 序 = [物理次条-B(顶), 物理首条-A(底)]
    expect(viewDirSelect().value).toBe("newest");
    expectCardOrder(["物理次条-B", "物理首条-A"]);
    // 点**物理首条**（DOM 底部那张）的 ↪回来源 → dereference 必须携带它自己的 P0 locator，
    // 不是 DOM 顶部那张的 P1（回跳按物理 item 锚定，不受倒序展示影响）
    fireEvent.click(within(cardOf("物理首条-A")).getByRole("button", { name: "↪ 回来源" }));
    await waitFor(() => expect(reentryBody).toBeTruthy(), { timeout: 3000 });
    expect(reentryBody.locator.segments).toEqual(P0.segments);
    expect(reentryBody.locator.segments).not.toEqual(P1.segments);
    expect(reentryBody.consent).toBe("per-request");
    const puts = fetchFn.mock.calls.filter((c) => String(c[0]).includes("/notes-api/") && c[1]?.method === "PUT");
    expect(puts.length).toBe(0);
    view.unmount();
    cleanup();
  });
});

describe("behavior regression persistent Note Pin (holder-local)", () => {
  const PAYLOAD_D = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 0, end: 8 }] };
  const SNAP_D = "SOURCE-A";
  const pinPlain = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
  const pinAware = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: SNAP_D, comment, sourcePayload: PAYLOAD_D }), key));
  const k = (tag) => `ik-test-${tag}-${Math.random().toString(36).slice(2, 8)}`;

  // （behavior regression describe 的闭包 helper 不可见——此处重建同构 helpers。）
  const noteListEl = () => document.querySelector("[data-notes-list]");
  const notesList = () => document.querySelector("[data-notes-list]");
  const viewDirSelect = () => document.querySelector("[data-view-dir]");
  const noteCards = () => [...noteListEl().querySelectorAll(":scope > div")].slice(1);
  const composerInput = () => screen.getByPlaceholderText(/可留空，以后再补/);
  const installLaneFetch = ({ body = "", lanes, onPut } = {}) => {
    const putBodies = [];
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (opts?.method === "PUT") {
        putBodies.push(String(opts.body ?? ""));
        if (onPut) onPut(String(opts.body ?? ""));
        return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      }
      const key = decodeURIComponent(url.split("/").pop() || "");
      const laneBody = lanes ? lanes[key] ?? "" : body;
      return Promise.resolve(makeResponse(laneBody, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    return { fetchFn, putBodies };
  };
  const setDir = (value) => {
    fireEvent.change(viewDirSelect(), { target: { value } });
    expect(viewDirSelect().value).toBe(value);
  };
  const btnInCard = (frag, name) => {
    const card = noteCards().find((el) => (el.textContent || "").includes(frag));
    expect(card, `card containing ${frag}`).toBeTruthy();
    const b = [...card.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === name);
    expect(b, `button ${name} in card ${frag}`).toBeTruthy();
    return b;
  };
  const clearPins = () => { window.localStorage.removeItem("dsh.collab-notes.pins.v1"); };
  const storePins = (keys, sid = SESSION, lane = "conversation_todo") => {
    window.localStorage.setItem("dsh.collab-notes.pins.v1", JSON.stringify({ 1: { [sid]: { [lane]: Object.fromEntries([...keys].map((x) => [x, true])) } } }));
  };
  const readStored = (sid = SESSION, lane = "conversation_todo") => {
    try {
      const r = JSON.parse(window.localStorage.getItem("dsh.collab-notes.pins.v1") || "{}");
      const m = r?.[1]?.[sid]?.[lane] ?? {};
      return new Set(Object.keys(m).filter((x) => m[x] === true));
    } catch { return new Set(); }
  };

  // happy-dom localStorage 在套件中途会失效——behavior regression 全部用自备 in-memory stub，
  // 与真实 browser 的同一 localStorage 接口（getItem/setItem/removeItem）一致。
  let lsOrig = null;
  const makeLsStub = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(k); },
      clear: () => { m.clear(); },
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
      __map: m,
    };
  };
  beforeEach(() => {
    lsOrig = window.localStorage;
    const stub = makeLsStub();
    Object.defineProperty(window, "localStorage", { configurable: true, value: stub });
  });
  afterEach(() => {
    if (lsOrig) Object.defineProperty(window, "localStorage", { configurable: true, value: lsOrig });
    lsOrig = null;
  });

  it("A/B/C: source-independent / anchored / comment-free anchored 都能置顶并取消；pinned 卡置顶 group、普通卡 normal group", async () => {
    const k1 = k("a"); const k2 = k("b"); const k3 = k("c");
    const body = [pinPlain("普通便签A", k1), pinAware("带来源便签B", k2), pinAware("", k3)].join("\n\n");
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    // 无 pin → 无置顶 group header（data-pin-group 区分 button 文案与 header）
    expect(document.querySelector('[data-pin-group]')).toBeNull();
    // 置顶 B（anchored）
    fireEvent.click(btnInCard("带来源便签B", "置顶"));
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    // 置顶 A（source-independent）与 comment-free C
    fireEvent.click(btnInCard("普通便签A", "置顶"));
    fireEvent.click(btnInCard("[空便签——之后可补写]", "置顶"));
    await waitFor(() => expect(screen.getAllByText("取消置顶").length).toBe(3));
    // 置顶 group 在前：pinned header 先于 normal header
    const headOrder = [...document.querySelectorAll("[data-pin-group]")].map((el) => el.getAttribute("data-pin-group"));
    expect(headOrder[0]).toBe("pinned");
    expect(headOrder[1]).toBe("normal");
    // 零 durable write（pin 只写 localStorage）
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
    // localStorage 持久化
    expect(readStored().size).toBe(3);
    // 取消 B → 回普通 group
    fireEvent.click(btnInCard("带来源便签B", "取消置顶"));
    await waitFor(() => expect(screen.getAllByText("取消置顶").length).toBe(2));
    expect(readStored().size).toBe(2);
  });

  it("D/E: pinned + normal 两 group 都遵循 behavior regression view direction", async () => {
    const k1 = k("1"); const k2 = k("2"); const k3 = k("3"); const k4 = k("4");
    const A1 = "AAA（旧）"; const B1 = "BBB"; const C1 = "CCC"; const D1 = "DDD（新）";
    const body = [pinPlain(A1, k1), pinPlain(B1, k2), pinPlain(C1, k3), pinPlain(D1, k4)].join("\n\n");
    storePins(new Set([k2, k4])); // pin B & D
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*4/)).toBeTruthy());
    // newest-first：物理 A B C D → 视图 D C B A；pinned 组（D,B 按视图序）= D B；normal = C A
    const cardTexts = () => noteCards().map((el) => (el.textContent || "").trim());
    const pos = (f) => cardTexts().findIndex((t) => t.includes(f));
    // newest-first：pinned 组（视图序 D B）在 normal 组（视图序 C A）之前
    expect(pos("DDD（新）") < pos("BBB")).toBe(true);
    expect(pos("BBB") < pos("CCC")).toBe(true);
    expect(pos("CCC") < pos("AAA（旧）")).toBe(true);
    // 切 oldest：pinned 组（物理序 B D）仍在 normal 组之前，组内顺序翻转
    setDir("oldest");
    expect(pos("BBB") < pos("DDD（新）")).toBe(true);
    expect(pos("DDD（新）") < pos("AAA（旧）")).toBe(true);
    expect(pos("AAA（旧）") < pos("CCC")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("F: pinned Note ordinary edit → 仍 pinned（key 保留）", async () => {
    const k1 = k("edit"); const k2 = k("other");
    const body = [pinPlain("原评论", k1), pinPlain("其它", k2)].join("\n\n");
    storePins(new Set([k1]));
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    expect(screen.getByText("取消置顶")).toBeTruthy();
    fireEvent.click(btnInCard("原评论", "编辑"));
    expect(composerInput().value).toBe("原评论");
    fireEvent.change(composerInput(), { target: { value: "改后评论" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(screen.getByText("改后评论")).toBeTruthy());
    // edit 后仍 pinned（key 保留 → 取消置顶 按钮仍在）
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    const edited = parseLaneBody(putBodies[0]).nodes.find((n) => n.type === "item" && n.item.comment === "改后评论");
    expect(getItemKey(edited.item)).toBe(k1); // key 不变
    expect(readStored().has(k1)).toBe(true);
  });

  it("G: pinned Note 删除 → 消失、无 ghost/rebind；其它 Note 不被 pin", async () => {
    const k1 = k("del"); const k2 = k("keep");
    const body = [pinPlain("要删的", k1), pinPlain("留下的", k2)].join("\n\n");
    storePins(new Set([k1])); // 只 pin 要删的那条
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    fireEvent.click(btnInCard("要删的", "删除…"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.queryByText("要删的")).toBeNull();
    // 留下的便签不因 stale k1 变 pinned；无 ghost 置顶
    expect(screen.queryByText("取消置顶")).toBeNull();
    expect(btnInCard("留下的", "置顶")).toBeTruthy();
  });

  it("I/J/K: panel close/reopen、reload（remount）、同一 conversation resume → pin 保持", async () => {
    const k1 = k("persist");
    const body = pinPlain("持久便签", k1);
    storePins(new Set([k1]));
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    // close → reopen（同一 mount 内 toggle off/on = remount）
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.queryByText("取消置顶")).toBeNull());
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    // “reload”语义：组件重挂（localStorage 仍在）
    cleanup();
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("L: cross-session 隔离——同 lane 同 itemKey 不同 sessionId 不互相 pinned", async () => {
    const k1 = k("iso");
    const body = pinPlain("会话A的便签", k1);
    storePins(new Set([k1]), "session-test-0001-0001");
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel(); // mount 用 SESSION = session-test-0001-0001
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    // 换 sessionId 渲染同一 lane body → pin map 用新 session → 不 pinned
    cleanup();
    storePins(new Set(), "session-other-0002-0002");
    const { apply } = loader.factory((id) => (id === "react" ? React : (() => { throw new Error("x"); })()));
    let reg = null;
    apply({ slots: { inject: (_n, fn) => { reg = fn(); }, register: (cfg, Component) => ({ cfg, Component }) } }, React);
    const view = render(React.createElement(reg.Component, { sessionId: "session-other-0002-0002" }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.queryByText("取消置顶")).toBeNull();
    expect(screen.getByText("置顶")).toBeTruthy();
    view.unmount(); cleanup();
  });

  it("M: ordinary fork（空 child carry）不传播 parent Pin——child 拿到新 key 且 unpinned", async () => {
    const kParent = k("parent");
    const parentBody = pinPlain("carried note", kParent);
    // fork/apply 是 host 行为（carry 已测 byte-copy + behavior regression rekey）；此处验证 UI 端：
    // child lane 文本若同内容但不同 key（模拟 rekey 后 child 文件），pin map 按
    // (childSession, key) → child unpinned、parent 仍 pinned。
    storePins(new Set([kParent]), SESSION); // parent holder
    const childKey = k("child");
    const childBody = pinPlain("carried note", childKey);
    const lanes = { conversation_todo: childBody };
    const { putBodies } = installLaneFetch({ lanes });
    // 用 child sessionId 打开（fork child holder）
    const { apply } = loader.factory((id) => (id === "react" ? React : (() => { throw new Error("x"); })()));
    let reg = null;
    apply({ slots: { inject: (_n, fn) => { reg = fn(); }, register: (cfg, Component) => ({ cfg, Component }) } }, React);
    const view = render(React.createElement(reg.Component, { sessionId: "session-child-0003-0003" }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.queryByText("取消置顶")).toBeNull(); // child unpinned
    expect(screen.getByText("置顶")).toBeTruthy();
    view.unmount(); cleanup();
    // parent holder 仍 pinned（stale check）
    expect(readStored(SESSION).has(kParent)).toBe(true);
  });

  it("N: occupied merge-wrapper lane → pin affordance unavailable（不显示 置顶 按钮）", async () => {
    const parentContent = "父分支便签内容\n\n" + pinPlain("父P1", k("p1"));
    const childContent = pinPlain("子C1", k("c1"));
    const body = composeCarryMerge(parentContent, childContent);
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    expect(screen.queryByText("置顶")).toBeNull(); // 无 pin 按钮（wrapper lane 恒 normal 组）
    expect(screen.queryByText("取消置顶")).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("O: legacy opaque item → 无 pin 按钮（identity substrate 不支持）", async () => {
    const body = "旧式自由文本段落\n\n" + pinPlain("新便签", k("leg"));
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getAllByText("新便签").length).toBeGreaterThan(0));
    const legacyCard = noteCards().find((el) => (el.textContent || "").includes("旧式自由文本"));
    expect(legacyCard).toBeTruthy();
    expect([...legacyCard.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "置顶")).toBe(false);
    expect(btnInCard("新便签", "置顶")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("P: Pin-only 操作不写 lane body（零 PUT）；localStorage write 失败 → truthful", async () => {
    const k1 = k("nowrite");
    const body = pinPlain("内容", k1);
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("置顶")).toBeTruthy());
    // 模拟 localStorage 写失败（quota/异常）
    const orig = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => { throw new Error("quota"); };
    fireEvent.click(screen.getByText("置顶"));
    await waitFor(() => expect(screen.getByText(/置顶未保存/)).toBeTruthy());
    window.localStorage.setItem = orig;
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0); // durable 写从未发生（已 keyed → 只尝试 local）
    expect(screen.queryByText("取消置顶")).toBeNull(); // 未成功 → 未置顶
  });

  it("Q: 无 priority/authority side-effect——pin 后 lane 字节不变、authored/source 不变、无新 meta 语义暴露", async () => {
    const k1 = k("q");
    const body = pinPlain("便签内容", k1);
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("置顶")).toBeTruthy());
    fireEvent.click(screen.getByText("置顶"));
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    // UI 不暴露 item-key/pinned 框架（只显示 取消置顶 按钮；无 dsh-meta/source-payload）
    const listText = noteListEl().textContent;
    expect(listText).not.toContain("dsh-meta");
    expect(listText).not.toContain("item-key");
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0);
  });

  it("first-pin migration：无 key 旧 item 首次置顶 → 先 durable key write（PUT）成功才 pin；失败无 pin entry", async () => {
    // 旧 item（无 item-key）
    const body = serializeItem(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "旧便签" }));
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    expect(screen.getByText("置顶")).toBeTruthy();
    fireEvent.click(screen.getByText("置顶"));
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    // PUT body = 旧便签 + item-key（identity-only：content/order 不变）
    const putBody = putBodies[0];
    const parsed = parseLaneBody(putBody).nodes;
    expect(parsed.length).toBe(1);
    expect(parsed[0].item.comment).toBe("旧便签");
    const addedKey = getItemKey(parsed[0].item);
    expect(typeof addedKey).toBe("string");
    // durable write 成功后 → pin 成立（取消置顶 出现）
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    expect(readStored().has(addedKey)).toBe(true);
  });
  it("test-1: localStorage 不可用（缺失）→ Pin 不误报成功（如实报未保存）", async () => {
    const k1 = k("missing-ls");
    const body = pinPlain("内容", k1);
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("置顶")).toBeTruthy());
    // 模拟 window.localStorage 缺失（security/隐私模式）：属性删除
    const desc = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, value: undefined });
    fireEvent.click(screen.getByText("置顶"));
    await waitFor(() => expect(screen.getByText(/置顶未保存/)).toBeTruthy());
    Object.defineProperty(window, "localStorage", desc);
    expect(screen.queryByText("取消置顶")).toBeNull(); // 未误报成功
    await new Promise((r) => setTimeout(r, 20));
    expect(putBodies.length).toBe(0); // 已 keyed → 只尝试 local；绝不因 storage 缺失写 lane
  });

  it("test-2: sibling insert/delete 不误绑——Pin B → 插入 A(前)/C(后) → B 仍 pinned；删 sibling 仍 pinned", async () => {
    const kB = k("b");
    const body0 = pinPlain("B便签", kB);
    const { putBodies } = installLaneFetch({ body: body0 });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*1/)).toBeTruthy());
    fireEvent.click(screen.getByText("置顶"));
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    // “插入”= 另一写入方（agent/raw editor）在 B 前/后加了新 item；B 的 itemKey 行不变
    const A1 = pinPlain("A前插", k("a"));
    const C1 = pinPlain("C后插", k("c"));
    const body1 = A1 + "\n\n" + body0 + "\n\n" + C1;
    // 模拟 GET 刷新返回新 body（fetch 再次返回 body1）
    const fetchFn = vi.fn((_u, opts) => {
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse(body1, { mtime: "3333" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    fireEvent.click(screen.getByTitle("刷新（重新加载本层）"));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    // B 仍 pinned（按 itemKey，非 index）；A/C 无 key → 不是 pinned
    const bCard = noteCards().find((el) => (el.textContent || "").includes("B便签"));
    expect(bCard).toBeTruthy();
    expect([...bCard.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "取消置顶")).toBe(true);
    const aCard = noteCards().find((el) => (el.textContent || "").includes("A前插"));
    expect([...aCard.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "置顶")).toBe(true);
    // 删除 sibling A → B 仍 pinned（不 rebind 到 C）
    fireEvent.click(btnInCard("A前插", "删除…"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    const bCard2 = noteCards().find((el) => (el.textContent || "").includes("B便签"));
    expect([...bCard2.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "取消置顶")).toBe(true);
    const cCard = noteCards().find((el) => (el.textContent || "").includes("C后插"));
    expect([...cCard.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "取消置顶")).toBe(false);
  });

  it("test-3a: keyless first-pin——durable key write 成功 + localStorage 写失败 → 如实报未保存（无成功 UI）", async () => {
    const body = serializeItem(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "旧便签" }));
    const { putBodies } = installLaneFetch({ body });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("置顶")).toBeTruthy());
    // localStorage.setItem 抛错（写失败）
    const orig = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => { throw new Error("quota"); };
    fireEvent.click(screen.getByText("置顶"));
    // durable key migration PUT 应发生（key 写成功）
    await waitFor(() => expect(putBodies.length).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText(/置顶未保存/)).toBeTruthy()); // 两种 truthful 文案共享“未保存”
    window.localStorage.setItem = orig;
    // 无成功状态、无 取消置顶
    expect(screen.queryByText("已置顶")).toBeNull();
    expect(screen.queryByText("取消置顶")).toBeNull();
    // 但 key 已 durable 落盘（无害 neutral）——PUT body 含 item-key
    expect(typeof getItemKey(parseLaneBody(putBodies[0]).nodes[0].item)).toBe("string");
  });

  it("test-3b: keyless first-pin——durable key PUT 失败（409）→ 不产生 Pin entry、无成功状态", async () => {
    const body = serializeItem(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "旧便签B" }));
    // PUT 返回 409（他人已改）→ doPut 走 conflict triage → 不写 Pin
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("latest", { status: 409, mtime: "9999" }));
      return Promise.resolve(makeResponse(body, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("置顶")).toBeTruthy());
    fireEvent.click(screen.getByText("置顶"));
    await waitFor(() => expect(screen.getAllByText(/已被其它方修改/).length).toBeGreaterThan(0));
    expect(screen.queryByText("取消置顶")).toBeNull();
    expect(readStored().size).toBe(0); // 无 pin entry
    expect(screen.queryByText(/已置顶/)).toBeNull();
  });

});

describe("behavior regression current-holder keyword search", () => {
  // behavior regression describe 的 localStorage stub 是 describe 局部；此处自备同款 in-memory stub。
  let lsOrigE = null;
  const makeLsE = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(k); },
      clear: () => { m.clear(); },
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  };
  beforeEach(() => {
    lsOrigE = window.localStorage;
    Object.defineProperty(window, "localStorage", { configurable: true, value: makeLsE() });
  });
  afterEach(() => {
    if (lsOrigE) Object.defineProperty(window, "localStorage", { configurable: true, value: lsOrigE });
    lsOrigE = null;
  });

  const PAYLOAD_E = { projectionVersion: 1, sessionId: SESSION, segments: [{ eventSeq: 7, start: 0, end: 8 }] };
  const SNAP_E = "SOURCE-ALPHA";
  const plainE = (c, o = SESSION) => serializeItem(makeItem({ kind: "source-independent", captureOrigin: o, comment: c }));
  const awareE = (c) => serializeItem(makeItem({ kind: "source-aware", captureOrigin: SESSION, snapshot: SNAP_E, comment: c, sourcePayload: PAYLOAD_E }));
  const noteListElE = () => document.querySelector("[data-notes-list]");
  const viewDirSelectE = () => document.querySelector("[data-view-dir]");
  const setDirE = (v) => { fireEvent.change(viewDirSelectE(), { target: { value: v } }); expect(viewDirSelectE().value).toBe(v); };
  // behavior regression CORR：按 lane 预置 holder-local Pin（{laneKey: [itemKey...]}），读取同构。
  const storePinsE = (keysByLane, sid = SESSION) => {
    const holder = {};
    for (const [laneKey, keys] of Object.entries(keysByLane)) {
      holder[laneKey] = Object.fromEntries(keys.map((k) => [k, true]));
    }
    window.localStorage.setItem("dsh.collab-notes.pins.v1", JSON.stringify({ 1: { [sid]: holder } }));
  };
  const readPinsE = (laneKey, sid = SESSION) => {
    try {
      const r = JSON.parse(window.localStorage.getItem("dsh.collab-notes.pins.v1") || "{}");
      const m = r?.[1]?.[sid]?.[laneKey] ?? {};
      return new Set(Object.keys(m).filter((x) => m[x] === true));
    } catch { return new Set(); }
  };
  // lane-keyed GET/PUT mock：GET 按 layer 返回；PUT 收集
  const installLaneFetchE = ({ lanes, onPut } = {}) => {
    const putBodies = [];
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (opts?.method === "PUT") { putBodies.push(String(opts.body ?? "")); if (onPut) onPut(String(opts.body ?? "")); return Promise.resolve(makeResponse("ok", { mtime: "2222" })); }
      const key = decodeURIComponent(url.split("/").pop() || "");
      return Promise.resolve(makeResponse(lanes ? lanes[key] ?? "" : "", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    return { fetchFn, putBodies };
  };
  const openSearchE = async () => {
    fireEvent.click(screen.getByRole("button", { name: "搜索便签" }));
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeTruthy());
  };
  const typeQueryE = async (q) => {
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: q } });
    // debounce 300ms → 等 fetch 完成（结果区出现或 busy 结束）
    await waitFor(() => expect(document.body.innerText.includes("匹配") || document.body.innerText.includes("没有找到匹配")).toBeTruthy(), { timeout: 2000 });
  };
  const resultCardsE = () => [...document.querySelectorAll('[data-search-result]')];

  it("A: empty query → normal Notes view（searchOpen 时 query 空仍显示普通列表/composer）", async () => {
    const body = plainE("AAA普通便签");
    installLaneFetchE({ lanes: { conversation_todo: body } });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("AAA普通便签")).toBeTruthy());
    await openSearchE();
    // 空 query：composer 与 notes-list 仍在（normal view）
    expect(screen.getByText("新便签")).toBeTruthy();
    expect(noteListElE()).toBeTruthy();
    expect(screen.getByText("AAA普通便签")).toBeTruthy();
  });

  it("structured search 的 composed lane title 只包含一次 displayId", async () => {
    installLaneFetchE({ lanes: { conversation_todo: plainE("search-title-once") } });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("search-title-once");
    const card = resultCardsE()[0];
    const text = card.textContent || "";
    expect(text).toContain("L1 会话待办");
    expect(text).not.toContain("L1 会话待办 · L1");
    expect(text).not.toContain("L1 L1 会话待办");
    expect((text.match(/L1/g) || []).length).toBe(1);
  });

  it("B/C/D/E: authored-content / anchored-authored / Source-snapshot / comment-free Source-snapshot 都能命中 whole Note", async () => {
    const lanes = {
      conversation_todo: [plainE("便签内含 keywordBeta"), awareE("带来源正文 keywordGamma")].join("\n\n"),
      deferred_work: [awareE("")].join("\n\n"), // comment-free anchored
    };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("keywordBeta");
    // B: source-independent authored 命中
    expect(resultCardsE().some((c) => (c.textContent || "").includes("keywordBeta"))).toBe(true);
    // C: anchored authored 命中（换 query 前先清空再输入新 query）
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "" } });
    await new Promise((r) => setTimeout(r, 50));
    await typeQueryE("keywordGamma");
    expect(resultCardsE().some((c) => (c.textContent || "").includes("keywordGamma"))).toBe(true);
    // D: Source snapshot（SNAP_E）命中 anchored
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "" } });
    await new Promise((r) => setTimeout(r, 50));
    await typeQueryE("SOURCE-ALPHA");
    const anchoredHits = resultCardsE();
    expect(anchoredHits.some((c) => (c.textContent || "").includes("带来源便签"))).toBe(true);
    // E: comment-free anchored（deferred_work）经 Source snapshot 命中
    expect(anchoredHits.some((c) => (c.textContent || "").includes("L2 延后工作") && (c.textContent || "").includes("SOURCE-ALPHA"))).toBe(true);
  });

  it("F/G/H: machine metadata（item-key/captureOrigin/locator/framing）不命中", async () => {
    const keyed = serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: "session-other-9999", comment: "人话正文" }), "ik-hiddenkey"));
    const lanes = { conversation_todo: keyed };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    // 搜 authored 应命中（对照：machine 不参与不代表正文不可搜）
    await typeQueryE("人话正文");
    expect(resultCardsE().length).toBe(1);
    // 搜 item-key / captureOrigin / locator session / framing → 0 命中
    for (const q of ["ik-hiddenkey", "session-other-9999", "source-aware", "dsh-meta", "projectionVersion", "dsh-note"]) {
      fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: q } });
      await waitFor(() => expect(document.body.innerText.includes("没有找到匹配的便签")).toBeTruthy(), { timeout: 2000 });
      expect(resultCardsE().length, `query=${q}`).toBe(0);
    }
  });

  it("I/J/K: 跨 lane 命中 + 每 lane 组内 behavior regression view semantics", async () => {
    const lanes = {
      conversation_todo: [plainE("L1-老 keywordX"), plainE("L1-新 keywordX")].join("\n\n"),
      deferred_work: plainE("L2 也有 keywordX"),
      lesson_candidate: plainE("L4 keywordX"),
    };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("keywordX");
    const cards = resultCardsE();
    // 跨 lane：L1 + L2 + L4 都出现
    const all = cards.map((c) => (c.textContent || "")).join("\n");
    expect(all.includes("L1 会话待办")).toBe(true);
    expect(all.includes("L2 延后工作")).toBe(true);
    expect(all.includes("L4 复盘素材")).toBe(true);
    // 默认 newest-first：L1 组内 新 在 老 前（renderSearchRow 按 viewDir 反转后的顺序）
    const l1Texts = cards.filter((c) => (c.textContent || "").includes("L1 会话待办")).map((c) => c.textContent || "");
    const iNew = l1Texts.findIndex((t) => t.includes("L1-新"));
    const iOld = l1Texts.findIndex((t) => t.includes("L1-老"));
    expect(iNew).toBeGreaterThan(-1); expect(iOld).toBeGreaterThan(-1); expect(iNew).toBeLessThan(iOld);
  });

  it("L/M: search 不改 Pin——pinned Note 命中仍 Pin-semantic only；换 query 不 mutate Pin", async () => {
    const keyB = "ik-pinB";
    const lanes = { conversation_todo: serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "已置顶便签 xyz" }), keyB)) };
    window.localStorage.setItem("dsh.collab-notes.pins.v1", JSON.stringify({ 1: { [SESSION]: { conversation_todo: { [keyB]: true } } } }));
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy());
    await openSearchE();
    await typeQueryE("xyz");
    const cards = resultCardsE();
    expect(cards.some((c) => (c.textContent || "").includes("已置顶便签 xyz"))).toBe(true);
    // search 不改 Pin：localStorage 仍 pinned
    const stored = JSON.parse(window.localStorage.getItem("dsh.collab-notes.pins.v1"));
    expect(stored[1][SESSION].conversation_todo[keyB]).toBe(true);
    // 换 query → Pin 不变
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "不存在词" } });
    await waitFor(() => expect(document.body.innerText.includes("没有找到匹配的便签")).toBeTruthy(), { timeout: 2000 });
    const stored2 = JSON.parse(window.localStorage.getItem("dsh.collab-notes.pins.v1"));
    expect(stored2[1][SESSION].conversation_todo[keyB]).toBe(true);
  });

  it("N: search 不 rewrite Notes（零 PUT）", async () => {
    const lanes = { conversation_todo: plainE("可搜内容 abc") };
    const { putBodies } = installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("abc");
    await typeQueryE("没这个词");
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(putBodies.length).toBe(0);
  });

  it("O/P: search result edit/Pin → 切到该 lane 并以 stable identity 定位正确原 Note", async () => {
    const keyT = "ik-target";
    const lanes = {
      conversation_todo: [plainE("L1 干扰"), serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "目标便签 searchTarget" }), keyT))].join("\n\n"),
    };
    const { putBodies } = installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("searchTarget");
    const card = resultCardsE().find((c) => (c.textContent || "").includes("searchTarget"));
    expect(card).toBeTruthy();
    // edit：点 result 的 编辑 → 跳回 lane（close search）→ inline 编辑展开（composer textarea 值=原文）
    const editBtn = [...card.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "编辑");
    fireEvent.click(editBtn);
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeNull());
    await waitFor(() => expect(screen.getByDisplayValue("目标便签 searchTarget")).toBeTruthy(), { timeout: 3000 });
    // 取消编辑（不写）
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    // pin：从 result 置顶 → jump → 该 lane active → 取消置顶 出现（keyed 直写）
    await openSearchE();
    await typeQueryE("searchTarget");
    const card2 = resultCardsE().find((c) => (c.textContent || "").includes("searchTarget"));
    const pinBtn = [...card2.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "置顶");
    fireEvent.click(pinBtn);
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeNull());
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy(), { timeout: 3000 });
    expect(putBodies.length).toBe(0); // keyed pin 零 PUT
  });

  it("Q: duplicate-content Notes remain distinct whole-Note results", async () => {
    const dup = "完全相同的内容 dupX";
    const lanes = { conversation_todo: [plainE(dup), plainE(dup)].join("\n\n") };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("dupX");
    expect(resultCardsE().length).toBe(2); // 两条独立 whole-Note 结果
  });

  it("R: no-result state（非空 query 0 命中 → 显式无结果，不静默显示全部）", async () => {
    installLaneFetchE({ lanes: { conversation_todo: plainE("只此一条") } });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("完全不存在");
    expect(document.body.innerText.includes("没有找到匹配的便签")).toBe(true);
    expect(resultCardsE().length).toBe(0);
  });

  it("S: legacy disposition——legacy opaque unit 作为整体可命中；不拆分；无操作按钮", async () => {
    const lanes = { conversation_todo: "旧式自由文本 legacyText段落\n多行内容\n\n" + plainE("结构化便签") };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("legacyText");
    const cards = resultCardsE();
    expect(cards.length).toBe(1); // 整段 legacy 为一条 whole-unit 结果
    expect(cards[0].textContent.includes("旧式自由文本")).toBe(true);
    // legacy result 无编辑按钮（renderSearchRow 只对 item 提供动作）
    expect([...cards[0].querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "编辑")).toBe(false);
  });

  it("T: occupied merge-wrapper lane → search 命中 structured 便签但恒正序（不伪造跨 branch chronology）", async () => {
    const p1 = plainE("父侧便签 mergeQ");
    const c1 = plainE("子侧便签 mergeQ");
    const body = composeCarryMerge("## 来自父分支\n\n" + p1, "## 当前分支已有内容\n\n" + c1);
    installLaneFetchE({ lanes: { conversation_todo: body } });
    mountPanel(); await openPanel();
    await openSearchE();
    await typeQueryE("mergeQ");
    const cards = resultCardsE();
    expect(cards.length).toBe(2); // 两条 structured 命中（wrapper 标题是 legacy，可能整体命中但此处 query 不含）
    const txts = cards.map((c) => c.textContent || "");
    // behavior regression adversarial-merge：即使搜索中把全局 viewDir 切到 oldest，merge-wrapper lane 仍为
    // group-preserving 正序（父侧分组在前、子侧分组在后）——不分配置顶分区、不倒序、
    // 绝不把该展示表述成普通 newest/oldest chronology。
    expect(txts.findIndex((t) => t.includes("父侧便签 mergeQ"))).toBeLessThan(txts.findIndex((t) => t.includes("子侧便签 mergeQ")));
    setDirE("oldest");
    await waitFor(() => {
      const t2 = resultCardsE().map((c) => c.textContent || "");
      expect(t2.findIndex((x) => x.includes("父侧便签 mergeQ"))).toBeLessThan(t2.findIndex((x) => x.includes("子侧便签 mergeQ")));
    }, { timeout: 2000 });
    expect(document.querySelector("[data-search-pin-group]")).toBeNull(); // merge wrapper 无 pin 分区
    // behavior regression test adversarial-02：merge-wrapper 的 Search result **不渲染** Pin affordance
    // （behavior regression merge Pin unavailable；可见但被 togglePin 忽略的按钮 = 误导 UI）
    const pinBtns = [...document.querySelectorAll("[data-search-result] button")].filter((b) => {
      const t = (b.textContent || "").trim();
      return t === "置顶" || t === "取消置顶";
    });
    expect(pinBtns.length).toBe(0);
    expect(document.querySelector('[data-search-result] [data-pin]')).toBeNull();
  });

  it("U: reasonable large-holder performance（合成 4 lanes × 60 notes ≈ 240 whole Notes）", async () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => plainE(`便签内容 number${i} 关键词`)).join("\n\n");
    const lanes = {
      conversation_todo: mk(60), deferred_work: mk(60), knowledge_candidate: mk(60), lesson_candidate: mk(60),
    };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await openSearchE();
    const t0 = Date.now();
    await typeQueryE("关键词");
    const elapsed = Date.now() - t0;
    expect(resultCardsE().length).toBe(240);
    // 宽松上界（含 debounce 300ms + parse/scan）；不建 index 的前提下 plain scan 足够
    expect(elapsed).toBeLessThan(4000);
  });

  it("adversarial-01: query race——先 A 后 B、A 响应晚到 → B 结果不被 A 覆盖（generation token）", async () => {
    // deferred per-query：conversation_todo GET 按 query 时间返回不同内容
    const resolvers = [];
    const lanesA = { conversation_todo: plainE("AAAA内容 alpha"), deferred_work: "" };
    const lanesB = { conversation_todo: plainE("BBBB内容 beta"), deferred_work: "" };
    let fetchIdx = 0;
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      if (url.includes("/notes-api/meta")) return Promise.resolve(makeResponse("", { mtime: "1" }));
      // 第 0 次 conversation_todo GET = openPanel 初始载入 → 立即返回（含 A 内容）
      if (url.endsWith("/conversation_todo")) {
        const idx = fetchIdx++;
        if (idx === 0) return Promise.resolve(makeResponse(lanesA.conversation_todo, { mtime: "1" }));
        // 搜索 GET（idx 1/2...）挂起，手动 resolve
        return new Promise((res) => resolvers.push({ idx, res }));
      }
      return Promise.resolve(makeResponse("", { mtime: "1" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel(); await openPanel();
    await openSearchE();
    // 输入 alpha（query A 的 GET 挂起）
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "alpha" } });
    await new Promise((r) => setTimeout(r, 450)); // debounce 已触发 A 请求
    // 输入 beta（query B 的 GET 挂起）
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "beta" } });
    await new Promise((r) => setTimeout(r, 450)); // B 请求已触发
    // 先 resolve A（旧）再 resolve B（新）——即使 A 晚到也不能覆盖 B
    const callA = resolvers.find((x) => x.idx === 1);
    const callB = resolvers.find((x) => x.idx === 2);
    callA.res(makeResponse(lanesA.conversation_todo, { mtime: "1" }));
    await new Promise((r) => setTimeout(r, 100));
    callB.res(makeResponse(lanesB.conversation_todo, { mtime: "1" }));
    await waitFor(() => expect(document.querySelectorAll("[data-search-result]").length).toBeGreaterThan(0), { timeout: 2000 });
    // 显示的是 B（beta）不是 A（alpha）
    const cards = [...document.querySelectorAll("[data-search-result]")].map((c) => (c.textContent || "").join ? "" : (c.textContent || ""));
    const all = document.body.innerText;
    expect(all.includes("BBBB内容 beta")).toBe(true);
    expect(all.includes("AAAA内容 alpha")).toBe(false); // 旧响应未覆盖
  });

  it("adversarial-02: keyless duplicate Note 定位——点第二条的 编辑 必须操作第二条（physIndex+sig 双确认）", async () => {
    // 两条 keyless、内容完全相同
    const corrDup = "完全相同的重复便签 corrDup";
    const dup = corrDup;
    const lanes = { conversation_todo: [plainE(dup), plainE(dup)].join("\n\n") };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getAllByText("完全相同的重复便签 corrDup").length).toBeGreaterThan(0));
    await openSearchE();
    await typeQueryE("corrDup");
    const cards = resultCardsE();
    expect(cards.length).toBe(2);
    // 点**第二条** result 的 编辑 → jump → active lane；定位 physIndex=1 的重复便签
    const editBtn = [...cards[1].querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "编辑");
    fireEvent.click(editBtn);
    // jump → 关闭搜索、切回 lane、inline edit 展开（第二条在物理 index 1 → DOM 位置第 2）
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeNull(), { timeout: 3000 });
    // 编辑目标应是对应 DOM 第二张卡（物理第二条）；两条内容相同无法靠文本区分 →
    // 通过“编辑的是 DOM 第二张卡”验证（编辑态只在该卡内出现 textarea）
    const cardsAfter = () => [...document.querySelectorAll('[data-notes-list] > div')].slice(1).filter((el) => (el.textContent || "").includes(corrDup));
    await waitFor(() => expect(cardsAfter().length).toBe(2), { timeout: 3000 });
    // 强断言：**第一张卡无 textarea、第二张卡有 textarea**（编辑的是物理第二条，不是第一条）
    const hasTa = cardsAfter().map((el) => !!el.querySelector("textarea"));
    expect(hasTa[0]).toBe(false);
    expect(hasTa[1]).toBe(true);
    // 第二条卡的 textarea 有值（编辑的是第二条）
    const ta2 = cardsAfter()[1].querySelector("textarea");
    expect(ta2.value).toContain("完全相同的重复便签 corrDup");
    // 取消（不写）
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
  });

  it("adversarial-04: result 操作前有未保存 composer 草稿 → 需确认；拒绝则不动草稿不跳转", async () => {
    const keyT = "ik-draft-corr4";
    const lanes = { conversation_todo: serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment: "目标便签 draftTarget" }), keyT)) };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("新便签")).toBeTruthy());
    // 在 composer 输入未保存草稿
    const comp = screen.getByPlaceholderText(/可留空，以后再补/);
    fireEvent.change(comp, { target: { value: "未保存草稿内容" } });
    await openSearchE();
    await typeQueryE("draftTarget");
    const card = resultCardsE().find((c) => (c.textContent || "").includes("draftTarget"));
    expect(card).toBeTruthy();
    // confirm 拒绝 → 不跳转、草稿保留、搜索仍开
    vi.stubGlobal("confirm", vi.fn(() => false));
    const editBtn = [...card.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "编辑");
    fireEvent.click(editBtn);
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelector('[data-search-input]')).toBeTruthy(); // 搜索未关闭
    // confirm 同意 → 清草稿、跳转、编辑目标卡
    vi.stubGlobal("confirm", vi.fn(() => true));
    const card2 = resultCardsE().find((c) => (c.textContent || "").includes("draftTarget"));
    const editBtn2 = [...card2.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "编辑");
    fireEvent.click(editBtn2);
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(screen.getByDisplayValue("目标便签 draftTarget")).toBeTruthy(), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
  });

  it("adversarial-R2-1: A 响应落在 B 的 debounce 窗口 → 不显示 A（query 变化即失效）", async () => {
    // idx0 = openPanel 初始载入；搜索 GET 从 idx1 起挂起
    let fetchIdx = 0;
    const resolvers = [];
    const lanesA = { conversation_todo: plainE("AAAA窗口 alpha"), deferred_work: "" };
    const lanesB = { conversation_todo: plainE("BBBB窗口 beta"), deferred_work: "" };
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      if (url.includes("/notes-api/meta")) return Promise.resolve(makeResponse("", { mtime: "1" }));
      if (url.endsWith("/conversation_todo")) {
        const idx = fetchIdx++;
        if (idx === 0) return Promise.resolve(makeResponse(lanesA.conversation_todo, { mtime: "1" }));
        return new Promise((res) => resolvers.push({ idx, res }));
      }
      return Promise.resolve(makeResponse("", { mtime: "1" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    mountPanel(); await openPanel();
    await openSearchE();
    // 输入 alpha → debounce 后 A 请求发出（挂起）
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "alpha" } });
    await new Promise((r) => setTimeout(r, 450));
    expect(resolvers.length).toBe(1);
    // 输入 beta（B 尚在 debounce 窗口，未发出请求）
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "beta" } });
    await new Promise((r) => setTimeout(r, 120)); // < 300ms：B 请求尚未发出
    expect(resolvers.length).toBe(1);
    // A 的响应此刻到达（B debounce 窗口内）→ 必须被丢弃（generation 已因 query 变化递增）
    resolvers[0].res(makeResponse(lanesA.conversation_todo, { mtime: "1" }));
    await new Promise((r) => setTimeout(r, 150));
    // A 结果不得显示（beta 未 settle，既无卡片也无 A）
    expect(document.body.innerText.includes("AAAA窗口 alpha")).toBe(false);
    // B debounce 到期 → B 请求发出并返回 → 显示 B
    await new Promise((r) => setTimeout(r, 500));
    expect(resolvers.length).toBe(2);
    resolvers[1].res(makeResponse(lanesB.conversation_todo, { mtime: "1" }));
    await waitFor(() => expect(document.body.innerText.includes("BBBB窗口 beta")).toBe(true), { timeout: 2000 });
    expect(document.body.innerText.includes("AAAA窗口 alpha")).toBe(false);
  });

  it("adversarial-A1: 跨 lane Search 按 result lane 解析 Pin truth——active lane 不改变任何 Note 的 pin 真值（旧实现：L2 已置顶在 active=L1 显示未置顶）", async () => {
    const k1 = "ik-corrA-l1";
    const k2 = "ik-corrA-l2";
    const keyed = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
    const lanes = {
      conversation_todo: [keyed("L1已置顶 corrA", k1), plainE("L1普通 corrA")].join("\n\n"),
      deferred_work: [keyed("L2已置顶 corrA", k2), plainE("L2普通 corrA")].join("\n\n"),
      knowledge_candidate: plainE("L3普通 corrA"),
    };
    storePinsE({ conversation_todo: [k1], deferred_work: [k2] });
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*2/)).toBeTruthy());
    const assertTruth = () => {
      const cards = resultCardsE();
      const txt = (c) => (c.textContent || "");
      const l1Pin = cards.find((c) => txt(c).includes("L1已置顶 corrA"));
      const l2Pin = cards.find((c) => txt(c).includes("L2已置顶 corrA"));
      const l1Nrm = cards.find((c) => txt(c).includes("L1普通 corrA"));
      const l2Nrm = cards.find((c) => txt(c).includes("L2普通 corrA"));
      expect(l1Pin).toBeTruthy(); expect(l2Pin).toBeTruthy();
      expect(l1Nrm).toBeTruthy(); expect(l2Nrm).toBeTruthy();
      // 已置顶结果（无论属于哪个 lane）在结果卡上都显示 取消置顶；普通结果显示 置顶
      expect([...l1Pin.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "取消置顶")).toBe(true);
      expect([...l2Pin.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "取消置顶")).toBe(true);
      expect([...l1Nrm.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "置顶")).toBe(true);
      expect([...l2Nrm.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "置顶")).toBe(true);
      // 每个 lane：置顶命中组在普通命中组之前（不平铺成一条普通序列）
      const texts = cards.map(txt);
      const idx = (frag) => texts.findIndex((t) => t.includes(frag));
      expect(idx("L1已置顶 corrA")).toBeGreaterThan(-1);
      expect(idx("L1普通 corrA")).toBeGreaterThan(-1);
      expect(idx("L2已置顶 corrA")).toBeGreaterThan(-1);
      expect(idx("L2普通 corrA")).toBeGreaterThan(-1);
      expect(idx("L1已置顶 corrA")).toBeLessThan(idx("L1普通 corrA"));
      expect(idx("L2已置顶 corrA")).toBeLessThan(idx("L2普通 corrA"));
      // 分区头存在且 pinned 组整体在 normal 组之前
      const heads = [...document.querySelectorAll("[data-search-pin-group]")].map((el) => el.getAttribute("data-search-pin-group"));
      const firstPinned = heads.indexOf("pinned");
      const firstNormal = heads.indexOf("normal");
      expect(firstPinned).toBeGreaterThan(-1);
      expect(firstNormal).toBeGreaterThan(-1);
      expect(firstPinned).toBeLessThan(firstNormal);
    };
    await openSearchE();
    await typeQueryE("corrA");
    await waitFor(() => assertTruth(), { timeout: 2000 });
    // active lane → L2（搜索保持打开；只切换导航上下文，结果与 pin 真值不变）
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    await waitFor(() => assertTruth(), { timeout: 2000 });
    // active lane → L3
    fireEvent.click(screen.getByRole("button", { name: "L3 知识候选" }));
    await waitFor(() => assertTruth(), { timeout: 2000 });
    // active lane → L4
    fireEvent.click(screen.getByRole("button", { name: "L4 复盘素材" }));
    await waitFor(() => assertTruth(), { timeout: 2000 });
  });

  it("adversarial-A2: 同一 lane 多条置顶命中——置顶组整体在前，组内/普通组内都遵循全局 viewDir；置顶真值不受 viewDir 改变影响", async () => {
    const kp1 = "ik-corrA2-p1";
    const kp2 = "ik-corrA2-p2";
    const keyed = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
    // 物理序（旧→新）：L1 普通-旧、L1 普通-新、L1 置顶-旧、L1 置顶-新
    const lanes = {
      conversation_todo: [
        plainE("L1普通-旧 corrA2"),
        plainE("L1普通-新 corrA2"),
        keyed("L1置顶-旧 corrA2", kp1),
        keyed("L1置顶-新 corrA2", kp2),
      ].join("\n\n"),
    };
    storePinsE({ conversation_todo: [kp1, kp2] });
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*4/)).toBeTruthy());
    await openSearchE();
    await typeQueryE("corrA2");
    const texts = () => resultCardsE().map((c) => c.textContent || "");
    const idx = (arr, frag) => arr.findIndex((t) => t.includes(frag));
    // newest：置顶组内 新 在 旧 前；普通组内 新 在 旧 前；置顶组整体在普通组前
    await waitFor(() => {
      const t = texts();
      expect(idx(t, "L1置顶-新 corrA2")).toBeGreaterThan(-1);
      expect(idx(t, "L1置顶-旧 corrA2")).toBeGreaterThan(-1);
      expect(idx(t, "L1普通-新 corrA2")).toBeGreaterThan(-1);
      expect(idx(t, "L1普通-旧 corrA2")).toBeGreaterThan(-1);
      expect(idx(t, "L1置顶-新 corrA2")).toBeLessThan(idx(t, "L1置顶-旧 corrA2"));
      expect(idx(t, "L1置顶-旧 corrA2")).toBeLessThan(idx(t, "L1普通-新 corrA2"));
      expect(idx(t, "L1普通-新 corrA2")).toBeLessThan(idx(t, "L1普通-旧 corrA2"));
    }, { timeout: 2000 });
    const pinnedBefore = [...resultCardsE()].filter((c) => [...c.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "取消置顶")).length;
    expect(pinnedBefore).toBe(2);
    // 搜索视图内直接切 oldest（adversarial-B 控件）：置顶组仍在普通组前、组内翻转；pin 真值不变
    expect(viewDirSelectE()).toBeTruthy();
    setDirE("oldest");
    await waitFor(() => {
      const t = texts();
      expect(idx(t, "L1置顶-旧 corrA2")).toBeLessThan(idx(t, "L1置顶-新 corrA2"));
      expect(idx(t, "L1置顶-新 corrA2")).toBeLessThan(idx(t, "L1普通-旧 corrA2"));
      expect(idx(t, "L1普通-旧 corrA2")).toBeLessThan(idx(t, "L1普通-新 corrA2"));
    }, { timeout: 2000 });
    const pinnedAfter = [...resultCardsE()].filter((c) => [...c.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "取消置顶")).length;
    expect(pinnedAfter).toBe(2); // viewDir 改变不改变哪些 Note 被置顶
  });

  it("adversarial-A3: active=L1 时对 L2 搜索结果 Pin/Unpin——只改 L2 那条 Note（holder+lane+itemKey 靶向，不串 L1）", async () => {
    const kL1 = "ik-corrA3-l1";
    const kL2 = "ik-corrA3-l2";
    const keyed = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
    const lanes = {
      conversation_todo: keyed("L1存在 corrA3", kL1),
      deferred_work: keyed("L2目标 corrA3", kL2),
    };
    installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText("L1存在 corrA3")).toBeTruthy());
    // (a) 从 active=L1 对未置顶的 L2 结果点 置顶
    await openSearchE();
    await typeQueryE("corrA3");
    const l2Card = resultCardsE().find((c) => (c.textContent || "").includes("L2目标 corrA3"));
    expect(l2Card).toBeTruthy();
    const pinBtn = [...l2Card.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "置顶");
    expect(pinBtn).toBeTruthy();
    fireEvent.click(pinBtn);
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeNull(), { timeout: 3000 });
    // 跳回 L2 并置顶成功
    await waitFor(() => expect(screen.getByText("取消置顶")).toBeTruthy(), { timeout: 3000 });
    expect(readPinsE("deferred_work").has(kL2)).toBe(true);
    expect(readPinsE("conversation_todo").has(kL2)).toBe(false); // 不串写 L1
    expect(readPinsE("conversation_todo").has(kL1)).toBe(false);
    // (b) 回到 active=L1，对已置顶的 L2 结果点 取消置顶
    fireEvent.click(screen.getByRole("button", { name: "L1 会话待办" }));
    await waitFor(() => expect(screen.getByText("L1存在 corrA3")).toBeTruthy(), { timeout: 3000 });
    await openSearchE();
    await typeQueryE("corrA3");
    const l2Card2 = resultCardsE().find((c) => (c.textContent || "").includes("L2目标 corrA3"));
    expect(l2Card2).toBeTruthy();
    // adversarial-A1 保证：跨 lane 已置顶结果显示 取消置顶
    const unPinBtn = [...l2Card2.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "取消置顶");
    expect(unPinBtn).toBeTruthy();
    fireEvent.click(unPinBtn);
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeNull(), { timeout: 3000 });
    await waitFor(() => expect(readPinsE("deferred_work").has(kL2)).toBe(false), { timeout: 3000 });
    expect(readPinsE("conversation_todo").has(kL1)).toBe(false);
  });

  it("adversarial-B1: Search 视图暴露同一全局 viewDir 控件——搜索中可切 newest/oldest，关闭搜索回普通视图仍同一状态；零 PUT", async () => {
    const kp = "ik-corrB-l1p";
    const keyed = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
    const lanes = {
      conversation_todo: [plainE("L1老N corrB"), plainE("L1新N corrB"), keyed("L1置顶 corrB", kp)].join("\n\n"),
      deferred_work: [plainE("L2老 corrB"), plainE("L2新 corrB")].join("\n\n"),
    };
    storePinsE({ conversation_todo: [kp] });
    const { putBodies } = installLaneFetchE({ lanes });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    await openSearchE();
    await typeQueryE("corrB");
    // 搜索中只有**一个**全局 viewDir 控件（不新建 search 排序状态）
    expect(document.querySelectorAll("[data-view-dir]").length).toBe(1);
    expect(viewDirSelectE().value).toBe("newest");
    const texts = () => resultCardsE().map((c) => c.textContent || "");
    const idx = (arr, frag) => arr.findIndex((t) => t.includes(frag));
    await waitFor(() => {
      const t = texts();
      expect(idx(t, "L1置顶 corrB")).toBeLessThan(idx(t, "L1新N corrB"));
      expect(idx(t, "L1新N corrB")).toBeLessThan(idx(t, "L1老N corrB"));
      expect(idx(t, "L2新 corrB")).toBeLessThan(idx(t, "L2老 corrB"));
    }, { timeout: 2000 });
    // 搜索中直接切 oldest → 全局生效（L1/L2 全翻转、置顶组仍在普通组前）
    setDirE("oldest");
    await waitFor(() => {
      const t = texts();
      expect(idx(t, "L1置顶 corrB")).toBeLessThan(idx(t, "L1老N corrB"));
      expect(idx(t, "L1老N corrB")).toBeLessThan(idx(t, "L1新N corrB"));
      expect(idx(t, "L2老 corrB")).toBeLessThan(idx(t, "L2新 corrB"));
    }, { timeout: 2000 });
    expect(viewDirSelectE().value).toBe("oldest");
    // 清空 query → 普通视图：同一全局 select（旧记录在前），置顶组仍存在、pin 真值未变
    fireEvent.change(document.querySelector('[data-search-input]'), { target: { value: "" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll("[data-view-dir]").length).toBe(1);
    expect(viewDirSelectE().value).toBe("oldest");
    expect(screen.getByText("取消置顶")).toBeTruthy();
    // 关闭搜索 → 普通列表 viewDir 仍 oldest（同一全局状态）
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    await waitFor(() => expect(document.querySelector('[data-search-input]')).toBeNull());
    expect(viewDirSelectE().value).toBe("oldest");
    expect(readPinsE("conversation_todo").has(kp)).toBe(true);
    expect(putBodies.length).toBe(0); // 全程（query 输入/切 viewDir/清空/关闭）零 Notes 写
  });

  it("adversarial-E0-01: 仅单侧 marker 的 lane 在 Search 中按普通 lane 处理（非 merge-wrapper）——viewDir 与 Pin 分区仍生效", async () => {
    const kp = "ik-single-marker-pin";
    const keyed = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
    // 只有一侧 marker（## 来自父分支）：composeCarryMerge 双侧都非空才同时写两侧标题 →
    // 这是普通 lane（OR 误判在 test adversarial-01 修复：Search 复用普通列表的双 marker AND 判定）。
    const body = "## 来自父分支\n\n" + [plainE("单标记-老N markerQ"), plainE("单标记-新N markerQ"), keyed("单标记-置顶 markerQ", kp)].join("\n\n");
    storePinsE({ conversation_todo: [kp] });
    installLaneFetchE({ lanes: { conversation_todo: body } });
    mountPanel(); await openPanel();
    await waitFor(() => expect(screen.getByText(/已保存便签\s*3/)).toBeTruthy());
    // 普通列表同判据：非 merge-wrapper → viewDir select 存在、Pin 按钮可用
    expect(viewDirSelectE()).toBeTruthy();
    expect(screen.getByText("取消置顶")).toBeTruthy();
    await openSearchE();
    await typeQueryE("markerQ");
    // Search：forkMerge=false → 出现置顶/普通分区；组内遵循全局 viewDir
    await waitFor(() => {
      expect(document.querySelectorAll("[data-search-pin-group]").length).toBeGreaterThan(0);
      const t = resultCardsE().map((c) => c.textContent || "");
      const iPin = t.findIndex((x) => x.includes("单标记-置顶 markerQ"));
      const iNew = t.findIndex((x) => x.includes("单标记-新N markerQ"));
      const iOld = t.findIndex((x) => x.includes("单标记-老N markerQ"));
      expect([iPin, iNew, iOld].every((i) => i > -1)).toBe(true);
      expect(iPin).toBeLessThan(iNew);
      expect(iNew).toBeLessThan(iOld); // newest：置顶组前，普通组内 新 在 老 前
    }, { timeout: 2000 });
    setDirE("oldest");
    await waitFor(() => {
      const t = resultCardsE().map((c) => c.textContent || "");
      const iPin = t.findIndex((x) => x.includes("单标记-置顶 markerQ"));
      const iNew = t.findIndex((x) => x.includes("单标记-新N markerQ"));
      const iOld = t.findIndex((x) => x.includes("单标记-老N markerQ"));
      expect(iPin).toBeLessThan(iOld);
      expect(iOld).toBeLessThan(iNew); // oldest：置顶组前，普通组内 老 在 新 前（viewDir 生效 → 非 merge）
    }, { timeout: 2000 });
  });
});

// ==================== behavior regression: whole-Note selection / tray / client-issued generation ====================
// 语义：whole-Note selection、client-issued generation 与 stale-result isolation：
//   - 勾选单元 = whole structured Note（需 stable itemKey；keyless/legacy 不可选——
//     无 stable key 无法在提交时 re-resolve，宁不可选不 silent subset）。
//   - selection 键 = holder+lane+itemKey：同一 Note 经 lane / Search / Pin / viewDir
//     多路径只占一个 entry；跨 L1-L4 可同时选（cross-lane current-holder set）。
//   - 每次可见 mutation = 一次 versioned PUT（client-issued 单调 generation；host
//     拒绝 → revert 可见态回 host accepted truth——绝不 "UI 0 选中 + 隐藏 stale
//     pending"）；clear = PUT []。
//   - 消费经轮询 GET selection：lastBinding.generation === 本地 synced gen 才动作；
//     stale lastBinding（代不匹配）忽略；绑定成功 → 清 tray；绑定失败 → tray 保留 +
//     truthful 文案。
//   - reload rehydration：mount GET host pending → 恢复可见 selection（同 running
//     runtime；重启不恢复）。
describe("behavior regression whole-Note selection / tray / generation sync", () => {
  const L1 = "conversation_todo";
  const L2 = "deferred_work";
  const kA = "ik-p4e2-client-a";
  const kB = "ik-p4e2-client-b";
  // keyed whole Note 块（Notes behavior regression 保存流同构：serializeItem(withItemKey(makeItem(...)))）
  const keyed = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
  const keyless = (comment) => serializeItem(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }));

  /** 迷你 host selection mock：单调 generation / 空=clear / stale 拒绝。 */
  function makeHostSel() {
    return { lastGen: 0, pending: null, lastBinding: null };
  }
  function installSelFetch({ lanes = {}, hostSel = makeHostSel(), failPut = false } = {}) {
    const selPuts = []; // {targets, generation}
    const putBodies = [];
    const jsonRes = (obj) => Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(obj),
      json: async () => obj,
    });
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      const method = opts?.method || "GET";
      if (url.includes("/selection")) {
        if (method === "GET") {
          return jsonRes({ pending: hostSel.pending, lastBinding: hostSel.lastBinding });
        }
        if (method === "PUT") {
          if (failPut) return Promise.reject(new Error("network down"));
          let payload = {};
          try { payload = JSON.parse(String(opts.body ?? "{}")); } catch {}
          const { targets, generation } = payload;
          selPuts.push({ targets, generation });
          if (!Number.isSafeInteger(generation) || generation <= hostSel.lastGen) {
            return jsonRes({ ok: false, stale: true, reason: `generation ${generation} <= current ${hostSel.lastGen}`, currentGeneration: hostSel.lastGen });
          }
          hostSel.lastGen = generation;
          hostSel.pending = (Array.isArray(targets) && targets.length === 0) ? null : { generation, targets: targets || [] };
          return jsonRes({ ok: true, generation, pending: hostSel.pending });
        }
        return jsonRes({ ok: false });
      }
      if (method === "PUT") {
        putBodies.push(String(opts.body ?? ""));
        return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      }
      const key = decodeURIComponent(url.split("/").pop() || "");
      const laneBody = lanes[key] ?? "";
      return Promise.resolve(makeResponse(laneBody, { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    return { fetchFn, selPuts, putBodies, hostSel };
  }

  const cards = () => [...document.querySelectorAll("[data-notes-list] > div")].slice(1);
  const cardOf = (frag) => cards().find((c) => (c.textContent || "").includes(frag));
  const selCheckboxOf = (frag) => {
    const card = cardOf(frag);
    expect(card).toBeTruthy();
    return card.querySelector("[data-select]");
  };
  const tray = () => document.querySelector("[data-sel-tray]");
  const trayText = () => (tray() ? tray().textContent || "" : "");
  const searchRowOf = (frag) => [...document.querySelectorAll("[data-search-result]")].find((el) => (el.textContent || "").includes(frag));

  // 消费轮询推进：测试把轮询间隔压到 25ms（window override），等几个周期即可（real timers）
  const fastPoll = () => { window.__DSH_NOTES_SEL_POLL_MS = 25; };
  const tickConsume = async () => { await new Promise((r) => setTimeout(r, 120)); };
  afterEach(() => { delete window.__DSH_NOTES_SEL_POLL_MS; delete window.__DSH_NOTES_HYDRATE_RETRY_MS; });

  it("T1: 勾选整条 Note → client-issued gen PUT + 勾选态 + compact tray 已选 1 条", async () => {
    const { selPuts } = installSelFetch({ lanes: { [L1]: keyed("T1正文AAA", kA) } });
    mountPanel();
    await openPanel();
    const cb = selCheckboxOf("T1正文AAA");
    await waitFor(() => expect(cb.disabled).toBe(false)); // 等 hydration GET 完成
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    expect(cb.checked).toBe(true);
    expect(selPuts.length).toBe(1);
    expect(selPuts[0].targets).toEqual([{ laneKey: L1, itemKey: kA }]);
    expect(selPuts[0].generation).toBe(1); // client-issued，从 1 起
  });

  it("T2: 同一勾选 truth 跨 lane 切换与 Search 视图存活（不新建 per-view 选择态、不重复 PUT）", async () => {
    const { selPuts } = installSelFetch({ lanes: { [L1]: keyed("T2正文AAA", kA) } });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText("T2正文AAA")).toBeTruthy());
    const cb = selCheckboxOf("T2正文AAA");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    const putsAfterSelect = selPuts.length; // 1
    // lane 切换（L2 空）→ 回来：勾选态与 tray 保留、零新增 selection PUT
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    await waitFor(() => expect(document.querySelector("[data-notes-list]")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "L1 会话待办" }));
    await waitFor(() => expect(screen.getByText("T2正文AAA")).toBeTruthy());
    const cbBack = selCheckboxOf("T2正文AAA");
    await waitFor(() => expect(cbBack.checked).toBe(true));
    expect(trayText()).toContain("已选 1 条");
    expect(selPuts.length).toBe(putsAfterSelect);
    // Search 视图（跨 lane 命中同一 Note 的 result row）显示同一勾选态（same truth）
    fireEvent.click(screen.getByTitle(/搜索便签/));
    const input = screen.getByPlaceholderText("搜索已保存便签");
    fireEvent.change(input, { target: { value: "T2正文" } });
    await waitFor(() => expect(searchRowOf("T2正文AAA")).toBeTruthy(), { timeout: 2000 });
    const rowCb = searchRowOf("T2正文AAA").querySelector("[data-select]");
    expect(rowCb.checked).toBe(true); // Search 视图同一 entry（lane+itemKey），非 per-view 副本
    expect(trayText()).toContain("已选 1 条"); // Search 视图不清 tray
    expect(selPuts.length).toBe(putsAfterSelect); // 纯视图：搜索/切换零写
    // 关闭搜索 → 列表勾选态仍在
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    expect(selCheckboxOf("T2正文AAA").checked).toBe(true);
  });

  it("T3: 跨 lane 集合（L1+L2）→ 单 targets 数组两项；tray 展开逐条 review/remove", async () => {
    const { selPuts } = installSelFetch({ lanes: { [L1]: keyed("T3A正文AAA", kA), [L2]: keyed("T3B正文BBB", kB) } });
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText("T3A正文AAA")).toBeTruthy());
    const cbA = selCheckboxOf("T3A正文AAA");
    await waitFor(() => expect(cbA.disabled).toBe(false));
    fireEvent.click(cbA);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    // L2 勾选 B → 第二次 PUT targets 含两项（cross-lane set）
    fireEvent.click(screen.getByRole("button", { name: "L2 延后工作" }));
    await waitFor(() => expect(screen.getByText("T3B正文BBB")).toBeTruthy());
    const cbB = selCheckboxOf("T3B正文BBB");
    await waitFor(() => expect(cbB.disabled).toBe(false));
    fireEvent.click(cbB);
    await waitFor(() => expect(trayText()).toContain("已选 2 条"));
    expect(selPuts.length).toBe(2);
    expect(selPuts[1].targets).toEqual([{ laneKey: L1, itemKey: kA }, { laneKey: L2, itemKey: kB }]);
    // 展开 tray：两条 review row（各自 lane 名 + 摘要）
    fireEvent.click(document.querySelector("[data-sel-tray-toggle]"));
    await waitFor(() => expect(document.querySelectorAll("[data-sel-tray-row]").length).toBe(2));
    const rowTexts = [...document.querySelectorAll("[data-sel-tray-row]")].map((r) => r.textContent || "");
    expect(rowTexts.some((t) => t.includes("L1 会话待办") && t.includes("T3A正文AAA"))).toBe(true);
    expect(rowTexts.some((t) => t.includes("L2 延后工作") && t.includes("T3B正文BBB"))).toBe(true);
    // 移除 B → PUT targets 只剩 A；tray 已选 1 条
    const removeBtns = [...document.querySelectorAll("[data-sel-remove]")];
    const removeB = removeBtns.find((b) => (b.closest("[data-sel-tray-row]").textContent || "").includes("T3B正文BBB"));
    fireEvent.click(removeB);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    expect(selPuts[selPuts.length - 1].targets).toEqual([{ laneKey: L1, itemKey: kA }]);
  });

  it("T4: 全部移除（clear）→ PUT [] → tray 消失（0 quiet）；取消最后一条同路径", async () => {
    const { selPuts } = installSelFetch({ lanes: { [L1]: keyed("T4正文AAA", kA) } });
    mountPanel();
    await openPanel();
    const cb = selCheckboxOf("T4正文AAA");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    fireEvent.click(document.querySelector("[data-sel-clear]"));
    await waitFor(() => expect(tray()).toBeNull());
    expect(selPuts[selPuts.length - 1].targets).toEqual([]);
    expect(cb.checked).toBe(false);
  });

  it("T5: host 同步失败 → revert 可见态 + truthful 状态（不出现 UI 0 选中 + 隐藏 pending）", async () => {
    const { hostSel } = installSelFetch({ lanes: { [L1]: keyed("T5正文AAA", kA) }, failPut: true });
    mountPanel();
    await openPanel();
    const cb = selCheckboxOf("T5正文AAA");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    // PUT 网络失败 → pump revert：勾选态回 false（host accepted truth = 空）、
    // host pending 未被写入（无 hidden stale pending），错误可见（status footer）
    await waitFor(() => expect(cb.checked).toBe(false));
    expect(hostSel.pending).toBeNull();
    expect(screen.getByText(/选择未保存/)).toBeTruthy();
  });

  it("T6: stale lastBinding（代不匹配）忽略不消费；匹配代 ok → 清 tray", async () => {
    fastPoll();
    const { hostSel } = installSelFetch({ lanes: { [L1]: keyed("T6正文AAA", kA) } });
    mountPanel();
    await openPanel();
    const cb = selCheckboxOf("T6正文AAA");
    await waitFor(() => expect(cb.disabled).toBe(false));
    // 第一轮：select(gen1) → 用户提交 → host 绑定成功（清 pending + lastBinding ok gen1）
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    hostSel.pending = null;
    hostSel.lastBinding = { ok: true, generation: 1, noteCount: 1 };
    await tickConsume();
    await waitFor(() => expect(tray()).toBeNull()); // 匹配代 → 消费清 tray
    // 第二轮：用户再次 select 同一 Note（gen2）——host 尚未绑定新 selection，lastBinding
    // 仍是上一轮 gen1 的 ok 结果（stale）
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    expect(hostSel.pending).toEqual({ generation: 2, targets: [{ laneKey: L1, itemKey: kA }] });
    await tickConsume();
    // stale lastBinding（gen1 ≠ 本地 synced gen2）→ 忽略，不清掉新选择的 tray
    expect(trayText()).toContain("已选 1 条");
    // 新选择被绑定（结果代 == 2）→ 消费清 tray
    hostSel.pending = null;
    hostSel.lastBinding = { ok: true, generation: 2, noteCount: 1 };
    await tickConsume();
    await waitFor(() => expect(tray()).toBeNull());
  });

  it("T7: 绑定失败（代匹配）→ tray 保留 + truthful failure 文案；取消选择仍可用", async () => {
    fastPoll();
    const { selPuts, hostSel } = installSelFetch({ lanes: { [L1]: keyed("T7正文AAA", kA) } });
    mountPanel();
    await openPanel();
    const cb = selCheckboxOf("T7正文AAA");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    // host 绑定失败（UNRESOLVED）且 pending 保留（case-1 语义：selection 不丢）
    hostSel.lastBinding = { ok: false, generation: 1, noteCount: 1, failures: [{ code: "UNRESOLVED", reason: "note gone" }] };
    await tickConsume();
    expect(trayText()).toContain("已选 1 条"); // 保留
    expect(trayText()).toContain("上次发送未附上引用");
    expect(trayText()).toContain("UNRESOLVED");
    // 失败后全部移除仍正常（PUT []）
    fireEvent.click(document.querySelector("[data-sel-clear]"));
    await waitFor(() => expect(tray()).toBeNull());
    expect(selPuts[selPuts.length - 1].targets).toEqual([]);
  });

  it("T8: reload rehydration——host pending 恢复可见 selection；后续 mutation 从 host gen 续号", async () => {
    const hostSel = makeHostSel();
    hostSel.lastGen = 3;
    hostSel.pending = { generation: 3, targets: [{ laneKey: L1, itemKey: kA }] };
    const { selPuts } = installSelFetch({ lanes: { [L1]: keyed("T8正文AAA", kA) }, hostSel });
    mountPanel();
    await openPanel();
    // 打开面板即重水合：tray 显示 host pending 的选择
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    const cb = selCheckboxOf("T8正文AAA");
    expect(cb.checked).toBe(true);
    // 下一次 mutation 从 host gen 续号（4），不被 stale 拒绝
    fireEvent.click(cb); // 取消（最后一条）→ PUT []
    await waitFor(() => expect(tray()).toBeNull());
    expect(selPuts[selPuts.length - 1].generation).toBe(4);
  });

  it("T9: keyless item 不可勾选（无 stable key → 不提供 silent-subset 语义）", async () => {
    const { selPuts } = installSelFetch({ lanes: { [L1]: keyless("T9正文KEYLESS") } });
    mountPanel();
    await openPanel();
    const cb = selCheckboxOf("T9正文KEYLESS");
    await waitFor(() => expect(cb).toBeTruthy());
    expect(cb.disabled).toBe(true);
    fireEvent.click(cb);
    await new Promise((r) => setTimeout(r, 30));
    expect(selPuts.length).toBe(0); // 无任何 selection PUT
    expect(tray()).toBeNull();
  });

  it("T10 (OQ-1): hydration GET 全失败 → 不声称 0 选中 + 主动 clear 收敛（无 hidden pending 可静默 bind）", async () => {
    fastPoll();
    window.__DSH_NOTES_HYDRATE_RETRY_MS = 20;
    const hostSel = makeHostSel();
    hostSel.lastGen = 5;
    hostSel.pending = { generation: 5, targets: [{ laneKey: L1, itemKey: kA }] }; // reload 前遗留 pending
    const selPuts = [];
    const jsonRes = (obj) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });
    let getFailsLeft = 8; // selection GET 持续读失败（endpoint read 故障；PUT 通道正常）
    vi.stubGlobal("fetch", vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/selection")) {
        if (opts?.method === "PUT") {
          let payload = {};
          try { payload = JSON.parse(String(opts.body ?? "{}")); } catch {}
          const { targets, generation } = payload;
          selPuts.push({ targets, generation });
          if (!Number.isSafeInteger(generation) || generation <= hostSel.lastGen) {
            return jsonRes({ ok: false, stale: true, currentGeneration: hostSel.lastGen });
          }
          hostSel.lastGen = generation;
          hostSel.pending = (Array.isArray(targets) && targets.length === 0) ? null : { generation, targets };
          return jsonRes({ ok: true, generation, pending: hostSel.pending });
        }
        if (getFailsLeft > 0) { getFailsLeft--; return Promise.reject(new Error("selection GET down")); }
        return jsonRes({ pending: hostSel.pending, lastBinding: null });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      const key = decodeURIComponent(url.split("/").pop() || "");
      return Promise.resolve(makeResponse(key === L1 ? keyed("T10正文AAA", kA) : "", { mtime: "1111" }));
    }));
    mountPanel();
    await openPanel();
    await waitFor(() => expect(screen.getByText("T10正文AAA")).toBeTruthy());
    const cb = selCheckboxOf("T10正文AAA");
    await new Promise((r) => setTimeout(r, 150));
    // unknown 窗口期间：不出现 tray 声称（哪怕 host 确有 pending 5 在内存）
    await waitFor(() => expect(cb.disabled).toBe(false), { timeout: 3000 }); // clear 收敛后 hydrated → enabled
    expect(tray()).toBeNull(); // 空态（无 0 声称行——tray 只在 count>0 渲染）
    // host pending 已被主动 clear（PUT []）→ 无 hidden pending 可被后续 submit 静默消费
    expect(hostSel.pending).toBeNull();
    expect(selPuts.some((x) => Array.isArray(x.targets) && x.targets.length === 0)).toBe(true);
  });

  it("T11 (behavior regression): A→B session 切换清空 selection——A 的在途 PUT 不污染 B（key remount + epoch guard）", async () => {
    const SIDB = "session-p4e2-switch-b-0001";
    const lanes = {
      [SESSION]: keyed("P4E2-03正文A", kA),
      [SIDB]: keyed("P4E2-03正文B", kA), // B 用相同 itemKey → 若串 session 会误显已选
    };
    let resolvePutA;
    const putADeferred = new Promise((res) => { resolvePutA = res; });
    let putACalled = 0;
    const jsonRes = (obj) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });
    vi.stubGlobal("fetch", vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/selection")) {
        if (opts?.method === "PUT") {
          if (putACalled === 0) { putACalled++; return putADeferred; } // A 的 PUT 挂起
          const { targets, generation } = JSON.parse(String(opts.body ?? "{}"));
          return jsonRes({ ok: true, generation, pending: (targets && targets.length ? { generation, targets } : null) });
        }
        return jsonRes({ pending: null, lastBinding: null });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      const sid = url.includes(SIDB) ? SIDB : SESSION;
      return Promise.resolve(makeResponse(lanes[sid] ?? "", { mtime: "1111" }));
    }));
    // 可切换 session 的 mount（NotesPanel keyed by sessionId → remount）
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let Component = null;
    const ctx = { slots: { inject: (_n, fn) => { const r = fn(); Component = r.Component; }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText("P4E2-03正文A")).toBeTruthy());
    const cbA = screen.getByLabelText("发送消息时引用这条便签");
    await waitFor(() => expect(cbA.disabled).toBe(false));
    fireEvent.click(cbA);
    await waitFor(() => expect(putACalled).toBe(1)); // A 的 PUT 已发出（挂起中）
    // 切到 B（同 itemKey 的 Note）：旧 tray/勾选必须立即消失（remount + hydration 清空）
    view.rerender(React.createElement(Component, { sessionId: SIDB }));
    await waitFor(() => expect(screen.getByText("P4E2-03正文B")).toBeTruthy());
    expect(document.querySelector("[data-sel-tray]")).toBeNull(); // A 的 tray 不残留
    const cbB = screen.getByLabelText("发送消息时引用这条便签");
    await waitFor(() => expect(cbB.disabled).toBe(false)); // B hydration 完成
    expect(cbB.checked).toBe(false); // 相同 itemKey 在 B 未选（不串 session）
    // A 的在途 PUT 结果落地 → 不得污染 B
    resolvePutA({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ok: true, generation: 1, pending: { generation: 1, targets: [{ laneKey: L1, itemKey: kA }] } }), json: async () => ({}) });
    await new Promise((r) => setTimeout(r, 60));
    expect(document.querySelector("[data-sel-tray]")).toBeNull();
    expect(cbB.checked).toBe(false);
    view.unmount();
  });

  it("T12 (behavior regression): A→B 切换——A 的 hydration GET 在途（含 pending）不污染 B", async () => {
    const SIDB = "session-p4e2-switch-b-0002";
    const lanes = { [SESSION]: keyed("P4E2-03C正文A", kA), [SIDB]: keyed("P4E2-03C正文B", kA) };
    let resolveGetA;
    const getADeferred = new Promise((res) => { resolveGetA = res; });
    const jsonRes = (obj) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });
    vi.stubGlobal("fetch", vi.fn((u, opts) => {
      const url = String(u);
      const isGet = !opts?.method || opts?.method === "GET";
      if (url.includes("/selection")) {
        if (isGet && url.includes(SESSION)) return getADeferred; // A hydration 挂起
        return jsonRes({ pending: null, lastBinding: null });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      const sid = url.includes(SIDB) ? SIDB : SESSION;
      return Promise.resolve(makeResponse(lanes[sid] ?? "", { mtime: "1111" }));
    }));
    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let Component = null;
    const ctx = { slots: { inject: (_n, fn) => { const r = fn(); Component = r.Component; }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const view = render(React.createElement(Component, { sessionId: SESSION }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => expect(screen.getByText("P4E2-03C正文A")).toBeTruthy());
    // A hydration 仍未决（getADeferred 未 resolve）→ A checkbox 禁用
    const cbA = screen.getByLabelText("发送消息时引用这条便签");
    expect(cbA.disabled).toBe(true);
    // 切到 B：B 自己的 hydration（空）完成 → 可用
    view.rerender(React.createElement(Component, { sessionId: SIDB }));
    await waitFor(() => expect(screen.getByText("P4E2-03C正文B")).toBeTruthy());
    expect(document.querySelector("[data-sel-tray]")).toBeNull();
    const cbB = screen.getByLabelText("发送消息时引用这条便签");
    await waitFor(() => expect(cbB.disabled).toBe(false));
    expect(cbB.checked).toBe(false);
    // A 的 hydration 迟到 resolve（host 有 pending gen5）→ 不污染 B
    resolveGetA({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ pending: { generation: 5, targets: [{ laneKey: L1, itemKey: kA }] }, lastBinding: null }), json: async () => ({}) });
    await new Promise((r) => setTimeout(r, 60));
    expect(document.querySelector("[data-sel-tray]")).toBeNull();
    expect(cbB.checked).toBe(false);
    view.unmount();
  });
});

// ==================== behavior regression pre-acceptance UI polish ====================
describe("behavior regression UI polish（search distinction + sidebar resize）", () => {
  it("A1: 搜索输入与新建便签一瞥可辨——图标 + 明确 placeholder + 独立样式；composer 不受影响", async () => {
    installDefaultFetch();
    mountPanel();
    await openPanel();
    // 打开搜索行
    fireEvent.click(screen.getByTitle(/搜索便签/));
    const input = document.querySelector("[data-search-input]");
    await waitFor(() => expect(input).toBeTruthy());
    expect(input.getAttribute("placeholder")).toBe("搜索已保存便签");
    expect(input.getAttribute("aria-label")).toBe("搜索便签");
    // 🔍 图标在输入框同一行内（aria-hidden，不干扰角色查询）
    const row = input.closest("div");
    expect((row.textContent || "").includes("🔍")).toBe(true);
    // 搜索输入有区别于 composer 的浅底（visual distinction 关键信号）
    expect((input.style.background || "")).toBe("#f8fafc"); // 区别于 composer 白底
    // 新建便签 composer 行为/占位不变（唯一 textbox 仍是 composer；搜索输入是 type=search）
    const composer = screen.getByPlaceholderText(/可留空，以后再补/);
    expect(composer).toBeTruthy();
    // 关闭搜索 → 行为不变
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    expect(document.querySelector("[data-search-input]")).toBeNull();
  });

  it("A2: 侧栏拖动 resize（plugin-local）——宽度变化并夹在 [280,560]，松开后停止", async () => {
    installDefaultFetch();
    mountPanel();
    await openPanel();
    const handle = document.querySelector("[data-resize-handle]");
    expect(handle).toBeTruthy();
    const root = handle.parentElement; // fixed panel 容器
    expect(root.style.width).toBe("340px");
    // 向左拖（clientX 500 → 300）→ 变宽 540
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 300 });
    expect(root.style.width).toBe("540px");
    // 继续向左拖 → 夹到 max 560
    fireEvent.mouseMove(window, { clientX: 200 });
    expect(root.style.width).toBe("560px");
    fireEvent.mouseUp(window);
    // 松开后不再跟随
    fireEvent.mouseMove(window, { clientX: 100 });
    expect(root.style.width).toBe("560px");
    // 向右拖 → 夹到 min 280
    fireEvent.mouseDown(handle, { clientX: 400 });
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(root.style.width).toBe("280px");
    fireEvent.mouseUp(window);
  });
});

// ============ behavior regression narrow UX: selection/reference binding receipt visibility ============
// receipt 只由 authoritative binding success/failure 驱动（lastBinding 代 == synced gen）；
// 成功：清 tray + 显著"✓ 已将 N 条便签附到刚才的消息"（可查看本次真实绑定 targets，
// ~数秒后降级低强调"已随消息引用 N 条"）；失败：红底"引用失败 + 选择保留"，不伪装成功。
describe("behavior regression binding receipt（authoritative success/failure + generation）", () => {
  const L1 = "conversation_todo";
  const L2 = "deferred_work";
  const kA = "ik-p4e2-client-a";
  const kB = "ik-p4e2-client-b";
  const kC = "ik-p4e2-client-c";
  const keyed = (comment, key) => serializeItem(withItemKey(makeItem({ kind: "source-independent", captureOrigin: SESSION, comment }), key));
  function makeHostSel() { return { lastGen: 0, pending: null, lastBinding: null }; }
  function installFetch({ lanes = {}, hostSel = makeHostSel() } = {}) {
    const selPuts = [];
    const jsonRes = (obj) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(obj), json: async () => obj });
    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      const method = opts?.method || "GET";
      if (url.includes("/selection")) {
        if (method === "GET") return jsonRes({ pending: hostSel.pending, lastBinding: hostSel.lastBinding });
        if (method === "PUT") {
          const payload = JSON.parse(String(opts.body ?? "{}"));
          const { targets, generation } = payload;
          selPuts.push({ targets, generation });
          if (!Number.isSafeInteger(generation) || generation <= hostSel.lastGen) return jsonRes({ ok: false, stale: true, currentGeneration: hostSel.lastGen });
          hostSel.lastGen = generation;
          hostSel.pending = (Array.isArray(targets) && targets.length === 0) ? null : { generation, targets: targets || [] };
          return jsonRes({ ok: true, generation, pending: hostSel.pending });
        }
        return jsonRes({ ok: false });
      }
      if (method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      const key = decodeURIComponent(url.split("/").pop() || "");
      return Promise.resolve(makeResponse(lanes[key] ?? "", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    return { fetchFn, selPuts, hostSel };
  }
  const cards = () => [...document.querySelectorAll("[data-notes-list] > div")].slice(1);
  const cardOf = (frag) => cards().find((c) => (c.textContent || "").includes(frag));
  const selCheckboxOf = (frag) => cardOf(frag).querySelector("[data-select]");
  const tray = () => document.querySelector("[data-sel-tray]");
  const trayText = () => (tray() ? tray().textContent || "" : "");
  const receiptEl = () => document.querySelector("[data-sel-receipt]");
  const receiptText = () => (receiptEl() ? receiptEl().textContent || "" : "");
  const fastPoll = () => { window.__DSH_NOTES_SEL_POLL_MS = 25; };
  const tick = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)); };
  beforeEach(() => {
    window.__DSH_NOTES_SEL_POLL_MS = 25;
    window.__DSH_NOTES_RECEIPT_MS = 300;
  });
  afterEach(() => {
    delete window.__DSH_NOTES_SEL_POLL_MS;
    delete window.__DSH_NOTES_RECEIPT_MS;
  });
  async function mountOpen() {
    mountPanel();
    await openPanel();
  }

  it("R1 (happy): 选 3 条 → 匹配代 ok → 清 tray + '✓ 已将 3 条便签附到刚才的消息'", async () => {
    const { hostSel } = installFetch({ lanes: { [L1]: keyed("R1A", kA) + "\n\n" + keyed("R1B", kB) + "\n\n" + keyed("R1C", kC) } });
    await mountOpen();
    for (const frag of ["R1A", "R1B", "R1C"]) {
      const cb = selCheckboxOf(frag);
      await waitFor(() => expect(cb.disabled).toBe(false));
      fireEvent.click(cb);
    }
    await waitFor(() => expect(trayText()).toContain("已选 3 条"));
    hostSel.pending = null;
    hostSel.lastBinding = { ok: true, generation: 3, noteCount: 3 };
    await tick();
    await waitFor(() => expect(tray()).toBeNull());
    await waitFor(() => expect(receiptEl()).toBeTruthy(), { timeout: 3000 });
    expect(receiptEl().getAttribute("data-sel-receipt")).toBe("success");
    expect(receiptText()).toContain("已将 3 条便签附到刚才的消息");
    expect(receiptText()).toContain("✓");
  });

  it("R2: receipt N 用本次 binding noteCount（非 selection count 误值）", async () => {
    const { hostSel } = installFetch({ lanes: { [L1]: keyed("R2A", kA) + "\n\n" + keyed("R2B", kB) } });
    await mountOpen();
    for (const frag of ["R2A", "R2B"]) {
      const cb = selCheckboxOf(frag);
      await waitFor(() => expect(cb.disabled).toBe(false));
      fireEvent.click(cb);
    }
    await waitFor(() => expect(trayText()).toContain("已选 2 条"));
    // host 实际只绑定成功 1 条（noteCount 是 authoritative N）
    hostSel.pending = null;
    hostSel.lastBinding = { ok: true, generation: 2, noteCount: 1 };
    await tick();
    await waitFor(() => expect(receiptEl()).toBeTruthy(), { timeout: 3000 });
    expect(receiptText()).toContain("已将 1 条便签附到刚才的消息");
  });

  it("R3 (ref-only): reference append 但 CURRENT direct 未配对 → 无 lastBinding → 无 success receipt", async () => {
    const { hostSel } = installFetch({ lanes: { [L1]: keyed("R3A", kA) } });
    await mountOpen();
    const cb = selCheckboxOf("R3A");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    // host: reference 已 append 但未配对确认 → lastBinding 仍 null、pending 保留
    await tick();
    expect(receiptEl()).toBeNull(); // 无 success receipt
    expect(trayText()).toContain("已选 1 条"); // tray 仍在
  });

  it("R4 (failure): 匹配代 ok:false → 失败 receipt + 选择保留 + 不出现 success", async () => {
    const { hostSel } = installFetch({ lanes: { [L1]: keyed("R4A", kA) } });
    await mountOpen();
    const cb = selCheckboxOf("R4A");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    hostSel.lastBinding = { ok: false, generation: 1, noteCount: 1, failures: [{ code: "UNRESOLVED", reason: "note gone" }] };
    await tick();
    await waitFor(() => expect(receiptEl()).toBeTruthy(), { timeout: 3000 });
    expect(receiptEl().getAttribute("data-sel-receipt")).toBe("failure");
    expect(receiptText()).toContain("引用失败");
    expect(receiptText()).toContain("已保留 1 条选择");
    expect(receiptText()).not.toContain("已将");
    expect(trayText()).toContain("已选 1 条"); // 选择保留
  });

  it("R5 (stale): A 迟到 success 不清 B（B 建立新 selection 后，A 的 lastBinding 代不匹配）", async () => {
    const { hostSel } = installFetch({ lanes: { [L1]: keyed("R5A", kA) } });
    await mountOpen();
    const cb = selCheckboxOf("R5A");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    // A 已提交、host 即将返回 gen1 ok；但用户先建了 B（同 Note 重新勾选 = gen2）
    fireEvent.click(cb); // 取消 → gen2 clear
    await waitFor(() => expect(tray()).toBeNull());
    fireEvent.click(cb); // 再勾 → gen3
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    // A 的迟到 gen1 ok 结果返回 → 代不匹配 → 不清 B tray、不产 receipt
    hostSel.lastBinding = { ok: true, generation: 1, noteCount: 1 };
    await tick();
    expect(trayText()).toContain("已选 1 条"); // B tray 未被 A 清
    expect(receiptEl()).toBeNull(); // A 的 receipt 不冒充 B 状态
  });

  it("R6: 新 selection 清旧 receipt（B 建立时 A 的 receipt 消失，不干扰新 pending）", async () => {
    const { hostSel } = installFetch({ lanes: { [L1]: keyed("R6A", kA) + "\n\n" + keyed("R6B", kB) } });
    await mountOpen();
    // A: 选 R6A → 成功 receipt 显示
    const cbA = selCheckboxOf("R6A");
    await waitFor(() => expect(cbA.disabled).toBe(false));
    fireEvent.click(cbA);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    hostSel.pending = null;
    hostSel.lastBinding = { ok: true, generation: 1, noteCount: 1 };
    await tick();
    await waitFor(() => expect(receiptEl()).toBeTruthy(), { timeout: 3000 });
    expect(receiptText()).toContain("已将 1 条便签附到刚才的消息");
    // B: 立即建新 selection（R6B）→ 旧 receipt 清除、不干扰新 pending
    const cbB = selCheckboxOf("R6B");
    fireEvent.click(cbB);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    expect(receiptEl()).toBeNull(); // 旧 receipt 已清
    expect(trayText()).not.toContain("已将"); // tray 是 pending 态，不是旧 success
  });

  it("R7: success receipt 数秒后降级为低强调'已随消息引用 N 条'", async () => {
    const { hostSel } = installFetch({ lanes: { [L1]: keyed("R7A", kA) } });
    await mountOpen();
    const cb = selCheckboxOf("R7A");
    await waitFor(() => expect(cb.disabled).toBe(false));
    fireEvent.click(cb);
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    hostSel.pending = null;
    hostSel.lastBinding = { ok: true, generation: 1, noteCount: 1 };
    await tick();
    await waitFor(() => expect(receiptText()).toContain("已将 1 条便签附到刚才的消息"), { timeout: 3000 });
    // 等降级窗口（receipt MS=300）→ 低强调"已随消息引用 1 条便签"
    await tick(600);
    await waitFor(() => expect(receiptText()).toContain("已随消息引用 1 条便签"), { timeout: 3000 });
    expect(receiptText()).not.toContain("✓");
  });

  it("R8 (reload): host pending 重水合期间不凭空制造 success receipt（无 lastBinding 不显示）", async () => {
    // host pending 存在但 lastBinding null（hydration 未知窗口）→ 只显示 tray，无 receipt
    const hostSel = makeHostSel();
    hostSel.pending = { generation: 1, targets: [{ laneKey: L1, itemKey: kA }] };
    installFetch({ lanes: { [L1]: keyed("R8A", kA) }, hostSel });
    await mountOpen();
    await waitFor(() => expect(trayText()).toContain("已选 1 条"));
    expect(receiptEl()).toBeNull(); // 无 lastBinding → 无 success receipt
  });
});

// behavior regression production 长会话回归：capture 从 assistant-step 容器（真实全局 turn）→
// proposal → Save。模拟 host session.history 返回**有界窗口**（turn 393..398），
// DOM 容器用 renderer 全局 turn（assistant-step397:13）——修复前 asmIndex 1..N
// 无法命中 → 报 "no matching event in snapshot"。
describe("behavior regression bounded-window assistant capture（真实全局 turn）", () => {
  const SESSION_L = "session-long-0001-0001";
  const LONG_EVENTS = [
    { event: { seq: 5697000, type: "user/message", data: { id: "u-393", content: [{ type: "text", text: "USER-393" }], source: { kind: "user" } } } },
    { event: { seq: 5697300, type: "assistant/message", data: { turn: 397, step: 13, message: { content: [{ type: "text", text: "PROD-SELECTED-TEXT-397" }] } } } },
    { event: { seq: 5697400, type: "user/message", data: { id: "u-398", content: [{ type: "text", text: "USER-398" }], source: { kind: "user" } } } },
  ];

  it("capture assistant-step397:13（长会话有界窗口）→ proposal → Save", async () => {
    const host = document.createElement("div");
    // DOM 容器 = renderer 全局身份（与真实 3080 报错同形态：14:assistant-step397:13）
    host.innerHTML = '<div data-chat-anchor-key="14:assistant-step397:13">PROD-SELECTED-TEXT-397</div>';
    document.body.appendChild(host);
    const anchorEl = host.querySelector("[data-chat-anchor-key]");
    const range = document.createRange();
    range.setStart(anchorEl.firstChild, 0);
    range.setEnd(anchorEl.firstChild, 22); // "PROD-SELECTED-TEXT-397".length
    vi.stubGlobal("getSelection", vi.fn(() => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range })));

    const fetchFn = vi.fn((u, opts) => {
      const url = String(u);
      if (url.includes("/api/session.history")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ type: "server-response", result: { ok: true, value: { events: LONG_EVENTS } } }) });
      }
      if (url.includes("/notes-api/anchored/validate")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, validated: { sessionId: SESSION_L, projectionVersion: 2, segments: [{ eventSeq: 5697300, start: 0, end: 22 }], effectiveSourceText: "PROD-SELECTED-TEXT-397", unresolved: [], sourcePayload: { projectionVersion: 2, sessionId: SESSION_L, segments: [{ eventSeq: 5697300, start: 0, end: 22 }] } } }) });
      }
      if (url.includes("/notes-api/anchored/prepare")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, block: "--- dsh-note v1 begin\ndsh-meta kind: source-aware\ndsh-meta origin: " + SESSION_L + "\n--- dsh-body\nPROD-SELECTED-TEXT-397\n--- dsh-note v1 end", validated: {} }) });
      }
      if (opts?.method === "PUT") return Promise.resolve(makeResponse("ok", { mtime: "2222" }));
      return Promise.resolve(makeResponse("", { mtime: "1111" }));
    });
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("confirm", vi.fn(() => true));

    const { apply } = loader.factory((id) => { if (id === "react") return React; throw new Error(`unexpected require: ${id}`); });
    let registered = null;
    const ctx = { slots: { inject: (_n, fn) => { registered = fn(); }, register: (cfg, C) => ({ cfg, Component: C }) } };
    apply(ctx, React);
    const view = render(React.createElement(registered.Component, { sessionId: SESSION_L }));
    fireEvent.click(screen.getByTitle("协作便签"));
    await waitFor(() => screen.getByRole("textbox"));
    // 点「引用选中到便签」→ 修复前这里会报 "无法引用这段文本：…no matching event"
    const attachBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("引用选中到便签"));
    expect(attachBtn).toBeTruthy();
    fireEvent.click(attachBtn);
    // 修复后：capture 成功 → composer 出现"引用的原文"（不再 attachHint 报错）
    await waitFor(() => expect(screen.getByText(/已引用选中文本/)).toBeTruthy(), { timeout: 3000 });
    expect(document.body.textContent).not.toContain("无法引用这段文本");
    host.remove();
    view.unmount();
    cleanup();
  });
});
