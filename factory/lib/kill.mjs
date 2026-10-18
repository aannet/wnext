/**
 * Kill-switch de la factory (strategy.md §4.5, ADR-007).
 * Fichier `factory/KILL` + suivi des sessions lancées (pgid) + arrêt de groupe SIGTERM puis SIGKILL.
 * Seul un humain lève le kill-switch (`resumeFactory`, appelé par `factory resume`).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const killFilePath = () => process.env.FACTORY_KILL_FILE ?? path.join(ROOT, "KILL");
export const stateFilePath = () => process.env.FACTORY_STATE_FILE ?? path.join(ROOT, "state", "sessions.json");

export const isKilled = (killFile = killFilePath()) => existsSync(killFile);

export function readState(stateFile = stateFilePath()) {
  try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return {}; }
}
function writeState(state, stateFile) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}
export const trackSession = (rec, stateFile = stateFilePath()) => { const s = readState(stateFile); s[String(rec.pgid)] = rec; writeState(s, stateFile); };
export const untrackSession = (pgid, stateFile = stateFilePath()) => { const s = readState(stateFile); delete s[String(pgid)]; writeState(s, stateFile); };

/**
 * Lance une session (ex. `claude -p`) dans son propre groupe de processus (`detached: true`, pgid = pid)
 * et la consigne dans le fichier d'état. Refuse de lancer si le kill-switch est actif.
 * C'est LA fonction de lancement que l'orchestrateur doit utiliser pour toute session.
 */
export function launchSession({ command, args = [], cwd, env, label = command, stdio = "ignore" }, { killFile = killFilePath(), stateFile = stateFilePath() } = {}) {
  if (isKilled(killFile)) throw new Error("kill-switch actif : lancement refusé");
  const child = spawn(command, args, { cwd, env: env ?? process.env, detached: true, stdio });
  if (!child.pid) throw new Error(`échec du lancement de ${command}`);
  trackSession({ pid: child.pid, pgid: child.pid, label, started_at: new Date().toISOString() }, stateFile);
  child.on("exit", () => untrackSession(child.pid, stateFile));
  return child;
}

/** Vrai tant qu'au moins un processus du groupe existe (un zombie compte : il disparaît une fois réapé). */
export function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
const sig = (pgid, s) => { try { process.kill(-pgid, s); } catch { /* déjà mort */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pgids, timeoutMs, pollMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!pgids.some(groupAlive)) return true;
    await sleep(pollMs);
  }
  return !pgids.some(groupAlive);
}

/**
 * `factory stop --all` : crée KILL, SIGTERM à chaque groupe suivi, attend `graceMs`, SIGKILL des survivants.
 * @returns {{ groups: number, escalated: number, survivors: number, elapsed_ms: number }}
 */
export async function stopAll({ graceMs = 10_000, killWaitMs = 5_000, pollMs = 50, killFile = killFilePath(), stateFile = stateFilePath(), onEvent } = {}) {
  const t0 = Date.now();
  mkdirSync(path.dirname(killFile), { recursive: true });
  writeFileSync(killFile, `${new Date().toISOString()} stop --all\n`);
  const pgids = Object.values(readState(stateFile)).map((r) => r.pgid).filter(groupAlive);
  onEvent?.({ phase: "kill.triggered", groups: pgids.length });
  for (const g of pgids) sig(g, "SIGTERM");
  let escalated = 0;
  if (!(await waitGone(pgids, graceMs, pollMs))) {
    const left = pgids.filter(groupAlive);
    escalated = left.length;
    for (const g of left) sig(g, "SIGKILL");
    await waitGone(left, killWaitMs, pollMs);
  }
  const survivors = pgids.filter(groupAlive).length;
  const s = readState(stateFile);
  for (const g of pgids) if (!groupAlive(g)) delete s[String(g)];
  writeState(s, stateFile);
  return { groups: pgids.length, escalated, survivors, elapsed_ms: Date.now() - t0 };
}

/** Lève le kill-switch. Réservé aux humains : exige la confirmation explicite et refuse dans une session d'agent. */
export const RESUME_CONFIRMATION = "--i-am-human";
export function resumeFactory({ confirm, killFile = killFilePath(), env = process.env } = {}) {
  if (confirm !== RESUME_CONFIRMATION) throw new Error(`confirmation requise : factory resume ${RESUME_CONFIRMATION}`);
  if (env.OBS_RUN_ID || env.FACTORY_SESSION) throw new Error("refusé : appelé depuis une session d'agent (seul un humain lève le kill-switch)");
  const was = existsSync(killFile);
  rmSync(killFile, { force: true });
  return was;
}
