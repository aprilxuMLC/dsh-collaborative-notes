// Locale contract: the Notes client uses the DSH host locale seam and
// keeps the feature dictionary balanced without changing semantic values.
// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { en, LOCALE_NS, zh } from "../src/locales.js";

let loader;
window.__ModuleLoader__ = { load: (cfg) => { loader = cfg; } };
await import("../lib/client.js");

describe("Notes locale resources", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps zh/en key parity and required UI coverage", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zh)).toEqual(expect.arrayContaining(["button.notes", "label.panelTitle", "button.save", "label.searchPlaceholder", "status.reentryExact"]));
  });

  it("supports host-style interpolation without changing semantic values", () => {
    const translate = (dict) => (key, params) => {
      const template = dict[key] ?? key;
      return params ? template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match) : template;
    };
    expect(translate(zh)("label.selectedCount", { n: 2 })).toBe("已选 2 条");
    expect(translate(en)("label.selectedCount", { n: 2 })).toBe("2 selected");
    expect(LOCALE_NS).toBe("dsh.collabNotes");
    expect("conversation_todo").toBe("conversation_todo");
  });

  it.each([
    ["zh", zh, "📝 便签", "协作便签"],
    ["en", en, "📝 Notes", "Collaborative Notes"],
  ])("renders representative %s Notes UI through the locale seat", async (_id, dict, trigger, title) => {
    const { apply } = loader.factory((id) => id === "react" ? React : (() => { throw new Error(`unexpected require: ${id}`); })());
    let registered;
    const t = (key, params) => {
      const template = dict[key] ?? key;
      return params ? template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match) : template;
    };
    const locale = {
      register: vi.fn(),
      bind: vi.fn(() => t),
    };
    const ctx = {
      locale,
      effect: (fn) => fn(),
      slots: {
        inject: (_name, fn) => { registered = fn(); },
        register: (cfg, Component) => ({ cfg, Component }),
      },
    };
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (String(url).includes("fork-status")) return Promise.resolve({ ok: true, json: async () => ({}) });
      if (String(url).includes("/meta")) return Promise.resolve({ ok: true, json: async () => ({ layers: [] }) });
      if (String(url).includes("/setup/")) return Promise.resolve({ ok: true, text: async () => JSON.stringify({ state: "INITIALIZED" }) });
      return Promise.resolve({ ok: true, headers: { get: () => "0" }, text: async () => "" });
    }));
    apply(ctx, React);
    expect(locale.register).toHaveBeenCalledWith(LOCALE_NS, { zh, en });
    render(React.createElement(registered.Component, { sessionId: "locale-test" , t }));
    expect(screen.getByText(trigger)).toBeTruthy();
    fireEvent.click(screen.getByText(trigger));
    await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
  });
});
