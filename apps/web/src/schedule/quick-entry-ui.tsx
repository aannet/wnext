// Barre de saisie rapide de l'écran Schedule (ADR-002 §5) : une phrase (« Refonte 6h lun-mer », « ? Audit 50 % jusqu'au 28 »)
// devient une allocation. L'analyse est celle du moteur (parseQuickEntry, codes stables) ; ici, l'aperçu, les messages
// traduits et la création.
//  * Focus par « / » ou « N » (écran), Échap pour sortir. La personne n'est pas dans la grammaire du moteur : sélecteur
//    obligatoire, prérempli avec la personne du bloc focalisé.
//  * Projet ambigu : liste déroulante (combobox ARIA, flèches haut / bas, Entrée choisit, Échap la ferme).
//  * Entrée valide : création optimiste (createAllocation, retour arrière si refus), enregistrée dans l'historique
//    (annulable par Ctrl+Z), annoncée ; refus : message traduit dans la barre et annonce.
//  * Sans quantité : 8 h par jour (défaut du moteur), signalé.
import type { I18n } from "@lingui/core";
import type { ScheduleResponse } from "@wnext/contracts";
import { parseQuickEntry, type QuickDraft, type QuickLocale } from "@wnext/engine";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AllocationCreate } from "../api/client.gen";
import type { EditError } from "../data/allocation-edits";
import type { CreateOutcome } from "../data/record-edits";
import type { MessageKey } from "../i18n";
import type { History } from "./history";

export interface QuickEntryHandle { focus(personId?: string): void }

export interface QuickEntryProps {
  i18n: I18n;
  data: ScheduleResponse;
  today: string;
  createAllocation(body: AllocationCreate): Promise<CreateOutcome>;
  /** Tous les projets du compte (candidats de la saisie) ; absent ou en échec : ceux de la fenêtre affichée. */
  listProjects?(): Promise<{ id: string; name: string }[]>;
  /** Liste des projets changée (temps réel) : on la relit. */
  onProjectsChange?(listener: () => void): () => void;
  record?: History["record"];
  announce(text: string): void;
  /** Sortie de la barre (Échap, création réussie) : rend le focus à la grille. */
  onExit(): void;
}

/** Corps de création d'un brouillon complet, ou null s'il manque quelque chose. */
export function allocationBodyOf(d: QuickDraft, personId: string): AllocationCreate | null {
  if (!personId || !d.projectId || !d.startDate || !d.endDate || d.invalid.length > 0) return null;
  const load = d.mode === "hours" && d.hoursPerDay !== null ? { mode: "hours" as const, hoursPerDay: d.hoursPerDay }
    : d.mode === "percentage" && d.percent !== null ? { mode: "percentage" as const, percent: d.percent } : null;
  if (!load) return null;
  return { personId, projectId: d.projectId, startDate: d.startDate, endDate: d.endDate, status: d.tentative ? "tentative" : "confirmed", load };
}

const SHOWN = new Set<EditError>(["NETWORK", "FORBIDDEN"]);

