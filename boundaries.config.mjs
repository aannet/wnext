// Regles de frontieres du monorepo (ADR-003 §2, docs/factory/strategy.md §4.6.10).
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
  },
  // Dossiers du monorepo : un import nu qui y commence est un contournement.
  monorepoRoots: ["apps/", "packages/"],
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  ignoreDirs: ["node_modules", "dist", "coverage", ".next"],
};
