// Profil connecté côté web : chargement (401 distinct des autres erreurs), droits d'affichage par rôle, prénom et initiales.
import type { Me } from "@wnext/contracts";
import { describe, expect, it } from "vitest";
import { canAdminister, canEditSchedule, demoMe, firstName, initials, loadMe } from "../src/shell/me";

const me = (role: Me["role"]): Me => ({ ...demoMe(), role });

describe("loadMe", () => {
  it("200 : prêt avec le profil ; 401 : non authentifié ; autre statut ou réseau : erreur", async () => {
    const ok = demoMe();
    expect(await loadMe({ getMe: async () => ({ ok: true, status: 200, data: ok }) })).toEqual({ status: "ready", me: ok });
    const err = (status: number) => ({ getMe: async () => ({ ok: false as const, status, error: { code: "INTERNAL_ERROR" as const, params: {}, requestId: "r" } }) });
    expect(await loadMe(err(401))).toEqual({ status: "unauthenticated" });
    expect(await loadMe(err(500))).toEqual({ status: "error" });
    expect(await loadMe({ getMe: async () => { throw new Error("réseau"); } })).toEqual({ status: "error" });
  });
});

describe("droits d'affichage", () => {
  it("import et réglages : owner et admin ; écritures du planning : plus project_manager ; member et guest lisent", () => {
    const table = (["owner", "admin", "project_manager", "member", "guest"] as const).map((r) => [r, canAdminister(me(r)), canEditSchedule(me(r))]);
    expect(table).toEqual([
      ["owner", true, true], ["admin", true, true], ["project_manager", false, true], ["member", false, false], ["guest", false, false],
    ]);
  });
});

describe("identité affichée", () => {
  it("prénom = premier mot ; initiales = deux premiers mots, en majuscules", () => {
    expect(firstName("Alec Annet")).toBe("Alec");
    expect(firstName("  Alec ")).toBe("Alec");
    expect(initials("Alec Annet")).toBe("AA");
    expect(initials("alec")).toBe("AL");
    expect(initials("sans.nom")).toBe("SN");
    expect(initials("Éloïse de la Tour")).toBe("ÉD");
  });
});