export const QuickEntry = forwardRef<QuickEntryHandle, QuickEntryProps>(function QuickEntry(
  { i18n, data, today, createAllocation, listProjects, onProjectsChange, record, announce, onExit }, ref,
) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [text, setText] = useState("");
  const [personId, setPersonId] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [listOpen, setListOpen] = useState(true);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const locale: QuickLocale = i18n.locale === "en" ? "en" : "fr";
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), [i18n.locale]);
  const date = (d: string) => fmt.format(new Date(`${d}T00:00:00Z`));

  useImperativeHandle(ref, () => ({
    focus(id) { if (id) setPersonId(id); inputRef.current?.focus(); inputRef.current?.select(); },
  }), []);

  const [allProjects, setAllProjects] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    if (!listProjects) return;
    let alive = true;
    const load = () => { listProjects().then((l) => { if (alive) setAllProjects(l); }, () => {}); };
    load();
    const off = onProjectsChange?.(load);
    return () => { alive = false; off?.(); };
  }, [listProjects, onProjectsChange]);
  const projects = useMemo(() => {
    const byId = new Map((allProjects ?? []).map((p) => [p.id, p]));
    for (const p of data.projects) if (!byId.has(p.id)) byId.set(p.id, { id: p.id, name: p.name });
    return [...byId.values()];
  }, [allProjects, data.projects]);
  const raw = useMemo(
    () => parseQuickEntry(text, { today, locale, projects }),
    [text, today, locale, projects],
  );
  const draft: QuickDraft = chosen && !raw.projectId ? { ...raw, projectId: chosen, candidates: [], missing: raw.missing.filter((m) => m !== "project") } : raw;
  const missing: MessageKey[] = [
    ...draft.missing.map((m) => `schedule.quick.missing.${m}` as MessageKey),
    ...(personId ? [] : (["schedule.quick.missing.person"] as MessageKey[])),
  ];
  const body = allocationBodyOf(draft, personId);
  const showList = draft.projectId === null && draft.candidates.length > 1 && listOpen;
  const optionId = (i: number) => `wn-quick-opt-${i}`;
  const projectName = projects.find((p) => p.id === draft.projectId)?.name ?? "";
  const personName = data.people.find((p) => p.id === personId)?.name ?? "";

  const change = (v: string) => { setText(v); setChosen(null); setActive(0); setListOpen(true); setError(""); };

  async function submit() {
    if (!body || busy.current) return;
    busy.current = true;
    try {
      const out = await createAllocation(body);
      if (out.ok) {
        record?.({ label: "allocation.create", ops: [{ kind: "create", entity: "allocations", id: out.id, after: { ...body } }] });
        setText(""); setChosen(null); setError("");
        announce(t("schedule.quick.created"));
        onExit();
      } else {
        const msg = t(SHOWN.has(out.error) ? (`schedule.quick.error.${out.error as "NETWORK"}`) : "schedule.quick.error.other");
        setError(msg);
        announce(msg);
      }
    } finally {
      busy.current = false;
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (showList) setListOpen(false); else onExit();
    } else if (showList && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = draft.candidates.length;
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      e.preventDefault();
      if (showList) setChosen(draft.candidates[active]?.id ?? null);
      else void submit();
    }
  };

  return (
    <div className="wn-quick" role="group" aria-label={t("schedule.quick.label")} onKeyDown={onKeyDown}>
      <label>
        <span>{t("schedule.quick.person")}</span>
        <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">{t("schedule.quick.person.none")}</option>
          {data.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <div className="wn-quick-field">
        <input ref={inputRef} type="text" role="combobox" aria-label={t("schedule.quick.input")} placeholder={t("schedule.quick.placeholder")}
          aria-autocomplete="list" aria-expanded={showList} aria-controls="wn-quick-list" aria-describedby="wn-quick-preview"
          aria-activedescendant={showList ? optionId(active) : undefined} aria-keyshortcuts="/ N" autoComplete="off"
          value={text} onChange={(e) => change(e.target.value)} />
        {showList && (
          <ul id="wn-quick-list" role="listbox" aria-label={t("schedule.quick.candidates")} className="wn-quick-list">
            {draft.candidates.map((c, i) => (
              <li key={c.id} id={optionId(i)} role="option" aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); setChosen(c.id); inputRef.current?.focus(); }}>{c.name}</li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" disabled={!body} onClick={() => void submit()}>{t("schedule.quick.submit")}</button>
      <div id="wn-quick-preview" className="wn-quick-preview">
        {body && draft.startDate && draft.endDate && (
          <span>{draft.mode === "hours"
            ? t("schedule.quick.preview.hours", { project: projectName, person: personName, start: date(draft.startDate), end: date(draft.endDate), hours: draft.hoursPerDay, tentative: draft.tentative ? "yes" : "no" })
            : t("schedule.quick.preview.percent", { project: projectName, person: personName, start: date(draft.startDate), end: date(draft.endDate), percent: draft.percent, tentative: draft.tentative ? "yes" : "no" })}</span>
        )}
        {draft.amountDefaulted && <span> {t("schedule.quick.defaulted", { hours: draft.hoursPerDay })}</span>}
        {text.trim() !== "" && missing.map((m) => <span key={m}> {t(m)}</span>)}
        {draft.invalid.map((c) => <span key={c}> {t(`schedule.quick.invalid.${c}`)}</span>)}
      </div>
      {error && <div role="alert" className="wn-quick-error">{error}</div>}
    </div>
  );
});
