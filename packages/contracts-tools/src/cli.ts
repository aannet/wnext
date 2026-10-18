import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { findBreakingChanges } from "./breaking";
import { generateClient } from "./client";
import { buildSpec } from "./openapi";
import { paths } from "./paths";

const render = () => {
  const spec = buildSpec();
  return { spec: JSON.stringify(spec, null, 2) + "\n", client: generateClient(spec) };
};
const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "generate") {
  const r = render();
  writeFileSync(paths.spec, r.spec);
  writeFileSync(paths.client, r.client);
  console.log("ecrit :", paths.spec, paths.client);
} else if (cmd === "check") {
  const r = render();
  const drift = [
    read(paths.spec) !== r.spec && "packages/contracts/openapi.json",
    read(paths.client) !== r.client && "apps/web/src/api/client.gen.ts",
  ].filter(Boolean);
  if (drift.length) {
    console.error(`DERIVE : ${drift.join(", ")} different(s) de la generation. Lancer : npm run generate:contract`);
    process.exit(1);
  }
  console.log("check:contract OK (spec et client a jour)");
} else if (cmd === "breaking") {
  // --base <fichier> ou --ref <git-ref> (defaut : origin/main s'il existe, sinon HEAD)
  const i = args.indexOf("--base");
  let baseText: string;
  if (i >= 0) baseText = readFileSync(args[i + 1]!, "utf8");
  else {
    const j = args.indexOf("--ref");
    const ref = j >= 0 ? args[j + 1]! : "HEAD";
    try {
      baseText = execFileSync("git", ["show", `${ref}:packages/contracts/openapi.json`], { cwd: paths.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      console.log(`check:breaking : pas de spec de reference sur ${ref} (premiere version), rien a comparer`);
      process.exit(0);
    }
  }
  const found = findBreakingChanges(JSON.parse(baseText), JSON.parse(render().spec));
  if (found.length) {
    console.error("RUPTURES detectees (incrementer la version d'API ou declarer la rupture) :\n- " + found.join("\n- "));
    process.exit(1);
  }
  console.log("check:breaking OK (aucune rupture)");
} else {
  console.error("usage : generate | check | breaking [--base f | --ref r]");
  process.exit(2);
}
