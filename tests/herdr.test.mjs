import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, symlinkSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeDescriptor } from "../extensions/herdr.ts";
import { HerdrBridge, caller, directChildren, decodeSnapshot, roleFor, quote } from "../extensions/herdr.ts";

const root = "root-1", sid = "child-1";
const binding = { socket: "/tmp/prime-explicit.sock", launcher: "/bin/sh" };
const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr-explicit.sock" };
const models = { author: "acme/sol", reviewer: "acme/luna" };
const parent = { sessionId: root, rlmDepth: 0, runtimeKind: "top-level", lifecycle: "live" };
const child = { sessionId: sid, parentSessionId: root, rlmDepth: 1, rlmChildId: "sub-1", runtimeKind: "subagent", lifecycle: "live", sessionName: "sol-fix", cwd: "/tmp", model: { provider: "acme", id: "sol" } };
function mock() {
  const calls = [], panes = new Map([["w1:p1", { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", tokens: {} }]]);
  let sessions = [parent, child], failure;
  const transport = async (binary, args, metadata) => {
    calls.push([binary, args, metadata]);
    if (binary === binding.launcher) { assert.deepEqual(args, ["list", "--json", "--daemon-socket", binding.socket]); return { sessions }; }
    assert.equal(binary, "herdr");
    const [group, command, ...rest] = args;
    assert.equal(group, "pane");
    if (command === "get") { if (failure === command) { failure = undefined; throw Error("mock get failed"); } return { result: { pane: panes.get(rest[0]) } }; }
    if (command === "split") { assert.deepEqual(rest.slice(0, 2), ["--pane", "w1:p1"]); const pane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", tokens: {} }; panes.set(pane.pane_id, pane); return { result: { pane } }; }
    const pane = panes.get(rest[0]);
    if (failure === command) { failure = undefined; throw Error(`mock ${command} failed`); }
    if (command === "report-metadata") { for (let i=1;i<rest.length;i++) if (rest[i] === "--token") pane.tokens.router_owner = rest[i+1].split("=")[1]; return { result: {} }; }
    if (command === "run") { assert.match(rest[1], /^exec '\/bin\/sh' attach 'child-1' --daemon-socket '\/tmp\/prime-explicit\.sock'$/); return { result: {} }; }
    if (command === "report-agent") { assert.ok(rest.includes("unknown")); return { result: {} }; }
    if (command === "close") { panes.delete(rest[0]); return { result: {} }; }
    throw Error(`unsupported: ${command}`);
  };
  return { calls, panes, transport, setSessions: (value) => { sessions = value; }, fail: (name) => { failure = name; } };
}

test("caller rejects outside Herdr, missing socket, wrong tab, and nonexecutable launcher", () => {
  assert.throws(() => caller({}, root, binding), /HERDR_ENV/);
  assert.equal(quote("/tmp/a'b"), "'/tmp/a'\"'\"'b'");
  assert.throws(() => caller({ ...env, HERDR_SOCKET_PATH: "" }, root, binding), /HERDR_SOCKET_PATH/);
  assert.throws(() => caller({ ...env, HERDR_TAB_ID: "w2:t1" }, root, binding), /Caller-bound/);
  assert.throws(() => caller(env, root, { ...binding, launcher: "/tmp/no-such-launcher" }), /not executable/);
});
test("authoritative native roster is parent bound and role assignment is exact and unambiguous", () => {
  assert.deepEqual(directChildren({ sessions: [parent, child] }, root), [child]);
  assert.throws(() => directChildren({ sessions: [child] }, root), /current live root/);
  assert.equal(roleFor("acme/sol", models), "author");
  assert.equal(roleFor("acme/sol", { author: "acme/sol", reviewer: "acme/sol" }), "worker");
  assert.equal(roleFor("other/model", models), "worker");
  assert.throws(() => decodeSnapshot({ version: 1, enabled: true, viewers: [{ child: "x" }] }), /Invalid/);
});
test("viewer attaches exact child, reports metadata and unknown, sync is idempotent; off checks owner", async () => {
  const m = mock(), saved = [];
  const b = new HerdrBridge(m.transport, env, (s) => saved.push(s));
  await b.on(root, models, binding);
  assert.equal(b.viewers.size, 1);
  assert.ok(m.calls.some(([, args]) => args[1] === "report-agent"));
  const splitCount = m.calls.filter(([, args]) => args[1] === "split").length;
  await b.sync(root, models);
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, splitCount);
  const restored = new HerdrBridge(m.transport, env, () => {}, decodeSnapshot(saved.at(-1)));
  await restored.off(root);
  assert.equal(m.panes.has("w1:p2"), false);
  assert.equal(m.panes.has("w1:p1"), true);
});
test("missing ownership token never closes an existing pane", async () => {
  const m = mock(), b = new HerdrBridge(m.transport, env);
  await b.on(root, models, binding);
  m.panes.get("w1:p2").tokens.router_owner = "different-owner";
  await b.off(root);
  assert.equal(m.panes.has("w1:p2"), true);
  assert.equal(m.calls.filter(([, args]) => args[1] === "close").length, 0);
});
test("split metadata failure closes only its freshly created pane", async () => {
  const m = mock(), b = new HerdrBridge(m.transport, env);
  m.fail("report-metadata");
  await assert.rejects(b.on(root, models, binding), /mock report-metadata failed/);
  assert.equal(m.panes.has("w1:p2"), false);
  assert.equal(b.viewers.size, 0);
});
test("terminal child removal closes verified viewer; wrong daemon parent creates none", async () => {
  const m = mock(), b = new HerdrBridge(m.transport, env);
  await b.on(root, models, binding);
  m.setSessions([parent]); await b.sync(root, models);
  assert.equal(m.panes.has("w1:p2"), false);
  const bad = mock(), b2 = new HerdrBridge(bad.transport, env);
  bad.setSessions([child]); await assert.rejects(b2.on(root, models, binding), /current live root/);
  assert.equal(bad.calls.filter(([, args]) => args[1] === "split").length, 0);
});


test("extension opt-in command and public parent events reconcile without timers or child spawn", async () => {
  const { default: router } = await import("../extensions/router.ts");
  const m = mock(), handlers = {}, entries = [], notices = [];
  let command;
  const pi = { on: (name, handler) => { handlers[name] = handler; }, registerCommand: (_, spec) => { command = spec; },
    appendEntry: (customType, data) => { entries.push({ type: "custom", customType, data }); }, sendUserMessage: () => assert.fail("must not start child") };
  router(pi, (persist, saved) => new HerdrBridge(m.transport, env, persist, saved));
  const ctx = { sessionManager: { getHeader: () => ({ rlmDepth: 0 }), getSessionId: () => root, getBranch: () => entries },
    model: { provider: "openai-codex", id: "gpt-6-astra" }, ui: { notify: (...x) => notices.push(x) } };
  await command.handler("herdr on /tmp/prime-explicit.sock /bin/sh", ctx);
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, 1);
  assert.ok(entries.some((e) => e.customType === "router-herdr-v1" && e.data.enabled));
  handlers.tool_execution_end({}, ctx);
  handlers.agent_end({}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, 1);
  await command.handler("herdr off", ctx);
  assert.equal(m.panes.has("w1:p2"), false);
  assert.equal(notices.at(-1)[1], "info");
});

test("off still attempts owned-pane cleanup if an in-flight sync fails", async () => {
  const m = mock(), b = new HerdrBridge(m.transport, env);
  await b.on(root, models, binding);
  m.fail("get");
  const pending = b.sync(root, models);
  await assert.rejects(b.off(root), /pending sync/);
  await assert.rejects(pending, /mock get failed/);
  assert.equal(m.panes.has("w1:p2"), false);
});

test("outside Herdr on fails before any Prime or Herdr transport", async () => {
  const calls = [];
  const b = new HerdrBridge(async (...args) => { calls.push(args); throw Error("transport must not run"); }, {});
  await assert.rejects(b.on(root, models, binding), /HERDR_ENV/);
  assert.deepEqual(calls, []);
  assert.equal(b.enabled, false);
});
test("malformed direct child fails before pane split", async () => {
  const m = mock(), b = new HerdrBridge(m.transport, env);
  m.setSessions([parent, { ...child, model: undefined }]);
  await assert.rejects(b.on(root, models, binding), /lacks authoritative/);
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, 0);
});

const helper = new URL("../bin/herdr-bind.mjs", import.meta.url).pathname;
function descriptor(rootId = root) {
  return execFileSync(process.execPath, [helper, rootId, binding.socket, binding.launcher], { env: { ...process.env, ...env }, encoding: "utf8" }).trim();
}
test("terminal helper refuses missing real inherited Herdr environment", () => {
  assert.throws(() => execFileSync(process.execPath, [helper, root, binding.socket, binding.launcher],
    { env: { PATH: process.env.PATH }, stdio: "pipe" }), /Herdr pane/);
});
test("one-use descriptor enforces root, ownership, perms, symlink, and expiry", () => {
  const path = descriptor();
  assert.throws(() => consumeDescriptor(path, "another-root"), /cross-session/);
  assert.throws(() => consumeDescriptor(path, root), /ENOENT/);
  const weak = descriptor(); chmodSync(weak, 0o644);
  assert.throws(() => consumeDescriptor(weak, root), /Unsafe Router descriptor file/);
  rmSync(join(weak, ".."), { recursive: true, force: true });
  const oversized = descriptor(); writeFileSync(oversized, "x".repeat(4097));
  assert.throws(() => consumeDescriptor(oversized, root), /too large/);
  assert.throws(() => consumeDescriptor(oversized, root), /ENOENT/);
  const expired = descriptor();
  const data = JSON.parse(readFileSync(expired, "utf8")); data.expiresAt = Date.now() - 1;
  writeFileSync(expired, JSON.stringify(data));
  assert.throws(() => consumeDescriptor(expired, root), /expired/);
  const original = descriptor();
  const dir = mkdtempSync(join(tmpdir(), "router-symlink-")); chmodSync(dir, 0o700);
  symlinkSync(original, join(dir, "binding.json"));
  assert.throws(() => consumeDescriptor(join(dir, "binding.json"), root), /Unsafe Router descriptor file/);
  rmSync(dir, { recursive: true, force: true }); rmSync(join(original,".."), { recursive: true, force: true });
});
test("bound context is session-specific and passed to each transport without mutating shared env", async () => {
  const m = mock(), scoped = [];
  const b = new HerdrBridge(async (binary, args, scopedEnv) => { scoped.push(scopedEnv); return m.transport(binary, args); }, {});
  const before = process.env.HERDR_PANE_ID;
  await b.bind(root, models, descriptor());
  assert.equal(b.viewers.size, 1);
  assert.ok(scoped.every((e) => e?.HERDR_PANE_ID === env.HERDR_PANE_ID));
  assert.equal(process.env.HERDR_PANE_ID, before);
  await assert.rejects(b.sync("another-root", models), /another root session/);
  const restored = new HerdrBridge(m.transport, {}, () => {}, decodeSnapshot(b.snapshot()));
  await restored.sync(root, models);
  await restored.off(root);
  assert.equal(m.panes.has("w1:p2"), false);
  assert.throws(() => consumeDescriptor("/tmp/absent/binding.json", root));
});

test("extension bind routes descriptor and existing root without any child spawn", async () => {
  const { default: router } = await import("../extensions/router.ts");
  const m = mock(), entries = [], notices = [];
  let command;
  const pi = { on: () => {}, registerCommand: (_, spec) => { command = spec; },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: () => assert.fail("cannot create a new agent") };
  router(pi, (persist, saved) => new HerdrBridge(m.transport, {}, persist, saved));
  const ctx = { sessionManager: { getHeader: () => ({ rlmDepth: 0 }), getSessionId: () => root, getBranch: () => entries },
    model: { provider: "openai-codex", id: "gpt-6-astra" }, ui: { notify: (...args) => notices.push(args) } };
  await command.handler(`herdr bind ${descriptor()}`, ctx);
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, 1);
  assert.equal(notices.at(-1)[1], "info");
  await command.handler("herdr off", ctx);
  assert.equal(m.panes.has("w1:p2"), false);
});


test("bare command uses only authenticated invoking metadata, not worker environment", async () => {
  const { default: router } = await import("../extensions/router.ts");
  const m = mock(), handlers = {}, entries = [], notices = [];
  let command, invoking = { env: { ...env }, daemonSocketPath: binding.socket, launcherPath: binding.launcher };
  const pi = { on: (name, handler) => { handlers[name] = handler; }, registerCommand: (_, spec) => { command = spec; },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), sendUserMessage: () => assert.fail("must not start child") };
  router(pi, (persist, saved) => new HerdrBridge(m.transport, {}, persist, saved));
  const ctx = { sessionManager: { getHeader: () => ({ rlmDepth: 0 }), getSessionId: () => root, getBranch: () => entries },
    getInvokingClientContext: () => invoking, model: { provider: "openai-codex", id: "gpt-6-astra" },
    ui: { notify: (...x) => notices.push(x) } };
  await command.handler("herdr on", { ...ctx, getInvokingClientContext: undefined });
  assert.match(notices.at(-1)[0], /invoking-client context capability/);
  await command.handler("herdr on", { ...ctx, getInvokingClientContext: () => undefined });
  assert.match(notices.at(-1)[0], /Herdr client invoking this command/);
  await command.handler("herdr on", { ...ctx, sessionManager: { ...ctx.sessionManager, getHeader: () => ({ rlmDepth: 1 }) } });
  assert.equal(m.calls.length, 0);
  invoking = { ...invoking, env: { ...env, HERDR_ENV: "" } };
  await command.handler("herdr on", ctx);
  assert.match(notices.at(-1)[0], /HERDR_ENV/);
  assert.equal(m.calls.length, 0);
  invoking = { env: { ...env }, daemonSocketPath: binding.socket, launcherPath: binding.launcher };
  await command.handler("herdr on", ctx);
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, 1);
  assert.ok(m.calls.every(([, , actual]) => actual?.HERDR_PANE_ID === env.HERDR_PANE_ID));
  invoking.env.HERDR_PANE_ID = "w1:p9"; // The host's per-command value must not mutate persisted ownership.
  assert.equal(entries.at(-1).data.context.env.HERDR_PANE_ID, "w1:p1");
  await command.handler("herdr on", ctx);
  assert.match(notices.at(-1)[0], /another caller/);
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, 1);
  await command.handler("herdr off", ctx);
  assert.equal(m.panes.has("w1:p2"), false);
});

