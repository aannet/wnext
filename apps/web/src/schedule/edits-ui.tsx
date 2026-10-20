// Interface des écritures par gestes : choix de portée d'une série (BR-25), annonces aria-live (pas clavier, résultat,
// avertissements BR-01 / BR-37 non bloquants) et erreurs traduites (codes stables, ADR-003). Le geste lui-même vit hors
// React (block-editor) ; ce module ne reçoit que des demandes validées.
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import type { GestureBlock } from "@wnext/engine";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { patched, type Allocation, type EditError, type EditOutcome, type ScheduleEditor } from "../data/allocation-edits";
import type { MessageKey } from "../i18n";
import type { EditRequest } from "./block-editor";
import { editWarnings } from "./edit-warnings";

export interface ScheduleEdits {
  onCommit(r: EditRequest): void | Promise<void>;
  onPreview(p: { allocation: Allocation; draft: GestureBlock } | null): void;
  element: ReactNode;
}

const SHOWN = new Set<EditError>(["VERSION_CONFLICT", "NETWORK", "FORBIDDEN", "NOT_FOUND", "BUSY"]);
const errorKey = (e: EditError): MessageKey => (SHOWN.has(e) ? `schedule.edit.error.${e as "NETWORK"}` : "schedule.edit.error.other");

interface Choice { req: EditRequest; unsupported: string | null; done?(): void }

/** Allocation isolée telle qu'après le geste sur une occurrence. */
const occurrenceAfter = (r: EditRequest): Allocation => patched({ ...r.allocation, repeatState: "none", repeatEndDate: null }, {
  personId: r.draft.personId, startDate: r.draft.startDate, endDate: r.draft.endDate, hoursPerDay: r.draft.hoursPerDay, percent: r.draft.percent,
});

/** Bloc à refocaliser après une écriture, par sa personne et ses dates (sa clé peut changer : occurrence découpée). */
export type FocusTarget = Pick<GestureBlock, "personId" | "startDate" | "endDate">;

export function useScheduleEdits(
  i18n: I18n, editor: ScheduleEditor | undefined, data: ScheduleResponse, focusKey: (key: string, at?: FocusTarget) => void,
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

  async function run(write: () => Promise<EditOutcome>, after: Allocation): Promise<EditOutcome> {
    const warnings = editWarnings(dataRef.current, after);
    const out = await write();
    if (out.ok) {
      const person = nameOf(after.personId);
      setNotice([t("schedule.edit.saved"), ...warnings.map((w) => t(`schedule.edit.warning.${w}`, { person }))].join(" "));
    } else if (out.error !== "SERIES_SPLIT_UNSUPPORTED") {
      setNotice(t(errorKey(out.error)));
    }
    return out;
  }

  async function choose(kind: "one" | "all" | "cancel") {
    const c = choice;
    if (!c || !editor) return;
    setChoice(null);
    c.done?.();
    const { req } = c;
    // Tout de suite (le bouton va disparaître) : le bloc d'origine, encore affiché. Différé, ce rappel passerait après
    // l'écriture et ramènerait le focus sur la grille (la clé de l'occurrence découpée n'existe plus).
    focusKey(req.key);
    if (kind === "cancel") { setNotice(t("schedule.edit.cancelled")); return; }
    const out = kind === "all"
      ? await run(() => editor.updateAllocation(req.allocationId, req.patch), patched(req.allocation, req.patch))
      : await run(() => editor.splitOccurrence(req.allocationId, req.occurrence!, req.occurrencePatch ?? {}), occurrenceAfter(req));
    // Le nœud focalisé a pu être recyclé au nouveau rendu (et l'occurrence découpée change de clé) : on le retrouve par ses dates.
    if (out.ok) focusKey(req.key, req.draft);
    else if (kind === "one" && out.error === "SERIES_SPLIT_UNSUPPORTED") setChoice({ req, unsupported: out.reason ?? "other" });
  }

  const element = (
    <>
      {choice && (
        <div role="dialog" aria-modal="true" aria-labelledby="wn-series-title" className="wn-dialog"
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void choose("cancel"); } }}>
          <p id="wn-series-title">
            {choice.unsupported === null ? t("schedule.edit.series.title") : t("schedule.edit.series.unsupported", { reason: choice.unsupported })}
          </p>
          <div className="wn-dialog-actions">
            {choice.unsupported === null && <button type="button" autoFocus onClick={() => void choose("one")}>{t("schedule.edit.series.one")}</button>}
            <button type="button" autoFocus={choice.unsupported !== null} onClick={() => void choose("all")}>{t("schedule.edit.series.all")}</button>
            <button type="button" onClick={() => void choose("cancel")}>{t("schedule.edit.series.cancel")}</button>
          </div>
        </div>
      )}
      <div className="wn-notice" aria-live="polite">{notice}</div>
    </>
  );

  return {
    element,
    onPreview: (p) => { if (p) setNotice(describe(p.draft)); },
    onCommit(r) {
      if (!editor) return;
      if (r.occurrence === null) { void run(() => editor.updateAllocation(r.allocationId, r.patch), patched(r.allocation, r.patch)); return; }
      return new Promise<void>((done) => setChoice({ req: r, unsupported: null, done }));
    },
  };
}
