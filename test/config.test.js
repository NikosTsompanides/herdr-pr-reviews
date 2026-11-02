import { expect, test } from "bun:test";
import { fill, argv, parseRoots, resolve, repoOf, DEFAULTS, DEFAULT_TEMPLATE } from "../mods/pr-reviews/config.js";

test("repoOf reads GitHub remotes in every URL shape", () => {
  expect(repoOf("https://github.com/Acme/App.git")).toBe("acme/app");
  expect(repoOf("https://github.com/acme/app/")).toBe("acme/app");
  expect(repoOf("git@github.com:acme/app.git")).toBe("acme/app");
  expect(repoOf("ssh://git@github.com:22/acme/app.git")).toBe("acme/app");
  expect(repoOf("git@github-work:acme/app")).toBe("acme/app");
  expect(repoOf("git@gitlab.com:acme/app.git")).toBe(null);
  expect(repoOf(undefined)).toBe(null);
});

test("default template leaves out author-written fields and marks PR content untrusted", () => {
  expect(DEFAULT_TEMPLATE).not.toContain("{title}");
  expect(DEFAULT_TEMPLATE).not.toContain("{branch}");
  expect(DEFAULT_TEMPLATE).toContain("untrusted");
  expect(argv(DEFAULTS.agent)).toEqual(["claude", "--setting-sources", "user"]);
});

const pr = { url: "https://github.com/o/r/pull/7", number: 7, repo: "o/r", title: "Fix it", author: "ana", head: "fix/it" };

test("fill replaces every variable", () => {
  expect(fill("/ce-code-review {url}", pr)).toBe("/ce-code-review https://github.com/o/r/pull/7");
  expect(fill("{repo}#{number} {title} by {author} on {branch}", pr)).toBe("o/r#7 Fix it by ana on fix/it");
});

test("fill leaves unknown and missing variables as written", () => {
  expect(fill("{nope} {url}", pr)).toBe("{nope} https://github.com/o/r/pull/7");
  expect(fill("{branch}", { ...pr, head: undefined })).toBe("{branch}");
});

test("argv splits words and keeps quoted groups", () => {
  expect(argv("claude")).toEqual(["claude"]);
  expect(argv(`codex --model "o 5" -c 'a b'`)).toEqual(["codex", "--model", "o 5", "-c", "a b"]);
  expect(argv("   ")).toEqual([]);
});

test("parseRoots trims, strips ~ and dedupes", () => {
  expect(parseRoots("~, Desktop , ~/code/, code")).toEqual(["", "Desktop", "code"]);
});

test("resolve falls back to defaults for empty or malformed settings", () => {
  expect(resolve(null)).toEqual(DEFAULTS);
  expect(resolve({ template: "  ", agent: " ", roots: "x" })).toEqual(DEFAULTS);
  expect(resolve({ template: "t", agent: "codex", roots: ["a", 1] })).toEqual({ template: "t", agent: "codex", roots: ["a"] });
});
