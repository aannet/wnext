// @vitest-environment jsdom
// Écran Projets : liste filtrable, état vide, création réduite (client à la volée, couleur de la palette, code dupliqué refusé,
// dates incohérentes), panneau d'édition (couleur, conflit de version, 403 de périmètre traduit), tâches, équipe (ajout, retrait
// BR-10 avec confirmation), lecture seule pour member et guest.
import type { ProjectDetail } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoSchedule } from "../src/demo";
import { createDemoProjectsSource, type ProjectsSource } from "../src/data/projects-source";
import type { TeamRemovalEditor } from "../src/data/team-removal";
import { PROJECT_PALETTE } from "../src/design/project-palette";
import { createI18n } from "../src/i18n";
import { ProjectsScreen } from "../src/projects/projects-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; });

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function demo(hooks: { onProject?(p: ProjectDetail): void } = {}) {
  return createDemoProjectsSource(demoSchedule("2026-10-20", 12), { onProject: hooks.onProject ?? (() => {}) });
}
async function mount(source: ProjectsSource, props: { canEdit?: boolean; editor?: TeamRemovalEditor; locale?: "fr" | "en"; openProjectId?: string; onOpenProjectHandled?(): void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ProjectsScreen i18n={createI18n(props.locale ?? "fr")} source={source} canEdit={props.canEdit ?? true} {...(props.editor ? { editor: props.editor } : {})}
    {...(props.openProjectId ? { openProjectId: props.openProjectId } : {})} {...(props.onOpenProjectHandled ? { onOpenProjectHandled: props.onOpenProjectHandled } : {})} />));
  await flush();
}
const emptySource = (): ProjectsSource => {
  const s = demo();
  return { ...s, listProjects: async () => ({ ok: true, value: [] }) };
};

// Les fiches sont des fenêtres (Drawer, Modal) montées dans document.body : toutes les recherches partent de là.
const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel);
const byText = (sel: string, text: string | RegExp) => [...document.body.querySelectorAll<HTMLElement>(sel)].find((e) => (typeof text === "string" ? e.textContent === text : text.test(e.textContent ?? "")));
// Quand un panneau est ouvert, boutons et champs se cherchent dans le panneau (la liste porte des libellés homonymes : filtre « Client »).
// La fiche est un Drawer (portail dans document.body) ; le dialogue de retrait BR-10, un Modal posé par-dessus : on cherche dans la fenêtre du dessus.
const dialogs = () => [...document.body.querySelectorAll<HTMLElement>("[role=dialog]")];
const scope = (): Element => dialogs().at(-1) ?? host;
const button = (text: string | RegExp) => [...scope().querySelectorAll<HTMLButtonElement>("button")].find((e) => (typeof text === "string" ? e.textContent === text : text.test(e.textContent ?? "")));
const field = (label: string) => {
  const l = [...scope().querySelectorAll("label")].find((x) => x.textContent === label);
  return (l ? scope().querySelector(`#${CSS.escape(l.htmlFor)}`) : scope().querySelector(`[aria-label="${label}"]`)) as HTMLInputElement & HTMLSelectElement;
};
async function click(el: Element | undefined | null) { await act(async () => { (el as HTMLElement).click(); }); await flush(); }
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); });
}
const rowNames = () => [...document.body.querySelectorAll("tbody th button")].map((b) => b.textContent);
const alerts = () => [...document.body.querySelectorAll("[role=alert]")].map((e) => e.textContent);
const panel = () => document.body.querySelector<HTMLElement>("[role=dialog].wn-project-panel");

describe("liste", () => {
  it("affiche les projets du compte avec leur client et leur statut, et filtre", async () => {
    await mount(demo());
    expect(rowNames()).toEqual(["Projet A", "Projet B", "Projet C", "Projet D", "Projet E", "Projet F"]);
    expect(q("tbody tr")!.textContent).toContain("Acme");
    await type(field("Rechercher (nom ou code)"), "projet c");
    expect(rowNames()).toEqual(["Projet C"]);
    await type(field("Rechercher (nom ou code)"), "");
    await choose(field("Client"), "none");
    expect(rowNames()).toEqual(["Projet C", "Projet F"]);
  });

  it("état vide : action « Nouveau projet » ; filtre sans résultat : effacer les filtres", async () => {
    await mount(emptySource());
    expect(document.body.textContent).toContain("Aucun projet pour l’instant");
    expect(button("Nouveau projet")).toBeTruthy();
    act(() => root!.unmount());
    host.remove();
    await mount(demo());
    await type(field("Rechercher (nom ou code)"), "zzz");
    expect(document.body.textContent).toContain("Aucun projet ne correspond");
    await click(button("Effacer les filtres"));
    expect(rowNames()).toHaveLength(6);
  });

  it("chargement puis erreur de chargement avec nouvel essai", async () => {
    let calls = 0;
    const s = demo();
    const flaky: ProjectsSource = { ...s, listProjects: async () => (++calls === 1 ? { ok: false, error: { code: "INTERNAL_ERROR", params: {} } } : s.listProjects()) };
    await mount(flaky);
    expect(alerts()[0]).toContain("Impossible de charger les projets");
    await click(button("Réessayer"));
    expect(rowNames()).toHaveLength(6);
  });
});

