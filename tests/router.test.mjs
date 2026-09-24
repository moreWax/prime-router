import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import router, { ASTRA_MODEL, BUILT_IN, CHILD_MODELS, WORKFLOW_MARKER, automaticPrompt, taskPrompt, workflowInstructions, configPath, readDefaults, saveDefaults } from "../extensions/router.ts";

function setup({
  model = { provider: "openai-codex", id: "gpt-6-astra" },
  available = ["gpt-5.6-sol", "gpt-5.6-luna"],
  idle = true,
  depth = 0,
  hasUI = false,
  choices = [],
} = {}) {
  let command;
  const entries = [];
  let leaf = null;
  const selections = [...choices];
  let beforeAgentStart;
  let contextHandler;
  let sessionStart;
  const sent = [];
  const notices = [];
  const pi = {
    on(name, handler) {
      if (name === "before_agent_start") beforeAgentStart = handler;
      else if (name === "context") contextHandler = handler;
      else if (name === "session_start") sessionStart = handler;
      else if (name === "tool_execution_end" || name === "agent_end" || name === "session_shutdown") { /* tested separately */ }
      else assert.fail(`unsupported hook: ${name}`);
    },
    registerCommand(name, opts) { assert.equal(name, "router"); command = opts; },
    sendUserMessage(...args) { sent.push(args); },
    appendEntry(customType, data) { const entry = { type: "custom", customType, data, id: `entry-${entries.length}`, parentId: leaf }; entries.push(entry); leaf = entry.id; },
    setModel() { throw new Error("should not change parent model"); },
  };
  router(pi);
  const ctx = {
    model,
    hasUI,
    sessionManager: { getHeader: () => ({ rlmDepth: depth, parentSession: "fork-from-user-session" }), getSessionId: () => "test-root", getBranch: () => { const branch = []; let id = leaf; while (id !== null) { const entry = entries.find((item) => item.id === id); branch.unshift(entry); id = entry.parentId; } return branch; } },
    modelRegistry: { getExecutableModels: async () => available.map((id) => ({ provider: "openai-codex", id })) },
    isIdle: () => idle,
    ui: { notify: (...args) => notices.push(args), select: async () => selections.shift() },
  };
  return { entries, setLeaf: (id) => { leaf = id; }, command, get beforeAgentStart() { return beforeAgentStart; }, get contextHandler() { return contextHandler; }, get sessionStart() { return sessionStart; }, ctx, sent, notices };
}

test("manifest includes Prime extension and workflow skill", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.deepEqual(pkg.pi.extensions, ["./extensions/router.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills/router"]);
});

test("rejects a non-Astra parent without changing model or creating a task", async () => {
  const app = setup({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } });
  await app.command.handler("write code", app.ctx);
  assert.equal(app.sent.length, 0);
  assert.match(app.notices[0][0], /openai-codex\/gpt-6-astra/);
});

test("rejects an undefined parent model before executable-model lookup", async () => {
  const app = setup();
  app.ctx.model = undefined;
  app.ctx.modelRegistry.getExecutableModels = () => { throw new Error("unexpected lookup"); };
  await app.command.handler("write code", app.ctx);
  assert.deepEqual(app.sent, []);
  assert.equal(app.notices.length, 1);
  assert.match(app.notices[0][0], /Router needs the parent model openai-codex\/gpt-6-astra/);
  assert.equal(app.notices[0][1], "warning");
});

test("refuses to start when executable-model discovery is unavailable", async () => {
  const app = setup();
  delete app.ctx.modelRegistry.getExecutableModels;
  await app.command.handler("write code", app.ctx);
  assert.deepEqual(app.sent, []);
  assert.equal(app.notices.length, 1);
  assert.match(app.notices[0][0], /executable-model discovery.*Update Prime Agent.*no task was started/);
  assert.equal(app.notices[0][1], "error");
});

