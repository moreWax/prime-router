#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, closeSync, unlinkSync, rmdirSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const keys = ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"];
const [root, socket, launcher, extra] = process.argv.slice(2);
const env = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
if (extra || !ID.test(root ?? "") || ![socket, launcher, env.HERDR_SOCKET_PATH].every((v) => typeof v === "string" && isAbsolute(v) && !/[\0\r\n]/.test(v)) ||
    env.HERDR_ENV !== "1" || ![env.HERDR_WORKSPACE_ID, env.HERDR_TAB_ID, env.HERDR_PANE_ID].every((v) => ID.test(v ?? "")) ||
    !env.HERDR_TAB_ID.startsWith(`${env.HERDR_WORKSPACE_ID}:`) || !env.HERDR_PANE_ID.startsWith(`${env.HERDR_WORKSPACE_ID}:`)) {
  console.error("Run inside a real Herdr pane: node bin/herdr-bind.mjs <root-session-id> <absolute-daemon-socket> <absolute-prime-launcher>");
  process.exitCode = 1;
} else {
  try {
    accessSync(launcher, constants.X_OK);
    const dir = join(tmpdir(), `prime-router-herdr-${randomUUID()}`);
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, "binding.json");
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ version: 1, root, env, binding: { socket, launcher }, token: randomBytes(32).toString("hex"), expiresAt: Date.now() + 120000 }));
      } finally { closeSync(fd); }
      console.log(path);
    } catch (error) { try { unlinkSync(path); } catch {} try { rmdirSync(dir); } catch {} throw error; }
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
