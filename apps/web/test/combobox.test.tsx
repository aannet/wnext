// @vitest-environment jsdom
// Combobox avec recherche (design) : filtre sans accents, flèches + Entrée, clic, Échap qui ferme la liste sans fermer la
// fenêtre parente, texte rendu au départ du champ, liste vide signalée hors listbox.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Combobox } from "../src/design";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; root = null; });

const OPTIONS = [{ id: "1", name: "Refonte" }, { id: "2", name: "Écluse" }, { id: "3", name: "Audit" }];
function mount(onParentKey: (k: string) => void = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  function Harness() {
    const [value, setValue] = useState<string | null>("1");
    // Parent React (comme le Popover, qui ferme sur Échap) : la propagation s'arrête au champ.
    return <div onKeyDown={(e) => onParentKey(e.key)}><Combobox label="Projet" value={value} options={OPTIONS} onChange={setValue} emptyLabel="Aucun résultat" /><output>{value}</output></div>;
  }
  act(() => root!.render(<Harness />));
  const input = host.querySelector<HTMLInputElement>("input[role=combobox]")!;
  return { host, input, value: () => host.querySelector("output")!.textContent };
}
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
const shown = (host: HTMLElement) => [...host.querySelectorAll("[role=option]")].map((o) => o.textContent);

it("taper filtre sans casse ni accents ; flèches puis Entrée choisissent ; le champ montre le choix", () => {
  const { host, input, value } = mount();
  expect(input.value).toBe("Refonte");
  type(input, "ecl");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(shown(host)).toEqual(["Écluse"]);
  key(input, "Enter");
  expect([value(), input.value, input.getAttribute("aria-expanded")]).toEqual(["2", "Écluse", "false"]);
  key(input, "ArrowDown");
  expect(input.getAttribute("aria-activedescendant")).toBe(host.querySelector("[role=option][aria-selected=true]")!.id);
  key(input, "ArrowDown");
  key(input, "Enter");
  expect(value()).toBe("3");
});

it("Échap ferme la liste sans atteindre la fenêtre parente ; liste fermée, Échap remonte", () => {
  const keys: string[] = [];
  const { input } = mount((k) => keys.push(k));
  type(input, "a");
  key(input, "Escape");
  expect([input.getAttribute("aria-expanded"), input.value, keys]).toEqual(["false", "Refonte", []]);
  key(input, "Escape");
  expect(keys).toEqual(["Escape"]);
});

it("clic sur une option ; aucun résultat : message hors listbox ; quitter le champ rend le texte du choix", () => {
  const { host, input, value } = mount();
  type(input, "zz");
  expect(host.querySelector("[role=listbox]")).toBeNull();
  expect(host.querySelector(".wn-combobox-empty")?.textContent).toBe("Aucun résultat");
  act(() => { input.dispatchEvent(new FocusEvent("blur")); input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(input.value).toBe("Refonte");
  type(input, "au");
  act(() => { host.querySelector("[role=option]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
  expect(value()).toBe("3");
});