test("refuses to start when executable-model discovery rejects", async () => {
  const app = setup();
  app.ctx.modelRegistry.getExecutableModels = async () => { throw new Error("catalog offline"); };
  await app.command.handler("write code", app.ctx);
  assert.deepEqual(app.sent, []);
  assert.equal(app.notices.length, 1);
  assert.match(app.notices[0][0], /Router error: Error: catalog offline.*No model or session was switched/);
  assert.equal(app.notices[0][1], "error");
});

test("requires a task", async () => {
  const app = setup();
  await app.command.handler("  ", app.ctx);
  assert.equal(app.sent.length, 0);
  assert.match(app.notices[0][0], /Usage:/);
});

test("refuses to start when required child models are not available", async () => {
  const app = setup({ available: ["gpt-6-sol", "gpt-6-luna"] });
  await app.command.handler("write code", app.ctx);
  assert.equal(app.sent.length, 0);
  assert.match(app.notices[0][0], /openai-codex\/gpt-5.6-sol/);
  assert.match(app.notices[0][0], /openai-codex\/gpt-5.6-luna/);
  assert.match(app.notices[0][0], /No fallback was used/);
});

test("sends workflow to idle Astra without changing session", async () => {
  const app = setup();
  await app.command.handler("  Build a parser  ", app.ctx);
  assert.equal(app.sent.length, 1);
  assert.match(app.sent[0][0], /## Task from the operator\nBuild a parser$/);
  assert.match(app.sent[0][0], /rlm\.spawn/);
  assert.match(app.sent[0][0], /openai-codex\/gpt-5.6-luna/);
  assert.equal(app.sent[0][1], undefined);
});

test("injects exact Sol and Luna roles without switching the parent session", async () => {
  const app = setup();
  const parentModel = app.ctx.model;
  await app.command.handler("Implement and review a parser", app.ctx);

  assert.equal(app.sent.length, 1);
  const [prompt, options] = app.sent[0];
  assert.equal(options, undefined);
  assert.match(prompt, /- `openai-codex\/gpt-5.6-sol`: \*\*code author only\*\*/);
  assert.match(prompt, /- `openai-codex\/gpt-5.6-luna`: \*\*review and test runner only\*\*/);
  assert.deepEqual(
    new Set(prompt.match(/openai-codex\/gpt-[\w.-]+/g)),
    new Set(["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"]),
  );
  assert.match(prompt, /Keep your parent session and model unchanged\./);
  assert.match(prompt, /Never replace, fork, or switch the parent session\./);
  assert.match(prompt, /Never call `pi\.setModel`/);
  assert.strictEqual(app.ctx.model, parentModel);
});

test("queues a follow-up if parent is busy", async () => {
  const app = setup({ idle: false });
  await app.command.handler("Check this", app.ctx);
  assert.deepEqual(app.sent[0][1], { deliverAs: "followUp" });
});

test("workflow metadata is omitted, and blank tasks fail", () => {
  assert.equal(ASTRA_MODEL, "openai-codex/gpt-6-astra");
  assert.deepEqual(CHILD_MODELS, ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"]);
  assert.deepEqual(BUILT_IN, { controller: ASTRA_MODEL, author: CHILD_MODELS[0], reviewer: CHILD_MODELS[1] });
  assert.equal(workflowInstructions("---\nname: x\n---\n\nHello"), "Hello");
  assert.throws(() => taskPrompt(" ", "rules"), /Provide a task/);
});


test("normal Astra turn automatically receives workflow through the registered hook", () => {
  const app = setup();
  const original = "Existing instructions from Prime and earlier extensions";
  const result = app.beforeAgentStart({ prompt: "Implement a parser", systemPrompt: original }, app.ctx);
  assert.ok(result.systemPrompt.startsWith(`${original}\n\n${WORKFLOW_MARKER}\n`));
  assert.match(result.systemPrompt, /openai-codex\/gpt-5.6-sol/);
  assert.match(result.systemPrompt, /openai-codex\/gpt-5.6-luna/);
  assert.match(result.systemPrompt, /On an ordinary coding request/);
  assert.deepEqual(app.sent, []);
});

test("Sol, Luna, unknown and absent models keep the chained prompt unchanged", () => {
  for (const model of [
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "other", id: "gpt-6-astra" },
    undefined,
  ]) {
    const app = setup({ model });
    app.ctx.model = model;
    assert.equal(app.beforeAgentStart({ prompt: "Implement", systemPrompt: "unchanged" }, app.ctx), undefined);
    assert.deepEqual(app.sent, []);
  }
});

test("native result turns carry recovery and continuation instructions without extra messages", () => {
  const app = setup();
  for (const prompt of ["[agent-message from child] finished", "[child-exited: no-reply child:sol-step-1]"]) {
    const result = app.beforeAgentStart({ prompt, systemPrompt: "base" }, app.ctx);
    assert.match(result.systemPrompt, /rlm\.collect\(\[child\], timeout_ms=0\)/);
    assert.match(result.systemPrompt, /Retry a missing report at most twice/);
    assert.match(result.systemPrompt, /Do not stop merely because one child or one test command finished/);
  }
  assert.deepEqual(app.sent, []);
});

test("hook preserves prompt on repeat injection, and direct helper is idempotent", () => {
  const app = setup();
  const once = app.beforeAgentStart({ prompt: "write", systemPrompt: "base" }, app.ctx).systemPrompt;
  const twice = app.beforeAgentStart({ prompt: "write", systemPrompt: once }, app.ctx).systemPrompt;
  assert.equal(once, twice);
  assert.equal(automaticPrompt(once, "new instructions"), "base\n\n[router:auto:v1]\nnew instructions\n[router:end:v1]");
  assert.equal(once.split(WORKFLOW_MARKER).length, 2);
});


test("explicit reply with base system prompt receives transient context instructions", () => {
  const app = setup();
  const original = [{ role: "user", content: "child reported results", timestamp: 1 }];
  app.ctx.getSystemPrompt = () => "Prime base system prompt";
  const first = app.contextHandler({ messages: original }, app.ctx).messages;
  assert.equal(original.length, 1);
  assert.equal(first.length, 2);
  assert.equal(first[1].customType, "router-context");
  assert.match(first[1].content, /Retry a missing report at most twice/);
  assert.equal(app.contextHandler({ messages: first }, app.ctx).messages.length, 2);
  assert.deepEqual(app.sent, []);
});

test("normal injected system prompt needs no duplicate context message", () => {
  const app = setup();
  const prompt = app.beforeAgentStart({ prompt: "Implement", systemPrompt: "base" }, app.ctx).systemPrompt;
  app.ctx.getSystemPrompt = () => prompt;
  const messages = [{ role: "user", content: "Implement", timestamp: 1 }];
  assert.equal(app.contextHandler({ messages }, app.ctx), undefined);
  assert.equal(messages.length, 1);
});

test("context removes Router-only transient instruction after role switch", () => {
  const app = setup();
  app.ctx.getSystemPrompt = () => "base";
  const messages = app.contextHandler({ messages: [{ role: "user", content: "result" }] }, app.ctx).messages;
  app.ctx.model = { provider: "openai-codex", id: "gpt-5.6-sol" };
  assert.deepEqual(app.contextHandler({ messages }, app.ctx).messages, [messages[0]]);
});


test("Router marker and optional slash command use the new public API", async () => {
  assert.equal(WORKFLOW_MARKER, "[router:auto:v1]");
  const app = setup();
  await app.command.handler(" ", app.ctx);
  assert.match(app.notices[0][0], /Usage: \/router <task>/);
  await app.command.handler("Implement", app.ctx);
  assert.match(app.sent[0][0], /Use the Router workflow below/);
});

test("legacy context entries are removed without injecting into non-Astra models", () => {
  const legacy = { role: "custom", customType: "astra-orchestrator-context", content: "old", timestamp: 1 };
  const previous = { role: "custom", customType: "router-context", content: "new", timestamp: 2 };
  const user = { role: "user", content: "reply", timestamp: 3 };
  const app = setup({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } });
  app.ctx.getSystemPrompt = () => "base";
  assert.deepEqual(app.contextHandler({ messages: [legacy, previous, user] }, app.ctx).messages, [user]);
  app.ctx.model = { provider: "openai-codex", id: "gpt-6-astra" };
  const messages = app.contextHandler({ messages: [legacy, previous, user] }, app.ctx).messages;
  assert.deepEqual(messages.slice(0, -1), [user]);
  assert.equal(messages.at(-1).customType, "router-context");
  assert.match(messages.at(-1).content, /\[router:auto:v1\]/);
});


