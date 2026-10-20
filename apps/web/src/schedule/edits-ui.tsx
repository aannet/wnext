// Interface des écritures par gestes : choix de portée d'une série (BR-25), annonces aria-live (pas clavier, résultat,
// avertissements BR-01 / BR-37 non bloquants) et erreurs traduites (codes stables, ADR-003). Le geste lui-même vit hors
// React (block-editor) ; ce module ne reçoit que des demandes validées.
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import type { GestureBlock } from "@wnext/engine";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { localSplit, patched, type Allocation, type EditError, type EditOutcome, type ScheduleEditor } from "../data/allocation-edits";
import { Button, Modal, Popover, type Rect } from "../design";
import type { MessageKey } from "../i18n";
import type { EditRequest } from "./block-editor";
import { editWarnings, type EditWarning } from "./edit-warnings";

export interface ScheduleEdits {
  onCommit(r: EditRequest): void | Promise<void>;
  onPreview(p: { allocation: Allocation; draft: GestureBlock } | null): void;
  /** Annonce (aria-live) d'un résultat hors geste : annuler / rétablir. */
  announce(text: string): void;
  element: ReactNode;
}

const SHOWN = new Set<EditError>(["VERSION_CONFLICT", "NETWORK", "FORBIDDEN", "NOT_FOUND", "BUSY"]);
const errorKey = (e: EditError): MessageKey => (SHOWN.has(e) ? `schedule.edit.error.${e as "NETWORK"}` : "schedule.edit.error.other");

interface Choice { req: EditRequest; unsupported: string | null; done?(): void }

/**
 * Avertissements (BR-01, BR-37) d'une écriture, sur l'état tel qu'après elle. « Cette occurrence » : la découpe locale
 * (localSplit, celle de l'état optimiste) donne l'occurrence écrite, bornée à la fin de série, et le reste de la série
 * (avant / après) qui remplace l'allocation d'origine pour la surcharge. Découpe refusée : aucun avertissement (l'écriture
 * échouera aussi).
 */
export function writeWarnings(s: ScheduleResponse, req: EditRequest, kind: "one" | "all"): EditWarning[] {
  if (kind === "all" || req.occurrence === null) return editWarnings(s, patched(req.allocation, req.patch));
  const local = localSplit(req.allocation, req.occurrence, req.occurrencePatch ?? {}, (n) => `${req.allocation.id}:split-${n}`);
  if (!local.ok) return [];
  const { before, occurrence, after } = local.split;
  const rest = [before, after].filter((a): a is Allocation => a !== null);
  return editWarnings({ ...s, allocations: [...s.allocations.filter((a) => a.id !== req.allocation.id), ...rest] }, occurrence);
}

/** Bloc à refocaliser après une écriture, par sa personne et ses dates (sa clé peut changer : occurrence découpée). */
export type FocusTarget = Pick<GestureBlock, "personId" | "startDate" | "endDate">;

