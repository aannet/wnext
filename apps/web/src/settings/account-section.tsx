// Compte (Réglages, RT-041) : fuseau, début de semaine, langue par défaut et seuil de sous-allocation, lus par GET /account.
// Owner et admin les modifient (PATCH, If-Match = version lue ; seuls les champs changés partent) ; les autres rôles les lisent.
// VERSION_CONFLICT : message, valeurs actuelles relues (la modification est à refaire). Après une écriture réussie, `onSaved`
// laisse l'appelant relire /me et mettre à jour le Planning (pas de temps réel pour le compte). Le nom reste en lecture.
import type { I18n } from "@lingui/core";
import type { AccountPatch, AccountSettings } from "@wnext/contracts";
import { useId, useMemo, useState } from "react";
import { timeZones, type AccountSource } from "../data/account-source";
import type { DirError } from "../data/people-source";
import { Button, Combobox } from "../design";
import type { MessageKey } from "../i18n";
import { errorOf, weekdayName } from "../people/people-model";
import { useLoad } from "../projects/use-load";

export interface AccountSectionProps {
  i18n: I18n;
  source: AccountSource;
  canEdit: boolean;
  onSaved?(settings: AccountSettings): void;
}

const LOCALES = ["fr", "en"] as const;
const WEEK = [1, 2, 3, 4, 5, 6, 7] as const;

interface Values { timezone: string; weekStart: string; defaultLocale: string; under: string }
const valuesOf = (s: AccountSettings): Values => ({ timezone: s.timezone, weekStart: String(s.weekStart), defaultLocale: s.defaultLocale, under: String(s.capacityThresholds.underPercent) });

/** Seuil saisi : nombre de 1 à 100 (virgule décimale admise), sinon null. */
export function parseThreshold(raw: string): number | null {
  const s = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 100 ? n : null;
}

/** Champs changés par rapport aux réglages lus ; vide : rien à enregistrer. */
export function accountPatchOf(cur: AccountSettings, v: Values): AccountPatch {
  const p: AccountPatch = {};
  if (v.timezone !== cur.timezone) p.timezone = v.timezone;
  if (Number(v.weekStart) !== cur.weekStart) p.weekStart = Number(v.weekStart);
  if (v.defaultLocale !== cur.defaultLocale) p.defaultLocale = v.defaultLocale as AccountPatch["defaultLocale"];
  const under = parseThreshold(v.under);
  if (under === null || under !== cur.capacityThresholds.underPercent) p.capacityThresholds = { underPercent: under ?? NaN };
  return p;
}

function errorKey(e: DirError): MessageKey {
  if (e.code === "VERSION_CONFLICT") return "settings.account.error.conflict";
  if (e.code === "VALIDATION_FAILED" && e.params.field === "timezone") return "settings.account.error.timezone";
  return errorOf(e).key;
}

export function AccountSection({ i18n, source, canEdit, onSaved }: AccountSectionProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const loaded = useLoad(() => source.get(), "account");
  const lang = useMemo(() => new Intl.DisplayNames([i18n.locale], { type: "language" }), [i18n.locale]);
  const title = <h2 id={`${id}-h`} className="wn-panel-section">{t("settings.account.title")}</h2>;
  if (loaded.state.status !== "ready") {
    return (
      <section className="wn-clients" aria-labelledby={`${id}-h`}>
        {title}
        {loaded.state.status === "loading"
          ? <p className="wn-muted" role="status">{t("people.loading")}</p>
          : <p role="alert" className="wn-error">{t("people.error.load")} <Button size="sm" type="button" onClick={loaded.reload}>{t("people.retry")}</Button></p>}
      </section>
    );
  }
  const settings = loaded.state.data;
  const langName = (code: string) => lang.of(code) ?? code;
  if (!canEdit) {
    return (
      <section className="wn-clients" aria-labelledby={`${id}-h`}>
        {title}
        <dl className="wn-facts">
          <dt>{t("settings.account.name")}</dt><dd>{settings.name}</dd>
          <dt>{t("settings.account.timezone")}</dt><dd>{settings.timezone}</dd>
          <dt>{t("settings.account.weekstart")}</dt><dd>{weekdayName(settings.weekStart - 1, i18n.locale)}</dd>
          <dt>{t("settings.account.locale")}</dt><dd>{langName(settings.defaultLocale)}</dd>
          <dt>{t("settings.account.threshold")}</dt><dd>{t("settings.account.threshold.value", { value: settings.capacityThresholds.underPercent })}</dd>
        </dl>
        <p className="wn-muted">{t("settings.account.readonly")}</p>
      </section>
    );
  }
  return (
    <section className="wn-clients" aria-labelledby={`${id}-h`}>
      {title}
      <AccountForm i18n={i18n} settings={settings} source={source} langName={langName}
        onSaved={(s) => { loaded.update(() => s); onSaved?.(s); }}
        onConflict={(s) => loaded.update(() => s)} />
    </section>
  );
}

