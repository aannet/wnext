// Configuration vitest de l'étage rapide (`npm run test:fast`, appelé par `make check`).
// Un seul run, un seul pool de workers pour tous les tests sans état partagé hors processus : web, api, contracts-tools,
// boundaries, parity, guardrails, e2e, migrations. Chaque worker qui ouvre un PGlite pèse ~0,6 Go : le nombre de workers
// est borné (MAX_WORKERS, défaut 4) pour tenir sous ~2,5 Go quelle que soit la machine, au lieu de cœurs - 1 par workspace.
// Les PGlite partent d'un instantané initdb pris une fois (tests/support/pglite-template-*.ts), pas d'un initdb par fichier.
// Hors de ce run, volontairement : packages/engine (ses tests tournent dans l'étape de couverture, seuils inchangés) et
// tests/concurrency (Postgres embarqué, sensible à la charge : étape séquentielle dédiée). Les scripts test:* unitaires
// (`vitest run tests/e2e`...) restent utilisables seuls avec la configuration par défaut.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const setupFiles = [here("./tests/support/pglite-template-setup.ts")];
const tests = (name: string, dir: string) => ({ test: { name, include: [`${dir}/**/*.test.ts`], setupFiles } });
const pkg = (name: string, root: string) => ({ test: { name, root, include: ["test/**/*.test.ts"], setupFiles } });

export default defineConfig({
  test: {
    pool: "threads", // mesuré à 4 workers : ~35 s et ~2,3 Go contre ~47 s et ~2,6 Go en forks
    maxWorkers: Number(process.env.MAX_WORKERS ?? 4),
    globalSetup: [here("./tests/support/pglite-template-global.ts")],
    projects: [
      "apps/web",
      pkg("api", "apps/api"),
      pkg("contracts-tools", "packages/contracts-tools"),
      tests("boundaries", "tests/boundaries"),
      tests("parity", "tests/parity"),
      tests("guardrails", "tests/guardrails"),
      tests("e2e", "tests/e2e"),
      tests("migrations", "tests/migrations"),
    ],
  },
});
