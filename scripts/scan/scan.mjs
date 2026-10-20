#!/usr/bin/env node
// Scan de sécurité (npm run scan), HORS make check : secrets (gitleaks, historique complet), dépendances
// (OSV-Scanner sur package-lock.json) et code (Semgrep p/typescript + p/nodejs + p/security-audit, installé par pip dans .venv-scan).
// Outils épinglés (scripts/scan/tools.mjs, requirements-semgrep.txt). Rapports dans tests/security/out/ (ignoré par le dépôt),
// résumé lisible sur la sortie standard, exclusions justifiées dans tests/security/.
// Code de sortie : 1 si un constat CRITIQUE (secret détecté, CVSS >= 9, impact Semgrep CRITICAL) ou une erreur d'outil ;
// avec --strict, 1 aussi pour un constat HAUT (CVSS >= 7, Semgrep ERROR). Option --only=secrets,deps,code.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureTool, readJson, root, run } from "./tools.mjs";

const out = join(root, "tests", "security", "out");
const cfg = join(root, "tests", "security");
const venv = join(root, ".venv-scan");
const strict = process.argv.includes("--strict");
const only = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "secrets,deps,code").split(",");
mkdirSync(out, { recursive: true });

const empty = () => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
const sev = (score) => (score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "unknown");

function secrets(bin) {
  const report = join(out, "gitleaks.json");
  rmSync(report, { force: true });
  // Historique complet des commits (sous-commande de scan de l'historique), secrets masqués dans le rapport.
  const args = ["git", "--no-banner", "--config", join(cfg, "gitleaks.toml"), "--report-format", "json", "--report-path", report, "--redact", "--exit-code", "0", root];
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gitleaks : ${r.stderr || r.stdout}`);
  const findings = readJson(report, []);
  const c = empty();
  c.critical = findings.length; // tout secret est critique tant qu'il n'est pas justifié dans gitleaks.toml
  return { counts: c, lines: findings.slice(0, 20).map((f) => `${f.RuleID} ${f.File}:${f.StartLine} (${String(f.Commit).slice(0, 8)})`) };
}

function deps(bin) {
  const report = join(out, "osv.json");
  rmSync(report, { force: true });
  const args = ["scan", "source", "--config", join(cfg, "osv-scanner.toml"), "--lockfile", join(root, "package-lock.json"), "--format", "json", "--output-file", report];
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (![0, 1].includes(r.status ?? -1)) throw new Error(`osv-scanner : code ${r.status} ${r.stderr}`);
  const data = readJson(report, { results: [] });
  const c = empty();
  const lines = [];
  for (const res of data.results ?? []) {
    for (const p of res.packages ?? []) {
      const byId = new Map((p.vulnerabilities ?? []).map((v) => [v.id, v]));
      for (const g of p.groups ?? []) {
        const score = Number(g.max_severity);
        const level = Number.isFinite(score) ? sev(score) : "unknown";
        c[level]++;
        lines.push(`${level.toUpperCase()} ${p.package.name}@${p.package.version} ${g.ids?.[0]} ${byId.get(g.ids?.[0])?.summary ?? ""}`.trim());
      }
    }
  }
  return { counts: c, lines: lines.slice(0, 30) };
}

function code() {
  const sg = join(venv, "bin", "semgrep");
  if (!existsSync(sg)) {
    rmSync(venv, { recursive: true, force: true });
    if (spawnSync("python3", ["-m", "venv", venv], { stdio: "ignore" }).status !== 0) {
      rmSync(venv, { recursive: true, force: true });
      run("python3", ["-m", "venv", "--without-pip", venv]);
      const getPip = join(out, "get-pip.py");
      run("curl", ["-fsSL", "https://bootstrap.pypa.io/get-pip.py", "-o", getPip]);
      run(join(venv, "bin", "python"), [getPip, "-q"]);
    }
    run(join(venv, "bin", "pip"), ["install", "-q", "-r", join("scripts", "scan", "requirements-semgrep.txt")]);
  }
  const ex = readJson(join(cfg, "semgrep-exclusions.json"), { rules: [], paths: [] });
  const report = join(out, "semgrep.json");
  rmSync(report, { force: true });
  const args = ["scan", "--metrics=off", "--quiet", "--json", "--output", report, "--config", "p/typescript", "--config", "p/nodejs", "--config", "p/security-audit",
    ...ex.paths.flatMap((p) => ["--exclude", p.pattern]), ...ex.rules.flatMap((r) => ["--exclude-rule", r.id]), "."];
  const r = spawnSync(sg, args, { cwd: root, encoding: "utf8", env: { ...process.env, SEMGREP_SEND_METRICS: "off" } });
  if (!existsSync(report)) throw new Error(`semgrep : code ${r.status} ${r.stderr}`);
  const data = readJson(report, { results: [], errors: [] });
  const c = empty();
  const lines = [];
  for (const f of data.results) {
    const s = String(f.extra?.severity ?? "").toUpperCase();
    const level = String(f.extra?.metadata?.impact).toUpperCase() === "CRITICAL" ? "critical" : s === "ERROR" ? "high" : s === "WARNING" ? "medium" : "low";
    c[level]++;
    lines.push(`${level.toUpperCase()} ${f.path}:${f.start.line} ${f.check_id.split(".").slice(-1)[0]}`);
  }
  return { counts: c, lines: lines.slice(0, 40), errors: data.errors?.length ?? 0 };
}

const steps = {
  secrets: async () => secrets(await ensureTool("gitleaks")),
  deps: async () => deps(await ensureTool("osv-scanner")),
  code: async () => code(),
};
const summary = {};
for (const [name, fn] of Object.entries(steps)) {
  if (!only.includes(name)) continue;
  try { summary[name] = await fn(); } catch (err) { summary[name] = { error: err instanceof Error ? err.message : String(err) }; }
}

let critical = 0;
let high = 0;
const label = { secrets: "Secrets (gitleaks)", deps: "Dépendances (OSV-Scanner)", code: "Code (Semgrep)" };
console.log("\n=== Résumé du scan de sécurité ===");
for (const [name, s] of Object.entries(summary)) {
  if (s.error) { console.log(`${label[name]} : ERREUR ${s.error}`); critical++; continue; }
  const c = s.counts;
  critical += c.critical;
  high += c.high;
  console.log(`${label[name]} : critique ${c.critical}, haut ${c.high}, moyen ${c.medium}, bas ${c.low}${c.unknown ? `, inconnu ${c.unknown}` : ""}${s.errors ? `, erreurs d'analyse ${s.errors}` : ""}`);
  for (const l of s.lines) console.log(`  - ${l}`);
}
writeFileSync(join(out, "resume.json"), JSON.stringify({ summary, critical, high, strict }, null, 2));
console.log(`\nRapports : ${out}`);
const fail = critical > 0 || (strict && high > 0);
console.log(fail ? `ECHEC : constat critique${strict ? " ou haut" : ""}` : "OK : aucun constat critique");
process.exit(fail ? 1 : 0);
