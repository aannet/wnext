// @vitest-environment jsdom
// DataTable (RT-053) : tri ASC/DESC avec aria-sort, deux états vides (liste vide, résultat filtré vide), menu d'actions par ligne
// (nom accessible, destructive en dernier, confirmation, focus rendu), colonne d'actions absente sans action, regroupement.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareText, DataTable, type RowAction } from "../src/design";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row { id: string; name: string; n: number }
const ROWS: Row[] = [{ id: "b", name: "Beta", n: 2 }, { id: "a", name: "Alpha", n: 3 }, { id: "c", name: "Gamma", n: 1 }];

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function click(el: Element | null | undefined) { if (!el) throw new Error("élément absent"); await act(async () => { (el as HTMLElement).click(); }); await flush(); }
const names = () => [...document.body.querySelectorAll("tbody th[scope=row]")].map((e) => e.textContent);
const header = (text: string) => [...document.body.querySelectorAll("thead th")].find((th) => th.textContent === text) as HTMLElement;

function Harness({ rows = ROWS, total = rows.length, actions, groups }: { rows?: Row[]; total?: number; actions?: (r: Row) => RowAction<Row>[]; groups?: boolean }) {
  const [q, setQ] = useState("");
  return (
    <DataTable<Row>
      rows={rows} totalCount={total} rowKey={(r) => r.id} caption="Lignes" toolbarLabel="Filtrer"
      search={{ value: q, onChange: setQ, label: "Rechercher" }}
      columns={[
        { id: "name", header: "Nom", rowHeader: true, compare: (a, b) => compareText(a.name, b.name), cell: (r) => r.name },
        { id: "n", header: "Nombre", compare: (a, b) => a.n - b.n, cell: (r) => String(r.n) },
        { id: "free", header: "Libre", cell: () => "" },
      ]}
      {...(groups ? { groups: [{ key: "g1", label: "Groupe 1", rows: rows.slice(0, 2) }, { key: "g2", label: "Groupe 2", rows: rows.slice(2) }] } : {})}
      {...(actions ? { actions } : {})}
      actionsHeader="Actions" actionsLabel={(r) => `Actions pour ${r.name}`}
      empty={{ title: "Rien", body: "Créez-en un.", action: <button type="button">Nouveau</button> }}
      emptyFiltered={{ title: "Aucun résultat", body: "Changez les filtres.", resetLabel: "Réinitialiser", onReset: () => setQ("") }}
    />
  );
}
async function mount(ui: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  await flush();
}

describe("tri", () => {
  it("premier clic ASC, second DESC, aria-sort sur l'en-tête actif seulement, colonne sans comparateur non triable", async () => {
    await mount(<Harness />);
    expect(names()).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(document.body.querySelector("[aria-sort]")).toBeNull();
    await click(header("Nom").querySelector("button"));
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(header("Nom").getAttribute("aria-sort")).toBe("ascending");
    await click(header("Nom").querySelector("button"));
    expect(names()).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(header("Nom").getAttribute("aria-sort")).toBe("descending");
    await click(header("Nombre").querySelector("button"));
    expect(names()).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(header("Nom").getAttribute("aria-sort")).toBeNull();
    expect(header("Nombre").getAttribute("aria-sort")).toBe("ascending");
    expect(header("Libre").querySelector("button")).toBeNull();
  });

  it("l'en-tête triable est un vrai bouton (Tab, Entrée, Espace)", async () => {
    await mount(<Harness />);
    const b = header("Nom").querySelector("button")!;
    expect(b.tagName).toBe("BUTTON");
    expect(b.getAttribute("type")).toBe("button");
  });
});

describe("états vides", () => {
  it("liste vide : message et action de création, pas de « Réinitialiser »", async () => {
    await mount(<Harness rows={[]} total={0} />);
    expect(document.body.querySelector("table")).toBeNull();
    expect(document.body.textContent).toContain("Rien");
    expect([...document.body.querySelectorAll("button")].map((b) => b.textContent)).toContain("Nouveau");
    expect([...document.body.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Réinitialiser");
  });

  it("résultat filtré vide : « Réinitialiser » vide la recherche, la barre d'outils reste", async () => {
    await mount(<Harness rows={[]} total={3} />);
    expect(document.body.textContent).toContain("Aucun résultat");
    expect([...document.body.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Nouveau");
    expect(document.body.querySelector("[role=search] input[type=search]")).not.toBeNull();
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Réinitialiser"));
  });
});

describe("actions par ligne", () => {
  it("nom accessible, destructive en dernier, confirmation avant l'action, annuler ne fait rien, le focus ne tombe pas sur body", async () => {
    const edit = vi.fn();
    const remove = vi.fn();
    const actions = (r: Row): RowAction<Row>[] => [
      { id: "delete", label: "Supprimer", destructive: true, onSelect: () => remove(r.id), confirm: { title: `Supprimer ${r.name} ?`, confirm: "Supprimer", cancel: "Annuler", closeLabel: "Fermer" } },
      { id: "edit", label: "Modifier", onSelect: () => edit(r.id) },
    ];
    await mount(<Harness actions={actions} />);
    const trigger = document.body.querySelector<HTMLElement>('[aria-label="Actions pour Alpha"]')!;
    expect(trigger).not.toBeNull();
    await click(trigger);
    expect([...document.body.querySelectorAll("[role=menuitem]")].map((e) => e.textContent)).toEqual(["Modifier", "Supprimer"]);
    await click(document.body.querySelectorAll("[role=menuitem]")[1]);
    const dialog = document.body.querySelector("[role=dialog]")!;
    expect(dialog.querySelector("h2")!.textContent).toBe("Supprimer Alpha ?");
    expect(remove).not.toHaveBeenCalled();
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Annuler"));
    expect(remove).not.toHaveBeenCalled();
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    await click(trigger);
    await click(document.body.querySelectorAll("[role=menuitem]")[1]);
    await click([...document.body.querySelector("[role=dialog]")!.querySelectorAll("button")].find((b) => b.textContent === "Supprimer"));
    expect(remove).toHaveBeenCalledWith("a");
    expect(edit).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("action sans confirmation : exécutée aussitôt", async () => {
    const edit = vi.fn();
    await mount(<Harness actions={(r) => [{ id: "edit", label: "Modifier", onSelect: () => edit(r.id) }]} />);
    await click(document.body.querySelector('[aria-label="Actions pour Gamma"]'));
    await click(document.body.querySelector("[role=menuitem]"));
    expect(edit).toHaveBeenCalledWith("c");
  });

  it("aucune action permise : pas de colonne d'actions", async () => {
    await mount(<Harness actions={() => []} />);
    expect(document.body.querySelector("[data-row-actions]")).toBeNull();
    expect([...document.body.querySelectorAll("thead th")].map((t) => t.textContent)).toEqual(["Nom", "Nombre", "Libre"]);
  });
});

describe("regroupement", () => {
  it("un tbody par groupe, en-tête de groupe sur toutes les colonnes (actions comprises)", async () => {
    await mount(<Harness groups actions={() => [{ id: "e", label: "Modifier", onSelect: () => {} }]} />);
    expect(document.body.querySelectorAll("tbody")).toHaveLength(2);
    const heads = [...document.body.querySelectorAll("th[scope=rowgroup]")];
    expect(heads.map((h) => h.textContent)).toEqual(["Groupe 1", "Groupe 2"]);
    expect(heads[0]!.getAttribute("colspan")).toBe("4");
  });
});
