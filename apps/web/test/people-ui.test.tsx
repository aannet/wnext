// @vitest-environment jsdom
// Écran Personnes (lot L-F2 : RT-012, US-1.1, BR-19, BR-31) : liste filtrable, création en trois champs, fiche dans le Drawer commun
// (horaire sur 7 jours selon week_start, modification datée, refus PERSON_HISTORY_LOCKED traduit, conflit de version), désactivation avec
// récapitulatif, lecture seule pour member et guest, import CSV réservé aux owner et admin.
import type { Me } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSchedule } from "../src/demo";
import { createDemoImportSource, demoImportSnapshot, type ImportSource } from "../src/data/import-source";
import { createDemoDirectory, type PeopleSource, type ReferenceSource } from "../src/data/people-source";
import { createI18n } from "../src/i18n";
import { PeopleScreen } from "../src/people/people-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function directory() {
  const hooks = { onEntity: vi.fn(), onRemoved: vi.fn(), onDeactivated: vi.fn(), today: TODAY };
  return { ...createDemoDirectory(demoSchedule(TODAY, 12), hooks), hooks };
}
const account = (weekStart = 1): Me["account"] => ({ id: "1", name: "Démo", timezone: "Europe/Paris", weekStart, defaultLocale: "fr" });
const now = () => new Date(`${TODAY}T10:00:00Z`);

async function mount(source: PeopleSource, reference: ReferenceSource, props: { canEdit?: boolean; weekStart?: number; locale?: "fr" | "en"; imports?: ImportSource } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(
    <PeopleScreen i18n={createI18n(props.locale ?? "fr")} source={source} reference={reference} account={account(props.weekStart)} canEdit={props.canEdit ?? true} now={now}
      {...(props.imports ? { imports: props.imports } : {})} />,
  ));
  await flush();
}

const dialogs = () => [...document.body.querySelectorAll<HTMLElement>("[role=dialog]")];
const top = (): Element => dialogs().at(-1) ?? document.body;
const button = (text: string | RegExp, scope: ParentNode = top()) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((e) => (typeof text === "string" ? e.textContent === text : text.test(e.textContent ?? "")));
const field = (label: string, scope: ParentNode = top()) => {
  const l = [...scope.querySelectorAll("label")].find((x) => x.textContent === label);
  return (l ? scope.querySelector(`#${CSS.escape(l.htmlFor)}`) : scope.querySelector(`[aria-label="${label}"]`)) as HTMLInputElement & HTMLSelectElement;
};
async function click(el: Element | undefined | null) { if (!el) throw new Error("élément absent"); await act(async () => { (el as HTMLElement).click(); }); await flush(); }
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(el: HTMLSelectElement, value: string) { await act(async () => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); }); }
// Nom seul : le texte direct du bouton, sans les initiales de l'avatar ni l'étiquette « Désactivée ».
const rowNames = () => [...document.body.querySelectorAll("tbody th button")].map((b) => [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""));
const page = () => document.body.querySelector("main")!;
const open = async (name: string) => click([...document.body.querySelectorAll<HTMLElement>("tbody th button")].find((b) => b.textContent!.includes(name)));

