#!/usr/bin/env node
// Schemathesis contre l'API réelle (npm run test:schemathesis), HORS make check : critère de sortie P2 « contrat OpenAPI vert ».
//  1. venv .venv-schemathesis (versions épinglées dans requirements.txt ; amorçage de pip via get-pip.py si ensurepip manque).
//  2. pile dédiée (scripts/dev-stack.mjs, ports 3200/54349, dossier Postgres tests/schemathesis/out/pg, RLS active).
//  3. passes : admin (tous les checks sauf exclusions documentées) puis member (mêmes checks, 403 documentés).
//  4. rapports JUnit + texte dans tests/schemathesis/out/ (ignoré par le dépôt) ; la pile est toujours arrêtée.
// Variables : ST_EXAMPLES (défaut 25 cas par opération), ST_SEED (défaut 1), ST_ROLES (défaut « admin,member »),
// ST_EXCLUDE_CHECKS, ST_API_PORT, ST_PG_PORT.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "tests", "schemathesis", "out");
const venv = join(root, ".venv-schemathesis");
const bin = (n) => join(venv, "bin", n);
const apiPort = process.env.ST_API_PORT ?? "3200";
const pgPort = process.env.ST_PG_PORT ?? "54349";
const examples = process.env.ST_EXAMPLES ?? "25";
const seed = process.env.ST_SEED ?? "1";
const roles = (process.env.ST_ROLES ?? "admin,member").split(",");
// Checks : tous, exclusions justifiées dans schemathesis.toml.

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} : code ${r.status}`);
}

mkdirSync(out, { recursive: true });

function ensureVenv() {
  if (existsSync(bin("schemathesis"))) return;
  rmSync(venv, { recursive: true, force: true });
  if (spawnSync("python3", ["-m", "venv", venv], { stdio: "ignore" }).status !== 0) {
    rmSync(venv, { recursive: true, force: true });
    run("python3", ["-m", "venv", "--without-pip", venv]);
    const getPip = join(out, "get-pip.py");
    run("curl", ["-fsSL", "https://bootstrap.pypa.io/get-pip.py", "-o", getPip]);
    run(bin("python"), [getPip, "-q"]);
  }
  run(bin("pip"), ["install", "-q", "-r", join("tests", "schemathesis", "requirements.txt")]);
}

async function waitReady(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* pas encore prête */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`l'API ne répond pas sur ${url}`);
}

ensureVenv();
rmSync(join(out, "pg"), { recursive: true, force: true });

const log = createWriteStream(join(out, "stack.log"));
const stack = spawn(process.execPath, ["scripts/dev-stack.mjs", "--reset"], {
  cwd: root,
  env: {
    ...process.env, WNEXT_DEV_API_PORT: apiPort, WNEXT_DEV_PG_PORT: pgPort, WNEXT_DEV_PG_DIR: join(out, "pg"),
    // Les limites de débit des tickets temps réel fausseraient le fuzz (429 attendus ailleurs, testés en e2e).
    TICKET_RATE_PER_USER: "1000000", TICKET_RATE_PER_ACCOUNT: "1000000", WS_UPGRADE_RATE_PER_ACCOUNT: "1000000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
stack.stdout.pipe(log);
stack.stderr.pipe(log);
const stopStack = () => new Promise((res) => {
  if (stack.exitCode !== null) return res();
  const t = setTimeout(() => { stack.kill("SIGKILL"); res(); }, 30_000);
  stack.once("exit", () => { clearTimeout(t); res(); });
  stack.kill("SIGTERM");
});
process.on("SIGINT", () => void stopStack().then(() => process.exit(130)));

let failed = false;
try {
  await waitReady(`http://127.0.0.1:${apiPort}/api/v1/health`, 180_000);
  for (const role of roles) {
    console.log(`\n=== Schemathesis, rôle ${role} ===`);
    const args = [
      "--config-file", join("tests", "schemathesis", "schemathesis.toml"),
      "run", join("packages", "contracts", "openapi.json"), "--url", `http://127.0.0.1:${apiPort}`,
      "-H", "x-dev-account-id: 1", "-H", "x-dev-user-id: 1", "-H", `x-dev-role: ${role}`,
      "--max-examples", examples, "--seed", seed, "--workers", "1", "--request-timeout", "10",
      "--phases", process.env.ST_PHASES ?? "examples,coverage,fuzzing", "--no-color", "--generation-database", "none",
      "--report", "junit", "--report-junit-path", join(out, `junit-${role}.xml`),
    ];
    const txt = createWriteStream(join(out, `rapport-${role}.txt`));
    const code = await new Promise((res) => {
      const p = spawn(bin("schemathesis"), args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      for (const s of [p.stdout, p.stderr]) s.on("data", (d) => { process.stdout.write(d); txt.write(d); });
      p.on("exit", (c) => { txt.end(); res(c); });
    });
    if (code !== 0) failed = true;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  failed = true;
} finally {
  await stopStack();
}
console.log(`\nRapports : ${out} (rapport-<rôle>.txt, junit-<rôle>.xml, stack.log)`);
process.exit(failed ? 1 : 0);
