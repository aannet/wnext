import { describe, expect, it } from "vitest";
import { validateEvent, SCHEMA_VERSION } from "@/lib/validate";
import { ev } from "./helpers";
import schema from "../schema/event.json";

describe("schéma d'événement", () => {
  it("est versionné", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
    expect(schema.required).toHaveLength(12);
  });
  it("accepte l'exemple de strategy.md §5.2 (avec un ULID valide)", () => {
    expect(validateEvent(ev()).ok).toBe(true);
  });
  it("accepte schema_version 1.0 et les champs optionnels", () => {
    const r = validateEvent(ev({ schema_version: "1.0", parent_id: "art-1", tokens_cache_read: 10, tokens_cache_write: 2, budget_remaining: 5, detail: { verdict: "approve", n: 3, ok: true } }));
    expect(r.ok).toBe(true);
  });
  it.each([
    ["champ obligatoire manquant", (e: any) => delete e.status],
    ["phase hors enum", (e: any) => (e.phase = "P9")],
    ["agent inconnu", (e: any) => (e.agent = "pirate")],
    ["ts sans millisecondes", (e: any) => (e.ts = "2026-10-18T09:14:03Z")],
    ["run_id non ULID", (e: any) => (e.run_id = "01JAB...")],
    ["ligne mal formée", (e: any) => (e.line = "ligne-1")],
    ["tokens négatifs", (e: any) => (e.tokens_in = -1)],
    ["tokens non entiers", (e: any) => (e.tokens_out = 1.5)],
    ["action sans verbe.objet", (e: any) => (e.action = "llm")],
    ["status inconnu", (e: any) => (e.status = "meh")],
    ["schema_version inconnue", (e: any) => (e.schema_version = "2.0")],
    ["champ additionnel (contenu potentiel)", (e: any) => (e.prompt = "secret")],
    ["detail avec clé de contenu interdite", (e: any) => (e.detail = { prompt: "x" })],
    ["detail avec valeur objet", (e: any) => (e.detail = { a: { b: 1 } })],
    ["detail avec valeur trop longue", (e: any) => (e.detail = { a: "x".repeat(201) })],
  ])("rejette : %s", (_n, mutate) => {
    const e: any = ev();
    mutate(e);
    expect(validateEvent(e).ok).toBe(false);
  });
  it("ne divulgue pas la valeur fautive dans le motif de rejet", () => {
    const r = validateEvent(ev({ status: "SECRET-VALUE" as never }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toContain("SECRET-VALUE");
  });
  it("rejette un non-objet", () => {
    expect(validateEvent("x").ok).toBe(false);
    expect(validateEvent(null).ok).toBe(false);
  });
});
