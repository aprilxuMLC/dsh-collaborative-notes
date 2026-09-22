// Lightweight publish-contract check for CI (no DSH runtime required):
//  1. lib/client.js starts as an IIFE and registers exactly once via
//     ModuleLoader with id === package name;
//  2. lib/index.js parses and exports apply/inject/Config.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const client = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

assert.match(client, /\(\(\) => \{/, "client bundle must be wrapped in an IIFE");
const loads = client.match(/window\.__ModuleLoader__\.load\(\{/g) ?? [];
assert.equal(loads.length, 1, "client bundle must call ModuleLoader.load exactly once");
assert.match(
  client,
  new RegExp(`id:\\s*"${pkg.name}"`),
  "ModuleLoader registration id must equal the package name"
);

const mod = await import("../lib/index.js");
assert.equal(typeof mod.apply, "function", "host must export apply");
assert.ok(
  Array.isArray(mod.inject) && mod.inject.includes("connection"),
  "host inject must declare the current Connection carrier"
);
assert.ok(mod.Config, "host must export a Config schema");

console.log(`✓ bundle contract OK (id: ${pkg.name})`);