test("invoking metadata rebind refuses a different pane when ownership is restored", async () => {
  const m = mock(), saved = [];
  const b = new HerdrBridge(m.transport, {}, (state) => saved.push(state));
  await b.onInvoking(root, models, { env, daemonSocketPath: binding.socket, launcherPath: binding.launcher });
  const restored = new HerdrBridge(m.transport, {}, () => {}, decodeSnapshot(saved.at(-1)));
  await assert.rejects(restored.onInvoking(root, models, { env: { ...env, HERDR_PANE_ID: "w1:p9" }, daemonSocketPath: binding.socket, launcherPath: binding.launcher }), /another caller/);
  assert.equal(restored.viewers.size, 1);
  assert.equal(m.calls.filter(([, args]) => args[1] === "split").length, 1);
  await restored.off(root);
});


test("invoking Herdr socket is part of immutable caller identity before transport or mutation", async () => {
  const m = mock(), saved = [];
  const b = new HerdrBridge(m.transport, {}, (state) => saved.push(state));
  await b.onInvoking(root, models, { env, daemonSocketPath: binding.socket, launcherPath: binding.launcher });
  const before = structuredClone(b.snapshot()), callCount = m.calls.length, saveCount = saved.length;
  await assert.rejects(b.onInvoking(root, models, { env: { ...env, HERDR_SOCKET_PATH: "/tmp/another-herdr.sock" }, daemonSocketPath: binding.socket, launcherPath: binding.launcher }), /another caller/);
  assert.deepEqual(b.snapshot(), before);
  assert.equal(m.calls.length, callCount);
  assert.equal(saved.length, saveCount);
  await b.off(root);
});

