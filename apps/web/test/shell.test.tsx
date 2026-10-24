// @vitest-environment jsdom
// Coque applicative : en-tête (nom, navigation, Réglages hors navigation, « Bonjour », avatar, menu utilisateur), routes,
// pages « bientôt », masquage par rôle, écrans d'accès (connexion, session expirée, erreur, chargement).
import type { Me } from "@wnext/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n, type UiLocale } from "../src/i18n";
import { App, type AppProps } from "../src/shell/app";
import { demoMe, type MeState } from "../src/shell/me";
import { createRouter, type Router } from "../src/shell/router";
import { LoginFailure, LoginScreen } from "../src/shell/screens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host.remove(); root = null; });

function memoryRouter(path = "/", search = ""): Router & { pushed: string[]; back(to: string): void } {
  const pushed: string[] = [];
  let pop = () => {};
  const loc = { pathname: path, search };
  const router = createRouter({
    location: loc,
    history: { pushState: (_s, _u, url) => { pushed.push(url); const [p, q = ""] = url.split("?"); loc.pathname = p!; loc.search = q ? `?${q}` : ""; } },
    onPopState: (fn) => { pop = fn; return () => {}; },
  });
  return Object.assign(router, { pushed, back(to: string) { loc.pathname = to; pop(); } });
}
const user = (role: Me["role"] = "owner", name = "Alec Annet"): MeState => ({ status: "ready", me: { ...demoMe(), role, user: { id: "1", name, email: "alec@wnext.test" } } });

function mount(props: Partial<AppProps> & { router?: Router; locale?: UiLocale }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const router = props.router ?? memoryRouter();
  act(() => root!.render(<App i18n={createI18n(props.locale ?? "fr")} router={router} me={user()} renderPlanning={() => <main><h1 tabIndex={-1}>Planning</h1><p>grille</p></main>} {...props} />));
  return router;
}
const click = (el: Element | null | undefined, init: MouseEventInit = {}) => { act(() => { el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })); }); };
const link = (name: string) => [...host.querySelectorAll("a")].find((a) => a.textContent === name);

