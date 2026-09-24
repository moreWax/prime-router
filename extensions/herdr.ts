import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, openSync, readFileSync, closeSync, renameSync, unlinkSync, rmdirSync, fstatSync } from "node:fs";
import { dirname, basename } from "node:path";

const execute = promisify(execFile);
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SOCKET = /^[^\0\r\n]+$/;
export const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
export type Viewer = { pane: string; tab: string; session: string; child: string; source: string; owner: string };
export type Environment = Record<string, string | undefined>;
export type Transport = (binary: string, args: string[], env?: Environment) => Promise<unknown>;
export type Context = { root: string; env: Environment };
export type HerdrSnapshot = { version: 1; enabled: boolean; binding?: Binding; context?: Context; viewers: Viewer[] };
export function decodeSnapshot(value: unknown): HerdrSnapshot {
  const s = value as HerdrSnapshot;
  if (s?.version !== 1 || typeof s.enabled !== "boolean" || !Array.isArray(s.viewers) ||
      (s.binding !== undefined && (typeof s.binding.socket !== "string" || typeof s.binding.launcher !== "string")) ||
      (s.context !== undefined && (!s.context || typeof s.context.root !== "string" || !ID.test(s.context.root) || !s.context.env || typeof s.context.env !== "object" || !HERDR_KEYS.every((k) => typeof s.context!.env[k] === "string"))) ||
      s.viewers.length > 8 || s.viewers.some((v) => !v || ![v.pane, v.tab, v.session, v.child, v.source, v.owner].every((x) => typeof x === "string" && ID.test(x))))
    throw new Error("Invalid Router Herdr session ownership state");
  return s;
}

