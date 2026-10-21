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
//  * Échap, clic sur le voile ou Annuler : rien n'est écrit ; l'appelant retire le bloc provisoire et rend le focus
//    (onClosed). Dans l'avertissement ou l'assistant BR-04, Échap revient d'une étape sans question.
import type { I18n } from "@lingui/core";
import type { Me, ProjectDetail, ProjectTask, ScheduleResponse } from "@wnext/contracts";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AllocationCreate } from "../api/client.gen";
import type { Allocation, ScheduleEditor } from "../data/allocation-edits";
import type { ProjectsResult, ProjectPatchInput } from "../data/projects-source";
import { groupMembers } from "../data/record-edits";
import type { GroupOutcome, ScheduleSource } from "../data/schedule-source";
import { Button, Drawer } from "../design";
import type { MessageKey } from "../i18n";
import { scheduleProjectOf } from "../projects/projects-model";
import type { FocusTarget } from "./edits-ui";
import type { History } from "./history";
import { canWriteProject, createBody, createDraft, editDraft, editPatch, projectOptions, slotErrorKey, slotIssues, slotOverloads, type SlotDraft } from "./slot-model";
import { SlotForm } from "./slot-form";
import { useTimeoffEdits } from "./timeoff-ui";

/** Référentiel des projets (écran Projets) : projets avec chef de projet et version, tâches, couleur. */
export interface SlotCatalog {
  listProjects(): Promise<ProjectsResult<ProjectDetail[]>>;
  listTasks(projectId: string): Promise<ProjectsResult<ProjectTask[]>>;
  updateProject(project: ProjectDetail, patch: ProjectPatchInput): Promise<ProjectsResult<ProjectDetail>>;
}

export type SlotRecords = Pick<ScheduleSource, "getState" | "updateAllocation" | "splitOccurrence" | "createTimeoff" | "updateTimeoff" | "deleteTimeoff"
  | "createAllocation" | "deleteAllocation" | "loggedTime"> & Partial<Pick<ScheduleSource, "listProjects" | "projectChanged">>
  & { createAllocationGroup?(body: Parameters<ScheduleSource["createAllocationGroup"]>[0]): Promise<GroupOutcome> };

export interface SlotEditorOptions {
  i18n: I18n;
  data: ScheduleResponse;
  records?: SlotRecords | undefined;
  /** Éditeur des mises à jour (en principe l'éditeur enregistreur de l'historique). */
  editor?: ScheduleEditor | undefined;
  history?: History | undefined;
  catalog?: SlotCatalog | undefined;
  me?: Pick<Me, "role" | "person"> | undefined;
  announce(text: string): void;
  /** Pop-in fermée, tout de suite : retirer le bloc provisoire. */
  onDraftDone(draft: number): void;
  /** Pop-in fermée, après son retrait du DOM : rendre le focus (bloc écrit, bloc d'origine ou grille). */
  onClosed(r: { key: string | null; focus: FocusTarget | null }): void;
}

type Tab = "allocation" | "timeoff";
/** `initial` : brouillon à l'ouverture, repère du formulaire modifié (Q7). */
interface State { tab: Tab; draft: SlotDraft; initial: SlotDraft; key: string | null; draftId: number | null; error: string | null; tried: boolean; color: string | null }

export interface SlotEditor {
  openEdit(r: { key: string; allocationId: string }): void;
  openCreate(r: { personId: string | null; startDate: string; endDate: string; draft: number | null }): void;
  openTimeoffAt(personId: string, date: string): void;
  openTimeoffEdit(id: string): void;
  isOpen(): boolean;
  element: ReactNode;
}

const TABS: readonly Tab[] = ["allocation", "timeoff"];

export function useSlotEditor(o: SlotEditorOptions): SlotEditor {
  const { i18n, data, records } = o;
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const [state, setState] = useState<State | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const busy = useRef(false);
  const ids = useId();
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
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
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(state!.tab);
    const next = e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length]
      : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : undefined;
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  async function submit() {
    const s = stateRef.current;
    if (!s || !records || busy.current) return;
    const issues = slotIssues(s.draft, current);
    if (issues.length) { show({ ...s, tried: true }); return; }
    const overloads = slotOverloads(records.getState().data ?? data, s.draft, current);
    const warning = overloads.length ? [t("schedule.slot.overload", { people: overloads.map(nameOf).join(", "), count: overloads.length })] : [];
    busy.current = true;
    try {
      if (current) {
        const patch = editPatch(current, s.draft);
        if (Object.keys(patch).length === 0) { finish(); return; }
        const out = await (o.editor ?? records).updateAllocation(current.id, patch);
        if (!out.ok) { show({ ...s, error: t(slotErrorKey(out.error)) }); return; }
        optsRef.current.announce([t("schedule.slot.saved"), ...warning].join(" "));
        finish({ personId: s.draft.personIds[0]!, startDate: s.draft.startDate, endDate: s.draft.endDate });
        return;
      }
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
    const alloc = state.tab === "allocation" ? renderAllocation(state) : null;
    const title = off ? off.title : t(state.draft.allocationId === null ? "schedule.slot.title.create" : "schedule.slot.title.edit");
    const tabs = state.tab === "allocation" || off?.creating === true;
    const panel = `${ids}-panel`;
    const content = off?.body ?? alloc?.body;
    const dirty = state.color !== null || JSON.stringify(state.draft) !== JSON.stringify(state.initial) || off?.dirty === true;
    element = (
      <Drawer title={title} closeLabel={t("dialog.close")} onClose={() => finish()} {...(off?.nested ? { onEscape: off.back } : {})}
        unsaved={{ dirty, title: t("dialog.discard.title"), keep: t("dialog.discard.keep"), discard: t("dialog.discard.discard") }}
        className="wn-slot wn-timeoff-dialog" footer={off?.footer ?? alloc?.footer} {...(off?.describedBy ? { describedBy: off.describedBy } : {})}>
        {tabs && (
          <div role="tablist" aria-label={t("schedule.slot.tabs.label")} className="wn-tabs" onKeyDown={onTabKey}>
            {TABS.map((tab) => (
              <button key={tab} ref={(el) => { tabRefs.current[tab] = el; }} type="button" role="tab" id={`${ids}-tab-${tab}`}
                aria-selected={state.tab === tab} aria-controls={state.tab === tab ? panel : undefined} tabIndex={state.tab === tab ? 0 : -1}
                onClick={() => selectTab(tab)}>
                {t(`schedule.slot.tab.${tab}`)}
              </button>
            ))}
          </div>
        )}
        {tabs ? <div role="tabpanel" id={panel} aria-labelledby={`${ids}-tab-${state.tab}`}>{content}</div> : content}
      </Drawer>
    );
  }

  const base = (draft: SlotDraft, tab: Tab, key: string | null, draftId: number | null): State =>
    ({ tab, draft, initial: draft, key, draftId, error: null, tried: false, color: null });
  return {
    openEdit(r) {
      const a = records && data.allocations.find((x) => x.id === r.allocationId);
      if (!a || stateRef.current?.key === r.key) return;
      timeoffs.reset();
      show(base(editDraft(a), "allocation", r.key, null));
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