async function temporaryAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "router-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { await run(dir); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("saved defaults are atomic, private, partial, and reject corruption without overwriting", async () => {
  await temporaryAgentDir(async (dir) => {
    const path = configPath();
    assert.equal(path, join(dir, "router", "models.json"));
    assert.deepEqual(readDefaults(), {});
    saveDefaults({ author: "prime-inference/z-ai/glm-5.3" });
    assert.deepEqual(readDefaults(), { author: "prime-inference/z-ai/glm-5.3" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8").includes('"version": 1'), true);
    writeFileSync(path, '{ bad json');
    assert.throws(() => readDefaults(), /corrupt/);
    const app = setup();
    await app.command.handler("default reviewer openai-codex/gpt-5.6-luna", app.ctx);
    assert.equal(readFileSync(path, "utf8"), '{ bad json');
    assert.match(app.notices.at(-1)[0], /corrupt/);
    writeFileSync(path, JSON.stringify({ version: 1, defaults: { alien: "foo/bar" } }));
    assert.throws(() => readDefaults(), /invalid schema/);
  });
});

test("snapshot freezes defaults; override precedence, reset, resume, and branch isolation", async () => {
  await temporaryAgentDir(async () => {
    saveDefaults({ author: "prime-inference/z-ai/glm-5.3" });
    const app = setup({ available: ["gpt-5.6-sol", "gpt-5.6-luna"] });
    app.ctx.modelRegistry.getExecutableModels = async () => [
      { provider: "openai-codex", id: "gpt-5.6-sol" }, { provider: "openai-codex", id: "gpt-5.6-luna" },
      { provider: "prime-inference", id: "z-ai/glm-5.3" },
    ];
    app.sessionStart({}, app.ctx);
    assert.equal(app.entries.length, 1);
    saveDefaults({ author: "openai-codex/gpt-5.6-sol" });
    await app.command.handler("models", app.ctx);
    assert.match(app.notices.at(-1)[0], /prime-inference\/z-ai\/glm-5.3 \(session default snapshot\)/);
    await app.command.handler("model author openai-codex/gpt-5.6-sol", app.ctx);
    assert.match(app.notices.at(-1)[0], /gpt-5.6-sol \(session override\)/);
    const overrideEntry = app.entries.at(-1).id;
    await app.command.handler("reset author", app.ctx);
    assert.match(app.notices.at(-1)[0], /z-ai\/glm-5.3 \(session default snapshot\)/);
    app.setLeaf(overrideEntry);
    await app.command.handler("models", app.ctx);
    assert.match(app.notices.at(-1)[0], /gpt-5.6-sol \(session override\)/);
    app.setLeaf("entry-0");
    await app.command.handler("models", app.ctx);
    assert.match(app.notices.at(-1)[0], /z-ai\/glm-5.3 \(session default snapshot\)/);
    await app.command.handler("default reviewer prime-inference/z-ai/glm-5.3", app.ctx);
    assert.match(app.notices.at(-1)[0], /reviewer: openai-codex\/gpt-5.6-luna/);
    const resumed = setup();
    resumed.ctx.sessionManager = app.ctx.sessionManager;
    await resumed.command.handler("models", resumed.ctx);
    assert.match(resumed.notices.at(-1)[0], /z-ai\/glm-5.3 \(session default snapshot\)/);
  });
});

