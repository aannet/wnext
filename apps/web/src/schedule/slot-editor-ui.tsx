// Éditeur du créneau (RT-011, RT-013 à RT-018) dans un drawer latéral, en création comme en édition (RT-024, Q8) : voile,
// piège du focus, Fermer (×), Échap et clic sur le voile comme tous les drawers (RT-023). Formulaire modifié (allocation,
// couleur en cours ou congé) : fermer demande « Abandonner les modifications ? » (Q7). Titré, à deux onglets.
//  * « Projet / tâche » (par défaut) : personnes (création : une ou plusieurs, groupe BR-26 ; édition : une, déplacement
//    vers une autre ligne par PATCH personId), projet et tâche par Combobox avec recherche dans le référentiel (projets
//    autorisés, BR-33), couleur du projet (RT-018, droits d'écriture du projet), dates, heures par jour ou pourcentage,
//    tentatif / confirmé, note. Surcharge signalée (BR-01), jamais bloquante. Enregistrement par l'éditeur de l'écran
//    (If-Match, annulable par Ctrl+Z) ; création enregistrée dans l'historique ; refus : code stable traduit, pop-in ouverte.
//  * « Congé » : le parcours congé existant (timeoff-ui : types, demi-journées, avertissement et assistant BR-04), prérempli
//    avec la personne et la plage du créneau. Ouvert directement (touche C, bouton, congé cliqué), la pop-in s'y place. Un geste
//    sur un congé (RT-051, timeoffGesture) n'ouvre la pop-in que si l'avertissement BR-04 est à montrer.
//  * Onglets APG : role tablist, flèches gauche / droite (activation automatique), Début / Fin. Pas d'onglets pour un congé
//    existant ni pendant l'avertissement BR-04.
//  * Portée (RT-042, PO-08) : une série s'ouvre sur l'occurrence cliquée (ses dates). À l'enregistrement, une étape du
//    drawer demande « Cette occurrence » (découpe BR-25, non annulable : annoncé) ou « Toute la série » (dates décalées
//    d'autant, fin de série comprise ; série mensuelle : seulement depuis sa première occurrence) ; une ligne de groupe (BR-26), « Cette ligne » ou « Tout le groupe » (PATCH de groupe, annulable ligne par
//    ligne ; indisponible, avec la raison, si la personne ou la charge change aussi). Rien qui dépende de la portée : pas
//    d'étape. Radio choisi focalisé à l'entrée ; Échap ou Retour revient au formulaire.
//  * Commandes du bloc (RT-047), si l'allocation est modifiable (`canCommand`, BR-33) : groupe « Actions sur l'allocation »
//    sous le formulaire d'édition. « Supprimer » (danger) supprime tout de suite, ou passe par l'étape de portée (série :
//    occurrence ou série ; groupe : ligne ou groupe), confirmée par « Supprimer ». « Dupliquer… » ouvre la création préremplie
//    avec le formulaire tel qu'affiché (on peut cocher d'autres personnes : une allocation par personne, BR-26). « Scinder… »
//    (bloc non répété de 2 jours ou plus) ouvre l'étape de la date de début de la seconde partie (au milieu par défaut). Ces
//    deux étapes s'ouvrent aussi directement depuis la grille (Suppr, S, menu contextuel) : Annuler ferme alors le drawer,
//    au lieu de revenir au formulaire. Les commandes agissent sur l'allocation enregistrée, pas sur le formulaire en cours.
//  * Échap, clic sur le voile ou Annuler : rien n'est écrit ; l'appelant retire le bloc provisoire et rend le focus
//    (onClosed). Dans l'avertissement ou l'assistant BR-04, Échap revient d'une étape sans question.
//  * La couleur du projet (RT-018) est une écriture du projet, hors de l'historique d'annulation (Ctrl+Z) du Planning.
import type { I18n } from "@lingui/core";
import type { Me, ProjectDetail, ProjectTask, ScheduleResponse } from "@wnext/contracts";
import { addDays } from "@wnext/engine";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AllocationCreate } from "../api/client.gen";
import { patched, type Allocation, type GroupEditOutcome, type ScheduleEditor } from "../data/allocation-edits";
import type { ProjectsResult, ProjectPatchInput } from "../data/projects-source";
import { groupMembers } from "../data/record-edits";
import type { GroupOutcome, ScheduleSource } from "../data/schedule-source";
import { Button, Drawer, RadioGroup, RadioItem, Tabs, TabsContent, TabsList, TabsTrigger } from "../design";
import type { MessageKey } from "../i18n";
import { scheduleProjectOf } from "../projects/projects-model";
import { editWarnings } from "./edit-warnings";
import { writeWarnings, type FocusTarget } from "./edits-ui";
import type { History } from "./history";
import {
  defaultSplitDate, deleteAllocationScoped, deleteOptions, splitAllocationAt, splitBlocker, splitDateValid, type CommandDeps, type DeleteScope,
} from "./block-commands";
import {
  canWriteProject, createBody, createDraft, editDraft, occurrenceOf, projectOptions, scopePlan, slotErrorKey, slotIssues, slotOverloads,
  type ScopePlan, type SlotDraft, type SlotOccurrence, type SlotScope,
} from "./slot-model";
import { SlotForm } from "./slot-form";
import { useTimeoffEdits } from "./timeoff-ui";

