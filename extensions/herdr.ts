import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, openSync, readFileSync, readSync, closeSync, renameSync, unlinkSync, rmdirSync, fstatSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";

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

const commandName = (binary: string, args: string[]) => {
  if (binary === "herdr" && args[0] === "pane" && typeof args[1] === "string") return `Herdr pane ${args[1]}`;
  if (args[0] === "list" && args[1] === "--json") return "Prime list --json";
  return "CLI command";
};
const readOnlyHerdrJSON = (binary: string, args: string[]) =>
  binary === "herdr" && args[0] === "pane" && ["get", "list"].includes(args[1] ?? "");
export function parseCLIJSON(binary: string, args: string[], stdout: string): unknown {
  try { return JSON.parse(stdout); }
  catch {
    throw new Error(`Malformed JSON from ${commandName(binary, args)} (received ${Buffer.byteLength(stdout, "utf8")} bytes; response omitted)`);
  }
}
const CLI_TIMEOUT_MS = 10000;
const CLI_RESPONSE_LIMIT = 8 * 1024 * 1024;

// Keep this small helper injectable so unlink-failure cleanup can be tested
// without changing the production transport policy.
export function unlinkOpenDescriptor(fd: number, remove: () => void, close: (fd: number) => void = closeSync) {
  try { remove(); }
  catch (error) {
    try { close(fd); } catch { /* preserve the unlink error */ }
    throw error;
  }
}

/** Testable primitive. The production cli always supplies the fixed limits above. */
export async function boundedCLIToFile(
  binary: string, args: string[], env: NodeJS.ProcessEnv,
  limits: Readonly<{ timeoutMs: number; responseBytes: number }> = { timeoutMs: CLI_TIMEOUT_MS, responseBytes: CLI_RESPONSE_LIMIT },
): Promise<string> {
  // Direct the large roster to a file descriptor instead of retaining a pipe
  // buffer. Poll its size while the child runs and independently count stderr.
  const path = join(tmpdir(), `router-prime-list-${randomUUID()}`);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  let open = true;
  try {
    unlinkOpenDescriptor(fd, () => unlinkSync(path));
  } catch (error) {
    open = false;
    try { unlinkSync(path); } catch { /* best-effort removal after close */ }
    throw error;
  }
  try {
    const child = spawn(binary, args, { env, stdio: ["ignore", fd, "pipe"] });
    let failure: "timeout" | "stdout" | "stderr" | undefined;
    let stderrBytes = 0;
    const terminate = (reason: typeof failure) => {
      if (!failure) { failure = reason; child.kill("SIGKILL"); }
    };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > limits.responseBytes) terminate("stderr");
    });
    const timer = setTimeout(() => terminate("timeout"), limits.timeoutMs);
    const monitor = setInterval(() => {
      try { if (fstatSync(fd).size > limits.responseBytes) terminate("stdout"); }
      catch { /* the final descriptor operations report any filesystem error */ }
    }, 5);
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => { clearTimeout(timer); clearInterval(monitor); });
    const size = fstatSync(fd).size;
    if (failure === "timeout") throw new Error("Prime list --json timed out");
    if (failure === "stdout" || size > limits.responseBytes) throw new Error("Prime list --json exceeded the stdout response limit");
    if (failure === "stderr" || stderrBytes > limits.responseBytes) throw new Error("Prime list --json exceeded the stderr response limit");
    if (code !== 0) throw new Error(`Prime list --json failed (${signal ? "terminated by signal" : `exit ${code}`})`);
    const output = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, output, offset, size - offset, offset);
      if (count === 0) throw new Error("Prime list --json response ended before its reported size");
      offset += count;
    }
    return output.toString("utf8");
  } finally { if (open) closeSync(fd); }
}

export async function parsePipedCLIJSON(binary: string, args: string[], invoke: () => Promise<string>): Promise<unknown> {
  // Retry only side-effect-free Herdr inventory reads after an incomplete pipe;
  // never retry a pane mutation whose response was lost.
  for (let attempt = 0; ; attempt++) {
    const stdout = await invoke();
    try { return parseCLIJSON(binary, args, stdout); }
    catch (error) {
      const incomplete = stdout.trim() === "" || !/[}\]]$/.test(stdout.trimEnd());
      if (attempt === 0 && incomplete && readOnlyHerdrJSON(binary, args)) continue;
      throw error;
    }
  }
}

