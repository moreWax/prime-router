import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const expectedFiles = [
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "GETTING_STARTED.md",
  "LICENSE.md",
  "README.md",
  "SECURITY.md",
  "bin/herdr-bind.mjs",
  "extensions/router.ts",
  "extensions/herdr.ts",
  "package.json",
  "skills/router/SKILL.md",
].sort();

test("manifest and lockfile preserve private MIT package and supported Node floor", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.engines.node, ">=22.19.0");
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  assert.equal(lock.packages[""].license, pkg.license);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.deepEqual([...pkg.files].sort(), expectedFiles.filter((path) => path !== "package.json"));
});

test("npm pack includes only the intended runtime and documentation files", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
  const packs = JSON.parse(output);
  assert.equal(packs.length, 1);
  assert.deepEqual(packs[0].files.map((file) => file.path).sort(), expectedFiles);
});

test("local documentation links resolve to packed files", () => {
  const packed = new Set(expectedFiles);
  for (const doc of expectedFiles.filter((path) => path.endsWith(".md"))) {
    const source = readFileSync(resolve(root, doc), "utf8");
    for (const [, target] of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(target)) continue;
      const linked = target.split("#", 1)[0];
      const destination = resolve(root, dirname(doc), decodeURIComponent(linked));
      assert.ok(existsSync(destination), `${doc}: missing link ${target}`);
      assert.ok(packed.has(relative(root, destination)), `${doc}: link not packed ${target}`);
    }
  }
});
