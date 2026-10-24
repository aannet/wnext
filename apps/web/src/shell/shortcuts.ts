// Raccourcis clavier de l'application (RT-064, né de la décision D1 de la recette n°4) : source unique de l'aide des raccourcis
// (shell/shortcuts-help) ET des gestionnaires de touches. Chaque raccourci porte sa reconnaissance (`match`) : la grille du
// Planning (ScheduleScreen), la recherche globale (shell/global-search), l'aide elle-même et l'historique d'annulation appellent
// `matches(id, e)` au lieu de comparer des touches en dur. Les gestes au clavier d'un bloc (flèches) sont reconnus par le moteur
// (`keyGesture`, packages/engine) : leurs entrées s'appuient sur lui, et un test vérifie que toute touche qu'il reconnaît figure ici.
// Même règle pour un congé focalisé (RT-051, `timeoffKeyGesture`) : portée « timeoff ».
//  * `keys` : combinaisons affichées, chacune une suite de jetons. Les noms de touches qui sont des mots (Entrée, Échap, Maj…)
//    viennent du catalogue i18n (`keys.*`) ; les lettres, flèches et symboles sont des noms de touches, hors catalogue (comme la
//    pastille « Ctrl K » de la recherche). `mod` vaut Ctrl, ou ⌘ sur Mac.
//  * `aria` : valeur d'aria-keyshortcuts (syntaxe ARIA : Control, Meta, Shift, Alt ; combinaisons séparées par une espace).
import { keyGesture, timeoffKeyGesture, type Gesture, type TimeoffGestureKind } from "@wnext/engine";
import type { MessageKey } from "../i18n";

export interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

export type KeyToken = "mod" | "shift" | "alt" | "enter" | "escape" | "delete" | "backspace" | "menu" | "left" | "right" | "up" | "down" | (string & {});

export type ShortcutScope = "global" | "planning" | "block" | "timeoff";

export interface Shortcut {
  id: string;
  scope: ShortcutScope;
  /** Combinaisons équivalentes, affichées « ou ». */
  keys: readonly (readonly KeyToken[])[];
  /** aria-keyshortcuts du contrôle qui porte le raccourci. */
  aria: string;
  label: MessageKey;
  match(e: KeyLike): boolean;
}

const plain = (e: KeyLike) => !e.ctrlKey && !e.metaKey && !e.altKey;
const letter = (e: KeyLike, l: string) => e.key.toLowerCase() === l;
const mod = (e: KeyLike) => !!(e.ctrlKey || e.metaKey) && !e.altKey;

/** Bloc fictif pour interroger le moteur : seul le genre du geste compte ici. */
const SAMPLE = { personId: "a", startDate: "2026-01-05", endDate: "2026-01-06", mode: "hours", hoursPerDay: 4, percent: null, repeatState: "none", repeatEndDate: null } as const;
/** Genre du geste au clavier que le moteur associe à la touche (block-editor l'applique au bloc focalisé). */
export function gestureOf(e: KeyLike): Gesture["kind"] | "person" | null {
  const g = keyGesture(e, SAMPLE, ["b", "a", "c"]);
  if (!g) return null;
  return g.kind === "move" && g.personId !== undefined ? "person" : g.kind;
}

/** Genre du geste au clavier que le moteur associe à la touche sur un congé (pas d'une demi-journée, seul le genre compte). */
export const timeoffGestureOf = (e: KeyLike): TimeoffGestureKind | null => timeoffKeyGesture(e, 1)?.kind ?? null;

