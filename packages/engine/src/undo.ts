// Annulation de session (BR-40, ADR-001 §9-10, dossier §4.1 principe 8). Pur : le moteur calcule les opérations
// inverses, le client web les exécute contre l'API (avec If-Match) et rapporte les nouveaux ids.
//  * Pile locale de session, 50 actions par défaut (>= 20 exigées), la plus ancienne tombe. Une nouvelle action vide le redo.
//  * Actions inversibles : créer, modifier (avant/après), supprimer (instantané). Une action peut grouper plusieurs
//    opérations (report assisté, édition « tous » d'un groupe) et s'annule en bloc, dans l'ordre inverse.
//  * Une suppression annulée recrée l'entité sous un NOUVEL id : remapId réécrit les actions qui la référencent.
//  * Les cascades (retrait d'équipe BR-10, désactivation BR-31) n'entrent JAMAIS dans la pile : elles passent par
//    CascadeQueue (confirmation, puis 10 s « Annuler » avant toute écriture). Une fois exécutées, invalidateUndo retire
//    de la pile les actions qui touchent ce qu'elles ont supprimé.
export type Fields = Readonly<Record<string, unknown>>;

export type Op =
  | { kind: "create"; entity: string; id: string; after: Fields }
  | { kind: "update"; entity: string; id: string; before: Fields; after: Fields }
  | { kind: "delete"; entity: string; id: string; before: Fields };

export interface Action {
  /** Code de libellé (traduit par le client, ADR-003 : pas de chaîne UI ici), ex. "allocation.move". */
  label: string;
  ops: readonly Op[];
  /** Horodatage (ms) fourni par l'appelant. */
  at: number;
}

export interface UndoState {
  undo: readonly Action[];
  redo: readonly Action[];
  limit: number;
}

export const DEFAULT_UNDO_LIMIT = 50;

export const emptyUndo = (limit = DEFAULT_UNDO_LIMIT): UndoState => {
  if (limit < 20) throw new Error("UNDO_LIMIT_TOO_SMALL: la pile doit garder au moins 20 actions");
  return { undo: [], redo: [], limit };
};

/** Opération qui défait `op`. La recréation d'une suppression porte l'id d'origine : à remapper après exécution. */
export function invertOp(op: Op): Op {
  switch (op.kind) {
    case "create": return { kind: "delete", entity: op.entity, id: op.id, before: op.after };
    case "delete": return { kind: "create", entity: op.entity, id: op.id, after: op.before };
    case "update": return { kind: "update", entity: op.entity, id: op.id, before: op.after, after: op.before };
  }
}

const inverseAction = (a: Action): Action => ({ ...a, ops: [...a.ops].reverse().map(invertOp) });

/** Enregistre une action faite par l'utilisateur. Une action sans opération ou sans effet est ignorée. */
export function recordAction(s: UndoState, a: Action): UndoState {
  const ops = a.ops.filter((o) => o.kind !== "update" || Object.keys(o.after).some((k) => !Object.is(o.after[k], o.before[k])));
  if (ops.length === 0) return s;
  return { ...s, undo: [...s.undo, { ...a, ops }].slice(-s.limit), redo: [] };
}

export interface Step {
  state: UndoState;
  /** Opérations à exécuter, dans l'ordre. null si rien à faire. */
  ops: readonly Op[] | null;
  label: string | null;
}

/** Ctrl+Z : retire la dernière action et rend ses opérations inverses. */
export function undoStep(s: UndoState): Step {
  const a = s.undo.at(-1);
  if (!a) return { state: s, ops: null, label: null };
  return { state: { ...s, undo: s.undo.slice(0, -1), redo: [...s.redo, a] }, ops: inverseAction(a).ops, label: a.label };
}

