import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "i18n.js"), "utf8");
const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem() {} },
  document: {
    querySelectorAll: () => [],
    getElementById: () => null,
    documentElement: { lang: "en" },
    title: "",
  },
};
sandbox.globalThis = sandbox;
runInContext(src, createContext(sandbox));

test("genreOptionLabel appends spectrum color for shared axis", () => {
  sandbox.setLang("en");
  assert.equal(sandbox.genreOptionLabel("Dub"), "Dub — Red-Orange");
  assert.equal(sandbox.genreOptionLabel("Jungle"), "Jungle — Cyan");
  assert.equal(sandbox.genreOptionLabel("Dubstep"), "Dubstep — Blue");
});

test("genreOptionLabel leaves non-genre enums alone", () => {
  assert.equal(sandbox.genreOptionLabel("Depth"), "Depth");
  assert.equal(sandbox.genreOptionLabel(""), "");
});

test("genreOptionLabel follows DE / FR", () => {
  sandbox.setLang("de");
  assert.equal(sandbox.genreOptionLabel("House"), "House — Gelb");
  sandbox.setLang("fr");
  assert.equal(sandbox.genreOptionLabel("UK Garage"), "UK Garage — Bleu ciel");
});
