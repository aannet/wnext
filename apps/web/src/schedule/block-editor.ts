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
//    pointercancel (le navigateur reprend le défilement) abandonne proprement l'aperçu.
//  * Clavier, sur le bloc focalisé : équivalents du moteur (keyGesture), cumulés dans un brouillon ; Entrée valide, Échap
//    annule ; chaque pas est rendu à l'appelant pour l'annonce aria-live.
//  * Séries : le geste est appliqué à la série (applyGesture : toute la série suit) et à l'occurrence seule ; l'appelant
//    choisit la portée (BR-25). Le fantôme reste figé tant que la promesse rendue par onCommit n'est pas réglée.
//  * Positions : abscisse en jours absolus (invariante quand la piste s'allonge ou que la tranche change), ordonnée dans la
//    surface (défilement vertical compris).
import type { ScheduleResponse } from "@wnext/contracts";
import {
  applyGesture, dayNumber, expandOccurrences, keyGesture, pointerGesture, referenceHours, workDaysHoursOn, type BlockPatch, type Gesture, type GestureBlock,
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
}

export interface BlockEditor {
  /** Geste en cours (pointeur ou clavier) ou fantôme figé. */
  busy(): boolean;
  destroy(): void;
}

interface Session {
  key: string; alloc: Allocation; index: number | null; block: GridBlock; personId: string; anchorY: number;
  occ0: GestureBlock; ser0: GestureBlock | null; occ: GestureBlock; ser: GestureBlock | null;
}
interface Drag extends Session { kind: Gesture["kind"]; pointerId: number; x0: number; y0: number; sd0: number; st0: number; cx: number; cy: number; started: boolean }

const KINDS: Record<string, Gesture["kind"]> = { start: "resizeStart", end: "resizeEnd", height: "height" };
const THRESHOLD_PX = 3;
/** Mouvement toléré pendant l'appui long : au-delà, c'est un défilement. */
const SLOP_PX = 8;
type Hit = NonNullable<ReturnType<EditHost["blockAt"]>>;
interface Pending { pointerId: number; x0: number; y0: number; cx: number; cy: number; hit: Hit | null; timer: unknown }
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
    const g = pointerGesture(d.kind, dx, dy, { pxPerDay: ppd, rowHeightPx: ROW_UNIT_PX, refHours: referenceHours(person ? workDaysHoursOn(person, d.occ0.startDate) : []), mode: d.occ0.mode });
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
  /** Glisser armé : le navigateur ne doit plus défiler (touch-action n'est pas relu en cours de geste). */
  function onTouchMove(e: TouchEvent) { if (drag && e.cancelable) e.preventDefault(); }

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
    const s = p.hit && session(p.hit);
    if (!p.hit || !s) { unlisten(); return; }
    select(p.hit.block.key);
    p.hit.el.classList.add("wn-armed");
    try { navigator.vibrate?.(15); } catch { /* indisponible */ }
    drag = { ...s, kind: "move", pointerId: p.pointerId, x0: p.cx, y0: p.cy, cx: p.cx, cy: p.cy, sd0: host.scrollDay(), st0: root.scrollTop, started: false };
    try { p.hit.el.setPointerCapture?.(p.pointerId); } catch { /* pointeur déjà relâché */ }
  }

  function onDownTouch(e: PointerEvent) {
    const hit = host.blockAt(e.target);
    if (kb) cancelKeyboard();
    const onHandle = !!(e.target as Element).closest?.("[data-handle]");
    if (hit && (onHandle || hit.block.key === selectedKey)) {
      const s = session(hit);
      if (s) beginDrag(e, hit, s);
      return;
    }
    const p: Pending = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, cx: e.clientX, cy: e.clientY, hit, timer: undefined };
    pending = p;
    if (hit) p.timer = setTimer(() => { if (pending === p) arm(p); }, o.longPressMs ?? 400);
    listen();
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0 || drag || pending || frozen || (o.enabled && !o.enabled())) return;
    if (e.pointerType === "touch") { onDownTouch(e); return; }
    const hit = host.blockAt(e.target);
    if (!hit) return;
    const s = session(hit);
    if (!s) return;
    if (kb) cancelKeyboard();
    e.preventDefault();
    hit.el.focus({ preventScroll: true });
    beginDrag(e, hit, s);
  }
  function beginDrag(e: PointerEvent, hit: Hit, s: Session) {
    const handle = (e.target as Element).closest?.("[data-handle]")?.getAttribute("data-handle");
    drag = {
      ...s, kind: (handle && KINDS[handle]) || "move", pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, cx: e.clientX, cy: e.clientY,
      sd0: host.scrollDay(), st0: root.scrollTop, started: false,
    };
    try { hit.el.setPointerCapture?.(e.pointerId); } catch { /* pointeur déjà relâché */ }
    listen();
  }
  function onMove(e: PointerEvent) {
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
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.cx = e.clientX;
    drag.cy = e.clientY;
    update(drag);
    const d = endDrag()!;
    if (d.started) commit(d, "pointer");
  }
  function onCancel() {
    if (pending) cancelPending();
    if (drag) { endDrag(); hideGhost(); }
  }
  function onDocKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !drag) return;
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

  /** Pas de menu contextuel du navigateur pendant un appui long ou un glisser au toucher. */
  function onContextMenu(e: Event) { if (pending || drag) e.preventDefault(); }
  root.addEventListener("contextmenu", onContextMenu);
  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("keydown", onKey);
  root.addEventListener("focusout", onFocusOut);

  return {
    busy: () => drag !== null || pending !== null || kb !== null || frozen,
    destroy() {
      cancelPending();
      endDrag();
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
