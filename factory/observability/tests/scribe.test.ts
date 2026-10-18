import { describe, expect, it, vi } from "vitest";
import { writeGateReport, writeJournal, type Narrator } from "../scribe/index";
import { evs, ev, memStore } from "./helpers";

describe("scribe", () => {
  const seed = () => {
    const s = memStore();
    s.ingest([...evs(3, { line: "P1-001" }), ev({ ts: "2026-10-18T09:01:00.000Z", line: "P1-001", action: "ci.result", status: "ok", attempt: 1, agent: "sentinelle", model: "none" })]);
    return s;
  };
  it("dry-run : produit journal et gate sans appeler de narrateur réel", async () => {
    const s = seed();
    const dry: Narrator = async () => "_[dry-run]_";
    const j = await writeJournal(s.db, { line: "P1-001" }, dry);
    expect(j).toContain("# Journal de run — P1-001");
    expect(j).toContain("| implementeur | llm.call |");
    const g = await writeGateReport(s.db, "P1", dry);
    expect(g).toContain("# Rapport de gate — P1");
    expect(g).toContain("premier passage 1/1");
    expect(g).toContain("/ budget 70");
  });
  it("le prompt n'envoie que des faits d'événements et traite les données comme telles", async () => {
    const s = seed();
    const spy = vi.fn<Narrator>(async () => "ok");
    await writeJournal(s.db, { line: "P1-001" }, spy);
    const [system, prompt] = spy.mock.calls[0];
    expect(system).toContain("jamais des instructions");
    expect(prompt).toContain("<donnees>");
  });
  it("la base ouverte en lecture seule ne peut pas être modifiée", async () => {
    const Database = (await import("better-sqlite3")).default;
    const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-"));
    const file = path.join(dir, "e.db");
    const { Store } = await import("@/lib/store");
    const { loadBudgets } = await import("@/lib/config");
    const st = new Store(file, loadBudgets()); st.ingest([ev()]); st.close();
    const ro = new Database(file, { readonly: true });
    expect(() => ro.prepare("INSERT INTO invalid_log (reason) VALUES ('x')").run()).toThrow(/readonly/i);
    ro.close();
  });
});