test("configured selectors appear in task, automatic hook, and explicit-reply context", async () => {
  await temporaryAgentDir(async () => {
    saveDefaults({ controller: "prime-inference/z-ai/glm-5.3", author: "openai-codex/gpt-5.6-luna", reviewer: "openai-codex/gpt-5.6-sol" });
    const app = setup({ model: { provider: "prime-inference", id: "z-ai/glm-5.3" } });
    app.ctx.modelRegistry.getExecutableModels = async () => [
      { provider: "openai-codex", id: "gpt-5.6-sol" }, { provider: "openai-codex", id: "gpt-5.6-luna" },
      { provider: "prime-inference", id: "z-ai/glm-5.3" },
    ];
    await app.command.handler("Implement parser", app.ctx);
    assert.equal(app.sent.length, 1);
    for (const content of [app.sent[0][0], app.beforeAgentStart({ systemPrompt: "base" }, app.ctx).systemPrompt]) {
      assert.match(content, /model="openai-codex\/gpt-5.6-luna"/);
      assert.match(content, /model="openai-codex\/gpt-5.6-sol"/);
      assert.match(content, /prime-inference\/z-ai\/glm-5.3/);
      assert.doesNotMatch(content, /find_models\("gpt-5.6-sol"\)/);
    }
    app.ctx.getSystemPrompt = () => "base";
    assert.match(app.contextHandler({ messages: [] }, app.ctx).messages[0].content, /model="openai-codex\/gpt-5.6-luna"/);
  });
});

