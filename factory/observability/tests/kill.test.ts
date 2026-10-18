import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error JS sans typages
import { groupAlive, isKilled, launchSession, readState, resumeFactory, stopAll } from "../../lib/kill.mjs";
import { validateEvent } from "@/lib/validate";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "../../hooks/kill-hook.mjs");
const FACTORY = path.join(HERE, "../../bin/factory.mjs");
const AGENT = path.join(HERE, "fixtures/fake-agent.mjs");

let dir: string, killFile: string, stateFile: string, env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "factory-kill-"));
  killFile = path.join(dir, "KILL"); stateFile = path.join(dir, "sessions.json");
  env = { ...process.env, FACTORY_KILL_FILE: killFile, FACTORY_STATE_FILE: stateFile, OBS_LINE: "P0-901", OBS_PHASE: "P0" };
  delete env.OBS_URL; delete env.OBS_RUN_ID;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const payload = JSON.stringify({ session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} });
const runHook = (e: NodeJS.ProcessEnv) => spawnSync(process.execPath, [HOOK], { input: payload, env: e, encoding: "utf8" });

describe("hook PreToolUse kill", () => {
  it("(a) sans KILL : autorise (exit 0, aucune sortie)", () => {
    const r = runHook(env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("(b) avec KILL : refuse (exit 2) et émet kill.triggered valide", async () => {
    writeFileSync(killFile, "x");
    const got: unknown[] = [];
    const srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(JSON.parse(b)); res.end("{}"); }); });
    await new Promise<void>((r) => srv.listen(0, r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const file = path.join(dir, "events.jsonl");
    const r = await new Promise<{ status: number | null; stderr: string }>((res) => {
      import("node:child_process").then(({ spawn }) => {
        const c = spawn(process.execPath, [HOOK], { env: { ...env, OBS_URL: url, OBS_EVENTS_FILE: file } });
        let stderr = ""; c.stderr.on("data", (d) => (stderr += d));
        c.on("close", (status) => res({ status, stderr }));
        c.stdin.end(payload);
      });
    });
    srv.close();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/KILL/);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ action: "kill.triggered", status: "killed", line: "P0-901", detail: { tool: "Write" } });
    expect(validateEvent(got[0]).ok).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8").trim())).toMatchObject({ action: "kill.triggered" });
  });

  it("refuse même sans payload lisible", () => {
    writeFileSync(killFile, "x");
    expect(spawnSync(process.execPath, [HOOK], { input: "pas du json", env, encoding: "utf8" }).status).toBe(2);
  });
});

describe("resume réservé aux humains", () => {
  it("exige la confirmation explicite et refuse depuis une session d'agent", () => {
    writeFileSync(killFile, "x");
    expect(() => resumeFactory({ killFile })).toThrow(/confirmation/);
    expect(() => resumeFactory({ confirm: "--yes", killFile })).toThrow(/confirmation/);
    expect(() => resumeFactory({ confirm: "--i-am-human", killFile, env: { OBS_RUN_ID: "X" } })).toThrow(/agent/);
    expect(isKilled(killFile)).toBe(true);
    expect(resumeFactory({ confirm: "--i-am-human", killFile, env: {} })).toBe(true);
    expect(isKilled(killFile)).toBe(false);
  });

  it("CLI : sans argument, KILL reste", () => {
    writeFileSync(killFile, "x");
    expect(spawnSync(process.execPath, [FACTORY, "resume"], { env, encoding: "utf8" }).status).toBe(2);
    expect(existsSync(killFile)).toBe(true);
    expect(spawnSync(process.execPath, [FACTORY, "resume", "--i-am-human"], { env, encoding: "utf8" }).status).toBe(0);
    expect(existsSync(killFile)).toBe(false);
  });
});

async function waitPids(file: string, n: number) {
  for (let i = 0; i < 100; i++) {
    const pids = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
    if (pids.length >= n) return pids;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("faux agent non démarré");
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("factory stop --all (intégration, sans LLM)", () => {
  it("tue l'agent et ses enfants (SIGTERM au groupe) en < 30 s", async () => {
    const pidfile = path.join(dir, "pids");
    const child = launchSession({ command: process.execPath, args: [AGENT, pidfile], label: "fake" }, { killFile, stateFile });
    const pids = await waitPids(pidfile, 3);
    expect(Object.keys(readState(stateFile))).toEqual([String(child.pid)]);
    expect(groupAlive(child.pid)).toBe(true);

    const r = await stopAll({ graceMs: 10_000, killFile, stateFile });
    console.log(`arrêt mesuré (SIGTERM) : ${r.elapsed_ms} ms`);
    expect(r).toMatchObject({ groups: 1, escalated: 0, survivors: 0 });
    expect(r.elapsed_ms).toBeLessThan(30_000);
    expect(isKilled(killFile)).toBe(true);
    for (const p of pids) expect(alive(p)).toBe(false);
    expect(readState(stateFile)).toEqual({});
  }, 40_000);

  it("escalade en SIGKILL si l'agent ignore SIGTERM", async () => {
    const pidfile = path.join(dir, "pids");
    const child = launchSession({ command: process.execPath, args: [AGENT, pidfile, "stubborn"] }, { killFile, stateFile });
    const pids = await waitPids(pidfile, 3);
    const r = await stopAll({ graceMs: 1_000, killFile, stateFile });
    console.log(`arrêt mesuré (SIGKILL après 1 s de grâce) : ${r.elapsed_ms} ms`);
    expect(r).toMatchObject({ groups: 1, escalated: 1, survivors: 0 });
    expect(r.elapsed_ms).toBeLessThan(30_000);
    for (const p of pids) expect(alive(p)).toBe(false);
    expect(groupAlive(child.pid!)).toBe(false);
  }, 40_000);

  it("refuse de lancer une session quand KILL existe", () => {
    writeFileSync(killFile, "x");
    expect(() => launchSession({ command: process.execPath, args: ["-e", "0"] }, { killFile, stateFile })).toThrow(/kill-switch/);
  });
});
