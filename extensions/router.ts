import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { HerdrBridge, decodeSnapshot } from "./herdr.ts";
import type { InvokingClientContext } from "./herdr.ts";

export const ASTRA_MODEL = "openai-codex/gpt-6-astra";
export const CHILD_MODELS = ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-luna"] as const;
export const BUILT_IN = { controller: ASTRA_MODEL, author: CHILD_MODELS[0], reviewer: CHILD_MODELS[1] } as const;
export type Role = keyof typeof BUILT_IN;
type Models = Partial<Record<Role, string>>;
type State = { version: 1; defaults: Models; overrides: Models };
const ROLES = Object.keys(BUILT_IN) as Role[];
const STATE_KEY = "router-models-v1";
const SKILL_URL = new URL("../skills/router/SKILL.md", import.meta.url);
export const WORKFLOW_MARKER = "[router:auto:v1]";
const WORKFLOW_END = "[router:end:v1]";
function workflowBlock(instructions: string): string { return `${WORKFLOW_MARKER}\n${instructions}\n${WORKFLOW_END}`; }

export function configPath(agentDir = getAgentDir()): string { return join(agentDir, "router", "models.json"); }
function role(value: string): value is Role { return ROLES.includes(value as Role); }
function selector(value: unknown): value is string {
  return typeof value === "string" && /^[^\s/]+\/[^\s/]+(?:\/[^\s/]+)*$/.test(value);
}
function models(value: unknown): Models {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected role map");
  const result: Models = {};
  for (const [key, item] of Object.entries(value)) {
    if (!role(key) || !selector(item)) throw new Error(`invalid role or model selector: ${key}`);
    result[key] = item;
  }
  return result;
}
export function readDefaults(path = configPath()): Models {
  if (!existsSync(path)) return {};
  let json: unknown;
  try { json = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Router default config ${path} is unreadable or corrupt: ${String(error)}`); }
  if (!json || typeof json !== "object" || Array.isArray(json) ||
      Object.keys(json).some((key) => key !== "version" && key !== "defaults") ||
      (json as { version?: unknown }).version !== 1) {
    throw new Error(`Router default config ${path} has an invalid schema`);
  }
  try { return models((json as { defaults?: unknown }).defaults); }
  catch (error) { throw new Error(`Router default config ${path} has an invalid schema: ${String(error)}`); }
}
export function saveDefaults(defaults: Models, path = configPath()): void {
  const valid = models(defaults);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, defaults: valid }, null, 2) + "\n");
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already renamed */ }
  }
}
function decodeState(value: unknown): State {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as { version?: unknown }).version !== 1) throw new Error("invalid Router session state");
  const data = value as { defaults?: unknown; overrides?: unknown };
  return { version: 1, defaults: models(data.defaults), overrides: models(data.overrides) };
}
function branchState(ctx: ExtensionContext): State | undefined {
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type === "custom" && entry.customType === STATE_KEY) return decodeState(entry.data);
  }
  return undefined;
}
function controllerSession(ctx: ExtensionContext): boolean {
  // Native RLM children have rlmDepth > 0. A missing depth is ambiguous (including
  // third-party forks): fail closed even if a worker happens to use the controller model.
  return (ctx.sessionManager.getHeader() as { rlmDepth?: unknown } | null)?.rlmDepth === 0;
}
function effective(state: State): Record<Role, string> {
  return Object.fromEntries(ROLES.map((key) => [key, state.overrides[key] ?? state.defaults[key] ?? BUILT_IN[key]])) as Record<Role, string>;
}
function loadState(ctx: ExtensionContext, pi: ExtensionAPI, persist: boolean): State {
  const existing = branchState(ctx);
  if (existing) return existing;
  const state: State = { version: 1, defaults: readDefaults(), overrides: {} };
  if (persist) pi.appendEntry(STATE_KEY, state);
  return state;
}
export function automaticPrompt(systemPrompt: string, instructions: string): string {
  const block = workflowBlock(instructions);
  const start = systemPrompt.indexOf(WORKFLOW_MARKER);
  if (start >= 0) {
    const end = systemPrompt.indexOf(WORKFLOW_END, start + WORKFLOW_MARKER.length);
    if (end >= 0) return systemPrompt.slice(0, start) + block + systemPrompt.slice(end + WORKFLOW_END.length);
    // Legacy unbounded marker cannot safely be removed if another extension
    // appended instructions after it. Context will supply current policy.
    return systemPrompt;
  }
  return `${systemPrompt}\n\n${block}`;
}
export function workflowInstructions(source: string, selected: Record<Role, string> = BUILT_IN): string {
  let instructions = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  for (const key of ROLES) instructions = instructions.replaceAll(`{{${key}}}`, selected[key]);
  return instructions;
}
export function taskPrompt(task: string, instructions: string): string {
  const trimmed = task.trim();
  if (!trimmed) throw new Error("Provide a task: /router <task>");
  return `Use the Router workflow below. You are the parent controller; keep this session and its model.\n\n${instructions}\n\n## Task from the operator\n${trimmed}`;
}
function instructions(state: State): string { return workflowInstructions(readFileSync(SKILL_URL, "utf8"), effective(state)); }
function status(ctx: ExtensionContext, state: State): string {
  const selected = effective(state);
  return ROLES.map((key) => `${key}: ${selected[key]} (${state.overrides[key] ? "session override" : state.defaults[key] ? "session default snapshot" : "built-in"})`).join("\n") +
    `\nCurrent parent model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}${ctx.model && `${ctx.model.provider}/${ctx.model.id}` === selected.controller ? " (matches controller)" : " (does not match controller; Router never switches it)"}`;
}
async function executable(ctx: ExtensionContext): Promise<Set<string>> {
  const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { getExecutableModels?: () => Promise<{provider: string; id: string}[]> };
  if (!registry.getExecutableModels) throw new Error("Router needs executable-model discovery. Update Prime Agent; no task was started.");
  return new Set((await registry.getExecutableModels()).map((item) => `${item.provider}/${item.id}`));
}

export default function router(pi: ExtensionAPI, makeBridge: (persist: (state: import("./herdr.ts").HerdrSnapshot) => void, saved?: import("./herdr.ts").HerdrSnapshot) => HerdrBridge = (persist, saved) => new HerdrBridge(undefined, undefined, persist, saved)): void {
  const warned = new Set<string>();
  const herdr = new Map<string, HerdrBridge>();
  const bridge = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    let current = herdr.get(id);
    if (!current) {
      const last = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "custom" && entry.customType === "router-herdr-v1");
      current = makeBridge((snapshot) => pi.appendEntry("router-herdr-v1", snapshot),
        last ? decodeSnapshot((last as { data?: unknown }).data) : undefined);
      herdr.set(id, current);
    }
    return current;
  };
  const reconcile = async (ctx: ExtensionContext) => {
    if (!controllerSession(ctx)) return;
    let current: HerdrBridge;
    try { current = bridge(ctx); }
    catch (error) { ctx.ui.notify(`Router Herdr ownership state is invalid: ${String(error)}`, "error"); return; }
    if (!current.enabled) return;
    try { await current.sync(ctx.sessionManager.getSessionId(), effective(loadState(ctx, pi, false))); }
    catch (error) {
      const key = `${ctx.sessionManager.getSessionId()}:herdr:${String(error)}`;
      if (!warned.has(key)) { warned.add(key); ctx.ui.notify(`Router Herdr sync failed: ${String(error)}. Use /router herdr sync to retry.`, "warning"); }
    }
  };
  pi.on("tool_execution_end", (_event, ctx) => { void reconcile(ctx); });
  pi.on("agent_end", (_event, ctx) => { void reconcile(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!controllerSession(ctx)) return;
    const current = herdr.get(ctx.sessionManager.getSessionId());
    if (!current?.enabled && !current?.viewers.size) return;
    try { await current.off(ctx.sessionManager.getSessionId()); }
    catch (error) { ctx.ui.notify(`Router Herdr owned pane cleanup failed: ${String(error)}`, "warning"); }
  });
  pi.on("session_start", (_event, ctx) => {
    if (!controllerSession(ctx)) return;
    try { loadState(ctx, pi, true); }
    catch (error) { ctx.ui.notify(`Cannot initialize Router defaults: ${String(error)}`, "error"); }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!controllerSession(ctx)) {
      if ((ctx.sessionManager.getHeader() as { rlmDepth?: unknown } | null)?.rlmDepth === undefined && !warned.has(ctx.sessionManager.getSessionId())) {
        warned.add(ctx.sessionManager.getSessionId());
        ctx.ui.notify("Router disabled: session has no verified rlmDepth; cannot identify root vs worker.", "warning");
      }
      return;
    }
    try {
      const state = loadState(ctx, pi, true);
      if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== effective(state).controller) {
        const mismatch = `${ctx.sessionManager.getSessionId()}:controller:${effective(state).controller}:${ctx.model?.provider}/${ctx.model?.id}`;
        if (!warned.has(mismatch)) {
          warned.add(mismatch);
          ctx.ui.notify(`Router controller is ${effective(state).controller}; current parent model is ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}. Router will not switch it.`, "warning");
        }
        return;
      }
      return { systemPrompt: automaticPrompt(event.systemPrompt, instructions(state)) };
    } catch (error) { ctx.ui.notify(`Cannot load Router workflow: ${String(error)}`, "error"); }
  });
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter((message) => !(message.role === "custom" && (message.customType === "router-context" || message.customType === "astra-orchestrator-context")));
    if (!controllerSession(ctx)) return messages.length === event.messages.length ? undefined : { messages };
    try {
      const state = loadState(ctx, pi, true);
      if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== effective(state).controller || ctx.getSystemPrompt().includes(workflowBlock(instructions(state)))) return messages.length === event.messages.length ? undefined : { messages };
      return { messages: [...messages, { role: "custom" as const, customType: "router-context", content: `Current Router role selectors supersede any earlier Router instructions in this turn.\n${WORKFLOW_MARKER}\n${instructions(state)}`, display: false, timestamp: Date.now() }] };
    } catch (error) { ctx.ui.notify(`Cannot load Router workflow: ${String(error)}`, "error"); return messages.length === event.messages.length ? undefined : { messages }; }
  });
  pi.registerCommand("router", {
    description: "Router models, saved defaults, and native Prime task orchestration",
    handler: async (args, ctx) => {
      if (!controllerSession(ctx)) { ctx.ui.notify("Router is disabled in child or ambiguous sessions (requires root rlmDepth=0).", "warning"); return; }
      try {
        const state = loadState(ctx, pi, true);
        const parts = args.trim().split(/\s+/);
        const action = parts[0];
        if (action === "herdr") {
          const op = parts[1];
          if (!["on", "off", "status", "sync", "bind"].includes(op) || (op === "on" ? parts.length !== 2 && parts.length !== 4 : op === "bind" ? parts.length !== 3 : parts.length !== 2)) {
            ctx.ui.notify("Usage: /router herdr on | /router herdr off|status|sync (advanced recovery: on <absolute-daemon-socket> <absolute-prime-launcher> | bind <absolute-descriptor-path>; paths with spaces are unsupported)", "warning"); return;
          }
          if (op === "on" && parts.length === 2) {
            // This optional host API is command-scoped. Do not guess a caller from
            // process.env, focus, local sockets, or descriptor files.
            const invoking = (ctx as ExtensionContext & { getInvokingClientContext?: () => InvokingClientContext | undefined }).getInvokingClientContext;
            if (!invoking) { ctx.ui.notify("Router Herdr needs Prime's invoking-client context capability; update Prime Agent and retry /router herdr on from Herdr.", "warning"); return; }
            const metadata = invoking.call(ctx);
            if (!metadata) { ctx.ui.notify("Router Herdr needs a Herdr client invoking this command; run /router herdr on from your Herdr terminal.", "warning"); return; }
            await bridge(ctx).onInvoking(ctx.sessionManager.getSessionId(), effective(state), metadata);
            ctx.ui.notify(bridge(ctx).status(), "info"); return;
          }
          const current = bridge(ctx);
          if (op === "on") await current.on(ctx.sessionManager.getSessionId(), effective(state), { socket: parts[2], launcher: parts[3] });
          if (op === "bind") await current.bind(ctx.sessionManager.getSessionId(), effective(state), parts[2]);
          if (op === "off") await current.off(ctx.sessionManager.getSessionId());
          if (op === "sync") await current.sync(ctx.sessionManager.getSessionId(), effective(state));
          ctx.ui.notify(current.status(), "info"); return;
        }
        if (!args.trim() || action === "models" || action === "help") {
          ctx.ui.notify(`${status(ctx, state)}\nUsage: /router <task> | /router models | /router model <controller|author|reviewer> <provider/model-id> | /router default <role> <selector> | /router reset <role|all>`, "info");
          if (!args.trim() && ctx.hasUI) {
            const choice = await ctx.ui.select("Router: choose role for current session", ROLES.map((key) => `${key}: ${effective(state)[key]}`));
            if (!choice) return;
            const selectedRole = choice.split(":")[0];
            if (!role(selectedRole)) return;
            const available = [...await executable(ctx)].sort();
            const picked = await ctx.ui.select(`Router ${selectedRole}: select executable model`, available);
            if (!picked) return;
            const scope = await ctx.ui.select("Router model scope", ["Current session override", "Saved default for new sessions"]);
            if (!scope) return;
            if (scope === "Saved default for new sessions") {
              const defaults = readDefaults();
              saveDefaults({ ...defaults, [selectedRole]: picked });
              ctx.ui.notify(`Saved default ${selectedRole}: ${picked} for new sessions only.\n${status(ctx, state)}`, "info");
            } else if (scope === "Current session override") {
              if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current turn to finish before changing session models. No change was saved.", "warning"); return; }
              const next: State = { ...state, overrides: { ...state.overrides, [selectedRole]: picked } };
              pi.appendEntry(STATE_KEY, next);
              ctx.ui.notify(status(ctx, next), "info");
            }
          }
          return;
        }
        if (action === "model" || action === "default") {
          if (parts.length !== 3 || !role(parts[1]) || !selector(parts[2])) { ctx.ui.notify(`Usage: /router ${action} <controller|author|reviewer> <provider/model-id>`, "warning"); return; }
          const available = await executable(ctx);
          if (!available.has(parts[2])) { ctx.ui.notify(`Prime's live executable-model catalog omits: ${parts[2]}. No fallback was used.`, "error"); return; }
          if (action === "default") {
            const defaults = readDefaults(); // Corruption must never be overwritten.
            saveDefaults({ ...defaults, [parts[1]]: parts[2] });
            ctx.ui.notify(`Saved default ${parts[1]}: ${parts[2]} for new sessions only.\n${status(ctx, state)}`, "info");
          } else {
            if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current turn to finish before changing session models. No change was saved.", "warning"); return; }
            const next: State = { ...state, overrides: { ...state.overrides, [parts[1]]: parts[2] } };
            pi.appendEntry(STATE_KEY, next);
            ctx.ui.notify(status(ctx, next), "info");
          }
          return;
        }
        if (action === "reset") {
          if (parts.length !== 2 || (parts[1] !== "all" && !role(parts[1]))) { ctx.ui.notify("Usage: /router reset <controller|author|reviewer|all>", "warning"); return; }
          if (!ctx.isIdle()) { ctx.ui.notify("Wait for the current turn to finish before resetting session models. No change was saved.", "warning"); return; }
          const overrides = { ...state.overrides };
          if (parts[1] === "all") for (const key of ROLES) delete overrides[key];
          else delete overrides[parts[1] as Role];
          const next: State = { ...state, overrides };
          pi.appendEntry(STATE_KEY, next);
          ctx.ui.notify(status(ctx, next), "info"); return;
        }
        const selected = effective(state);
        if (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== selected.controller) {
          ctx.ui.notify(`Router needs the parent model ${selected.controller}. Current: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}. Select it first; this command never switches models or sessions.`, "warning"); return;
        }
        const available = await executable(ctx);
        const missing = [selected.author, selected.reviewer].filter((item) => !available.has(item));
        if (missing.length) { ctx.ui.notify(`Prime's live executable-model catalog omits: ${missing.join(", ")}. No fallback was used.`, "error"); return; }
        pi.sendUserMessage(taskPrompt(args, instructions(state)), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      } catch (error) { ctx.ui.notify(`Router error: ${String(error)}. No model or session was switched.`, "error"); }
    },
  });
}