test("picker cancellation, non-UI status, scoped choice and unknown models never mutate parent", async () => {
  await temporaryAgentDir(async () => {
    const noUI = setup();
    await noUI.command.handler("", noUI.ctx);
    assert.equal(noUI.entries.length, 1); // session default snapshot only
    assert.equal(noUI.sent.length, 0);
    assert.match(noUI.notices[0][0], /Current parent model/);
    const cancelled = setup({ hasUI: true, choices: ["author: openai-codex/gpt-5.6-sol", undefined] });
    await cancelled.command.handler("", cancelled.ctx);
    assert.equal(cancelled.entries.length, 1);
    const app = setup({ hasUI: true, choices: ["reviewer: openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol", "Current session override"] });
    const parent = app.ctx.model;
    await app.command.handler("", app.ctx);
    assert.match(app.notices.at(-1)[0], /reviewer: openai-codex\/gpt-5.6-sol \(session override\)/);
    assert.strictEqual(app.ctx.model, parent);
    await app.command.handler("model author bad/provider/model", app.ctx);
    assert.match(app.notices.at(-1)[0], /catalog omits/);
    assert.equal(app.entries.length, 2);
  });
});

test("same-model worker and unknown-depth fork do not receive controller policy", async () => {
  for (const depth of [1, null]) {
    const app = setup({ depth });
    app.sessionStart({}, app.ctx);
    assert.equal(app.beforeAgentStart({ prompt: "Implement", systemPrompt: "base" }, app.ctx), undefined);
    await app.command.handler("Implement", app.ctx);
    assert.equal(app.entries.length, 0);
    assert.equal(app.sent.length, 0);
    assert.match(app.notices.at(-1)[0], /disabled/);
  }
});


test("automatic controller mismatch is visible once and never changes the parent", () => {
  const app = setup({ model: { provider: "openai-codex", id: "gpt-5.6-sol" } });
  const parent = app.ctx.model;
  app.beforeAgentStart({ prompt: "code", systemPrompt: "base" }, app.ctx);
  app.beforeAgentStart({ prompt: "code", systemPrompt: "base" }, app.ctx);
  assert.equal(app.notices.length, 1);
  assert.match(app.notices[0][0], /current parent model.*gpt-5.6-sol/i);
  assert.strictEqual(app.ctx.model, parent);
});


