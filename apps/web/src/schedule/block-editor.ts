// Édition des blocs du Schedule par gestes (ADR-002 §5-6, ADR-001 n°9, WCAG 2.1.1 / 2.5.7), sans React ni reconstruction
// du modèle pendant le geste : un seul nœud fantôme, posé dans la surface, montre le résultat ; le modèle ne change qu'à la
// validation (écriture optimiste de l'appelant).
//  * Pointeur (Pointer Events, capture) : glisser le bloc = déplacer en dates et vers une autre ligne (personne) ; poignées
//    gauche / droite = étirer le début / la fin ; poignée basse = hauteur (heures ou %). Un seul jeu de trois poignées,
//    posé dans le bloc survolé (pointerover) : le nombre de nœuds de la grille ne change pas. Seuil de 3 px avant de démarrer
//    (un simple clic ne modifie rien). Échap annule. Près des bords, la grille défile seule (vitesse croissante).
//  * Toucher (WCAG 2.5.7) : un tap sélectionne le bloc (classe wn-selected, aria-selected) et lui pose les poignées (zones de 44 px,
//    voir styles.css) ; un tap ailleurs désélectionne. Sur un bloc non sélectionné, le doigt pan (touch-action: pan-x pan-y) : un
//    mouvement de plus de 8 px abandonne le geste et laisse défiler la grille ; sans bouger pendant 400 ms (appui long), le bloc est
//    sélectionné et le glisser armé (wn-armed, vibration, touchmove annulé). Bloc sélectionné ou poignée : glisser tout de suite.
//    Sur une case libre, même règle : un tap ne crée rien, l'appui long pose le bloc provisoire de la création (vibration,
//    touchmove annulé), le glisser l'étend, relâcher demande la création (RT-043). Pas de menu contextuel pendant l'appui long.
//    Un deuxième doigt (n'importe où) abandonne l'appui long en attente, la création ou le glisser en cours (le bloc reste en place,
//    rien n'est écrit, RT-046) ; sortir de la zone des blocs abandonne la création.
//    pointercancel (le navigateur reprend le défilement) abandonne proprement l'aperçu.
//  * Clavier, sur le bloc focalisé : équivalents du moteur (keyGesture), cumulés dans un brouillon ; Entrée valide, Échap
//    annule ; chaque pas est rendu à l'appelant pour l'annonce aria-live.
//  * Séries : le geste est appliqué à la série (applyGesture : toute la série suit) et à l'occurrence seule ; l'appelant
//    choisit la portée (BR-25). Le fantôme reste figé tant que la promesse rendue par onCommit n'est pas réglée.
//  * Positions : abscisse en jours absolus (invariante quand la piste s'allonge ou que la tranche change), ordonnée dans la
//    surface (défilement vertical compris).
//  * Pop-in du créneau (RT-013, Q5) : un clic (souris) sélectionne le bloc comme un tap ; double clic, Entrée sur le bloc
//    focalisé (sans brouillon clavier) ou clic sur le bloc déjà sélectionné : onOpen. Un glisser reste un geste.
//  * Création (RT-015 à la souris, RT-043 au toucher par appui long) : clic ou glisser dans une zone libre d'une ligne (hors
//    en-tête, blocs, congés, bande de capacité) : un bloc provisoire (.wn-slot-draft) couvre la plage, puis onCreate ; il reste
//    affiché jusqu'à clearDraft (pop-in fermée : créée ou annulée). Échap pendant le glisser annule. À la souris (RT-046), la plage
//    est bornée aux jours visibles (pas de défilement automatique) et relâcher hors de la zone des blocs abandonne la création.
//  * Alt + glisser à la souris (RT-047, convention Float) : copie au lieu de déplacer ; le bloc reste en place, le fantôme montre
//    la copie et onCopy reçoit sa place (personne, dates) au lâcher. Sans onCopy, ou au toucher : un déplacement.
import type { ScheduleResponse } from "@wnext/contracts";
import {
  applyGesture, dayNumber, expandOccurrences, fromDayNumber, keyGesture, pointerGesture, referenceHours, workDaysHoursOn, type BlockPatch, type Gesture, type GestureBlock,
} from "@wnext/engine";
import { diffBlocks, gestureBlockOf, type Allocation } from "../data/allocation-edits";
import { ROW_UNIT_PX, type GridBlock, type GridModel, type GridRow, type GridTimeoff } from "./grid-model";
import { GUTTER_PX, HEADER_PX, type Clock } from "./scroller";