test("enabled context with zero viewers cannot change any Herdr identity or transport", async () => {
  const m = mock(); m.setSessions([parent]);
  const b = new HerdrBridge(m.transport, {});
  await b.onInvoking(root, models, { env, daemonSocketPath: binding.socket, launcherPath: binding.launcher });
  assert.equal(b.viewers.size, 0);
  const before = structuredClone(b.snapshot()), callCount = m.calls.length;
  for (const changed of [
    { env: { ...env, HERDR_SOCKET_PATH: "/tmp/different.sock" }, daemonSocketPath: binding.socket, launcherPath: binding.launcher },
    { env, daemonSocketPath: "/tmp/different-prime.sock", launcherPath: binding.launcher },
    { env: { ...env, HERDR_PANE_ID: "w1:p9" }, daemonSocketPath: binding.socket, launcherPath: binding.launcher },
  ]) {
    await assert.rejects(b.onInvoking(root, models, changed), /Turn Herdr off/);
    assert.deepEqual(b.snapshot(), before);
    assert.equal(m.calls.length, callCount);
  }
  await b.off(root);
});

test("contextless explicit-on snapshot fails closed instead of adopting a new invoking client", async () => {
  const m = mock(), legacy = new HerdrBridge(m.transport, env);
  await legacy.on(root, models, binding);
  const restored = new HerdrBridge(m.transport, env, () => {}, decodeSnapshot(legacy.snapshot()));
  const before = structuredClone(restored.snapshot()), callCount = m.calls.length;
  await assert.rejects(restored.onInvoking(root, models, { env, daemonSocketPath: binding.socket, launcherPath: binding.launcher }), /no saved caller identity.*off from the original caller/);
  assert.deepEqual(restored.snapshot(), before);
  assert.equal(m.calls.length, callCount);
  await restored.off(root);
});