test("changed selection replaces only bounded Router policy, preserving chained prompts", async () => {
  const app = setup();
  const original = app.beforeAgentStart({ prompt: "code", systemPrompt: "before" }, app.ctx).systemPrompt + "\nAFTER OTHER EXTENSION";
  assert.match(original, /model="openai-codex\/gpt-5.6-sol"/);
  await app.command.handler("model author openai-codex/gpt-5.6-luna", app.ctx);
  const updated = app.beforeAgentStart({ prompt: "code", systemPrompt: original }, app.ctx).systemPrompt;
  assert.ok(updated.startsWith("before\n\n[router:auto:v1]"));
  assert.ok(updated.endsWith("[router:end:v1]\nAFTER OTHER EXTENSION"));
  assert.match(updated, /model="openai-codex\/gpt-5.6-luna"/);
  assert.doesNotMatch(updated, /model="openai-codex\/gpt-5.6-sol"/);
  assert.equal(updated.split(WORKFLOW_MARKER).length, 2);
  assert.equal(app.beforeAgentStart({ prompt: "code", systemPrompt: updated }, app.ctx).systemPrompt, updated);
});

test("stale system policy and legacy unbounded policy get current transient context", async () => {
  const app = setup();
  const old = app.beforeAgentStart({ prompt: "code", systemPrompt: "base" }, app.ctx).systemPrompt;
  await app.command.handler("model author openai-codex/gpt-5.6-luna", app.ctx);
  app.ctx.getSystemPrompt = () => old;
  const result = app.contextHandler({ messages: [] }, app.ctx);
  assert.match(result.messages[0].content, /model="openai-codex\/gpt-5.6-luna"/);
  app.ctx.getSystemPrompt = () => "base\n\n[router:auto:v1]\nold unbounded workflow\nOTHER EXTENSION";
  assert.equal(app.beforeAgentStart({ prompt: "code", systemPrompt: app.ctx.getSystemPrompt() }, app.ctx).systemPrompt, app.ctx.getSystemPrompt());
  assert.match(app.contextHandler({ messages: [] }, app.ctx).messages[0].content, /model="openai-codex\/gpt-5.6-luna"/);
});

test("busy session mutations are rejected; future defaults and task follow-ups remain allowed", async () => {
  await temporaryAgentDir(async () => {
    const app = setup({ idle: false });
    await app.command.handler("model author openai-codex/gpt-5.6-luna", app.ctx);
    await app.command.handler("reset all", app.ctx);
    assert.equal(app.entries.length, 1);
    assert.match(app.notices.at(-1)[0], /Wait for the current turn/);
    await app.command.handler("default author openai-codex/gpt-5.6-luna", app.ctx);
    assert.equal(readDefaults().author, "openai-codex/gpt-5.6-luna");
    assert.equal(app.entries.length, 1);
    await app.command.handler("Implement", app.ctx);
    assert.deepEqual(app.sent.at(-1)[1], { deliverAs: "followUp" });
    assert.match(app.sent.at(-1)[0], /model="openai-codex\/gpt-5.6-sol"/); // snapshot unchanged
  });
});

test("picker rechecks idle at commit and cancellation leaves overrides unchanged", async () => {
  await temporaryAgentDir(async () => {
    const app = setup({ hasUI: true, choices: ["author: openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna", "Current session override"] });
    let checks = 0;
    app.ctx.isIdle = () => ++checks < 1; // busy when commit occurs
    await app.command.handler("", app.ctx);
    assert.equal(app.entries.length, 1);
    assert.match(app.notices.at(-1)[0], /No change was saved/);
    const cancelled = setup({ hasUI: true, choices: ["author: openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna", undefined] });
    await cancelled.command.handler("", cancelled.ctx);
    assert.equal(cancelled.entries.length, 1);
  });
});
