// Fiche d'une personne, dans le Drawer commun : propriétés (nom, type, équipe, rôle, pays), horaire hebdomadaire (7 valeurs, début de
// semaine du compte), modification datée « à partir du » (BR-19), historique des horaires en lecture (GET /people/{id}/history),
// désactivation avec récapitulatif (BR-31) et réactivation. Verrou optimiste : If-Match = version lue, 409 VERSION_CONFLICT proposé
// en rechargement ; un horaire qui toucherait des temps verrouillés est refusé (PERSON_HISTORY_LOCKED) avec le dernier jour verrouillé.
// Lecture seule pour member et guest : champs désactivés, aucune action d'écriture.
import type { I18n } from "@lingui/core";
import { useEffect, useMemo, useState } from "react";
import type { Department, PeopleSource, Person, Role } from "../data/people-source";
import { Button, Drawer } from "../design";
import type { MessageKey } from "../i18n";
import { DeactivateDialog } from "./deactivate-dialog";
import { diffOf, errorOf, valuesOf, weekdayName, weekOrder, weeklySummary, type PersonValues } from "./people-model";
import { PersonForm } from "./person-form";
import { useLoad } from "../projects/use-load";

export interface PersonPanelProps {
  i18n: I18n;
  source: PeopleSource;
  person: Person;
  people: readonly Person[];
  departments: readonly Department[];
  roles: readonly Role[];
  weekStart: number;
  today: string;
  canEdit: boolean;
  onUpdated(person: Person): void;
  onClose(): void;
}

export function PersonPanel(p: PersonPanelProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => p.i18n._(k, v);
  const { person, source } = p;
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [draft, setDraft] = useState<PersonValues | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState("");
  const [deactivating, setDeactivating] = useState(false);
  const history = useLoad(() => source.history(person.id), `history:${person.id}:${person.version}`);
  const fmt = useMemo(() => new Intl.DateTimeFormat(p.i18n.locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), [p.i18n.locale]);
  const day = (iso: string) => fmt.format(new Date(`${iso}T00:00:00Z`));

  useEffect(() => { setError(null); setConflict(false); setDraft(null); setNotice(""); }, [person.id]);

  async function save(v: PersonValues, effectiveFrom: string | undefined) {
    const { patch, historized } = diffOf(person, v);
    setBusy(true); setError(null); setConflict(false); setNotice("");
    try {
      const r = await source.updatePerson(person, { ...patch, ...(historized && effectiveFrom ? { effectiveFrom } : {}) });
      if (r.ok) { p.onUpdated(r.value); setDraft(null); setFormKey((n) => n + 1); setNotice(t("people.panel.saved")); return; }
      setDraft(v); setFormKey((n) => n + 1); // le formulaire garde la saisie au nouvel essai
      if (r.error.code === "VERSION_CONFLICT") setConflict(true);
      else { const m = errorOf(r.error, day); setError(t(m.key, m.values)); }
    } finally {
      setBusy(false);
    }
  }
  async function reactivate() {
    setBusy(true); setError(null); setNotice("");
    const r = await source.updatePerson(person, { active: true });
    setBusy(false);
    if (r.ok) { p.onUpdated(r.value); setNotice(t("people.panel.reactivated")); } else { const m = errorOf(r.error, day); setError(t(m.key, m.values)); }
  }
  async function reloadAfterConflict() {
    const fresh = await source.reloadPerson(person.id);
    setConflict(false);
    if (fresh) { p.onUpdated(fresh); setDraft(null); setFormKey((n) => n + 1); } else p.onClose();
  }

  const periods = history.state.status === "ready" ? history.state.data.filter((h) => h.attribute === "workDaysHours") : [];
  return (
    <Drawer title={person.name} closeLabel={t("dialog.close")} onClose={p.onClose} busy={busy} className="wn-person-panel"
      unsaved={{ dirty, title: t("dialog.discard.title"), keep: t("dialog.discard.keep"), discard: t("dialog.discard.discard") }}>
      {!p.canEdit && <p className="wn-muted">{t("people.panel.readonly")}</p>}
      {!person.active && <p className="wn-muted">{t("people.panel.inactive")}</p>}
      <p role="status" className={notice ? "wn-panel-notice" : "wn-visually-hidden"}>{notice}</p>
      {conflict && (
        <div role="alert" className="wn-error">
          <p>{t("people.error.conflict")}</p>
          <Button type="button" onClick={() => void reloadAfterConflict()}>{t("people.panel.reload")}</Button>
        </div>
      )}
      <h3 className="wn-panel-section">{t("people.panel.properties")}</h3>
      <PersonForm key={`${person.id}:${person.version}:${formKey}`} i18n={p.i18n} mode="edit" person={person} initial={draft ?? valuesOf(person)}
        departments={p.departments} roles={p.roles} weekStart={p.weekStart} today={p.today} readOnly={!p.canEdit} busy={busy} submitError={error}
        onDirtyChange={setDirty} onSubmit={(v, from) => void save(v, from)} />

      <section className="wn-panel-block" aria-labelledby="wn-history-h">
        <h3 id="wn-history-h" className="wn-panel-section">{t("people.history.title")}</h3>
        {history.state.status === "loading" && <p className="wn-muted">{t("people.loading")}</p>}
        {history.state.status === "error" && <p role="alert" className="wn-error">{t("people.history.error")} <Button size="sm" type="button" onClick={history.reload}>{t("people.retry")}</Button></p>}
        {history.state.status === "ready" && (
          <ul className="wn-history">
            {periods.map((h) => {
              const hours = h.attribute === "workDaysHours" ? h.workDaysHours : [];
              const { total } = weeklySummary(hours);
              const detail = weekOrder(p.weekStart).map((i) => `${weekdayName(i, p.i18n.locale, "short")} ${hours[i] ?? 0}`).join(" · ");
              const range = h.validFrom && h.validTo ? t("people.history.range", { from: day(h.validFrom), to: day(h.validTo) })
                : h.validFrom ? t("people.history.since", { from: day(h.validFrom) })
                : h.validTo ? t("people.history.until", { to: day(h.validTo) }) : t("people.history.always");
              return <li key={h.id}><strong>{range}</strong> : {t("people.hours.week", { hours: total })} <span className="wn-muted">({detail})</span></li>;
            })}
          </ul>
        )}
      </section>

      {p.canEdit && (
        <section className="wn-panel-block" aria-labelledby="wn-access-h">
          <h3 id="wn-access-h" className="wn-panel-section">{t("people.panel.status")}</h3>
          {person.active
            ? <Button type="button" onClick={() => setDeactivating(true)}>{t("people.panel.deactivate")}</Button>
            : <Button type="button" disabled={busy} onClick={() => void reactivate()}>{t("people.panel.reactivate")}</Button>}
        </section>
      )}
      {deactivating && (
        <DeactivateDialog i18n={p.i18n} source={source} person={person} candidates={p.people}
          onClose={() => setDeactivating(false)} onDone={(next) => { setDeactivating(false); p.onUpdated(next); setNotice(t("people.panel.deactivated")); }} />
      )}
    </Drawer>
  );
}
