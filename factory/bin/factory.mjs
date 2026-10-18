#!/usr/bin/env node
/** CLI de la factory : `factory stop --all` | `factory resume --i-am-human` | `factory status`. */
import { isKilled, killFilePath, readState, resumeFactory, stopAll, groupAlive, RESUME_CONFIRMATION } from "../lib/kill.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const grace = Number(process.env.FACTORY_STOP_GRACE_MS ?? 10_000);

async function postKillEvent(info) {
  if (!process.env.OBS_URL) return;
  const { buildKillEvent } = await import("../hooks/kill-hook.mjs");
  const e = { ...buildKillEvent({ session_id: "cli-stop" }, { ...process.env, OBS_AGENT: "orchestrateur" }), detail: { groups: info.groups, escalated: info.escalated, elapsed_ms: info.elapsed_ms } };
  await fetch(`${process.env.OBS_URL}/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(1500) }).catch(() => {});
}

if (cmd === "stop" && rest.includes("--all")) {
  const r = await stopAll({ graceMs: grace });
  await postKillEvent(r);
  console.log(`KILL créé (${killFilePath()}) ; ${r.groups} groupe(s) arrêté(s), ${r.escalated} en SIGKILL, ${r.survivors} survivant(s), ${r.elapsed_ms} ms`);
  process.exit(r.survivors ? 1 : 0);
} else if (cmd === "resume") {
  try {
    console.log(resumeFactory({ confirm: rest[0] }) ? "kill-switch levé" : "aucun kill-switch actif");
  } catch (e) { console.error(e.message); process.exit(2); }
} else if (cmd === "status") {
  const live = Object.values(readState()).filter((r) => groupAlive(r.pgid));
  console.log(`kill-switch : ${isKilled() ? "ACTIF" : "inactif"} ; sessions suivies vivantes : ${live.length}`);
} else {
  console.error(`usage : factory stop --all | factory resume ${RESUME_CONFIRMATION} | factory status`);
  process.exit(64);
}
