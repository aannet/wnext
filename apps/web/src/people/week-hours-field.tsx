// Horaire hebdomadaire : sept saisies d'heures (0 à 24), dans l'ordre du début de semaine du compte. Le stockage reste ISO
// (index 0 = lundi, CLAUDE.md) : seul l'affichage suit `week_start`. Le total par semaine est annoncé sous les champs.
import type { I18n } from "@lingui/core";
import { useId } from "react";
import type { MessageKey } from "../i18n";
import { parseWeek, weekdayName, weekOrder, weeklySummary } from "./people-model";

export interface WeekHoursFieldProps {
  i18n: I18n;
  /** Début de semaine du compte, ISO : 1 = lundi ... 7 = dimanche. */
  weekStart: number;
  /** Sept saisies, index ISO (0 = lundi). */
  value: readonly string[];
  onChange(next: string[]): void;
  disabled?: boolean;
  error?: MessageKey | undefined;
  errorId?: string;
}

export function WeekHoursField({ i18n, weekStart, value, onChange, disabled, error, errorId }: WeekHoursFieldProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const parsed = parseWeek(value);
  const total = parsed ? weeklySummary(parsed) : null;
  return (
    <fieldset className="wn-week-hours" aria-describedby={error && errorId ? errorId : `${id}-total`}>
      <legend>{t("people.form.hours")}</legend>
      <div className="wn-week-grid">
        {weekOrder(weekStart).map((index) => (
          <div key={index} className="wn-field">
            <label htmlFor={`${id}-${index}`}><abbr title={weekdayName(index, i18n.locale)}>{weekdayName(index, i18n.locale, "short")}</abbr></label>
            <input id={`${id}-${index}`} type="text" aria-label={weekdayName(index, i18n.locale)} inputMode="decimal" size={3} value={value[index] ?? ""} disabled={disabled} autoComplete="off"
              aria-invalid={error ? true : undefined}
              onChange={(e) => { const next = [...value]; next[index] = e.target.value; onChange(next); }} />
          </div>
        ))}
      </div>
      <p id={`${id}-total`} className="wn-muted">{total ? t("people.hours.total", { hours: total.total, days: total.days }) : " "}</p>
      {error && <p id={errorId} className="wn-field-error">{t(error)}</p>}
    </fieldset>
  );
}
