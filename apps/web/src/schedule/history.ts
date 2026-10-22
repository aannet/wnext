// Historique d'annulation de l'écran (BR-40, ADR-001 §9) : enveloppe la pile pure du moteur (UndoState) autour de
// l'éditeur des gestes. Sans framework, testable seul.
//  * `editor` : l'éditeur à donner à l'écran. Chaque écriture réussie (déplacement, redimensionnement, charge) y devient
//    une Action « mise à jour » avec les champs d'avant et d'après ; un échec n'est pas enregistré.
//  * Undo / redo rejouent l'opération inverse par l'éditeur d'origine (même chemin optimiste + PATCH) : l'éditeur lit la
//    version courante du magasin au moment du rejeu, jamais une version capturée à l'enregistrement. Ils ne s'enregistrent
//    pas eux-mêmes. Lancés coup sur coup, ils s'exécutent l'un après l'autre.
//  * Échec du rejeu : VERSION_CONFLICT, NOT_FOUND (quelqu'un d'autre a changé l'entité) et tout refus définitif
//    abandonnent l'action (dropFailedStep) ; NETWORK et BUSY (passagers) la laissent dans sa pile pour réessayer.
//  * Découpe d'une occurrence (BR-25) : NON annulable. La défaire demanderait trois écritures non atomiques (PATCH de la
//    ligne d'origine, suppression de l'occurrence et de la suite, recréation sous un nouvel id et hors groupe pour
//    l'occurrence 0) : un échec au milieu laisserait la série dans un état qu'aucune action ne décrit. Sans endpoint
//    « fusion » côté API, la découpe n'entre pas dans la pile, et les actions antérieures sur la série en sont retirées
//    (elles décriraient une ligne que la découpe a changée). L'écran l'annonce.
//  * « Tout le groupe » (BR-26, RT-042) : une action, une opération « mise à jour » par ligne du groupe (champs d'avant de
//    chacune, lus avant l'écriture par `readGroup`). Le rejeu repasse ligne par ligne par updateAllocation (If-Match de chaque
//    ligne) : pas d'endpoint de groupe « champs d'avant par ligne », et les lignes peuvent différer (projet, dates). Non
//    atomique : un conflit sur une ligne abandonne l'action, les lignes déjà rejouées le restent (comme toute action à
//    plusieurs opérations). Seules les lignes chargées dans le magasin sont connues (un groupe partage ses dates).
//  * `record(action)` : actions arbitraires (créations, suppressions du lot E). Les opérations autres qu'une mise à jour
//    d'allocation passent par `execute` ; une recréation rend son nouvel id, remappé dans la pile (remapId).
//  * `invalidate(entity, ids)` : changement venu d'ailleurs (écho temps réel d'une autre source) : seules les actions qui
//    touchent ces entités sont retirées.
import {
  emptyUndo, dropFailedStep, invalidateUndo, recordAction, redoStep, remapId, undoStep,
  type Action, type Op, type UndoState,
} from "@wnext/engine";
import { patched, type Allocation, type AllocationEdit, type AllocationGroupEdit, type EditError, type EditOutcome, type ScheduleEditor } from "../data/allocation-edits";
import type { ScheduleSource } from "../data/schedule-source";
import { executeRecordOp } from "./timeoff-flow";

export type ExecOutcome = { ok: true; id?: string } | { ok: false; error: EditError; reason?: string };

export interface HistoryOptions {
  /** Éditeur d'origine (source branchée sur l'API ou démo) : enregistrement des gestes et rejeu des mises à jour. */
  editor: ScheduleEditor;
  /** État courant d'une allocation dans le magasin (champs d'avant d'une écriture). */
  read(id: string): Allocation | undefined;
  /** Lignes d'un groupe (BR-26) dans le magasin ; absent : pas d'annulation des écritures de groupe. */
  readGroup?(groupId: string): Allocation[];
  /** Opérations hors mise à jour d'allocation (lot E) ; absent : UNSUPPORTED. */
  execute?(op: Op): Promise<ExecOutcome>;
  now?(): number;
  limit?: number;
}

