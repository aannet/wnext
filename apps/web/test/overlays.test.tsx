// @vitest-environment jsdom
// Primitives de fenêtres superposées (design/) : Modal, Drawer, Popover. Échap, clic extérieur, focus rendu au déclencheur,
// piège du focus, bouton Fermer toujours présent, rendu par portail, défilement de la page bloqué, placement du popover.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, Drawer, Modal, Popover, placePopover } from "../src/design";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root | null;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; document.body.style.overflow = ""; });

const render = (node: React.ReactNode) => act(() => { root!.render(node); });
const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
const press = (el: Element, init: KeyboardEventInit) => act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

/** Déclencheur + fenêtre ouverte par un clic, comme dans l'application. */
function Harness({ kind, onClosed }: { kind: "modal" | "drawer"; onClosed?(): void }) {
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); onClosed?.(); };
  const Win = kind === "modal" ? Modal : Drawer;
  return (
    <>
      <button type="button" id="opener" onClick={() => setOpen(true)}>ouvrir</button>
      {open && (
        <Win title="Titre" closeLabel="Fermer la fenêtre" onClose={close} footer={<Button variant="primary" id="last">OK</Button>}>
          <input id="first" aria-label="champ" />
        </Win>
      )}
    </>
  );
}
const open = () => { const b = host.querySelector<HTMLButtonElement>("#opener")!; act(() => { b.focus(); }); click(b); };

describe.each(["modal", "drawer"] as const)("%s", (kind) => {
  it("portail dans document.body, rôle dialog modal, titre relié, bouton Fermer présent", () => {
    render(<Harness kind={kind} />);
    open();
    const d = dialog()!;
    expect(host.contains(d)).toBe(false);
    expect(document.body.contains(d)).toBe(true);
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)!.textContent).toBe("Titre");
    expect(d.querySelector("button[aria-label='Fermer la fenêtre']")).not.toBeNull();
  });

  it("focus initial sur le premier champ (pas sur ×), défilement de la page bloqué puis rendu", () => {
    render(<Harness kind={kind} />);
    open();
    expect(document.activeElement?.id).toBe("first");
    expect(document.body.style.overflow).toBe("hidden");
    click(dialog()!.querySelector("[aria-label='Fermer la fenêtre']")!);
    expect(document.body.style.overflow).toBe("");
  });

  it("Échap ferme et rend le focus au déclencheur", () => {
    const closed = vi.fn();
    render(<Harness kind={kind} onClosed={closed} />);
    open();
    press(document.activeElement!, { key: "Escape" });
    expect(closed).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
    expect(document.activeElement?.id).toBe("opener");
  });

  it("le bouton Fermer ferme et rend le focus au déclencheur", () => {
    render(<Harness kind={kind} />);
    open();
    click(dialog()!.querySelector("[aria-label='Fermer la fenêtre']")!);
    expect(dialog()).toBeNull();
    expect(document.activeElement?.id).toBe("opener");
  });

  it("piège du focus : Tab depuis la dernière action revient au premier élément, Maj+Tab depuis le premier va à la dernière", () => {
    render(<Harness kind={kind} />);
    open();
    const last = document.getElementById("last")!;
    act(() => { last.focus(); });
    press(last, { key: "Tab" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Fermer la fenêtre");
    press(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.id).toBe("last");
  });

  it("Échap pressé hors de la fenêtre (focus resté sur la page) ferme aussi", () => {
    const closed = vi.fn();
    render(<Harness kind={kind} onClosed={closed} />);
    open();
    press(document.body, { key: "Escape" });
    expect(closed).toHaveBeenCalledOnce();
  });

  it("le focus que l'appelant a déjà placé ailleurs n'est pas repris par le déclencheur", () => {
    render(<><Harness kind={kind} /><button type="button" id="elsewhere">ailleurs</button></>);
    open();
    act(() => { document.getElementById("elsewhere")!.focus(); });
    press(dialog()!, { key: "Escape" });
    expect(document.activeElement?.id).toBe("elsewhere");
  });
});