/** Ce que l'éditeur lit du défilement et du rendu. */
export interface EditHost {
  surface: HTMLElement;
  data(): ScheduleResponse;
  model(): GridModel | null;
  pxPerDay(): number;
  /** Abscisse dans la surface du début d'un jour. */
  xOfDate(date: string): number;
  /** Défilement horizontal en jours absolus. */
  scrollDay(): number;
  blockAt(target: EventTarget | null): { block: GridBlock; row: GridRow; el: HTMLElement } | null;
  /** Congé affiché sous `target` (saisie des congés, hors gestes) ; absent : aucun congé. */
  timeoffAt?(target: EventTarget | null): { timeoff: GridTimeoff; row: GridRow; el: HTMLElement } | null;
}

export interface EditRequest {
  allocationId: string;
  /** Clé du bloc (allocation:rang) : on y rend le focus après une validation au clavier. */
  key: string;
  /** Rang de l'occurrence si l'allocation est une série, sinon null. */
  occurrence: number | null;
  /** Patch de l'allocation (de toute la série pour une série). */
  patch: BlockPatch;
  /** Patch de la seule occurrence (séries), null sinon. */
  occurrencePatch: BlockPatch | null;
  allocation: Allocation;
  /** Bloc (de l'occurrence) tel qu'après le geste : annonce et avertissements. */
  draft: GestureBlock;
  via: "pointer" | "keyboard";
}

export interface BlockEditorOptions {
  root: HTMLElement;
  host: EditHost;
  clock?: Partial<Pick<Clock, "raf" | "caf" | "setTimer" | "clearTimer">>;
  /** Faux : lecture seule (aucun geste). */
  enabled?(): boolean;
  /** Une promesse garde le fantôme figé (choix de portée d'une série) jusqu'à son règlement. */
  onCommit(r: EditRequest): void | Promise<unknown>;
  /** Pas clavier (brouillon courant de l'occurrence) ; null quand le brouillon est validé ou annulé. */
  onPreview?(p: { allocation: Allocation; draft: GestureBlock } | null): void;
  edgePx?: number;
  maxSpeedPx?: number;
  /** Durée de l'appui long au toucher (ms, 400 par défaut). */
  longPressMs?: number;
  /** Ouvrir la pop-in d'édition du bloc (Q5) ; absent : rien. */
  onOpen?(r: OpenRequest): void;
  /** Plage d'un bloc provisoire posé en zone libre (RT-015) ; absent : pas de création au pointeur. */
  onCreate?(r: CreateRequest): void;
  /** Alt + glisser (RT-047) : copie du bloc (de l'occurrence pour une série) à la place du fantôme ; absent : déplacement. */
  onCopy?(r: CopyRequest): void;
}

export interface CopyRequest { allocation: Allocation; key: string; draft: GestureBlock }

export interface OpenRequest { key: string; allocationId: string; occurrence: number | null; el: HTMLElement }
export interface CreateRequest {
  /** Identifiant du bloc provisoire (clearDraft ne retire que celui-là). */
  draft: number;
  personId: string; startDate: string; endDate: string;
  /** Rectangle du bloc provisoire (repère de la fenêtre) : ancre de la pop-in. */
  rect: { left: number; top: number; width: number; height: number };
}

export interface BlockEditor {
  /** Geste en cours (pointeur ou clavier) ou fantôme figé. */
  busy(): boolean;
  /** Retire le bloc provisoire `draft` (tous s'il est absent). */
  clearDraft(draft?: number): void;
  /** Sélectionne le bloc de clé `key` (null : aucun), comme un clic. */
  select(key: string | null): void;
  destroy(): void;
}