describe("liste", () => {
  it("affiche les personnes actives avec rôle, équipe, type et horaire résumé, et filtre", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    expect(rowNames()).toHaveLength(12);
    const first = document.body.querySelector("tbody tr")!;
    expect(first.textContent).toContain("Personne 1");
    expect(first.textContent).toContain("Produit"); // équipe = département
    expect(first.textContent).toContain("Senior");
    expect(first.textContent).toContain("Employé");
    expect(first.textContent).toContain("40 h par semaine, 5 jours");
    await type(field("Rechercher (nom)", page()), "personne 12");
    expect(rowNames()).toEqual(["Personne 12"]);
    await type(field("Rechercher (nom)", page()), "");
    await choose(field("Équipe", page()), "2");
    expect(rowNames().every((n) => ["Personne 2", "Personne 5", "Personne 8", "Personne 11"].includes(n))).toBe(true);
    await choose(field("Équipe", page()), "");
    await choose(field("Type", page()), "contractor");
    expect(rowNames()).toEqual([]);
    expect(page().textContent).toContain("Aucun résultat");
    await click(button("Effacer les filtres", page()));
    expect(rowNames()).toHaveLength(12);
  });

  it("les personnes désactivées se demandent par le filtre d'état", async () => {
    const d = directory();
    const p = (await d.people.listPeople());
    if (!p.ok) throw new Error();
    await d.people.deactivate(p.value[11]!, { asOf: TODAY, disposition: "delete", confirmation: { allocationCount: 99 } }); // refusé : récapitulatif à jour
    const summary = await d.people.deactivationSummary(p.value[11]!.id);
    if (!summary.ok) throw new Error();
    await d.people.deactivate(p.value[11]!, { asOf: TODAY, ...(summary.value.allocationCount ? { disposition: "delete" as const, confirmation: { allocationCount: summary.value.allocationCount } } : {}) });
    await mount(d.people, d.reference);
    expect(rowNames()).toHaveLength(11);
    await choose(field("État", page()), "inactive");
    expect(rowNames()).toEqual(["Personne 12"]);
    expect(page().textContent).toContain("Désactivée");
  });

  it("état vide : action « Nouvelle personne »", async () => {
    const d = directory();
    await mount({ ...d.people, listPeople: async () => ({ ok: true, value: [] }) }, d.reference);
    expect(page().textContent).toContain("Aucune personne");
    expect(button("Nouvelle personne", page())).toBeTruthy();
  });
});

describe("tri et regroupement de la liste (RT-031)", () => {
  const header = (name: string) => [...document.body.querySelectorAll<HTMLElement>("thead th")].find((th) => th.textContent?.startsWith(name))!;
  const sortButton = (name: string) => header(name).querySelector<HTMLButtonElement>("button")!;

  it("en-têtes Nom, Rôle et Équipe triables : aria-sort sur la colonne triée, second clic inverse le sens", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    expect(header("Nom").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Équipe").getAttribute("aria-sort")).toBeNull();
    const first = rowNames();
    await click(sortButton("Nom"));
    expect(header("Nom").getAttribute("aria-sort")).toBe("descending");
    expect(rowNames()).toEqual([...first].reverse());
    await click(sortButton("Équipe"));
    expect([header("Équipe").getAttribute("aria-sort"), header("Nom").getAttribute("aria-sort")]).toEqual(["ascending", null]);
    const teams = [...document.body.querySelectorAll("tbody tr")].map((tr) => tr.children[2]!.textContent);
    expect(teams).toEqual([...teams].sort((a, b) => a!.localeCompare(b!)));
  });

  it("« Regrouper par équipe » : un groupe par équipe (en-tête de groupe avec le nombre), le tri s'applique dans chaque groupe", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    const toggle = [...document.body.querySelectorAll<HTMLButtonElement>("[role=switch]")].find((b) => b.textContent === "Regrouper par équipe")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const groups = [...document.body.querySelectorAll("tbody")];
    expect(groups.map((g) => g.querySelector("th[scope=rowgroup]")!.textContent)).toEqual(["Design (4)", "Ingénierie (4)", "Produit (4)"]);
    expect(rowNames().length).toBe(12);
    await click(sortButton("Nom"));
    const firstGroup = [...groups[0]!.querySelectorAll("th[scope=row] button")].map((b) => b.textContent);
    expect(firstGroup).toEqual([...firstGroup].sort().reverse());
  });
});

