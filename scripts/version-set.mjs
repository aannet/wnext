#!/usr/bin/env node
// Change la version du produit (`npm run version:set -- X.Y.Z`) : package.json racine, chaque workspace et package-lock.json,
// sans commit ni tag (à faire à la main, avec l'entrée de CHANGELOG.md). Cohérence vérifiée par tests/guardrails/version.test.ts.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage : npm run version:set -- X.Y.Z");
  process.exit(1);
}
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = (...args) => execFileSync("npm", args, { cwd, stdio: "inherit" });
npm("version", version, "--workspaces", "--include-workspace-root", "--no-git-tag-version", "--no-workspaces-update", "--allow-same-version");
npm("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund");