interface Session {
  key: string; alloc: Allocation; index: number | null; block: GridBlock; personId: string; anchorY: number;
  occ0: GestureBlock; ser0: GestureBlock | null; occ: GestureBlock; ser: GestureBlock | null;
}
interface Drag extends Session {
  kind: Gesture["kind"]; pointerId: number; x0: number; y0: number; sd0: number; st0: number; cx: number; cy: number; started: boolean;
  /** Le bloc était déjà sélectionné au début du geste : un clic sans glisser ouvre la pop-in (Q5). */
  wasSelected: boolean; el: HTMLElement;
  /** Geste au doigt : un deuxième doigt l'annule (RT-046). */
  touch: boolean;
  /** Alt + glisser : copie au lieu de déplacer (RT-047). */
  copy: boolean;
}
/** `touch` : création par appui long (RT-043), abandonnée si le doigt sort de la zone des blocs ou si un deuxième doigt se pose. */
interface Creating { pointerId: number; personId: string; anchor: number; day: number; touch: boolean }

const KINDS: Record<string, Gesture["kind"]> = { start: "resizeStart", end: "resizeEnd", height: "height" };
const THRESHOLD_PX = 3;
/** Mouvement toléré pendant l'appui long : au-delà, c'est un défilement. */
const SLOP_PX = 8;
type Hit = NonNullable<ReturnType<EditHost["blockAt"]>>;
type Slot = { row: GridRow; day: number };
/** Appui en attente au toucher : sur un bloc (`hit`) ou sur une case libre (`slot`, création RT-043). */
interface Pending { pointerId: number; x0: number; y0: number; cx: number; cy: number; hit: Hit | null; slot: Slot | null; timer: unknown }
const step = (b: GestureBlock, g: Gesture): GestureBlock => ({ ...b, ...(applyGesture(b, g)?.patch ?? {}) });

