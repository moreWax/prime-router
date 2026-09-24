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
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=22.19.0");
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/moreWax/prime-router.git",
  });
  assert.equal(pkg.homepage, "https://github.com/moreWax/prime-router#readme");
  assert.deepEqual(pkg.bugs, { url: "https://github.com/moreWax/prime-router/issues" });
  assert.deepEqual(pkg.pi, {
    extensions: ["./extensions/router.ts"],
    skills: ["./skills/router"],
  });
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(pkg.peerDependenciesMeta["@earendil-works/pi-coding-agent"].optional, true);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  for (const field of ["name", "version", "license", "engines", "devDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    assert.deepEqual(lock.packages[""][field], pkg[field], `lockfile root ${field} differs from package.json`);
  }
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
  const files = packs[0].files.map((file) => file.path).sort();
  assert.deepEqual(files, expectedFiles);
  for (const path of files) {
    assert.doesNotMatch(path, /(?:^|\/)(?:\.prime|\.router|\.astra|node_modules|tests?|logs?)(?:\/|$)|\.(?:log|tgz)$/i);
  }
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

test("architecture includes a closed Mermaid diagram", () => {
  const architecture = readFileSync(resolve(root, "ARCHITECTURE.md"), "utf8");
  const fences = [...architecture.matchAll(/^(`{3,}|~{3,})([^\n]*)\n/gm)];
  let mermaidDiagrams = 0;
  let open;
  for (const [, marker, info] of fences) {
    if (open) {
      assert.equal(marker[0], open.marker[0], "architecture fence delimiter differs");
      assert.ok(marker.length >= open.marker.length, "architecture closing fence is too short");
      assert.equal(info.trim(), "", "architecture closing fence has an info string");
      open = undefined;
    } else {
      if (/^mermaid(?:\s|$)/i.test(info.trim())) mermaidDiagrams++;
      open = { marker };
    }
  }
  assert.equal(open, undefined, "architecture code fence was not closed");
  assert.ok(mermaidDiagrams > 0, "architecture lacks a Mermaid diagram");
});
