// @vitest-environment jsdom
// Écran Réglages (lot L-F2 : RT-012 partie Réglages) : sections Équipes (= départements), Rôles, Clients, Types de congé, Jours fériés,
// Compte (lecture seule : pas de route d'écriture) ; création, renommage, suppression refusée si l'élément sert encore, droits.
import type { Me } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSchedule } from "../src/demo";
import { createDemoDirectory, type ReferenceSource } from "../src/data/people-source";
import { createDemoProjectsSource } from "../src/data/projects-source";
import { createI18n } from "../src/i18n";
import { SettingsScreen } from "../src/settings/settings-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODAY = "2026-10-20";
let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function setup() {
  const schedule = demoSchedule(TODAY, 12);
  const hooks = { onEntity: vi.fn(), onRemoved: vi.fn(), onDeactivated: vi.fn(), today: TODAY };
  const dir = createDemoDirectory(schedule, hooks);
  return { ...dir, hooks, projects: createDemoProjectsSource(schedule, { onProject: () => {} }) };
}
const account: Me["account"] = { id: "1", name: "WNEXT Démo", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr" };

async function mount(s: ReturnType<typeof setup>, props: { canEdit?: boolean; locale?: "fr" | "en"; reference?: ReferenceSource } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<SettingsScreen i18n={createI18n(props.locale ?? "fr")} reference={props.reference ?? s.reference} projects={s.projects} account={account} canEdit={props.canEdit ?? true} />));
  await flush();
}
const body = () => document.body;
const button = (text: string | RegExp, scope: ParentNode = body()) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((e) => (typeof text === "string" ? e.textContent === text : text.test(e.textContent ?? "")));
const field = (label: string, scope: ParentNode = body()) => {
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
const tab = (name: string) => click([...body().querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent === name));
const rows = () => [...body().querySelectorAll(".wn-rows .wn-row-name")].map((e) => e.textContent);

describe("sections", () => {
  it("six onglets, Équipes d'abord (équipes = départements)", async () => {
    await mount(setup());
    expect([...body().querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual(["Équipes", "Rôles", "Clients", "Types de congé", "Jours fériés", "Compte"]);
    expect(body().querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Équipes");
    expect(rows()).toEqual(["Design", "Ingénierie", "Produit"]);
  });

  it("flèches gauche et droite parcourent les onglets (focus suivi)", async () => {
    await mount(setup());
    const first = body().querySelector<HTMLElement>("[role=tab]")!;
    await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(body().querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Rôles");
    expect(document.activeElement!.textContent).toBe("Rôles");
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(body().querySelector("[role=tab][aria-selected=true]")!.textContent).toBe("Équipes");
  });
});

describe("équipes", () => {
  it("crée, refuse un doublon, renomme et supprime après confirmation ; la création est répercutée", async () => {
    const s = setup();
    await mount(s);
    await type(field("Nouvelle équipe"), "Données");
    await click(button("Ajouter"));
    expect(rows()).toContain("Données");
    expect(body().textContent).toContain("« Données » ajouté.");
    expect(s.hooks.onEntity).toHaveBeenCalledWith("departments", expect.objectContaining({ name: "Données" }));

    await type(field("Nouvelle équipe"), "données");
    await click(button("Ajouter"));
    expect(body().querySelector("[role=alert]")!.textContent).toBe("Un élément porte déjà ce nom.");

    await click(button("Renommer Données"));
    await type(field("Nouveau nom de Données"), "Data");
    await click(button("Enregistrer"));
    expect(rows()).toContain("Data");
    expect(rows()).not.toContain("Données");

    await click(button("Supprimer Data"));
    expect(body().querySelector("[role=dialog] h2")!.textContent).toBe("Supprimer « Data » ?");
    await click(button("Supprimer", body().querySelector("[role=dialog]")!));
    expect(rows()).not.toContain("Data");
    expect(s.hooks.onRemoved).toHaveBeenCalledWith("departments", expect.any(String));
  });

  it("supprimer une équipe encore utilisée est refusé, avec un message clair", async () => {
    await mount(setup());
    await click(button("Supprimer Produit"));
    await click(button("Supprimer", body().querySelector("[role=dialog]")!));
    expect(body().querySelector("[role=alert]")!.textContent).toBe("Suppression impossible : cet élément est encore utilisé.");
    expect(rows()).toContain("Produit");
  });
});

describe("types de congé et jours fériés", () => {
  it("types de congé : création, bascule « déduit de la capacité »", async () => {
    await mount(setup());
    await tab("Types de congé");
    expect(rows()).toHaveLength(3);
    await type(field("Nouveau type de congé"), "Maladie");
    await click(button("Ajouter"));
    expect(rows().some((r) => r!.includes("Maladie"))).toBe(true);
    await click(button("Ne plus déduire Maladie de la capacité"));
    expect(rows().find((r) => r!.includes("Maladie"))).toContain("non déduit");
  });

  it("jours fériés : validation, ajout par pays, filtre par pays, suppression", async () => {
    await mount(setup());
    await tab("Jours fériés");
    expect(body().textContent).toContain("Aucun jour férié.");
    await click(button("Ajouter"));
    expect(body().textContent).toContain("Le nom est obligatoire.");
    expect(body().textContent).toContain("Choisissez une date.");
    await type(field("Nom"), "Noël");
    await type(field("Date"), "2026-12-25");
    await type(field("Pays (code à 2 lettres)"), "fr");
    await click(button("Ajouter"));
    await type(field("Nom"), "Thanksgiving");
    await type(field("Date"), "2026-11-26");
    await type(field("Pays (code à 2 lettres)"), "US");
    await click(button("Ajouter"));
    expect(rows()).toHaveLength(2);
    const filter = field("Pays");
    await act(async () => { filter.value = "FR"; filter.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("Noël");
    await click(button("Supprimer Noël"));
    expect(rows()).toHaveLength(0);
  });
});

describe("compte", () => {
  it("fuseau, début de semaine et langue en lecture seule : aucune route d'écriture du compte", async () => {
    await mount(setup());
    await tab("Compte");
    const text = body().querySelector(".wn-facts")!.textContent!;
    expect(text).toContain("Europe/Paris");
    expect(text).toContain("lundi");
    expect(text).toContain("français");
    expect(body().querySelector("[role=tabpanel] input")).toBeNull();
    expect(body().textContent).toContain("lecture seule");
  });
});

describe("clients et droits", () => {
  it("clients : même gestion que l'écran Projets (création à la volée)", async () => {
    const s = setup();
    await mount(s);
    await tab("Clients");
    await type(field("Nouveau client"), "Initech");
    await click(button("Ajouter"));
    expect(body().querySelector("[role=tabpanel]")!.textContent).toContain("Initech");
  });

  it("lecture seule : listes visibles, aucune action d'écriture", async () => {
    await mount(setup(), { canEdit: false });
    expect(rows()).toHaveLength(3);
    expect(button("Ajouter")).toBeUndefined();
    expect(button("Renommer Produit")).toBeUndefined();
    expect(button("Supprimer Produit")).toBeUndefined();
  });

  it("un 403 de l'API est traduit", async () => {
    const s = setup();
    const reference: ReferenceSource = { ...s.reference, departments: { ...s.reference.departments, create: async () => ({ ok: false, error: { code: "FORBIDDEN", params: {} } }) } };
    await mount(s, { reference });
    await type(field("Nouvelle équipe"), "X");
    await click(button("Ajouter"));
    expect(body().querySelector("[role=alert]")!.textContent).toBe("Vous n’avez pas le droit de faire cette modification.");
  });

  it("anglais : Teams, Time-off types, Holidays", async () => {
    await mount(setup(), { locale: "en" });
    expect([...body().querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual(["Teams", "Roles", "Clients", "Time-off types", "Holidays", "Account"]);
  });
});
