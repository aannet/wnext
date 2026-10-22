// Éditeur du créneau (RT-011, RT-013 à RT-018) dans un drawer latéral, en création comme en édition (RT-024, Q8) : voile,
// piège du focus, Fermer (×), Échap et clic sur le voile comme tous les drawers (RT-023). Formulaire modifié (allocation,
// couleur en cours ou congé) : fermer demande « Abandonner les modifications ? » (Q7). Titré, à deux onglets.
//  * « Projet / tâche » (par défaut) : personnes (création : une ou plusieurs, groupe BR-26 ; édition : une, déplacement
//    vers une autre ligne par PATCH personId), projet et tâche par Combobox avec recherche dans le référentiel (projets
//    autorisés, BR-33), couleur du projet (RT-018, droits d'écriture du projet), dates, heures par jour ou pourcentage,
//    tentatif / confirmé, note. Surcharge signalée (BR-01), jamais bloquante. Enregistrement par l'éditeur de l'écran
//    (If-Match, annulable par Ctrl+Z) ; création enregistrée dans l'historique ; refus : code stable traduit, pop-in ouverte.
//  * « Congé » : le parcours congé existant (timeoff-ui : types, demi-journées, avertissement et assistant BR-04), prérempli
//    avec la personne et la plage du créneau. Ouvert directement (touche C, bouton, congé cliqué), la pop-in s'y place.
//  * Onglets APG : role tablist, flèches gauche / droite (activation automatique), Début / Fin. Pas d'onglets pour un congé
//    existant ni pendant l'avertissement BR-04.
//  * Portée (RT-042, PO-08) : une série s'ouvre sur l'occurrence cliquée (ses dates). À l'enregistrement, une étape du
//    drawer demande « Cette occurrence » (découpe BR-25, non annulable : annoncé) ou « Toute la série » (dates décalées
//    d'autant) ; une ligne de groupe (BR-26), « Cette ligne » ou « Tout le groupe » (PATCH de groupe, annulable ligne par
//    ligne ; indisponible, avec la raison, si la personne ou la charge change aussi). Rien qui dépende de la portée : pas
//    d'étape. Radio choisi focalisé à l'entrée ; Échap ou Retour revient au formulaire.
//  * Échap, clic sur le voile ou Annuler : rien n'est écrit ; l'appelant retire le bloc provisoire et rend le focus
//    (onClosed). Dans l'avertissement ou l'assistant BR-04, Échap revient d'une étape sans question.
//  * La couleur du projet (RT-018) est une écriture du projet, hors de l'historique d'annulation (Ctrl+Z) du Planning.
import type { I18n } from "@lingui/core";
import type { Me, ProjectDetail, ProjectTask, ScheduleResponse } from "@wnext/contracts";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { AllocationCreate } from "../api/client.gen";
import { patched, type Allocation, type ScheduleEditor } from "../data/allocation-edits";
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
  | "createAllocation" | "deleteAllocation" | "loggedTime"> & Partial<Pick<ScheduleSource, "listProjects" | "projectChanged" | "updateAllocationGroup">>
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
  /** Pop-in fermée, tout de suite : retirer le bloc provisoire. */
  onDraftDone(draft: number): void;
  /** Pop-in fermée, après son retrait du DOM : rendre le focus (bloc écrit, bloc d'origine ou grille). */
  onClosed(r: { key: string | null; focus: FocusTarget | null }): void;
}

type Tab = "allocation" | "timeoff";
/** Étape de portée (RT-042) : plan des écritures et choix courant. */
interface ScopeStep { plan: ScopePlan; value: SlotScope }
/**
 * `initial` : brouillon à l'ouverture, repère du formulaire modifié (Q7). `occ` : occurrence ouverte d'une série (null
 * sinon). `scope` : étape de portée affichée (null : formulaire).
 */
interface State {
  tab: Tab; draft: SlotDraft; initial: SlotDraft; key: string | null; draftId: number | null; error: string | null; tried: boolean; color: string | null;
  occ: SlotOccurrence | null; scope: ScopeStep | null;
}

export interface SlotEditor {
  /** `occurrence` : rang de l'occurrence d'une série (absent : celui de la clé `allocation:rang`). */
  openEdit(r: { key: string; allocationId: string; occurrence?: number | null }): void;
  openCreate(r: { personId: string | null; startDate: string; endDate: string; draft: number | null }): void;
  openTimeoffAt(personId: string, date: string): void;
  openTimeoffEdit(id: string): void;
  isOpen(): boolean;
  element: ReactNode;
}