/** `undoable` : un historique d'annulation enregistre les écritures ; la découpe (non annulable) le précise alors. */
export function useScheduleEdits(
  i18n: I18n, editor: ScheduleEditor | undefined, data: ScheduleResponse, focusKey: (key: string, at?: FocusTarget) => void,
  undoable = false,
  /** Rectangle (repère de la fenêtre) du bloc de clé donnée, null s'il n'est pas dessiné : ancre du popover de portée. */
  anchorOf?: (key: string) => Rect | null,
): ScheduleEdits {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [notice, setNotice] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), [i18n.locale]);
  const nameOf = (id: string) => dataRef.current.people.find((p) => p.id === id)?.name ?? "";

  function describe(b: GestureBlock): string {
    const v = { person: nameOf(b.personId), start: fmt.format(new Date(`${b.startDate}T00:00:00Z`)), end: fmt.format(new Date(`${b.endDate}T00:00:00Z`)) };
    return b.mode === "hours" ? t("schedule.edit.preview.hours", { ...v, hours: b.hoursPerDay }) : t("schedule.edit.preview.percent", { ...v, percent: b.percent });
  }

  async function run(write: () => Promise<EditOutcome>, personId: string, warnings: EditWarning[], split = false): Promise<EditOutcome> {
    const out = await write();
    if (out.ok) {
      const person = nameOf(personId);
      const note = split && undoable ? [t("schedule.edit.split.notUndoable")] : [];
      setNotice([t("schedule.edit.saved"), ...note, ...warnings.map((w) => t(`schedule.edit.warning.${w}`, { person }))].join(" "));
    } else if (out.error !== "SERIES_SPLIT_UNSUPPORTED") {
      setNotice(t(errorKey(out.error)));
    }
    return out;
  }

  // Choix en cours, vidé de façon synchrone au premier clic : un double clic ou une répétition d'Entrée (avant le nouveau
  // rendu) ne lance pas une seconde écriture.
  const choiceRef = useRef<Choice | null>(null);
  const open = (c: Choice | null) => { choiceRef.current = c; setChoice(c); };

  async function choose(kind: "one" | "all" | "cancel") {
    const c = choiceRef.current;
    if (!c || !editor) return;
    open(null);
    c.done?.();
    const { req } = c;
    // Tout de suite (le bouton va disparaître) : le bloc d'origine, encore affiché. Différé, ce rappel passerait après
    // l'écriture et ramènerait le focus sur la grille (la clé de l'occurrence découpée n'existe plus).
    focusKey(req.key);
    if (kind === "cancel") { setNotice(t("schedule.edit.cancelled")); return; }
    const warnings = writeWarnings(dataRef.current, req, kind);
    const out = kind === "all"
      ? await run(() => editor.updateAllocation(req.allocationId, req.patch), req.draft.personId, warnings)
      : await run(() => editor.splitOccurrence(req.allocationId, req.occurrence!, req.occurrencePatch ?? {}), req.draft.personId, warnings, true);
    // Le nœud focalisé a pu être recyclé au nouveau rendu (et l'occurrence découpée change de clé) : on le retrouve par ses dates.
    if (out.ok) focusKey(req.key, req.draft);
    else if (kind === "one" && out.error === "SERIES_SPLIT_UNSUPPORTED") open({ req, unsupported: out.reason ?? "other" });
  }

  // Choix de portée : popover ancré au bloc édité s'il est dessiné (rectangle non vide), sinon fenêtre modale.
  const anchor = choice ? anchorOf?.(choice.req.key) ?? null : null;
  const question = choice ? (choice.unsupported === null ? t("schedule.edit.series.title") : t("schedule.edit.series.unsupported", { reason: choice.unsupported })) : "";
  const actions = choice && (
    <>
      {choice.unsupported === null && <Button variant="primary" autoFocus onClick={() => void choose("one")}>{t("schedule.edit.series.one")}</Button>}
      <Button variant={choice.unsupported === null ? "secondary" : "primary"} autoFocus={choice.unsupported !== null} onClick={() => void choose("all")}>{t("schedule.edit.series.all")}</Button>
      <Button onClick={() => void choose("cancel")}>{t("schedule.edit.series.cancel")}</Button>
    </>
  );
  const element = (
    <>
      {choice && anchor && (
        <Popover anchor={anchor} labelledBy="wn-series-title" onClose={() => void choose("cancel")}>
          <p id="wn-series-title" className="m-0 mb-3">{question}</p>
          <div className="flex flex-wrap justify-end gap-2">{actions}</div>
        </Popover>
      )}
      {choice && !anchor && (
        <Modal title={question} closeLabel={t("dialog.close")} onClose={() => void choose("cancel")} footer={actions}>{null}</Modal>
      )}
      <div className="wn-notice" aria-live="polite">{notice}</div>
    </>
  );

  return {
    element,
    announce: setNotice,
    onPreview: (p) => { if (p) setNotice(describe(p.draft)); },
    onCommit(r) {
      if (!editor) return;
      if (r.occurrence === null) { void run(() => editor.updateAllocation(r.allocationId, r.patch), r.draft.personId, writeWarnings(dataRef.current, r, "all")); return; }
      return new Promise<void>((done) => open({ req: r, unsupported: null, done }));
    },
  };
}