function AccountForm({ i18n, settings, source, langName, onSaved, onConflict }: {
  i18n: I18n; settings: AccountSettings; source: AccountSource; langName(code: string): string;
  onSaved(s: AccountSettings): void; onConflict(s: AccountSettings): void;
}) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const [v, setV] = useState<Values>(() => valuesOf(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const zones = useMemo(() => {
    const list = timeZones();
    return (list.includes(settings.timezone) ? list : [settings.timezone, ...list]).map((z) => ({ id: z, name: z }));
  }, [settings.timezone]);
  const patch = accountPatchOf(settings, v);
  const dirty = Object.keys(patch).length > 0;
  const underInvalid = parseThreshold(v.under) === null;
  const locales: readonly string[] = LOCALES.includes(settings.defaultLocale as never) ? LOCALES : [settings.defaultLocale, ...LOCALES];
  const set = <K extends keyof Values>(k: K, value: Values[K]) => { setV((x) => ({ ...x, [k]: value })); setNotice(null); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty) return;
    setShowErrors(true);
    if (underInvalid) return;
    setBusy(true); setError(null); setNotice(null);
    const r = await source.update(settings, patch);
    if (r.ok) {
      setBusy(false);
      setV(valuesOf(r.value));
      setNotice("settings.account.saved");
      onSaved(r.value);
      return;
    }
    if (r.error.code === "VERSION_CONFLICT") {
      const fresh = await source.get();
      setBusy(false);
      setError("settings.account.error.conflict");
      if (fresh.ok) { setV(valuesOf(fresh.value)); onConflict(fresh.value); }
      return;
    }
    setBusy(false);
    setError(errorKey(r.error));
  }

  return (
    <form className="wn-account-form" onSubmit={(e) => void submit(e)} noValidate aria-busy={busy || undefined}>
      {error && <p role="alert" className="wn-error">{t(error)}</p>}
      <dl className="wn-facts">
        <dt>{t("settings.account.name")}</dt><dd>{settings.name}</dd>
      </dl>
      <div className="wn-field">
        <Combobox label={t("settings.account.timezone")} value={v.timezone} options={zones} onChange={(z) => set("timezone", z)}
          emptyLabel={t("settings.account.timezone.empty")} disabled={busy} />
      </div>
      <div className="wn-field">
        <label htmlFor={`${id}-week`}>{t("settings.account.weekstart")}</label>
        <select id={`${id}-week`} value={v.weekStart} disabled={busy} onChange={(e) => set("weekStart", e.target.value)}>
          {WEEK.map((d) => <option key={d} value={String(d)}>{weekdayName(d - 1, i18n.locale)}</option>)}
        </select>
      </div>
      <div className="wn-field">
        <label htmlFor={`${id}-locale`}>{t("settings.account.locale")}</label>
        <select id={`${id}-locale`} value={v.defaultLocale} disabled={busy} onChange={(e) => set("defaultLocale", e.target.value)}>
          {locales.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
        </select>
      </div>
      <div className="wn-field">
        <label htmlFor={`${id}-under`}>{t("settings.account.threshold")}</label>
        <input id={`${id}-under`} type="number" inputMode="decimal" min={1} max={100} step={1} value={v.under} disabled={busy}
          aria-invalid={showErrors && underInvalid ? true : undefined}
          aria-describedby={`${id}-under-hint${showErrors && underInvalid ? ` ${id}-under-err` : ""}`}
          onChange={(e) => set("under", e.target.value)} />
        <p id={`${id}-under-hint`} className="wn-muted">{t("settings.account.threshold.hint")}</p>
        {showErrors && underInvalid && <p id={`${id}-under-err`} className="wn-field-error">{t("settings.account.error.threshold")}</p>}
      </div>
      <p role="status" className={notice ? "wn-panel-notice" : "wn-visually-hidden"}>{notice ? t(notice) : ""}</p>
      <div className="wn-dialog-actions">
        <Button type="submit" variant="primary" disabled={busy || !dirty}>{t("settings.account.save")}</Button>
      </div>
    </form>
  );
}