export const cli: Transport = async (binary, args, env) => {
  const processEnv = env ? { ...process.env, ...onlyHerdr(env) } : process.env;
  if (args[0] === "list" && args[1] === "--json" && args[2] === "--daemon-socket" && args.length === 4)
    return parseCLIJSON(binary, args, await boundedCLIToFile(binary, args, processEnv));
  const options = { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_RESPONSE_LIMIT, env: processEnv };
  return parsePipedCLIJSON(binary, args, async () => (await execute(binary, args, options)).stdout);
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
  if (new Set(children.map((s: any) => s.rlmChildId)).size !== children.length ||
      new Set(children.map((s: any) => s.sessionId)).size !== children.length)
    throw new Error("Prime direct child roster contains duplicate identities");
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
  lastSuccess?: number;
  lastError?: string;
  deferred = 0;
  readonly activity = new Map<string, "working" | "unknown">();
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
  status() {
    const binding = this.binding ? "Prime transport: bound (socket and launcher paths hidden)" : "Prime transport: unbound";
    const observed = [...this.activity.values()].reduce((counts, state) => { counts[state]++; return counts; }, { working: 0, unknown: 0 });
    return `Herdr ${this.enabled ? "on" : "off"}; ${binding}; caller pane: ${this.context?.env.HERDR_PANE_ID && ID.test(this.context.env.HERDR_PANE_ID) ? this.context.env.HERDR_PANE_ID : "unverified"}; tracked viewers (ownership not currently verified): ${this.viewers.size}/8; deferred: ${this.deferred}; observed activity: ${observed.working} working, ${observed.unknown} unknown; Agents sidebar: unverified; last successful sync: ${this.lastSuccess ? new Date(this.lastSuccess).toISOString() : "never"}; last error: ${this.lastError ?? "none"}. Event-driven sync follows parent tool/turn completion; child-only transitions await the next parent event.`;
  }
  private current(session: string) {
    if (this.context && this.context.root !== session) throw new Error("Router Herdr context belongs to another root session");
    return caller(this.context?.env ?? this.env, session, this.binding!);
  }
  private async herdr(...args: string[]) { return result(await this.transport("herdr", args, this.context?.env)); }
  // Herdr 0.9.1 protocol 22: pane.list --workspace returns
  // {result:{type:"pane_list",panes:PaneInfo[]}} on success. Its server-side
  // workspace filter rejects an unknown workspace rather than returning [].
  private async inventory(c: ReturnType<typeof caller>): Promise<Map<string, any>> {
    const response = await this.herdr("pane", "list", "--workspace", c.workspace);
    if (!response || response.type !== "pane_list" || !Array.isArray(response.panes))
      throw new Error("Invalid Herdr workspace pane inventory");
    const panes = new Map<string, any>();
    for (const pane of response.panes) {
      if (!pane || typeof pane.pane_id !== "string" || !ID.test(pane.pane_id) ||
          !pane.pane_id.startsWith(`${c.workspace}:`) || pane.workspace_id !== c.workspace ||
          typeof pane.tab_id !== "string" || !ID.test(pane.tab_id) || !pane.tab_id.startsWith(`${c.workspace}:`) ||
          typeof pane.terminal_id !== "string" || !pane.terminal_id ||
          typeof pane.focused !== "boolean" || typeof pane.agent_status !== "string" ||
          !Number.isSafeInteger(pane.revision) || pane.revision < 0 ||
          (pane.tokens !== undefined && (!pane.tokens || typeof pane.tokens !== "object" || Array.isArray(pane.tokens) ||
            Object.values(pane.tokens).some((value) => typeof value !== "string"))) || panes.has(pane.pane_id))
        throw new Error("Invalid Herdr workspace pane inventory");
      panes.set(pane.pane_id, pane);
    }
    if (panes.get(c.pane)?.tab_id !== c.tab)
      throw new Error("Herdr workspace pane inventory does not contain the bound caller pane");
    return panes;
  }
  private async verifyPane(c: ReturnType<typeof caller>, v: Viewer) {
    const pane = await this.herdr("pane", "get", v.pane);
    return pane?.pane?.pane_id === v.pane && pane.pane.tab_id === v.tab && pane.pane.workspace_id === c.workspace && pane.pane.tokens?.router_owner === v.owner;
  }
  private async release(c: ReturnType<typeof caller>, v: Viewer) {
    if (!(await this.verifyPane(c, v))) throw new Error(`Pane ${v.pane} ownership missing or mismatched; retained for manual recovery`);
    await this.herdr("pane", "close", v.pane);
    this.viewers.delete(v.child); this.activity.delete(v.child); this.save();
  }
  async off(session: string) {
    const c = this.current(session);
    ++this.generation; this.enabled = false; this.save();
    const errors: string[] = [];
    if (this.pending) { try { await this.pending; } catch (e) { errors.push(`pending sync: ${String(e)}`); } }
    let panes: Map<string, any> | undefined;
    if (this.viewers.size) {
      try { panes = await this.inventory(c); }
      catch (e) { errors.push(`inventory: ${String(e)}`); }
    }
    if (panes) for (const v of [...this.viewers.values()]) {
      try {
        if (!panes.has(v.pane)) { this.viewers.delete(v.child); this.activity.delete(v.child); this.save(); }
        else await this.release(c, v);
      } catch (e) { errors.push(`${v.pane}: ${String(e)}`); }
    }
    if (errors.length) {
      this.lastError = "owned pane cleanup failed; missing or mismatched ownership retained for manual recovery";
      throw new Error(`Owned pane cleanup failed: ${errors.join("; ")}`);
    }
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
    this.pending = task.then(() => {}, (error) => { this.lastError = /ownership missing or mismatched|changed native session identity/.test(String(error)) ? "ownership mismatch or child identity change; retained for manual recovery" : "sync failed (transport, schema, or server error); retry after checking diagnostics"; throw error; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async reconcile(session: string, selected: {author: string; reviewer: string}, generation: number) {
    const c = this.current(session);
    const origin = await this.herdr("pane", "get", c.pane);
    if (origin?.pane?.pane_id !== c.pane || origin.pane.tab_id !== c.tab || origin.pane.workspace_id !== c.workspace)
      throw new Error("Herdr caller pane does not match inherited workspace/tab/pane");
    const response = await this.transport(c.launcher, ["list", "--json", "--daemon-socket", c.socket], this.context?.env);
    const children = directChildren(response, session);
    const panes = await this.inventory(c); // Validate complete bound workspace before any mutation.
    // Keep existing owned viewers in their slots. New children fill remaining slots
    // in the daemon's roster order; never reorder panes to favor a newcomer.
    const seen = new Set<string>(children.map((s: any) => s.rlmChildId));
    for (const v of [...this.viewers.values()]) if (!seen.has(v.child)) {
      if (!this.enabled || this.generation !== generation) return;
      if (!panes.has(v.pane)) { this.viewers.delete(v.child); this.activity.delete(v.child); this.save(); }
      else await this.release(c, v);
    }
    this.deferred = 0;
    for (const s of children) {
      if (!this.enabled || this.generation !== generation) return;
      const model = `${s.model.provider}/${s.model.id}`;
      const label = `${roleFor(model, selected)}: ${s.sessionName} | ${model}`;
      let v = this.viewers.get(s.rlmChildId);
      if (v && v.session !== s.sessionId) throw new Error(`Child ${s.rlmChildId} changed native session identity; retained pane ${v.pane} for manual recovery`);
      if (v && !panes.has(v.pane)) { this.viewers.delete(v.child); this.activity.delete(v.child); this.save(); v = undefined; }
      if (v && !(await this.verifyPane(c, v))) throw new Error(`Pane ${v.pane} ownership missing or mismatched; retained for manual recovery`);
      if (!this.enabled || this.generation !== generation) return;
      if (!v && this.viewers.size >= 8) { this.deferred++; continue; }
      if (!v) {
        const created = await this.herdr("pane", "split", "--pane", c.pane, "--direction", "right", "--cwd", s.cwd, "--no-focus");
        const pane = created?.pane?.pane_id;
        if (typeof pane !== "string" || !ID.test(pane) || !pane.startsWith(`${c.workspace}:`) || created?.pane?.tab_id !== c.tab)
          throw new Error("Herdr split returned a pane outside the caller tab");
        v = { pane, tab: c.tab, session: s.sessionId, child: s.rlmChildId, source: `router-${randomUUID()}`, owner: randomUUID() };
        this.viewers.set(v.child, v); this.save();
        if (!this.enabled || this.generation !== generation) return;
        try {
          if (!this.enabled || this.generation !== generation) return;
          await this.herdr("pane", "report-metadata", pane, "--source", v.source, "--title", label, "--display-agent", label, "--token", `router_owner=${v.owner}`);
          const command = `exec ${quote(c.launcher)} attach ${quote(s.sessionId)} --daemon-socket ${quote(c.socket)}`;
          if (!this.enabled || this.generation !== generation) return;
          await this.herdr("pane", "run", pane, command);
          if (!this.enabled || this.generation !== generation) return;
        } catch (error) {
          // Never close a pane without an exact matching owner token. A failed
          // metadata call can leave an orphan; retain the record for recovery.
          this.lastError = "viewer setup failed; ownership unverified and record retained for manual recovery";
          throw error;
        }
      } else {
        await this.herdr("pane", "report-metadata", v.pane, "--source", v.source, "--title", label, "--display-agent", label);
      }
      if (!this.enabled || this.generation !== generation) return;
      const state = s.isStreaming === true || s.isCompacting === true ? "working" : "unknown";
      await this.herdr("pane", "report-agent", v.pane, "--source", v.source, "--agent", "prime-agent", "--state", state, "--agent-session-id", s.sessionId);
      this.activity.set(v.child, state);
    }
    if (this.enabled && this.generation === generation) { this.lastSuccess = Date.now(); this.lastError = undefined; }
  }
}