const TABS: readonly Tab[] = ["allocation", "timeoff"];

/** Focus initial de l'étape de portée : le radio choisi (le drawer reste monté, son focus initial ne se rejoue pas). */
const focusChecked = (el: HTMLElement | null) => { el?.querySelector<HTMLElement>("[role=radio][aria-checked=true]")?.focus({ preventScroll: true }); };

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
  const finish = (focus: FocusTarget | null = null) => {
    const s = stateRef.current;
    stateRef.current = null;
    setState(null);
    timeoffs.reset();
    if (!s) return;
    if (s.draftId !== null) optsRef.current.onDraftDone(s.draftId);
    closed.current = { key: s.key, focus };
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
      const first = plan.options.find((x) => x.blocked === null);
      if (first) show({ ...s, scope: { plan, value: first.scope } });
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
      // Surcharge (BR-01, signalée) sur l'état d'avant l'écriture, à la portée écrite.
      const over = scope === "group"
        ? lines.filter((x) => editWarnings(state, patched(x, plan.patch)).includes("OVERLOAD")).map((x) => x.personId)
        : writeWarnings(state, { allocation: a, occurrence: s.occ?.index ?? null, patch: plan.patch, occurrencePatch: plan.occurrencePatch }, scope === "occurrence" ? "one" : "all")
          .includes("OVERLOAD") ? [plan.patch.personId ?? a.personId] : [];
      const warning = over.length ? [t("schedule.slot.overload", { people: over.map(nameOf).join(", "), count: over.length })] : [];
      const saved = scope === "occurrence" ? [t("schedule.slot.saved.occurrence"), ...(o.history ? [t("schedule.edit.split.notUndoable")] : [])]
        : scope === "group" ? [t("schedule.slot.saved.group", { count: lines.length })]
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
    if (!s?.scope) return;
    refocus.current = true;
    show({ ...s, scope: null });
  }
  useEffect(() => {
    if (!refocus.current || state?.scope !== null) return;
    refocus.current = false;
    document.querySelector<HTMLElement>(`button[form="${ids}-form"]`)?.focus({ preventScroll: true });
  }, [state?.scope]);

  function renderScope(s: State, step: ScopeStep): { body: ReactNode; footer: ReactNode } {
    const a = current!;
    const count = new Set(data.allocations.filter((x) => x.groupId !== null && x.groupId === a.groupId).map((x) => x.personId)).size;
    const legend = step.plan.options.some((x) => x.scope === "occurrence") ? t("schedule.edit.series.title") : t("schedule.slot.scope.group.title", { count });
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
      </fieldset>
    );
    const footer = (
      <>
        <Button onClick={back}>{t("schedule.slot.scope.back")}</Button>
        <Button variant="primary" onClick={() => void write(s, a, step.plan, step.value)}>{t("schedule.slot.scope.confirm")}</Button>
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
    const body = (
      <SlotForm i18n={i18n} formId={`${ids}-form`} draft={d} onChange={set} onSubmit={() => void submit()} current={current}
        people={data.people.map((p) => ({ id: p.id, name: p.name }))} projects={options}
        tasks={(d.projectId ? tasks[d.projectId] ?? [] : []).map((x) => ({ id: x.id, name: x.name }))}
        overloads={slotOverloads(data, d, current).map(nameOf)} issues={s.tried ? slotIssues(d, current) : []} error={s.error} color={color} />
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
    const alloc = state.tab !== "allocation" ? null : state.scope ? renderScope(state, state.scope) : renderAllocation(state);
    const title = off ? off.title : t(state.draft.allocationId === null ? "schedule.slot.title.create" : "schedule.slot.title.edit");
    const tabs = (state.tab === "allocation" && state.scope === null) || off?.creating === true;
    const content = off?.body ?? alloc?.body;
    const dirty = state.color !== null || JSON.stringify(state.draft) !== JSON.stringify(state.initial) || off?.dirty === true;
    element = (
      <Drawer title={title} closeLabel={t("dialog.close")} onClose={() => finish()} {...(off?.nested ? { onEscape: off.back } : state.scope ? { onEscape: back } : {})}
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
    ({ tab, draft, initial: draft, key, draftId, error: null, tried: false, color: null, occ, scope: null });
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
    isOpen: () => stateRef.current !== null,
    element,
  };
}