/** Référentiel des projets (écran Projets) : projets avec chef de projet et version, tâches, couleur. */
export interface SlotCatalog {
  listProjects(): Promise<ProjectsResult<ProjectDetail[]>>;
  listTasks(projectId: string): Promise<ProjectsResult<ProjectTask[]>>;
  updateProject(project: ProjectDetail, patch: ProjectPatchInput): Promise<ProjectsResult<ProjectDetail>>;
}

export type SlotRecords = Pick<ScheduleSource, "getState" | "updateAllocation" | "splitOccurrence" | "createTimeoff" | "updateTimeoff" | "deleteTimeoff"
  | "createAllocation" | "deleteAllocation" | "loggedTime"> & Partial<Pick<ScheduleSource, "listProjects" | "projectChanged" | "updateAllocationGroup" | "deleteAllocationGroup" | "deleteOccurrence">>
  & { createAllocationGroup?(body: Parameters<ScheduleSource["createAllocationGroup"]>[0]): Promise<GroupOutcome> };

export interface SlotEditorOptions {
  i18n: I18n;
  data: ScheduleResponse;
  records?: SlotRecords | undefined;
  /** Éditeur des mises à jour (en principe l'éditeur enregistreur de l'historique). */
  editor?: ScheduleEditor | undefined;
  history?: History | undefined;
  catalog?: SlotCatalog | undefined;
  me?: (Pick<Me, "role" | "person"> & Partial<Pick<Me, "user">>) | undefined;
  announce(text: string): void;
  /** L'allocation accepte-t-elle les commandes (supprimer, dupliquer, scinder ; BR-33) ? Absent : oui, si `records` est fourni. */
  canCommand?(a: Allocation): boolean;
  /** Pop-in fermée, tout de suite : retirer le bloc provisoire. */
  onDraftDone(draft: number): void;
  /** Pop-in fermée, après son retrait du DOM : rendre le focus (bloc écrit, bloc d'origine ou grille). */
  onClosed(r: { key: string | null; focus: FocusTarget | null }): void;
}

type Tab = "allocation" | "timeoff";
/**
 * Étape de portée (RT-042) : plan des écritures et choix courant (null : aucun choix disponible, Confirmer désactivé). `action` :
 * enregistrer le formulaire ou supprimer (RT-047) ; `direct` : ouverte depuis la grille, Annuler ferme le drawer. `target` et
 * `groupSize` sont figés à l'ouverture : pendant l'écriture optimiste, l'allocation peut déjà avoir quitté (ou changé dans) le
 * magasin.
 */
interface ScopeStep { plan: ScopePlan; value: SlotScope | null; action: "save" | "delete"; direct: boolean; target: Allocation; groupSize: number }
/** Étape « Scinder » (RT-047) : début de la seconde partie ; `tried` : refus affiché ; `target` figée à l'ouverture. */
interface SplitStep { date: string; direct: boolean; tried: boolean; target: Allocation }
/**
 * `initial` : brouillon à l'ouverture, repère du formulaire modifié (Q7). `occ` : occurrence ouverte d'une série (null
 * sinon). `scope` : étape de portée affichée (null : formulaire).
 */