describe("création en trois champs (US-1.1)", () => {
  it("nom, type et horaire par défaut suffisent ; équipe, rôle et pays sont repliés ; la personne arrive dans la liste et sa fiche s'ouvre", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    await click(button("Nouvelle personne", page()));
    expect(top().querySelector("h2")!.textContent).toBe("Nouvelle personne");
    expect(top().querySelector("details")!.hasAttribute("open")).toBe(false);
    expect(field("Type").value).toBe("employee");
    expect([...top().querySelectorAll<HTMLInputElement>(".wn-week-grid input")].map((i) => i.value)).toEqual(["8", "8", "8", "8", "8", "0", "0"]);
    await click(button("Créer la personne"));
    expect(top().textContent).toContain("Le nom est obligatoire.");
    expect(field("Nom").getAttribute("aria-invalid")).toBe("true");
    await type(field("Nom"), "Ada Lovelace");
    await choose(field("Type"), "contractor");
    await click(button("Créer la personne"));
    expect(rowNames()).toContain("Ada Lovelace");
    expect(d.hooks.onEntity).toHaveBeenCalledWith("people", expect.objectContaining({ name: "Ada Lovelace", peopleType: "contractor" }));
    expect(top().querySelector("h2")!.textContent).toBe("Ada Lovelace"); // la fiche s'ouvre
  });
});