describe("fiche ouverte par l'adresse (?projet=, RT-038)", () => {
  it("projet connu : sa fiche s'ouvre dès le chargement, une seule fois, et l'adresse est consommée", async () => {
    const id = (await demo().listProjects() as { ok: true; value: ProjectDetail[] }).value.find((p) => p.name === "Projet C")!.id;
    const handled = vi.fn();
    await mount(demo(), { openProjectId: id, onOpenProjectHandled: handled });
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain("Projet C");
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("projet inconnu : la liste s'affiche sans fiche, l'adresse est quand même consommée", async () => {
    const handled = vi.fn();
    await mount(demo(), { openProjectId: "absent", onOpenProjectHandled: handled });
    expect(rowNames()).toHaveLength(6);
    expect(panel()).toBeNull();
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("projet archivé, masqué par le filtre de statut par défaut : la fiche s'ouvre quand même", async () => {
    const s = demo();
    const list = (await s.listProjects() as { ok: true; value: ProjectDetail[] }).value;
    const done = { ...list[0]!, status: "archived" as const };
    await mount({ ...s, listProjects: async () => ({ ok: true, value: [done, ...list.slice(1)] }) }, { openProjectId: done.id });
    expect(panel()).not.toBeNull();
  });
});

describe("création réduite (US-2.1)", () => {
  it("propose une couleur de la palette, crée le projet avec un client à la volée, l'ajoute à la liste et ouvre son panneau", async () => {
    const onProject = vi.fn();
    await mount(demo({ onProject }));
    await click(button("Nouveau projet"));
    expect(panel()!.getAttribute("aria-labelledby")).toBe(panel()!.querySelector("h2")!.id);
    expect(panel()!.querySelector("h2")!.textContent).toBe("Nouveau projet");
    const proposed = (field("Autre couleur (#RRGGBB)").value);
    expect(PROJECT_PALETTE.map((p) => p.hex)).toContain(proposed);
    await type(field("Nom du projet"), "Portail RH");
    await choose(field("Client"), "__new__");
    await type(field("Nom du nouveau client"), "Initech");
    await type(field("Code projet"), "RH-1");
    await click(q("[role=radio][aria-label='Couleur " + PROJECT_PALETTE[3]!.hex + "']"));
    await click(button("Créer le projet"));
    expect(rowNames()).toContain("Portail RH");
    expect(onProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Portail RH", projectCode: "RH-1", color: PROJECT_PALETTE[3]!.hex }));
    expect(panel()!.querySelector("h2")!.textContent).toBe("Portail RH");
    expect(panel()!.textContent).toContain("Portail RH");
    expect(field("Client").selectedOptions[0]!.textContent).toBe("Initech");
  });

  it("refuse un code projet déjà utilisé, avec un message clair sous le champ", async () => {
    const source = demo();
    await source.createProject({ name: "Existant", projectCode: "J-1", clientId: null, color: "#112233", startDate: null, endDate: null, status: "planned" });
    await mount(source);
    await click(button("Nouveau projet"));
    await type(field("Nom du projet"), "Doublon");
    await type(field("Code projet"), "J-1");
    await click(button("Créer le projet"));
    expect(document.body.textContent).toContain("Ce code est déjà utilisé par un autre projet.");
    expect(field("Code projet").getAttribute("aria-invalid")).toBe("true");
    expect(rowNames()).not.toContain("Doublon");
  });

  it("refuse une fin antérieure au début et un nom vide, sans appeler le serveur", async () => {
    const source = demo();
    const create = vi.spyOn(source, "createProject");
    await mount(source);
    await click(button("Nouveau projet"));
    await click(button("Créer le projet"));
    expect(document.body.textContent).toContain("Le nom est obligatoire.");
    await type(field("Nom du projet"), "Dates");
    await type(field("Début"), "2026-05-10");
    await type(field("Fin"), "2026-05-09");
    await click(button("Créer le projet"));
    expect(document.body.textContent).toContain("La fin ne peut pas précéder le début.");
    expect(create).not.toHaveBeenCalled();
  });

  it("couleur libre : avertit (clair, rouge) au lieu d'interdire", async () => {
    await mount(demo());
    await click(button("Nouveau projet"));
    await type(field("Autre couleur (#RRGGBB)"), "#FFFFCC");
    expect(q(".wn-color-warnings")!.textContent).toContain("très claire");
    await type(field("Autre couleur (#RRGGBB)"), "#B91C1C");
    expect(q(".wn-color-warnings")!.textContent).toContain("rouge du dépassement");
  });

  it("Échap ferme le panneau de création et rend le focus au bouton", async () => {
    await mount(demo());
    const opener = button("Nouveau projet")!;
    await click(opener);
    await act(async () => { panel()!.querySelector("h2")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("RT-023 : clic sur le voile ferme le panneau vide ; une fois saisi, il demande d'abord « Abandonner les modifications ? » (Q7)", async () => {
    const pressOn = async (el: Element) => act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    });
    const scrim = () => document.body.querySelector<HTMLElement>("[data-slot=dialog-overlay]")!;
    await mount(demo());
    await click(button("Nouveau projet"));
    await pressOn(scrim());
    await flush();
    expect(panel()).toBeNull();
    await click(button("Nouveau projet"));
    await type(field("Nom du projet"), "Refonte du site");
    await pressOn(scrim());
    await flush();
    expect(panel()).not.toBeNull();
    const alert = document.body.querySelector<HTMLElement>("[role=alertdialog]")!;
    expect(alert.querySelector("h2")!.textContent).toBe("Abandonner les modifications ?");
    await click([...alert.querySelectorAll("button")].find((b) => b.textContent === "Abandonner"));
    expect(panel()).toBeNull();
  });
});

describe("panneau d'un projet", () => {
  const open = async (name: string) => { await click(byText("tbody th button", name)); };

  it("change la couleur : PATCH avec la version lue, le nouveau coloris est répercuté et la pastille de la liste suit", async () => {
    const onProject = vi.fn();
    await mount(demo({ onProject }));
    await open("Projet A");
    expect(panel()!.textContent).toContain("Projet A");
    const target = PROJECT_PALETTE[5]!.hex;
    await click(q(`[role=radio][aria-label='Couleur ${target}']`));
    await click(button("Enregistrer"));
    expect(onProject).toHaveBeenLastCalledWith(expect.objectContaining({ id: "1", color: target, version: 2 }));
    expect(panel()!.textContent).toContain("Modifications enregistrées.");
    expect(q<HTMLElement>("tbody tr .wn-dot")!.style.background).toMatch(/rgb|#/);
    expect(button("Enregistrer")!.disabled).toBe(true); // plus rien à enregistrer
  });

  it("409 VERSION_CONFLICT : message traduit et rechargement du projet", async () => {
    const source = demo();
    await mount(source);
    await open("Projet A");
    // Une autre session modifie le projet entre-temps.
    const list = await source.listProjects();
    if (!list.ok) throw new Error("liste");
    await source.updateProject(list.value[0]!, { name: "Renommé ailleurs" });
    await type(field("Nom du projet"), "Mon nom");
    await click(button("Enregistrer"));
    expect(alerts().join(" ")).toContain("modifié par quelqu’un d’autre");
    await click(button("Recharger le projet"));
    expect(field("Nom du projet").value).toBe("Renommé ailleurs");
  });

  it("403 de périmètre (BR-33) : message dédié", async () => {
    const s = demo();
    const refusing: ProjectsSource = { ...s, updateProject: async () => ({ ok: false, error: { code: "FORBIDDEN", params: { scope: "project" } } }) };
    await mount(refusing);
    await open("Projet A");
    await type(field("Nom du projet"), "Autre");
    await click(button("Enregistrer"));
    expect(alerts().join(" ")).toContain("Vous ne gérez pas ce projet");
  });

  it("tâches : ajout, renommage, suppression ; suppression refusée par l'API (REFERENCE_IN_USE) expliquée", async () => {
    const s = demo();
    await mount(s);
    await open("Projet A");
    await type(field("Nom de la nouvelle tâche"), "Maquettes");
    await click(button("Ajouter"));
    expect(panel()!.textContent).toContain("Maquettes");
    await click(button("Renommer Maquettes"));
    await type(field("Nouveau nom de la tâche Maquettes"), "Wireframes");
    await click(byText(".wn-inline-form button[type=submit]", "Enregistrer"));
    expect(panel()!.textContent).toContain("Wireframes");
    await click(button("Supprimer Wireframes"));
    expect(panel()!.textContent).not.toContain("Wireframes");
    await act(async () => {}); // état stable
    // Refus de l'API.
    act(() => root!.unmount()); host.remove();
    const refusing: ProjectsSource = { ...s, deleteTask: async () => ({ ok: false, error: { code: "REFERENCE_IN_USE", params: { allocations: 2 } } }) };
    await s.createTask("1", "Utilisée");
    await mount(refusing);
    await open("Projet A");
    await click(button("Supprimer Utilisée"));
    expect(alerts().join(" ")).toContain("Suppression impossible : des allocations");
    expect(panel()!.textContent).toContain("Utilisée");
  });

  it("équipe : liste les membres, ajoute une personne ; retrait BR-10 avec récapitulatif puis confirmation", async () => {
    const summary = { inTeam: true, allocationCount: 3, firstAllocation: "2026-10-01", lastAllocation: "2026-10-10", logCount: 0, logHours: 0, lockedLogCount: 0, canRemove: true };
    const editor: TeamRemovalEditor = {
      teamRemovalSummary: vi.fn(async () => ({ ok: true as const, summary })),
      removeFromTeam: vi.fn(async () => ({ ok: true as const, removedAllocations: 3, removedLogs: 0, removedLogHours: 0 })),
    };
    await mount(demo(), { editor });
    await open("Projet A");
    const members = () => [...document.body.querySelectorAll(".wn-panel-block .wn-rows li .wn-row-name")].map((e) => e.textContent);
    const before = members().length;
    expect(button(/^Retirer /)).toBeTruthy();
    const pick = field("Personne à ajouter à l’équipe") as HTMLSelectElement;
    const candidate = [...pick.options].find((o) => o.value)!;
    await choose(pick, candidate.value);
    await click(button("Ajouter à l’équipe"));
    expect(members()).toContain(candidate.textContent);
    expect(members().length).toBe(before + 1);

    await click(button(new RegExp(`^Retirer ${candidate.textContent}…`)));
    expect(editor.teamRemovalSummary).toHaveBeenCalled();
    expect(document.body.textContent).toContain("3 allocations supprimées");
    expect(editor.removeFromTeam).not.toHaveBeenCalled(); // jamais sans confirmation explicite
    await click(button("Retirer du projet"));
    expect(editor.removeFromTeam).toHaveBeenCalledWith("1", candidate.value, { allocationCount: 3, logCount: 0, logHours: 0 });
    expect(members()).not.toContain(candidate.textContent);
  });

  it("retrait impossible quand des temps saisis sont verrouillés : pas de bouton de confirmation", async () => {
    const locked = { inTeam: true, allocationCount: 1, firstAllocation: null, lastAllocation: null, logCount: 2, logHours: 8, lockedLogCount: 2, canRemove: false };
    const editor: TeamRemovalEditor = { teamRemovalSummary: async () => ({ ok: true as const, summary: locked }), removeFromTeam: vi.fn() as never };
    await mount(demo(), { editor });
    await open("Projet A");
    await click(button(/^Retirer /));
    expect(button("Retirer du projet")).toBeUndefined();
    expect(alerts().join(" ")).toContain("Retrait impossible");
  });
});

describe("clients (RT-053 : gérés dans Réglages seul)", () => {
  it("l'écran Projets n'a plus d'onglet ni de section Clients", async () => {
    await mount(demo());
    expect(document.body.querySelector("[role=tab]")).toBeNull();
    expect(button("Ajouter")).toBeUndefined();
    expect(document.body.querySelector(".wn-clients")).toBeNull();
  });

  it("le menu « … » d'une ligne porte l'action Modifier et ouvre la fiche", async () => {
    await mount(demo());
    const trigger = q<HTMLButtonElement>('[data-row-actions]')!;
    expect(trigger.getAttribute("aria-label")).toBe("Actions pour Projet A");
    await click(trigger);
    const items = [...document.body.querySelectorAll("[role=menuitem]")].map((e) => e.textContent);
    expect(items).toEqual(["Modifier"]);
    await click(document.body.querySelector("[role=menuitem]"));
    expect(panel()).not.toBeNull();
  });
});

describe("droits (member, guest : lecture seule)", () => {
  it("masque « Nouveau projet », désactive les champs et retire les actions d'écriture", async () => {
    await mount(demo(), { canEdit: false });
    expect(button("Nouveau projet")).toBeUndefined();
    await click(byText("tbody th button", "Projet A"));
    expect(panel()!.textContent).toContain("lecture seule");
    expect(field("Nom du projet").disabled).toBe(true);
    expect(button("Enregistrer")).toBeUndefined();
    expect(button("Ajouter")).toBeUndefined();
    expect(button(/^Retirer /)).toBeUndefined();
    expect(q("[data-row-actions]")).toBeNull();
  });

  it("vide : pas d'action de création pour un lecteur", async () => {
    await mount(emptySource(), { canEdit: false });
    expect(document.body.textContent).toContain("Aucun projet pour l’instant");
    expect(button("Nouveau projet")).toBeUndefined();
  });
});

describe("EN", () => {
  it("l'écran s'affiche en anglais", async () => {
    await mount(demo(), { locale: "en" });
    expect(button("New project")).toBeTruthy();
    expect(document.body.textContent).toContain("Project");
    expect(byText("th", "Status")).toBeTruthy();
  });
});

