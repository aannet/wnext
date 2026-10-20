// setupFile de l'étage rapide : `new PGlite(opts)` démarre depuis l'instantané du cluster vierge (pglite-template-global.ts)
// plutôt que de refaire initdb. Même base vide qu'avant (schema.sql reste chargé par chaque test) ; aucune API de test
// ne change. Sans instantané (autre configuration vitest), le vrai PGlite est utilisé tel quel.
import { readFileSync } from "node:fs";
import { vi } from "vitest";

vi.mock("@electric-sql/pglite", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@electric-sql/pglite")>();
  const file = process.env.WNEXT_PGLITE_TEMPLATE;
  if (!file) return mod;
  const template = new Blob([readFileSync(file)]);
  class TemplatedPGlite extends mod.PGlite {
    constructor(options: ConstructorParameters<typeof mod.PGlite>[0] = {}) {
      super(typeof options === "object" && options.loadDataDir === undefined ? { ...options, loadDataDir: template } : options);
    }
  }
  return { ...mod, PGlite: TemplatedPGlite };
});