describe("fiche", () => {
  it("affiche l'horaire sur 7 jours dans l'ordre du début de semaine du compte (dimanche d'abord)", async () => {
    const d = directory();
    await mount(d.people, d.reference, { weekStart: 7 });
    await open("Personne 1");
    const labels = [...top().querySelectorAll(".wn-week-grid label")].map((l) => l.textContent);
    expect(labels).toEqual(["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."]);
    expect([...top().querySelectorAll(".wn-week-grid input")].map((i) => i.getAttribute("aria-label"))).toEqual(["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"]); // nom accessible long (RT-036)
    const values = [...top().querySelectorAll<HTMLInputElement>(".wn-week-grid input")].map((i) => i.value);
    expect(values).toEqual(["0", "8", "8", "8", "8", "8", "0"]); // stockage ISO inchangé : lundi = 8, dimanche = 0
  });

  it("modification datée : « À partir du » n'apparaît que pour l'horaire, l'équipe ou le rôle ; l'historique se met à jour", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    await open("Personne 1");
    expect(top().textContent).toContain("Historique de l’horaire");
    expect(top().querySelectorAll(".wn-history li")).toHaveLength(1);
    expect(field("À partir du")).toBeFalsy();
    await type(field("Nom"), "Personne Un");
    expect(field("À partir du")).toBeFalsy();
    await type(field("Nom"), "Personne 1");
    const friday = top().querySelector<HTMLInputElement>(`.wn-week-grid input[aria-label="vendredi"]`)!;
    await type(friday, "0");
    expect(field("À partir du").value).toBe(TODAY);
    expect(top().textContent).toContain("Total : 32 h par semaine sur 4 jours");
    await type(field("À partir du"), "2026-11-02");
    await click(button("Enregistrer"));
    expect(top().textContent).toContain("Modifications enregistrées.");
    const items = [...top().querySelectorAll(".wn-history li")].map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("40 h par semaine");
    expect(items[1]).toContain("32 h par semaine");
    expect(items[1]).toMatch(/Depuis le 2 nov\. 2026/);
    expect(d.hooks.onEntity).toHaveBeenCalledWith("people", expect.objectContaining({ id: "1", workDaysHours: [8, 8, 8, 8, 0, 0, 0] }));
  });

  it("PERSON_HISTORY_LOCKED est traduit avec le dernier jour verrouillé, et la saisie est conservée", async () => {
    const d = directory();
    const source: PeopleSource = {
      ...d.people,
      updatePerson: async () => ({ ok: false, error: { code: "PERSON_HISTORY_LOCKED", params: { lockedThrough: "2026-09-30" } } }),
    };
    await mount(source, d.reference);
    await open("Personne 1");
    const monday = [...top().querySelectorAll<HTMLInputElement>(".wn-week-grid input")][0]!;
    await type(monday, "4");
    await click(button("Enregistrer"));
    const alert = top().querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("verrouillés jusqu’au 30 sept. 2026");
    expect([...top().querySelectorAll<HTMLInputElement>(".wn-week-grid input")][0]!.value).toBe("4");
  });

  it("409 VERSION_CONFLICT : message et rechargement de la personne", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    await open("Personne 1");
    const list = await d.people.listPeople();
    if (!list.ok) throw new Error();
    await d.people.updatePerson(list.value[0]!, { country: "BE" }); // quelqu'un d'autre est passé
    await type(field("Nom"), "Renommée");
    await click(button("Enregistrer"));
    expect(top().textContent).toContain("modifiée par quelqu’un d’autre");
    await click(button("Recharger"));
    expect(top().querySelector("[role=alert]")).toBeNull();
    expect(field("Nom").value).toBe("Personne 1");
    expect(field("Pays (jours fériés)").value).toBe("BE");
  });

  it("refuse un horaire hors 0-24 avant tout appel", async () => {
    const d = directory();
    const update = vi.spyOn(d.people, "updatePerson");
    await mount(d.people, d.reference);
    await open("Personne 1");
    await type([...top().querySelectorAll<HTMLInputElement>(".wn-week-grid input")][0]!, "30");
    await click(button("Enregistrer"));
    expect(top().textContent).toContain("un nombre d’heures entre 0 et 24");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("désactivation (BR-31)", () => {
  it("récapitulatif des allocations à venir, choix obligatoire, puis réaffectation ; la personne reste dans la liste « Désactivées »", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    await open("Personne 1");
    await click(button("Désactiver cette personne"));
    const dialog = top();
    expect(dialog.querySelector("h2")!.textContent).toBe("Désactiver Personne 1");
    expect(dialog.textContent).toMatch(/\d+ allocations? à venir sur \d+ projets?/);
    const confirm = button("Désactiver", dialog)!;
    expect(confirm.disabled).toBe(true); // rien n'est écrit tant qu'un choix n'est pas fait
    await click(dialog.querySelector<HTMLInputElement>("input[type=radio]")!);
    expect(confirm.disabled).toBe(true); // réaffecter : il faut une personne
    await choose(field("Réaffecter à", dialog), "2");
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(d.hooks.onDeactivated).toHaveBeenCalledWith("1", TODAY, "reassign", "2");
    expect(rowNames()).not.toContain("Personne 1");
    expect(top().textContent).toContain("Personne désactivée.");
  });
});

describe("droits", () => {
  it("member et guest : fiche en lecture seule, ni création, ni désactivation", async () => {
    const d = directory();
    await mount(d.people, d.reference, { canEdit: false });
    expect(button("Nouvelle personne", page())).toBeUndefined();
    await open("Personne 1");
    expect(top().textContent).toContain("lecture seule");
    expect(field("Nom").disabled).toBe(true);
    expect(button("Enregistrer")).toBeUndefined();
    expect(button("Désactiver cette personne")).toBeUndefined();
  });

  it("un 403 de l'API (project_manager sur une désactivation avec allocations) est traduit", async () => {
    const d = directory();
    const source: PeopleSource = { ...d.people, deactivate: async () => ({ ok: false, error: { code: "FORBIDDEN", params: {} } }) };
    await mount(source, d.reference);
    await open("Personne 1");
    await click(button("Désactiver cette personne"));
    await click([...top().querySelectorAll<HTMLInputElement>("input[type=radio]")][1]);
    await click(button("Désactiver", top()));
    expect(top().textContent).toContain("Vous n’avez pas le droit de faire cette modification.");
  });

  it("l'import CSV n'est offert qu'avec une source d'import (owner, admin)", async () => {
    const d = directory();
    await mount(d.people, d.reference);
    expect(button("Importer", page())).toBeUndefined();
    act(() => root!.unmount());
    host.remove();
    await mount(d.people, d.reference, { imports: createDemoImportSource(demoImportSnapshot(demoSchedule(TODAY), TODAY)) });
    await click(button("Importer", page()));
    expect(top().querySelector("h2")!.textContent).toBe("Importer un fichier CSV");
  });
});

describe("i18n", () => {
  it("anglais : libellés traduits, jours en anglais", async () => {
    const d = directory();
    await mount(d.people, d.reference, { locale: "en" });
    expect(page().querySelector("h1")!.textContent).toBe("People");
    expect(button("New person", page())).toBeTruthy();
    await open("Personne 1");
    expect([...top().querySelectorAll(".wn-week-grid label")].map((l) => l.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(top().textContent).toContain("Schedule history");
  });
});