describe("Modal", () => {
  it("onEscape distinct de onClose : Échap revient d'un cran, × ferme", () => {
    const onClose = vi.fn(), onEscape = vi.fn();
    render(<Modal title="T" closeLabel="X" onClose={onClose} onEscape={onEscape}><input aria-label="a" /></Modal>);
    press(document.activeElement!, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    click(document.querySelector("[aria-label='X']")!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("sans champ ni action, le focus initial va au bouton Fermer", () => {
    render(<Modal title="T" closeLabel="X" onClose={() => {}}><p>texte</p></Modal>);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("X");
  });

  it("ancrée (pop-in du créneau) : voile et rôle modal gardés, panneau placé sous l'ancre comme un popover", () => {
    render(<Modal title="T" closeLabel="X" onClose={() => {}} anchor={{ left: 100, top: 50, width: 80, height: 20 }}><input aria-label="a" /></Modal>);
    const panel = dialog()!;
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect([panel.style.position, panel.style.left, panel.style.top]).toEqual(["absolute", "100px", "74px"]);
    expect(document.body.style.overflow).toBe("hidden");
  });
});

describe("Drawer", () => {
  it("panneau latéral de 420 px", () => {
    render(<Drawer title="T" closeLabel="X" onClose={() => {}}><p>texte</p></Drawer>);
    expect(dialog()!.className).toContain("w-[420px]");
  });
});

describe("Popover", () => {
  function PopHarness({ onClosed }: { onClosed?(): void }) {
    const [el, setEl] = useState<HTMLElement | null>(null);
    const [shown, setShown] = useState(false);
    return (
      <>
        <button type="button" id="anchor" ref={setEl} onClick={() => setShown(true)}>ancre</button>
        <button type="button" id="outside">dehors</button>
        {shown && el && (
          <Popover anchor={el} label="Pop" onClose={() => { setShown(false); onClosed?.(); }}>
            <button type="button" id="inner">dedans</button>
          </Popover>
        )}
      </>
    );
  }
  const openPop = () => { const b = host.querySelector<HTMLButtonElement>("#anchor")!; act(() => { b.focus(); }); click(b); };
  const pointerdown = (el: Element) => act(() => { el.dispatchEvent(new Event("pointerdown", { bubbles: true })); });

  it("portail, focus initial dans le popover, Échap ferme et rend le focus à l'ancre", () => {
    const closed = vi.fn();
    render(<PopHarness onClosed={closed} />);
    openPop();
    expect(host.contains(dialog())).toBe(false);
    expect(dialog()!.getAttribute("aria-modal")).toBe("false");
    expect(document.activeElement?.id).toBe("inner");
    press(document.activeElement!, { key: "Escape" });
    expect(closed).toHaveBeenCalledOnce();
    expect(document.activeElement?.id).toBe("anchor");
  });

  it("clic extérieur ferme ; clic dedans ou sur l'ancre ne ferme pas", () => {
    const closed = vi.fn();
    render(<PopHarness onClosed={closed} />);
    openPop();
    pointerdown(document.getElementById("inner")!);
    pointerdown(document.getElementById("anchor")!);
    expect(closed).not.toHaveBeenCalled();
    pointerdown(document.getElementById("outside")!);
    expect(closed).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
  });

  it("ne bloque pas le défilement de la page", () => {
    render(<PopHarness />);
    openPop();
    expect(document.body.style.overflow).toBe("");
  });

  it("ancré à un rectangle (bloc de la grille)", () => {
    render(<Popover anchor={{ left: 100, top: 50, width: 80, height: 20 }} label="Pop" onClose={() => {}}><p>x</p></Popover>);
    expect(dialog()!.style.left).toBe("100px");
    expect(dialog()!.style.top).toBe("74px");
  });
});

describe("placePopover", () => {
  const view = { width: 1000, height: 600 };
  const size = { width: 200, height: 100 };
  it("sous l'ancre, aligné à sa gauche", () => {
    expect(placePopover({ left: 100, top: 100, width: 50, height: 20 }, size, view)).toEqual({ left: 100, top: 124, side: "bottom" });
  });
  it("retourné au-dessus quand le bas déborde", () => {
    expect(placePopover({ left: 100, top: 560, width: 50, height: 20 }, size, view)).toEqual({ left: 100, top: 456, side: "top" });
  });
  it("aligné à droite de l'ancre quand la droite déborde", () => {
    expect(placePopover({ left: 900, top: 100, width: 80, height: 20 }, size, view).left).toBe(780);
  });
  it("reste dans la fenêtre quand ni le haut ni le bas ne conviennent", () => {
    const p = placePopover({ left: -50, top: 10, width: 20, height: 580 }, size, view);
    expect(p.left).toBe(8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + size.height).toBeLessThanOrEqual(view.height - 8);
  });
});