/** Ctrl+Shift+Z : rejoue la dernière action annulée. */
export function redoStep(s: UndoState): Step {
  const a = s.redo.at(-1);
  if (!a) return { state: s, ops: null, label: null };
  return { state: { ...s, undo: [...s.undo, a], redo: s.redo.slice(0, -1) }, ops: a.ops, label: a.label };
}

/**
 * Échec d'exécution d'un undo/redo (409 VERSION_CONFLICT, 404 : quelqu'un d'autre a changé l'entité) : l'action est
 * abandonnée plutôt que remise dans une pile qui ne correspond plus au serveur. À appeler avec l'état rendu par undoStep/redoStep.
 */
export function dropFailedStep(s: UndoState, direction: "undo" | "redo"): UndoState {
  return direction === "undo" ? { ...s, redo: s.redo.slice(0, -1) } : { ...s, undo: s.undo.slice(0, -1) };
}

const mapAction = (a: Action, f: (o: Op) => Op): Action => ({ ...a, ops: a.ops.map(f) });

/** Une entité recréée (undo d'une suppression, redo d'une création) a reçu un nouvel id : réécrit les deux piles. */
export function remapId(s: UndoState, entity: string, oldId: string, newId: string): UndoState {
  const f = (o: Op): Op => (o.entity === entity && o.id === oldId ? { ...o, id: newId } : o);
  return { ...s, undo: s.undo.map((a) => mapAction(a, f)), redo: s.redo.map((a) => mapAction(a, f)) };
}

/** Retire les actions qui touchent des entités supprimées hors de la pile (cascade exécutée, suppression distante). */
export function invalidateUndo(s: UndoState, entity: string, ids: Iterable<string>): UndoState {
  const gone = new Set(ids);
  const keep = (a: Action) => !a.ops.some((o) => o.entity === entity && gone.has(o.id));
  return { ...s, undo: s.undo.filter(keep), redo: s.redo.filter(keep) };
}

/** Durée de vie : retire les actions plus vieilles que maxAgeMs. */
export function pruneUndo(s: UndoState, now: number, maxAgeMs: number): UndoState {
  const keep = (a: Action) => now - a.at <= maxAgeMs;
  return { ...s, undo: s.undo.filter(keep), redo: s.redo.filter(keep) };
}

// ---------- Exécution différée des cascades (ADR-001 §10) ----------

export const CASCADE_DELAY_MS = 10_000;

export interface Deferred<T> { key: string; payload: T; dueAt: number }

export interface CascadeQueue<T> { pending: readonly Deferred<T>[] }

export const emptyCascadeQueue = <T>(): CascadeQueue<T> => ({ pending: [] });

/** Programme une cascade confirmée ; aucune écriture avant dueAt. Reprogrammer la même clé repart de zéro. */
export function scheduleCascade<T>(q: CascadeQueue<T>, key: string, payload: T, now: number, delayMs = CASCADE_DELAY_MS): CascadeQueue<T> {
  return { pending: [...q.pending.filter((d) => d.key !== key), { key, payload, dueAt: now + delayMs }] };
}

/** « Annuler » du toast : retire la cascade si elle n'est pas encore échue. Rend aussi si l'annulation a pris effet. */
export function cancelCascade<T>(q: CascadeQueue<T>, key: string, now: number): { queue: CascadeQueue<T>; cancelled: boolean } {
  const d = q.pending.find((x) => x.key === key);
  if (!d || now >= d.dueAt) return { queue: q, cancelled: false };
  return { queue: { pending: q.pending.filter((x) => x.key !== key) }, cancelled: true };
}

/** Cascades échues à exécuter maintenant (par échéance), et la file restante. */
export function takeDueCascades<T>(q: CascadeQueue<T>, now: number): { due: Deferred<T>[]; queue: CascadeQueue<T> } {
  const due = q.pending.filter((d) => now >= d.dueAt).sort((a, b) => a.dueAt - b.dueAt);
  return { due, queue: { pending: q.pending.filter((d) => now < d.dueAt) } };
}
