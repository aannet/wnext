/**
 * Scribe Haiku : lit les événements (base ouverte en LECTURE SEULE), écrit un journal de run lisible
 * et un rapport de gate de phase dans reports/. Ne modifie jamais les événements.
 *
 *   npm run scribe -- journal --line P1-001 [--run <ULID>] [--dry-run]
 *   npm run scribe -- gate --phase P0 [--dry-run]
 * Options : --db data/events.db  --out reports  --dry-run (aucun appel API)
 * Clé : variable d'environnement ANTHROPIC_API_KEY (jamais commitée).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, gateData, gateFacts, gatePrompt, journalFacts, journalPrompt, runEvents } from "./facts";

export const SCRIBE_MODEL = "claude-haiku-5-5";

export type Narrator = (system: string, prompt: string) => Promise<string>;

/** Appel réel à Haiku via le SDK officiel. Le client lit ANTHROPIC_API_KEY dans l'environnement. */
export function haikuNarrator(): Narrator {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY absente (utiliser --dry-run pour tester sans appel API).");
  const client = new Anthropic();
  return async (system, prompt) => {
    const res = await client.messages.create({
      model: SCRIBE_MODEL,
      max_tokens: 4000,
      system,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new Error("Haiku a refusé la requête (stop_reason=refusal).");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
    if (!text) throw new Error(`Réponse vide (stop_reason=${res.stop_reason}).`);
    return text;
  };
}

const dryRunNarrator: Narrator = async () => "_[dry-run : synthèse Haiku non générée, aucun appel API]_";

export async function writeJournal(db: Database.Database, sel: { run?: string; line?: string }, narrate: Narrator): Promise<string> {
  const events = runEvents(db, sel);
  const facts = journalFacts(events);
  const story = events.length ? await narrate(SYSTEM_PROMPT, journalPrompt(facts)) : "_Aucun événement._";
  return `# Journal de run — ${sel.run ?? sel.line}\n\n## Synthèse\n\n${story}\n\n## Faits (extraits des événements)\n\n${facts}`;
}

export async function writeGateReport(db: Database.Database, phase: string, narrate: Narrator): Promise<string> {
  const facts = gateFacts(gateData(db, phase));
  const story = await narrate(SYSTEM_PROMPT, gatePrompt(facts));
  return `# Rapport de gate — ${phase}\n\n## Synthèse\n\n${story}\n\n## Faits (extraits des événements)\n\n${facts}`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--dry-run") flags.add("dry-run");
    else if (rest[i].startsWith("--")) a.set(rest[i].slice(2), rest[++i]);
  }
  const dbPath = a.get("db") ?? process.env.OBS_DB_PATH ?? "data/events.db";
  const outDir = a.get("out") ?? "reports";
  if (!fs.existsSync(dbPath)) throw new Error(`Base introuvable : ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const narrate = flags.has("dry-run") ? dryRunNarrator : haikuNarrator();
  fs.mkdirSync(outDir, { recursive: true });
  let md: string, file: string;
  if (cmd === "journal") {
    const sel = { run: a.get("run"), line: a.get("line") };
    if (!sel.run && !sel.line) throw new Error("journal : --line <P1-001> ou --run <ULID> requis");
    md = await writeJournal(db, sel, narrate);
    file = path.join(outDir, `journal-${sel.run ?? sel.line}.md`);
  } else if (cmd === "gate") {
    const phase = a.get("phase");
    if (!phase) throw new Error("gate : --phase <P0..P5> requis");
    md = await writeGateReport(db, phase, narrate);
    file = path.join(outDir, `gate-${phase}.md`);
  } else {
    throw new Error("Usage : scribe <journal|gate> ... [--dry-run]");
  }
  fs.writeFileSync(file, md);
  db.close();
  console.log(`Écrit : ${file}${flags.has("dry-run") ? " (dry-run)" : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error("scribe :", e.message); process.exit(1); });
}