interface State {
  tab: Tab; draft: SlotDraft; initial: SlotDraft; key: string | null; draftId: number | null; error: string | null; tried: boolean; color: string | null;
  occ: SlotOccurrence | null; scope: ScopeStep | null; split: SplitStep | null;
}

export interface SlotEditor {
  /** `occurrence` : rang de l'occurrence d'une série (absent : celui de la clé `allocation:rang`). */
  openEdit(r: { key: string; allocationId: string; occurrence?: number | null }): void;
  openCreate(r: { personId: string | null; startDate: string; endDate: string; draft: number | null }): void;
  openTimeoffAt(personId: string, date: string): void;
  openTimeoffEdit(id: string): void;
  /** Geste sur un congé (RT-051) : écrit tout de suite, refusé, ou pop-in ouverte sur l'avertissement BR-04 ; réglé ensuite. */
  timeoffGesture(id: string, span: Pick<ScheduleResponse["timeoffs"][number], "startDate" | "endDate" | "startHalf" | "endHalf">): Promise<void>;
  /** Supprimer un congé depuis la grille (Suppr, menu), sans formulaire. */
  timeoffDelete(id: string): void;
  /** Supprimer depuis la grille (Suppr, menu) : tout de suite, ou étape de portée (série, groupe) dans le drawer. */
  requestDelete(r: { key: string; allocationId: string; occurrence?: number | null }): void;
  /** Scinder depuis la grille (S, menu) : étape de la date, ou annonce de l'impossibilité (série, bloc d'un jour). */
  requestSplit(r: { key: string; allocationId: string }): void;
  isOpen(): boolean;
  element: ReactNode;
}

const TABS: readonly Tab[] = ["allocation", "timeoff"];

/** Focus initial de l'étape de portée : le radio choisi (le drawer reste monté, son focus initial ne se rejoue pas). */
const focusChecked = (el: HTMLElement | null) => { el?.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus({ preventScroll: true }); };
/** Focus initial de l'étape « Scinder » : le champ de date (référence stable : appelée au montage seulement). */
const focusSelf = (el: HTMLElement | null) => { el?.focus({ preventScroll: true }); };
const firstOpen = (plan: ScopePlan) => plan.options.find((x) => x.blocked === null)?.scope ?? null;