export type HistoryDirection = "undo" | "redo";
export type HistoryResult =
  | { ok: true; direction: HistoryDirection; label: string }
  | { ok: false; direction: HistoryDirection; label: string; error: EditError; dropped: boolean };

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** Code de libellé de la prochaine action à annuler / rétablir (traduit par l'écran). */
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface History {
  editor: ScheduleEditor;
  record(a: Omit<Action, "at"> & { at?: number }): void;
  undo(): Promise<HistoryResult | null>;
  redo(): Promise<HistoryResult | null>;
  invalidate(entity: string, ids: Iterable<string>): void;
  getState(): HistoryState;
  subscribe(listener: () => void): () => void;
}

const ALLOCATIONS = "allocations";
const TRANSIENT = new Set<EditError>(["NETWORK", "BUSY"]);

/** Code de libellé d'une écriture : édition (pop-in : projet, tâche, statut, note, mode), charge, déplacement (personne, ou dates décalées d'autant) ou redimensionnement. */
export function labelOf(patch: AllocationEdit, before: Allocation): string {
  if (EDIT_ONLY.some((k) => patch[k] !== undefined && patch[k] !== before[k])) return "allocation.edit";
  if (patch.hoursPerDay != null || patch.percent != null) return "allocation.load";
  if (patch.personId !== undefined) return "allocation.move";
  const span = (s: string, e: string) => Date.parse(e) - Date.parse(s);
  if (patch.startDate !== undefined && patch.endDate !== undefined && span(patch.startDate, patch.endDate) === span(before.startDate, before.endDate)) {
    return "allocation.move";
  }
  return "allocation.resize";
}

const EDIT_ONLY = ["projectId", "phaseId", "taskId", "status", "notes", "mode"] as const;
const FIELDS = ["personId", "startDate", "endDate", "hoursPerDay", "percent", "repeatEndDate", ...EDIT_ONLY] as const;

/**
 * Champs d'avant et d'après d'une écriture, limités à ceux qu'elle change. Un changement de mode emporte les deux quantités
 * (l'inverse rend le mode et sa quantité d'origine) ; un changement de projet, la phase et la tâche remises à zéro.
 */
function updateOp(before: Allocation, patch: AllocationEdit): Op {
  const next = patched(before, patch);
  const changed = FIELDS.filter((k) => next[k] !== before[k]);
  if (changed.includes("mode")) for (const k of ["hoursPerDay", "percent"] as const) if (!changed.includes(k)) changed.push(k);
  const pick = (a: Allocation) => Object.fromEntries(changed.map((k) => [k, a[k]]));
  return { kind: "update", entity: ALLOCATIONS, id: before.id, before: pick(before), after: pick(next) };
}

export function createHistory(opts: HistoryOptions): History {
  const now = opts.now ?? Date.now;
  const listeners = new Set<() => void>();
  let undo: UndoState = emptyUndo(opts.limit);
  let view: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };

  function set(next: UndoState) {
    if (next === undo) return;
    undo = next;
    view = {
      canUndo: undo.undo.length > 0, canRedo: undo.redo.length > 0,
      undoLabel: undo.undo.at(-1)?.label ?? null, redoLabel: undo.redo.at(-1)?.label ?? null,
    };
    for (const l of listeners) l();
  }

  const record: History["record"] = (a) => set(recordAction(undo, { label: a.label, ops: a.ops, at: a.at ?? now() }));

  async function run(op: Op): Promise<ExecOutcome> {
    if (op.kind === "update" && op.entity === ALLOCATIONS) return opts.editor.updateAllocation(op.id, op.after as AllocationEdit);
    return opts.execute ? opts.execute(op) : { ok: false, error: "UNSUPPORTED" };
  }

  async function step(direction: HistoryDirection): Promise<HistoryResult | null> {
    const s = direction === "undo" ? undoStep(undo) : redoStep(undo);
    if (!s.ops) return null;
    const label = s.label!;
    set(s.state);
    // L'action déplacée est au sommet de la pile opposée ; pendant le rejeu, une écriture ou une invalidation a pu l'en
    // retirer : on ne touche alors à rien.
    let moved = (direction === "undo" ? s.state.redo : s.state.undo).at(-1)!;
    const top = () => (direction === "undo" ? undo.redo : undo.undo).at(-1);
    for (const [i, op] of s.ops.entries()) {
      const out = await run(op);
      if (!out.ok) {
        // Passager et rien d'écrit : l'action reprend sa place. Sinon la pile ne décrit plus le serveur : abandon.
        const keep = i === 0 && TRANSIENT.has(out.error);
        if (top() === moved) {
          const rest = (direction === "undo" ? undo.redo : undo.undo).slice(0, -1);
          if (!keep) set(dropFailedStep(undo, direction));
          else set(direction === "undo" ? { ...undo, redo: rest, undo: [...undo.undo, moved] } : { ...undo, undo: rest, redo: [...undo.redo, moved] });
        }
        return { ok: false, direction, label, error: out.error, dropped: !keep };
      }
      if (op.kind === "create" && out.id !== undefined && out.id !== op.id) {
        const wasTop = top() === moved;
        set(remapId(undo, op.entity, op.id, out.id));
        if (wasTop) moved = top()!;
      }
    }
    return { ok: true, direction, label };
  }

  // Un undo / redo à la fois, dans l'ordre des demandes.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (direction: HistoryDirection) => {
    const p = queue.then(() => step(direction));
    queue = p.catch(() => {});
    return p;
  };

  const editor: ScheduleEditor = {
    async updateAllocation(id, patch) {
      const before = opts.read(id);
      const out: EditOutcome = await opts.editor.updateAllocation(id, patch);
      if (out.ok && before) record({ label: labelOf(patch, before), ops: [updateOp(before, patch)] });
      return out;
    },
    async splitOccurrence(id, index, patch) {
      const out = await opts.editor.splitOccurrence(id, index, patch);
      if (out.ok) set(invalidateUndo(undo, ALLOCATIONS, [id]));
      return out;
    },
    // Absent si l'éditeur d'origine n'écrit pas de groupe : la pop-in ne propose alors pas « tout le groupe ».
    ...(opts.editor.updateAllocationGroup && {
      async updateAllocationGroup(id: string, patch: AllocationGroupEdit) {
        const head = opts.read(id);
        const lines = head?.groupId ? opts.readGroup?.(head.groupId) ?? [] : [];
        const out = await opts.editor.updateAllocationGroup!(id, patch);
        if (out.ok && head) record({ label: labelOf(patch, head), ops: lines.map((a) => updateOp(a, patch)) });
        return out;
      },
    }),
  };

  return {
    editor,
    record,
    undo: () => enqueue("undo"),
    redo: () => enqueue("redo"),
    invalidate: (entity, ids) => set(invalidateUndo(undo, entity, ids)),
    getState: () => view,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/**
 * Historique branché sur une source : lit l'état courant de son magasin (snapshot de la plage chargée) ; les opérations hors
 * mise à jour d'allocation (congés, allocations créées ou supprimées par le report assisté BR-04) passent par ses écritures. `connect` abonne
 * l'historique aux changements étrangers de la source (invalidation ciblée) et rend le désabonnement (effet React).
 */
export function historyForSource(source: ScheduleSource, opts: Omit<HistoryOptions, "editor" | "read"> = {}): { history: History; connect(): () => void } {
  const history = createHistory({
    execute: executeRecordOp(source), ...opts, editor: source, read: (id) => source.getState().data?.allocations.find((a) => a.id === id),
    readGroup: (groupId) => source.getState().data?.allocations.filter((a) => a.groupId === groupId) ?? [],
  });
  return { history, connect: () => source.onForeignChange((kind, ids) => history.invalidate(kind, ids)) };
}