export type Binding = { socket: string; launcher: string };
/** Metadata supplied by the authenticated, command-scoped invoking Prime client. */
export type InvokingClientContext = { readonly env: Readonly<Partial<Record<(typeof HERDR_KEYS)[number], string>>>; readonly daemonSocketPath: string; readonly launcherPath: string };
export const HERDR_KEYS = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"] as const;
function onlyHerdr(env: Environment): Environment { return Object.fromEntries(HERDR_KEYS.map((k) => [k, env[k]])); }
export function consumeDescriptor(path: string, session: string): { binding: Binding; context: Context } {
  if (!path.startsWith("/") || path.includes("\0") || basename(path) !== "binding.json") throw new Error("Absolute Router descriptor path required");
  const dir = dirname(path), d = lstatSync(dir);
  if (!d.isDirectory() || d.isSymbolicLink() || d.uid !== process.getuid?.() || (d.mode & 0o777) !== 0o700) throw new Error("Unsafe Router descriptor directory");
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new Error("Unsafe Router descriptor file");
  const claimed = `${path}.claimed-${randomUUID()}`;
  renameSync(path, claimed); // Single atomic claim: a repeated bind cannot consume this path.
  try {
    const fd = openSync(claimed, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: string;
    try { const actual = fstatSync(fd); if (actual.ino !== st.ino || actual.dev !== st.dev || actual.uid !== st.uid || (actual.mode & 0o777) !== 0o600) throw new Error("Router descriptor changed during claim");
      if (actual.size > 4096) throw new Error("Router descriptor is too large");
      raw = readFileSync(fd, { encoding: "utf8" }); } finally { closeSync(fd); }
    if (raw.length > 4096) throw new Error("Router descriptor is too large");
    const data = JSON.parse(raw) as any;
    if (!data || Object.keys(data).sort().join(",") !== "binding,env,expiresAt,root,token,version" || data.version !== 1 ||
        typeof data.token !== "string" || !/^[a-f0-9]{64}$/.test(data.token) || !Number.isSafeInteger(data.expiresAt) ||
        data.expiresAt < Date.now() || data.expiresAt > Date.now() + 120000 || data.root !== session ||
        !data.binding || Object.keys(data.binding).sort().join(",") !== "launcher,socket" || !data.env ||
        Object.keys(data.env).sort().join(",") !== [...HERDR_KEYS].sort().join(",") ||
        !HERDR_KEYS.every((k) => typeof data.env[k] === "string")) throw new Error("Invalid, expired, or cross-session Router descriptor");
    caller(data.env, session, data.binding);
    return { binding: data.binding, context: { root: session, env: onlyHerdr(data.env) } };
  } finally { unlinkSync(claimed); try { rmdirSync(dir); } catch { /* directory may contain other files */ } }
}
export function caller(env: Environment, session: string, binding: Binding) {
  if (!binding) throw new Error("Router Herdr needs explicit bound Prime transport; use /router herdr on <socket> <launcher>");
  if (env.HERDR_ENV !== "1") throw new Error("HERDR_ENV=1 is required; no Herdr control outside a managed pane");
  const { HERDR_WORKSPACE_ID: workspace, HERDR_TAB_ID: tab, HERDR_PANE_ID: pane,
    HERDR_SOCKET_PATH: herdrSocket } = env;
  if (![workspace, tab, pane, session].every((v) => typeof v === "string" && ID.test(v)) ||
      !tab!.startsWith(`${workspace}:`) || !pane!.startsWith(`${workspace}:`)) throw new Error("Caller-bound Herdr and Prime IDs required");
  if (process.platform === "win32") throw new Error("Herdr viewer shell quoting is not supported on Windows");
  if (!herdrSocket?.startsWith("/") || !SOCKET.test(herdrSocket)) throw new Error("Inherited HERDR_SOCKET_PATH is required; no default Herdr server selection");
  const { socket, launcher } = binding;
  if (!socket?.startsWith("/") || !SOCKET.test(socket) || !launcher?.startsWith("/") || !SOCKET.test(launcher))
    throw new Error("Explicit absolute parent daemon socket and Prime launcher required");
  try { accessSync(launcher, constants.X_OK); } catch { throw new Error("Prime launcher is not executable"); }
  return { workspace: workspace!, tab: tab!, pane: pane!, socket, launcher, session };
}

export const cli: Transport = async (binary, args, env) => {
  const { stdout } = await execute(binary, args, { timeout: 10000, maxBuffer: 8 * 1024 * 1024, env: env ? { ...process.env, ...onlyHerdr(env) } : process.env });
  return JSON.parse(stdout);
};
function result(data: unknown): any {
  if (!data || typeof data !== "object" || !Object.hasOwn(data, "result")) throw new Error("Unexpected Herdr response");
  return (data as { result: unknown }).result;
}
export function directChildren(list: unknown, parent: string) {
  if (!list || typeof list !== "object" || !Array.isArray((list as any).sessions)) throw new Error("Unexpected Prime list response");
  if (!(list as any).sessions.some((s: any) => s?.sessionId === parent && s?.rlmDepth === 0 && s?.runtimeKind === "top-level" && s?.lifecycle === "live"))
    throw new Error("Prime daemon list does not contain the current live root session");
  const children = (list as any).sessions.filter((s: any) => s?.parentSessionId === parent && s?.rlmDepth === 1 && s?.runtimeKind === "subagent" && s?.lifecycle === "live");
  for (const s of children) {
    if (typeof s.rlmChildId !== "string" || !ID.test(s.rlmChildId) || typeof s.sessionId !== "string" || !ID.test(s.sessionId) ||
        typeof s.model?.provider !== "string" || !s.model.provider || typeof s.model?.id !== "string" || !s.model.id ||
        typeof s.sessionName !== "string" || !s.sessionName || typeof s.cwd !== "string" || !s.cwd.startsWith("/"))
      throw new Error("Live direct child lacks authoritative identity, model, name, or cwd");
  }
  return children;
}
export function roleFor(model: string, selected: {author: string; reviewer: string}) {
  return (selected.author === model) !== (selected.reviewer === model) ? selected.author === model ? "author" : "reviewer" : "worker";
}
export class HerdrBridge {
  enabled = false;
  readonly viewers = new Map<string, Viewer>();
  private pending?: Promise<void>;
  private dirty = false;
  private generation = 0;
  binding?: Binding;
  context?: Context;
  private readonly transport: Transport;
  private readonly env: Environment;
  private readonly persist: (state: HerdrSnapshot) => void;
  constructor(transport: Transport = cli, env: Environment = process.env, persist: (state: HerdrSnapshot) => void = () => {}, saved?: HerdrSnapshot) {
    this.transport = transport; this.env = env; this.persist = persist;
    if (saved) { this.enabled = saved.enabled; this.binding = saved.binding; this.context = saved.context;
      for (const v of saved.viewers) this.viewers.set(v.child, v); }
  }
  snapshot(): HerdrSnapshot { return { version: 1, enabled: this.enabled, binding: this.binding, context: this.context,
    viewers: [...this.viewers.values()] }; }
  private save() { this.persist(this.snapshot()); }
  status() { return `Herdr ${this.enabled ? "on" : "off"}; ${this.viewers.size} owned viewer pane(s). Event-driven sync follows parent tool/turn completion; child-only transitions await the next parent event.`; }
  private current(session: string) {
    if (this.context && this.context.root !== session) throw new Error("Router Herdr context belongs to another root session");
    return caller(this.context?.env ?? this.env, session, this.binding!);
  }
  private async herdr(...args: string[]) { return result(await this.transport("herdr", args, this.context?.env)); }
  private async verifyPane(c: ReturnType<typeof caller>, v: Viewer) {
    const pane = await this.herdr("pane", "get", v.pane);
    return pane?.pane?.pane_id === v.pane && pane.pane.tab_id === v.tab && pane.pane.workspace_id === c.workspace && pane.pane.tokens?.router_owner === v.owner;
  }
  private async release(c: ReturnType<typeof caller>, v: Viewer) {
    if (await this.verifyPane(c, v)) await this.herdr("pane", "close", v.pane);
    this.viewers.delete(v.child); this.save();
  }
  async off(session: string) {
    const c = this.current(session);
    ++this.generation; this.enabled = false; this.save();
    const errors: string[] = [];
    if (this.pending) { try { await this.pending; } catch (e) { errors.push(`pending sync: ${String(e)}`); } }
    for (const v of [...this.viewers.values()]) {
      try { await this.release(c, v); } catch (e) { errors.push(`${v.pane}: ${String(e)}`); }
    }
    if (errors.length) throw new Error(`Owned pane cleanup failed: ${errors.join("; ")}`);
    if (!this.viewers.size) { this.context = undefined; this.save(); }
  }
  async on(session: string, selected: {author: string; reviewer: string}, binding: Binding) {
    caller(this.env, session, binding);
    if (this.context && this.context.root !== session) throw new Error("Router Herdr context belongs to another root session");
    if (this.viewers.size && (this.binding?.socket !== binding.socket || this.binding.launcher !== binding.launcher))
      throw new Error("Turn Herdr off before changing the bound Prime transport");
    if (this.context && (this.binding?.socket !== binding.socket || this.binding?.launcher !== binding.launcher)) throw new Error("Turn Herdr off before changing bound context");
    this.binding = binding; this.enabled = true; this.save();
    try { await this.sync(session, selected); }
    catch (error) {
      if (!this.viewers.size) { this.enabled = false; this.save(); }
      throw error;
    }
  }
  async onInvoking(session: string, selected: {author: string; reviewer: string}, invoking: InvokingClientContext) {
    // Never consult the worker process environment for the command's caller.
    const binding: Binding = { socket: invoking.daemonSocketPath, launcher: invoking.launcherPath };
    const env = onlyHerdr({ ...invoking.env });
    caller(env, session, binding);
    if (this.context && this.context.root !== session) throw new Error("Router Herdr context belongs to another root session");
    // Older explicit-on snapshots lack a caller context. Do not adopt their
    // viewers into a different Herdr server or pane through this command.
    if ((this.enabled || this.viewers.size) && !this.context)
      throw new Error("Router Herdr has no saved caller identity; use /router herdr off from the original caller before rebinding");
    const changed = this.context && (HERDR_KEYS.some((key) => this.context!.env[key] !== env[key]) ||
      this.binding?.socket !== binding.socket || this.binding?.launcher !== binding.launcher);
    if (changed && this.viewers.size)
      throw new Error("Router Herdr owns viewer panes for another caller; use /router herdr off from the original caller before rebinding");
    if (changed && this.enabled)
      throw new Error("Turn Herdr off before changing the bound caller or Prime transport");
    this.binding = binding;
    this.context = { root: session, env };
    this.enabled = true;
    this.save();
    try { await this.sync(session, selected); }
    catch (error) { if (!this.viewers.size) { this.enabled = false; this.context = undefined; this.save(); } throw error; }
  }
  async bind(session: string, selected: {author: string; reviewer: string}, path: string) {
    if (this.viewers.size || this.enabled) throw new Error("Turn Herdr off before binding a different caller");
    const { binding, context } = consumeDescriptor(path, session);
    this.binding = binding; this.context = context; this.enabled = true; this.save();
    try { await this.sync(session, selected); } catch (error) { if (!this.viewers.size) { this.enabled = false; this.context = undefined; this.save(); } throw error; }
  }
  sync(session: string, selected: {author: string; reviewer: string}): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.pending) { this.dirty = true; return this.pending; }
    const generation = this.generation;
    const run = async () => {
      do {
        this.dirty = false;
        if (!this.enabled || this.generation !== generation) break;
        await this.reconcile(session, selected, generation);
      } while (this.dirty && this.enabled && this.generation === generation);
    };
    const task = run();
    this.pending = task.finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async reconcile(session: string, selected: {author: string; reviewer: string}, generation: number) {
    const c = this.current(session);
    const origin = await this.herdr("pane", "get", c.pane);
    if (origin?.pane?.pane_id !== c.pane || origin.pane.tab_id !== c.tab || origin.pane.workspace_id !== c.workspace)
      throw new Error("Herdr caller pane does not match inherited workspace/tab/pane");
    const response = await this.transport(c.launcher, ["list", "--json", "--daemon-socket", c.socket], this.context?.env);
    const children = directChildren(response, session);
    if (children.length > 8) throw new Error("Router Herdr viewer limit is 8 direct children");
    const seen = new Set<string>(children.map((s: any) => s.rlmChildId));
    for (const v of [...this.viewers.values()]) if (!seen.has(v.child)) await this.release(c, v);
    for (const s of children) {
      if (!this.enabled || this.generation !== generation) return;
      const model = `${s.model.provider}/${s.model.id}`;
      const label = `${roleFor(model, selected)}: ${s.sessionName} | ${model}`;
      let v = this.viewers.get(s.rlmChildId);
      if (v && !(await this.verifyPane(c, v))) { this.viewers.delete(s.rlmChildId); this.save(); v = undefined; }
      if (!v) {
        const created = await this.herdr("pane", "split", "--pane", c.pane, "--direction", "right", "--cwd", s.cwd, "--no-focus");
        const pane = created?.pane?.pane_id;
        if (typeof pane !== "string" || !ID.test(pane) || !pane.startsWith(`${c.workspace}:`) || created?.pane?.tab_id !== c.tab)
          throw new Error("Herdr split returned a pane outside the caller tab");
        v = { pane, tab: c.tab, session: s.sessionId, child: s.rlmChildId, source: `router-${randomUUID()}`, owner: randomUUID() };
        this.viewers.set(v.child, v); this.save();
        try {
          await this.herdr("pane", "report-metadata", pane, "--source", v.source, "--title", label, "--display-agent", label, "--token", `router_owner=${v.owner}`);
          const command = `exec ${quote(c.launcher)} attach ${quote(s.sessionId)} --daemon-socket ${quote(c.socket)}`;
          await this.herdr("pane", "run", pane, command);
          // This is a viewer of an existing native session. Presence is known;
          // the child's execution state is not, so never claim idle/working/done.
          await this.herdr("pane", "report-agent", pane, "--source", v.source, "--agent", "prime-agent", "--state", "unknown", "--agent-session-id", s.sessionId);
        } catch (error) {
          try {
            if (await this.verifyPane(c, v)) await this.release(c, v);
            else {
              // The split response proves this fresh pane was created by this invocation.
              // Metadata may have failed before the ownership token was installed.
              const fresh = await this.herdr("pane", "get", v.pane);
              if (fresh?.pane?.pane_id === v.pane && fresh.pane.tab_id === c.tab && fresh.pane.workspace_id === c.workspace && !fresh.pane.tokens?.router_owner) {
                await this.herdr("pane", "close", v.pane);
                this.viewers.delete(v.child); this.save();
              }
            }
          } catch { /* retain ownership record for explicit cleanup */ }
          throw error;
        }
      } else {
        await this.herdr("pane", "report-metadata", v.pane, "--source", v.source, "--title", label, "--display-agent", label);
      }
    }
  }
}
