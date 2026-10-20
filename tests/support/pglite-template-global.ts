// globalSetup de l'étage rapide : initdb de PGlite une seule fois, instantané du cluster vierge écrit dans un fichier
// temporaire. Chaque `new PGlite(...)` des tests repart de cet instantané (voir pglite-template-setup.ts) au lieu de
// refaire initdb (~1,8 s de CPU par instance). L'instantané ne contient que le cluster initdb : aucun schéma, aucune donnée.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

export default async function setup() {
  if (process.env.WNEXT_NO_TEMPLATE) return; // interrupteur de diagnostic : PGlite refait son initdb comme avant
  const pg = new PGlite();
  await pg.waitReady;
  const dump = await pg.dumpDataDir("none");
  await pg.close();
  const dir = mkdtempSync(join(tmpdir(), "wnext-pglite-"));
  const file = join(dir, "template.tar");
  writeFileSync(file, Buffer.from(await dump.arrayBuffer()));
  process.env.WNEXT_PGLITE_TEMPLATE = file;
  return () => {
    delete process.env.WNEXT_PGLITE_TEMPLATE;
    rmSync(dir, { recursive: true, force: true });
  };
}
