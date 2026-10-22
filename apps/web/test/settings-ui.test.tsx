// @vitest-environment jsdom
// Écran Réglages (lot L-F2 : RT-012 partie Réglages) : sections Équipes (= départements), Rôles, Clients, Types de congé, Jours fériés,
// Compte (formulaire pour owner et admin, RT-041 ; lecture seule sinon) ; création, renommage, suppression refusée si l'élément sert
// encore, droits.
import type { AccountSettings } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSchedule } from "../src/demo";
import { createDemoAccountSource, meAccountOf, scheduleAccountOf, type AccountSource } from "../src/data/account-source";
import { createDemoSource } from "../src/data/demo-source";
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
const settings: AccountSettings = { id: "1", version: 4, name: "WNEXT Démo", timezone: "Europe/Paris", weekStart: 1, defaultLocale: "fr", capacityThresholds: { underPercent: 80 } };

async function mount(s: ReturnType<typeof setup>, props: { canEdit?: boolean; locale?: "fr" | "en"; reference?: ReferenceSource; account?: AccountSource; onAccountSaved?: (a: AccountSettings) => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<SettingsScreen i18n={createI18n(props.locale ?? "fr")} reference={props.reference ?? s.reference} projects={s.projects}
    account={props.account ?? createDemoAccountSource(settings)} canEdit={props.canEdit ?? true} {...(props.onAccountSaved ? { onAccountSaved: props.onAccountSaved } : {})} />));
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
  const panel = () => body().querySelector<HTMLElement>("[role=tabpanel]")!;
  async function choose(el: HTMLSelectElement, value: string) {
    await act(async () => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
  }
  /** Source espionnée : PATCH vu (version, corps), réponse de la démo ou imposée. */
  function spied(reply?: AccountSource["update"]) {
    const demo = createDemoAccountSource(settings);
    const calls: Array<{ version: number; patch: unknown }> = [];
    const src: AccountSource = { get: vi.fn(demo.get), update: async (cur, patch) => { calls.push({ version: cur.version, patch }); return (reply ?? demo.update)(cur, patch); } };
    return { src, calls };
  }

  it("owner ou admin : formulaire prérempli depuis GET /account (fuseau, semaine, langue, seuil), nom en lecture", async () => {
    await mount(setup());
    await tab("Compte");
    expect(panel().textContent).toContain("WNEXT Démo");
    expect(field("Fuseau horaire").value).toBe("Europe/Paris");
    expect(field("Début de semaine").value).toBe("1");
    expect([...field("Début de semaine").options].map((o) => o.textContent)).toEqual(["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]);
    expect(field("Langue par défaut").value).toBe("fr");
    expect([...field("Langue par défaut").options].map((o) => o.textContent)).toEqual(["français", "anglais"]);
    expect(field("Seuil de sous-allocation (%)").value).toBe("80");
    expect(button("Enregistrer", panel())!.disabled).toBe(true); // rien à enregistrer
    expect(panel().textContent).not.toContain("lecture seule");
  });

  it("enregistre semaine, langue et seuil : PATCH If-Match = version lue, seuls les champs changés, le parent est prévenu", async () => {
    const { src, calls } = spied();
    const saved = vi.fn();
    await mount(setup(), { account: src, onAccountSaved: saved });
    await tab("Compte");
    await choose(field("Début de semaine"), "7");
    await choose(field("Langue par défaut"), "en");
    await type(field("Seuil de sous-allocation (%)"), "65");
    await click(button("Enregistrer", panel()));
    expect(calls).toEqual([{ version: 4, patch: { weekStart: 7, defaultLocale: "en", capacityThresholds: { underPercent: 65 } } }]);
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ version: 5, weekStart: 7, defaultLocale: "en", capacityThresholds: { underPercent: 65 } }));
    expect(panel().textContent).toContain("Réglages du compte enregistrés.");
    expect(button("Enregistrer", panel())!.disabled).toBe(true);
    // Écriture suivante : la nouvelle version.
    await choose(field("Début de semaine"), "1");
    await click(button("Enregistrer", panel()));
    expect(calls[1]).toEqual({ version: 5, patch: { weekStart: 1 } });
  });

  it("fuseau : liste des fuseaux IANA avec recherche ; le choix part dans le PATCH", async () => {
    const { src, calls } = spied();
    await mount(setup(), { account: src });
    await tab("Compte");
    const input = field("Fuseau horaire");
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "new_york");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    await flush();
    const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent === "America/New_York");
    await click(option);
    expect(field("Fuseau horaire").value).toBe("America/New_York");
    await click(button("Enregistrer", panel()));
    expect(calls).toEqual([{ version: 4, patch: { timezone: "America/New_York" } }]);
  });

  it.each(["0", "101", "abc", ""])("seuil « %s » refusé avant tout envoi", async (v) => {
    const { src, calls } = spied();
    await mount(setup(), { account: src });
    await tab("Compte");
    await type(field("Seuil de sous-allocation (%)"), v);
    await click(button("Enregistrer", panel()));
    expect(calls).toEqual([]);
    expect(panel().textContent).toContain("Saisissez un nombre entre 1 et 100.");
    expect(field("Seuil de sous-allocation (%)").getAttribute("aria-invalid")).toBe("true");
  });

  it("409 VERSION_CONFLICT : message, valeurs actuelles relues, la version relue sert au prochain envoi", async () => {
    let current: AccountSettings = { ...settings, version: 9, weekStart: 3, capacityThresholds: { underPercent: 70 } };
    const calls: number[] = [];
    let first = true;
    const src: AccountSource = {
      get: async () => ({ ok: true, value: first ? settings : current }),
      update: async (cur, patch) => {
        calls.push(cur.version);
        if (first) { first = false; return { ok: false, error: { code: "VERSION_CONFLICT", params: { currentVersion: 9 } } }; }
        current = { ...current, ...patch, version: current.version + 1 } as AccountSettings;
        return { ok: true, value: current };
      },
    };
    await mount(setup(), { account: src });
    await tab("Compte");
    await choose(field("Début de semaine"), "7");
    await click(button("Enregistrer", panel()));
    expect(panel().querySelector("[role=alert]")!.textContent).toContain("modifié entre-temps");
    expect(field("Début de semaine").value).toBe("3");
    expect(field("Seuil de sous-allocation (%)").value).toBe("70");
    await choose(field("Début de semaine"), "7");
    await click(button("Enregistrer", panel()));
    expect(calls).toEqual([4, 9]);
  });

  it("409 : la relecture est propagée comme une écriture réussie, /me et le Planning restent cohérents avec le formulaire", async () => {
    // Le compte a été changé ailleurs (version 9, dimanche, 60 %, Tokyo) ; câblage de main.tsx : /me et la source du Planning.
    const server: AccountSettings = { ...settings, version: 9, weekStart: 7, timezone: "Asia/Tokyo", capacityThresholds: { underPercent: 60 } };
    const src: AccountSource = {
      get: (() => { let n = 0; return async () => ({ ok: true as const, value: n++ === 0 ? settings : server }); })(),
      update: async () => ({ ok: false, error: { code: "VERSION_CONFLICT", params: { currentVersion: 9 } } }),
    };
    const planning = createDemoSource(demoSchedule(TODAY, 4));
    let me = meAccountOf(settings);
    const saved = vi.fn((s: AccountSettings) => { me = meAccountOf(s); planning.accountChanged!(scheduleAccountOf(s)); });
    await mount(setup(), { account: src, onAccountSaved: saved });
    await tab("Compte");
    await choose(field("Début de semaine"), "3");
    await click(button("Enregistrer", panel()));
    expect(saved).toHaveBeenCalledWith(server);
    expect(field("Début de semaine").value).toBe("7");
    expect(me).toEqual({ id: "1", name: "WNEXT Démo", timezone: "Asia/Tokyo", weekStart: 7, defaultLocale: "fr" });
    expect(planning.getState().data!.account).toEqual({ weekStart: 7, capacityThresholds: { underPercent: 60 }, timezone: "Asia/Tokyo" });
  });

  it("400 sur le fuseau : l'erreur est reliée au champ (aria-invalid, aria-describedby) jusqu'au prochain choix", async () => {
    const { src } = spied(async () => ({ ok: false, error: { code: "VALIDATION_FAILED", params: { field: "timezone" } } }));
    await mount(setup(), { account: src });
    await tab("Compte");
    const zone = field("Fuseau horaire");
    expect(zone.getAttribute("aria-invalid")).toBeNull();
    await choose(field("Début de semaine"), "2");
    await click(button("Enregistrer", panel()));
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    const described = (zone.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain("Fuseau horaire inconnu du serveur.");
    await act(async () => {
      zone.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(zone, "new_york");
      zone.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    await flush();
    await click([...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent === "America/New_York"));
    expect(field("Fuseau horaire").getAttribute("aria-invalid")).toBeNull();
  });

  it("400 sur le fuseau : message dédié ; 403 traduit", async () => {
    const { src } = spied(async () => ({ ok: false, error: { code: "VALIDATION_FAILED", params: { field: "timezone" } } }));
    await mount(setup(), { account: src });
    await tab("Compte");
    await choose(field("Début de semaine"), "2");
    await click(button("Enregistrer", panel()));
    expect(panel().querySelector("[role=alert]")!.textContent).toBe("Fuseau horaire inconnu du serveur.");
    act(() => root?.unmount()); host.remove();
    const denied = spied(async () => ({ ok: false, error: { code: "FORBIDDEN", params: {} } }));
    await mount(setup(), { account: denied.src });
    await tab("Compte");
    await choose(field("Début de semaine"), "2");
    await click(button("Enregistrer", panel()));
    expect(panel().querySelector("[role=alert]")!.textContent).toBe("Vous n’avez pas le droit de faire cette modification.");
  });

  it("lecture seule (canEdit faux) : valeurs affichées, aucun champ ni bouton", async () => {
    await mount(setup(), { canEdit: false });
    await tab("Compte");
    const text = body().querySelector(".wn-facts")!.textContent!;
    expect(text).toContain("Europe/Paris");
    expect(text).toContain("lundi");
    expect(text).toContain("français");
    expect(text).toMatch(/80\s%/);
    expect(panel().querySelector("input, select")).toBeNull();
    expect(button("Enregistrer", panel())).toBeUndefined();
    expect(panel().textContent).toContain("propriétaire et les administrateurs");
  });

  it("anglais : libellés et noms des jours traduits", async () => {
    await mount(setup(), { locale: "en" });
    await tab("Account");
    expect(field("Week start").value).toBe("1");
    expect(field("Week start").options[0]!.textContent).toBe("Monday");
    expect(field("Under-allocation threshold (%)").value).toBe("80");
    expect(button("Save", panel())).toBeDefined();
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
