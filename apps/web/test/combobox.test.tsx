// @vitest-environment jsdom
// Combobox avec recherche (design, Combobox Base UI depuis L-K, ADR-010) : filtre sans accents, flèches + Entrée, clic,
// Échap qui ferme la liste sans fermer la fenêtre parente, texte rendu au départ du champ, liste vide signalée hors listbox,
// liste dans un portail au-dessus d'un drawer.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Combobox, Drawer } from "../src/design";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = null; });

const OPTIONS = [{ id: "1", name: "Refonte" }, { id: "2", name: "Écluse" }, { id: "3", name: "Audit" }];
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function mount(o: { onParentKey?: (k: string) => void; inDrawer?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  function Harness() {
    const [value, setValue] = useState<string | null>("1");
    const field = <Combobox label="Projet" value={value} options={OPTIONS} onChange={setValue} emptyLabel="Aucun résultat" />;
    // Parent React (comme une fenêtre qui ferme sur Échap) : la propagation s'arrête au champ quand la liste est ouverte.
    return (
      <div onKeyDown={(e) => o.onParentKey?.(e.key)}>
        {o.inDrawer ? <Drawer title="T" closeLabel="X" onClose={() => {}}>{field}</Drawer> : field}
        <output>{value}</output>
      </div>
    );
  }
  act(() => root!.render(<Harness />));
  await flush();
  const input = document.querySelector<HTMLInputElement>("input[role=combobox]")!;
  return { host, input, value: () => host.querySelector("output")!.textContent };
}
const type = async (el: HTMLInputElement, v: string) => {
  act(() => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    // Frappe réelle (inputType) : Base UI n'ouvre pas la liste sur un remplissage automatique.
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await flush();
};
const key = async (el: Element, k: string) => { act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); await flush(); };
const shown = () => [...document.querySelectorAll("[role=option]")].map((o) => o.textContent);

it("taper filtre sans casse ni accents ; flèches puis Entrée choisissent ; le champ montre le choix", async () => {
  const { input, value } = await mount();
  expect(input.value).toBe("Refonte");
  await type(input, "ecl");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(shown()).toEqual(["Écluse"]);
  await key(input, "Enter");
  expect([value(), input.value, input.getAttribute("aria-expanded")]).toEqual(["2", "Écluse", "false"]);
  await key(input, "ArrowDown");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(shown()).toEqual(["Refonte", "Écluse", "Audit"]);
  expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
});

it("Échap ferme la liste sans atteindre la fenêtre parente ; liste fermée, Échap remonte", async () => {
  const keys: string[] = [];
  const { input } = await mount({ onParentKey: (k) => keys.push(k) });
  await type(input, "a");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  await key(input, "Escape");
  expect([input.getAttribute("aria-expanded"), keys]).toEqual(["false", []]);
  await key(input, "Escape");
  expect([keys, input.value]).toEqual([["Escape"], "Refonte"]);
});

it("clic sur une option ; aucun résultat : message hors listbox ; quitter le champ rend le texte du choix", async () => {
  const { input, value } = await mount();
  await type(input, "zz");
  expect(document.querySelector("[role=option]")).toBeNull();
  expect(document.querySelector(".wn-combobox-empty")?.textContent?.replace(/\u2060/g, "")).toBe("Aucun résultat");
  expect(document.querySelector(".wn-combobox-empty")?.closest("[role=listbox]")).toBeNull();
  act(() => { input.blur(); });
  await flush();
  expect(input.value).toBe("Refonte");
  await type(input, "au");
  act(() => { document.querySelector<HTMLElement>("[role=option]")!.click(); });
  await flush();
  expect(value()).toBe("3");
});

it("dans un drawer : la liste s'ouvre dans un portail Base UI, hors du panneau, au-dessus de la fenêtre", async () => {
  const { input } = await mount({ inDrawer: true });
  await type(input, "a");
  const list = document.querySelector<HTMLElement>("[role=listbox]")!;
  expect(list).not.toBeNull();
  expect(list.closest("[role=dialog]")).toBeNull();
  expect(list.closest(".wn-combobox-popup")).not.toBeNull();
});

it("erreur reliée au champ : aria-invalid et aria-describedby posés sur la saisie, absents sans erreur", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (invalid: boolean) => act(() => root!.render(<>
    <Combobox label="Fuseau" value="1" options={OPTIONS} onChange={() => {}} emptyLabel="Aucun" invalid={invalid} {...(invalid ? { describedBy: "err" } : {})} />
    <p id="err">Inconnu</p>
  </>));
  render(false);
  await flush();
  const input = document.querySelector<HTMLInputElement>("input[role=combobox]")!;
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(input.getAttribute("aria-describedby")).toBeNull();
  render(true);
  await flush();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe("err");
});
