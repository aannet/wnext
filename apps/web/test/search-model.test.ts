// Palette de recherche du Planning (RT-038) : filtre sans casse ni accents sur les listes chargées, groupes Personnes / Projets,
// ordre (début de nom d'abord), plafond par groupe, personnes masquées par les filtres, filtres retirés avant de défiler.
import { describe, expect, it } from "vitest";
import { clearCriteria, normalizeFilters } from "../src/schedule/view-filters";
import { fold, searchEntries, type SearchInput } from "../src/schedule/search-model";

const people = [
  { id: "1", name: "Élodie Perrin" }, { id: "2", name: "Pierre Martin" }, { id: "3", name: "Jean-Luc Pernet" },
  { id: "4", name: "Ana Dupont" }, { id: "5", name: "Zoé Hamon" },
];
const projects = [
  { id: "10", name: "Refonte du site", color: "#3B82F6" }, { id: "11", name: "Application mobile", color: null }, { id: "12", name: "Audit Persona" },
];
const base: SearchInput = { people, projects, hiddenIds: new Set(), query: "" };
const ids = (g: ReturnType<typeof searchEntries>, kind: "people" | "projects") => g.find((x) => x.kind === kind)?.items.map((i) => i.id) ?? [];

describe("fold", () => {
  it("minuscules sans accents ni diacritiques", () => {
    expect(fold("Élodie")).toBe("elodie");
    expect(fold("ÇA Été")).toBe("ca ete");
  });
});

describe("searchEntries", () => {
  it("« per » : sans casse ni accents, début de nom d'abord (Perrin, Pernet), puis le reste (Pierre : pas de « per »)", () => {
    const g = searchEntries({ ...base, query: "PER" });
    expect(ids(g, "people")).toEqual(["1", "3"]);
    expect(ids(g, "projects")).toEqual(["12"]); // Audit Persona : « per » en début du mot « persona »
  });

  it("accents tapés ou non : « elodie » et « Élodie » donnent le même résultat", () => {
    expect(ids(searchEntries({ ...base, query: "elodie" }), "people")).toEqual(["1"]);
    expect(ids(searchEntries({ ...base, query: "ÉLODIE" }), "people")).toEqual(["1"]);
  });

  it("plusieurs mots : tous doivent se retrouver, dans n'importe quel ordre", () => {
    expect(ids(searchEntries({ ...base, query: "martin pie" }), "people")).toEqual(["2"]);
    expect(ids(searchEntries({ ...base, query: "site refonte" }), "projects")).toEqual(["10"]);
  });

  it("un début de mot passe avant un milieu de mot ; à égalité, ordre alphabétique", () => {
    const g = searchEntries({ ...base, people: [{ id: "a", name: "Zed Mara" }, { id: "b", name: "Amar Zed" }, { id: "c", name: "Marc Zed" }], query: "mar" });
    expect(ids(g, "people")).toEqual(["c", "a", "b"]);
  });

  it("groupes vides omis ; aucune correspondance : liste vide", () => {
    expect(searchEntries({ ...base, query: "mobile" }).map((x) => x.kind)).toEqual(["projects"]);
    expect(searchEntries({ ...base, query: "xyz" })).toEqual([]);
  });

  it("requête vide : les premiers de chaque groupe (ordre alphabétique), plafonnés", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `Personne ${String(i).padStart(2, "0")}` }));
    const g = searchEntries({ ...base, people: many, query: "  ", limit: 5 });
    expect(ids(g, "people")).toEqual(["0", "1", "2", "3", "4"]);
    expect(ids(g, "projects")).toEqual(["11", "12", "10"]);
  });

  it("personne masquée par les filtres : signalée dans l'option", () => {
    const g = searchEntries({ ...base, hiddenIds: new Set(["3"]), query: "per" });
    expect(g.find((x) => x.kind === "people")!.items.map((i) => (i.kind === "person" ? i.hidden : null))).toEqual([false, true]);
  });

  it("clé d'option distincte entre une personne et un projet de même identifiant", () => {
    const g = searchEntries({ ...base, people: [{ id: "1", name: "Marie" }], projects: [{ id: "1", name: "Marathon", color: null }], query: "mar" });
    const keys = g.flatMap((x) => x.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(2);
  });
});

describe("clearCriteria", () => {
  it("retire département, rôle, projet, personne et étiquettes ; garde tri, zoom et densité", () => {
    const out = clearCriteria({ departmentIds: ["d"], roleIds: ["r"], projectIds: ["p"], personIds: ["x"], tags: ["t"], peopleSort: "role", zoom: "week", density: "airy" });
    expect(out).toEqual({ peopleSort: "role", zoom: "week", density: "airy" });
    expect(normalizeFilters(clearCriteria({ departmentIds: ["d"] }))).toEqual({});
  });
});