export const SHORTCUTS = [
  // Partout
  { id: "search", scope: "global", keys: [["mod", "K"]], aria: "Control+K Meta+K", label: "shortcuts.search",
    match: (e) => mod(e) && !e.shiftKey && letter(e, "k") },
  { id: "help", scope: "global", keys: [["?"]], aria: "?", label: "shortcuts.help", match: (e) => e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey },
  { id: "close", scope: "global", keys: [["escape"]], aria: "Escape", label: "shortcuts.close", match: (e) => e.key === "Escape" },
  // Grille du Planning (focus sur la grille ou sur un bloc)
  { id: "create", scope: "planning", keys: [["N"]], aria: "N", label: "shortcuts.create", match: (e) => plain(e) && letter(e, "n") },
  { id: "timeoff", scope: "planning", keys: [["C"]], aria: "C", label: "shortcuts.timeoff", match: (e) => plain(e) && letter(e, "c") },
  { id: "today", scope: "planning", keys: [["T"]], aria: "T", label: "shortcuts.today", match: (e) => plain(e) && letter(e, "t") },
  { id: "scroll", scope: "planning", keys: [["left"], ["right"]], aria: "ArrowLeft ArrowRight", label: "shortcuts.scroll",
    match: (e) => plain(e) && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") },
  { id: "firstBlock", scope: "planning", keys: [["enter"]], aria: "Enter", label: "shortcuts.firstBlock", match: (e) => e.key === "Enter" },
  { id: "undo", scope: "planning", keys: [["mod", "Z"]], aria: "Control+Z Meta+Z", label: "shortcuts.undo",
    match: (e) => mod(e) && !e.shiftKey && letter(e, "z") },
  { id: "redo", scope: "planning", keys: [["mod", "shift", "Z"], ["mod", "Y"]], aria: "Control+Shift+Z Control+Y Meta+Shift+Z", label: "shortcuts.redo",
    match: (e) => mod(e) && ((e.shiftKey && letter(e, "z")) || (!e.shiftKey && letter(e, "y"))) },
  // Bloc focalisé
  { id: "open", scope: "block", keys: [["enter"]], aria: "Enter", label: "shortcuts.open", match: (e) => e.key === "Enter" },
  { id: "leave", scope: "block", keys: [["escape"]], aria: "Escape", label: "shortcuts.leave", match: (e) => e.key === "Escape" },
  { id: "move", scope: "block", keys: [["left"], ["right"]], aria: "ArrowLeft ArrowRight", label: "shortcuts.move", match: (e) => gestureOf(e) === "move" },
  { id: "resizeEnd", scope: "block", keys: [["shift", "left"], ["shift", "right"]], aria: "Shift+ArrowLeft Shift+ArrowRight", label: "shortcuts.resizeEnd",
    match: (e) => gestureOf(e) === "resizeEnd" },
  { id: "resizeStart", scope: "block", keys: [["alt", "left"], ["alt", "right"]], aria: "Alt+ArrowLeft Alt+ArrowRight", label: "shortcuts.resizeStart",
    match: (e) => gestureOf(e) === "resizeStart" },
  { id: "height", scope: "block", keys: [["up"], ["down"]], aria: "ArrowUp ArrowDown", label: "shortcuts.height", match: (e) => gestureOf(e) === "height" },
  { id: "person", scope: "block", keys: [["mod", "up"], ["mod", "down"]], aria: "Control+ArrowUp Control+ArrowDown", label: "shortcuts.person",
    match: (e) => gestureOf(e) === "person" },
  { id: "delete", scope: "block", keys: [["delete"], ["backspace"]], aria: "Delete Backspace", label: "shortcuts.delete",
    match: (e) => plain(e) && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace") },
  { id: "duplicate", scope: "block", keys: [["mod", "D"]], aria: "Control+D Meta+D", label: "shortcuts.duplicate",
    match: (e) => mod(e) && !e.shiftKey && letter(e, "d") },
  { id: "split", scope: "block", keys: [["S"]], aria: "S", label: "shortcuts.split", match: (e) => plain(e) && !e.shiftKey && letter(e, "s") },
  { id: "menu", scope: "block", keys: [["menu"], ["shift", "F10"]], aria: "ContextMenu Shift+F10", label: "shortcuts.menu",
    match: (e) => e.key === "ContextMenu" || (e.key === "F10" && !!e.shiftKey) },
  // Congé focalisé (RT-051) : mêmes touches que les blocs, sans hauteur, personne, duplication ni scission.
  { id: "timeoffOpen", scope: "timeoff", keys: [["enter"]], aria: "Enter", label: "shortcuts.timeoffOpen", match: (e) => e.key === "Enter" },
  { id: "timeoffLeave", scope: "timeoff", keys: [["escape"]], aria: "Escape", label: "shortcuts.leave", match: (e) => e.key === "Escape" },
  { id: "timeoffMove", scope: "timeoff", keys: [["left"], ["right"]], aria: "ArrowLeft ArrowRight", label: "shortcuts.timeoffMove",
    match: (e) => timeoffGestureOf(e) === "move" },
  { id: "timeoffResizeEnd", scope: "timeoff", keys: [["shift", "left"], ["shift", "right"]], aria: "Shift+ArrowLeft Shift+ArrowRight", label: "shortcuts.resizeEnd",
    match: (e) => timeoffGestureOf(e) === "resizeEnd" },
  { id: "timeoffResizeStart", scope: "timeoff", keys: [["alt", "left"], ["alt", "right"]], aria: "Alt+ArrowLeft Alt+ArrowRight", label: "shortcuts.resizeStart",
    match: (e) => timeoffGestureOf(e) === "resizeStart" },
  { id: "timeoffDelete", scope: "timeoff", keys: [["delete"], ["backspace"]], aria: "Delete Backspace", label: "shortcuts.delete",
    match: (e) => plain(e) && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace") },
  { id: "timeoffMenu", scope: "timeoff", keys: [["menu"], ["shift", "F10"]], aria: "ContextMenu Shift+F10", label: "shortcuts.timeoffMenu",
    match: (e) => e.key === "ContextMenu" || (e.key === "F10" && !!e.shiftKey) },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

export function shortcut(id: ShortcutId): Shortcut {
  return BY_ID.get(id)!;
}

/** L'événement déclenche-t-il le raccourci `id` ? */
export function matches(id: ShortcutId, e: KeyLike): boolean {
  return shortcut(id).match(e);
}

/** aria-keyshortcuts de plusieurs raccourcis, dans l'ordre donné. */
export function ariaKeys(...ids: ShortcutId[]): string {
  return ids.map((id) => shortcut(id).aria).join(" ");
}

export const isMacPlatform = (platform = globalThis.navigator?.platform ?? "") => /mac|iphone|ipad/i.test(platform);

const GLYPHS: Record<string, string> = { left: "←", right: "→", up: "↑", down: "↓" };
const NAMED: Record<string, MessageKey> = {
  shift: "keys.shift", enter: "keys.enter", escape: "keys.escape", delete: "keys.delete", backspace: "keys.backspace", menu: "keys.menu",
};

/** Texte d'une touche : mot traduit (Entrée, Échap…), glyphe (flèches, ⌘, ⌥) ou nom de touche tel quel. */
export function keyText(token: KeyToken, t: (k: MessageKey) => string, mac = isMacPlatform()): string {
  if (token === "mod") return mac ? "⌘" : "Ctrl";
  if (token === "alt") return mac ? "⌥" : "Alt";
  const named = NAMED[token];
  if (named) return t(named);
  return GLYPHS[token] ?? token;
}