describe("en-tête applicatif", () => {
  it("nom de l'app, navigation principale Planning / Projets / Personnes, Réglages hors de la navigation", () => {
    mount({});
    const header = host.querySelector("header")!;
    expect(header.querySelector(".wn-brand")!.textContent).toBe("WNEXT"); // le lien de marque mène au planning
    const nav = header.querySelector("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Navigation principale");
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Planning", "Projets", "Personnes"]);
    expect(nav.querySelector("a[aria-current=page]")!.textContent).toBe("Planning");
    expect(nav.textContent).not.toContain("Réglages");
    expect(header.querySelector(".wn-appheader-end a")!.textContent).toBe("Réglages");
  });

  it("« Bonjour {prénom} » et avatar à initiales à droite ; EN : « Hello »", () => {
    mount({});
    const end = host.querySelector(".wn-appheader-end")!;
    expect(end.querySelector(".wn-greeting")!.textContent).toBe("Bonjour Alec");
    expect(end.querySelector(".wn-avatar")!.textContent).toBe("AA");
    expect(end.querySelector(".wn-avatar")!.getAttribute("aria-hidden")).toBe("true");
    act(() => root!.unmount()); host.remove();
    mount({ locale: "en" });
    expect(host.querySelector(".wn-greeting")!.textContent).toBe("Hello Alec");
    expect(host.querySelector("nav a")!.textContent).toBe("Schedule");
  });

  it("masquage par rôle : Réglages pour owner et admin seulement", () => {
    const seen: Record<string, boolean> = {};
    for (const role of ["owner", "admin", "project_manager", "member", "guest"] as const) {
      mount({ me: user(role) });
      seen[role] = link("Réglages") !== undefined;
      act(() => root!.unmount()); host.remove();
    }
    expect(seen).toEqual({ owner: true, admin: true, project_manager: false, member: false, guest: false });
    mount({ me: user("member"), router: memoryRouter("/reglages") }); // adresse saisie à la main : comme une page inconnue
    expect(host.querySelector("main h1")!.textContent).toBe("Page introuvable");
  });

  it("menu utilisateur : avatar seul sans session ; avec onLogout, bouton de menu, Déconnexion, Échap rend le focus", async () => {
    mount({});
    expect(host.querySelector(".wn-avatar-button")).toBeNull();
    act(() => root!.unmount()); host.remove();
    const onLogout = vi.fn();
    mount({ onLogout });
    const trigger = host.querySelector<HTMLButtonElement>(".wn-avatar-button")!;
    expect(trigger.getAttribute("aria-label")).toBe("AA, menu utilisateur de Alec Annet");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const item = document.querySelector<HTMLElement>("[role=menu] [role=menuitem]")!; // le menu est dans un portail (Base UI)
    expect(item.textContent).toBe("Déconnexion");
    expect(document.activeElement).toBe(item);
    expect(document.querySelector("[role=menu]")!.textContent).toContain("alec@wnext.test");
    act(() => { item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelector("[role=menu]")).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // Base UI rend le focus après la fermeture
    expect(document.activeElement).toBe(trigger);
    click(trigger);
    click(document.querySelector("[role=menuitem]"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  // axe ne tranche pas cette règle sous jsdom (pas de rendu) : la vraie pile la vérifie (login.oidc.ts).
  it("menu utilisateur : le nom accessible commence par les initiales visibles (WCAG 2.5.3, PO-14) ; EN aussi", () => {
    for (const [locale, expected] of [["fr", "AA, menu utilisateur de Alec Annet"], ["en", "AA, user menu for Alec Annet"]] as const) {
      mount({ onLogout: vi.fn(), locale });
      const trigger = host.querySelector<HTMLButtonElement>(".wn-avatar-button")!;
      expect(trigger.getAttribute("aria-label")).toBe(expected);
      act(() => root!.unmount()); host.remove();
      host = document.createElement("div"); document.body.appendChild(host);
    }
  });
});

describe("navigation", () => {
  it("Projets puis retour au Planning : adresse (requête conservée), page « bientôt », lien actif, focus sur le titre", () => {
    const router = memoryRouter("/", "?demo=1");
    mount({ router });
    expect(host.querySelector("main h1")!.textContent).toBe("Planning");
    click(link("Projets"));
    expect(router.pushed).toEqual(["/projets?demo=1"]);
    expect(host.querySelector("main h1")!.textContent).toBe("Projets");
    expect(host.querySelector(".wn-soon h2")!.textContent).toBe("Bientôt disponible");
    expect(host.querySelector(".wn-soon p")!.textContent).toBe("Cette page est en préparation : Projets arrivera dans une prochaine version.");
    expect(host.querySelector("nav a[aria-current=page]")!.textContent).toBe("Projets");
    expect(document.activeElement).toBe(host.querySelector("main h1"));
    expect(document.title).toBe("Projets · WNEXT");
    click(link("Planning"));
    expect(router.pushed.at(-1)).toBe("/?demo=1");
    expect(host.querySelector("main p")!.textContent).toBe("grille");
    expect(document.title).toBe("Planning · WNEXT");
  });

  it("Personnes et Réglages ont leur page « bientôt » ; précédent du navigateur ramène à la page d'avant", () => {
    const router = memoryRouter();
    mount({ router });
    click(link("Personnes"));
    expect(host.querySelector("main h1")!.textContent).toBe("Personnes");
    click(link("Réglages"));
    expect(host.querySelector("main h1")!.textContent).toBe("Réglages");
    act(() => router.back("/"));
    expect(host.querySelector("main p")!.textContent).toBe("grille");
  });

  it("Personnes et Réglages rendus par l'appelant (lot L-F2) ; Réglages reste introuvable pour un rôle sans droit, même rendu fourni", () => {
    const pages = { renderPeople: () => <main><h1>Personnes</h1><p>liste des personnes</p></main>, renderSettings: () => <main><h1>Réglages</h1><p>sections</p></main> };
    const router = memoryRouter();
    mount({ router, ...pages });
    click(link("Personnes"));
    expect(host.querySelector("main p")!.textContent).toBe("liste des personnes");
    expect(host.querySelector(".wn-soon")).toBeNull();
    click(link("Réglages"));
    expect(host.querySelector("main p")!.textContent).toBe("sections");
    act(() => root!.unmount());
    host.remove();
    mount({ router: memoryRouter("/reglages"), me: user("member"), ...pages });
    expect(host.querySelector("main h1")!.textContent).toBe("Page introuvable");
  });

  it("clic modifié (Ctrl, Cmd, molette) : laissé au navigateur, pas de navigation interne", () => {
    const router = memoryRouter();
    mount({ router });
    click(link("Projets"), { ctrlKey: true });
    click(link("Projets"), { metaKey: true });
    click(link("Projets"), { button: 1 });
    expect(router.pushed).toEqual([]);
    expect(link("Projets")!.getAttribute("href")).toBe("/projets");
  });

  it("adresse inconnue : page introuvable avec retour au planning", () => {
    const router = memoryRouter("/nimporte-quoi");
    mount({ router });
    expect(host.querySelector("main h1")!.textContent).toBe("Page introuvable");
    expect(host.querySelector("nav a[aria-current=page]")).toBeNull();
    click(link("Retour au planning"));
    expect(router.current()).toBe("planning");
  });

  it("une seule zone <main> et un seul <h1> par page", () => {
    mount({});
    click(link("Personnes"));
    expect([host.querySelectorAll("main").length, host.querySelectorAll("h1").length]).toEqual([1, 1]);
  });
});

describe("marque (logo et mot-symbole)", () => {
  const brandOk = (el: Element) => {
    const svg = el.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect([svg.querySelectorAll("rect").length, svg.querySelectorAll("circle").length]).toEqual([3, 1]);
    expect(el.querySelector(".wn-brand-text")!.textContent).toBe("WNEXT");
    expect(el.textContent).toBe("WNEXT"); // le symbole n'ajoute rien au nom accessible
  };
  it("en-tête : symbole masqué aux lecteurs d'écran, puis « WNEXT »", () => {
    mount({});
    brandOk(host.querySelector("header .wn-brand")!);
  });
  it("écran de connexion : même marque", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<LoginScreen i18n={createI18n("fr")} onLogin={() => {}} />));
    brandOk(host.querySelector(".wn-gate-brand")!);
  });
});

describe("écrans d'accès", () => {
  it("profil en chargement, en erreur (réessayer), session expirée (se reconnecter) : sans en-tête applicatif", () => {
    mount({ me: { status: "loading" } });
    expect(host.querySelector("main")!.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelector("header")).toBeNull();
    const retry = vi.fn();
    act(() => root!.unmount()); host.remove();
    mount({ me: { status: "error" }, onRetry: retry });
    expect(host.querySelector("[role=alert]")!.textContent).toBe("WNEXT n’a pas pu charger votre profil. Réessayez.");
    click(host.querySelector("button"));
    expect(retry).toHaveBeenCalledTimes(1);
    const reconnect = vi.fn();
    act(() => root!.unmount()); host.remove();
    mount({ me: { status: "unauthenticated" }, onReconnect: reconnect });
    expect(host.querySelector("h1")!.textContent).toBe("Session expirée");
    expect(host.querySelector("header")).toBeNull();
    click(host.querySelector("button"));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("portail de connexion : nom de l'app, titre, bouton « Se connecter » qui lance la connexion", () => {
    const login = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<LoginScreen i18n={createI18n("fr")} onLogin={login} />));
    expect(host.querySelector(".wn-gate-brand")!.textContent).toBe("WNEXT");
    expect(host.querySelector("main h1")!.textContent).toBe("Connexion");
    click(host.querySelector("button"));
    expect(login).toHaveBeenCalledTimes(1);
    expect(host.querySelector("button")!.textContent).toBe("Se connecter");
  });

  it("échec de connexion : alerte traduite et bouton pour recommencer", () => {
    const retry = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<LoginFailure i18n={createI18n("en")} onRetry={retry} />));
    expect(host.querySelector("main [role=alert]")!.textContent).toBe("Sign-in failed. Please try again.");
    click(host.querySelector("button"));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
