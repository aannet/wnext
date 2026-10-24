// Regles de frontieres du monorepo (ADR-003 §2, docs/00-factory/strategy.md §4.6.10).
// Appliquees par scripts/lint-boundaries.mjs (npm run lint:boundaries).
// `dir` : racine du paquet ; `monorepo` : paquets @wnext/* importables ;
// `rule` : identifiant rapporte si un import monorepo interdit est detecte ;
// `external` : si defini, liste fermee des dependances externes (nom de paquet npm).
export default {
  scope: "@wnext/",
  packages: {
    "@wnext/web": { dir: "apps/web", monorepo: ["@wnext/contracts", "@wnext/engine"], rule: "app-isolation" },
    "@wnext/api": { dir: "apps/api", monorepo: ["@wnext/contracts", "@wnext/engine"], rule: "app-isolation" },
    "@wnext/contracts": { dir: "packages/contracts", monorepo: [], rule: "contracts-no-monorepo", external: ["zod"], externalRule: "contracts-only-zod" },
    "@wnext/engine": { dir: "packages/engine", monorepo: ["@wnext/contracts"], rule: "engine-only-contracts" },
    // Outillage hors graphe runtime (Zod -> OpenAPI -> client) : n'importe que contracts ; personne ne l'importe (cf. forbidden).
    "@wnext/contracts-tools": {
      dir: "packages/contracts-tools",
      monorepo: ["@wnext/contracts"],
      rule: "tools-only-contracts",
      // vitest : import des tests uniquement (devDependency racine).
      external: ["zod", "@asteasolutions/zod-to-openapi", "tsx", "vitest", "node:*"],
      externalRule: "tools-only-allowed-externals",
    },
  },
  // Paquets importables par personne : toute importation, quel que soit le paquet appelant, est rapportee avec cette regle.
  forbidden: {
    "@wnext/contracts-tools": "no-import-contracts-tools",
  },
  // Dossiers du monorepo : un import nu qui y commence est un contournement.
  monorepoRoots: ["apps/", "packages/"],
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  ignoreDirs: ["node_modules", "dist", "coverage", ".next"],
};