export function createBlockEditor(o: BlockEditorOptions): BlockEditor {
  const { root, host } = o;
  const raf = o.clock?.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
  const caf = o.clock?.caf ?? ((id: number) => cancelAnimationFrame(id));
  const edge = o.edgePx ?? 40;
  const maxSpeed = o.maxSpeedPx ?? 24;
  const doc = root.ownerDocument;
  let drag: Drag | null = null;
  let kb: Session | null = null;
  let frozen = false;
  let frame = 0;
  let ghost: HTMLDivElement | null = null;
  let pending: Pending | null = null;
  let selectedKey: string | null = null;
  let observer: MutationObserver | null = null;
  let creating: Creating | null = null;
  let draftEl: HTMLDivElement | null = null;
  let draftId = 0;
  const setTimer = o.clock?.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = o.clock?.clearTimer ?? ((id: unknown) => clearTimeout(id as number));

  function session(hit: NonNullable<ReturnType<EditHost["blockAt"]>>): Session | null {
    const alloc = host.data().allocations.find((a) => a.id === hit.block.allocationId);
    const m = host.model();
    if (!alloc || !m) return null;
    const series = alloc.repeatState !== "none";
    const index = Number(hit.block.key.split(":")[1] ?? 0);
    const o = series ? expandOccurrences(alloc, m.from, m.to).find((x) => x.index === index) : undefined;
    if (series && !o) return null;
    const occ0 = gestureBlockOf(alloc, o);
    const ser0 = series ? gestureBlockOf(alloc) : null;
    return {
      key: hit.block.key, alloc, index: series ? index : null, block: hit.block, personId: alloc.personId,
      anchorY: hit.row.top + Math.min(hit.block.y + hit.block.h / 2, hit.row.capY - 1), occ0, ser0, occ: occ0, ser: ser0,
    };
  }

  function rowAt(y: number): GridRow | null {
    const rows = host.model()?.rows ?? [];
    let lo = 0;
    let hi = rows.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid]!.top <= y) lo = mid;
      else hi = mid - 1;
    }
    return rows[lo]!;
  }

  function showGhost(s: Session) {
    const m = host.model();
    if (!m) return;
    const row = m.rows.find((r) => r.personId === s.occ.personId);
    if (!row) return;
    if (!ghost) {
      ghost = doc.createElement("div");
      ghost.className = "wn-ghost";
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.position = "absolute";
      ghost.style.top = "0";
      ghost.style.left = "0";
      ghost.style.pointerEvents = "none";
    }
    if (ghost.parentNode !== host.surface) host.surface.appendChild(ghost);
    const ppd = host.pxPerDay();
    const days = dayNumber(s.occ.endDate) - dayNumber(s.occ.startDate) + 1;
    const ratio = s.occ0.mode === "hours" ? (s.occ.hoursPerDay ?? 0) / (s.occ0.hoursPerDay || 1) : (s.occ.percent ?? 0) / (s.occ0.percent || 1);
    const y = row.top + (s.occ.personId === s.personId ? s.block.y : 0);
    ghost.style.transform = `translate(${host.xOfDate(s.occ.startDate)}px, ${y}px)`;
    ghost.style.width = `${days * ppd}px`;
    ghost.style.height = `${Math.max(4, Math.round(s.block.h * ratio))}px`;
    ghost.style.backgroundColor = s.block.color ?? "";
    ghost.style.display = "";
  }
  const hideGhost = () => { if (ghost) ghost.style.display = "none"; };

  function commit(s: Session, via: EditRequest["via"]) {
    const patch = diffBlocks(s.ser0 ?? s.occ0, s.ser ?? s.occ);
    if (Object.keys(patch).length === 0) { hideGhost(); return; }
    const r = o.onCommit({
      allocationId: s.alloc.id, key: s.key, occurrence: s.index, patch, occurrencePatch: s.ser0 ? diffBlocks(s.occ0, s.occ) : null,
      allocation: s.alloc, draft: s.occ, via,
    });
    if (!r) { hideGhost(); return; }
    frozen = true;
    void Promise.resolve(r).catch(() => {}).finally(() => { frozen = false; hideGhost(); });
  }

  function open(hit: { key: string; allocationId: string; el: HTMLElement }) {
    if (!o.onOpen || (o.enabled && !o.enabled())) return;
    const a = host.data().allocations.find((x) => x.id === hit.allocationId);
    if (!a) return;
    o.onOpen({ key: hit.key, allocationId: a.id, occurrence: a.repeatState === "none" ? null : Number(hit.key.split(":")[1] ?? 0), el: hit.el });
  }

  // ---------- création en zone libre (RT-015) ----------

  /** Ligne et jour sous le pointeur, si c'est une zone libre de la grille ; null sinon. */
  function freeSlotAt(target: EventTarget | null, clientX: number, clientY: number): Slot | null {
    const m = host.model();
    if (!m || !(target instanceof Element) || !host.surface.contains(target)) return null;
    if (target.closest(".wn-rowheader, .wn-block, .wn-timeoff, .wn-cap, [data-handle]")) return null;
    if (clientX < root.getBoundingClientRect().left + GUTTER_PX) return null;
    const r = host.surface.getBoundingClientRect();
    const y = clientY - r.top;
    const row = rowAt(y);
    if (!row || y < row.top || y >= row.top + row.capY) return null;
    const day = dayAt(clientX);
    return day === null ? null : { row, day };
  }
  /** Abscisse ramenée dans la zone des blocs visible (jours affichés seulement) ; sans mise en page, inchangée. */
  function clampX(x: number): number {
    const r = blocksRect();
    return r ? Math.min(Math.max(x, r.left), r.right - 1) : x;
  }
  function dayAt(clientX: number): number | null {
    const m = host.model();
    if (!m) return null;
    const x = clientX - host.surface.getBoundingClientRect().left - host.xOfDate(m.from);
    return x < 0 ? null : dayNumber(m.from) + Math.floor(x / host.pxPerDay());
  }

  function showDraft(c: Creating) {
    const row = host.model()?.rows.find((r) => r.personId === c.personId);
    if (!row) return;
    if (!draftEl) {
      draftEl = doc.createElement("div");
      draftEl.className = "wn-slot-draft";
      draftEl.setAttribute("aria-hidden", "true");
      draftEl.style.position = "absolute";
      draftEl.style.top = "0";
      draftEl.style.left = "0";
      draftEl.style.pointerEvents = "none";
    }
    if (draftEl.parentNode !== host.surface) host.surface.appendChild(draftEl);
    const from = Math.min(c.anchor, c.day);
    const days = Math.abs(c.day - c.anchor) + 1;
    draftEl.style.transform = `translate(${host.xOfDate(fromDayNumber(from))}px, ${row.top}px)`;
    draftEl.style.width = `${days * host.pxPerDay()}px`;
    draftEl.style.height = `${Math.max(4, Math.min(row.capY, host.model()?.rowUnitPx ?? ROW_UNIT_PX))}px`;
    draftEl.style.display = "";
  }
  function clearDraft(id?: number) {
    if (id !== undefined && id !== draftId) return;
    if (draftEl) draftEl.style.display = "none";
  }

  function beginCreate(e: PointerEvent): boolean {
    const slot = freeSlotAt(e.target, e.clientX, e.clientY);
    if (!slot) return false;
    e.preventDefault();
    startCreate(e.pointerId, slot, false);
    listen();
    return true;
  }
  function startCreate(pointerId: number, slot: Slot, touch: boolean) {
    creating = { pointerId, personId: slot.row.personId, anchor: slot.day, day: slot.day, touch };
    draftId++;
    showDraft(creating);
  }
  function endCreate(commit: boolean) {
    const c = creating;
    creating = null;
    unlisten();
    if (!c) return;
    if (!commit) { clearDraft(); return; }
    const r = draftEl?.getBoundingClientRect();
    const from = Math.min(c.anchor, c.day);
    const to = Math.max(c.anchor, c.day);
    o.onCreate?.({
      draft: draftId, personId: c.personId, startDate: fromDayNumber(from), endDate: fromDayNumber(to),
      rect: { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 },
    });
  }

  // ---------- pointeur ----------

  function update(d: Drag) {
    const ppd = host.pxPerDay();
    const dx = d.cx - d.x0 + (host.scrollDay() - d.sd0) * ppd;
    const dy = d.cy - d.y0 + (root.scrollTop - d.st0);
    if (!d.started) {
      if (Math.abs(dx) < THRESHOLD_PX && Math.abs(dy) < THRESHOLD_PX) return;
      d.started = true;
      root.classList.add("wn-dragging");
    }
    const person = host.data().people.find((p) => p.id === d.personId);
    const g = pointerGesture(d.kind, dx, dy, { pxPerDay: ppd, rowHeightPx: host.model()?.rowUnitPx ?? ROW_UNIT_PX, refHours: referenceHours(person ? workDaysHoursOn(person, d.occ0.startDate) : []), mode: d.occ0.mode });
    if (g.kind === "move") { const r = rowAt(d.anchorY + dy); if (r) g.personId = r.personId; }
    d.occ = step(d.occ0, g);
    d.ser = d.ser0 && step(d.ser0, g);
    showGhost(d);
  }

  /** Vitesse de défilement automatique (px par image) selon la distance aux bords de la zone des blocs. */
  function edgeSpeed(d: Drag): { x: number; y: number } {
    const r = root.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    const v = (dist: number) => (dist < edge ? Math.round(maxSpeed * Math.min(1, (edge - dist) / edge)) : 0);
    return {
      x: v(d.cx - (r.left + GUTTER_PX)) ? -v(d.cx - (r.left + GUTTER_PX)) : v(r.right - d.cx),
      y: v(d.cy - (r.top + HEADER_PX)) ? -v(d.cy - (r.top + HEADER_PX)) : v(r.bottom - d.cy),
    };
  }

  function tick() {
    frame = 0;
    const d = drag;
    if (!d) return;
    if (!d.started) update(d);
    const s = d.started ? edgeSpeed(d) : { x: 0, y: 0 };
    if (s.x) root.scrollLeft = Math.max(0, root.scrollLeft + s.x);
    if (s.y) root.scrollTop = Math.max(0, root.scrollTop + s.y);
    update(d);
    if (s.x || s.y) schedule();
  }
  const schedule = () => { if (!frame) frame = raf(tick); };

  function endDrag(): Drag | null {
    const d = drag;
    drag = null;
    if (frame) { caf(frame); frame = 0; }
    unlisten();
    root.classList.remove("wn-dragging");
    for (const el of root.querySelectorAll(".wn-armed")) el.classList.remove("wn-armed");
    return d;
  }

  function listen() {
    doc.addEventListener("pointermove", onMove, true);
    doc.addEventListener("pointerup", onUp, true);
    doc.addEventListener("pointercancel", onCancel, true);
    doc.addEventListener("keydown", onDocKey, true);
    doc.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  }
  function unlisten() {
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerup", onUp, true);
    doc.removeEventListener("pointercancel", onCancel, true);
    doc.removeEventListener("keydown", onDocKey, true);
    doc.removeEventListener("touchmove", onTouchMove, true);
  }
  /** Glisser armé ou création : le navigateur ne doit plus défiler (touch-action n'est pas relu en cours de geste). */
  function onTouchMove(e: TouchEvent) { if ((drag || creating) && e.cancelable) e.preventDefault(); }

  // ---------- toucher : sélection, appui long ----------

  function applySelection() {
    for (const el of root.querySelectorAll<HTMLElement>(".wn-selected")) {
      if (el.dataset.key !== selectedKey || el.style.display === "none") { el.classList.remove("wn-selected"); el.removeAttribute("aria-selected"); }
    }
    const el = selectedKey === null ? undefined
      : [...root.querySelectorAll<HTMLElement>(`.wn-block[data-key="${selectedKey}"]`)].find((x) => x.style.display !== "none");
    if (!el) { for (const h of handles) h.remove(); return; }
    el.classList.add("wn-selected");
    el.setAttribute("aria-selected", "true");
    if (handles[0]!.parentNode !== el) el.append(...handles);
  }
  function select(key: string | null) {
    selectedKey = key;
    applySelection();
    observer?.disconnect();
    if (key === null) return;
    // Les nœuds sont recyclés au défilement : la sélection suit la clé, pas le nœud.
    const MO = doc.defaultView?.MutationObserver;
    if (MO) { observer ??= new MO(applySelection); observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["data-key"] }); }
  }

  function cancelPending() {
    if (!pending) return;
    clearTimer(pending.timer);
    pending = null;
    unlisten();
  }

  function arm(p: Pending) {
    pending = null;
    if (p.slot) {
      select(null);
      startCreate(p.pointerId, p.slot, true);
      vibrate();
      return;
    }
    const s = p.hit && session(p.hit);
    if (!p.hit || !s) { unlisten(); return; }
    select(p.hit.block.key);
    p.hit.el.classList.add("wn-armed");
    vibrate();
    drag = { ...s, kind: "move", pointerId: p.pointerId, x0: p.cx, y0: p.cy, cx: p.cx, cy: p.cy, sd0: host.scrollDay(), st0: root.scrollTop, started: false, wasSelected: false, el: p.hit.el, touch: true, copy: false };
    try { p.hit.el.setPointerCapture?.(p.pointerId); } catch { /* pointeur déjà relâché */ }
  }
  function vibrate() { try { navigator.vibrate?.(15); } catch { /* indisponible */ } }

  /** Zone des blocs visible (hors colonne des personnes et en-tête), repère de la fenêtre ; null sans mise en page. */
  function blocksRect(): { left: number; right: number; top: number; bottom: number } | null {
    const r = root.getBoundingClientRect();
    return r.width && r.height ? { left: r.left + GUTTER_PX, right: r.right, top: r.top + HEADER_PX, bottom: r.bottom } : null;
  }
  /** Point dans la zone des blocs ; sans mise en page (rectangle vide), tout point y est. */
  function inBlocks(x: number, y: number): boolean {
    const r = blocksRect();
    return !r || (x >= r.left && x < r.right && y >= r.top && y < r.bottom);
  }

  // Contacts tactiles posés, suivis sur tout le document (un deuxième doigt peut se poser hors de la grille) : dès le deuxième,
  // l'appui long en attente, la création ou le glisser au toucher est abandonné (pincement, défilement à deux doigts).
  const touches = new Set<number>();
  function onAnyDown(e: PointerEvent) {
    if (e.pointerType !== "touch") return;
    if (e.isPrimary === true) touches.clear(); // premier doigt d'une nouvelle séquence : oublie un contact perdu
    touches.add(e.pointerId);
    if (touches.size < 2) return;
    cancelPending();
    if (creating?.touch) endCreate(false);
    if (drag?.touch) { endDrag(); hideGhost(); }
  }
  function onAnyUp(e: PointerEvent) { if (e.pointerType === "touch") touches.delete(e.pointerId); }

  function onDownTouch(e: PointerEvent) {
    if (touches.size > 1) return;
    const hit = host.blockAt(e.target);
    if (kb) cancelKeyboard();
    const onHandle = !!(e.target as Element).closest?.("[data-handle]");
    if (hit && (onHandle || hit.block.key === selectedKey)) {
      const s = session(hit);
      if (s) beginDrag(e, hit, s);
      return;
    }
    // Pas de preventDefault : tant que l'appui long n'est pas armé, le doigt fait défiler la grille.
    const slot = !hit && o.onCreate ? freeSlotAt(e.target, e.clientX, e.clientY) : null;
    const p: Pending = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, cx: e.clientX, cy: e.clientY, hit, slot, timer: undefined };
    pending = p;
    if (hit || slot) p.timer = setTimer(() => { if (pending === p) arm(p); }, o.longPressMs ?? 400);
    listen();
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0 || drag || pending || creating || frozen || (o.enabled && !o.enabled())) return;
    if (e.pointerType === "touch") { onDownTouch(e); return; }
    const hit = host.blockAt(e.target);
    if (!hit) {
      if (o.onCreate && beginCreate(e)) select(null);
      return;
    }
    const s = session(hit);
    if (!s) return;
    if (kb) cancelKeyboard();
    e.preventDefault();
    hit.el.focus({ preventScroll: true });
    beginDrag(e, hit, s);
  }
  function beginDrag(e: PointerEvent, hit: Hit, s: Session) {
    const handle = (e.target as Element).closest?.("[data-handle]")?.getAttribute("data-handle");
    const kind = (handle && KINDS[handle]) || "move";
    const touch = e.pointerType === "touch";
    drag = {
      ...s, kind, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, cx: e.clientX, cy: e.clientY,
      sd0: host.scrollDay(), st0: root.scrollTop, started: false, wasSelected: selectedKey === hit.block.key, el: hit.el,
      touch, copy: kind === "move" && !touch && e.altKey && o.onCopy !== undefined,
    };
    try { hit.el.setPointerCapture?.(e.pointerId); } catch { /* pointeur déjà relâché */ }
    listen();
  }
  function onMove(e: PointerEvent) {
    if (creating && e.pointerId === creating.pointerId) {
      if (creating.touch && !inBlocks(e.clientX, e.clientY)) { endCreate(false); return; }
      const day = dayAt(clampX(e.clientX));
      if (day !== null && day !== creating.day) { creating.day = day; showDraft(creating); }
      return;
    }
    if (pending && e.pointerId === pending.pointerId) {
      pending.cx = e.clientX;
      pending.cy = e.clientY;
      if (Math.hypot(pending.cx - pending.x0, pending.cy - pending.y0) > SLOP_PX) cancelPending();
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    schedule();
  }
  function onUp(e: PointerEvent) {
    if (pending && e.pointerId === pending.pointerId) {
      // Tap : sélectionne le bloc touché, ou désélectionne s'il n'y en a pas.
      const hit = pending.hit;
      cancelPending();
      select(hit ? hit.block.key : null);
      hit?.el.focus({ preventScroll: true });
      return;
    }
    if (creating && e.pointerId === creating.pointerId) {
      const inside = inBlocks(e.clientX, e.clientY);
      const day = inside ? dayAt(e.clientX) : null;
      if (day !== null && day !== creating.day) { creating.day = day; showDraft(creating); }
      endCreate(inside);
      return;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    update(drag);
    const d = endDrag()!;
    if (d.started && d.copy) { hideGhost(); o.onCopy!({ allocation: d.alloc, key: d.key, draft: d.occ }); return; }
    if (d.started) { commit(d, "pointer"); return; }
    // Clic sans glisser (Q5) : sélectionne ; sur un bloc déjà sélectionné, ouvre la pop-in.
    select(d.key);
    if (d.wasSelected) open({ key: d.key, allocationId: d.alloc.id, el: d.el });
  }
  function onCancel() {
    if (creating) endCreate(false);
    if (pending) cancelPending();
    if (drag) { endDrag(); hideGhost(); }
  }
  function onDocKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !(drag || creating)) return;
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  }

  // ---------- clavier ----------

  function cancelKeyboard() {
    kb = null;
    hideGhost();
    o.onPreview?.(null);
  }

  function onKey(e: KeyboardEvent) {
    const hit = host.blockAt(e.target);
    if (!hit || e.target !== hit.el || drag || frozen) return;
    if (e.key === "Enter" && !kb && o.onOpen && !(o.enabled && !o.enabled())) {
      e.preventDefault();
      e.stopPropagation();
      select(hit.block.key);
      open({ key: hit.block.key, allocationId: hit.block.allocationId, el: hit.el });
      return;
    }
    if (e.key === "Escape" || e.key === "Enter") {
      if (!kb) return;
      e.preventDefault();
      e.stopPropagation();
      const s = kb;
      if (e.key === "Escape") { cancelKeyboard(); return; }
      kb = null;
      o.onPreview?.(null);
      commit(s, "keyboard");
      refocus(s.key);
      return;
    }
    if (o.enabled && !o.enabled()) return;
    const s = kb && kb.key === hit.block.key ? kb : session(hit);
    if (!s) return;
    const g = keyGesture(e, s.occ, host.data().people.map((p) => p.id));
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    kb = s;
    s.occ = step(s.occ, g);
    s.ser = s.ser && step(s.ser, g);
    showGhost(s);
    o.onPreview?.({ allocation: s.alloc, draft: s.occ });
  }

  /** Le bloc validé a pu changer de nœud (recyclage après le nouveau rendu) : on rend le focus à sa clé. */
  function refocus(key: string) {
    raf(() => raf(() => {
      const el = root.querySelector<HTMLElement>(`.wn-block[data-key="${key}"]`);
      const at = doc.activeElement;
      // Le focus parti ailleurs (choix de portée d'une série) n'est pas repris.
      if (el && at !== el && (at === doc.body || at === null || root.contains(at))) el.focus({ preventScroll: true });
    }));
  }

  function onFocusOut(e: FocusEvent) {
    if (kb && host.blockAt(e.target)?.block.key === kb.key) cancelKeyboard();
  }

  const handles = ["start", "end", "height"].map((h) => {
    const el = doc.createElement("div");
    el.className = `wn-handle wn-handle-${h}`;
    el.setAttribute("data-handle", h);
    el.setAttribute("aria-hidden", "true");
    return el;
  });
  function onOver(e: PointerEvent) {
    if (drag || e.pointerType === "touch" || (o.enabled && !o.enabled())) return;
    const hit = host.blockAt(e.target);
    if (hit && handles[0]!.parentNode !== hit.el) hit.el.append(...handles);
  }

  /** Pas de menu contextuel du navigateur pendant un appui long, un glisser ou une création au toucher. */
  function onContextMenu(e: Event) { if (pending || drag || creating) e.preventDefault(); }
  function onDblClick(e: MouseEvent) {
    const hit = host.blockAt(e.target);
    if (!hit || drag || frozen) return;
    select(hit.block.key);
    open({ key: hit.block.key, allocationId: hit.block.allocationId, el: hit.el });
  }
  doc.addEventListener("pointerdown", onAnyDown, true);
  doc.addEventListener("pointerup", onAnyUp, true);
  doc.addEventListener("pointercancel", onAnyUp, true);
  root.addEventListener("dblclick", onDblClick);
  root.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("keydown", onKey);
  root.addEventListener("focusout", onFocusOut);

  return {
    busy: () => drag !== null || pending !== null || kb !== null || creating !== null || frozen,
    clearDraft,
    select,
    destroy() {
      cancelPending();
      endDrag();
      creating = null;
      draftEl?.remove();
      doc.removeEventListener("pointerdown", onAnyDown, true);
      doc.removeEventListener("pointerup", onAnyUp, true);
      doc.removeEventListener("pointercancel", onAnyUp, true);
      root.removeEventListener("dblclick", onDblClick);
      observer?.disconnect();
      root.removeEventListener("contextmenu", onContextMenu);
      for (const h of handles) h.remove();
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("keydown", onKey);
      root.removeEventListener("focusout", onFocusOut);
      ghost?.remove();
    },
  };
}