export function useSlotEditor(o: SlotEditorOptions): SlotEditor {
  const { i18n, data, records } = o;
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [state, setState] = useState<State | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const busy = useRef(false);
  const ids = useId();
  const optsRef = useRef(o);
  optsRef.current = o;

  const closed = useRef<{ key: string | null; focus: FocusTarget | null } | null>(null);
  /** `gone` : le bloc d'origine n'existe plus (supprimé) : le focus va à la grille. */
  const finish = (focus: FocusTarget | null = null, gone = false) => {
    const s = stateRef.current;
    stateRef.current = null;
    setState(null);
    timeoffs.reset();
    if (!s) return;
    if (s.draftId !== null) optsRef.current.onDraftDone(s.draftId);
    closed.current = { key: gone ? null : s.key, focus };
  };
  useEffect(() => {
    const c = closed.current;
    if (state !== null || !c) return;
    closed.current = null;
    optsRef.current.onClosed(c);
  }, [state]);
  const timeoffs = useTimeoffEdits(
    i18n, records && { editor: records, data: () => records.getState().data ?? data, record: o.history?.record }, data,
    (text) => optsRef.current.announce(text), () => finish(),
  );

  // Référentiel : projets (détail : chef de projet, version) relus à chaque ouverture ; tâches par projet, en cache.
  const [projects, setProjects] = useState<ProjectDetail[] | null>(null);
  const [tasks, setTasks] = useState<Record<string, ProjectTask[]>>({});
  const [plain, setPlain] = useState<{ id: string; name: string }[] | null>(null);
  const open = state !== null;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    if (o.catalog) void o.catalog.listProjects().then((r) => { if (alive && r.ok) setProjects(r.value); });
    else if (records?.listProjects) void records.listProjects().then((l) => { if (alive) setPlain(l); }, () => {});
    return () => { alive = false; };
  }, [open]);
  const projectId = state?.draft.projectId ?? null;
  useEffect(() => {
    if (!projectId || !o.catalog || tasks[projectId]) return;
    void o.catalog.listTasks(projectId).then((r) => { if (r.ok) setTasks((m) => ({ ...m, [projectId]: r.value })); });
  }, [projectId]);

  const current: Allocation | undefined = state?.draft.allocationId ? data.allocations.find((a) => a.id === state.draft.allocationId) : undefined;
  const colorOf = (id: string) => data.projects.find((p) => p.id === id)?.color ?? projects?.find((p) => p.id === id)?.color ?? null;
  const options = useMemo(() => {
    if (projects) return projectOptions(projects, o.me, current?.projectId ?? null).map((p) => ({ ...p, color: colorOf(p.id) }));
    const byId = new Map((plain ?? []).map((p) => [p.id, p]));
    for (const p of data.projects) if (!byId.has(p.id)) byId.set(p.id, { id: p.id, name: p.name });
    return [...byId.values()].map((p) => ({ ...p, color: colorOf(p.id) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, plain, data.projects, current?.projectId, o.me]);

  const set = (patch: Partial<SlotDraft>) => setState((s) => s && { ...s, error: null, draft: { ...s.draft, ...patch } });
  const show = (s: State) => { stateRef.current = s; setState(s); };

  function selectTab(tab: Tab) {
    const s = stateRef.current;
    if (!s || s.tab === tab) return;
    if (tab === "timeoff") timeoffs.openCreate(s.draft.personIds[0] ?? data.people[0]?.id ?? "", s.draft.startDate, s.draft.endDate);
    else timeoffs.reset();
    show({ ...s, tab });
  }
  async function submit() {
    const s = stateRef.current;
    if (!s || !records || busy.current) return;
    const issues = slotIssues(s.draft, current);
    if (issues.length) { show({ ...s, tried: true }); return; }
    if (current) {
      const plan = scopePlan(current, s.occ, s.draft, writer().updateAllocationGroup !== undefined);
      if (plan.options.length > 0) show({ ...s, scope: scopeStep(plan, "save", false, current) });
      else if (Object.keys(plan.patch).length === 0) finish();
      else await write(s, current, plan, s.occ ? "series" : "line");
      return;
    }
    const overloads = slotOverloads(records.getState().data ?? data, s.draft, current);
    const warning = overloads.length ? [t("schedule.slot.overload", { people: overloads.map(nameOf).join(", "), count: overloads.length })] : [];
    busy.current = true;
    try {
      const req = createBody(s.draft);
      let created: { id: string; body: AllocationCreate }[];
      if (req.kind === "one") {
        const out = await records.createAllocation(req.body);
        if (!out.ok) { show({ ...s, error: t(slotErrorKey(out.error)) }); return; }
        created = [{ id: out.id, body: req.body }];
      } else {
        const out = records.createAllocationGroup ? await records.createAllocationGroup(req.body) : { ok: false as const, error: "UNSUPPORTED" as const };
        if (!out.ok) { show({ ...s, error: t(slotErrorKey(out.error)) }); return; }
        const bodies = groupMembers(req.body);
        created = out.ids.map((id, i) => ({ id, body: bodies[i]! }));
      }
      o.history?.record({ label: "allocation.create", ops: created.map((c) => ({ kind: "create" as const, entity: "allocations", id: c.id, after: { ...c.body } })) });
      optsRef.current.announce([t("schedule.slot.created", { count: created.length }), ...warning].join(" "));
      finish({ personId: s.draft.personIds[0]!, startDate: s.draft.startDate, endDate: s.draft.endDate });
    } finally {
      busy.current = false;
    }
  }

  const writer = () => (o.editor ?? records)!;

  /** Écriture d'une édition à la portée choisie ; refus : retour au formulaire avec le message traduit. */
  async function write(s: State, a: Allocation, plan: ScopePlan, scope: SlotScope) {
    if (busy.current || !records) return;
    busy.current = true;
    try {
      const w = writer();
      const state = records.getState().data ?? data;
      const lines = scope === "group" ? state.allocations.filter((x) => x.groupId === a.groupId) : [];
      const out = scope === "occurrence" ? await w.splitOccurrence(a.id, s.occ!.index, plan.occurrencePatch ?? {})
        : scope === "group" ? await w.updateAllocationGroup!(a.id, plan.patch)
        : await w.updateAllocation(a.id, plan.patch);
      if (!out.ok) { show({ ...s, scope: null, error: t(slotErrorKey(out.error)) }); return; }
      const written = scope === "group" ? out as Extract<GroupEditOutcome, { ok: true }> : null;
      // Surcharge (BR-01, signalée) sur l'état d'avant l'écriture, à la portée écrite.
      const over = scope === "group"
        ? lines.filter((x) => editWarnings(state, patched(x, plan.patch)).includes("OVERLOAD")).map((x) => x.personId)
        : writeWarnings(state, { allocation: a, occurrence: s.occ?.index ?? null, patch: plan.patch, occurrencePatch: plan.occurrencePatch }, scope === "occurrence" ? "one" : "all")
          .includes("OVERLOAD") ? [plan.patch.personId ?? a.personId] : [];
      const warning = over.length ? [t("schedule.slot.overload", { people: over.map(nameOf).join(", "), count: over.length })] : [];
      const saved = scope === "occurrence" ? [t("schedule.slot.saved.occurrence"), ...(o.history ? [t("schedule.edit.split.notUndoable")] : [])]
        : written ? [t(written.unknown.length > 0 && o.history ? "schedule.slot.saved.group.notUndoable" : "schedule.slot.saved.group", { count: written.before.length + written.unknown.length })]
        : [t("schedule.slot.saved")];
      optsRef.current.announce([...saved, ...warning].join(" "));
      finish({ personId: s.draft.personIds[0]!, startDate: s.draft.startDate, endDate: s.draft.endDate });
    } finally {
      busy.current = false;
    }
  }

  /** Retour de l'étape de portée au formulaire (Échap, Retour) : le focus va au bouton Enregistrer. */
  const refocus = useRef(false);
  function back() {
    const s = stateRef.current;
    if (!s?.scope && !s?.split) return;
    if (s.scope?.direct || s.split?.direct) { finish(); return; }
    refocus.current = true;
    show({ ...s, scope: null, split: null });
  }
  useEffect(() => {
    if (!refocus.current || state?.scope !== null || state?.split !== null) return;
    refocus.current = false;
    document.querySelector<HTMLElement>(`button[form="${ids}-form"]`)?.focus({ preventScroll: true });
  }, [state?.scope, state?.split]);

  // ---------- commandes du bloc (RT-047) ----------

  const commandDeps = (): CommandDeps => ({ records: records!, history: o.history });
  const scopeStep = (plan: ScopePlan, action: ScopeStep["action"], direct: boolean, target: Allocation): ScopeStep => ({
    plan, value: firstOpen(plan), action, direct, target,
    groupSize: new Set(data.allocations.filter((x) => x.groupId !== null && x.groupId === target.groupId).map((x) => x.personId)).size,
  });
  const commandable = (a: Allocation | undefined): a is Allocation => !!a && !!records && (o.canCommand ? o.canCommand(a) : true);
  const deleteScopes = (a: Allocation, occ: SlotOccurrence | null): ScopePlan =>
    ({ patch: {}, occurrencePatch: null, options: deleteOptions(a, occ?.index ?? null, records?.deleteAllocationGroup !== undefined) });

  /** Suppression à la portée choisie ; `s` absent : depuis la grille, sans drawer. Le bloc n'existe plus : focus à la grille. */
  async function runDelete(s: State | null, a: Allocation, occ: SlotOccurrence | null, scope: DeleteScope) {
    if (busy.current || !records) return;
    busy.current = true;
    try {
      const out = await deleteAllocationScoped(commandDeps(), a, occ?.index ?? null, scope);
      if (!out.ok) {
        if (s) show({ ...s, scope: null, error: t(slotErrorKey(out.error)) });
        else optsRef.current.announce(t(slotErrorKey(out.error)));
        return;
      }
      optsRef.current.announce(scope === "occurrence" ? t("schedule.delete.occurrence")
        : t(scope === "group" && o.history && !out.undoable ? "schedule.delete.notUndoable" : "schedule.delete.done", { count: out.count }));
      if (s) finish(null, true);
      else optsRef.current.onClosed({ key: null, focus: null });
    } finally {
      busy.current = false;
    }
  }

  /** « Supprimer » du formulaire : tout de suite, ou étape de portée. */
  function deleteFromForm(s: State, a: Allocation) {
    const plan = deleteScopes(a, s.occ);
    if (plan.options.length === 0) void runDelete(s, a, s.occ, "line");
    else show({ ...s, error: null, scope: scopeStep(plan, "delete", false, a) });
  }

  async function runSplit(s: State, a: Allocation, step: SplitStep) {
    if (busy.current || !records) return;
    if (!splitDateValid(a, step.date)) { show({ ...s, split: { ...step, tried: true } }); return; }
    busy.current = true;
    try {
      const out = await splitAllocationAt(commandDeps(), a, step.date);
      if (!out.ok && !out.partial) { show({ ...s, error: t(slotErrorKey(out.error)) }); return; }
      optsRef.current.announce(out.ok ? t("schedule.split.done") : [t(slotErrorKey(out.error)), t("schedule.split.partial")].join(" "));
      finish({ personId: a.personId, startDate: a.startDate, endDate: addDays(step.date, -1) });
    } finally {
      busy.current = false;
    }
  }

  const day = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }), [i18n.locale]);
  const fmt = (d: string) => day.format(new Date(`${d}T00:00:00Z`));

  function renderSplit(s: State, step: SplitStep): { body: ReactNode; footer: ReactNode } {
    const a = step.target;
    const valid = splitDateValid(a, step.date);
    const body = (
      <form id={`${ids}-split`} className="wn-slot-form" noValidate onSubmit={(e) => { e.preventDefault(); void runSplit(s, a, step); }}>
        <label>{t("schedule.split.date")}
          <input ref={focusSelf} type="date" required min={addDays(a.startDate, 1)} max={a.endDate} value={step.date}
            onChange={(e) => setState((x) => x?.split ? { ...x, error: null, split: { ...x.split, date: e.target.value } } : x)} />
        </label>
        {valid && <p data-split-parts="" className="wn-slot-wide">{t("schedule.split.parts", { a: fmt(a.startDate), b: fmt(addDays(step.date, -1)), c: fmt(step.date), d: fmt(a.endDate) })}</p>}
        {step.tried && !valid && <p role="alert" className="wn-slot-wide wn-dialog-error">{t("schedule.split.issue")}</p>}
        {s.error && <p role="alert" className="wn-slot-wide wn-dialog-error">{s.error}</p>}
      </form>
    );
    const footer = (
      <>
        <Button onClick={back}>{t(step.direct ? "schedule.slot.cancel" : "schedule.slot.scope.back")}</Button>
        <Button type="submit" form={`${ids}-split`} variant="primary">{t("schedule.split.confirm")}</Button>
      </>
    );
    return { body, footer };
  }

  function renderScope(s: State, step: ScopeStep): { body: ReactNode; footer: ReactNode } {
    const a = step.target;
    const count = step.groupSize;
    const removing = step.action === "delete";
    const legend = step.plan.options.some((x) => x.scope === "occurrence")
      ? t(removing ? "schedule.delete.series.title" : "schedule.edit.series.title")
      : t(removing ? "schedule.delete.group.title" : "schedule.slot.scope.group.title", { count });
    const body = (
      <fieldset className="wn-choice">
        <legend id={`${ids}-scope`}>{legend}</legend>
        <RadioGroup ref={focusChecked} aria-labelledby={`${ids}-scope`} value={step.value} className="flex flex-col gap-(--space-2)"
          onValueChange={(v) => setState((x) => x?.scope ? { ...x, scope: { ...x.scope, value: v as SlotScope } } : x)}>
          {step.plan.options.map((x) => (
            <div key={x.scope}>
              <label className="inline-flex items-center gap-2">
                <RadioItem value={x.scope} disabled={x.blocked !== null} {...(x.blocked ? { "aria-describedby": `${ids}-why-${x.scope}` } : {})} />
                {t(`schedule.slot.scope.${x.scope}`)}
              </label>
              {x.blocked && <p id={`${ids}-why-${x.scope}`} className="wn-muted m-0 ml-6">{t(`schedule.slot.scope.blocked.${x.blocked}`)}</p>}
            </div>
          ))}
        </RadioGroup>
        {step.value === null && <p role="status" className="m-0 mt-2">{t("schedule.slot.scope.none")}</p>}
      </fieldset>
    );
    const footer = (
      <>
        <Button onClick={back}>{t(step.direct ? "schedule.slot.cancel" : "schedule.slot.scope.back")}</Button>
        <Button variant={removing ? "danger" : "primary"} disabled={step.value === null} onClick={() => {
          if (!step.value) return;
          if (removing) void runDelete(s, a, s.occ, step.value);
          else void write(s, a, step.plan, step.value);
        }}>{t(removing ? "schedule.delete.confirm" : "schedule.slot.scope.confirm")}</Button>
      </>
    );
    return { body, footer };
  }

  async function applyColor() {
    const s = stateRef.current;
    const detail = projects?.find((p) => p.id === s?.draft.projectId);
    if (!s || !s.color || !detail || !o.catalog || busy.current) return;
    busy.current = true;
    try {
      const r = await o.catalog.updateProject(detail, { color: s.color.trim().toUpperCase() });
      if (!r.ok) { show({ ...s, error: t(slotErrorKey(r.error.code)) }); return; }
      setProjects((list) => list && list.map((p) => (p.id === r.value.id ? r.value : p)));
      records?.projectChanged?.(scheduleProjectOf(r.value));
      show({ ...s, color: null });
      optsRef.current.announce(t("schedule.slot.color.saved", { project: r.value.name }));
    } finally {
      busy.current = false;
    }
  }

  const nameOf = (id: string) => data.people.find((p) => p.id === id)?.name ?? "";

  function renderAllocation(s: State): { body: ReactNode; footer: ReactNode } {
    const d = s.draft;
    const detail = projects?.find((p) => p.id === d.projectId);
    const color = o.catalog && detail && canWriteProject(o.me, detail) ? {
      value: s.color,
      onToggle: () => show({ ...s, color: s.color === null ? detail.color : null }),
      onChange: (hex: string) => setState((x) => x && { ...x, color: hex }),
      onApply: () => void applyColor(),
    } : undefined;
    const a = current;
    const body = (
      <>
        <SlotForm i18n={i18n} formId={`${ids}-form`} draft={d} onChange={set} onSubmit={() => void submit()} current={current}
          people={data.people.map((p) => ({ id: p.id, name: p.name }))} projects={options}
          tasks={(d.projectId ? tasks[d.projectId] ?? [] : []).map((x) => ({ id: x.id, name: x.name }))}
          overloads={slotOverloads(data, d, current).map(nameOf)} issues={s.tried ? slotIssues(d, current) : []} error={s.error} color={color} />
        {commandable(a) && (
          <div role="group" aria-label={t("schedule.slot.actions")} className="wn-slot-actions">
            <Button onClick={() => show(base({ ...d, allocationId: null }, "allocation", s.key, null))}>{t("schedule.slot.duplicate")}</Button>
            {splitBlocker(a) === null && <Button onClick={() => show({ ...s, error: null, split: { date: defaultSplitDate(a), direct: false, tried: false, target: a } })}>{t("schedule.slot.split")}</Button>}
            <Button variant="danger" onClick={() => deleteFromForm(s, a)}>{t("schedule.slot.delete")}</Button>
          </div>
        )}
      </>
    );
    const footer = (
      <>
        <Button onClick={() => finish()}>{t("schedule.slot.cancel")}</Button>
        <Button type="submit" form={`${ids}-form`} variant="primary">{t(d.allocationId === null ? "schedule.slot.create" : "schedule.slot.save")}</Button>
      </>
    );
    return { body, footer };
  }

  let element: ReactNode = null;
  if (state) {
    const off = state.tab === "timeoff" ? timeoffs.view : null;
    const alloc = state.tab !== "allocation" ? null : state.scope ? renderScope(state, state.scope) : state.split ? renderSplit(state, state.split) : renderAllocation(state);
    const title = off ? off.title : state.scope?.action === "delete" ? t("schedule.delete.title") : state.split ? t("schedule.split.title")
      : t(state.draft.allocationId === null ? "schedule.slot.title.create" : "schedule.slot.title.edit");
    const tabs = (state.tab === "allocation" && state.scope === null && state.split === null) || off?.creating === true;
    const content = off?.body ?? alloc?.body;
    const dirty = state.color !== null || JSON.stringify(state.draft) !== JSON.stringify(state.initial) || off?.dirty === true;
    element = (
      <Drawer title={title} closeLabel={t("dialog.close")} onClose={() => finish()} {...(off?.nested ? { onEscape: off.back } : state.scope || state.split ? { onEscape: back } : {})}
        unsaved={{ dirty, title: t("dialog.discard.title"), keep: t("dialog.discard.keep"), discard: t("dialog.discard.discard") }}
        className="wn-slot wn-timeoff-dialog" footer={off?.footer ?? alloc?.footer} {...(off?.describedBy ? { describedBy: off.describedBy } : {})}>
        {tabs ? (
          <Tabs value={state.tab} onValueChange={(v) => selectTab(v as Tab)}>
            <TabsList aria-label={t("schedule.slot.tabs.label")} className="mb-(--space-2) border-b border-solid border-border">
              {TABS.map((tab) => <TabsTrigger key={tab} value={tab}>{t(`schedule.slot.tab.${tab}`)}</TabsTrigger>)}
            </TabsList>
            <TabsContent value={state.tab}>{content}</TabsContent>
          </Tabs>
        ) : content}
      </Drawer>
    );
  }

  const base = (draft: SlotDraft, tab: Tab, key: string | null, draftId: number | null, occ: SlotOccurrence | null = null): State =>
    ({ tab, draft, initial: draft, key, draftId, error: null, tried: false, color: null, occ, scope: null, split: null });
  return {
    openEdit(r) {
      const a = records && data.allocations.find((x) => x.id === r.allocationId);
      if (!a || stateRef.current?.key === r.key) return;
      timeoffs.reset();
      const index = a.repeatState === "none" ? null : r.occurrence ?? Number(r.key.split(":")[1] ?? 0);
      const occ = index === null ? null : occurrenceOf(a, index);
      show(base(editDraft(a, occ), "allocation", r.key, null, occ));
    },
    openCreate(r) {
      if (!records) { if (r.draft !== null) optsRef.current.onDraftDone(r.draft); return; }
      timeoffs.reset();
      show(base(createDraft(r.personId, r.startDate, r.endDate), "allocation", null, r.draft));
    },
    openTimeoffAt(personId, date) {
      if (!records) return;
      const prev = stateRef.current;
      show(base(createDraft(personId, date, date), "timeoff", null, prev?.draftId ?? null));
      timeoffs.openAt(personId, date);
    },
    openTimeoffEdit(id) {
      const x = records && data.timeoffs.find((y) => y.id === id);
      if (!x) return;
      show(base(createDraft(x.personId, x.startDate, x.endDate), "timeoff", null, stateRef.current?.draftId ?? null));
      timeoffs.openEdit(id);
    },
    async timeoffGesture(id, span) {
      const x = records && (records.getState().data ?? data).timeoffs.find((y) => y.id === id);
      if (!x || stateRef.current) return;
      const out = await timeoffs.gesture(id, span);
      if (out === "warn") show(base(createDraft(x.personId, span.startDate, span.endDate), "timeoff", null, null));
    },
    timeoffDelete(id) {
      if (records && !stateRef.current) void timeoffs.removeNow(id);
    },
    requestDelete(r) {
      const a = records && data.allocations.find((x) => x.id === r.allocationId);
      if (!commandable(a) || busy.current) return;
      const index = a.repeatState === "none" ? null : r.occurrence ?? Number(r.key.split(":")[1] ?? 0);
      const occ = index === null ? null : occurrenceOf(a, index);
      const plan = deleteScopes(a, occ);
      if (plan.options.length === 0) { void runDelete(null, a, occ, "line"); return; }
      timeoffs.reset();
      show({ ...base(editDraft(a, occ), "allocation", r.key, null, occ), scope: scopeStep(plan, "delete", true, a) });
    },
    requestSplit(r) {
      const a = records && data.allocations.find((x) => x.id === r.allocationId);
      if (!commandable(a)) return;
      const why = splitBlocker(a);
      if (why) { optsRef.current.announce(t("schedule.split.unavailable", { reason: why })); return; }
      timeoffs.reset();
      show({ ...base(editDraft(a), "allocation", r.key, null), split: { date: defaultSplitDate(a), direct: true, tried: false, target: a } });
    },
    isOpen: () => stateRef.current !== null,
    element,
  };
}
