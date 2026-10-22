// Choix de la couleur d'un projet (RT-018) : les 16 couleurs de la palette (design/project-palette), garanties lisibles
// (texte >= 4,5:1, loin du rouge de dépassement et de l'accent), et une couleur libre en #RRGGBB qui avertit au lieu d'interdire.
// Groupe radio de Base UI (design/ui/radio-group) : une seule tabulation pour le groupe, flèches pour passer d'une teinte à l'autre.
import type { I18n } from "@lingui/core";
import { useId } from "react";
import { RadioGroup, RadioItem } from "../design";
import { colorWarnings, PROJECT_PALETTE, type ColorWarning } from "../design/project-palette";
import type { MessageKey } from "../i18n";
import { blockColors } from "../schedule/block-colors";

const WARNING_KEY: Record<ColorWarning, MessageKey> = {
  invalid: "projects.color.warning.invalid",
  "low-surface-contrast": "projects.color.warning.light",
  "near-over-capacity": "projects.color.warning.red",
  "near-accent": "projects.color.warning.accent",
};

export interface ColorFieldProps {
  i18n: I18n;
  value: string;
  onChange(hex: string): void;
  disabled?: boolean;
  /** Message d'erreur déjà traduit (validation du formulaire). */
  error?: string | undefined;
  errorId?: string;
}

export function ColorField({ i18n, value, onChange, disabled = false, error, errorId }: ColorFieldProps) {
  const t = (k: MessageKey, v?: Record<string, unknown>) => i18n._(k, v);
  const id = useId();
  const current = value.trim().toUpperCase();
  const inPalette = PROJECT_PALETTE.findIndex((p) => p.hex === current);
  const warnings = inPalette >= 0 ? [] : colorWarnings(value.trim());

  return (
    <div className="wn-color-field">
      <div id={`${id}-label`} className="wn-field-label">{t("projects.color.label")}</div>
      <RadioGroup aria-labelledby={`${id}-label`} value={inPalette >= 0 ? current : null} disabled={disabled} onValueChange={(v) => onChange(v as string)} className="wn-swatches">
        {PROJECT_PALETTE.map((p) => {
          const selected = p.hex === current;
          return (
            <RadioItem key={p.hex} value={p.hex} variant="bare" aria-label={t("projects.color.swatch", { hex: p.hex })} className="wn-swatch" data-selected={selected || undefined}
              style={{ background: p.hex, color: p.text }}>
              {selected ? "✓" : ""}
            </RadioItem>
          );
        })}
      </RadioGroup>
      <div className="wn-color-free">
        <label htmlFor={`${id}-hex`}>{t("projects.color.free")}</label>
        <input id={`${id}-hex`} type="text" value={value} disabled={disabled} maxLength={7} spellCheck={false} autoComplete="off"
          aria-invalid={error ? true : undefined} aria-describedby={[error ? errorId : "", warnings.length ? `${id}-warn` : ""].filter(Boolean).join(" ") || undefined}
          onChange={(e) => onChange(e.target.value)} />
        <span className="wn-color-preview" aria-hidden="true" style={{ background: blockColors(value, false).background }} />
      </div>
      {warnings.length > 0 && (
        <ul id={`${id}-warn`} className="wn-color-warnings">
          {warnings.map((w) => <li key={w}>{t(WARNING_KEY[w])}</li>)}
        </ul>
      )}
    </div>
  );
}
