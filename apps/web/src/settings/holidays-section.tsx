// Jours fériés (Réglages), par pays : liste filtrable par pays, ajout (nom, date, pays facultatif, heures chômées facultatives) et
// suppression. Un férié sans pays vaut pour tout le compte ; avec un pays, pour les personnes de ce pays (people.country).
import type { I18n } from "@lingui/core";
import { useId, useMemo, useState } from "react";
import type { Holiday, RefStore, HolidayInput } from "../data/people-source";
import type { MessageKey } from "../i18n";
import { COUNTRY_EXAMPLE, errorOf } from "../people/people-model";
import { useLoad } from "../projects/use-load";
import { countriesOf, holidayInputOf, holidaysOf, NEW_HOLIDAY, NO_COUNTRY, validateHoliday, type HolidayErrors, type HolidayValues } from "./settings-model";
import { Button } from "../design";

export interface HolidaysSectionProps {
  i18n: I18n;
  store: RefStore<Holiday, HolidayInput, Partial<HolidayInput>>;
  canEdit: boolean;
}

export function HolidaysSection({ i18n, store, canEdit }: HolidaysSectionProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const list = useLoad(() => store.list(), "holidays");
  const [country, setCountry] = useState("");
  const [v, setV] = useState<HolidayValues>(NEW_HOLIDAY);
  const [errors, setErrors] = useState<HolidayErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const all = list.state.status === "ready" ? list.state.data : [];
  const shown = useMemo(() => holidaysOf(all, country), [all, country]);
  const countries = countriesOf(all);
  const fmt = useMemo(() => new Intl.DateTimeFormat(i18n.locale, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }), [i18n.locale]);
  const names = useMemo(() => new Intl.DisplayNames([i18n.locale], { type: "region" }), [i18n.locale]);
  const region = (c: string) => { try { return `${names.of(c) ?? c} (${c})`; } catch { return c; } };
  const set = <K extends keyof HolidayValues>(k: K, value: string) => setV((x) => ({ ...x, [k]: value }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const found = validateHoliday(v);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true); setError(null); setNotice("");
    const r = await store.create(holidayInputOf(v));
    setBusy(false);
    if (!r.ok) { setError(t(errorOf(r.error).key)); return; }
    list.update((d) => [...d, r.value]);
    setV(NEW_HOLIDAY);
    setNotice(t("settings.created", { name: r.value.name }));
  }
  async function remove(h: Holiday) {
    setBusy(true); setError(null); setNotice("");
    const r = await store.remove(h);
    setBusy(false);
    if (!r.ok) { setError(t(errorOf(r.error).key)); return; }
    list.update((d) => d.filter((x) => x.id !== h.id));
    setNotice(t("settings.deleted", { name: h.name }));
  }
  const err = (f: keyof HolidayValues) => errors[f] && <p id={`${id}-${f}-err`} className="wn-field-error">{t(errors[f]!)}</p>;
  const invalid = (f: keyof HolidayValues) => (errors[f] ? { "aria-invalid": true as const, "aria-describedby": `${id}-${f}-err` } : {});

  return (
    <section className="wn-clients" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="wn-panel-section">{t("settings.holidays.title")}</h2>
      {error && <p role="alert" className="wn-error">{error}</p>}
      <p role="status" className={notice ? "wn-panel-notice" : "wn-visually-hidden"}>{notice}</p>
      {list.state.status === "loading" && <p className="wn-muted">{t("people.loading")}</p>}
      {list.state.status === "error" && <p role="alert" className="wn-error">{t("people.error.load")} <Button size="sm" type="button" onClick={list.reload}>{t("people.retry")}</Button></p>}
      {canEdit && (
        <form className="wn-holiday-form" onSubmit={(e) => void create(e)} noValidate>
          <div className="wn-field">
            <label htmlFor={`${id}-name`}>{t("settings.holidays.name")}</label>
            <input id={`${id}-name`} value={v.name} maxLength={200} autoComplete="off" onChange={(e) => set("name", e.target.value)} {...invalid("name")} />
            {err("name")}
          </div>
          <div className="wn-field">
            <label htmlFor={`${id}-date`}>{t("settings.holidays.date")}</label>
            <input id={`${id}-date`} type="date" value={v.date} onChange={(e) => set("date", e.target.value)} {...invalid("date")} />
            {err("date")}
          </div>
          <div className="wn-field">
            <label htmlFor={`${id}-country`}>{t("settings.holidays.country")}</label>
            <input id={`${id}-country`} value={v.country} maxLength={2} size={4} placeholder={COUNTRY_EXAMPLE} autoComplete="off" onChange={(e) => set("country", e.target.value)} {...invalid("country")} />
            {err("country")}
          </div>
          <div className="wn-field">
            <label htmlFor={`${id}-hours`}>{t("settings.holidays.hours")}</label>
            <input id={`${id}-hours`} value={v.hoursOff} inputMode="decimal" size={4} autoComplete="off" onChange={(e) => set("hoursOff", e.target.value)} {...invalid("hoursOff")} />
            {err("hoursOff")}
          </div>
          <Button type="submit" variant="primary" disabled={busy}>{t("settings.add")}</Button>
        </form>
      )}
      {list.state.status === "ready" && (
        <>
          <div className="wn-field wn-filter-inline">
            <label htmlFor={`${id}-filter`}>{t("settings.holidays.filter")}</label>
            <select id={`${id}-filter`} value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">{t("settings.holidays.filter.all")}</option>
              <option value={NO_COUNTRY}>{t("settings.holidays.filter.none")}</option>
              {countries.map((c) => <option key={c} value={c}>{region(c)}</option>)}
            </select>
          </div>
          {shown.length === 0 ? <p className="wn-muted">{t("settings.holidays.empty")}</p> : (
            <ul className="wn-rows">
              {shown.map((h) => (
                <li key={h.id}>
                  <span className="wn-row-name">
                    {h.name} <span className="wn-muted">{fmt.format(new Date(`${h.date}T00:00:00Z`))} · {h.country ? region(h.country) : t("settings.holidays.everyone")}
                    {h.hoursOff !== null ? ` · ${t("settings.holidays.off", { hours: h.hoursOff })}` : ""}</span>
                  </span>
                  {canEdit && <Button size="sm" type="button" disabled={busy} onClick={() => void remove(h)}>{t("settings.delete", { name: h.name })}</Button>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
